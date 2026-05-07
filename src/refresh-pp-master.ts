/**
 * PP 재고마스터 dashboard 갱신 (단일 시트, 31행 상품 단위).
 *
 * VM cron 매일 7:55 KST에 sync-smartstore 후 호출.
 * 컬럼: 카테고리 | 상품명 | SS상품번호 | 어제 식스샵 판매 | 어제 SS 판매 | 식스샵 재고 | SS 재고 | 남은재고 | 리오더
 *
 * 식스샵 재고: 사장님이 1회 시드 후 매일 (어제 식스샵 판매)만큼 자동 차감 (사장님 ± 보존).
 * SS 재고: SS API에서 자동 fetch (matter of source of truth).
 * 어제 판매: lastRunAt~now 사이 결제완료 주문을 코드에서 직접 합산.
 */
import "dotenv/config";
import { google } from "googleapis";
import { config } from "./config.js";
import { BRANDS } from "./brands.js";
import { fetchSmartStoreStocks } from "./smartstore.js";
import { getBrandState, setBrandState } from "./sheets.js";

const MASTER_SHEET = "PP 재고마스터";
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

interface MappingRow {
  sixName: string;
  ssId: string; // "" if SS 미판매
}

async function readMapping(): Promise<MappingRow[]> {
  const sheets = getSheetsClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${MAPPING_SHEET}!A2:B`,
  });
  return (got.data.values ?? [])
    .map((r) => ({ sixName: String(r[0] ?? "").trim(), ssId: String(r[1] ?? "").trim() }))
    .filter((r) => r.sixName);
}

/** PP 주문로그 → 상품명별 (lastRunAt, now] 결제완료 판매수량 합 */
async function readSixshopSalesByProduct(ordersSheet: string, lastRunAt: string | null): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!lastRunAt) return result;
  const sheets = getSheetsClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${ordersSheet}!A2:G`,
  });
  for (const row of got.data.values ?? []) {
    const orderedAt = String(row[1] ?? "");
    if (!orderedAt || orderedAt <= lastRunAt) continue;
    const status = String(row[2] ?? "").trim();
    if (status !== "결제 완료") continue;
    const name = String(row[3] ?? "").trim();
    const qty = Number(row[6]) || 0;
    if (!name || !qty) continue;
    result.set(name, (result.get(name) ?? 0) + qty);
  }
  return result;
}

/** PP SS주문로그 → originProductNo별 (lastRunAt, now] 판매수량 합 */
async function readSsSalesByProductId(ssOrdersSheet: string, lastRunAt: string | null): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!lastRunAt) return result;
  const sheets = getSheetsClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${ssOrdersSheet}!C2:K`,
  });
  for (const row of got.data.values ?? []) {
    const orderedAt = String(row[0] ?? "");
    if (!orderedAt || orderedAt <= lastRunAt) continue;
    const qty = Number(row[5]) || 0;
    const ssId = String(row[8] ?? "").trim();
    if (!ssId || qty === 0) continue;
    result.set(ssId, (result.get(ssId) ?? 0) + qty);
  }
  return result;
}

/**
 * PP 재고마스터의 기존 식스샵 재고 컬럼 (F열) 읽기.
 * 사장님 시드값 + 매일 누적 차감된 현재 값. 매핑 row 순서로 Map<상품명, 재고>.
 */
async function readExistingSixStocks(): Promise<Map<string, number>> {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === MASTER_SHEET);
  if (!exists) return new Map();
  // 컬럼: A=카테고리|B=상품명|C=SS상품번호|D=어제식스샵판매|E=어제SS판매|F=식스샵재고|G=SS재고|H=남은재고|I=리오더
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${MASTER_SHEET}!B2:F`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const map = new Map<string, number>();
  for (const row of got.data.values ?? []) {
    const name = String(row[0] ?? "").trim();
    const stock = Number(row[4]) || 0; // F열 = index 4 in B:F slice
    if (name) map.set(name, stock);
  }
  return map;
}

async function main(): Promise<void> {
  const ppBrand = BRANDS.find((b) => b.siteLink === "produktepr");
  if (!ppBrand?.smartStore) {
    console.error("PP brand or smartStore config missing");
    process.exit(1);
  }

  const lastRunAt = await getBrandState(ppBrand, "last_pp_master_at").catch(() => null);
  console.log(`[refresh-pp-master] last_pp_master_at = ${lastRunAt ?? "(first run — 차감 없음, 시드만)"}`);

  const mapping = await readMapping();
  console.log(`[refresh-pp-master] mapping rows: ${mapping.length}`);

  console.log(`[refresh-pp-master] fetching SS stocks from API...`);
  const ssStocks = await fetchSmartStoreStocks(ppBrand);
  console.log(`[refresh-pp-master] SS stocks: ${ssStocks.size} products`);

  const sixSales = await readSixshopSalesByProduct(ppBrand.ordersSheetName, lastRunAt);
  const ssSales = await readSsSalesByProductId(ppBrand.smartStore.ssOrdersSheetName, lastRunAt);
  const existingSixStocks = await readExistingSixStocks();
  console.log(`[refresh-pp-master] sales: 식스샵=${[...sixSales.values()].reduce((a, b) => a + b, 0)}, SS=${[...ssSales.values()].reduce((a, b) => a + b, 0)}`);
  console.log(`[refresh-pp-master] existing 식스샵 stocks (사장님 시드): ${existingSixStocks.size} rows`);

  // PP 재고마스터 9열 dashboard
  const sheets = getSheetsClient();
  const spreadsheetId = config.sheets.sheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheetMeta = meta.data.sheets?.find((s) => s.properties?.title === MASTER_SHEET);
  if (!sheetMeta) {
    const r = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: MASTER_SHEET } } }] },
    });
    sheetMeta = (await sheets.spreadsheets.get({ spreadsheetId })).data.sheets?.find((s) => s.properties?.title === MASTER_SHEET);
  }
  const sheetId = sheetMeta?.properties?.sheetId;

  const header = [
    "카테고리",
    "상품명",
    "SS상품번호",
    "어제 식스샵 판매",
    "어제 SS 판매",
    "식스샵 재고",
    "SS 재고",
    "남은재고",
    "리오더 알림",
  ];

  const values: (string | number)[][] = [header];
  for (let i = 0; i < mapping.length; i++) {
    const m = mapping[i];
    const r = i + 2;
    const sixSold = sixSales.get(m.sixName) ?? 0;
    const ssSold = m.ssId ? (ssSales.get(m.ssId) ?? 0) : 0;
    const ssStock = m.ssId ? (ssStocks.get(m.ssId) ?? 0) : 0;
    // 식스샵 재고: 기존 값에서 어제 판매 차감. 첫 회는 0 (사장님이 시드해야 함).
    const existing = existingSixStocks.get(m.sixName) ?? 0;
    const sixStock = lastRunAt ? Math.max(0, existing - sixSold) : existing;
    values.push([
      "", // 카테고리 — 사장님이 매핑 시트에 추가하면 SUMIF로 가져올 수 있음 (지금은 빈)
      m.sixName,
      m.ssId,
      sixSold,
      ssSold,
      sixStock,
      ssStock,
      `=F${r}+G${r}`,
      `=IF(H${r}<=20, "⚠ 리오더", IF(H${r}<=50, "⚡ 임박", ""))`,
    ]);
  }

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${MASTER_SHEET}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${MASTER_SHEET}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${MASTER_SHEET}!K1`,
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
                range: { sheetId, startRowIndex: 0, endRowIndex: values.length, startColumnIndex: 0, endColumnIndex: header.length },
              },
            },
          },
        ],
      },
    });
  }

  await setBrandState(ppBrand, "last_pp_master_at", nowKstStamp());
  console.log(`[refresh-pp-master] ✅ done. ${mapping.length} rows pushed.`);
  if (!lastRunAt) {
    console.log(`\n⚠️ 첫 회 실행: 식스샵 재고 컬럼이 비어있습니다.`);
    console.log(`사장님이 PP 재고마스터의 "식스샵 재고" 컬럼(F)에 31개 상품의 식스샵 보유 재고를 한 번 입력해주세요.`);
    console.log(`그 후 매일 cron이 자동 차감 + SS 재고 + 어제 판매 갱신합니다.`);
  }
}

main().catch((err) => {
  console.error("refresh-pp-master failed:", err);
  process.exit(1);
});
