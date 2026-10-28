/**
 * 식스샵 프로 주문 목록 API → 개인정보 없이 줄인 ProOrder (src/home-report-pro.ts 입력).
 *   GET https://storemanager-be.sixshop.io/call/order-integration/v2/orders?page&limit=100&sort=-orderedAt&orderedAtMin&orderedAtMax
 *   응답 data.list[]: { order, productOrders[], storeMarket } · data.pagination.totalPages
 * 필드 대응은 2026-10 관리자 화면에서 받은 것과 같다 (Downloads 의 {brand}-sixshop-pro-orders-*.json).
 * 구매자 이름 · 연락처 · 주소 · 배송 메모 · 작성형(추가) 옵션은 담지 않는다.
 */
import type { ProItem, ProOrder } from "./home-report-pro.js";

export const PRO_API = "https://storemanager-be.sixshop.io";

interface RawProduct {
  productOrderId: string;
  productName: string;
  productOptionNames?: string[] | null;
  productOptionValues?: string[] | null;
  productOptionDisplayName?: string | null;
  quantity: number;
  unitPrice: number;
  originalUnitPrice?: number;
  unitAmount?: number;
  discountAmount?: number;
  status: string;
  claimType?: string | null;
  sku?: string | null;
  productManageCode?: string | null;
}
interface RawOrder {
  orderId: string;
  orderedAt: string;
  paidAt?: string | null;
  cancelledAt?: string | null;
  paymentStatus: string;
  processStatus?: string;
  paymentTypes?: string;
  marketCode: string;
  orderAmount: number;
  deliveryFee: number;
  discountAmount?: number;
  discountDeliveryFee?: number;
  sectionDeliveryFee?: number;
  totalAmount: number;
  totalDiscountAmount?: number;
  refundAmount?: number;
}
interface RawListItem { order: RawOrder; productOrders: RawProduct[] }

/** 주문 API 가 401 · 403 (로그인 풀림 · 권한 없음) 또는 400 (토큰이 다른 상점 것 — 2026-10-28 확인) */
export class ProAuthError extends Error {}

export function slimOrder({ order: o, productOrders }: RawListItem): ProOrder {
  return {
    id: o.orderId,
    orderedAt: o.orderedAt,
    paidAt: o.paidAt ?? null,
    cancelledAt: o.cancelledAt ?? null,
    payment: o.paymentStatus,
    process: o.processStatus,
    types: o.paymentTypes,
    market: o.marketCode,
    orderAmount: o.orderAmount,
    deliveryFee: o.deliveryFee,
    discountAmount: o.discountAmount,
    discountDeliveryFee: o.discountDeliveryFee,
    sectionDeliveryFee: o.sectionDeliveryFee,
    totalAmount: o.totalAmount,
    totalDiscountAmount: o.totalDiscountAmount,
    refundAmount: o.refundAmount,
    items: (productOrders ?? []).map(
      (p): ProItem => ({
        poid: p.productOrderId,
        name: p.productName,
        optNames: p.productOptionNames ?? null,
        optValues: p.productOptionValues ?? null,
        optDisplay: p.productOptionDisplayName ?? null,
        qty: p.quantity,
        unitPrice: p.unitPrice,
        originalUnitPrice: p.originalUnitPrice,
        unitAmount: p.unitAmount,
        discount: p.discountAmount,
        status: p.status,
        claimType: p.claimType ?? null,
        sku: p.sku ?? null,
        pcode: p.productManageCode ?? null,
      }),
    ),
  };
}

/** 주문일 fromIso ~ toIso (UTC ISO) 의 주문 전부 — toIso 를 고정해서 받는 동안 들어온 새 주문에 페이지가 밀리지 않게 */
export async function fetchProOrders(headers: Record<string, string>, fromIso: string, toIso: string): Promise<ProOrder[]> {
  const byId = new Map<string, ProOrder>();
  let page = 1;
  let total = 1;
  do {
    const q = `page=${page}&limit=100&sort=-orderedAt&orderedAtMin=${encodeURIComponent(fromIso)}&orderedAtMax=${encodeURIComponent(toIso)}`;
    const r = await fetch(`${PRO_API}/call/order-integration/v2/orders?${q}`, { headers });
    if (r.status === 401 || r.status === 403 || r.status === 400) {
      throw new ProAuthError(`식스샵 프로 주문 API ${r.status} — 로그인이 풀렸거나, 토큰이 다른 상점 것이거나, 상점 권한 없음`);
    }
    if (!r.ok) throw new Error(`식스샵 프로 주문 API ${r.status} ${(await r.text()).slice(0, 200)}`);
    const d = ((await r.json()) as { data: { list: RawListItem[]; pagination: { totalPages: number } } }).data;
    for (const x of d.list) {
      const o = slimOrder(x);
      byId.set(o.id, o);
    }
    total = d.pagination.totalPages;
    page++;
    if (page > 100) throw new Error("식스샵 프로 주문이 10,000건을 넘어요 — 기간을 확인하세요");
  } while (page <= total);
  return [...byId.values()];
}
