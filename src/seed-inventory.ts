import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { read, utils } from "xlsx";
import { google } from "googleapis";
import { config } from "./config.js";

const PRODUCT_PAGE = "https://www.sixshop.com/dashboard/shop-products";
const STOCK_SHEET_NAME = "재고마스터";

async function main(): Promise<void> {
  console.log("[seed-inventory] start");
  const path = await downloadProductsXlsx();
  const all = parseProducts(path);
  // "판매 중" 상태인 상품만 시드 + 재고 많은 순 정렬
  const products = all
    .filter((p) => p.status === "판매 중")
    .sort((a, b) => b.stock - a.stock);
  console.log(`[parsed] total=${all.length}, 판매중=${products.length}`);
  await unlink(path).catch(() => {});

  await pushToStockSheet(products);
  console.log(`[done] ${products.length} rows written to "${STOCK_SHEET_NAME}"`);
}

async function downloadProductsXlsx(): Promise<string> {
  const browser = await chromium.launch({ headless: config.collect.headless });
  try {
    const ctx = await browser.newContext({
      locale: "ko-KR", timezoneId: "Asia/Seoul",
      viewport: { width: 1440, height: 900 }, acceptDownloads: true,
    });
    const page = await ctx.newPage();

    // 1) login (직접 POST)
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

    // 2) products page
    await page.goto(PRODUCT_PAGE, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(2500);

    // 3) 다운로드 버튼 클릭 → CSV 즉시 다운로드 (재로그인 다이얼로그 없음)
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.locator("#downloadAllProductsBtn").click();
    const download = await downloadPromise;

    const filename = download.suggestedFilename() || "products.xlsx";
    const out = join(tmpdir(), `sixshop-products-${Date.now()}-${filename}`);
    await download.saveAs(out);
    console.log(`[xlsx saved] ${out}`);
    return out;
  } finally {
    await browser.close();
  }
}

interface ProductRow {
  productName: string;
  optionText: string;
  sku: string;
  stock: number;
  status: string;
  category: string;
}

function parseProducts(path: string): ProductRow[] {
  // 식스샵 CSV는 BOM + UTF-8. xlsx.read가 csv도 처리.
  const buf = readFileSync(path);
  const wb = read(buf, { type: "buffer", raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
  if (rows.length > 0) {
    console.log("[csv columns]", Object.keys(rows[0]));
    console.log("[first row]", JSON.stringify(rows[0], null, 2));
  }
  return rows.map(mapRow).filter((p) => p.productName);
}

function mapRow(r: Record<string, any>): ProductRow {
  const get = (...keys: string[]): string => {
    for (const k of keys) if (k in r) return String(r[k] ?? "").trim();
    return "";
  };
  const num = (...keys: string[]): number => {
    const v = get(...keys);
    return Number(v.replace(/[^\d.-]/g, "")) || 0;
  };
  // 식스샵 CSV 정확한 컬럼명
  const productName = get("이름", "상품 이름");
  const optionText = get("상품 옵션 정보");
  const sku = get("상품 코드");
  const stock = num("수량");      // "0 개" → 0
  const status = get("상태");     // "판매 중" / "판매 중지" 등
  const category = get("카테고리");
  return { productName, optionText: optionText === "-" ? "" : optionText, sku: sku === "-" ? "" : sku, stock, status, category };
}

async function pushToStockSheet(rows: ProductRow[]): Promise<void> {
  const creds = JSON.parse(config.sheets.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = config.sheets.sheetId;

  // 시트 탭 ensure
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === STOCK_SHEET_NAME);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: STOCK_SHEET_NAME } } }] },
    });
  }

  // 데이터 비우고 새로 쓰기 (마스터는 매번 갱신)
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${STOCK_SHEET_NAME}!A:Z`,
  });

  const header = ["카테고리", "상품명", "옵션", "SKU", "현재재고", "판매수량", "남은재고", "리오더 알림"];
  const values: (string | number)[][] = [header];
  for (const p of rows) {
    const r = values.length + 1; // 시트 행 번호 (1-based, header가 1행)
    values.push([
      p.category,
      p.productName,
      p.optionText,
      p.sku,
      p.stock,
      // 판매수량: 주문로그의 상품명(D열)과 매칭, 수량(G열) 합계
      `=IFERROR(SUMIF(주문로그!D:D, B${r}, 주문로그!G:G), 0)`,
      // 남은재고 = 현재재고 - 판매수량
      `=E${r}-F${r}`,
      // 리오더 알림: 남은재고가 5개 이하면 "⚠ 리오더"
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

main().catch((err) => {
  console.error("seed-inventory failed:", err);
  process.exit(1);
});
