export interface OrderItem {
  orderNumber: string;       // 주문번호 (식스샵 고유)
  orderedAt: string;         // ISO 8601
  status: string;            // 결제완료/배송중/배송완료 등
  productName: string;
  optionText: string;        // 옵션 조합 (예: "색상: 블랙 / 사이즈: M")
  sku?: string;              // 상품 코드
  quantity: number;
  unitPrice: number;         // 옵션가 포함 단가
  lineTotal: number;         // unitPrice * quantity
  paymentMethod?: string;
  buyerName?: string;
  raw?: unknown;             // 디버깅용 원본
}

export type OrderRow = [
  orderNumber: string,
  orderedAt: string,
  status: string,
  productName: string,
  optionText: string,
  sku: string,
  quantity: number,
  unitPrice: number,
  lineTotal: number,
  paymentMethod: string,
  buyerName: string,
  collectedAt: string,
];

export const ORDER_HEADER: OrderRow = [
  "주문번호", "주문일시", "상태", "상품명", "옵션", "SKU",
  "수량", "단가", "합계", "결제방법", "주문자", "수집일시",
] as unknown as OrderRow;

export function toRow(o: OrderItem, collectedAt: string): OrderRow {
  return [
    o.orderNumber,
    o.orderedAt,
    o.status,
    o.productName,
    o.optionText,
    o.sku ?? "",
    o.quantity,
    o.unitPrice,
    o.lineTotal,
    o.paymentMethod ?? "",
    o.buyerName ?? "",
    collectedAt,
  ];
}

export function rowKey(o: OrderItem): string {
  // 한 주문 안에 같은 (상품, 옵션)이 두 번 나올 수 있어 수량/합계까지 키에 포함
  return [
    o.orderNumber,
    o.productName,
    o.optionText,
    String(o.quantity),
    String(o.lineTotal),
  ].join("::");
}
