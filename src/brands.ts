export interface Brand {
  /** 식스샵 사이트 식별자 (URL 경로). 예: "6thanother", "cleartype" */
  siteLink: string;
  /** 표시용 이름 */
  displayName: string;
  /** 식스샵 memberNo (mall API 호출용) */
  memberNo: number;
  /** 주문 로그 시트 탭 이름 */
  ordersSheetName: string;
  /** 재고 마스터 시트 탭 이름 */
  stockSheetName: string;
  /** 마지막 실행 메타데이터 시트 탭 이름 */
  stateSheetName: string;
  /** 재고마스터에 포함할 상품 상태 */
  includeStatuses: string[];
  /** 환경변수 suffix. "" → SIXSHOP_EMAIL, "_CLEARTYPE" → SIXSHOP_EMAIL_CLEARTYPE */
  credEnvSuffix: string;
  /** false면 cron에서 재고마스터 갱신 스킵 (주문 수집은 그대로). 멀티채널 매칭 전 임시. */
  inventoryEnabled: boolean;
  /** 스마트스토어 연동 설정 (있는 브랜드만). 매핑 완성 전엔 inventoryEnabled=false로 사용 보류. */
  smartStore?: {
    ssOrdersSheetName: string;
    credEnvSuffix: string;
  };
}

export const BRANDS: Brand[] = [
  {
    siteLink: "6thanother",
    displayName: "6thanother",
    memberNo: 184096,
    ordersSheetName: "6A 주문로그",
    stockSheetName: "6A 재고마스터",
    stateSheetName: "6A _state",
    includeStatuses: ["판매 중"],
    credEnvSuffix: "",
    inventoryEnabled: true,
  },
  {
    siteLink: "cleartype",
    displayName: "Clear.type",
    memberNo: 274464,
    ordersSheetName: "CT 주문로그",
    stockSheetName: "CT 재고마스터",
    stateSheetName: "CT _state",
    includeStatuses: ["판매 중", "품절"],
    credEnvSuffix: "_CLEARTYPE",
    inventoryEnabled: true,
  },
  {
    siteLink: "produktepr",
    displayName: "Produktepr",
    memberNo: 211642,
    ordersSheetName: "PP 주문로그",
    stockSheetName: "PP 재고마스터",
    stateSheetName: "PP _state",
    includeStatuses: ["판매 중", "품절"],
    credEnvSuffix: "_PP",
    // 식스샵+SS 멀티채널. 옵션 매칭 검증 전까지 재고 갱신 보류 (주문 수집은 정상 진행).
    inventoryEnabled: false,
    smartStore: {
      ssOrdersSheetName: "PP SS주문로그",
      credEnvSuffix: "_PP",
    },
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
