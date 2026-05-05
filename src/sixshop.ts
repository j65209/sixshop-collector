import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { read, utils } from "xlsx";
import { config } from "./config.js";
import type { OrderItem } from "./types.js";

const LOGIN_URL = "https://www.sixshop.com/member/login";
const ORDERS_URL = "https://www.sixshop.com/dashboard/shop-orders";
const DEBUG_DUMP = process.env.DEBUG_DUMP_XHR === "true";

export async function fetchRecentOrders(): Promise<OrderItem[]> {
  const browser = await chromium.launch({ headless: config.collect.headless });
  try {
    const ctx = await browser.newContext({
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    const page = await ctx.newPage();

    await login(page);
    await gotoOrders(page);
    await applyPaidFilter(page);
    const xlsxPath = await downloadOrdersXlsx(page);
    const orders = parseXlsx(xlsxPath);

    if (!DEBUG_DUMP) await unlink(xlsxPath).catch(() => {});
    return orders;
  } finally {
    await browser.close();
  }
}

async function login(page: Page): Promise<void> {
  // 로그인 페이지 방문해 쿠키 셋업
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // 직접 POST — UI 키보드 입력보다 CI에서 안정적 (재로그인 흐름과 동일)
  const formData = new URLSearchParams({
    idOrUserName: Buffer.from(config.sixshop.email).toString("base64"),
    password: Buffer.from(config.sixshop.password).toString("base64"),
    keepLoginAgreement: "on",
    trendReportLogin: "",
    memberNo: "0",
    pageNo: "0",
    shopCustomerNo: "0",
  }).toString();
  const res = await page.evaluate(async (body) => {
    const r = await fetch("/member/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      credentials: "include",
    });
    const t = await r.text();
    return { status: r.status, ok: t.includes('"RESULT":"OK"'), bodyHead: t.slice(0, 200) };
  }, formData);
  if (!res.ok) {
    throw new Error(`login failed: status=${res.status}, body=${res.bodyHead}`);
  }
}

async function gotoOrders(page: Page): Promise<void> {
  await page.goto(ORDERS_URL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2000);
}

async function applyPaidFilter(page: Page): Promise<void> {
  // 좌측 사이드 메뉴의 "결제 완료" 필터 클릭
  await page.getByText("결제 완료", { exact: true }).first().click();
  await page.waitForTimeout(2500);
}

async function downloadOrdersXlsx(page: Page): Promise<string> {
  // 1) 전체 목록 내려받기 클릭 → 재로그인 다이얼로그 등장
  await page.locator("#orderExportBtn").click();
  await page.waitForTimeout(2000);

  // 2) 재로그인은 직접 POST로 우회 (쿠키 공유)
  const formData = new URLSearchParams({
    idOrUserName: Buffer.from(config.sixshop.email).toString("base64"),
    password: Buffer.from(config.sixshop.password).toString("base64"),
    keepLoginAgreement: "on",
    trendReportLogin: "",
    memberNo: "0",
    pageNo: "0",
    shopCustomerNo: "0",
  }).toString();
  const reloginRes = await page.evaluate(async (body) => {
    const r = await fetch("/member/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      credentials: "include",
    });
    return { status: r.status, ok: (await r.text()).includes('"RESULT":"OK"') };
  }, formData);
  if (!reloginRes.ok) throw new Error(`re-login failed: ${JSON.stringify(reloginRes)}`);

  // 3) 재로그인 다이얼로그만 숨기기 (orderExportTypeDialog는 그대로 유지)
  await page.evaluate(() => {
    const reLoginDialog = Array.from(document.querySelectorAll(".dialog_inner_content.member"))
      .find((d) => d.querySelector("#login_form"));
    if (reLoginDialog) {
      let p = reLoginDialog as HTMLElement | null;
      while (p && !p.classList.contains("dialog")) p = p.parentElement;
      if (p) p.style.display = "none";
    }
  });
  await page.waitForTimeout(1000);

  // 4) orderExportTypeDialog가 안정적으로 열릴 때까지 대기 (안 열렸으면 export 재클릭)
  for (let i = 0; i < 3; i++) {
    const open = await page.locator("#orderExportTypeDialog.dialog--open").count();
    if (open) break;
    await page.locator("#orderExportBtn").click({ force: true });
    await page.waitForTimeout(2500);
  }
  await page.waitForSelector("#orderExportTypeDialog.dialog--open", { timeout: 15_000 });
  await page.waitForSelector("#orderExcelDownloadBtn", { state: "visible", timeout: 10_000 });
  await page.waitForTimeout(1000);

  // 5) 양식 = "상품별로 행 나누기"
  await page.evaluate(() => {
    const sel = document.querySelector("#orderExportTypeDialog select") as HTMLSelectElement | null;
    if (sel) {
      const opt = Array.from(sel.options).find((o) => o.text.includes("상품별로 행 나누기") && !o.text.includes("네이버페이"));
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  });
  // 6) "전체 추가" 클릭 — 모든 항목(주문번호 포함)을 내려받기 대상으로
  await page.locator("#excelListAllAdd").click();
  await page.waitForTimeout(500);

  // 6) "내려받기" 버튼 클릭 → xlsx 다운로드
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#orderExcelDownloadBtn").click({ force: true });
  const download = await downloadPromise;

  const filename = download.suggestedFilename() || "orders.xlsx";
  const path = join(tmpdir(), `sixshop-${Date.now()}-${filename}`);
  await download.saveAs(path);
  console.log(`[xlsx saved] ${path}`);
  return path;
}

function parseXlsx(path: string): OrderItem[] {
  const buf = readFileSync(path);
  const wb = read(buf);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });

  if (DEBUG_DUMP && rows.length > 0) {
    console.log("[xlsx columns]", Object.keys(rows[0]));
    console.log("[first row]", JSON.stringify(rows[0], null, 2));
  }

  return rows.map((r) => mapXlsxRow(r));
}

function mapXlsxRow(r: Record<string, any>): OrderItem {
  // exact match → contains 매칭 순으로 (오탐 방지)
  const get = (...keys: string[]): string => {
    for (const k of keys) {
      if (k in r) return String(r[k] ?? "").trim();
    }
    for (const k of keys) {
      for (const rk of Object.keys(r)) {
        if (rk.includes(k)) return String(r[rk] ?? "").trim();
      }
    }
    return "";
  };
  const num = (...keys: string[]): number => {
    const v = get(...keys);
    return Number(v.replace(/[^\d.-]/g, "")) || 0;
  };

  // 주문번호 우선, 없으면 상품 주문번호(네이버페이) 사용
  const orderNumber = get("주문번호") || get("상품 주문번호");
  const optionText = [get("상품 옵션 정보"), get("추가 옵션 정보"), get("작성형 옵션 정보")]
    .filter(Boolean).join(" / ");

  return {
    orderNumber,
    orderedAt: get("주문 일자"),
    status: get("주문 상태", "상품별 주문 상태") || "결제완료",
    productName: get("상품 이름"),
    optionText,
    sku: get("상품 코드"),
    quantity: num("수량"),
    unitPrice: num("상품별 결제 금액") / Math.max(num("수량"), 1),
    lineTotal: num("상품별 결제 금액") || num("결제 금액"),
    paymentMethod: get("결제 방법"),
    buyerName: get("주문자 이름"),
    raw: r,
  };
}
