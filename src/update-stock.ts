/**
 * 식스샵 PP 브랜드 옵션 재고를 일괄 변경.
 *
 * 실행: tsx src/update-stock.ts <productSearchTerm> '<updatesJSON>'
 * 예: tsx src/update-stock.ts "180° Fast Charging Cable (8color)" \
 *       '[{"color":"블루","cable":"Apple 8pin","setStock":500}, ...]'
 *
 * 또는 GitHub Actions workflow_dispatch inputs로 호출:
 *   inputs.product_term, inputs.updates (JSON 문자열)
 *
 * cable 매칭 — 식스샵 UI의 "기종 옵션:" 텍스트 substring 매칭:
 *   "Apple 8pin"  → "USB -> Apple 8pin"
 *   "USB-C"       → "USB -> C type"
 *   "C to C"      → "C type -> C type"
 *
 * 식스샵 admin DOM (2026-06-08 검증):
 *   - 행 컨테이너: div.tb_content (한 옵션당 1개)
 *   - 옵션의 "지정" 라디오: input[type=radio][value="setInventory"]
 *     · id = "setStock<productId>-<optionId>", 라디오 자체는 display:none
 *     · 옆에 <label for="setStock..."> "지정" 라벨이 있음 → 라벨을 클릭해야 모드 전환
 *   - 같은 행의 input[type=number] 하나 (현재 모드용) — 지정 모드로 전환 후 채워야 절댓값으로 동작
 *   - 같은 행의 button "저장"
 *   - 페이지네이션: div.pagination_div > span.pagination_navi
 *     · 선택된 페이지: span.pagination_selected
 *     · 다음 버튼: span.btn-nav-next (마지막 페이지면 .navi-disabled 추가)
 *     · 페이지당 10개 행 (10개 옵션 + 같은 검색어에 걸린 다른 상품 행 포함될 수 있음)
 */
import { BRANDS, brandCredentials } from "./brands.js";
import { newBrowser, newBrandPage, loginAsBrand } from "./sixshop.js";

interface OptionUpdate {
  color: string; // "블루", "민트", "옐로우", "오렌지", "퍼플", "피치", "네온그린", "네온핑크"
  cable: string; // "Apple 8pin" | "USB-C" | "C to C"
  setStock: number; // 지정할 새 재고 수량
}

interface UpdateResult {
  color: string;
  cable: string;
  setStock: number;
  status: "ok" | "skip" | "error";
  message?: string;
}

// 식스샵 옵션 텍스트가 우리 cable 키와 매칭되는지
function matchesCable(rawOptionText: string, cable: string): boolean {
  const t = rawOptionText.toLowerCase();
  if (cable === "Apple 8pin") return /apple|8\s*pin/i.test(t);
  if (cable === "C to C") {
    const ctocCount = (t.match(/c\s*type/g) || []).length;
    return ctocCount >= 2 && !/usb/.test(t);
  }
  if (cable === "USB-C") {
    return /usb/.test(t) && !/apple|8\s*pin/.test(t) && /c\s*type/.test(t);
  }
  return false;
}

interface PendingUpdate extends OptionUpdate {
  done: boolean;
  result?: UpdateResult;
}

async function updateStockForPP(
  productSearchTerm: string,
  updates: OptionUpdate[],
): Promise<UpdateResult[]> {
  const brand = BRANDS.find((b) => b.credEnvSuffix === "_PP");
  if (!brand) throw new Error("PP brand not found in BRANDS");

  const pending: PendingUpdate[] = updates.map((u) => ({ ...u, done: false }));
  const browser = await newBrowser();
  const page = await newBrandPage(browser);

  try {
    console.log(`[update-stock] login as ${brand.displayName}`);
    await loginAsBrand(page, brand);

    const url = `https://www.sixshop.com/dashboard/shop-products-inventory?searchKeyword=${encodeURIComponent(
      productSearchTerm,
    )}`;
    console.log(`[update-stock] goto ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.setViewportSize({ width: 1800, height: 1000 });

    // 검색어 URL 파라미터가 무시되는 경우 대비 — 검색박스에 직접 타이핑 + Enter
    try {
      const search = page.locator('input[placeholder*="상품 이름"], input[placeholder*="상품"]').first();
      const cnt = await search.count();
      if (cnt > 0) {
        const cur = (await search.inputValue().catch(() => "")) || "";
        if (!cur.trim()) {
          await search.fill(productSearchTerm);
          await search.press("Enter");
          await page.waitForTimeout(1500);
        }
      }
    } catch (e) {
      // best-effort
    }

    const MAX_PAGES = 10;
    for (let pageIdx = 1; pageIdx <= MAX_PAGES; pageIdx++) {
      // 표 로드 대기
      await page
        .waitForSelector('div.tb_content input[type="radio"][value="setInventory"]', { timeout: 15_000 })
        .catch(() => undefined);
      await page.waitForTimeout(600);

      // 케이블 옵션 행: div.tb_content + setInventory radio 보유 + productSearchTerm 텍스트 포함
      const rows = await page
        .locator("div.tb_content")
        .filter({ has: page.locator('input[type="radio"][value="setInventory"]') })
        .filter({ hasText: productSearchTerm })
        .all();
      console.log(`[update-stock] page ${pageIdx}: ${rows.length} option rows`);

      for (const row of rows) {
        if (pending.every((u) => u.done)) break;

        const rowText: string = await row.evaluate((el) =>
          (el as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        );
        const colorMatch = rowText.match(/컬러:\s*([^\s/]+)/);
        const cableMatch = rowText.match(/기종\s*옵션:\s*(.+?)\s*-\s*(?:\d+(?:,\d+)*\s*개|품절)/);
        if (!colorMatch || !cableMatch) continue;
        const rowColor = colorMatch[1].trim();
        const rowCableRaw = cableMatch[1].trim();

        const u = pending.find(
          (p) => !p.done && p.color === rowColor && matchesCable(rowCableRaw, p.cable),
        );
        if (!u) continue;

        try {
          const radio = row.locator('input[type="radio"][value="setInventory"]').first();
          const radioId = await radio.getAttribute("id");
          if (!radioId) throw new Error("setInventory radio has no id");
          // "지정" 라벨 클릭 — 라디오 자체는 display:none이라 직접 클릭 안 됨
          const label = page.locator(`label[for="${radioId}"]`).first();
          await label.click({ timeout: 5_000 });
          await page.waitForTimeout(300);

          // 같은 행의 number input (지정 모드용) 채우기
          const numInput = row.locator('input[type="number"]').first();
          await numInput.waitFor({ state: "visible", timeout: 5_000 });
          await numInput.fill(String(u.setStock));
          await numInput.evaluate((el) => {
            (el as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
            (el as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
          });

          // 같은 행의 "저장" 버튼
          const saveBtn = row.locator("button", { hasText: "저장" }).first();
          await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
          await saveBtn.click();
          await page.waitForTimeout(1500);

          u.done = true;
          u.result = { color: u.color, cable: u.cable, setStock: u.setStock, status: "ok" };
          console.log(`[update-stock] ✓ ${u.color}/${u.cable} = ${u.setStock}`);
        } catch (e) {
          u.done = true;
          u.result = {
            color: u.color,
            cable: u.cable,
            setStock: u.setStock,
            status: "error",
            message: (e as Error).message,
          };
          console.warn(`[update-stock] ✗ ${u.color}/${u.cable}:`, (e as Error).message);
        }
      }

      if (pending.every((u) => u.done)) break;

      // 다음 페이지로
      const nextBtn = page
        .locator("div.pagination_div")
        .filter({ has: page.locator("span.pagination_selected") })
        .locator("span.btn-nav-next")
        .first();
      const hasNext = (await nextBtn.count()) > 0;
      if (!hasNext) {
        console.log(`[update-stock] no next page button — stopping at page ${pageIdx}`);
        break;
      }
      const isDisabled = await nextBtn
        .evaluate((el) => el.classList.contains("navi-disabled"))
        .catch(() => true);
      if (isDisabled) {
        console.log(`[update-stock] reached last page (${pageIdx})`);
        break;
      }
      await nextBtn.click();
      // 페이지 전환 대기 — pagination_selected의 텍스트가 변할 때까지
      await page.waitForFunction(
        (prev) => {
          const sel = document.querySelector(
            "div.pagination_div span.pagination_selected",
          );
          return sel && (sel.textContent || "").trim() !== String(prev);
        },
        pageIdx,
        { timeout: 8_000 },
      ).catch(() => undefined);
      await page.waitForTimeout(600);
    }

    // 미매칭 분류
    for (const u of pending) {
      if (!u.result) {
        u.result = {
          color: u.color,
          cable: u.cable,
          setStock: u.setStock,
          status: "skip",
          message: "row not found",
        };
        console.warn(`[update-stock] ✗ ${u.color}/${u.cable}: row not found`);
      }
    }

    return pending.map((u) => u.result!);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const productTerm = process.argv[2] || process.env.PRODUCT_TERM;
  const updatesJson = process.argv[3] || process.env.UPDATES_JSON;
  if (!productTerm || !updatesJson) {
    console.error(
      "Usage: tsx src/update-stock.ts <productTerm> <updatesJSON>\n" +
        '  example: tsx src/update-stock.ts "180° Fast Charging Cable (8color)" ' +
        '\'[{"color":"블루","cable":"Apple 8pin","setStock":500}]\'',
    );
    process.exit(2);
  }
  const updates: OptionUpdate[] = JSON.parse(updatesJson);
  const results = await updateStockForPP(productTerm, updates);
  console.log("\n=== RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
  const fails = results.filter((r) => r.status !== "ok").length;
  if (fails > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}
