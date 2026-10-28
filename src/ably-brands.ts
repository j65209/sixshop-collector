/**
 * 에이블리 보고서 마켓(브랜드) 설정 — src/ably-live.ts(30분마다) 가 쓴다. 매일 07:10 src/ably-daily.ts 는 코페리만.
 * id 는 오피스 PLATFORM_SECTIONS 의 brand 와 같게 — 전략팀 플랫폼 탭 "ably-{id}" 카드가 brightbeed-reports 의 dir 을 읽는다
 * (코페리만 처음 만든 경로 ably/ 그대로, 나머지는 ably/{id}/).
 *
 * env (마켓마다 envSuffix 를 붙여서): ABLY_EMAIL · ABLY_PASSWORD (셀러 어드민 계정) · ABLY_AD_MARKET_SNO (광고 관리자 마켓 번호)
 *   2026-10-28 확인: 아페티 60636 · 식스에이 22249 — statistics_timeseries 7일 합이 대시보드 ad_performance.ad_spend 와 같음
 */

export interface AblyBrand {
  /** 보고서 market (오피스 표시) */
  name: string;
  /** brightbeed-reports 안 경로 — {dir}/daily/{date}.json · {dir}/index.json */
  dir: string;
  /** env 이름 뒤에 붙임 — ABLY_EMAIL{envSuffix} 등 */
  envSuffix: string;
  /** 원가 시트(src/ably-cost.ts) 연결 — false 면 원가 미반영 보고서 (summary.cost = null, 순이익에 원가 안 뺌) */
  costs: boolean;
}

export const ABLY_BRANDS: Record<string, AblyBrand> = {
  kop: { name: process.env.ABLY_MARKET_NAME ?? "코페리", dir: "ably", envSuffix: "", costs: true },
  apt: { name: "아페티", dir: "ably/apt", envSuffix: "_APT", costs: false },
  "6a": { name: "식스에이", dir: "ably/6a", envSuffix: "_6A", costs: false },
};
