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
 *   "Apple 8pin"  → "USB -> Apple 8pin" 또는 "USB - Apple 8pin"
 *   "C type"      → "USB -> C type" 또는 "USB - C type"   (Apple 8pin 제외)
 *   "C to C"      → "C type -> C type" 또는 "C type - C type"
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
    // "c type ... c type" + "usb"가 없으면 C to C
    const ctocCount = (t.match(/c\s*type/g) || []).length;
    return ctocCount >= 2 && !/usb/.test(t);
  }
  if (cable === "USB-C") {
    // USB 포함 + apple/8pin 없으면 USB-C
    return /usb/.test(t) && !/apple|8\s*pin/.test(t) && /c\s*type/.test(t);
  }
  return false;
}

async function updateStockForPP(
  productSearchTerm: string,
  updates: OptionUpdate[],
): Promise<UpdateResult[]> {
  const brand = BRANDS.find((b) => b.credEnvSuffix === "_PP");
  if (!brand) throw new Error("PP brand not found in BRANDS");

  const results: UpdateResult[] = [];
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

    // viewport 충분히 — 저장 버튼이 잘리지 않게
    await page.setViewportSize({ width: 1800, height: 1000 });

    // 옵션 행 모두 수집 + 텍스트 분석
    // 식스샵 admin: 옵션 행마다 input[type=number] + 같은 row에 "저장" button
    const numberInputs = await page.locator('input[type="number"]:visible').all();
    console.log(`[update-stock] visible number inputs: ${numberInputs.length}`);

    if (numberInputs.length === 0) {
      throw new Error("no number inputs found — search term not matched?");
    }

    for (const u of updates) {
      try {
        let matched = false;
        for (const inp of numberInputs) {
          // 같은 row의 텍스트 (input의 ancestor row text)
          const rowText = await inp.evaluate((el) => {
            // 가장 가까운 'row' 컨테이너 — tr 또는 [class*=row]
            let node: HTMLElement | null = el as HTMLElement;
            for (let i = 0; i < 8 && node; i++) {
              if (
                node.tagName === "TR" ||
                /row|item|line/i.test(node.className || "")
              ) {
                return node.innerText || "";
              }
              node = node.parentElement;
            }
            return el.parentElement?.parentElement?.parentElement?.innerText || "";
          });

          const colorMatch = rowText.includes(u.color);
          const cableMatch = matchesCable(rowText, u.cable);
          if (!colorMatch || !cableMatch) continue;

          console.log(`[update-stock] matched row: ${u.color}/${u.cable}`);

          // 같은 row의 "지정" radio 클릭 (있으면)
          const inpHandle = await inp.elementHandle();
          if (!inpHandle) continue;
          const rowBox = await inp.evaluate((el) => {
            let node: HTMLElement | null = el as HTMLElement;
            for (let i = 0; i < 8 && node; i++) {
              if (node.tagName === "TR" || /row|item|line/i.test(node.className || "")) {
                return { selector: "found" };
              }
              node = node.parentElement;
            }
            return null;
          });

          // "지정" radio — input 형제/조상에 있는 두 번째 radio
          const radios = inp.locator('xpath=ancestor::*[self::tr or contains(@class,"row")][1]//input[@type="radio"]');
          const radioCount = await radios.count();
          if (radioCount >= 2) {
            await radios.nth(1).check(); // 두 번째 radio = "지정"
          }

          // input 채우기
          await inp.fill(String(u.setStock));
          await inp.evaluate((el) => {
            (el as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
            (el as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
          });

          // 같은 row의 "저장" 버튼 클릭
          const saveBtn = inp.locator(
            'xpath=ancestor::*[self::tr or contains(@class,"row")][1]//button[contains(text(),"저장") or contains(.,"저장")]',
          );
          await saveBtn.first().waitFor({ state: "visible", timeout: 5_000 });
          await saveBtn.first().click();

          // 식스샵의 저장 후 확인 모달이나 응답 대기
          await page.waitForTimeout(1500);

          results.push({ color: u.color, cable: u.cable, setStock: u.setStock, status: "ok" });
          matched = true;
          break;
        }
        if (!matched) {
          results.push({
            color: u.color,
            cable: u.cable,
            setStock: u.setStock,
            status: "skip",
            message: "row not found",
          });
        }
      } catch (e) {
        const msg = (e as Error).message;
        console.warn(`[update-stock] ${u.color}/${u.cable} failed:`, msg);
        results.push({
          color: u.color,
          cable: u.cable,
          setStock: u.setStock,
          status: "error",
          message: msg,
        });
      }
    }
  } finally {
    await browser.close();
  }

  return results;
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
