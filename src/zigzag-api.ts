/**
 * 지그재그 파트너센터 조회 (코페리 · 아페티) — 전략팀 플랫폼 탭 일일 보고서용. 읽기만 한다.
 * 공식 오픈 API 는 직진배송 주문을 안 줘서, 프록시 zigzag_sales.py 처럼 파트너센터 로그인 세션 쿠키로 GraphQL 을 부른다.
 *   세션 파일: ~/projects/zigzag-collector/data/kakaostyle-state-{브랜드}.json
 *   프록시 platform-sales 작업이 30분마다 같은 파일을 쓰고, 만료되면 그쪽이 다시 로그인한다 — 여기서는 로그인하지 않는다.
 * 구매자 이름 · 연락처 · 주소 · 메모는 쿼리에 넣지 않는다 (받지도 않음).
 *
 * env (선택): ZIGZAG_STATE_DIR (세션 파일 폴더)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://partners.kakaostyle.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export interface ZigzagOrderItem {
  order_item_number: string;
  order_number: string;
  /** merchant 스토어배송 · zigzin 직진배송 */
  fulfillment: "merchant" | "zigzin";
  /** 주문 시각 (epoch ms) */
  date_created: number;
  status: string;
  quantity: number;
  remaining_quantity: number;
  total_amount: number;
  /** 스토어 부담 쿠폰 */
  seller_coupon: number;
  product_id: string;
  name: string;
  option: string;
  price: number;
  code: string;
}

export type ZigzagGql = (op: string, query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface RawItem {
  order_item_number: string;
  date_created: number;
  status: string;
  quantity: number;
  remaining_quantity: number | null;
  total_amount: number | null;
  product_id: string;
  order: { order_number: string };
  product_info: { name: string; options: string | null; price: number | null; custom_product_code: string | null };
  remaining_processing_payment_amount_detail: { allotment_detail: { seller_coupon_allotment_amount: number | null } | null } | null;
}

const ITEM_FIELDS = `total_count item_list {
  order_item_number date_created status quantity remaining_quantity total_amount product_id
  order { order_number }
  product_info { name options price custom_product_code }
  remaining_processing_payment_amount_detail { allotment_detail { seller_coupon_allotment_amount } }
}`;
const MERCHANT_QUERY = `query SearchPartnerOrderItemList($date_created_ymd_gte: Int, $date_created_ymd_lte: Int, $page: Int!, $items_per_page: Int!) {
  partner_order_item_list(date_created_ymd_gte: $date_created_ymd_gte, date_created_ymd_lte: $date_created_ymd_lte, page: $page, items_per_page: $items_per_page, order_by: DATE_CREATED_DESC) { ${ITEM_FIELDS} }
}`;
const ZIGZIN_QUERY = `query ZonlySearchOrderItemList($date_created_ymd_gte: Int, $date_created_ymd_lte: Int, $page: Int!, $items_per_page: Int!) {
  zonly_order_item_list(date_created_ymd_gte: $date_created_ymd_gte, date_created_ymd_lte: $date_created_ymd_lte, page: $page, items_per_page: $items_per_page, order: DATE_CREATED_DESC) { ${ITEM_FIELDS} }
}`;
const WMS_FEE_QUERY = `query GetWmsFeeSettlementPageList($searchInput: WmsFeeSettlementSearchInput!, $pageInput: WmsPageInput!) {
  wms_fee_settlement_page_list(searchInput: $searchInput, pageInput: $pageInput) { total_pages item_list { date_settled_ymd total_fee_with_vat } }
}`;

/** 저장된 세션으로 GraphQL 호출기를 만듦. 세션 파일이 없으면 던짐 */
export function zigzagClient(brand: string, mainDomain: string): ZigzagGql {
  const dir = process.env.ZIGZAG_STATE_DIR ?? join(homedir(), "projects", "zigzag-collector", "data");
  const state = JSON.parse(readFileSync(join(dir, `kakaostyle-state-${brand}.json`), "utf8")) as { cookies: { name: string; value: string; domain: string }[] };
  const cookie = state.cookies.filter((c) => c.domain.includes("kakaostyle")).map((c) => `${c.name}=${c.value}`).join("; ");
  return async (op, query, variables) => {
    const r = await fetch(`${BASE}/api/provider/${mainDomain}/graphql/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Origin: BASE, Referer: `${BASE}/shop/${mainDomain}/home`, Cookie: cookie, "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({ operationName: op, query, variables }),
    });
    const text = await r.text();
    // 세션이 끊기면 로그인 화면(HTML)이나 401 이 온다 — 빈 값으로 치지 않고 실패시킨다
    if (!r.ok) throw new Error(`지그재그 ${op} → ${r.status} (세션 만료면 프록시 platform-sales 가 다시 로그인)`);
    let j: { data?: Record<string, unknown>; errors?: { message?: string }[] };
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`지그재그 ${op} → JSON 이 아님 (세션 만료 가능)`);
    }
    if (j.errors?.length || !j.data) throw new Error(`지그재그 ${op} 오류: ${j.errors?.[0]?.message ?? "data 없음"}`);
    return j.data;
  };
}

const ymd = (date: string) => Number(date.replace(/-/g, ""));

/** 주문일 from ~ to (YYYY-MM-DD, KST) 주문 항목 — 스토어배송 + 직진배송 */
export async function fetchZigzagItems(gql: ZigzagGql, from: string, to: string): Promise<ZigzagOrderItem[]> {
  const out: ZigzagOrderItem[] = [];
  const kinds = [
    { op: "SearchPartnerOrderItemList", query: MERCHANT_QUERY, key: "partner_order_item_list", fulfillment: "merchant" },
    { op: "ZonlySearchOrderItemList", query: ZIGZIN_QUERY, key: "zonly_order_item_list", fulfillment: "zigzin" },
  ] as const;
  for (const k of kinds) {
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`지그재그 ${k.op}: ${MAX_PAGES}쪽을 넘음 — 잘린 채로 쓰지 않음`);
      const data = await gql(k.op, k.query, { date_created_ymd_gte: ymd(from), date_created_ymd_lte: ymd(to), page, items_per_page: PAGE_SIZE });
      const list = data[k.key] as { total_count: number; item_list: RawItem[] };
      for (const x of list.item_list) {
        out.push({
          order_item_number: x.order_item_number,
          order_number: x.order.order_number,
          fulfillment: k.fulfillment,
          date_created: x.date_created,
          status: x.status,
          quantity: x.quantity || 0,
          remaining_quantity: x.remaining_quantity ?? x.quantity ?? 0,
          total_amount: x.total_amount || 0,
          seller_coupon: x.remaining_processing_payment_amount_detail?.allotment_detail?.seller_coupon_allotment_amount || 0,
          product_id: x.product_id,
          name: x.product_info.name ?? "",
          option: x.product_info.options ?? "",
          price: x.product_info.price || 0,
          code: x.product_info.custom_product_code ?? "",
        });
      }
      if (page * PAGE_SIZE >= list.total_count || !list.item_list.length) break;
    }
  }
  return out;
}

/** 직진배송 이용료 (부가세 포함) — 달 YYYY-MM 의 정산일별 { "YYYY-MM-DD": 금액 }. 직진배송을 안 쓰는 상점은 빈 값 */
export async function fetchZigzinFees(gql: ZigzagGql, month: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error(`지그재그 이용료: ${MAX_PAGES}쪽을 넘음`);
    const data = await gql("GetWmsFeeSettlementPageList", WMS_FEE_QUERY, { searchInput: { date_settled_ym: month.replace("-", "") }, pageInput: { page, page_size: 40 } });
    const list = data.wms_fee_settlement_page_list as { total_pages: number; item_list: { date_settled_ymd: string; total_fee_with_vat: string }[] };
    for (const r of list.item_list) {
      const d = r.date_settled_ymd;
      out[`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`] = Number(r.total_fee_with_vat) || 0;
    }
    if (page + 1 >= list.total_pages || !list.item_list.length) break;
  }
  return out;
}
