/**
 * 공홈(식스샵) 일일 보고서 계산 — 주문 엑셀 행 → 에이블리 일일 보고서와 같은 양식의 JSON.
 * 브라우저·네트워크 없이 도는 순수 계산이라 받아 둔 엑셀로 시험할 수 있다 (src/home-daily.ts 가 수집 후 호출).
 *
 * 식스샵 주문 엑셀(상품별로 행 나누기) — 2026-10 코페리 실제 파일로 확인한 규칙:
 *   · 한 주문의 상품마다 한 행. 주문 단위 값(결제 금액 · 배송비 · 쿠폰/할인 코드/총 할인 · 사용한 적립금 · 상품 합계 금액)은
 *     그 주문의 모든 행에 똑같이 반복된다 → 주문번호당 한 번만 센다.
 *   · 결제 금액 = Σ 상품별 결제 금액 + 배송비,  Σ 상품별 결제 금액 = 상품 합계 금액 − 총 할인 금액 − 사용한 적립금
 *   · 부분 취소가 있으면 결제 금액·상품별 금액은 원래 값 그대로이고 "부분 취소 후 잔액"이 남은 금액
 *   · 날짜는 "주문 일자"(YYYY-MM-DD HH:mm:ss)뿐 — 결제일 열은 없다. 가상 계좌는 입금 전 "입금 대기"
 * 구매자 이름·연락처·주소·메모 열은 읽지 않는다.
 */
import { matchCost, type CostRow } from "./ably-cost.js";

export type XlsxRow = Record<string, unknown>;

export interface HomeAd {
  /** 그날 광고비(원) — 오피스 광고 시트 */
  spend: number | null;
  /** 광고 전환 매출(원) */
  order_price: number | null;
  basis: string;
}

export interface HomeReportOptions {
  date: string;
  brand: string;
  market: string;
  /** 식스샵 자체 결제(카드 · 토스페이 · 가상 계좌 …) 수수료율 */
  feeRate: number;
  /** 네이버페이 주문형 수수료율 — 코페리 공홈 주문의 절반 이상 */
  naverFeeRate: number;
  shippingCost: number;
  costRows: CostRow[];
  ad: HomeAd;
}

// 매출에서 뺄 주문 상태 — 취소·반품·환불(요청 포함) + 아직 돈이 안 들어온 입금 대기
export const EXCLUDED_ORDER_STATUS = /취소|반품|환불|입금 ?대기/;
const ITEM_CANCELLED = /취소/;
// "신용 / 체크카드 (네이버페이 주문형)" 처럼 결제 방법에 붙어 나온다
const NAVERPAY = /네이버페이/;

/** 이 열들이 없으면 엑셀 양식이 바뀐 것 — 보고서 assumptions.missing_columns 로 남겨 원격에서 확인 */
export const REQUIRED_COLUMNS = ["주문 일자", "주문번호", "주문 상태", "상품 이름", "상품별 결제 금액", "수량", "결제 금액", "배송비"];

const num = (v: unknown) => Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0;
const str = (v: unknown) => String(v ?? "").trim();
const clean = (v: unknown) => {
  const s = str(v);
  return s === "-" ? "" : s;
};

export function buildHomeReport(rows: XlsxRow[], o: HomeReportOptions) {
  const columns = new Set(rows.flatMap((r) => Object.keys(r)));
  const missing_columns = rows.length ? REQUIRED_COLUMNS.filter((c) => !columns.has(c)) : [];
  const dayRows = rows.filter((r) => str(r["주문 일자"]).slice(0, 10) === o.date);

  // 주문번호별로 묶음 (엑셀 순서 유지)
  const byOrder = new Map<string, XlsxRow[]>();
  for (const r of dayRows) {
    const k = str(r["주문번호"]);
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k)!.push(r);
  }

  const orders: ReturnType<typeof itemOf>[] = [];
  const sum = {
    orders: 0, items: 0, qty: 0, gross: 0, coupon: 0, couponOrders: 0, emoney: 0, shippingIncome: 0,
    paid: 0, naverOrders: 0, naverPaid: 0, partialOrders: 0, cost: 0, costMissing: 0, costBase: 0, excludedItems: 0,
  };

  function itemOf(r: XlsxRow, orderNo: string, idx: number, share: number, excluded: boolean, o2: { coupon: number; emoney: number }) {
    const name = str(r["상품 이름"]);
    const code = clean(r["상품 코드"]);
    // 작성형 옵션(고객이 직접 쓴 글)은 개인정보가 들어갈 수 있어 넣지 않는다
    const option = [r["상품 옵션 정보"], r["추가 옵션 정보"]].map(clean).filter(Boolean).join(" / ");
    const ea = Math.max(num(r["수량"]) - num(r["취소/반품 상품 수량"]), 0);
    const paid = num(r["상품별 결제 금액"]);
    // 주문 단위 할인은 상품별 결제 금액 비율로 나눠서 상품 줄에 표시
    const coupon = Math.round(o2.coupon * share);
    const emoney = Math.round(o2.emoney * share);
    const cm = matchCost(o.costRows, name, code, option);
    return {
      sno: clean(r["상품 주문번호 (네이버페이 주문형)"]) || `${orderNo}-${idx + 1}`,
      order_sno: orderNo,
      ordered_at: str(r["주문 일자"]),
      checked_at: str(r["주문 일자"]),
      status: excluded ? `${str(r["주문 상태"])}${ITEM_CANCELLED.test(str(r["상품별 주문 상태"])) ? " · 상품 취소" : ""}` : str(r["주문 상태"]),
      excluded,
      goods_name: name,
      goods_code: code,
      option,
      ea,
      price: ea ? Math.round((paid + coupon + emoney) / ea) : 0,
      gross: paid + coupon + emoney,
      coupon,
      emoney,
      pay_benefit: 0,
      paid,
      cost_unit: cm.cost_unit,
      cost: cm.cost_unit != null ? cm.cost_unit * ea : 0,
      cost_name: cm.cost_name,
      cost_match: cm.cost_match,
      pay_method: str(r["결제 방법"]),
    };
  }

  for (const [orderNo, rs] of byOrder) {
    const head = rs[0];
    const orderExcluded = EXCLUDED_ORDER_STATUS.test(str(head["주문 상태"]));
    const couponAmt = num(head["쿠폰 할인 금액"]) + num(head["할인 코드 할인 금액"]);
    const emoneyAmt = num(head["사용한 적립금"]);
    const itemPaidSum = rs.reduce((s, r) => s + num(r["상품별 결제 금액"]), 0);
    let liveItems = 0;
    rs.forEach((r, i) => {
      const itemExcluded = orderExcluded || ITEM_CANCELLED.test(str(r["상품별 주문 상태"]));
      const share = itemPaidSum ? num(r["상품별 결제 금액"]) / itemPaidSum : 1 / rs.length;
      const it = itemOf(r, orderNo, i, share, itemExcluded, { coupon: couponAmt, emoney: emoneyAmt });
      orders.push(it);
      if (itemExcluded || it.ea === 0) {
        sum.excludedItems++;
        return;
      }
      liveItems++;
      sum.items++;
      sum.qty += it.ea;
      sum.cost += it.cost;
      if (it.cost_match === "none") sum.costMissing++;
      if (it.cost_match === "base") sum.costBase++;
    });
    if (orderExcluded || liveItems === 0) continue;
    sum.orders++;
    const partial = num(head["부분 취소 금액"]);
    if (partial > 0) sum.partialOrders++;
    // 실결제 = 고객이 실제로 낸 돈 (상품 + 배송비, 부분 취소 뒤 잔액)
    const paid = partial > 0 ? num(head["부분 취소 후 잔액"]) : num(head["결제 금액"]);
    sum.paid += paid;
    if (NAVERPAY.test(str(head["결제 방법"]))) {
      sum.naverOrders++;
      sum.naverPaid += paid;
    }
    sum.shippingIncome += num(head["배송비"]);
    sum.gross += num(head["상품 합계 금액"]) || itemPaidSum + couponAmt + emoneyAmt;
    sum.coupon += couponAmt;
    sum.emoney += emoneyAmt;
    if (couponAmt > 0) sum.couponOrders++;
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
      paid_basis: "실결제 = 고객 결제 금액 (상품 + 고객이 낸 배송비, 부분 취소는 잔액). 네이버페이 주문형 포함",
      cost_basis: "MD팀 코페리 시트 — 첫 탭(C·E · P·Q열) → Product List 탭 보충, 상품명·옵션으로 매칭",
      ad_basis: o.ad.basis,
      date_basis: "주문일",
      excluded_status: "취소·반품·환불(요청 포함) · 입금 대기 주문과 취소된 상품은 매출에서 제외",
      source: "식스샵 관리자 주문 엑셀",
      ...(missing_columns.length ? { missing_columns } : {}),
    },
    summary: {
      orders: sum.orders,
      items: sum.items,
      qty: sum.qty,
      gross: sum.gross,
      coupon_discount: sum.coupon,
      coupon_orders: sum.couponOrders,
      emoney: sum.emoney,
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
      partial_cancel_orders: sum.partialOrders,
      events_running: 0,
    },
    orders,
    events: [] as unknown[],
    events_note: "공홈 기획전은 아직 수집하지 않아요.",
    coupons: [] as unknown[],
    coupons_note: "공홈 쿠폰 목록은 아직 수집하지 않아요 — 주문에 쓰인 쿠폰·할인 코드 금액은 위 합계와 주문 내역에 반영돼 있어요.",
  };
}

export type HomeReport = ReturnType<typeof buildHomeReport>;

/** 엑셀이 그날 하루 전체를 담는지 — 엑셀은 최근 주문부터 일정 건수까지라, 가장 오래된 주문이 그날보다 앞이어야 함 */
export function coversWholeDay(rows: XlsxRow[], date: string): boolean {
  const days = rows.map((r) => str(r["주문 일자"]).slice(0, 10)).filter(Boolean).sort();
  return days.length > 0 && days[0] < date;
}
