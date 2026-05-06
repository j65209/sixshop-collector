import "dotenv/config";
import { chromium } from "playwright";
import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { read, utils } from "xlsx";

// 1) 시트 읽기
const path = process.env.GOOGLE_SERVICE_ACCOUNT_PATH.replace(/^~/, process.env.HOME);
const creds = JSON.parse(readFileSync(path, "utf8"));
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });

const stockSheet = await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.SHEET_ID,
  range: "PP 재고마스터!A2:E",
});
const stockRows = (stockSheet.data.values || []).map((r) => ({
  category: r[0], product: r[1], option: r[2], sku: r[3], stock: Number(r[4]) || 0,
}));

// 2) 식스샵 produktepr 상품 다운로드
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: "ko-KR", acceptDownloads: true });
const page = await ctx.newPage();

await page.goto("https://www.sixshop.com/member/login", { waitUntil: "domcontentloaded" });
await page.evaluate(async (b) => {
  await fetch("/member/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: b, credentials: "include" });
}, new URLSearchParams({
  idOrUserName: Buffer.from(process.env.SIXSHOP_EMAIL_PP).toString("base64"),
  password: Buffer.from(process.env.SIXSHOP_PASSWORD_PP).toString("base64"),
  keepLoginAgreement: "on", trendReportLogin: "", memberNo: "0", pageNo: "0", shopCustomerNo: "0",
}).toString());

await page.goto("https://www.sixshop.com/dashboard/shop-products", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#downloadAllProductsBtn", { timeout: 30_000 });
await page.waitForTimeout(2000);
const dl = page.waitForEvent("download", { timeout: 60_000 });
await page.locator("#downloadAllProductsBtn").click();
const d = await dl;
const csvPath = join(tmpdir(), `pp-${Date.now()}.csv`);
await d.saveAs(csvPath);

// active brand 확인
const brand = await page.evaluate(() => document.querySelector("#siteLinkAddress")?.getAttribute("href"));
console.log(`[active brand on download] ${brand}`);

await browser.close();

// 3) CSV 파싱
const wb = read(readFileSync(csvPath), { type: "buffer", raw: false });
const csvRows = utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
const csvBySaleStatus = csvRows.reduce((m, r) => {
  const s = String(r["상태"] ?? "").trim();
  m[s] = (m[s] || 0) + 1;
  return m;
}, {});
console.log(`[식스샵 PP CSV] 전체 ${csvRows.length}건, 상태별:`, csvBySaleStatus);

const sellingOrSoldOut = csvRows.filter((r) => ["판매 중", "품절"].includes(String(r["상태"] ?? "").trim()));
console.log(`[식스샵 PP 판매중+품절] ${sellingOrSoldOut.length}건`);
console.log(`[시트 PP 재고마스터] ${stockRows.length}행`);

// 옵션 펼침 예상치
let expectedRows = 0;
for (const r of sellingOrSoldOut) {
  const opt = String(r["상품 옵션 정보"] ?? "").trim();
  if (!opt || opt === "-") expectedRows += 1;
  else {
    const m = opt.match(/^([^:]+):\s*(.+)$/);
    if (!m) expectedRows += 1;
    else expectedRows += m[2].split(",").map((v) => v.trim()).filter(Boolean).length;
  }
}
console.log(`[옵션 펼침 예상] ${expectedRows}행`);

// 시트에 있는 상품명 vs CSV 상품명
const sheetProducts = new Set(stockRows.map((r) => r.product));
const csvProducts = new Set(sellingOrSoldOut.map((r) => String(r["이름"] ?? "").trim()));
const inSheetNotCsv = [...sheetProducts].filter((p) => !csvProducts.has(p));
const inCsvNotSheet = [...csvProducts].filter((p) => !sheetProducts.has(p));
if (inSheetNotCsv.length) console.log(`⚠ 시트에만 있고 CSV에 없는 상품: ${inSheetNotCsv.slice(0, 5).join(", ")}${inSheetNotCsv.length > 5 ? ` 외 ${inSheetNotCsv.length - 5}건` : ""}`);
if (inCsvNotSheet.length) console.log(`⚠ CSV에만 있고 시트에 없는 상품: ${inCsvNotSheet.slice(0, 5).join(", ")}${inCsvNotSheet.length > 5 ? ` 외 ${inCsvNotSheet.length - 5}건` : ""}`);
if (!inSheetNotCsv.length && !inCsvNotSheet.length) console.log("✓ 시트 상품 = CSV 상품 100% 일치");

// 시트 첫 5행
console.log("\n[시트 PP 첫 5행]");
stockRows.slice(0, 5).forEach((r) => console.log(`  ${r.product} / ${r.option || '(옵션없음)'} / 재고:${r.stock}`));

// CSV 첫 5건 (판매중+품절)
console.log("\n[식스샵 PP CSV 첫 5건]");
sellingOrSoldOut.slice(0, 5).forEach((r) => console.log(`  ${r["이름"]} / 카테고리:${r["카테고리"]} / 옵션:${r["상품 옵션 정보"]} / 수량:${r["수량"]} / 상태:${r["상태"]}`));
