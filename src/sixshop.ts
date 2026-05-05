import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { read, utils } from "xlsx";
import { config } from "./config.js";
import { type Brand, brandCredentials } from "./brands.js";
import type { OrderItem } from "./types.js";

const LOGIN_URL = "https://www.sixshop.com/member/login";
const ORDERS_URL = "https://www.sixshop.com/dashboard/shop-orders";
const PRODUCTS_URL = "https://www.sixshop.com/dashboard/shop-products";

export async function newBrowser(): Promise<Browser> {
  return chromium.launch({ headless: config.collect.headless });
}

/**
 * 한 brand 전용 새 context + page. 다른 brand와 cookies 분리.
 */
export async function newBrandPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    locale: "ko-KR", timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  return ctx.newPage();
}

export async function loginAsBrand(page: Page, brand: Brand): Promise<void> {
  const { email, password } = brandCredentials(brand);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  const formData = new URLSearchParams({
    idOrUserName: Buffer.from(email).toString("base64"),
    password: Buffer.from(password).toString("base64"),
    keepLoginAgreement: "on",
    trendReportLogin: "", memberNo: "0", pageNo: "0", shopCustomerNo: "0",
  }).toString();
  const res = await page.evaluate(async (body) => {
    const r = await fetch("/member/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body, credentials: "include",
    });
    return { status: r.status, ok: (await r.text()).includes('"RESULT":"OK"') };
  }, formData);
  if (!res.ok) throw new Error(`login failed for ${brand.displayName}: ${res.status}`);
}

export async function fetchOrdersForBrand(page: Page, brand: Brand): Promise<OrderItem[]> {
  await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);
  await applyPaidFilter(page);

  const xlsxPath = await downloadOrdersXlsx(page, brand);
  const orders = parseXlsx(xlsxPath);
  await unlink(xlsxPath).catch(() => {});
  return orders;
}

export async function downloadProductsCsv(page: Page): Promise<string> {
  await page.goto(PRODUCTS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector("#downloadAllProductsBtn", { timeout: 30_000 });
  await page.waitForTimeout(2000);

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator("#downloadAllProductsBtn").click();
  const download = await downloadPromise;

  const filename = download.suggestedFilename() || "products.csv";
  const out = join(tmpdir(), `sixshop-products-${Date.now()}-${filename}`);
  await download.saveAs(out);
  return out;
}

async function applyPaidFilter(page: Page): Promise<void> {
  const btn = page.getByText("결제 완료", { exact: true }).first();
  if (await btn.count()) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(2500);
  }
}

async function downloadOrdersXlsx(page: Page, brand: Brand): Promise<string> {
  await page.locator("#orderExportBtn").click();
  await page.waitForTimeout(2000);

  // 재로그인 (보안 단계). 같은 brand credentials 사용 → context 변경 없음.
  const { email, password } = brandCredentials(brand);
  const formData = new URLSearchParams({
    idOrUserName: Buffer.from(email).toString("base64"),
    password: Buffer.from(password).toString("base64"),
    keepLoginAgreement: "on",
    trendReportLogin: "", memberNo: "0", pageNo: "0", shopCustomerNo: "0",
  }).toString();
  const reloginRes = await page.evaluate(async (body) => {
    const r = await fetch("/member/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body, credentials: "include",
    });
    return { ok: (await r.text()).includes('"RESULT":"OK"') };
  }, formData);
  if (!reloginRes.ok) throw new Error("re-login failed");

  // 재로그인 다이얼로그 닫기
  await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll(".dialog_inner_content.member"))
      .find((x) => x.querySelector("#login_form"));
    if (d) {
      let p = d as HTMLElement | null;
      while (p && !p.classList.contains("dialog")) p = p.parentElement;
      if (p) p.style.display = "none";
    }
  });
  await page.waitForTimeout(1000);

  for (let i = 0; i < 3; i++) {
    const open = await page.locator("#orderExportTypeDialog.dialog--open").count();
    if (open) break;
    await page.locator("#orderExportBtn").click({ force: true });
    await page.waitForTimeout(2500);
  }
  await page.waitForSelector("#orderExportTypeDialog.dialog--open", { timeout: 15_000 });
  await page.waitForSelector("#orderExcelDownloadBtn", { state: "visible", timeout: 10_000 });
  await page.waitForTimeout(1000);

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
  await page.locator("#excelListAllAdd").click();
  await page.waitForTimeout(500);

  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("#orderExcelDownloadBtn").click({ force: true });
  const download = await downloadPromise;

  const filename = download.suggestedFilename() || "orders.xlsx";
  const path = join(tmpdir(), `sixshop-${Date.now()}-${filename}`);
  await download.saveAs(path);
  return path;
}

function parseXlsx(path: string): OrderItem[] {
  const buf = readFileSync(path);
  const wb = read(buf);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
  return rows.map(mapXlsxRow);
}

function mapXlsxRow(r: Record<string, any>): OrderItem {
  const get = (...keys: string[]): string => {
    for (const k of keys) if (k in r) return String(r[k] ?? "").trim();
    for (const k of keys) for (const rk of Object.keys(r)) {
      if (rk.includes(k)) return String(r[rk] ?? "").trim();
    }
    return "";
  };
  const num = (...keys: string[]): number => {
    const v = get(...keys);
    return Number(v.replace(/[^\d.-]/g, "")) || 0;
  };
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
