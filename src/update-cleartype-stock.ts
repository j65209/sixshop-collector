/**
 * 클리어타입 (cleartype) 식스샵 단일상품 + 옵션상품 재고 일괄 변경.
 *
 * 실행: tsx src/update-cleartype-stock.ts '<updatesJSON>'
 * 예 (단일상품): '[{"id":"1234567","name":"...","setStock":40}]'
 * 예 (옵션상품): '[{"id":"1234567","name":"...","optionNo":"99999","optionLabel":"색상: 블랙","setStock":30}]'
 *
 * 같은 productId의 변경들은 한 번에 묶어서 page 1회 진입.
 *
 * 식스에이 update-six6-stock.ts 와 동일 패턴. brand siteLink 차이만 'cleartype'.
 */
import type { Locator } from "playwright";
import { BRANDS } from "./brands.js";
import { newBrowser, newBrandPage, loginAsBrand } from "./sixshop.js";

interface ProductUpdate {
  id: string;
  name: string;
  optionNo?: string;
  optionLabel?: string;
  setStock: number;
}

interface UpdateResult {
  id: string;
  name: string;
  optionNo?: string;
  optionLabel?: string;
  setStock: number;
  status: "ok" | "skip" | "error";
  message?: string;
}

function groupByProductId(updates: ProductUpdate[]): Map<string, ProductUpdate[]> {
  const m = new Map<string, ProductUpdate[]>();
  for (const u of updates) {
    if (!m.has(u.id)) m.set(u.id, []);
    m.get(u.id)!.push(u);
  }
  return m;
}

function normalizeLabel(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[():~,/]/g, "");
}

async function updateStockForCleartype(updates: ProductUpdate[]): Promise<UpdateResult[]> {
  const brand = BRANDS.find((b) => b.siteLink === "cleartype");
  if (!brand) throw new Error("cleartype brand not found in BRANDS");

  const results: UpdateResult[] = [];
  const browser = await newBrowser();
  const page = await newBrandPage(browser);

  try {
    console.log(`[update-cleartype-stock] login as ${brand.displayName}`);
    await loginAsBrand(page, brand);
    await page.setViewportSize({ width: 1800, height: 1200 });

    const grouped = groupByProductId(updates);
    for (const [productId, items] of grouped) {
      const url = `https://www.sixshop.com/_shop/editShopProduct/${brand.siteLink}/${productId}`;
      const productName = items[0].name;
      console.log(`\n[update-cleartype-stock] ${productName} (${productId}) — ${items.length} change(s)`);

      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
        await page.waitForTimeout(1000);
      } catch (e) {
        for (const u of items) results.push({ ...u, status: "error", message: `goto failed: ${(e as Error).message}` });
        continue;
      }

      const hasOptionItems = items.some((u) => u.optionNo);
      const hasPlainItems = items.some((u) => !u.optionNo);

      if (hasPlainItems) {
        const plain = items.filter((u) => !u.optionNo);
        try {
          const candidates = await page
            .locator('input[type="number"]:visible, input[name*="tock" i]:visible, input[name*="quantity" i]:visible')
            .all();
          if (candidates.length === 0) {
            for (const u of plain) results.push({ ...u, status: "skip", message: "재고 input 없음 — 옵션 상품일 수 있음. options 매핑 누락?" });
          } else {
            const stockInput = candidates[0];
            const setVal = plain[0].setStock;
            const currentVal = await stockInput.inputValue();
            if (currentVal === String(setVal)) {
              for (const u of plain) results.push({ ...u, status: "ok", message: `변경 없음 (이미 ${currentVal})` });
            } else {
              await stockInput.fill(String(setVal));
              await stockInput.evaluate((el) => {
                (el as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
                (el as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
              });
              await page.waitForTimeout(300);
              for (const u of plain) results.push({ ...u, status: "ok", message: `${currentVal} → ${setVal}` });
            }
          }
        } catch (e) {
          for (const u of plain) results.push({ ...u, status: "error", message: `single stock fill: ${(e as Error).message}` });
        }
      }

      if (hasOptionItems) {
        const optItems = items.filter((u) => u.optionNo);
        const rowCandidates: { sel: string; locator: Locator }[] = [
          { sel: 'tr:has(input[type="number"])', locator: page.locator('tr:has(input[type="number"]):visible') },
          { sel: '[data-option-no]', locator: page.locator('[data-option-no]:visible') },
          { sel: '.option-row, .product-option-row', locator: page.locator('.option-row:visible, .product-option-row:visible') },
        ];

        let optionRows: Locator[] = [];
        for (const c of rowCandidates) {
          const found = await c.locator.all();
          if (found.length >= optItems.length) {
            optionRows = found;
            console.log(`  옵션 row selector matched: "${c.sel}" → ${found.length} row(s)`);
            break;
          }
        }
        if (optionRows.length === 0) {
          const allNum = await page.locator('input[type="number"]:visible').all();
          if (allNum.length > 1) {
            console.log(`  fallback: using number inputs 2~${allNum.length} as option rows`);
            optionRows = allNum.slice(1).map((_, i) => page.locator(`input[type="number"]:visible >> nth=${i + 1}`));
          }
        }

        for (const u of optItems) {
          let matched = false;
          for (const row of optionRows) {
            try {
              const dataNo = await row.getAttribute("data-option-no").catch(() => null);
              const hiddenNo = await row.locator(`input[type="hidden"][value="${u.optionNo}"]`).count().catch(() => 0);
              const rowText = await row.innerText().catch(() => "");
              const labelMatch = u.optionLabel && normalizeLabel(rowText).includes(normalizeLabel(u.optionLabel));
              const noMatch = dataNo === u.optionNo || hiddenNo > 0;
              if (!noMatch && !labelMatch) continue;

              const input = row.locator('input[type="number"]:visible').first();
              const exists = await input.count();
              if (!exists) continue;
              const currentVal = await input.inputValue();
              if (currentVal === String(u.setStock)) {
                results.push({ ...u, status: "ok", message: `변경 없음 (이미 ${currentVal})` });
              } else {
                await input.fill(String(u.setStock));
                await input.evaluate((el) => {
                  (el as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
                  (el as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
                });
                await page.waitForTimeout(200);
                results.push({ ...u, status: "ok", message: `${currentVal} → ${u.setStock} (옵션 ${u.optionNo})` });
              }
              matched = true;
              break;
            } catch {
              continue;
            }
          }
          if (!matched) results.push({ ...u, status: "error", message: `옵션 row 매칭 실패 (optionNo=${u.optionNo}, label="${u.optionLabel}")` });
        }
      }

      try {
        const saveBtn = page
          .locator(
            'button:visible:has-text("저장"), button:visible:has-text("수정 완료"), button:visible:has-text("수정하기")',
          )
          .first();
        await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
        await saveBtn.click();
        await page.waitForTimeout(2000);

        const confirmBtn = page.locator('button:visible:has-text("확인")').first();
        try {
          await confirmBtn.waitFor({ state: "visible", timeout: 1500 });
          await confirmBtn.click();
          await page.waitForTimeout(1000);
        } catch {
          /* no modal */
        }
        console.log(`  ✓ saved ${productName}`);
      } catch (e) {
        const msg = (e as Error).message;
        console.warn(`  save failed for ${productName}: ${msg}`);
        for (let i = results.length - 1; i >= 0; i--) {
          if (results[i].id !== productId) break;
          if (results[i].status === "ok") {
            results[i].status = "error";
            results[i].message = `${results[i].message} | save failed: ${msg}`;
          }
        }
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
      'Usage: tsx src/update-cleartype-stock.ts \'[{"id":"1234567","name":"...","setStock":40}]\'',
    );
    process.exit(2);
  }
  const updates: ProductUpdate[] = JSON.parse(updatesJson);
  const results = await updateStockForCleartype(updates);
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
