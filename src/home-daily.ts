/**
 * 공홈(식스샵) 일일 보고서 수집기 — 에이블리 일일 보고서(src/ably-daily.ts)와 같은 양식. 오피스 전략팀 → 공홈 탭이 읽는다.
 * 하루치를 손으로 만들 때 (받아 둔 프로 주문 JSON · 일반 식스샵 엑셀). 식스샵 프로 상점의 30분 자동 갱신은 src/home-live.ts.
 *
 * 사용법:
 *   npx tsx src/home-daily.ts kop                              # 어제(KST)
 *   npx tsx src/home-daily.ts kop 2026-10-27                   # 특정 날짜
 *   npx tsx src/home-daily.ts kop 2026-10-27 --dry             # 수집·계산만, 기록 안 함
 *   npx tsx src/home-daily.ts kop 2026-10-05 --xlsx 주문.xlsx   # 받아 둔 주문 엑셀로 계산만 (로그인·기록 안 함)
 *   (--xlsx 는 여러 번 줄 수 있음 — 엑셀이 1,000건씩 끊겨 있을 때 합쳐서 지난 기간 채우기.
 *    --out 파일.json 을 붙이면 만든 보고서를 파일로도 저장)
 *
 * 하는 일:
 *   1. 식스샵 관리자 로그인 → 주문 엑셀(상품별로 행 나누기 · 상태 전체 · 최근 주문부터) — ERP 와 같은 방식(src/sixshop.ts)
 *   2. 그날 주문만 · 취소/반품/입금 대기 제외 → 계산은 src/home-report.ts
 *   3. 원가: MD팀 코페리 구글시트(src/ably-cost.ts) · 광고비: 오피스 광고 시트(beaduniverse data/ad-sheets/{브랜드}.json)
 *   4. 비공개 레포 brightbeed-reports 의 home/{브랜드}/daily/{date}.json · home/{브랜드}/index.json (src/reports-repo.ts)
 * 구매자 이름·연락처·주소·메모는 어디에도 저장하지 않는다.
 *
 * env: SIXSHOP_EMAIL_<브랜드> · SIXSHOP_PASSWORD_<브랜드> (예: SIXSHOP_EMAIL_KOP) · REPORTS_GITHUB_TOKEN
 *      (선택) HOME_FEE_RATE(식스샵 결제, 기본 0.035) · HOME_NAVERPAY_FEE_RATE(네이버페이 주문형, 기본 0.035)
 *             HOME_SHIPPING_COST(주문당 택배비, 기본 2200) · REPORTS_REPO
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { read, utils } from "xlsx";
import type { Brand } from "./brands.js";
import { loadAd } from "./home-ad.js";
import { FEE_RATE, loadCostMatcher, HOME_BRANDS, NAVER_FEE_RATE, SHIPPING_COST, type HomeBrand } from "./home-brands.js";
import { buildHomeReport, coversWholeDay, type XlsxRow } from "./home-report.js";
import { buildProReport, proCoversDay, type ProOrder } from "./home-report-pro.js";
import { REPORTS_REPO, writeDailyReport } from "./reports-repo.js";

// 브랜드 설정(원가 시트 · 식스샵 프로 상점) 은 src/home-brands.ts, 광고비는 src/home-ad.ts

function yesterdayKst(): string {
  return new Date(Date.now() + 9 * 3600_000 - 24 * 3600_000).toISOString().slice(0, 10);
}

/* ---------------- 주문 엑셀 ---------------- */

function readXlsx(path: string): XlsxRow[] {
  const wb = read(readFileSync(path));
  return utils.sheet_to_json<XlsxRow>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

/** 여러 엑셀을 합침 (지난 기간 채우기용) — 같은 주문번호가 여러 파일에 있으면 뒤에 준 파일 것을 씀 */
function readXlsxFiles(paths: string[]): XlsxRow[] {
  const byOrder = new Map<string, XlsxRow[]>();
  for (const p of paths) {
    const fileOrders = new Map<string, XlsxRow[]>();
    for (const r of readXlsx(p)) {
      const k = String(r["주문번호"] ?? "");
      if (!fileOrders.has(k)) fileOrders.set(k, []);
      fileOrders.get(k)!.push(r);
    }
    for (const [k, rs] of fileOrders) byOrder.set(k, rs);
  }
  return [...byOrder.values()].flat();
}

/** 식스샵 프로 주문 JSON 여러 개를 합침 (같은 주문번호는 뒤 파일 것) — 그날이 어느 파일 기간 안에 있는지도 확인 */
function readProFiles(paths: string[], date: string): { orders: ProOrder[]; covered: boolean } {
  const byId = new Map<string, ProOrder>();
  let covered = false;
  for (const p of paths) {
    const j = JSON.parse(readFileSync(p, "utf8")) as { from: string; to: string; orders: ProOrder[] };
    if (proCoversDay(j.from, j.to, date)) covered = true;
    for (const o of j.orders) byId.set(o.id, o);
  }
  return { orders: [...byId.values()], covered };
}

async function fetchRows(brandId: string, cfg: HomeBrand): Promise<XlsxRow[]> {
  if (cfg.proStore) {
    throw new Error(`${cfg.name}은 식스샵 프로 상점이라 일반 식스샵 엑셀로 못 받아요 — 식스샵 프로 실시간 수집은 준비 중 (--pro-json 으로 받아 둔 주문 사용)`);
  }
  // playwright 는 실제 수집 때만 불러옴 (--xlsx 시험은 브라우저 없이)
  const { newBrowser, newBrandPage, loginAsBrand, fetchOrdersForBrand } = await import("./sixshop.js");
  const brand: Brand = {
    siteLink: brandId, displayName: cfg.name, memberNo: 0,
    ordersSheetName: "", stockSheetName: "", stateSheetName: "", includeStatuses: [],
    credEnvSuffix: cfg.credEnvSuffix, inventoryEnabled: false,
  };
  const browser = await newBrowser();
  try {
    const page = await newBrandPage(browser);
    await loginAsBrand(page, brand);
    const items = await fetchOrdersForBrand(page, brand, { paidOnly: false });
    return items.map((it) => it.raw as XlsxRow);
  } finally {
    await browser.close();
  }
}

/* ---------------- main ---------------- */

async function main(): Promise<void> {
  const pos: string[] = [];
  const xlsxPaths: string[] = [];
  const proPaths: string[] = [];
  let dry = false;
  let outPath: string | null = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--xlsx") xlsxPaths.push(argv[++i] ?? "");
    else if (argv[i] === "--pro-json") proPaths.push(argv[++i] ?? "");
    else if (argv[i] === "--dry") dry = true;
    else if (argv[i] === "--out") outPath = argv[++i] ?? null;
    else pos.push(argv[i]);
  }
  const brandId = pos[0] ?? "";
  const cfg = HOME_BRANDS[brandId];
  if (!cfg) throw new Error(`브랜드를 지정하세요: ${Object.keys(HOME_BRANDS).join(", ")} (예: npx tsx src/home-daily.ts kop)`);
  const date = pos[1] ?? yesterdayKst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`날짜 형식은 YYYY-MM-DD: ${date}`);
  const offline = xlsxPaths.length > 0 || proPaths.length > 0;

  const [{ rows: costRows, matcher: costMatcher }, ad] = await Promise.all([loadCostMatcher(cfg), loadAd(brandId, date)]);
  const opts = {
    date, brand: brandId, market: cfg.name, feeRate: FEE_RATE, naverFeeRate: NAVER_FEE_RATE, shippingCost: SHIPPING_COST,
    costRows, costBasis: cfg.costBasis, ad, costMatcher, costUnavailable: cfg.noCostSheet,
  };
  let report;
  if (proPaths.length) {
    // 식스샵 프로 주문 데이터 (관리자 주문 API 를 개인정보 없이 줄인 JSON — docs/HOME-DAILY.md)
    const { orders, covered } = readProFiles(proPaths, date);
    if (!covered) throw new Error(`주문 데이터 파일(${proPaths.join(", ")})의 기간에 ${date} 가 없어요`);
    report = buildProReport(orders, opts);
  } else {
    const rows = xlsxPaths.length ? readXlsxFiles(xlsxPaths) : await fetchRows(brandId, cfg);
    if (!coversWholeDay(rows, date)) {
      throw new Error(`주문 엑셀(${rows.length}행)이 ${date} 하루 전체를 담고 있지 않아요 — 엑셀은 최근 주문부터라 오래된 날짜는 빠질 수 있어요`);
    }
    report = buildHomeReport(rows, opts);
  }
  const s = report.summary;
  const won = (n: number) => n.toLocaleString("ko-KR");
  console.log(
    `[home-daily] ${cfg.name} ${date} 주문 ${s.orders}(네이버페이 ${s.naverpay_orders}) · 실결제 ${won(s.paid)} (배송비 수입 ${won(s.shipping_income)}) · 광고비 ${won(s.ad_spend)} · 원가 ${s.cost == null ? "미반영" : won(s.cost)} · 순이익 ${won(s.net)} · 원가 미확인 ${s.cost_missing_items}건`,
  );
  if ("missing_columns" in report.assumptions && report.assumptions.missing_columns) {
    console.warn(`[home-daily] 엑셀에 없는 열: ${report.assumptions.missing_columns.join(", ")} — 식스샵 엑셀 양식이 바뀌었는지 확인`);
  }
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`[home-daily] 보고서 파일: ${outPath}`);
  }
  if (offline || dry) {
    console.log("[home-daily] 시험 실행 — 기록하지 않음");
    return;
  }
  await writeDailyReport(`home/${brandId}`, report, `home ${brandId}`);
  console.log(`[home-daily] ${REPORTS_REPO}/home/${brandId}/daily/${date}.json 기록`);
}

main().catch((e) => {
  console.error("[home-daily] 실패:", (e as Error).message);
  process.exit(1);
});
