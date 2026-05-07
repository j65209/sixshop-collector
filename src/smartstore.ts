import bcrypt from "bcryptjs";
import type { Brand } from "./brands.js";

const BASE_URL = "https://api.commerce.naver.com/external";

interface SsCreds {
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

export function smartStoreCreds(brand: Brand): SsCreds {
  if (!brand.smartStore) {
    throw new Error(`Brand ${brand.displayName} has no smartStore config`);
  }
  const suffix = brand.smartStore.credEnvSuffix;
  const clientId = process.env[`NAVER_CLIENT_ID${suffix}`];
  const clientSecret = process.env[`NAVER_CLIENT_SECRET${suffix}`];
  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing Naver creds for ${brand.displayName} (env NAVER_CLIENT_ID${suffix} / NAVER_CLIENT_SECRET${suffix})`,
    );
  }
  return { clientId, clientSecret };
}

async function getAccessToken(creds: SsCreds): Promise<string> {
  const cached = tokenCache.get(creds.clientId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const timestamp = Date.now();
  const password = `${creds.clientId}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, creds.clientSecret);
  const signature = Buffer.from(hashed, "utf-8").toString("base64");

  const body = new URLSearchParams({
    client_id: creds.clientId,
    timestamp: String(timestamp),
    client_secret_sign: signature,
    grant_type: "client_credentials",
    type: "SELF",
  });

  const resp = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    throw new Error(`SmartStore auth failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  tokenCache.set(creds.clientId, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

/** ISO 8601 with KST offset, e.g. "2026-05-06T14:00:00.000+09:00" */
function toKstIso(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  const ss = String(kst.getUTCSeconds()).padStart(2, "0");
  const ms = String(kst.getUTCMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}+09:00`;
}

/** "2026-05-06 14:25:00" (KST) — sheet 표시용 */
function toKstDisplay(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export interface SsOrderLine {
  productOrderId: string;
  orderId: string;
  originProductNo: string;
  productName: string;
  optionText: string;
  sellerProductCode: string;
  quantity: number;
  totalPaymentAmount: number;
  orderedAt: string;
  status: string;
}

interface LastChangedItem {
  productOrderId: string;
  productOrderStatus: string;
  paymentDate?: string;
}

interface ProductOrderDetail {
  productOrder: {
    productOrderId: string;
    originalProductId?: number | string; // origin product id — 식스샵 매핑 키
    productId?: number | string; // channel product id (per-channel)
    productName: string;
    productOption?: string;
    sellerProductCode?: string;
    quantity: number;
    totalPaymentAmount?: number;
    productOrderStatus: string;
  };
  order: {
    orderId: string;
    orderDate: string;
    paymentDate?: string;
  };
}

async function fetchWithRetry(url: string | URL, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(url, init);
    if (resp.status !== 429) return resp;
    const wait = 2000 * (attempt + 1);
    console.log(`  rate limited, retry in ${wait}ms (attempt ${attempt + 1})`);
    await sleep(wait);
  }
  return fetch(url, init);
}

async function fetchPayedIdsChunk(
  token: string,
  fromIso: string,
  toIso: string,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor = fromIso;
  // Naver's last-changed-statuses may paginate via `more.moreFrom`
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${BASE_URL}/v1/pay-order/seller/product-orders/last-changed-statuses`);
    url.searchParams.set("lastChangedFrom", cursor);
    url.searchParams.set("lastChangedTo", toIso);
    // lastChangedType 생략 — 모든 상태 변경을 가져온 뒤 details에서 status 기준으로 필터
    // (PAYED만 필터하면 이미 배송 단계로 넘어간 과거 주문이 누락됨)
    const resp = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(`SS lastChangedStatuses failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as {
      data?: { lastChangeStatuses?: LastChangedItem[]; more?: { moreFrom?: string } | null };
    };
    if (process.env.SS_DEBUG === "1") {
      console.log(`[SS debug] from=${cursor} to=${toIso} → keys=${Object.keys(data).join(",")} dataKeys=${Object.keys(data.data ?? {}).join(",")} count=${(data.data?.lastChangeStatuses ?? []).length}`);
      console.log(`[SS debug] raw: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const items = data.data?.lastChangeStatuses ?? [];
    for (const it of items) ids.push(it.productOrderId);
    const moreFrom = data.data?.more?.moreFrom;
    if (!moreFrom) break;
    cursor = moreFrom;
  }
  return ids;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Naver는 한 호출당 최대 24시간 윈도우만 허용 — 23h 단위로 쪼개서 순차 fetch (rate limit 회피용 sleep) */
async function fetchPayedIds(
  token: string,
  from: Date,
  to: Date,
): Promise<string[]> {
  const ids: string[] = [];
  const chunkMs = 23 * 60 * 60 * 1000;
  let cursor = from.getTime();
  let firstChunk = true;
  while (cursor < to.getTime()) {
    if (!firstChunk) await sleep(1500);
    firstChunk = false;
    const chunkEnd = Math.min(cursor + chunkMs, to.getTime());
    const chunkIds = await fetchPayedIdsChunk(token, toKstIso(new Date(cursor)), toKstIso(new Date(chunkEnd)));
    for (const id of chunkIds) ids.push(id);
    cursor = chunkEnd;
  }
  return Array.from(new Set(ids));
}

async function fetchOrderDetails(
  token: string,
  productOrderIds: string[],
): Promise<ProductOrderDetail[]> {
  if (productOrderIds.length === 0) return [];
  const out: ProductOrderDetail[] = [];
  for (let i = 0; i < productOrderIds.length; i += 300) {
    const batch = productOrderIds.slice(i, i + 300);
    const resp = await fetch(`${BASE_URL}/v1/pay-order/seller/product-orders/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ productOrderIds: batch }),
    });
    if (!resp.ok) {
      throw new Error(`SS query failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as { data?: ProductOrderDetail[] };
    if (process.env.SS_DEBUG === "1" && i === 0 && (data.data?.length ?? 0) > 0) {
      console.log("[SS debug] sample productOrder keys:", Object.keys((data.data as any[])[0]?.productOrder ?? {}).join(","));
      console.log("[SS debug] sample productOrder:", JSON.stringify((data.data as any[])[0]?.productOrder ?? {}, null, 2).slice(0, 1500));
    }
    out.push(...(data.data ?? []));
  }
  return out;
}

/**
 * 지정 기간(KST) 동안 결제완료(PAYED)된 SS 주문 라인 fetch.
 * `from`이 너무 과거면 응답이 커지니 호출부에서 적절히 잘라줄 것.
 */
export async function fetchSmartStoreOrders(
  brand: Brand,
  from: Date,
  to: Date,
): Promise<SsOrderLine[]> {
  const creds = smartStoreCreds(brand);
  const token = await getAccessToken(creds);

  const ids = await fetchPayedIds(token, from, to);
  if (ids.length === 0) return [];

  const details = await fetchOrderDetails(token, ids);
  return details.map((d) => ({
    productOrderId: String(d.productOrder.productOrderId),
    orderId: String(d.order.orderId),
    // pay-order/product-orders/query는 originalProductId 키 사용 (products/search의 originProductNo와 동일 ID)
    originProductNo: String(d.productOrder.originalProductId ?? d.productOrder.productId ?? ""),
    productName: d.productOrder.productName ?? "",
    optionText: d.productOrder.productOption ?? "",
    sellerProductCode: d.productOrder.sellerProductCode ?? "",
    quantity: Number(d.productOrder.quantity) || 0,
    totalPaymentAmount: Number(d.productOrder.totalPaymentAmount) || 0,
    orderedAt: toKstDisplay(d.order.paymentDate ?? d.order.orderDate),
    status: d.productOrder.productOrderStatus,
  }));
}

/**
 * SS 옵션 조합 (옵션값들 / join + stockQuantity).
 * 식스샵 옵션과 token 매칭에 사용.
 */
export interface SsOptionCombo {
  /** "블랙 / 1m" 형태 — 옵션값을 ' / '로 join (옵션이름은 빠짐, token 매칭이 흡수) */
  optionText: string;
  stockQuantity: number;
}

/**
 * 모든 판매 가능 SS 상품의 옵션별 재고.
 * 반환: Map<originProductNo, { totalStock, optionCombos: SsOptionCombo[] }>
 *
 * 옵션 없는 상품: optionCombos 빈 배열, totalStock에 channelProducts[0].stockQuantity.
 * 옵션 있는 상품: optionCombos에 각 조합. totalStock은 합.
 */
export interface SsProductStock {
  totalStock: number;
  optionCombos: SsOptionCombo[];
}

export async function fetchSmartStoreProductStocks(brand: Brand): Promise<Map<string, SsProductStock>> {
  const creds = smartStoreCreds(brand);
  const token = await getAccessToken(creds);

  // 1단계: products/search로 판매중(SALE) 상품의 originProductNo 수집.
  // search 응답은 옵션 정보를 안 주므로 ID만 받고 단건 조회로 옵션별 재고 가져옴.
  const ids: string[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await fetchWithRetry(`${BASE_URL}/v1/products/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ size: 100, page }),
    });
    if (!r.ok) {
      throw new Error(`SS products/search failed: ${r.status} ${await r.text()}`);
    }
    const data = (await r.json()) as {
      contents?: Array<{
        originProductNo: number | string;
        channelProducts?: Array<{ statusType?: string }>;
      }>;
    };
    const contents = data.contents ?? [];
    if (contents.length === 0) break;
    for (const c of contents) {
      const status = c.channelProducts?.[0]?.statusType;
      if (status !== "SALE") continue;
      ids.push(String(c.originProductNo));
    }
    if (contents.length < 100) break;
    await sleep(800);
  }

  // 2단계: 각 originProductNo 단건 조회로 옵션조합별 stockQuantity fetch (5 병렬).
  // 응답: originProduct.{stockQuantity, detailAttribute.optionInfo.optionCombinations[]}
  const result = new Map<string, SsProductStock>();
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    await Promise.all(
      batch.map(async (id) => {
        try {
          const resp = await fetchWithRetry(`${BASE_URL}/v2/products/origin-products/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!resp.ok) {
            console.warn(`  SS stock fetch ${id} failed: ${resp.status}`);
            return;
          }
          const data = (await resp.json()) as {
            originProduct?: {
              stockQuantity?: number;
              detailAttribute?: {
                optionInfo?: {
                  optionCombinations?: Array<{
                    optionName1?: string;
                    optionName2?: string;
                    optionName3?: string;
                    stockQuantity?: number;
                  }>;
                };
              };
            };
          };
          const op = data.originProduct;
          const totalStock = Number(op?.stockQuantity) || 0;
          const combos: SsOptionCombo[] = (op?.detailAttribute?.optionInfo?.optionCombinations ?? [])
            .map((co) => {
              const parts = [co.optionName1, co.optionName2, co.optionName3]
                .filter(Boolean)
                .map((s) => String(s).trim());
              return {
                optionText: parts.join(" / "),
                stockQuantity: Number(co.stockQuantity) || 0,
              };
            })
            .filter((c) => c.optionText);
          if (process.env.SS_DEBUG === "1" && i === 0) {
            console.log(`[SS stock debug] ${id} totalStock=${totalStock} combos=${combos.length}`);
          }
          result.set(id, { totalStock, optionCombos: combos });
        } catch (e) {
          console.warn(`  SS stock fetch ${id} error: ${(e as Error).message}`);
        }
      }),
    );
    if (i + 5 < ids.length) await sleep(1000);
  }
  return result;
}

/** 기존 호환: 상품 단위 stock 합만 반환 */
export async function fetchSmartStoreStocks(brand: Brand): Promise<Map<string, number>> {
  const creds = smartStoreCreds(brand);
  const token = await getAccessToken(creds);
  const result = new Map<string, number>();

  for (let page = 1; page <= 50; page++) {
    const r = await fetchWithRetry(`${BASE_URL}/v1/products/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ size: 100, page }),
    });
    if (!r.ok) {
      throw new Error(`SS products/search failed: ${r.status} ${await r.text()}`);
    }
    const data = (await r.json()) as {
      contents?: Array<{
        originProductNo: number | string;
        channelProducts?: Array<{ stockQuantity?: number; statusType?: string }>;
      }>;
      totalElements?: number;
    };
    const contents = data.contents ?? [];
    if (contents.length === 0) break;
    for (const c of contents) {
      const cp = c.channelProducts?.[0];
      const stock = Number(cp?.stockQuantity) || 0;
      result.set(String(c.originProductNo), stock);
    }
    if (contents.length < 100) break;
    await sleep(800); // rate limit 보호
  }
  return result;
}

/** 시트에 적재할 행 형식. K열 SS상품번호(originProductNo) — 식스샵 매핑용 */
export const SS_ORDER_HEADER = [
  "주문번호", "상품주문번호", "주문일시", "상태", "상품명", "옵션",
  "SKU", "수량", "결제금액", "수집일시", "SS상품번호",
] as const;

export type SsOrderRow = [
  orderId: string,
  productOrderId: string,
  orderedAt: string,
  status: string,
  productName: string,
  optionText: string,
  sku: string,
  quantity: number,
  totalAmount: number,
  collectedAt: string,
  originProductNo: string,
];

export function ssRowKey(line: SsOrderLine): string {
  // productOrderId 단독으로 unique
  return line.productOrderId;
}

export function ssToRow(line: SsOrderLine, collectedAt: string): SsOrderRow {
  return [
    line.orderId,
    line.productOrderId,
    line.orderedAt,
    line.status,
    line.productName,
    line.optionText,
    line.sellerProductCode,
    line.quantity,
    line.totalPaymentAmount,
    collectedAt,
    line.originProductNo,
  ];
}
