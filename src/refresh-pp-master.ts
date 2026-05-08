/**
 * PP 재고마스터 dashboard 갱신 (옵션 단위 191행).
 *
 * VM cron 매일 cron 마지막 step.
 * 컬럼: 카테고리 | 상품명 | 옵션 | SKU | 어제 판매 | 남은재고 | 리오더
 *
 * - 식스샵 부분: GHA cron이 박은 "PP 식스샵 재고마스터" (옵션별 7열) 그대로 reuse
 * - SS 부분: SS API 옵션재고 + SS주문로그 옵션판매를 token 매칭으로 식스샵 옵션 row에 attribute
 * - 어제 판매 = 식스샵 + SS 합 (정확/부분 매칭)
 * - 남은재고 = 식스샵 옵션재고 + SS 옵션재고 (token 매칭으로 attribute)
 */
import "dotenv/config";
import { google } from "googleapis";
import { config } from "./config.js";
import { BRANDS, type Brand } from "./brands.js";
import { fetchSmartStoreOrders, fetchSmartStoreProductStocks } from "./smartstore.js";
import { setBrandState } from "./sheets.js";

const FINAL_SHEET = "PP 재고마스터"; // 사장님이 보는 dashboard
const RAW_FINAL = "PP 식스샵 재고마스터"; // GHA가 박는 식스샵 옵션별 raw
const MAPPING_SHEET = "PP 매핑"; // 정적 매핑 (식스샵상품명 ↔ SS상품번호)

function getSheetsClient() {
  const creds = JSON.parse(config.sheets.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function nowKstStamp(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** 식스샵/SS 공통 옵션 → 토큰 set. 그룹명/순서/구분자 차이 흡수. */
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
      if (t === "to" || t === "type" || t === "size" || t === "free" || t === "color") continue;
      // 사이즈 부가 표기 (성별 라벨) — 식스샵 "여성" vs SS "여성용" 등 한 글자 차이로 mismatch나는 케이스 흡수
      if (t === "여성" || t === "여성용" || t === "남성" || t === "남성용" || t === "남녀공용" || t === "공용") continue;
      tokens.add(t);
    }
  }
  return tokens;
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

interface RawRow {
  category: string;
  productName: string;
  optionText: string;
  sku: string;
  yesterdaySales: number;
  stock: number;
  // 토큰 캐시
  tokens?: Set<string>;
}

async function readRawSheet(sheetName: string): Promise<RawRow[]> {
  const sheets = getSheetsClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${sheetName}!A2:G`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (got.data.values ?? [])
    .filter((r) => r[1])
    .map((r) => ({
      category: String(r[0] ?? ""),
      productName: String(r[1] ?? "").trim(),
      optionText: String(r[2] ?? "").trim(),
      sku: String(r[3] ?? ""),
      yesterdaySales: Number(r[4]) || 0,
      stock: Number(r[5]) || 0,
    }));
}

async function readMapping(): Promise<Map<string, string>> {
  // 식스샵상품명 → SS originProductNo
  const sheets = getSheetsClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${MAPPING_SHEET}!A2:B`,
  });
  const map = new Map<string, string>();
  for (const row of got.data.values ?? []) {
    const sixName = String(row[0] ?? "").trim();
    const ssId = String(row[1] ?? "").trim();
    if (sixName && ssId) map.set(sixName, ssId);
  }
  return map;
}

/**
 * SS API에서 라이브 fetch — 현재 PAYED(결제완료=발송대기) 상태인 주문만.
 * 발송 처리되면 status가 DELIVERING으로 바뀌어 PAYED에서 빠지므로 자연 차감.
 * 윈도우는 status 변경이 잡히는 범위 (last 14d). PAYED 상태가 14일 이상 묵을 가능성은 거의 없음.
 */
interface SsLine { tokens: Set<string>; qty: number; }
async function fetchPendingSsByProduct(brand: Brand): Promise<Map<string, SsLine[]>> {
  const to = new Date();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
  const orders = await fetchSmartStoreOrders(brand, from, to);

  const map = new Map<string, SsLine[]>();
  let payedCount = 0;
  const statusTally = new Map<string, number>();
  for (const o of orders) {
    statusTally.set(o.status, (statusTally.get(o.status) ?? 0) + 1);
    if (o.status !== "PAYED") continue;
    if (!o.originProductNo || o.quantity === 0) continue;
    if (!map.has(o.originProductNo)) map.set(o.originProductNo, []);
    map.get(o.originProductNo)!.push({ tokens: tokenizeOption(o.optionText), qty: o.quantity });
    payedCount++;
  }
  console.log(`  [SS pending fetch last 14d] PAYED=${payedCount} / 전체 ${orders.length}`);
  console.log(`  [SS status tally] ${[...statusTally.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  return map;
}

/**
 * SS 옵션 데이터(qty 또는 stock)를 식스샵 옵션 row에 attribute.
 * 매칭 우선순위: exact token set → SS ⊆ 식스샵 → 식스샵 ⊆ SS
 * 후보 N개면 균등 분배.
 * 식스샵 row에 매칭 안 된 SS 옵션은 buckets["unmatched"]에 합산.
 */
function attribute(
  rows: RawRow[],
  productMap: Map<string, string>,
  ssDataByProduct: Map<string, Array<{ tokens: Set<string>; value: number }>>,
): { attributedByRowIdx: Map<number, number>; unmatchedByProduct: Map<string, number> } {
  const result = new Map<number, number>();
  const unmatched = new Map<string, number>();
  // 식스샵 row를 ssId별로 그룹
  const sixByProduct = new Map<string, Array<{ idx: number; tokens: Set<string> }>>();
  rows.forEach((r, i) => {
    const ssId = productMap.get(r.productName);
    if (!ssId) return;
    if (!r.tokens) r.tokens = tokenizeOption(r.optionText);
    if (!sixByProduct.has(ssId)) sixByProduct.set(ssId, []);
    sixByProduct.get(ssId)!.push({ idx: i, tokens: r.tokens });
  });

  for (const [ssId, ssLines] of ssDataByProduct) {
    const candidates = sixByProduct.get(ssId);
    if (!candidates || candidates.length === 0) {
      // 매핑 자체 없음 → 모두 unmatched
      const totalUnmatched = ssLines.reduce((a, b) => a + b.value, 0);
      if (totalUnmatched > 0) unmatched.set(ssId, (unmatched.get(ssId) ?? 0) + totalUnmatched);
      continue;
    }
    for (const line of ssLines) {
      let matched = candidates.filter((c) => c.tokens.size === line.tokens.size && isSubset(c.tokens, line.tokens));
      if (matched.length === 0) matched = candidates.filter((c) => isSubset(line.tokens, c.tokens));
      if (matched.length === 0) matched = candidates.filter((c) => isSubset(c.tokens, line.tokens));
      if (matched.length === 0) {
        unmatched.set(ssId, (unmatched.get(ssId) ?? 0) + line.value);
        continue;
      }
      const share = line.value / matched.length;
      for (const t of matched) {
        result.set(t.idx, (result.get(t.idx) ?? 0) + share);
      }
    }
  }
  return { attributedByRowIdx: result, unmatchedByProduct: unmatched };
}

async function main(): Promise<void> {
  const ppBrand = BRANDS.find((b) => b.siteLink === "produktepr");
  if (!ppBrand?.smartStore) {
    console.error("PP brand or smartStore config missing");
    process.exit(1);
  }

  // 1) 식스샵 raw 시트 읽기 (GHA가 박음 — 결제완료 라이브 카운트가 yesterdaySales 자리에 들어있음)
  const sixRows = await readRawSheet(RAW_FINAL);
  console.log(`[refresh-pp-master] 식스샵 raw rows: ${sixRows.length}`);
  if (sixRows.length === 0) {
    console.error(`⚠️ ${RAW_FINAL}이 비었습니다. GHA cron이 한 번 돌아야 합니다 (KST 08:00).`);
    console.error(`수동 트리거: gh workflow run collect-sixshop-orders -R j65209/sixshop-collector`);
    process.exit(1);
  }

  // 2) 매핑 + SS API 옵션재고 + SS주문로그
  const mapping = await readMapping();
  console.log(`[refresh-pp-master] mapping: ${mapping.size} products`);

  console.log(`[refresh-pp-master] fetching SS option stocks...`);
  const ssProductStocks = await fetchSmartStoreProductStocks(ppBrand);
  console.log(`[refresh-pp-master] SS products fetched: ${ssProductStocks.size}`);

  // SS 재고를 attribute용 형식으로 변환
  const ssStockData = new Map<string, Array<{ tokens: Set<string>; value: number }>>();
  for (const [ssId, ps] of ssProductStocks) {
    if (ps.optionCombos.length === 0) {
      // 옵션 없는 상품: totalStock을 빈 토큰 set으로 하나
      ssStockData.set(ssId, [{ tokens: new Set(), value: ps.totalStock }]);
    } else {
      ssStockData.set(ssId, ps.optionCombos.map((c) => ({ tokens: tokenizeOption(c.optionText), value: c.stockQuantity })));
    }
  }

  console.log(`[refresh-pp-master] fetching SS pending orders (PAYED status, last 14d)...`);
  const ssPendingLines = await fetchPendingSsByProduct(ppBrand);
  const ssSalesData = new Map<string, Array<{ tokens: Set<string>; value: number }>>();
  for (const [ssId, lines] of ssPendingLines) {
    ssSalesData.set(ssId, lines.map((l) => ({ tokens: l.tokens, value: l.qty })));
  }
  console.log(`[refresh-pp-master] SS pending lines: ${[...ssPendingLines.values()].reduce((a, b) => a + b.length, 0)}`);

  // 3) attribute (옵션 매칭)
  const stockAttr = attribute(sixRows, mapping, ssStockData);
  const salesAttr = attribute(sixRows, mapping, ssSalesData);

  let stockUnmatchedSum = [...stockAttr.unmatchedByProduct.values()].reduce((a, b) => a + b, 0);
  let salesUnmatchedSum = [...salesAttr.unmatchedByProduct.values()].reduce((a, b) => a + b, 0);
  console.log(`[refresh-pp-master] SS 재고 attributed: ${[...stockAttr.attributedByRowIdx.values()].reduce((a, b) => a + b, 0).toFixed(0)} (unmatched: ${stockUnmatchedSum.toFixed(0)})`);
  console.log(`[refresh-pp-master] SS 결제완료 attributed: ${[...salesAttr.attributedByRowIdx.values()].reduce((a, b) => a + b, 0).toFixed(0)} (unmatched: ${salesUnmatchedSum.toFixed(0)})`);

  // 4) PP 재고마스터 dashboard 작성
  const sheets = getSheetsClient();
  const spreadsheetId = config.sheets.sheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheetMeta = meta.data.sheets?.find((s) => s.properties?.title === FINAL_SHEET);
  if (!sheetMeta) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: FINAL_SHEET } } }] },
    });
    sheetMeta = (await sheets.spreadsheets.get({ spreadsheetId })).data.sheets?.find((s) => s.properties?.title === FINAL_SHEET);
  }
  const sheetId = sheetMeta?.properties?.sheetId;

  // 9-col 옵션 단위 schema — 식스샵/SS 분리 (합산 X). 결제완료 = 발송대기 (운송장 출력 전) 라이브 카운트.
  const header = ["카테고리", "상품명", "옵션", "SKU", "식스샵 결제완료", "SS 결제완료", "식스샵 재고", "SS 재고", "리오더 알림"];
  const values: (string | number)[][] = [header];
  for (let i = 0; i < sixRows.length; i++) {
    const r = sixRows[i];
    const sixSale = r.yesterdaySales;
    // 옵션 1:N 매칭 균등 분배의 결과는 소수가 나오므로 정수로 반올림.
    const ssSale = Math.round(salesAttr.attributedByRowIdx.get(i) ?? 0);
    const sixStock = r.stock;
    const ssStock = Math.round(stockAttr.attributedByRowIdx.get(i) ?? 0);
    const rowR = i + 2;
    values.push([
      r.category,
      r.productName,
      r.optionText,
      r.sku,
      sixSale,
      ssSale,
      sixStock,
      ssStock,
      // 리오더는 합 기준 (식스샵 + SS 둘 다 합쳤을 때 임박이면 발주 의사결정용)
      `=IF(G${rowR}+H${rowR}<=20, "⚠ 리오더", IF(G${rowR}+H${rowR}<=50, "⚡ 임박", ""))`,
    ]);
  }

  // unmatched 행 추가 (사장님 검증용)
  if (salesUnmatchedSum > 0 || stockUnmatchedSum > 0) {
    values.push(["", "", "", "", "", "", "", "", ""]);
    values.push(["⚠ 옵션 매칭 안 됨", "ssId", "", "", "", "SS 결제완료(매칭X)", "", "SS 재고(매칭X)", ""]);
    const allSsIds = new Set([...salesAttr.unmatchedByProduct.keys(), ...stockAttr.unmatchedByProduct.keys()]);
    for (const ssId of allSsIds) {
      values.push([
        "",
        ssId,
        "",
        "",
        "",
        salesAttr.unmatchedByProduct.get(ssId) ?? 0,
        "",
        stockAttr.unmatchedByProduct.get(ssId) ?? 0,
        "",
      ]);
    }
  }

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${FINAL_SHEET}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${FINAL_SHEET}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${FINAL_SHEET}!K1`,
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
              filter: { range: { sheetId, startRowIndex: 0, endRowIndex: sixRows.length + 1, startColumnIndex: 0, endColumnIndex: header.length } },
            },
          },
        ],
      },
    });
  }

  await setBrandState(ppBrand, "last_pp_master_at", nowKstStamp());
  console.log(`[refresh-pp-master] ✅ done. ${sixRows.length} option rows pushed to ${FINAL_SHEET}.`);
}

main().catch((err) => {
  console.error("refresh-pp-master failed:", err);
  process.exit(1);
});
