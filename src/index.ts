import { fetchRecentOrders } from "./sixshop.js";
import { appendOrders, ensureSchema, readExistingKeys, setState, tagInventoryHeaderWithDate } from "./sheets.js";
import { rowKey, toRow } from "./types.js";

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`[${startedAt.toISOString()}] sixshop-collector start`);

  await ensureSchema();

  const orders = await fetchRecentOrders();
  console.log(`fetched ${orders.length} order line(s) from sixshop`);

  if (orders.length === 0) {
    await setState("last_run_at", startedAt.toISOString());
    await setState("last_run_status", "ok:empty");
    await tagInventoryHeaderWithDate();
    return;
  }

  // 한 주문 안에 같은 상품+옵션이 여러 라인일 수 있어 수량/합계까지 포함
  const KEY_COLS = [0, 3, 4, 6, 8]; // 주문번호, 상품명, 옵션, 수량, 합계
  const existing = await readExistingKeys(KEY_COLS);
  const collectedAt = startedAt.toISOString();

  const newRows = orders
    .filter((o) => !existing.has(rowKey(o)))
    .map((o) => toRow(o, collectedAt));

  if (newRows.length === 0) {
    console.log("no new rows (all already in sheet)");
  } else {
    await appendOrders(newRows);
    console.log(`appended ${newRows.length} new row(s)`);
  }

  await setState("last_run_at", collectedAt);
  await setState("last_run_status", `ok:${newRows.length}`);
  await tagInventoryHeaderWithDate();
}

main().catch(async (err) => {
  console.error("collector failed:", err);
  try {
    await setState("last_run_at", new Date().toISOString());
    await setState("last_run_status", `error:${(err as Error).message}`.slice(0, 200));
  } catch {
    // state 기록 실패는 무시
  }
  process.exit(1);
});
