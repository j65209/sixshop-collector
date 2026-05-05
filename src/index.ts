import { fetchOrdersForBrand, loginAsBrand, newBrandPage, newBrowser } from "./sixshop.js";
import { appendOrders, ensureBrandSchema, readExistingKeys, setState } from "./sheets.js";
import { refreshInventoryForBrand } from "./seed-inventory.js";
import { rowKey, toRow } from "./types.js";
import { type Brand, BRANDS } from "./brands.js";
import type { OrderItem } from "./types.js";

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`[${startedAt.toISOString()}] sixshop-collector start`);

  const browser = await newBrowser();
  let totalNewRows = 0;
  const errors: string[] = [];

  try {
    for (const brand of BRANDS) {
      await ensureBrandSchema(brand).catch((e) => {
        errors.push(`${brand.displayName} schema: ${(e as Error).message}`);
      });

      const page = await newBrandPage(browser);
      try {
        await loginAsBrand(page, brand);

        // 1) 주문 수집
        try {
          const orders = await fetchOrdersForBrand(page, brand);
          const newRows = await appendNewOrders(brand, orders, startedAt);
          totalNewRows += newRows;
        } catch (err) {
          console.error(`[${brand.displayName}] orders failed:`, (err as Error).message);
          errors.push(`${brand.displayName} orders: ${(err as Error).message}`.slice(0, 100));
        }

        // 주문→재고 사이 page 정리 (다이얼로그 잔재 제거)
        await page.goto("https://www.sixshop.com/dashboard/shop-home", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // 2) 재고 새로고침
        try {
          await refreshInventoryForBrand(page, brand);
        } catch (err) {
          console.error(`[${brand.displayName}] inventory failed:`, (err as Error).message);
          errors.push(`${brand.displayName} inv: ${(err as Error).message}`.slice(0, 100));
        }
      } finally {
        await page.context().close();
      }
    }
  } finally {
    await browser.close();
  }

  await setState("last_run_at", startedAt.toISOString());
  if (errors.length === 0) {
    await setState("last_run_status", `ok:${totalNewRows}`);
  } else {
    await setState("last_run_status", `partial:${totalNewRows}|${errors.join(";")}`.slice(0, 200));
    process.exit(1);
  }
}

async function appendNewOrders(brand: Brand, orders: OrderItem[], startedAt: Date): Promise<number> {
  console.log(`[${brand.displayName}] fetched ${orders.length} order line(s)`);
  if (orders.length === 0) return 0;

  const KEY_COLS = [0, 3, 4, 6, 8];
  const existing = await readExistingKeys(brand, KEY_COLS);
  const collectedAt = startedAt.toISOString();

  const newRows = orders
    .filter((o) => !existing.has(rowKey(o)))
    .map((o) => toRow(o, collectedAt));

  if (newRows.length === 0) {
    console.log(`[${brand.displayName}] no new rows`);
  } else {
    await appendOrders(brand, newRows);
    console.log(`[${brand.displayName}] appended ${newRows.length} new row(s)`);
  }
  return newRows.length;
}

main().catch(async (err) => {
  console.error("collector failed:", err);
  try {
    await setState("last_run_at", new Date().toISOString());
    await setState("last_run_status", `error:${(err as Error).message}`.slice(0, 200));
  } catch {}
  process.exit(1);
});
