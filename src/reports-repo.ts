/**
 * 비공개 레포 j65209/brightbeed-reports 에 일일 보고서 기록 — 오피스 전략팀이 프록시로 읽는다.
 *   {dir}/daily/{date}.json · {dir}/index.json (days: 최신 날짜부터, 같은 날짜는 덮어씀)
 * dir 규칙 (오피스 index.html 전략팀 주석과 같음):
 *   에이블리 코페리 = "ably" (처음 만든 경로 그대로) · 공홈 = "home/{브랜드}" · 다른 플랫폼 = "{플랫폼}/{브랜드}"
 *
 * env: REPORTS_GITHUB_TOKEN (contents 쓰기 권한) · (선택) REPORTS_REPO
 */

export const REPORTS_REPO = process.env.REPORTS_REPO ?? "j65209/brightbeed-reports";

function token(): string {
  const t = process.env.REPORTS_GITHUB_TOKEN;
  if (!t) throw new Error("Missing required env: REPORTS_GITHUB_TOKEN");
  return t;
}

export async function ghPut(path: string, content: unknown, message: string): Promise<void> {
  const url = `https://api.github.com/repos/${REPORTS_REPO}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json" };
  const cur = await fetch(url, { headers });
  const sha = cur.ok ? ((await cur.json()) as { sha: string }).sha : undefined;
  const r = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(content, null, 1)).toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export async function ghGetJson<T>(path: string): Promise<T | null> {
  const r = await fetch(`https://api.github.com/repos/${REPORTS_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github.raw+json" },
  });
  return r.ok ? ((await r.json()) as T) : null;
}

/** 오피스 "최근 일별 추이" 표와 카드 순이익이 읽는 한 줄 */
export interface IndexRow {
  date: string;
  orders: number;
  paid: number;
  net: number;
  ad_spend: number;
  coupon_orders: number;
  cost: number | null;
}

export interface DailyReportBase {
  date: string;
  generated_at: string;
  summary: Omit<IndexRow, "date">;
}

/** daily/{date}.json 을 쓰고 index.json 의 그 날짜 줄을 갱신. label 은 커밋 메시지 앞머리 (예: "ably", "home kop") */
export async function writeDailyReport(dir: string, report: DailyReportBase, label: string): Promise<void> {
  await ghPut(`${dir}/daily/${report.date}.json`, report, `${label}: daily ${report.date}`);
  const idx = (await ghGetJson<{ days: IndexRow[] }>(`${dir}/index.json`)) ?? { days: [] };
  const s = report.summary;
  const row: IndexRow = {
    date: report.date,
    orders: s.orders,
    paid: s.paid,
    net: s.net,
    ad_spend: s.ad_spend,
    coupon_orders: s.coupon_orders,
    cost: s.cost,
  };
  idx.days = [row, ...idx.days.filter((d) => d.date !== report.date)].sort((a, b) => b.date.localeCompare(a.date));
  await ghPut(`${dir}/index.json`, { updated_at: report.generated_at, days: idx.days }, `${label}: index ${report.date}`);
}
