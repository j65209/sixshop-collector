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

/** 파일 내용 — 없으면(404) null. 그 밖의 오류(5xx · 403 · 429)는 던짐: "없음"으로 착각하면 index 를 비운 채 덮어쓰게 된다 */
export async function ghGetJson<T>(path: string): Promise<T | null> {
  const r = await fetch(`https://api.github.com/repos/${REPORTS_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github.raw+json" },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${path} → ${r.status} ${(await r.text()).slice(0, 120)}`);
  return (await r.json()) as T;
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
  /** 하루가 아직 안 끝난 보고서 — 계산한 시각 "HH:MM"(KST). 오피스가 "진행 중"으로 표시 */
  as_of?: string;
}

export interface DailyReportBase {
  date: string;
  generated_at: string;
  as_of?: string;
  summary: Omit<IndexRow, "date" | "as_of">;
}

export function indexRowOf(report: DailyReportBase): IndexRow {
  const s = report.summary;
  return {
    date: report.date,
    orders: s.orders,
    paid: s.paid,
    net: s.net,
    ad_spend: s.ad_spend,
    coupon_orders: s.coupon_orders,
    cost: s.cost,
    ...(report.as_of ? { as_of: report.as_of } : {}),
  };
}

/** index.json 의 days 에 줄들을 넣음 (같은 날짜는 바꿈, 최신 날짜부터) */
export function mergeIndexRows(days: IndexRow[], rows: IndexRow[]): IndexRow[] {
  const dates = new Set(rows.map((r) => r.date));
  return [...rows, ...days.filter((d) => !dates.has(d.date))].sort((a, b) => b.date.localeCompare(a.date));
}

/** daily/{date}.json 을 쓰고 index.json 의 그 날짜 줄을 갱신. label 은 커밋 메시지 앞머리 (예: "ably", "home kop") */
export async function writeDailyReport(dir: string, report: DailyReportBase, label: string): Promise<void> {
  await ghPut(`${dir}/daily/${report.date}.json`, report, `${label}: daily ${report.date}`);
  const idx = (await ghGetJson<{ days: IndexRow[] }>(`${dir}/index.json`)) ?? { days: [] };
  idx.days = mergeIndexRows(idx.days, [indexRowOf(report)]);
  await ghPut(`${dir}/index.json`, { updated_at: report.generated_at, days: idx.days }, `${label}: index ${report.date}`);
}

/** 시각만 다른 건 같은 내용으로 침 (generated_at · updated_at · as_of) */
export function sameContent(a: unknown, b: unknown): boolean {
  const strip = (x: unknown) => JSON.stringify(x, (k, v) => (k === "generated_at" || k === "updated_at" || k === "as_of" ? undefined : v));
  return strip(a) === strip(b);
}

/**
 * 여러 파일을 커밋 하나로 올림 (Git Data API) — 30분마다 도는 실시간 수집기가 브랜드 · 파일마다 커밋을 쌓지 않게.
 * 그사이 다른 곳(맥미니 다른 작업 · 이 PC)이 먼저 올렸으면 그 위에 다시 만들어 최대 3번 시도. 올린 커밋 sha 를 돌려줌.
 */
export async function commitFiles(files: { path: string; content: unknown }[], message: string, branch = "main"): Promise<string | null> {
  if (!files.length) return null;
  const api = `https://api.github.com/repos/${REPORTS_REPO}/git`;
  const headers = { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  // raced: 브랜치 옮기기(PATCH ref)에서만 422/409(빨리 감기 안 됨)를 실패 대신 "다시 시도"로 받음
  const call = async <T>(method: string, path: string, body?: unknown, raced = false): Promise<{ ok: boolean; json: T }> => {
    const r = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok && !(raced && (r.status === 409 || r.status === 422))) {
      throw new Error(`GitHub ${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
    }
    return { ok: r.ok, json: (text ? JSON.parse(text) : {}) as T };
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const head = (await call<{ object: { sha: string } }>("GET", `/ref/heads/${branch}`)).json.object.sha;
    const baseTree = (await call<{ tree: { sha: string } }>("GET", `/commits/${head}`)).json.tree.sha;
    const tree = await call<{ sha: string }>("POST", "/trees", {
      base_tree: baseTree,
      tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: JSON.stringify(f.content, null, 1) })),
    });
    const made = await call<{ sha: string }>("POST", "/commits", { message, tree: tree.json.sha, parents: [head] });
    const moved = await call("PATCH", `/refs/heads/${branch}`, { sha: made.json.sha, force: false }, true);
    if (moved.ok) return made.json.sha;
    // 그사이 다른 커밋이 올라감 → 새 HEAD 위에 다시
  }
  throw new Error("GitHub 커밋 실패 — 3번 시도하는 동안 계속 다른 커밋이 먼저 올라감");
}
