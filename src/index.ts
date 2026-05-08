import { fetchOrdersForBrand, loginAsBrand, newBrandPage, newBrowser } from "./sixshop.js";
import { appendOrders, ensureBrandSchema, readExistingKeys, setBrandState } from "./sheets.js";
import { pendingByKeyFromOrders, refreshInventoryForBrand } from "./seed-inventory.js";
import { rowKey, toRow } from "./types.js";
import { type Brand, BRANDS } from "./brands.js";
import type { OrderItem } from "./types.js";

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

        // 1) 주문 수집 — fetchOrdersForBrand 내부에 5회 retry + exponential backoff 내장
        let orders: OrderItem[] = [];
        try {
          orders = await fetchOrdersForBrand(page, brand);
          newRowsCount = await appendNewOrders(brand, orders, startedAt);
        } catch (err) {
          console.error(`[${brand.displayName}] orders failed:`, (err as Error).message);
          brandErrors.push(`orders: ${(err as Error).message}`.slice(0, 80));
        }

        // 주문→재고 사이 page 정리
        await page.goto("https://www.sixshop.com/dashboard/shop-home", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // 스마트스토어 sync는 IP 화이트리스트 때문에 GHA에서 못 돌림 — `npm run sync-ss`를 사용자 PC에서 실행

        // 2) 재고 새로고침 — 결제완료(발송대기) 카운트는 위에서 fresh fetch한 orders 그대로 합산
        // (운송장 출력하면 식스샵 어드민의 "결제완료" 탭에서 빠지므로 다음 cron엔 자연 차감)
        if (brand.inventoryEnabled) {
          try {
            const pendingByKey = pendingByKeyFromOrders(orders);
            await refreshInventoryForBrand(page, brand, pendingByKey);
          } catch (err) {
            console.error(`[${brand.displayName}] inventory failed:`, (err as Error).message);
            brandErrors.push(`inv: ${(err as Error).message}`.slice(0, 80));
          }
        } else {
          console.log(`[${brand.displayName}] inventory refresh skipped (inventoryEnabled=false)`);
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
