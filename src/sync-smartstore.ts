import "dotenv/config";
import { BRANDS } from "./brands.js";
import {
  appendSmartStoreOrders,
  ensureBrandSchema,
  readExistingSsOrderIds,
  setBrandState,
} from "./sheets.js";
import { fetchSmartStoreOrders, ssRowKey, ssToRow } from "./smartstore.js";

function toKstString(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/**
 * 사용자 PC(네이버 화이트리스트 등록된 IP)에서 실행.
 * 스마트스토어 결제완료 주문 → 각 브랜드의 SS주문로그 시트에 적재.
 *
 * 윈도우: 기본 7일치. 환경변수 SS_DAYS로 조정 가능 (예: SS_DAYS=30).
 */
async function main(): Promise<void> {
  const startedAt = new Date();
  const days = Number(process.env.SS_DAYS) || 7;
  const to = startedAt;
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  console.log(`[sync-ss] window: ${toKstString(from)} ~ ${toKstString(to)} (KST)`);

  let anyError = false;
  for (const brand of BRANDS) {
    if (!brand.smartStore) continue;
    try {
      await ensureBrandSchema(brand);
      const lines = await fetchSmartStoreOrders(brand, from, to);
      console.log(`[${brand.displayName}] SS fetched ${lines.length} line(s)`);
      const existing = await readExistingSsOrderIds(brand);
      const collectedAt = toKstString(startedAt);
      const newRows = lines
        .filter((l) => !existing.has(ssRowKey(l)))
        .map((l) => ssToRow(l, collectedAt));
      if (newRows.length > 0) {
        await appendSmartStoreOrders(brand, newRows);
      }
      console.log(`[${brand.displayName}] SS appended ${newRows.length} new line(s)`);
      await setBrandState(brand, "last_ss_sync_at", toKstString(startedAt));
      await setBrandState(brand, "last_ss_sync_status", `ok:${newRows.length}`);
    } catch (err) {
      anyError = true;
      const msg = (err as Error).message;
      console.error(`[${brand.displayName}] SS failed:`, msg);
      await setBrandState(brand, "last_ss_sync_at", toKstString(startedAt)).catch(() => {});
      await setBrandState(brand, "last_ss_sync_status", `error:${msg}`.slice(0, 200)).catch(() => {});
    }
  }

  if (anyError) process.exit(1);
}

main().catch((err) => {
  console.error("sync-ss fatal:", err);
  process.exit(1);
});
