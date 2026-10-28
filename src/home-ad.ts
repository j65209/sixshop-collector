/**
 * 공홈 보고서 광고비 — 오피스 광고 시트(마케팅팀이 다음 날 입력)가 기준, 아직 없으면 메타 광고 데이터로 추정.
 *   광고 시트  beaduniverse data/ad-sheets/{브랜드}.json  days[date]: krw (없으면 usd × fx) · rev(원)
 *              — krw = 메타 광고비(달러) × 그날 환율 (2026-10-26 코페리 677.15 × 1,324.3 = 896,750원). 시트가 없는 브랜드도 있음(404)
 *   메타 데이터 beaduniverse data/meta-ads/{브랜드}.json  맥미니가 약 1시간마다 갱신. today · yesterday 의 spend(계정 통화) · purchase_value.
 *              generated_at(계정 시간대 KST, 시간대 표시 없음)의 날짜가 "today" — 그날과 전날만 쓸 수 있다.
 * 광고 시트를 이번에 못 읽으면(네트워크 · 5xx) unavailable — "미입력"과 구분해서 실시간 수집기가 이전 값을 지키게 한다.
 * 오피스 index.html _adshCalc 와 같은 계산.
 */
import type { HomeAd } from "./home-report.js";

export const OFFICE_RAW = "https://raw.githubusercontent.com/j65209/beaduniverse/main";

interface AdDay { krw?: number; usd?: number; rev?: number; revUsd?: number; fx?: number }
interface MetaPeriod { spend?: number; purchase_value?: number }
interface MetaAds { generated_at?: string; account?: { currency?: string }; today?: MetaPeriod; yesterday?: MetaPeriod }

// 한 번 실행하는 동안 같은 파일은 한 번만 받음 (실시간 수집기는 브랜드 · 날짜마다 부른다). 실패는 기억하지 않음
const cache = new Map<string, Promise<unknown>>();
/** 오피스 데이터 파일 — 없으면(404) null, 못 읽으면 던짐 */
function getJson<T>(path: string): Promise<T | null> {
  if (!cache.has(path)) {
    const p = fetch(`${OFFICE_RAW}/${path}?_t=${Date.now()}`).then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T | null>;
}

async function fxRate(date: string): Promise<number | null> {
  const rates = (await getJson<{ rates?: Record<string, { rate: number }> }>("data/fx-usd.json").catch(() => null))?.rates ?? {};
  const days = Object.keys(rates).filter((d) => d <= date).sort();
  return days.length ? rates[days[days.length - 1]].rate : null;
}

const prevDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);

/** 광고 시트에 아직 없는 날 — 메타 광고 데이터의 오늘 · 어제 값 × 환율 (추정) */
async function metaAd(brand: string, date: string): Promise<HomeAd | null> {
  const m = await getJson<MetaAds>(`data/meta-ads/${brand}.json`).catch(() => null);
  const at = m?.generated_at ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) return null;
  const metaDay = at.slice(0, 10);
  const p = date === metaDay ? m?.today : date === prevDay(metaDay) ? m?.yesterday : null;
  if (p?.spend == null) return null;
  const rate = (m?.account?.currency ?? "USD").toUpperCase() === "KRW" ? 1 : await fxRate(date);
  if (!rate) return null;
  return {
    spend: p.spend * rate,
    order_price: p.purchase_value != null ? p.purchase_value * rate : null,
    basis: `메타 광고 데이터로 추정 — 광고 시트 입력 전 (data/meta-ads/${brand}.json ${at.slice(5, 10).replace("-", "/")} ${at.slice(11, 16)} 기준${date === metaDay ? ", 그때까지 쓴 금액" : ""})`,
    estimated: true,
  };
}

export async function loadAd(brand: string, date: string): Promise<HomeAd> {
  const basis = `오피스 광고 시트 (메타, data/ad-sheets/${brand}.json)`;
  let sheet: { days?: Record<string, AdDay> } | null;
  try {
    sheet = await getJson(`data/ad-sheets/${brand}.json`);
  } catch (e) {
    // 못 읽음 — 메타 추정이 있으면 그 값을 주되 unavailable 로 알림
    const meta = await metaAd(brand, date);
    return { ...(meta ?? { spend: null, order_price: null, basis: `${basis} — 못 읽음 (${(e as Error).message})` }), unavailable: true };
  }
  const day = sheet?.days?.[date];
  if (day) {
    const rate = day.fx ?? (day.usd != null || day.revUsd != null ? await fxRate(date) : null);
    const spend = day.krw ?? (day.usd != null && rate ? day.usd * rate : null);
    if (spend != null) {
      const orderPrice = day.rev ?? (day.revUsd != null && rate ? day.revUsd * rate : null);
      return { spend, order_price: orderPrice, basis };
    }
  }
  return (await metaAd(brand, date)) ?? { spend: null, order_price: null, basis: sheet ? `${basis} — ${date} 광고비 미입력` : `${basis} — 광고 시트 없음` };
}
