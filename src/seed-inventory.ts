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

/** "5.5~5.6" KST: 24h 윈도우 라벨 (어제 ~ 오늘) */
function windowDateTag(): string {
  const end = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return `${start.getUTCMonth() + 1}.${start.getUTCDate()}~${end.getUTCMonth() + 1}.${end.getUTCDate()}`;
}

/** "YYYY-MM-DD HH:mm:ss" KST string for (now - 24h). 주문로그/SS주문로그 datetime 컬럼과 비교용 (sortable string) */
function windowStartKstString(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function nowKstStamp(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${kst.getUTCFullYear()}-${m}-${d} ${hh}:${mm}`;
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
  // 옵션 이름 리스트 — 다중 그룹은 optionName 2~3개 (orderNo 순)
  const nameList = (data.shopProductOptionNameList ?? [])
    .slice()
    .sort((a: any, b: any) => (a.optionNameOrderNo ?? 0) - (b.optionNameOrderNo ?? 0))
    .map((n: any) => String(n.optionName ?? "").trim());

  // shopProductOptionList: 옵션 조합별 재고
  for (const opt of data.shopProductOptionList ?? []) {
    const parts: string[] = [];
    for (const [idx, name] of nameList.entries()) {
      const noKey = `optionValueNo${idx + 1}`;
      const valueNo = opt[noKey];
      if (valueNo == null) break;
      const value = valueMap.get(valueNo);
      if (!value) break;
      parts.push(name ? `${name}: ${value}` : value);
    }
    if (parts.length === 0) continue;
    result.set(parts.join(" / "), Number(opt.optionQuantity) || 0);
  }
  return result;
}

/**
 * "상품 옵션 정보" 문자열을 옵션 값들로 분해.
 * 단일 그룹: "컬러: 블루,화이트" → ["컬러: 블루", "컬러: 화이트"]
 * 다중 그룹 (슬래시 분리, cartesian product):
 *   "컬러: 블랙,화이트 / 사이즈: S,M" →
 *     ["컬러: 블랙 / 사이즈: S", "컬러: 블랙 / 사이즈: M",
 *      "컬러: 화이트 / 사이즈: S", "컬러: 화이트 / 사이즈: M"]
 * 빈/"-" → [""]
 */
function expandOptions(rawOption: string): string[] {
  const t = rawOption.trim();
  if (!t || t === "-") return [""];

  // 슬래시로 그룹 분리 (예: "컬러: A,B / 사이즈: S,M" → ["컬러: A,B", "사이즈: S,M"])
  const groups = t.split(/\s*\/\s*/).map((g) => g.trim()).filter(Boolean);

  // 각 그룹을 [{name, values[]}] 로 파싱
  const parsed: { name: string; values: string[] }[] = [];
  for (const g of groups) {
    const m = g.match(/^([^:]+):\s*(.+)$/);
    if (!m) {
      parsed.push({ name: "", values: [g] });
      continue;
    }
    const name = m[1].trim();
    const values = m[2].split(",").map((v) => v.trim()).filter(Boolean);
    if (values.length === 0) continue;
    parsed.push({ name, values });
  }
  if (parsed.length === 0) return [""];

  // cartesian product
  let combos: string[] = parsed[0].values.map((v) => `${parsed[0].name}: ${v}`);
  for (let i = 1; i < parsed.length; i++) {
    const next: string[] = [];
    for (const c of combos) {
      for (const v of parsed[i].values) {
        next.push(`${c} / ${parsed[i].name}: ${v}`);
      }
    }
    combos = next;
  }
  return combos;
}

function getSheetsClient() {
  const creds = JSON.parse(config.sheets.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

/**
 * 주문로그에서 (last_run_at, now] 사이의 (상품명, 옵션)별 판매수량 합계.
 * 옵션 비교는 trim해서 좌우 공백 차이 흡수.
 * lastRunAt이 null이면 빈 Map (첫 회 실행 — 차감 없이 시드만).
 */
async function computeSalesByKey(
  brand: Brand,
  lastRunAt: string | null,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!lastRunAt) return result;

  const sheets = getSheetsClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${brand.ordersSheetName}!A2:G`,
  });
  for (const row of got.data.values ?? []) {
    const orderedAt = String(row[1] ?? "");
    if (!orderedAt || orderedAt <= lastRunAt) continue;
    const status = String(row[2] ?? "").trim();
    if (status !== "결제 완료") continue; // 취소/환불 제외, 결제완료만 판매로 카운트
    const name = String(row[3] ?? "").trim();
    const opt = String(row[4] ?? "").trim();
    const qty = Number(row[6]) || 0;
    if (!name || !qty) continue;
    const key = `${name}::${opt}`;
    result.set(key, (result.get(key) ?? 0) + qty);
  }
  return result;
}

/**
 * 옵션 텍스트 → 토큰 set. 그룹명/순서/구분자 차이를 흡수하고 의미 토큰만 추출.
 * 식스샵/SS 옵션 매칭용 — exact 일치, 또는 한쪽이 다른 쪽의 subset인 경우까지 매칭 가능.
 *
 * 예:
 *   식스샵 "옵션: 잔체크-블랙"            → {잔체크, 블랙}
 *   SS     "옵션: 잔체크 / 컬러: 블랙"    → {잔체크, 블랙}     (exact)
 *   식스샵 "컬러: 그레이 / 사이즈: 230~270" → {그레이, 230, 270}
 *   SS     "컬러: 그레이"                  → {그레이}            (SS ⊂ 식스샵)
 */
function tokenizeOption(opt: string): Set<string> {
  if (!opt) return new Set();
  const tokens = new Set<string>();
  for (const group of opt.split(/\s*\/\s*/)) {
    const colon = group.indexOf(":");
    const value = colon === -1 ? group : group.slice(colon + 1);
    const norm = value
      .toLowerCase()
      .replace(/->/g, " ")
      .replace(/usb-?a/g, "usb");
    for (const tok of norm.split(/[\s\-_()~,.]+/)) {
      const t = tok.trim();
      if (!t) continue;
      if (t === "to" || t === "type" || t === "size" || t === "free") continue;
      tokens.add(t);
    }
  }
  return tokens;
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** PP 매핑 시트: A=식스샵상품명, B=SS originProductNo */
async function readSsProductMapping(): Promise<Map<string, string>> {
  const sheets = getSheetsClient();
  const spreadsheetId = config.sheets.sheetId;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  if (!meta.data.sheets?.some((s) => s.properties?.title === "PP 매핑")) {
    return new Map();
  }
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `PP 매핑!A2:B`,
  });
  const map = new Map<string, string>();
  for (const row of got.data.values ?? []) {
    const name = String(row[0] ?? "").trim();
    const ssId = String(row[1] ?? "").trim();
    if (name && ssId) map.set(name, ssId);
  }
  return map;
}

interface SsLine { tokens: Set<string>; qty: number; }

/**
 * SS주문로그 → Map<ssId, SsLine[]>
 * `windowStart`(KST "YYYY-MM-DD HH:mm:ss") 이후 주문일시만 포함 — 24h 윈도우 적재용.
 */
async function readSsLinesByProduct(brand: Brand, windowStart: string): Promise<Map<string, SsLine[]>> {
  if (!brand.smartStore) return new Map();
  const sheets = getSheetsClient();
  const spreadsheetId = config.sheets.sheetId;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  if (!meta.data.sheets?.some((s) => s.properties?.title === brand.smartStore!.ssOrdersSheetName)) {
    return new Map();
  }
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${brand.smartStore.ssOrdersSheetName}!C2:K`,
  });
  // C=주문일시(0), D=상태(1), E=상품명(2), F=옵션(3), G=SKU(4), H=수량(5), I=결제금액(6), J=수집일시(7), K=SS상품번호(8)
  const map = new Map<string, SsLine[]>();
  let inWindow = 0, outOfWindow = 0;
  for (const row of got.data.values ?? []) {
    const orderedAt = String(row[0] ?? "");
    if (orderedAt < windowStart) { outOfWindow++; continue; }
    const opt = String(row[3] ?? "");
    const qty = Number(row[5]) || 0;
    const ssId = String(row[8] ?? "").trim();
    if (!ssId || qty === 0) continue;
    if (!map.has(ssId)) map.set(ssId, []);
    map.get(ssId)!.push({ tokens: tokenizeOption(opt), qty });
    inWindow++;
  }
  console.log(`  [SS window ${windowStart}~now] ${inWindow} lines in, ${outOfWindow} older`);
  return map;
}

/**
 * SS 라인들을 식스샵 row(옵션별)로 attribute.
 * 매칭 우선순위: exact token set → SS ⊆ 식스샵 → 식스샵 ⊆ SS
 * 후보 N개면 qty/N씩 균등 분배.
 * 반환: Map<rowIndex(0-based in rows), 누적 SS qty>
 */
function attributeSsSalesToRows(
  rows: ProductRow[],
  productMap: Map<string, string>,
  ssMap: Map<string, SsLine[]>,
): Map<number, number> {
  const result = new Map<number, number>();
  const sixByProduct = new Map<string, { idx: number; tokens: Set<string> }[]>();
  rows.forEach((p, i) => {
    const ssId = productMap.get(p.productName);
    if (!ssId) return;
    if (!sixByProduct.has(ssId)) sixByProduct.set(ssId, []);
    sixByProduct.get(ssId)!.push({ idx: i, tokens: tokenizeOption(p.optionText) });
  });

  let unmatched = 0;
  for (const [ssId, lines] of ssMap) {
    const candidates = sixByProduct.get(ssId);
    if (!candidates || candidates.length === 0) continue;
    for (const line of lines) {
      let matched = candidates.filter(c => c.tokens.size === line.tokens.size && isSubset(c.tokens, line.tokens));
      if (matched.length === 0) matched = candidates.filter(c => isSubset(line.tokens, c.tokens));
      if (matched.length === 0) matched = candidates.filter(c => isSubset(c.tokens, line.tokens));
      if (matched.length === 0) { unmatched++; continue; }
      const share = line.qty / matched.length;
      for (const t of matched) {
        result.set(t.idx, (result.get(t.idx) ?? 0) + share);
      }
    }
  }
  if (unmatched > 0) console.log(`  [SS attribute] ${unmatched} lines unmatched (option mismatch within mapped products)`);
  return result;
}

async function pushToStockSheet(brand: Brand, rows: ProductRow[], salesByKey: Map<string, number>): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = config.sheets.sheetId;

  let meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheetMeta = meta.data.sheets?.find((s) => s.properties?.title === brand.stockSheetName);
  if (!sheetMeta) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: brand.stockSheetName } } }] },
    });
    meta = await sheets.spreadsheets.get({ spreadsheetId });
    sheetMeta = meta.data.sheets?.find((s) => s.properties?.title === brand.stockSheetName);
  }
  const sheetId = sheetMeta?.properties?.sheetId;

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${brand.stockSheetName}!A:Z`,
  });

  const dateTag = todayKstDateTag();
  // 단일 채널(6A/CT) 7열 구조. 남은재고 = mall API 실재고 (그날 8시 시점).
  // 어제 판매는 lastRunAt~now 사이 결제완료 주문을 코드에서 직접 합산한 값 (수식 X — SUMIFS 0 버그 차단).
  const header = [
    "카테고리", "상품명", "옵션", "SKU",
    `어제 판매(${dateTag})`,
    "남은재고",
    "리오더 알림",
  ];

  const values: (string | number)[][] = [header];
  rows.forEach((p) => {
    const r = values.length + 1;
    const sold = salesByKey.get(`${p.productName}::${p.optionText}`) ?? 0;
    const remaining = p.stock; // mall API 또는 CSV의 현재 재고 = 단일 채널의 진짜 남은재고
    values.push([
      p.category,
      p.productName,
      p.optionText,
      p.sku,
      sold,
      remaining,
      `=IF(F${r}<=5, "⚠ 리오더", IF(F${r}<=10, "⚡ 임박", ""))`,
    ]);
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${brand.stockSheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${brand.stockSheetName}!J1`,
    valueInputOption: "RAW",
    requestBody: { values: [[`최신화: ${nowKstStamp()}`]] },
  });

  if (sheetId != null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { clearBasicFilter: { sheetId } },
          {
            setBasicFilter: {
              filter: {
                range: {
                  sheetId,
                  startRowIndex: 0,
                  endRowIndex: values.length,
                  startColumnIndex: 0,
                  endColumnIndex: header.length,
                },
              },
            },
          },
        ],
      },
    });
  }
}

export async function refreshInventoryForBrand(
  page: Page,
  brand: Brand,
  lastRunAt: string | null,
): Promise<{ total: number }> {
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

    // 단일 채널(6A/CT): mall API의 옵션별 재고 = 진짜 남은재고. CSV stock(상품 합계)은 fallback.
    const final = expanded.map((p) => {
      const fromApi = optionStocksByProduct.get(p.productNo)?.get(p.optionText);
      const stock = p.optionText ? (fromApi ?? 0) : p.stock;
      return { ...p, stock };
    });

    final.sort((a, b) => b.stock - a.stock);

    const salesByKey = await computeSalesByKey(brand, lastRunAt);
    await pushToStockSheet(brand, final, salesByKey);
    const apiCount = [...optionStocksByProduct.values()].reduce((a, m) => a + m.size, 0);
    const soldTotal = [...salesByKey.values()].reduce((a, n) => a + n, 0);
    console.log(`[${brand.displayName}] inventory refreshed: rows=${final.length}, 옵션재고 from API=${apiCount}, 어제판매합=${soldTotal} (since ${lastRunAt ?? "first-run"})`);
    return { total: final.length };
  } finally {
    await unlink(path).catch(() => {});
  }
}

// 수동 실행: `npm run seed-inventory`
async function main(): Promise<void> {
  const { getBrandState } = await import("./sheets.js");
  const browser = await newBrowser();
  try {
    for (const brand of BRANDS) {
      if (!brand.inventoryEnabled) {
        console.log(`[${brand.displayName}] skipped (inventoryEnabled=false)`);
        continue;
      }
      const lastRunAt = await getBrandState(brand, "last_run_at").catch(() => null);
      const page = await newBrandPage(browser);
      try {
        await loginAsBrand(page, brand);
        await refreshInventoryForBrand(page, brand, lastRunAt);
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
