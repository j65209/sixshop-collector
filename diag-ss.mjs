// ERP 스마트스토어 안맞음 진단:
// 1) PP _state — 마지막 SS sync, 마지막 dashboard refresh 시각
// 2) PP 재고마스터 — 실제 dashboard 상태 (unmatched 섹션 포함)
// 3) PP SS주문로그 — 최근 동기화된 SS 주문
// 4) PP 매핑 — 식스샵상품명 ↔ SS originProductNo 매핑 개수
import { readFileSync } from "node:fs";
import { google } from "googleapis";
import "dotenv/config";

const creds = JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_PATH, "utf8"));
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.SHEET_ID;

async function getRows(range, opts = {}) {
  const got = await sheets.spreadsheets.values.get({ spreadsheetId, range, ...opts });
  return got.data.values ?? [];
}

console.log("=".repeat(60));
console.log("PP _state");
console.log("=".repeat(60));
const stateRows = await getRows("PP _state!A:B");
for (const r of stateRows) console.log(`  ${r[0]} = ${r[1]}`);

console.log("\n" + "=".repeat(60));
console.log("PP 재고마스터 (dashboard)");
console.log("=".repeat(60));
const dashRows = await getRows("PP 재고마스터!A1:K", { valueRenderOption: "UNFORMATTED_VALUE" });
console.log(`  총 행: ${dashRows.length}`);
console.log(`  헤더: ${JSON.stringify(dashRows[0])}`);
console.log(`  K1 (최신화): ${dashRows[0]?.[10] ?? "(없음)"}`);

// 데이터 행 (unmatched 섹션 전까지)
const dataEnd = dashRows.findIndex((r, i) => i > 0 && r[0] === "" && r[1] === "");
const dataRows = dashRows.slice(1, dataEnd > 0 ? dataEnd : dashRows.length);
const unmatchedStart = dashRows.findIndex(r => r[0] === "⚠ 옵션 매칭 안 됨");
console.log(`  데이터 행: ${dataRows.length}`);

// 컬럼별 합계 (E=어제 식스샵 판매, F=어제 SS 판매, G=식스샵 재고, H=SS 재고)
let sumSixSale = 0, sumSsSale = 0, sumSixStock = 0, sumSsStock = 0;
let nonzeroSsSale = 0, nonzeroSsStock = 0;
for (const r of dataRows) {
  sumSixSale += Number(r[4]) || 0;
  sumSsSale += Number(r[5]) || 0;
  sumSixStock += Number(r[6]) || 0;
  sumSsStock += Number(r[7]) || 0;
  if ((Number(r[5]) || 0) > 0) nonzeroSsSale++;
  if ((Number(r[7]) || 0) > 0) nonzeroSsStock++;
}
console.log(`  합계: 식스샵 판매=${sumSixSale}, SS 판매=${sumSsSale}, 식스샵 재고=${sumSixStock}, SS 재고=${sumSsStock}`);
console.log(`  SS 판매>0 행 수: ${nonzeroSsSale}, SS 재고>0 행 수: ${nonzeroSsStock}`);

if (unmatchedStart > 0) {
  console.log(`\n  ⚠ 옵션 매칭 안 됨 섹션 (${dashRows.length - unmatchedStart - 1}건):`);
  for (const r of dashRows.slice(unmatchedStart + 1, unmatchedStart + 11)) {
    console.log(`    ssId=${r[1]} / SS판매=${r[5]} / SS재고=${r[7]}`);
  }
  if (dashRows.length - unmatchedStart - 1 > 10) console.log(`    ... 외 ${dashRows.length - unmatchedStart - 11}건`);
}

console.log("\n" + "=".repeat(60));
console.log("PP SS주문로그");
console.log("=".repeat(60));
const ssOrderRows = await getRows("PP SS주문로그!A1:K");
console.log(`  총 행: ${ssOrderRows.length}`);
console.log(`  헤더: ${JSON.stringify(ssOrderRows[0])}`);
if (ssOrderRows.length > 1) {
  // 주문일시(C열, idx=2) 분포
  const dates = ssOrderRows.slice(1).map(r => String(r[2] ?? ""));
  const sorted = dates.filter(Boolean).sort();
  console.log(`  주문일시 범위: ${sorted[0]} ~ ${sorted[sorted.length - 1]}`);
  // 최근 3건
  const sortedDesc = dates.filter(Boolean).sort().reverse();
  console.log(`  최근 3건:`);
  for (const d of sortedDesc.slice(0, 3)) {
    const r = ssOrderRows.find(row => String(row[2] ?? "") === d);
    console.log(`    ${d} | 상태=${r?.[3]} | 상품=${r?.[4]?.slice(0, 30)} | 수량=${r?.[7]} | ssId=${r?.[10]}`);
  }
  // 상태별 카운트
  const statusCount = new Map();
  for (const r of ssOrderRows.slice(1)) {
    const s = String(r[3] ?? "(blank)");
    statusCount.set(s, (statusCount.get(s) ?? 0) + 1);
  }
  console.log(`  상태별: ${[...statusCount.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
}

console.log("\n" + "=".repeat(60));
console.log("PP 매핑");
console.log("=".repeat(60));
const mapRows = await getRows("PP 매핑!A1:C");
console.log(`  총 행: ${mapRows.length}`);
console.log(`  헤더: ${JSON.stringify(mapRows[0])}`);
const mapped = mapRows.slice(1).filter(r => r[0] && r[1]);
const unmappedRows = mapRows.slice(1).filter(r => r[0] && !r[1]);
console.log(`  매핑된 상품: ${mapped.length}, 매핑 안 된 상품: ${unmappedRows.length}`);
if (unmappedRows.length > 0) {
  console.log(`  매핑 안 된 상품 예 5개:`);
  for (const r of unmappedRows.slice(0, 5)) console.log(`    "${r[0]}"`);
}

console.log("\n" + "=".repeat(60));
console.log("PP 식스샵 재고마스터 (raw)");
console.log("=".repeat(60));
const rawRows = await getRows("PP 식스샵 재고마스터!A1:G", { valueRenderOption: "UNFORMATTED_VALUE" });
console.log(`  총 행: ${rawRows.length}`);
console.log(`  헤더: ${JSON.stringify(rawRows[0])}`);
const rawData = rawRows.slice(1);
let rawYesterdaySum = 0, rawStockSum = 0;
for (const r of rawData) {
  rawYesterdaySum += Number(r[4]) || 0;
  rawStockSum += Number(r[5]) || 0;
}
console.log(`  raw 어제 판매 합: ${rawYesterdaySum}, raw 재고 합: ${rawStockSum}`);
