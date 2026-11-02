/**
 * 지그재그 하루 보고서 계산 — 네트워크 없음. 받기는 src/zigzag-api.ts, 실행은 src/zigzag-live.ts.
 *   순이익 = 실결제 − 수수료 − 직배 이용료 − 택배비(스토어배송 주문번호당 2,200원) − 광고비 − 원가
 * 수수료는 브랜드별 기본 수수료율 (src/zigzag-live.ts). 직진배송 주문은 지그재그 창고에서 나가고 출고비가 직배 이용료에 들어 있어 택배비를 안 뺀다 (사장님 결정 2026-11-02).
 * 양식은 에이블리 보고서와 같고 오피스 전략팀이 읽는다.
 * 실결제 = 주문 항목 금액 (지그재그 주문금액, 쿠폰 빼기 전) — 취소 · 반품 · 입금 전은 뺀다. 날짜 = 주문일 KST.
 *
 * env (선택): ZIGZAG_SHIPPING_COST(기본 2200)
 */
import type { CostMatch } from "./ably-cost.js";
import type { ZigzagOrderItem } from "./zigzag-api.js";

const SHIPPING_COST = Number(process.env.ZIGZAG_SHIPPING_COST ?? 2200);
// 취소 · 반품 · 환불 (요청 포함) · 입금 전 — 상태는 지그재그 내부 코드
const EXCLUDED_STATUS = /CANCEL|RETURN|REFUND|BEFORE_TRANSFER/;

const kstDate = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const kstStamp = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 19).replace("T", " ");

/** 여러 날 주문 항목 → 그날 주문 */
export function zigzagItemsOn(items: ZigzagOrderItem[], date: string): ZigzagOrderItem[] {
  return items.filter((o) => kstDate(o.date_created) === date);
}

export function buildZigzagReport(
  date: string,
  d: {
    items: ZigzagOrderItem[];
    /** 그날 직진배송 이용료 (부가세 포함) */
    directFee: number;
    ad: { charge: number; adOrderPrice: number; basis: string };
  },
  /** 없으면 원가 미반영 보고서 (summary.cost = null, 순이익에 원가 안 뺌) */
  costOf: ((goodsName: string, goodsCode: string, option: string) => CostMatch) | null,
  opts: { market: string; costBasis: string; feeRate: number },
) {
  const orders = d.items.map((o) => {
    const excluded = EXCLUDED_STATUS.test(o.status);
    const ea = o.remaining_quantity || o.quantity;
    // 일부만 취소되면 남은 수량만큼
    const paid = o.quantity && o.remaining_quantity && o.remaining_quantity < o.quantity ? Math.round((o.total_amount * o.remaining_quantity) / o.quantity) : o.total_amount;
    const cm = costOf ? costOf(o.name, o.code, o.option) : null;
    return {
      sno: o.order_item_number,
      order_sno: o.order_number,
      ordered_at: kstStamp(o.date_created),
      checked_at: kstStamp(o.date_created),
      status: o.status,
      excluded,
      goods_sno: o.product_id,
      goods_name: o.name,
      goods_code: o.code,
      option: o.option,
      ea,
      price: o.price,
      gross: paid,
      coupon: o.seller_coupon,
      coupon_by_ably: 0,
      emoney: 0,
      pay_benefit: 0,
      paid,
      cost_unit: cm?.cost_unit ?? null,
      cost: cm?.cost_unit != null ? cm.cost_unit * (ea || 1) : 0,
      cost_name: cm?.cost_name ?? null,
      cost_match: cm?.cost_match ?? null,
      delivery_type: o.fulfillment,
    };
  });
  const live = orders.filter((o) => !o.excluded);
  const sum = (k: "gross" | "coupon" | "paid" | "ea" | "cost") => live.reduce((s, o) => s + (o[k] || 0), 0);
  const orderNos = new Set(live.map((o) => o.order_sno));
  // 택배비 대상 — 스토어배송 항목이 하나라도 있는 주문 (직진배송만 있는 주문은 빠짐)
  const shipOrders = new Set(live.filter((o) => o.delivery_type === "merchant").map((o) => o.order_sno)).size;
  const paid = sum("paid");
  const feesEst = Math.round(paid * opts.feeRate);
  const shipping = shipOrders * SHIPPING_COST;
  const cost = sum("cost");
  const net = paid - feesEst - shipping - d.ad.charge - cost - d.directFee;

  return {
    date,
    generated_at: new Date().toISOString(),
    market: opts.market,
    channel: "zigzag",
    assumptions: {
      shipping_cost_per_order: SHIPPING_COST,
      fee_rate: opts.feeRate,
      fee_note: `수수료는 지그재그 정산 내역의 기본 수수료율 ${(opts.feeRate * 100).toFixed(1)}%로 계산했어요. 직진배송 주문은 출고비가 직배 이용료에 들어 있어 택배비를 빼지 않아요.`,
      cost_basis: opts.costBasis,
      ad_basis: d.ad.basis,
      date_basis: "주문일",
      excluded_status: "취소·반품·환불 · 입금 전은 매출에서 제외",
      source: "지그재그 파트너센터",
    },
    summary: {
      orders: orderNos.size,
      items: live.length,
      qty: sum("ea"),
      gross: sum("gross"),
      coupon_discount: sum("coupon"),
      coupon_orders: new Set(live.filter((o) => o.coupon > 0).map((o) => o.order_sno)).size,
      paid,
      fees_est: feesEst,
      direct_fee: d.directFee,
      settle_est: paid - feesEst,
      shipping,
      ship_orders: shipOrders,
      zigzin_items: live.filter((o) => o.delivery_type === "zigzin").length,
      ad_spend: d.ad.charge,
      ad_order_price: d.ad.adOrderPrice,
      cost: costOf ? cost : null,
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
    events_note: "지그재그 기획전은 아직 수집하지 않아요.",
    coupons_note: "지그재그 쿠폰 목록은 아직 수집하지 않아요. 스토어 부담 쿠폰은 주문 내역의 쿠폰 칸에 있어요.",
  };
}
