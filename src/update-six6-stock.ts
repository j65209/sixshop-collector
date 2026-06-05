/**
 * 식스에이 (6thanother) 식스샵 단일상품 재고 일괄 변경.
 *
 * 실행: tsx src/update-six6-stock.ts '<updatesJSON>'
 * 예: tsx src/update-six6-stock.ts '[{"id":"9439051","name":"GRANADA Necklace","setStock":40}]'
 *
 * GitHub Actions workflow_dispatch:
 *   inputs.updates (JSON 문자열)
 *
 * 식스에이는 PA 미등록 — 식스샵 admin만 단독 sync.
 * 옵션 없는 단일상품 70개. 상품 admin URL로 직접 진입 후 재고 input 변경 + 저장.
 */
import { BRANDS } from "./brands.js";
import { newBrowser, newBrandPage, loginAsBrand } from "./sixshop.js";

interface ProductUpdate {
  id: string;
  name: string;
  setStock: number;
}

interface UpdateResult {
  id: string;
  name: string;
  setStock: number;
  status: "ok" | "skip" | "error";
  message?: string;
}

async function updateStockForSixA(updates: ProductUpdate[]): Promise<UpdateResult[]> {
  const brand = BRANDS.find((b) => b.siteLink === "6thanother");
  if (!brand) throw new Error("6thanother brand not found in BRANDS");

  const results: UpdateResult[] = [];
  const browser = await newBrowser();
  const page = await newBrandPage(browser);

  try {
    console.log(`[update-six6-stock] login as ${brand.displayName}`);
    await loginAsBrand(page, brand);
    await page.setViewportSize({ width: 1800, height: 1000 });

    for (const u of updates) {
      try {
        const url = `https://www.sixshop.com/_shop/editShopProduct/6thanother/${u.id}`;
        console.log(`\n[update-six6-stock] ${u.name} (${u.id}) → ${u.setStock}`);
        await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
        await page.waitForTimeout(800);

        // 재고 수량 input 찾기 — 옵션 없는 단일상품의 메인 stock input
        // 다양한 selector 시도 (식스샵 admin DOM 변동 대비)
        const candidates = await page
          .locator('input[type="number"]:visible, input[name*="tock" i]:visible, input[name*="quantity" i]:visible')
          .all();
        if (candidates.length === 0) {
          results.push({ ...u, status: "skip", message: "재고 input 없음 (옵션 상품일 수 있음)" });
          continue;
        }

        // 첫 input이 메인 재고. (옵션 있으면 첫 input이 옵션의 첫 항목일 수도)
        // 옵션 상품 처리는 차후 확장. 일단 단일 상품만.
        const stockInput = candidates[0];

        // 현재값 확인 + 변경
        const currentVal = await stockInput.inputValue();
        if (currentVal === String(u.setStock)) {
          results.push({ ...u, status: "ok", message: `변경 없음 (이미 ${currentVal})` });
          continue;
        }
        await stockInput.fill(String(u.setStock));
        await stockInput.evaluate((el) => {
          (el as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
          (el as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
        });
        await page.waitForTimeout(400);

        // "저장" 또는 "수정" 버튼 클릭 (페이지 상/하단 어디든)
        const saveBtn = page
          .locator(
            'button:visible:has-text("저장"), button:visible:has-text("수정 완료"), button:visible:has-text("수정하기")',
          )
          .first();
        await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
        await saveBtn.click();

        // 응답 대기 (식스샵 confirm 모달 또는 응답)
        await page.waitForTimeout(2000);

        // 모달 확인 버튼 (있으면)
        const confirmBtn = page.locator('button:visible:has-text("확인")').first();
        try {
          await confirmBtn.waitFor({ state: "visible", timeout: 1500 });
          await confirmBtn.click();
          await page.waitForTimeout(1000);
        } catch {
          /* 모달 없음 = 그대로 진행 */
        }

        results.push({ ...u, status: "ok", message: `${currentVal} → ${u.setStock}` });
        console.log(`[update-six6-stock]   ✓ ${u.name}: ${currentVal} → ${u.setStock}`);
      } catch (e) {
        const msg = (e as Error).message;
        console.warn(`[update-six6-stock] ${u.name} failed:`, msg);
        results.push({ ...u, status: "error", message: msg });
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

async function main(): Promise<void> {
  const updatesJson = process.argv[2] || process.env.UPDATES_JSON;
  if (!updatesJson) {
    console.error(
      'Usage: tsx src/update-six6-stock.ts \'[{"id":"9439051","name":"GRANADA","setStock":40}]\'',
    );
    process.exit(2);
  }
  const updates: ProductUpdate[] = JSON.parse(updatesJson);
  const results = await updateStockForSixA(updates);
  console.log("\n=== RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
  const fails = results.filter((r) => r.status === "error").length;
  if (fails > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}
