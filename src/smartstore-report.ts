/**
 * 스마트스토어 하루 보고서 계산 — 네트워크 없음. 받기 · 실행은 src/smartstore-live.ts. 양식은 에이블리 보고서와 같고 오피스 전략팀이 읽는다.
 *   실결제 = 상품 매출(상품 금액 − 판매자 부담 할인) + 고객이 낸 배송비 (묶음배송 번호당 한 번)
 *   순이익 = 실결제 − 수수료 − 택배비(주문번호당 2,200원) − 광고비 − 원가
 * 수수료는 주문마다 네이버가 알려 주는 실제 값 (상품 매출 − 정산 예정 금액). 날짜 = 결제일 KST.
 * 취소 · 반품은 요청 단계부터 뺀다 (교환은 매출 유지, 거부된 요청은 그대로).
 *
 * env (선택): SMARTSTORE_SHIPPING_COST(기본 2200)
 */
import type { CostMatch } from "./ably-cost.js";

const SHIPPING_COST = Number(process.env.SMARTSTORE_SHIPPING_COST ?? 2200);
const EXCLUDED_STATUS = /^(CANCELED|RETURNED|CANCELED_BY_NOPAYMENT)$/;
const EXCLUDED_CLAIM = /^(CANCEL|RETURN|ADMIN_CANCEL)$/;

/** 상품 주문 한 줄 — 구매자 정보는 담지 않는다 (src/smartstore-live.ts pickProductOrder) */
export interface SsProductOrder {
  product_order_id: string;
  order_id: string;
  package_no: string;
  /** 결제 시각 (ISO, +09:00) */
  payment_date: string;
  status: string;
  claim_type: string;
  claim_status: string;
  name: string;
  option: string;
  code: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  product_amount: number;
  seller_discount: number;
  /** 상품 매출 = 상품 금액 − 판매자 부담 할인 (네이버 부담 할인은 정산으로 채워져 빼지 않는다) */
  paid: number;
  settle: number;
  /** 고객이 낸 배송비 (묶음배송 안의 줄마다 같은 값이 반복된다) */
  delivery_fee: number;
}

const kstStamp = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 19).replace("T", " ");

/** 여러 날 상품 주문 → 그날 결제 */
export function ssOrdersOn(rows: SsProductOrder[], date: string): SsProductOrder[] {
  return rows.filter((o) => o.payment_date && kstStamp(o.payment_date).slice(0, 10) === date);
}

export function isExcludedSs(o: Pick<SsProductOrder, "status" | "claim_type" | "claim_status">): boolean {
  return EXCLUDED_STATUS.test(o.status) || (EXCLUDED_CLAIM.test(o.claim_type) && !/REJECT/.test(o.claim_status));
}

export function buildSmartstoreReport(
  date: string,
  rows: SsProductOrder[],
  costOf: (goodsName: string, goodsCode: string, option: string) => CostMatch,
  opts: { market: string; costBasis: string },
) {
  const orders = rows.map((o) => {
    const cm = costOf(o.name, o.code, o.option);
    return {
      sno: o.product_order_id,
      order_sno: o.order_id,
      package_no: o.package_no,
      ordered_at: kstStamp(o.payment_date),
      checked_at: kstStamp(o.payment_date),
      status: o.claim_status ? `${o.status} · ${o.claim_status}` : o.status,
      excluded: isExcludedSs(o),
      goods_sno: o.product_id,
      goods_name: o.name,
      goods_code: o.code,
      option: o.option,
      ea: o.quantity,
      price: o.unit_price,
      gross: o.product_amount,
      coupon: o.seller_discount,
      coupon_by_ably: 0,
      emoney: 0,
      pay_benefit: 0,
      paid: o.paid,
      settle: o.settle,
      delivery_fee: o.delivery_fee,
      cost_unit: cm.cost_unit,
      cost: cm.cost_unit != null ? cm.cost_unit * (o.quantity || 1) : 0,
      cost_name: cm.cost_name,
      cost_match: cm.cost_match,
    };
  });
  const live = orders.filter((o) => !o.excluded);
  const sum = (k: "coupon" | "paid" | "settle" | "ea" | "cost") => live.reduce((s, o) => s + (o[k] || 0), 0);
  const itemsPaid = sum("paid");
  const fees = itemsPaid - sum("settle");
  // 묶음배송 안의 줄마다 같은 배송비가 반복되므로 번호당 한 번 (2026-10 ~ 11 전체 묶음에서 줄마다 같은 값임을 확인)
  const packages = new Map(live.map((o) => [o.package_no, o.delivery_fee]));
  const shippingIncome = [...packages.values()].reduce((s, v) => s + v, 0);
  const paid = itemsPaid + shippingIncome;
  const orderNos = new Set(live.map((o) => o.order_sno));
  const shipping = orderNos.size * SHIPPING_COST;
  const cost = sum("cost");
  const net = paid - fees - shipping - cost;

  return {
    date,
    generated_at: new Date().toISOString(),
    market: opts.market,
    channel: "smartstore",
    assumptions: {
      shipping_cost_per_order: SHIPPING_COST,
      fee_rate: itemsPaid ? Number((fees / itemsPaid).toFixed(4)) : 0,
      fee_label: "수수료 (네이버 주문 상세)",
      fee_note: "수수료는 주문마다 네이버가 알려 주는 결제 · 쇼핑 연동 수수료 합이에요. 상품 금액 기준이라, 배송비에 수수료가 붙는다면 그 몫은 빠져 있어요.",
      cost_basis: opts.costBasis,
      ad_basis: "네이버 광고비 미연결 — 시트 없음",
      date_basis: "결제일",
      excluded_status: "취소 · 반품(요청 포함)은 매출에서 제외",
      source: "스마트스토어센터",
    },
    summary: {
      orders: orderNos.size,
      items: live.length,
      qty: sum("ea"),
      gross: itemsPaid,
      shipping_income: shippingIncome,
      coupon_discount: sum("coupon"),
      coupon_orders: new Set(live.filter((o) => o.coupon > 0).map((o) => o.order_sno)).size,
      paid,
      fees_est: fees,
      settle_est: paid - fees,
      shipping,
      ad_spend: 0,
      ad_order_price: 0,
      cost,
      cost_missing_items: live.filter((o) => o.cost_match === "none").length,
      cost_base_items: live.filter((o) => o.cost_match === "base").length,
      net,
      net_rate: paid ? Number((net / paid).toFixed(4)) : 0,
      excluded_items: orders.length - live.length,
      events_running: 0,
    },
    orders,
    events: [] as never[],
    coupons: [] as never[],
    events_note: "스마트스토어 기획전은 아직 수집하지 않아요.",
    coupons_note: "스마트스토어 쿠폰 목록은 아직 수집하지 않아요. 판매자 부담 할인은 주문 내역의 쿠폰 칸에 있어요.",
  };
}
