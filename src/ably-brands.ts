/**
 * 에이블리 보고서 마켓(브랜드) 설정 — src/ably-live.ts(30분마다) 가 쓴다. 매일 07:10 src/ably-daily.ts 는 코페리만.
 * id 는 오피스 PLATFORM_SECTIONS 의 brand 와 같게 — 전략팀 플랫폼 탭 "ably-{id}" 카드가 brightbeed-reports 의 dir 을 읽는다
 * (코페리만 처음 만든 경로 ably/ 그대로, 나머지는 ably/{id}/).
 *
 * env (마켓마다 envSuffix 를 붙여서): ABLY_EMAIL · ABLY_PASSWORD (셀러 어드민 계정) · ABLY_AD_MARKET_SNO (광고 관리자 마켓 번호)
 *   2026-10-28 확인: 아페티 60636 · 식스에이 22249 — statistics_timeseries 7일 합이 대시보드 ad_performance.ad_spend 와 같음
 */
import type { CostRow } from "./ably-cost.js";
import { costBook, matchCostAbly, type CostAlias } from "./cost-match.js";
import { APETI_ALIASES, loadApetiCosts, type CostMatcher } from "./home-brands.js";

/** 코페리 원가 시트가 아닌 마켓의 원가 */
export interface AblyCost {
  /** 보고서 assumptions.cost_basis */
  basis: string;
  /** 시트를 읽어 원가 찾기를 만듦 (실행마다 한 번) — 못 읽으면 그 마켓은 실패(아무것도 안 덮음) */
  load: () => Promise<CostMatcher>;
}

export interface AblyBrand {
  /** 보고서 market (오피스 표시) */
  name: string;
  /** brightbeed-reports 안 경로 — {dir}/daily/{date}.json · {dir}/index.json */
  dir: string;
  /** env 이름 뒤에 붙임 — ABLY_EMAIL{envSuffix} 등 */
  envSuffix: string;
  /** 원가 반영 — false 면 원가 미반영 보고서 (summary.cost = null, 순이익에 원가 안 뺌) */
  costs: boolean;
  /** costs 마켓의 원가 출처 — 없으면 코페리 원가 시트(src/ably-cost.ts loadCostRows · matchCost) */
  cost?: AblyCost;
}

// 에이블리 아페티 옵션 표기 → MD팀 아페티 시트 이름 (2026-08 ~ 10 에이블리 주문에 실제로 나온 표기). 공홈 별칭(APETI_ALIASES)보다 먼저 봄
const APETI_ABLY_ALIASES: CostAlias[] = [
  [/^\s*0?7\s*\.\s*0?8\s*set\s*$/i, "R-07 + R-08"], // 7080 ring set
  [/^\s*baby\s*set\s*$/i, "Baby ring-A + Baby ring-B"],
  [/^\s*(matt|white)\s*orion\s*set\s*\(\s*a\s*\+\s*b\s*\+\s*c\s*\)\s*$/i, "$1 ORION - A + $1 ORION - B + $1 ORION - C"],
  [/^\s*(?:오리온|orion)\s*set\s*\(\s*a\s*\+\s*b\s*\+\s*c\s*\)\s*$/i, "ORION- A + ORION - B + ORION - C"],
  [/^\s*오리온\s*-\s*([abc])\s*$/i, "ORION - $1"],
  [/^\s*도레미\s*-?\s*(\d)\s*$/, "DORAEMI $1"],
];
// "Heart ring set" 의 옵션 "set" = heart ring + White heart ring (플랫폼 세트 탭 두 반지 아래 1+1 줄 2,754원 = 합)
const apetiAblySpecial = (goodsName: string, option: string): string[] | null =>
  /heart\s*ring\s*set/i.test(goodsName) && /^\s*set\s*(\/|$)/i.test(option) ? ["heart ring", "White heart ring"] : null;

/** 에이블리 아페티 원가 찾기 — 시트 행으로 색인 (시험은 가짜 행으로) */
export function apetiAblyMatcher(rows: CostRow[]): CostMatcher {
  const book = costBook(rows, { aliases: [...APETI_ABLY_ALIASES, ...APETI_ALIASES], special: apetiAblySpecial });
  return (goodsName, goodsCode, option) => matchCostAbly(book, goodsName, goodsCode, option);
}

export const ABLY_BRANDS: Record<string, AblyBrand> = {
  kop: { name: process.env.ABLY_MARKET_NAME ?? "코페리", dir: "ably", envSuffix: "", costs: true },
  apt: {
    name: "아페티", dir: "ably/apt", envSuffix: "_APT", costs: true,
    cost: {
      basis: "MD팀 아페티 시트(공홈 보고서와 같은 표) — Product List → 공홈 가격 수정 표 → 플랫폼 세트 F열(공급가), 옵션에 고른 반지 · 세트 구성까지 읽어 매칭",
      load: async () => apetiAblyMatcher(await loadApetiCosts()),
    },
  },
  "6a": { name: "식스에이", dir: "ably/6a", envSuffix: "_6A", costs: false },
};
