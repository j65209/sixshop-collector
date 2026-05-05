import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { Page } from "playwright";
import { read, utils } from "xlsx";
import { google } from "googleapis";
import { config } from "./config.js";
import { type Brand, BRANDS } from "./brands.js";
import { downloadProductsCsv, loginAsBrand, newBrandPage, newBrowser } from "./sixshop.js";

interface ProductRow {
  productName: string;
  optionText: string;
  sku: string;
  stock: number;
  status: string;
  category: string;
}

function todayKstDateTag(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}.${kst.getUTCDate()}완료`;
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
  const rawQty = get("수량");
  const stock = /관리\s*안/.test(rawQty)
    ? 99999
    : Number(rawQty.replace(/[^\d.-]/g, "")) || 0;
  return {
    productName,
    optionText: optionText === "-" ? "" : optionText,
    sku: sku === "-" ? "" : sku,
    stock,
    status: get("상태"),
    category: get("카테고리"),
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

async function readExistingStocks(stockSheetName: string): Promise<Map<string, number>> {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  if (!meta.data.sheets?.some((s) => s.properties?.title === stockSheetName)) {
    return new Map();
  }
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${stockSheetName}!B2:E`,
  });
  const map = new Map<string, number>();
  for (const row of got.data.values ?? []) {
    const name = String(row[0] ?? "").trim();
    const stock = Number(row[3]) || 0;
    if (name) map.set(name, stock);
  }
  return map;
}

async function pushToStockSheet(brand: Brand, rows: ProductRow[]): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = config.sheets.sheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === brand.stockSheetName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: brand.stockSheetName } } }] },
    });
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${brand.stockSheetName}!A:Z`,
  });

  const dateTag = todayKstDateTag();
  const header = [
    "카테고리", "상품명", "옵션", "SKU",
    `현재재고(${dateTag})`,
    `판매수량(${dateTag})`,
    "남은재고", "리오더 알림",
  ];
  const ordersRef = /[^가-힣A-Za-z0-9_]/.test(brand.ordersSheetName)
    ? `'${brand.ordersSheetName}'`
    : brand.ordersSheetName;

  const values: (string | number)[][] = [header];
  for (const p of rows) {
    const r = values.length + 1;
    values.push([
      p.category, p.productName, p.optionText, p.sku, p.stock,
      `=IFERROR(SUMIF(${ordersRef}!D:D, B${r}, ${ordersRef}!G:G), 0)`,
      `=E${r}-F${r}`,
      `=IF(G${r}<=5, "⚠ 리오더", IF(G${r}<=10, "⚡ 임박", ""))`,
    ]);
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${brand.stockSheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

export async function refreshInventoryForBrand(page: Page, brand: Brand): Promise<{ total: number }> {
  const path = await downloadProductsCsv(page);
  try {
    const all = parseProducts(path);
    const products = all
      .filter((p) => brand.includeStatuses.includes(p.status))
      .sort((a, b) => b.stock - a.stock);

    const existing = await readExistingStocks(brand.stockSheetName);
    const final = products.map((p) => ({
      ...p,
      stock: p.stock > 0 ? p.stock : (existing.get(p.productName) ?? 0),
    }));

    await pushToStockSheet(brand, final);
    console.log(`[${brand.displayName}] inventory refreshed: total=${all.length}, ${brand.includeStatuses.join("|")}=${final.length}`);
    return { total: final.length };
  } finally {
    await unlink(path).catch(() => {});
  }
}

// 수동 실행: `npm run seed-inventory`
async function main(): Promise<void> {
  const browser = await newBrowser();
  try {
    for (const brand of BRANDS) {
      const page = await newBrandPage(browser);
      try {
        await loginAsBrand(page, brand);
        await refreshInventoryForBrand(page, brand);
      } finally {
        await page.context().close();
      }
    }
  } finally {
    await browser.close();
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1] ?? "");
if (isDirectRun) {
  main().catch((err) => {
    console.error("seed-inventory failed:", err);
    process.exit(1);
  });
}
