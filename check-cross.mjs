import "dotenv/config";
import { chromium } from "playwright";
import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { read, utils } from "xlsx";

// 1) 시트 데이터 읽기
const path = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
const expanded = path.startsWith("~") ? path.replace(/^~/, process.env.HOME) : path;
const creds = JSON.parse(readFileSync(expanded, "utf8"));
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });
const sheetId = process.env.SHEET_ID;

async function readStock(tab) {
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tab}!A2:E`,
  });
  return (got.data.values ?? []).map((r) => ({
    category: r[0] ?? "",
    product: r[1] ?? "",
    option: r[2] ?? "",
    sku: r[3] ?? "",
    stock: Number(r[4]) || 0,
  }));
}

const sixA = await readStock("6A 재고마스터");
const ct = await readStock("CT 재고마스터");
console.log(`[시트] 6A 재고마스터: ${sixA.length}행, CT 재고마스터: ${ct.length}행`);

// 2) 식스샵 6thanother 상품 다운로드
async function dl(brand, email, password) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: "ko-KR", acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto("https://www.sixshop.com/member/login", { waitUntil: "domcontentloaded" });
  await page.evaluate(async (body) => {
    await fetch("/member/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, credentials: "include" });
  }, new URLSearchParams({
    idOrUserName: Buffer.from(email).toString("base64"),
    password: Buffer.from(password).toString("base64"),
    keepLoginAgreement: "on", trendReportLogin: "", memberNo: "0", pageNo: "0", shopCustomerNo: "0",
  }).toString());
  await page.goto("https://www.sixshop.com/dashboard/shop-products", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#downloadAllProductsBtn", { timeout: 30_000 });
  await page.waitForTimeout(2000);
  const dlPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator("#downloadAllProductsBtn").click();
  const d = await dlPromise;
  const out = join(tmpdir(), `${brand}-${Date.now()}.csv`);
  await d.saveAs(out);
  await browser.close();
  const wb = read(readFileSync(out), { type: "buffer", raw: false });
  return utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

const sixARaw = await dl("6A", process.env.SIXSHOP_EMAIL, process.env.SIXSHOP_PASSWORD);
const ctRaw = await dl("CT", process.env.SIXSHOP_EMAIL_CLEARTYPE, process.env.SIXSHOP_PASSWORD_CLEARTYPE);
console.log(`[식스샵 raw] 6thanother: ${sixARaw.length}건, cleartype: ${ctRaw.length}건`);

// 3) 대조: 시트의 상품명 → 식스샵 raw에 같은 상품명 있는지
function check(label, sheetRows, rawRows) {
  const rawProducts = new Map(rawRows.map((r) => [String(r["이름"] ?? "").trim(), r]));
  let mismatched = 0;
  let matched = 0;
  let notFound = [];
  for (const sr of sheetRows) {
    const raw = rawProducts.get(sr.product);
    if (!raw) { notFound.push(sr.product); continue; }
    matched++;
    const rawQty = String(raw["수량"] ?? "");
    const expectedStock = /관리\s*안/.test(rawQty) ? 99999
      : Number(rawQty.replace(/[^\d.-]/g, "")) || 0;
    // 옵션 있는 상품은 0이거나 수동값. 옵션 없는 상품은 expectedStock 매칭 기대.
    if (!sr.option && expectedStock > 0 && sr.stock !== expectedStock) {
      mismatched++;
      if (mismatched <= 5) console.log(`  ⚠ ${label} 불일치: ${sr.product} (시트 ${sr.stock} vs 식스샵 ${expectedStock})`);
    }
  }
  console.log(`\n[${label}] 매칭 ${matched}/${sheetRows.length}, 옵션없는 상품 수량 불일치 ${mismatched}건`);
  if (notFound.length > 0) console.log(`  not found: ${notFound.slice(0, 5).join(", ")}${notFound.length > 5 ? ` 외 ${notFound.length - 5}건` : ""}`);
}

check("6A", sixA, sixARaw);
check("CT", ct, ctRaw);

// 4) 시트 첫 5행 비교
console.log("\n[6A 재고마스터 첫 5행]");
sixA.slice(0, 5).forEach((r) => console.log(`  ${r.product} / ${r.option || "(옵션없음)"} / 재고:${r.stock}`));
console.log("\n[CT 재고마스터 첫 5행]");
ct.slice(0, 5).forEach((r) => console.log(`  ${r.product} / ${r.option || "(옵션없음)"} / 재고:${r.stock}`));
