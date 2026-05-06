import { fetchOrdersForBrand, loginAsBrand, newBrandPage, newBrowser } from "./sixshop.js";
import {
  appendOrders,
  appendSmartStoreOrders,
  ensureBrandSchema,
  readExistingKeys,
  readExistingSsOrderIds,
  setBrandState,
} from "./sheets.js";
import { refreshInventoryForBrand } from "./seed-inventory.js";
import { rowKey, toRow } from "./types.js";
import { type Brand, BRANDS } from "./brands.js";
import type { OrderItem } from "./types.js";
import { fetchSmartStoreOrders, ssRowKey, ssToRow } from "./smartstore.js";

/** UTC Date → "YYYY-MM-DD HH:mm:ss" 형식의 KST 문자열 */
function toKstString(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`[${startedAt.toISOString()}] sixshop-collector start`);

  const browser = await newBrowser();
  let anyError = false;

  try {
    for (const brand of BRANDS) {
      const brandErrors: string[] = [];
      let newRowsCount = 0;

      await ensureBrandSchema(brand).catch((e) => {
        brandErrors.push(`schema: ${(e as Error).message}`);
      });

      const page = await newBrandPage(browser);
      try {
        await loginAsBrand(page, brand);

        // 1) 주문 수집
        try {
          const orders = await fetchOrdersForBrand(page, brand);
          newRowsCount = await appendNewOrders(brand, orders, startedAt);
        } catch (err) {
          console.error(`[${brand.displayName}] orders failed:`, (err as Error).message);
          brandErrors.push(`orders: ${(err as Error).message}`.slice(0, 80));
        }

        // 주문→재고 사이 page 정리
        await page.goto("https://www.sixshop.com/dashboard/shop-home", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // 1.5) 스마트스토어 주문 수집 (smartStore 설정된 브랜드만)
        if (brand.smartStore) {
          try {
            const ssAdded = await syncSmartStoreOrders(brand, startedAt);
            console.log(`[${brand.displayName}] SS appended ${ssAdded} new line(s)`);
          } catch (err) {
            console.error(`[${brand.displayName}] SS failed:`, (err as Error).message);
            brandErrors.push(`ss: ${(err as Error).message}`.slice(0, 80));
          }
        }

        // 2) 재고 새로고침
        try {
          await refreshInventoryForBrand(page, brand);
        } catch (err) {
          console.error(`[${brand.displayName}] inventory failed:`, (err as Error).message);
          brandErrors.push(`inv: ${(err as Error).message}`.slice(0, 80));
        }
      } finally {
        await page.context().close();
      }

      // brand별 _state 기록 (KST 시간으로)
      await setBrandState(brand, "last_run_at", toKstString(startedAt));
      if (brandErrors.length === 0) {
        await setBrandState(brand, "last_run_status", `ok:${newRowsCount}`);
      } else {
        anyError = true;
        await setBrandState(brand, "last_run_status", `partial:${newRowsCount}|${brandErrors.join(";")}`.slice(0, 200));
      }
    }
  } finally {
    await browser.close();
  }

  if (anyError) process.exit(1);
}

async function syncSmartStoreOrders(brand: Brand, startedAt: Date): Promise<number> {
  // 최근 1일치 결제완료 주문 fetch (cron 매일 1회 → 24h 윈도우 충분, 실패 대비 24h 중복 fetch 후 dedup)
  const to = startedAt;
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const lines = await fetchSmartStoreOrders(brand, from, to);
  if (lines.length === 0) {
    console.log(`[${brand.displayName}] SS: no orders in window`);
    return 0;
  }
  const existing = await readExistingSsOrderIds(brand);
  const collectedAt = toKstString(startedAt);
  const newRows = lines.filter((l) => !existing.has(ssRowKey(l))).map((l) => ssToRow(l, collectedAt));
  if (newRows.length > 0) {
    await appendSmartStoreOrders(brand, newRows);
  }
  return newRows.length;
}

async function appendNewOrders(brand: Brand, orders: OrderItem[], startedAt: Date): Promise<number> {
  console.log(`[${brand.displayName}] fetched ${orders.length} order line(s)`);
  if (orders.length === 0) return 0;

  const KEY_COLS = [0, 3, 4, 6, 8];
  const existing = await readExistingKeys(brand, KEY_COLS);
  // 주문로그의 "수집일시"도 KST로
  const collectedAt = toKstString(startedAt);

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
  for (const brand of BRANDS) {
    await setBrandState(brand, "last_run_at", toKstString(new Date())).catch(() => {});
    await setBrandState(brand, "last_run_status", `error:${(err as Error).message}`.slice(0, 200)).catch(() => {});
    break;
  }
  process.exit(1);
});
