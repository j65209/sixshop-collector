/**
 * 에이블리 셀러 어드민 (https://my.a-bly.com) endpoint 탐색용 일회성 probe.
 *
 * 사용법:
 *   PATH="/c/Program Files/nodejs:$PATH" npx tsx src/probe-ably.ts
 *
 * 동작:
 *   1. Playwright headed 모드로 my.a-bly.com 띄움 (사장님이 직접 로그인)
 *   2. 모든 a-bly.com XHR 응답을 캡처해서 _ably-probe.json에 저장
 *   3. 브라우저 닫으면 자동 종료 + storageState를 _ably-auth-state.json에 저장 (다음에 자동 로그인용)
 *
 * 캡처 후 분석: _ably-probe.json 보고 endpoint URL/응답 구조 파악 → sync-ably.ts 작성.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

interface CapturedRequest {
  url: string;
  method: string;
  status: number;
  contentType: string;
  bodyPreview: string;
}

const captured: CapturedRequest[] = [];
const seenUrls = new Set<string>();

function saveCapture(): void {
  try {
    writeFileSync("_ably-probe.json", JSON.stringify(captured, null, 2));
    console.log(`\n[probe-ably] 저장 완료: _ably-probe.json (${captured.length} responses, ${seenUrls.size} unique URLs)`);
  } catch (e) {
    console.error("[probe-ably] save failed:", (e as Error).message);
  }
}

async function main(): Promise<void> {
  // Playwright 번들 chromium이 spawn UNKNOWN으로 실패 → 시스템 Chrome 사용
  const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--start-maximized"] });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();

  page.on("response", async (resp) => {
    const url = resp.url();
    if (!url.includes("a-bly.com")) return;
    const ct = resp.headers()["content-type"] ?? "";
    // JSON 응답만 (페이지/이미지/CSS 제외)
    if (!ct.includes("json")) return;
    try {
      const body = await resp.text();
      const preview = body.length > 4000 ? body.slice(0, 4000) + `\n…[truncated, total ${body.length} chars]` : body;
      captured.push({
        url,
        method: resp.request().method(),
        status: resp.status(),
        contentType: ct,
        bodyPreview: preview,
      });
      const urlKey = `${resp.request().method()} ${url.split("?")[0]}`;
      if (!seenUrls.has(urlKey)) {
        seenUrls.add(urlKey);
        console.log(`[NEW] ${resp.status()} ${urlKey}`);
      }
      // 응답 받을 때마다 저장 (중간 종료에도 안전)
      if (captured.length % 5 === 0) saveCapture();
    } catch {
      /* ignore */
    }
  });

  await page.goto("https://my.a-bly.com/dashboard").catch(() => {});

  console.log("\n========================================");
  console.log("  브라우저 창에서 직접 로그인 후");
  console.log("  ▶ 주문 목록 페이지");
  console.log("  ▶ 상품 목록 페이지");
  console.log("  ▶ 옵션/재고 페이지");
  console.log("  순으로 둘러봐주세요.");
  console.log("  끝나면 브라우저 창을 그냥 닫으면 됩니다.");
  console.log("========================================\n");

  // 브라우저 닫힐 때까지 대기
  await new Promise<void>((resolve) => {
    browser.on("disconnected", () => resolve());
  });

  saveCapture();
  console.log("[probe-ably] 종료");
  process.exit(0);
}

main().catch((e) => {
  console.error("[probe-ably] error:", e);
  saveCapture();
  process.exit(1);
});

process.on("SIGINT", () => {
  saveCapture();
  process.exit(0);
});
