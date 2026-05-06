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

async function fetchPayedIds(
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
    url.searchParams.set("lastChangedType", "PAYED");
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(`SS lastChangedStatuses failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as {
      data?: { lastChangeStatuses?: LastChangedItem[]; more?: { moreFrom?: string } | null };
    };
    const items = data.data?.lastChangeStatuses ?? [];
    for (const it of items) ids.push(it.productOrderId);
    const moreFrom = data.data?.more?.moreFrom;
    if (!moreFrom) break;
    cursor = moreFrom;
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

  const fromIso = toKstIso(from);
  const toIso = toKstIso(to);

  const ids = await fetchPayedIds(token, fromIso, toIso);
  if (ids.length === 0) return [];

  const details = await fetchOrderDetails(token, ids);
  return details.map((d) => ({
    productOrderId: String(d.productOrder.productOrderId),
    orderId: String(d.order.orderId),
    productName: d.productOrder.productName ?? "",
    optionText: d.productOrder.productOption ?? "",
    sellerProductCode: d.productOrder.sellerProductCode ?? "",
    quantity: Number(d.productOrder.quantity) || 0,
    totalPaymentAmount: Number(d.productOrder.totalPaymentAmount) || 0,
    orderedAt: toKstDisplay(d.order.paymentDate ?? d.order.orderDate),
    status: d.productOrder.productOrderStatus,
  }));
}

/** 시트에 적재할 행 형식. 식스샵 ORDER_HEADER와 동일 12-col 구조로 맞춤 */
export const SS_ORDER_HEADER = [
  "주문번호", "상품주문번호", "주문일시", "상태", "상품명", "옵션",
  "SKU", "수량", "결제금액", "수집일시",
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
  ];
}
