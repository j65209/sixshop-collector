/**
 * 에이블리 일일 보고서 수집기 — 맥미니 launchd 에서 매일 아침 실행.
 *
 * 사용법:
 *   npx tsx src/ably-daily.ts              # 어제(KST) 보고서
 *   npx tsx src/ably-daily.ts 2026-10-26   # 특정 날짜
 *
 * 하는 일:
 *   1. 에이블리 셀러 어드민 API 로그인 (docs/ABLY-API.md)
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
import { loadCostRows, matchCost } from "./ably-cost.js";

const API = "https://api.a-bly.com";
const SHIPPING_COST = Number(process.env.ABLY_SHIPPING_COST ?? 2200);
const REPORTS_REPO = process.env.REPORTS_REPO ?? "j65209/brightbeed-reports";
const MARKET_NAME = process.env.ABLY_MARKET_NAME ?? "코페리";
// 취소·반품·환불은 매출에서 제외 (상태 문자열은 에이블리 내부 코드라 패턴으로 판별)
const EXCLUDED_STATUS = /CANCEL|REFUND|RETURN|취소|반품|환불/i;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function yesterdayKst(): string {
  const kst = new Date(Date.now() + 9 * 3600_000 - 24 * 3600_000);
  return kst.toISOString().slice(0, 10);
}

/* ---------------- 에이블리 API ---------------- */

let token = "";

async function login(): Promise<void> {
  const email = required("ABLY_EMAIL");
  const password = required("ABLY_PASSWORD");
  // 로그인 필드명은 캡처하지 못해 후보를 순서대로 시도. 비밀번호 불일치(code 2)면 즉시 중단해 계정 잠금을 피한다.
  for (const idKey of ["email", "username", "id"]) {
    const r = await fetch(`${API}/seller/login/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ [idKey]: email, password }),
    });
    const j = (await r.json().catch(() => ({}))) as { token?: string; message?: string; code?: number };
    if (r.ok && j.token) {
      token = j.token;
      return;
    }
    if (j.code === 2) throw new Error(`에이블리 로그인 실패: ${j.message ?? "비밀번호 불일치"}`);
  }
  throw new Error("에이블리 로그인 실패: 로그인 요청 형식을 확인하세요 (docs/ABLY-API.md)");
}

async function get<T>(path: string, params: Record<string, string | number | string[]> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else qs.append(k, String(v));
  }
  const url = `${API}${path}${qs.toString() ? "?" + qs : ""}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `JWT ${token}`, Accept: "application/json" } });
    if (r.ok) return (await r.json()) as T;
    if (r.status === 401 && attempt === 0) {
      await login();
      continue;
    }
    if (r.status >= 500) {
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`GET ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error(`GET ${path} → 재시도 초과`);
}

interface AblyOrderItem {
  sno: number;
  order_sno: number;
  ea: number;
  status: string;
  ordered_at: string;
  checked_at: string;
  goods_sno: number;
  goods_name: string;
  goods_custom_code: string | null;
  option_info: string;
  price: number;
  exact_coupon_discount: number;
  exact_emoney_discount: number;
  exact_pay_benefit_discount: number;
  exact_amount: number;
  coupon_amount_for_ably: number;
  delivery_type: string;
  pay_method_name: string;
  balance_accounts_scheduled_at: string | null;
}

async function fetchOrders(date: string): Promise<AblyOrderItem[]> {
  const out: AblyOrderItem[] = [];
  for (let page = 1; page <= 200; page++) {
    const j = await get<{ order_items: AblyOrderItem[] }>("/seller/order_items/", {
      order: "-checked_at",
      page,
      per_page: 100,
      "delivery_type[]": ["standard", "today", "combine", "reserved"],
      start_date: `${date} 00:00:00`,
      end_date: `${date} 23:59:59`,
      date_type: "checked_at",
    });
    const items = j.order_items ?? [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

interface SettlementHistory {
  is_completed: boolean;
  scheduled_at: string;
  payment_amount: number;
  payment_fees: number;
  platform_fees: number;
  category_fees: number;
}

/** 최근 정산 내역의 (결제수수료+판매수수료+카테고리수수료)/결제액 — 주문 단위 수수료가 API에 없어 추정에 사용 */
async function fetchFeeRate(date: string): Promise<{ rate: number; basis: string }> {
  // 정산 내역은 월 단위(YYYY-MM) 파라미터만 받는다 — 일자를 넣으면 500
  const [y, m] = date.split("-").map(Number);
  const startMonth = new Date(Date.UTC(y, m - 1 - 2, 1)).toISOString().slice(0, 7);
  const j = await get<{ balance_accounts_histories: SettlementHistory[] }>("/seller/balance_accounts/histories/", {
    start_date: startMonth,
    end_date: date.slice(0, 7),
  });
  const rows = (j.balance_accounts_histories ?? []).filter((h) => h.payment_amount > 0);
  const pay = rows.reduce((s, h) => s + h.payment_amount, 0);
  const fees = rows.reduce((s, h) => s + h.payment_fees + h.platform_fees + h.category_fees, 0);
  if (!pay) return { rate: 0.275, basis: "기본값 27.5% (최근 정산 내역 없음)" };
  return { rate: fees / pay, basis: `${startMonth}~${date.slice(0, 7)} 정산 ${rows.length}건 · 결제 ${pay.toLocaleString("ko-KR")}원 기준` };
}

async function fetchAdSpend(date: string): Promise<{ charge: number; adOrderPrice: number }> {
  const marketSno = required("ABLY_AD_MARKET_SNO");
  const rows = await get<{ charge: number; order_price: number; datetime: string }[]>(
    `/seller/ad_markets/${marketSno}/statistics_timeseries/`,
    { start_at: date, end_at: date, periodicity: "daily" },
  );
  const day = (rows ?? []).filter((r) => String(r.datetime).startsWith(date));
  return {
    charge: day.reduce((s, r) => s + (r.charge || 0), 0),
    adOrderPrice: day.reduce((s, r) => s + (r.order_price || 0), 0),
  };
}

interface AblyEvent {
  sno: number;
  name: string;
  event_type: string;
  discount_type: string;
  event_start_date: string;
  event_end_date: string;
  is_applied: boolean;
  applied_status: string | null;
  applied_goods_count: number;
  approved_goods_count: number;
}

async function fetchEvents(date: string) {
  const seen = new Map<number, AblyEvent>();
  for (const isApplyPeriod of ["true", "false"]) {
    for (let page = 1; page <= 10; page++) {
      const j = await get<{ event_application_list: AblyEvent[]; max_page_number?: number }>(
        "/seller/event-applications/",
        { page, per_page: 50, is_apply_period: isApplyPeriod },
      ).catch(() => ({ event_application_list: [] as AblyEvent[], max_page_number: 0 }));
      (j.event_application_list ?? []).forEach((e) => seen.set(e.sno, e));
      if (!j.max_page_number || page >= j.max_page_number) break;
    }
  }
  const day = (s: string) => String(s ?? "").slice(0, 10);
  return [...seen.values()]
    .filter((e) => e.is_applied || e.approved_goods_count > 0)
    .map((e) => {
      // 기간 안이어도 승인된 상품이 없으면 실제로 할인 중이 아니므로 "승인대기"
      const state =
        date < day(e.event_start_date) ? "예정"
        : date > day(e.event_end_date) ? "종료"
        : e.approved_goods_count > 0 ? "진행중"
        : "승인대기";
      return {
        sno: e.sno,
        name: e.name,
        event_type: e.event_type,
        discount_type: e.discount_type,
        start: e.event_start_date,
        end: e.event_end_date,
        state,
        applied_status: e.applied_status,
        applied_goods: e.applied_goods_count,
        approved_goods: e.approved_goods_count,
      };
    })
    .filter((e) => e.state !== "종료")
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

interface AblyCoupon {
  sno: number;
  management_name: string;
  discount_type: string;
  discount_price: number;
  discount_percent: number;
  minimum_price: number;
  used_count: number;
  total_count: number;
  coupon_discount: number;
  roas: number;
  started_at: string;
  finished_at: string;
  issue_state: string;
}

async function fetchCoupons(date: string) {
  const j = await get<{ coupons: AblyCoupon[] }>("/seller/coupons/", { page: 1, per_page: 100 }).catch(() => ({
    coupons: [] as AblyCoupon[],
  }));
  return (j.coupons ?? [])
    .filter((c) => !c.finished_at || String(c.finished_at).slice(0, 10) >= date)
    .map((c) => ({
      sno: c.sno,
      name: c.management_name,
      // discount_type: "1" 정률(%) · "0" 정액(원)
      discount: String(c.discount_type) === "1" ? `${c.discount_percent}%` : `${(c.discount_price ?? 0).toLocaleString("ko-KR")}원`,
      minimum_price: c.minimum_price,
      used: c.used_count,
      total: c.total_count,
      coupon_discount: c.coupon_discount,
      roas: c.roas,
      start: c.started_at,
      end: c.finished_at,
      state: c.issue_state,
    }));
}

/* ---------------- 보고서 계산 ---------------- */

async function buildReport(date: string) {
  const [items, fee, ad, events, coupons, costRows] = await Promise.all([
    fetchOrders(date),
    fetchFeeRate(date),
    fetchAdSpend(date),
    fetchEvents(date),
    fetchCoupons(date),
    loadCostRows(),
  ]);

  const orders = items.map((o) => {
    const excluded = EXCLUDED_STATUS.test(o.status ?? "");
    const discount = (o.exact_coupon_discount || 0) + (o.exact_emoney_discount || 0) + (o.exact_pay_benefit_discount || 0);
    const cm = matchCost(costRows, o.goods_name ?? "", o.goods_custom_code ?? "", o.option_info ?? "");
    return {
      sno: o.sno,
      order_sno: o.order_sno,
      ordered_at: o.ordered_at,
      checked_at: o.checked_at,
      status: o.status,
      excluded,
      goods_sno: o.goods_sno,
      goods_name: o.goods_name,
      goods_code: o.goods_custom_code ?? "",
      option: o.option_info,
      ea: o.ea,
      price: o.price,
      gross: (o.exact_amount || 0) + discount,
      coupon: o.exact_coupon_discount || 0,
      coupon_by_ably: o.coupon_amount_for_ably || 0,
      emoney: o.exact_emoney_discount || 0,
      pay_benefit: o.exact_pay_benefit_discount || 0,
      paid: o.exact_amount || 0,
      cost_unit: cm.cost_unit,
      cost: cm.cost_unit != null ? cm.cost_unit * (o.ea || 1) : 0,
      cost_name: cm.cost_name,
      cost_match: cm.cost_match,
      delivery_type: o.delivery_type,
      pay_method: o.pay_method_name,
    };
  });

  const live = orders.filter((o) => !o.excluded);
  const sum = (arr: typeof orders, k: "gross" | "coupon" | "paid" | "ea" | "coupon_by_ably" | "cost") =>
    arr.reduce((s, o) => s + (o[k] || 0), 0);
  const orderNos = new Set(live.map((o) => o.order_sno));
  const couponOrderNos = new Set(live.filter((o) => o.coupon > 0).map((o) => o.order_sno));

  const paid = sum(live, "paid");
  const feesEst = Math.round(paid * fee.rate);
  const settleEst = paid - feesEst;
  const shipping = orderNos.size * SHIPPING_COST;
  const cost = sum(live, "cost");
  const net = settleEst - shipping - ad.charge - cost;

  return {
    date,
    generated_at: new Date().toISOString(),
    market: MARKET_NAME,
    channel: "ably",
    assumptions: {
      shipping_cost_per_order: SHIPPING_COST,
      fee_rate: Number(fee.rate.toFixed(4)),
      fee_basis: fee.basis,
      cost_basis: "원가 시트(기획전 계산기 시트) E열 → 없으면 Q열, 상품명·옵션으로 매칭",
      date_basis: "결제일(checked_at)",
      excluded_status: "취소·반품·환불 상태는 매출에서 제외",
    },
    summary: {
      orders: orderNos.size,
      items: live.length,
      qty: sum(live, "ea"),
      gross: sum(live, "gross"),
      coupon_discount: sum(live, "coupon"),
      coupon_by_ably: sum(live, "coupon_by_ably"),
      coupon_orders: couponOrderNos.size,
      paid,
      fees_est: feesEst,
      settle_est: settleEst,
      shipping,
      ad_spend: ad.charge,
      ad_order_price: ad.adOrderPrice,
      cost,
      cost_missing_items: live.filter((o) => o.cost_match === "none").length,
      cost_base_items: live.filter((o) => o.cost_match === "base").length,
      net,
      net_rate: paid ? Number((net / paid).toFixed(4)) : 0,
      excluded_items: orders.length - live.length,
      events_running: events.filter((e) => e.state === "진행중").length,
    },
    orders,
    events,
    coupons,
  };
}

type Report = Awaited<ReturnType<typeof buildReport>>;

/* ---------------- 비공개 레포 기록 ---------------- */

async function ghPut(path: string, content: unknown, message: string): Promise<void> {
  const gh = required("REPORTS_GITHUB_TOKEN");
  const url = `https://api.github.com/repos/${REPORTS_REPO}/contents/${path}`;
  const headers = { Authorization: `Bearer ${gh}`, Accept: "application/vnd.github+json" };
  const cur = await fetch(url, { headers });
  const sha = cur.ok ? ((await cur.json()) as { sha: string }).sha : undefined;
  const r = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(content, null, 1)).toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function ghGetJson<T>(path: string): Promise<T | null> {
  const gh = required("REPORTS_GITHUB_TOKEN");
  const r = await fetch(`https://api.github.com/repos/${REPORTS_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${gh}`, Accept: "application/vnd.github.raw+json" },
  });
  return r.ok ? ((await r.json()) as T) : null;
}

async function writeRepo(report: Report): Promise<void> {
  await ghPut(`ably/daily/${report.date}.json`, report, `ably: daily ${report.date}`);
  type IndexRow = { date: string } & Pick<Report["summary"], "orders" | "paid" | "net" | "ad_spend" | "coupon_orders" | "cost">;
  const idx = (await ghGetJson<{ days: IndexRow[] }>("ably/index.json")) ?? { days: [] };
  const s = report.summary;
  const row: IndexRow = {
    date: report.date,
    orders: s.orders,
    paid: s.paid,
    net: s.net,
    ad_spend: s.ad_spend,
    coupon_orders: s.coupon_orders,
    cost: s.cost,
  };
  idx.days = [row, ...idx.days.filter((d) => d.date !== report.date)].sort((a, b) => b.date.localeCompare(a.date));
  await ghPut("ably/index.json", { updated_at: report.generated_at, days: idx.days }, `ably: index ${report.date}`);
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

/* ---------------- main ---------------- */

async function main(): Promise<void> {
  const date = process.argv[2] ?? yesterdayKst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`날짜 형식은 YYYY-MM-DD: ${date}`);
  await login();
  const report = await buildReport(date);
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
