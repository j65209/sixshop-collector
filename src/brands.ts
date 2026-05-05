export interface Brand {
  /** 식스샵 사이트 식별자 (URL 경로). 예: "6thanother", "cleartype" */
  siteLink: string;
  /** 표시용 이름 */
  displayName: string;
  /** 주문 로그 시트 탭 이름 */
  ordersSheetName: string;
  /** 재고 마스터 시트 탭 이름 */
  stockSheetName: string;
  /** 재고마스터에 포함할 상품 상태 */
  includeStatuses: string[];
  /** 환경변수 suffix. "" → SIXSHOP_EMAIL, "_CLEARTYPE" → SIXSHOP_EMAIL_CLEARTYPE */
  credEnvSuffix: string;
}

export const BRANDS: Brand[] = [
  {
    siteLink: "6thanother",
    displayName: "6thanother",
    ordersSheetName: "주문로그",
    stockSheetName: "재고마스터",
    includeStatuses: ["판매 중"],
    credEnvSuffix: "",
  },
  {
    siteLink: "cleartype",
    displayName: "Clear.type",
    ordersSheetName: "CT주문로그",
    stockSheetName: "CT마스터",
    includeStatuses: ["판매 중", "품절"],
    credEnvSuffix: "_CLEARTYPE",
  },
];

export function brandCredentials(brand: Brand): { email: string; password: string } {
  const email = process.env[`SIXSHOP_EMAIL${brand.credEnvSuffix}`];
  const password = process.env[`SIXSHOP_PASSWORD${brand.credEnvSuffix}`];
  if (!email || !password) {
    throw new Error(`Missing credentials for ${brand.displayName} (env SIXSHOP_EMAIL${brand.credEnvSuffix} / SIXSHOP_PASSWORD${brand.credEnvSuffix})`);
  }
  return { email, password };
}
