// 24h 윈도우로 각 브랜드 어제 판매 합계가 얼마 나오는지 미리 검증
import { readFileSync } from "node:fs";
import { google } from "googleapis";
import "dotenv/config";

const creds = JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_PATH, "utf8"));
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.SHEET_ID;

function windowStartKstString() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function nowKst() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

const windowStart = windowStartKstString();
console.log(`24h 윈도우: ${windowStart} ~ ${nowKst()}\n`);

const BRANDS = [
  { name: "6thanother", state: "6A _state", orders: "6A 주문로그" },
  { name: "Clear.type", state: "CT _state", orders: "CT 주문로그" },
  { name: "Produktepr", state: "PP _state", orders: "PP 주문로그" },
];

for (const b of BRANDS) {
  // current state
  const stateGot = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${b.state}!A:B` });
  const state = new Map((stateGot.data.values ?? []).map(r => [r[0], r[1]]));
  const lastRunAt = state.get("last_run_at") ?? "(없음)";
  const lastStatus = state.get("last_run_status") ?? "(없음)";

  // orders in 24h window
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${b.orders}!A2:G`,
  });
  const rows = got.data.values ?? [];
  let inWindow = 0, completedQty = 0, totalQty = 0;
  let mostRecent = "";
  const statusMap = new Map();
  for (const r of rows) {
    const orderedAt = String(r[1] ?? "");
    const status = String(r[2] ?? "").trim();
    const qty = Number(r[6]) || 0;
    if (orderedAt > mostRecent) mostRecent = orderedAt;
    if (orderedAt < windowStart) continue;
    inWindow++;
    totalQty += qty;
    statusMap.set(status, (statusMap.get(status) ?? 0) + 1);
    if (status === "결제 완료") completedQty += qty;
  }

  // orders since lastRunAt (current production logic)
  let sinceLastRun = 0, sinceLastRunQty = 0;
  if (lastRunAt !== "(없음)") {
    for (const r of rows) {
      const orderedAt = String(r[1] ?? "");
      const status = String(r[2] ?? "").trim();
      const qty = Number(r[6]) || 0;
      if (orderedAt <= lastRunAt) continue;
      if (status !== "결제 완료") continue;
      sinceLastRun++;
      sinceLastRunQty += qty;
    }
  }

  console.log(`========== ${b.name} ==========`);
  console.log(`  last_run_at=${lastRunAt} | status=${lastStatus}`);
  console.log(`  주문로그 총 행: ${rows.length}, 가장 최근 주문: ${mostRecent}`);
  console.log(`  ⚡ 24h 윈도우 안 주문: ${inWindow}건 (총 수량 ${totalQty}, 결제완료 수량 ${completedQty})`);
  console.log(`     상태별: ${[...statusMap.entries()].map(([k,v]) => `${k}=${v}`).join(", ")}`);
  console.log(`  ❌ 현재 production (lastRunAt=${lastRunAt} cutoff): 결제완료 ${sinceLastRun}건, 합 ${sinceLastRunQty}`);
  console.log();
}
