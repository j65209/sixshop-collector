import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { Page } from "playwright";
import { read, utils } from "xlsx";
import { google } from "googleapis";
import { config } from "./config.js";
import { type Brand, BRANDS } from "./brands.js";
import { downloadProductsCsv, loginAsBrand, newBrandPage, newBrowser } from "./sixshop.js";

interface ProductRow {
  productNo: number;
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
  const productNo = Number(get("상품고유번호")) || 0;
  return {
    productNo,
    productName,
    optionText: optionText === "-" ? "" : optionText,
    sku: sku === "-" ? "" : sku,
    stock,
    status: get("상태"),
    category: get("카테고리"),
  };
}

/**
 * mall API로 상품의 옵션별 재고 fetch.
 * 응답: { shopProductOptionList: [{optionValueNo1, optionQuantity}], shopProductOptionValueList: [{optionValueNo, optionValue}] }
 * 반환: Map<옵션값(예: "1size (41.5~47cm)"), 재고 수량>
 */
async function fetchOptionStocks(page: Page, brand: Brand, productNo: number): Promise<Map<string, number>> {
  const data = await page.evaluate(async ({ memberNo, productNo }) => {
    const r = await fetch(`/apis/mall/getShopProductByMemberNoAndProductNo?memberNo=${memberNo}&productNo=${productNo}`, {
      credentials: "include",
    });
    if (!r.ok) return null;
    return await r.json();
  }, { memberNo: brand.memberNo, productNo });

  const result = new Map<string, number>();
  if (!data) return result;

  // optionValueNo → optionValue 매핑
  const valueMap = new Map<number, string>();
  for (const v of data.shopProductOptionValueList ?? []) {
    valueMap.set(v.optionValueNo, String(v.optionValue ?? "").trim());
  }
  // 옵션 이름 (단일 옵션 가정)
  const optionName = String(data.shopProductOptionNameList?.[0]?.optionName ?? "").trim();

  // shopProductOptionList: 옵션 조합별 재고
  for (const opt of data.shopProductOptionList ?? []) {
    const v1 = valueMap.get(opt.optionValueNo1);
    if (!v1) continue;
    const key = optionName ? `${optionName}: ${v1}` : v1;
    result.set(key, Number(opt.optionQuantity) || 0);
  }
  return result;
}

/**
 * "상품 옵션 정보" 문자열을 옵션 값들로 분해.
 * "Size: 1 Size,2 Size" → ["Size: 1 Size", "Size: 2 Size"]
 * "컬러: 블루,옐로우,화이트" → ["컬러: 블루", "컬러: 옐로우", "컬러: 화이트"]
 * 빈 값/"-" → [""] (옵션 없음, 단일 row)
 */
function expandOptions(rawOption: string): string[] {
  const t = rawOption.trim();
  if (!t || t === "-") return [""];
  const m = t.match(/^([^:]+):\s*(.+)$/);
  if (!m) return [t];
  const optName = m[1].trim();
  const values = m[2].split(",").map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) return [""];
  return values.map((v) => `${optName}: ${v}`);
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
  // 키: `${상품명}::${옵션}` — 옵션별 수동 입력 보존
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
    const opt = String(row[1] ?? "").trim();
    const stock = Number(row[3]) || 0;
    if (name) map.set(`${name}::${opt}`, stock);
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
    // 옵션 있으면 SUMIFS (상품명+옵션 매칭), 없으면 SUMIF (상품명만)
    const salesFormula = p.optionText
      ? `=IFERROR(SUMIFS(${ordersRef}!G:G, ${ordersRef}!D:D, B${r}, ${ordersRef}!E:E, C${r}), 0)`
      : `=IFERROR(SUMIF(${ordersRef}!D:D, B${r}, ${ordersRef}!G:G), 0)`;
    values.push([
      p.category, p.productName, p.optionText, p.sku, p.stock,
      salesFormula,
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
    const filtered = all.filter((p) => brand.includeStatuses.includes(p.status));

    // 옵션 있는 상품의 productNo → 옵션별 재고 Map (mall API 호출, 5개 병렬)
    const optionStocksByProduct = new Map<number, Map<string, number>>();
    const productsWithOptions = filtered.filter((p) => p.optionText && p.optionText !== "-" && p.productNo);
    console.log(`[${brand.displayName}] fetching option stocks for ${productsWithOptions.length} products...`);
    for (let i = 0; i < productsWithOptions.length; i += 5) {
      const batch = productsWithOptions.slice(i, i + 5);
      await Promise.all(batch.map(async (p) => {
        try {
          const stocks = await fetchOptionStocks(page, brand, p.productNo);
          if (stocks.size > 0) optionStocksByProduct.set(p.productNo, stocks);
        } catch (e) {
          console.warn(`  option fetch failed for ${p.productName}: ${(e as Error).message}`);
        }
      }));
    }

    // 옵션 있는 상품은 옵션값마다 별도 row로 펼침
    const expanded: ProductRow[] = [];
    for (const p of filtered) {
      const opts = expandOptions(p.optionText);
      const fetched = optionStocksByProduct.get(p.productNo);
      for (const optionText of opts) {
        const optStock = fetched?.get(optionText);
        expanded.push({ ...p, optionText, stock: optStock ?? p.stock });
      }
    }

    // 수동 입력 보존: 옵션별로 (상품명+옵션) 키 매칭. mall API 값 우선.
    const existing = await readExistingStocks(brand.stockSheetName);
    const final = expanded.map((p) => {
      const key = `${p.productName}::${p.optionText}`;
      const fromApi = optionStocksByProduct.get(p.productNo)?.get(p.optionText);
      let stock = p.stock;
      if (p.optionText) {
        stock = fromApi ?? existing.get(key) ?? 0;
      } else {
        stock = p.stock > 0 ? p.stock : (existing.get(key) ?? 0);
      }
      return { ...p, stock };
    });

    // 최종 stock 적용 후 재고 많은 순 정렬 (mall API 값 반영됨)
    final.sort((a, b) => b.stock - a.stock);

    await pushToStockSheet(brand, final);
    const apiCount = [...optionStocksByProduct.values()].reduce((a, m) => a + m.size, 0);
    console.log(`[${brand.displayName}] inventory refreshed: products=${filtered.length}, rows=${final.length}, 옵션재고 from API=${apiCount}`);
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
