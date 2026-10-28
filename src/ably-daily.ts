/**
 * 에이블리 일일 보고서 수집기 — 맥미니 launchd 에서 매일 아침 실행 (mac/jobs/ably-daily.job, 자동 설치 관리자).
 *
 * 사용법:
 *   npx tsx src/ably-daily.ts              # 어제(KST) 보고서
 *   npx tsx src/ably-daily.ts 2026-10-26   # 특정 날짜
 *
 * 하는 일 (받기 src/ably-api.ts · 계산 src/ably-report.ts — 30분마다 도는 src/ably-live.ts 와 같은 코드):
 *   1. 에이블리 셀러 어드민 API 로그인 (docs/ABLY-API.md, 토큰은 맥미니 상태 폴더에 저장해 다시 씀)
 *   2. 결제일 기준 주문 · 정산 수수료율 · 광고비 · 기획전 · 쿠폰 수집
 *   3. 순이익 = 정산 추정액 − 배송비(주문번호당 2,200원) − 에이블리 광고비 − 원가(src/ably-cost.ts, 원가 시트 매칭)
 *   4. 비공개 레포 j65209/brightbeed-reports 에 ably/daily/{date}.json · ably/index.json 기록 (오피스가 프록시로 읽음)
 *   5. 구글시트 "에이블리_일일"(날짜별 요약) · "에이블리_주문"(주문상품별) 탭에 기록
 *
 * 구매자 이름 · 연락처 · 주소 · 메모는 어디에도 저장하지 않는다.
 *
 * env: ABLY_EMAIL, ABLY_PASSWORD, ABLY_AD_MARKET_SNO, REPORTS_GITHUB_TOKEN
 *      (선택) ABLY_MARKET_NAME, ABLY_SHIPPING_COST(기본 2200), REPORTS_REPO(기본 j65209/brightbeed-reports), ABLY_SKIP_SHEETS=1
 *      + 기존 SHEET_ID · GOOGLE_SERVICE_ACCOUNT_PATH|JSON
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { loadCostRows } from "./ably-cost.js";
import {
  ablyLogin, fetchAdRows, fetchCouponList, fetchEventList, fetchFeeHistories, fetchOrders,
  type AblyAdRow, type AblyClient, type AblyCoupon, type AblyEvent, type AblyOrderItem, type SettlementHistory,
} from "./ably-api.js";
import { adOn, buildAblyReport, couponsAsOf, couponsOn, eventsOn, feeRateFrom, feeWindow, ordersOn, type AblyReport } from "./ably-report.js";
import { commitFiles, ghGetJson, indexRowOf, mergeIndexRows, REPORTS_REPO, writeDailyReport, type IndexRow } from "./reports-repo.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function yesterdayKst(): string {
  const kst = new Date(Date.now() + 9 * 3600_000 - 24 * 3600_000);
  return kst.toISOString().slice(0, 10);
}

/* ---------------- 하루 보고서 ---------------- */

async function buildReport(c: AblyClient, date: string): Promise<AblyReport> {
  const { startMonth, endMonth } = feeWindow(date);
  const [items, fees, adRows, events, coupons, costRows] = await Promise.all([
    fetchOrders(c, `${date} 00:00:00`, `${date} 23:59:59`),
    fetchFeeHistories(c, startMonth, endMonth),
    fetchAdRows(c, required("ABLY_AD_MARKET_SNO"), date, date),
    fetchEventList(c),
    fetchCouponList(c),
    loadCostRows(),
  ]);
  return buildAblyReport(
    date,
    { items, fee: feeRateFrom(fees, date), ad: adOn(adRows, date), events: eventsOn(events, date), coupons: couponsOn(coupons, date) },
    costRows,
  );
}

type Report = AblyReport;

/* ---------------- 비공개 레포 기록 (src/reports-repo.ts) ---------------- */

async function writeRepo(report: Report): Promise<void> {
  await writeDailyReport("ably", report, "ably");
}

/* ---------------- 구글시트 기록 ---------------- */

const DAILY_TAB = "에이블리_일일";
const ORDERS_TAB = "에이블리_주문";
const DAILY_HEADER = [
  "날짜", "주문수", "상품건수", "수량", "판매금액", "쿠폰할인", "쿠폰주문수", "실결제", "수수료(추정)",
  "정산(추정)", "배송비", "광고비", "원가", "순이익", "순이익률", "진행중 기획전", "수수료율", "원가 미확인", "생성시각",
];
const ORDERS_HEADER = [
  "결제일", "주문번호", "주문상품번호", "상태", "제외", "상품명", "옵션", "수량", "판매금액", "쿠폰할인",
  "에이블리부담쿠폰", "적립금", "결제혜택", "실결제", "원가", "원가 시트 상품명", "원가 매칭", "배송유형",
];

async function writeSheets(report: Report): Promise<void> {
  const { config } = await import("./config.js");
  const { getClient } = await import("./sheets.js");
  const sheets = getClient();
  const spreadsheetId = config.sheets.sheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  for (const [tab, header] of [[DAILY_TAB, DAILY_HEADER], [ORDERS_TAB, ORDERS_HEADER]] as const) {
    if (!meta.data.sheets?.some((s) => s.properties?.title === tab)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [header as unknown as string[]] },
      });
    }
  }

  // 일일 요약: 같은 날짜 행이 있으면 덮어쓰기, 없으면 추가
  const s = report.summary;
  const dailyRow = [
    report.date, s.orders, s.items, s.qty, s.gross, s.coupon_discount, s.coupon_orders, s.paid, s.fees_est,
    s.settle_est, s.shipping, s.ad_spend, s.cost, s.net, s.net_rate, s.events_running, report.assumptions.fee_rate,
    s.cost_missing_items, report.generated_at,
  ];
  const dates = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${DAILY_TAB}!A:A` });
  const rowIdx = (dates.data.values ?? []).findIndex((r) => r[0] === report.date);
  if (rowIdx > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${DAILY_TAB}!A${rowIdx + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [dailyRow] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${DAILY_TAB}!A:A`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [dailyRow] },
    });
  }

  // 주문상품: 주문상품번호(C열) 기준 신규만 추가
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ORDERS_TAB}!C:C` });
  const have = new Set((existing.data.values ?? []).map((r) => String(r[0])));
  const rows = report.orders
    .filter((o) => !have.has(String(o.sno)))
    .map((o) => [
      report.date, o.order_sno, o.sno, o.status, o.excluded ? "Y" : "", o.goods_name, o.option, o.ea, o.gross,
      o.coupon, o.coupon_by_ably, o.emoney, o.pay_benefit, o.paid, o.cost_unit != null ? o.cost : "",
      o.cost_name ?? "", { exact: "일치", base: "기본값", none: "미확인" }[o.cost_match], o.delivery_type,
    ]);
  if (rows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${ORDERS_TAB}!A:A`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
  }
}

/* ---------------- 지난 기간 채우기 (--raw) ---------------- */

/** 셀러 어드민 화면에서 받아 둔 데이터 (구매자 정보 없음) — 만드는 법은 docs/ABLY-API.md "지난 기간 채우기" */
interface AblyRaw {
  from: string;
  to: string;
  orders: AblyOrderItem[];
  ad: AblyAdRow[];
  /** 키 = 그날 달(YYYY-MM), 값 = feeWindow 3개월 정산 내역 */
  fees: Record<string, SettlementHistory[]>;
  events: AblyEvent[];
  coupons: AblyCoupon[];
}

async function backfill(path: string, dry: boolean): Promise<void> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as AblyRaw;
  const costRows = await loadCostRows();
  const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  const files: { path: string; content: unknown }[] = [];
  const rows: IndexRow[] = [];
  for (let d = raw.from; d <= raw.to; d = next(d)) {
    const report = buildAblyReport(
      d,
      {
        items: ordersOn(raw.orders, d),
        fee: feeRateFrom(raw.fees[d.slice(0, 7)] ?? [], d),
        ad: adOn(raw.ad, d),
        events: eventsOn(raw.events, d),
        // 그날 이후에 시작한 쿠폰은 빼기 (목록은 지금 기준이라)
        coupons: couponsAsOf(raw.coupons, d),
      },
      costRows,
    );
    const s = report.summary;
    console.log(`[ably-daily] ${d} 주문 ${s.orders} · 실결제 ${s.paid.toLocaleString("ko-KR")} · 광고비 ${s.ad_spend.toLocaleString("ko-KR")} · 원가 ${s.cost.toLocaleString("ko-KR")} · 순이익 ${s.net.toLocaleString("ko-KR")} · 원가 미확인 ${s.cost_missing_items}건`);
    files.push({ path: `ably/daily/${d}.json`, content: report });
    rows.push(indexRowOf(report));
  }
  if (dry) {
    console.log(`[ably-daily] 시험 — ${rows.length}일 계산만, 기록 안 함`);
    return;
  }
  const idx = (await ghGetJson<{ days: IndexRow[] }>("ably/index.json")) ?? { days: [] };
  files.push({ path: "ably/index.json", content: { updated_at: new Date().toISOString(), days: mergeIndexRows(idx.days, rows) } });
  const sha = await commitFiles(files, `ably: ${raw.from} ~ ${raw.to} 지난 기간 채움 (셀러 어드민에서 받은 주문)`);
  console.log(`[ably-daily] ${REPORTS_REPO} ${rows.length}일 커밋 ${sha?.slice(0, 7)}`);
}

/* ---------------- main ---------------- */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--raw")) return backfill(argv[argv.indexOf("--raw") + 1] ?? "", argv.includes("--dry"));
  const date = process.argv[2] ?? yesterdayKst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`날짜 형식은 YYYY-MM-DD: ${date}`);
  const report = await buildReport(await ablyLogin(), date);
  const s = report.summary;
  console.log(
    `[ably-daily] ${date} 주문 ${s.orders} · 실결제 ${s.paid.toLocaleString("ko-KR")} · 광고비 ${s.ad_spend.toLocaleString("ko-KR")} · 순이익 ${s.net.toLocaleString("ko-KR")}`,
  );
  await writeRepo(report);
  console.log(`[ably-daily] ${REPORTS_REPO}/ably/daily/${date}.json 기록`);
  if (process.env.ABLY_SKIP_SHEETS !== "1") {
    await writeSheets(report);
    console.log(`[ably-daily] 구글시트 ${DAILY_TAB} · ${ORDERS_TAB} 기록`);
  }
}

main().catch((e) => {
  console.error("[ably-daily] 실패:", (e as Error).message);
  process.exit(1);
});
