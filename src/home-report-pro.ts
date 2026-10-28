/**
 * 공홈(식스샵 프로) 일일 보고서 계산 — 식스샵 프로 관리자 주문 API 데이터 → 에이블리 일일 보고서와 같은 양식의 JSON.
 * (일반 식스샵 주문 엑셀은 src/home-report.ts. 코페리·아페티·코즈미는 2026-10 식스샵 프로로 옮김)
 *
 * 입력 = storemanager-be.sixshop.io/call/order-integration/v2/orders 응답을 개인정보 없이 줄인 것 (ProOrder):
 *   주문 단위 금액(totalAmount 등)과 상품 줄(items)이 따로 있어 엑셀처럼 반복되지 않는다.
 *   market: "commerce"(자사몰 결제) · "naver-pay"(네이버페이 주문형). 날짜·시각은 UTC ISO → KST 로 바꿔 쓴다.
 * 계산 규칙은 docs/HOME-DAILY.md "식스샵 프로" 절 — 2026-10 실제 주문으로 확인한 것.
 */
import { matchCost } from "./ably-cost.js";
import type { HomeReportOptions } from "./home-report.js";

export interface ProItem {
  poid: string;
  name: string;
  optNames?: string[] | null;
  optValues?: string[] | null;
  optDisplay?: string | null;
  qty: number;
  unitPrice: number;
  originalUnitPrice?: number;
  unitAmount?: number;
  discount?: number;
  status: string;
  claimType?: string | null;
  sku?: string | null;
  pcode?: string | null;
}

export interface ProOrder {
  id: string;
  orderedAt: string;
  paidAt?: string | null;
  cancelledAt?: string | null;
  payment: string;
  process?: string;
  types?: string;
  market: string;
  orderAmount: number;
  deliveryFee: number;
  discountAmount?: number;
  discountDeliveryFee?: number;
  sectionDeliveryFee?: number;
  totalAmount: number;
  totalDiscountAmount?: number;
  refundAmount?: number;
  items: ProItem[];
}

// 돈이 들어와 있는 주문 — 결제 완료 · 부분 환불(partially-refunded) · 반품 보류 중(under-refunded, 아직 환불 전).
// 취소(cancelled) · 전액 환불(refunded) · 입금 전 가상계좌는 제외. 남은 상품이 있는지는 상품 줄 상태로 본다.
export const PRO_KEPT_PAYMENT = new Set(["paid", "partially-refunded", "under-refunded"]);
// 팔리지 않은 상품 줄 — 취소·환불·반품 (요청 · 보류 포함: returnHoldback 은 네이버페이 반품 보류)
export const PRO_ITEM_GONE = /cancel|refund|return/i;
const NAVERPAY = "naver-pay";

const PAY_LABEL: Record<string, string> = {
  CARD: "카드", PASSBOOK: "무통장", BANK: "계좌이체", POINT: "네이버페이 포인트", VIRTUAL_ACCOUNT: "가상계좌",
  "EASY_PAY-TOSSPAY": "토스페이", "EASY_PAY-KAKAOPAY": "카카오페이", PAYLATER: "후불결제", MOBIL: "휴대폰", UNKNOWN: "기타",
};
const STATUS_LABEL: Record<string, string> = {
  fulfillmentPending: "배송 준비", fulfillmentShipped: "배송 중", fulfillmentArrived: "배송 완료", purchaseConfirmed: "구매 확정",
  cancelled: "취소", refundAccepted: "환불", refundRequested: "환불 요청",
  returnRequested: "반품 요청", returnHoldback: "반품 보류", returnReturnArrived: "반품 도착", returnAccepted: "반품 완료", returned: "반품",
};

const n = (v: unknown) => Number(v) || 0;
export const kst = (iso: string | null | undefined) =>
  iso ? new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19) : "";

export function buildProReport(all: ProOrder[], o: HomeReportOptions) {
  // 결제일(paidAt, KST) 기준 — 오피스 마케팅팀 실시간 매출(맥미니 pro-sales)과 같은 날짜. 입금 전 무통장(paidAt 없음)은 안 셈
  const day = all.filter((x) => x.paidAt && kst(x.paidAt).slice(0, 10) === o.date);
  const orders: ReturnType<typeof itemRow>[] = [];
  const sum = {
    orders: 0, items: 0, qty: 0, gross: 0, saleDiscount: 0, coupon: 0, couponOrders: 0, shippingIncome: 0, paid: 0,
    naverOrders: 0, naverPaid: 0, refundOrders: 0, cost: 0, costMissing: 0, costBase: 0, excludedItems: 0,
  };

  function itemRow(x: ProOrder, it: ProItem, excluded: boolean) {
    const option = (it.optDisplay || (it.optValues ?? []).join(" / ") || "").trim();
    const code = (it.sku || it.pcode || "").trim();
    const cm = o.costMatcher ? o.costMatcher(it.name, code, option) : matchCost(o.costRows, it.name, code, option);
    const ea = n(it.qty);
    const paid = n(it.unitPrice) * ea;
    return {
      sno: it.poid,
      order_sno: x.id,
      ordered_at: kst(x.orderedAt),
      checked_at: kst(x.paidAt || x.orderedAt),
      status: STATUS_LABEL[it.status] ?? it.status,
      excluded,
      goods_name: it.name,
      goods_code: code,
      option,
      ea,
      price: n(it.unitPrice),
      gross: paid,
      coupon: 0,
      emoney: 0,
      pay_benefit: 0,
      paid,
      cost_unit: cm.cost_unit,
      cost: cm.cost_unit != null ? cm.cost_unit * ea : 0,
      cost_name: cm.cost_name,
      cost_match: cm.cost_match,
      pay_method: `${PAY_LABEL[x.types ?? ""] ?? x.types ?? ""}${x.market === NAVERPAY ? " (네이버페이 주문형)" : ""}`,
    };
  }

  for (const x of day) {
    const orderOk = PRO_KEPT_PAYMENT.has(x.payment);
    let live = 0;
    let liveAmt = 0;
    for (const it of x.items) {
      const excluded = !orderOk || PRO_ITEM_GONE.test(it.status || "") || n(it.qty) === 0;
      const row = itemRow(x, it, excluded);
      orders.push(row);
      if (excluded) {
        sum.excludedItems++;
        continue;
      }
      live++;
      liveAmt += row.paid;
      sum.items++;
      sum.qty += row.ea;
      sum.gross += row.paid;
      sum.saleDiscount += Math.max(n(it.originalUnitPrice) - n(it.unitPrice), 0) * row.ea;
      sum.cost += row.cost;
      if (row.cost_match === "none") sum.costMissing++;
      if (row.cost_match === "base") sum.costBase++;
    }
    if (!orderOk || live === 0) continue;
    sum.orders++;
    // 고객이 실제로 낸 돈. 결제 금액 = Σ(판매가×수량) − 주문 단위 추가 할인 + 배송비 (2026-10 세 상점 전 주문으로 확인).
    // 둘 중 작은 쪽: ① 결제 금액 − 환불된 금액  ② 남은 상품 금액 − 추가 할인 + 배송비
    // (②는 환불 전인 반품 요청·보류 상품을 빼려고, ①은 배송비까지 돌려준 환불을 반영하려고)
    const ship = n(x.deliveryFee) + n(x.sectionDeliveryFee) - n(x.discountDeliveryFee);
    const extra = Math.max(n(x.totalDiscountAmount) - n(x.discountAmount), 0);
    const kept = Math.max(Math.min(n(x.totalAmount) - n(x.refundAmount), liveAmt - extra + ship), 0);
    if (live < x.items.length || n(x.refundAmount) > 0) sum.refundOrders++;
    sum.paid += kept;
    sum.shippingIncome += ship;
    // 주문 단위 추가 할인은 쿠폰·적립금류 (코즈미 자사몰 2,000원) — 필드로 둘을 구분할 수는 없다
    if (extra > 0) {
      sum.coupon += extra;
      sum.couponOrders++;
    }
    if (x.market === NAVERPAY) {
      sum.naverOrders++;
      sum.naverPaid += kept;
    }
  }

  const feesEst = Math.round((sum.paid - sum.naverPaid) * o.feeRate + sum.naverPaid * o.naverFeeRate);
  const settleEst = sum.paid - feesEst;
  const shipping = sum.orders * o.shippingCost;
  const adSpend = Math.round(o.ad.spend ?? 0);
  const net = settleEst - shipping - adSpend - sum.cost;
  const pct = (r: number) => (r * 100).toFixed(1).replace(/\.0$/, "") + "%";
  const rateText = o.feeRate === o.naverFeeRate ? pct(o.feeRate) : `식스샵 결제 ${pct(o.feeRate)} · 네이버페이 ${pct(o.naverFeeRate)}`;

  return {
    date: o.date,
    generated_at: new Date().toISOString(),
    market: o.market,
    brand: o.brand,
    channel: "home",
    assumptions: {
      shipping_cost_per_order: o.shippingCost,
      fee_rate: sum.paid ? Number((feesEst / sum.paid).toFixed(4)) : o.feeRate,
      fee_rate_sixshop: o.feeRate,
      fee_rate_naverpay: o.naverFeeRate,
      fee_label: "결제수수료 (추정)",
      fee_basis: `실결제의 ${rateText} 가정`,
      fee_note: `결제수수료는 실결제의 ${rateText}로 가정한 추정값이에요 (실제 요율 반영 전).`,
      paid_basis: "실결제 = 고객 결제 금액(상품 + 고객이 낸 배송비) − 환불 금액 (부분 환불 · 반품 보류 주문은 남은 상품만). 네이버페이 주문형 포함."
        + " 오피스 실시간 매출과 달리 진행 중인 취소·반품 요청·보류 상품은 미리 뺌",
      cost_basis: o.costBasis ?? "MD팀 원가 시트 — 상품명·옵션으로 매칭",
      ad_basis: o.ad.basis,
      date_basis: "결제일 (KST)",
      excluded_status: "취소·전액 환불·입금 전 주문과 취소·환불·반품(요청·보류 포함)된 상품은 매출에서 제외",
      source: "식스샵 프로 관리자 주문",
    },
    summary: {
      orders: sum.orders,
      items: sum.items,
      qty: sum.qty,
      gross: sum.gross,
      coupon_discount: sum.coupon,
      coupon_orders: sum.couponOrders,
      sale_discount: sum.saleDiscount,
      emoney: 0,
      shipping_income: sum.shippingIncome,
      paid: sum.paid,
      naverpay_orders: sum.naverOrders,
      naverpay_paid: sum.naverPaid,
      fees_est: feesEst,
      settle_est: settleEst,
      shipping,
      ad_spend: adSpend,
      ad_order_price: Math.round(o.ad.order_price ?? 0),
      cost: sum.cost,
      cost_missing_items: sum.costMissing,
      cost_base_items: sum.costBase,
      net,
      net_rate: sum.paid ? Number((net / sum.paid).toFixed(4)) : 0,
      excluded_items: sum.excludedItems,
      partial_cancel_orders: sum.refundOrders,
      events_running: 0,
    },
    orders,
    events: [] as unknown[],
    events_note: "공홈 기획전은 아직 수집하지 않아요.",
    coupons: [] as unknown[],
    coupons_note: "공홈 쿠폰 목록은 아직 수집하지 않아요.",
  };
}

/** 받아 둔 주문 데이터(주문일 from ~ to)가 그날 결제분을 다 담는지 — 무통장은 주문 다음 날 입금되기도 해서 이틀 앞부터 있어야 함 */
export function proCoversDay(from: string, to: string, date: string): boolean {
  const twoDaysBefore = new Date(Date.parse(`${date}T00:00:00Z`) - 2 * 86400_000).toISOString().slice(0, 10);
  return from <= twoDaysBefore && date <= to;
}
