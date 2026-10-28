/**
 * 에이블리 하루 보고서 계산 — 네트워크 없음. 받기는 src/ably-api.ts, 실행은 src/ably-daily.ts(매일) · src/ably-live.ts(30분마다).
 *   순이익 = 정산 추정액 − 배송비(주문번호당 2,200원) − 에이블리 광고비 − 원가(src/ably-cost.ts, 원가 시트 매칭)
 * 양식 · 규칙은 docs/ABLY-API.md. 구매자 이름 · 연락처 · 주소 · 메모는 담지 않는다 (주문은 AblyOrderItem 필드만).
 *
 * env (선택): ABLY_MARKET_NAME(기본 코페리) · ABLY_SHIPPING_COST(기본 2200)
 */
import { matchCost, type CostRow } from "./ably-cost.js";
import type { AblyAdRow, AblyCoupon, AblyEvent, AblyOrderItem, SettlementHistory } from "./ably-api.js";

const SHIPPING_COST = Number(process.env.ABLY_SHIPPING_COST ?? 2200);
const MARKET_NAME = process.env.ABLY_MARKET_NAME ?? "코페리";
// 취소·반품·환불은 매출에서 제외 (상태 문자열은 에이블리 내부 코드라 패턴으로 판별)
const EXCLUDED_STATUS = /CANCEL|REFUND|RETURN|취소|반품|환불/i;

/** 수수료율을 볼 정산 내역 기간 — 그날 달 포함 3개월 (정산 내역은 월 단위 YYYY-MM 만 받는다, 일자면 500) */
export function feeWindow(date: string): { startMonth: string; endMonth: string } {
  const [y, m] = date.split("-").map(Number);
  return { startMonth: new Date(Date.UTC(y, m - 1 - 2, 1)).toISOString().slice(0, 7), endMonth: date.slice(0, 7) };
}

/** 최근 정산 내역의 (결제수수료+판매수수료+카테고리수수료)/결제액 — 주문 단위 수수료가 API에 없어 추정에 사용 */
export function feeRateFrom(histories: SettlementHistory[], date: string): { rate: number; basis: string } {
  const { startMonth, endMonth } = feeWindow(date);
  const rows = histories.filter((h) => h.payment_amount > 0);
  const pay = rows.reduce((s, h) => s + h.payment_amount, 0);
  const fees = rows.reduce((s, h) => s + h.payment_fees + h.platform_fees + h.category_fees, 0);
  if (!pay) return { rate: 0.275, basis: "기본값 27.5% (최근 정산 내역 없음)" };
  return { rate: fees / pay, basis: `${startMonth}~${endMonth} 정산 ${rows.length}건 · 결제 ${pay.toLocaleString("ko-KR")}원 기준` };
}

/** 광고비 일별 줄 → 그날 광고비 · 광고 기여 매출 */
export function adOn(rows: AblyAdRow[], date: string): { charge: number; adOrderPrice: number } {
  const day = rows.filter((r) => String(r.datetime).startsWith(date));
  return { charge: day.reduce((s, r) => s + (r.charge || 0), 0), adOrderPrice: day.reduce((s, r) => s + (r.order_price || 0), 0) };
}

/** 여러 날 주문 → 그날 결제(checked_at, KST) 주문 */
export function ordersOn(items: AblyOrderItem[], date: string): AblyOrderItem[] {
  return items.filter((o) => String(o.checked_at).slice(0, 10) === date);
}

/** 기획전 목록 → 그날 기준 상태 (예정 · 진행중 · 승인대기, 끝난 것은 뺌) */
export function eventsOn(list: AblyEvent[], date: string) {
  const day = (s: string) => String(s ?? "").slice(0, 10);
  return list
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

/** 쿠폰 목록 → 그날 끝나지 않은 쿠폰 */
export function couponsOn(list: AblyCoupon[], date: string) {
  return list
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

/** 지난 날짜용 쿠폰 — 목록은 지금 기준이라 그날 이후에 시작한 쿠폰은 뺀다 */
export function couponsAsOf(list: AblyCoupon[], date: string) {
  return couponsOn(list.filter((c) => !c.started_at || String(c.started_at).slice(0, 10) <= date), date);
}

/** 받아 온 데이터로 하루 보고서 계산 */
export function buildAblyReport(
  date: string,
  d: {
    items: AblyOrderItem[];
    fee: { rate: number; basis: string };
    ad: { charge: number; adOrderPrice: number };
    events: ReturnType<typeof eventsOn>;
    coupons: ReturnType<typeof couponsOn>;
  },
  costRows: CostRow[],
) {
  const { items, fee, ad, events, coupons } = d;
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

export type AblyReport = ReturnType<typeof buildAblyReport>;
