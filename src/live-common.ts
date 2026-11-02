/**
 * 30분마다 도는 채널 보고서 수집기의 공통 부분 (지그재그 · 스마트스토어) — 날짜 범위 정하기, 바뀐 보고서만 골라 올릴 파일 만들기.
 * 규칙은 공홈 · 에이블리 실시간과 같다: 오늘 · 어제, 06시 이후 그날 첫 실행은 지난 8일. 오늘 보고서는 as_of(계산 시각) 표시.
 */
import { indexRowOf, mergeIndexRows, sameContent, type DailyReportBase, type IndexRow } from "./reports-repo.js";

const DAY = 86400_000;
export const SETTLE_DAYS = 8;
export const SETTLE_HOUR = 6;
export const MAX_DAYS = 92;
// 오늘 보고서는 숫자가 그대로여도 이만큼 지나면 다시 올림 — 오피스의 "HH:MM 기준" 이 너무 오래돼 보이지 않게
export const PARTIAL_REFRESH_MIN = 55;

export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const won = (n: number) => Math.round(n).toLocaleString("ko-KR");

export function liveWindow(nowMs: number, days: number | null, settled: string | undefined) {
  const now = new Date(nowMs + 9 * 3600_000); // KST 를 UTC 필드로
  const today = now.toISOString().slice(0, 10);
  const asOf = now.toISOString().slice(11, 16);
  const settle = days == null && now.getUTCHours() >= SETTLE_HOUR && settled !== today;
  const nDays = days ?? (settle ? SETTLE_DAYS : 2);
  const dates = Array.from({ length: nDays }, (_, i) => addDays(today, -i));
  return { today, asOf, settle, dates, oldest: dates[dates.length - 1], months: [...new Set(dates.map((d) => d.slice(0, 7)))] };
}

/** 오늘 보고서면 진행 중 표시를 붙임 */
export function markPartial<R extends { assumptions: object }>(report: R, partial: boolean, asOf: string): R & { as_of?: string } {
  return partial ? { ...report, as_of: asOf, assumptions: { ...report.assumptions, partial_day: true } } : report;
}

/** 계산한 보고서 중 바뀐 것만 골라 daily · index 파일로 — 읽기 실패는 던진다 (없음으로 착각해 index 를 비우지 않게) */
export async function changedFiles(
  dir: string,
  reports: (DailyReportBase & { as_of?: string })[],
  ctx: { today: string; nowMs: number; label: string; getJson: <T>(path: string) => Promise<T | null> },
): Promise<{ files: { path: string; content: unknown }[]; done: string[] }> {
  const files: { path: string; content: unknown }[] = [];
  const rows: IndexRow[] = [];
  const done: string[] = [];
  for (const report of reports) {
    const path = `${dir}/daily/${report.date}.json`;
    const prev = await ctx.getJson<{ generated_at?: string }>(path);
    const stale = report.date === ctx.today && prev?.generated_at != null && ctx.nowMs - Date.parse(prev.generated_at) >= PARTIAL_REFRESH_MIN * 60_000;
    if (prev && sameContent(prev, report) && !stale) continue;
    files.push({ path, content: report });
    rows.push(indexRowOf(report));
    done.push(`${ctx.label} ${report.date.slice(5)}`);
  }
  if (rows.length) {
    const idx = (await ctx.getJson<{ days: IndexRow[] }>(`${dir}/index.json`)) ?? { days: [] };
    // 날이 지났는데 남은 "진행 중" 표시는 지움 (지난 날 보고서는 다시 계산하면서 as_of 없이 올라감)
    const days = mergeIndexRows(idx.days, rows).map((d) => (d.date !== ctx.today && d.as_of ? (({ as_of: _, ...rest }) => rest)(d) : d));
    files.push({ path: `${dir}/index.json`, content: { updated_at: new Date(ctx.nowMs).toISOString(), days } });
  }
  return { files, done };
}
