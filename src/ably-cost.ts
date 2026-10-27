/**
 * 에이블리 주문 → 원가 매칭.
 *
 * 원가 시트(오피스 기획전 계산기와 같은 시트, 링크 공개 gviz CSV):
 *   A표 C열 상품명 · E열 원가(원)  ← 우선
 *   B표 P열 상품명 · Q열 원가(원)  ← A표에 없는 이름만 보충
 *
 * 에이블리 상품명은 "❤️‍🔥유사품주의! 리버시블 보부상 가방!❤️‍🔥cobaltiny bag 노트북…" 처럼 길어서
 * 시트 상품명의 앞 두 단어(제품 키)가 에이블리 상품명에 들어 있는 행만 후보로 두고,
 * 나머지 단어(색상·사이즈·유광/무광)가 옵션과 얼마나 맞는지로 고른다.
 * 맞는 색상이 시트에 없으면 색상 없는 기본 행(예: "cobaltiny bag")을 쓴다.
 */

export const DEFAULT_COST_SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/1bnKosG3_Ytjg-maMKt1SeaO-ojeQemKp_mzyjnWscD0/gviz/tq?tqx=out:csv&gid=0";

export interface CostRow {
  name: string;
  cost: number;
  table: "A" | "B";
}

export interface CostMatch {
  cost_unit: number | null;
  cost_name: string | null;
  /** exact: 옵션까지 일치 · base: 색상 없는 기본 행/색상 미일치 · none: 못 찾음 */
  cost_match: "exact" | "base" | "none";
}

// 시트 값보다 우선하는 원가 (사장님 확인값). 시트 E열을 고치면 여기서 지워도 된다.
const COST_OVERRIDES: Record<string, number> = {
  "cobaltiny bag (black)": 6750, // 2026-10-27: E열 6,528 · Q열 6,750 중 Q열이 맞음
};

// 시트 약어 → 옵션 표기
const SYNONYM: Record<string, string> = { bl: "black", bk: "black", blk: "black", w: "white", wh: "white", iv: "ivory", br: "brown" };

const norm = (s: string) => s.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[()\[\]/,&]/g, " ")
    .split(/\s+/)
    .map((t) => norm(t))
    .filter(Boolean)
    .map((t) => SYNONYM[t] ?? t);

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (c === '"') inQ = true;
    else if (c !== "\r") cur += c;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

const won = (s: string | undefined) => Number(String(s ?? "").replace(/[^0-9.]/g, "")) || 0;

export function costRowsFromCsv(csv: string): CostRow[] {
  const rows = parseCsv(csv).slice(1);
  const a: CostRow[] = [];
  const b: CostRow[] = [];
  for (const r of rows) {
    if (r[2]?.trim() && won(r[4]) > 0) a.push({ name: r[2].trim(), cost: won(r[4]), table: "A" });
    if (r[15]?.trim() && won(r[16]) > 0) b.push({ name: r[15].trim(), cost: won(r[16]), table: "B" });
  }
  const overrides = new Map(Object.entries(COST_OVERRIDES).map(([k, v]) => [norm(k), v]));
  for (const x of [...a, ...b]) {
    const o = overrides.get(norm(x.name));
    if (o) x.cost = o;
  }
  const inA = new Set(a.map((x) => norm(x.name)));
  const seenB = new Set<string>();
  return [
    ...a,
    ...b.filter((x) => {
      const k = norm(x.name);
      if (inA.has(k) || seenB.has(k)) return false;
      seenB.add(k);
      return true;
    }),
  ];
}

export async function loadCostRows(url = process.env.ABLY_COST_SHEET_CSV ?? DEFAULT_COST_SHEET_CSV): Promise<CostRow[]> {
  const r = await fetch(`${url}&_t=${Date.now()}`);
  if (!r.ok) throw new Error(`원가 시트 ${r.status}`);
  return costRowsFromCsv(await r.text());
}

export function matchCost(rows: CostRow[], goodsName: string, goodsCode: string, option: string): CostMatch {
  const nameHay = norm(`${goodsName} ${goodsCode}`);
  const hayTokens = new Set(tokens(`${goodsName} ${goodsCode} ${option}`));
  let best: { row: CostRow; score: number; matched: number; unmatched: number } | null = null;
  let variants = 0;
  for (const row of rows) {
    const t = tokens(row.name);
    if (t.length < 2 || !nameHay.includes(t[0] + t[1])) continue;
    const rest = t.slice(2);
    if (rest.length) variants++;
    const matched = rest.filter((x) => hayTokens.has(x)).length;
    const unmatched = rest.length - matched;
    // 일치 단어가 많을수록, 안 맞는 단어가 적을수록 우선. 동점이면 A표.
    const score = 2 + matched * 10 - unmatched;
    if (!best || score > best.score || (score === best.score && row.table === "A" && best.row.table === "B")) {
      best = { row, score, matched, unmatched };
    }
  }
  if (!best) return { cost_unit: null, cost_name: null, cost_match: "none" };
  // 색상/사이즈 행이 따로 있는데 하나도 안 맞아 기본 행을 쓴 경우는 "base"
  const exact = best.unmatched === 0 && (best.matched > 0 || variants === 0);
  return { cost_unit: best.row.cost, cost_name: best.row.name, cost_match: exact ? "exact" : "base" };
}
