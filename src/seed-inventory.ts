import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { read, utils } from "xlsx";
import { google } from "googleapis";
import { config } from "./config.js";

const PRODUCT_PAGE = "https://www.sixshop.com/dashboard/shop-products";
const STOCK_SHEET_NAME = "재고마스터";

interface ProductRow {
  productName: string;
  optionText: string;
  sku: string;
  stock: number;
  status: string;
  category: string;
}

/** 오늘(KST) 날짜를 "M.D" 형태로. 헤더 라벨용. */
function todayKstDateTag(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}.${kst.getUTCDate()}완료`;
}

/** 식스샵 상품 페이지에서 CSV 다운로드. 상품 페이지는 재로그인 다이얼로그 없음. */
async function downloadProductsCsv(): Promise<string> {
  const browser = await chromium.launch({ headless: config.collect.headless });
  try {
    const ctx = await browser.newContext({
      locale: "ko-KR", timezoneId: "Asia/Seoul",
      viewport: { width: 1440, height: 900 }, acceptDownloads: true,
    });
    const page = await ctx.newPage();

    await page.goto("https://www.sixshop.com/member/login", { waitUntil: "domcontentloaded" });
    const loginBody = new URLSearchParams({
      idOrUserName: Buffer.from(config.sixshop.email).toString("base64"),
      password: Buffer.from(config.sixshop.password).toString("base64"),
      keepLoginAgreement: "on",
      trendReportLogin: "", memberNo: "0", pageNo: "0", shopCustomerNo: "0",
    }).toString();
    const loginRes = await page.evaluate(async (body) => {
      const r = await fetch("/member/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body, credentials: "include",
      });
      return { ok: (await r.text()).includes('"RESULT":"OK"') };
    }, loginBody);
    if (!loginRes.ok) throw new Error("login failed");

    // dashboard는 polling이 많아 networkidle이 안 떠짐 → domcontentloaded로
    await page.goto(PRODUCT_PAGE, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("#downloadAllProductsBtn", { timeout: 30_000 });
    await page.waitForTimeout(2000);

    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.locator("#downloadAllProductsBtn").click();
    const download = await downloadPromise;

    const filename = download.suggestedFilename() || "products.csv";
    const out = join(tmpdir(), `sixshop-products-${Date.now()}-${filename}`);
    await download.saveAs(out);
    return out;
  } finally {
    await browser.close();
  }
}

function parseProducts(path: string): ProductRow[] {
  const buf = readFileSync(path);
  const wb = read(buf, { type: "buffer", raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
  return rows.map(mapRow).filter((p) => p.productName);
}

function mapRow(r: Record<string, any>): ProductRow {
  const get = (...keys: string[]): string => {
    for (const k of keys) if (k in r) return String(r[k] ?? "").trim();
    return "";
  };
  const productName = get("이름", "상품 이름");
  const optionText = get("상품 옵션 정보");
  const sku = get("상품 코드");

  // "수량" 처리:
  //  - "수량 관리 안 함" → 99999 (사실상 무한)
  //  - "0 개" / "57 개" → 숫자 추출
  //  - 옵션 있는 상품은 보통 0
  const rawQty = get("수량");
  let stock = 0;
  if (/관리\s*안/.test(rawQty)) {
    stock = 99999;
  } else {
    stock = Number(rawQty.replace(/[^\d.-]/g, "")) || 0;
  }

  const status = get("상태");
  const category = get("카테고리");
  return {
    productName,
    optionText: optionText === "-" ? "" : optionText,
    sku: sku === "-" ? "" : sku,
    stock,
    status,
    category,
  };
}

function getSheetsClient() {
  const creds = JSON.parse(config.sheets.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

/** 기존 재고마스터 시트의 (상품명 → 현재재고) 맵을 반환. 옵션 있는 상품의 수동 입력 보존용. */
async function readExistingStocks(): Promise<Map<string, number>> {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  if (!meta.data.sheets?.some((s) => s.properties?.title === STOCK_SHEET_NAME)) {
    return new Map();
  }
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${STOCK_SHEET_NAME}!B2:E`,
  });
  const map = new Map<string, number>();
  for (const row of got.data.values ?? []) {
    const name = String(row[0] ?? "").trim();
    const stock = Number(row[3]) || 0;
    if (name) map.set(name, stock);
  }
  return map;
}

async function pushToStockSheet(rows: ProductRow[]): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = config.sheets.sheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === STOCK_SHEET_NAME);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: STOCK_SHEET_NAME } } }] },
    });
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${STOCK_SHEET_NAME}!A:Z`,
  });

  const dateTag = todayKstDateTag();
  const header = [
    "카테고리", "상품명", "옵션", "SKU",
    `현재재고(${dateTag})`,
    `판매수량(${dateTag})`,
    "남은재고", "리오더 알림",
  ];
  const values: (string | number)[][] = [header];
  for (const p of rows) {
    const r = values.length + 1;
    values.push([
      p.category, p.productName, p.optionText, p.sku, p.stock,
      `=IFERROR(SUMIF(주문로그!D:D, B${r}, 주문로그!G:G), 0)`,
      `=E${r}-F${r}`,
      `=IF(G${r}<=5, "⚠ 리오더", IF(G${r}<=10, "⚡ 임박", ""))`,
    ]);
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${STOCK_SHEET_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

/**
 * 재고마스터 시트를 새로고침. 매일 cron + 수동 시드 모두에서 호출.
 * - 식스샵 CSV에서 받은 stock > 0이면 그대로 사용 (옵션 없는 상품)
 * - CSV stock = 0이면 기존 시트의 수동 입력값 보존 (옵션 있는 상품, 사장님이 직접 입력)
 */
export async function refreshInventory(): Promise<{ total: number }> {
  const path = await downloadProductsCsv();
  try {
    const all = parseProducts(path);
    const products = all
      .filter((p) => p.status === "판매 중")
      .sort((a, b) => b.stock - a.stock);

    const existing = await readExistingStocks();
    const final = products.map((p) => ({
      ...p,
      stock: p.stock > 0 ? p.stock : (existing.get(p.productName) ?? 0),
    }));

    await pushToStockSheet(final);
    console.log(`[inventory refreshed] total=${all.length}, 판매중=${final.length}`);
    return { total: final.length };
  } finally {
    await unlink(path).catch(() => {});
  }
}

// 수동 실행: `npm run seed-inventory`
const isDirectRun = import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1] ?? "");
if (isDirectRun) {
  refreshInventory().catch((err) => {
    console.error("seed-inventory failed:", err);
    process.exit(1);
  });
}
