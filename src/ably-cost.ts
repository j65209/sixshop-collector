/**
 * 주문 → 원가 매칭 (에이블리 일일 보고서 · 공홈 일일 보고서 공용).
 *
 * 원가 시트 = 오피스 MD팀 "코페리" 구글시트 (기획전 계산기와 같은 파일, 링크 공개 gviz CSV):
 *   첫 탭(기획전 플랫폼 리스트) A표 C열 상품명 · E열 원가(원)  ← 우선
 *   첫 탭 B표 P열 상품명 · Q열 원가(원)                       ← A표에 없는 이름만 보충
 *   "Product List" 탭 C열 상품명 · E열 원가(원)               ← 위 두 표에 없는 이름만 보충
 *     (2026-10-28 기준 Bunny bag · Stella keyring · Mori dot bag mint/white 등 9개가 여기에만 있음.
 *      두 탭 값이 다른 5개 — ROUD bag · Staring backpack · stud belt · Vinta bag · SH star bag — 는 첫 탭 값을 씀)
 *
 * 에이블리 상품명은 "❤️‍🔥유사품주의! 리버시블 보부상 가방!❤️‍🔥cobaltiny bag 노트북…" 처럼 길어서
 * 시트 상품명의 앞 두 단어(제품 키)가 에이블리 상품명에 들어 있는 행만 후보로 두고,
 * 나머지 단어(색상·사이즈·유광/무광)가 옵션과 얼마나 맞는지로 고른다.
 * 맞는 색상이 시트에 없으면 색상 없는 기본 행(예: "cobaltiny bag")을 쓴다.
 */

export const DEFAULT_COST_SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/1bnKosG3_Ytjg-maMKt1SeaO-ojeQemKp_mzyjnWscD0/gviz/tq?tqx=out:csv&gid=0";
export const PRODUCT_LIST_CSV =
  "https://docs.google.com/spreadsheets/d/1bnKosG3_Ytjg-maMKt1SeaO-ojeQemKp_mzyjnWscD0/gviz/tq?tqx=out:csv&gid=705952769";

export interface CostRow {
  name: string;
  cost: number;
  /** A·B = 첫 탭의 두 표, P = Product List 탭 (보충) */
  table: "A" | "B" | "P";
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

const TABLE_RANK: Record<CostRow["table"], number> = { A: 0, B: 1, P: 2 };

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

/** Product List 탭: C열 상품명 · E열 원가 (B표 없음 — P·Q열은 다른 값이라 읽지 않는다) */
export function productListRowsFromCsv(csv: string): CostRow[] {
  const overrides = new Map(Object.entries(COST_OVERRIDES).map(([k, v]) => [norm(k), v]));
  return parseCsv(csv)
    .slice(1)
    .filter((r) => r[2]?.trim() && won(r[4]) > 0)
    .map((r) => ({ name: r[2].trim(), cost: overrides.get(norm(r[2])) ?? won(r[4]), table: "P" as const }));
}

/** 앞 목록에 없는 이름만 뒤에 붙임 */
export function withSupplement(main: CostRow[], extra: CostRow[]): CostRow[] {
  const have = new Set(main.map((x) => norm(x.name)));
  const seen = new Set<string>();
  return [
    ...main,
    ...extra.filter((x) => {
      const k = norm(x.name);
      if (have.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  ];
}

/** 다른 브랜드 원가 표 (상품명 열 · 원가 열이 정해진 시트 탭) */
export interface CostTable {
  url: string;
  nameCol: number;
  costCol: number;
  /** 머리글 줄 수 */
  skip: number;
  table: CostRow["table"];
  /** 원가 열이 원이 아닐 때 곱할 값 (예: 위안 단가 × 300) */
  multiplier?: number;
}

/** 표를 차례로 읽어 합침 — 같은 이름은 앞 표 값을 씀 */
export async function loadCostTables(tables: CostTable[]): Promise<CostRow[]> {
  let rows: CostRow[] = [];
  for (const t of tables) {
    const part = parseCsv(await fetchCsv(t.url))
      .slice(t.skip)
      .filter((r) => r[t.nameCol]?.trim() && won(r[t.costCol]) > 0)
      .map((r) => ({ name: r[t.nameCol].trim(), cost: Math.round(won(r[t.costCol]) * (t.multiplier ?? 1)), table: t.table }));
    rows = withSupplement(rows, part);
  }
  return rows;
}

export async function fetchCsv(url: string): Promise<string> {
  const r = await fetch(`${url}&_t=${Date.now()}`);
  if (!r.ok) throw new Error(`원가 시트 ${r.status}`);
  return r.text();
}

export async function loadCostRows(
  url = process.env.ABLY_COST_SHEET_CSV ?? DEFAULT_COST_SHEET_CSV,
  productListUrl = process.env.COST_PRODUCT_LIST_CSV ?? PRODUCT_LIST_CSV,
  /** 보충 탭을 못 읽으면 실패 — 공홈 실시간 수집기는 지난 보고서를 "원가 미확인"으로 덮지 않게 */
  strict = false,
): Promise<CostRow[]> {
  const main = costRowsFromCsv(await fetchCsv(url));
  if (!productListUrl) return main;
  // (에이블리 보고서는) 보충 탭을 못 읽어도 첫 탭만으로 보고서는 만든다
  const extra = await fetchCsv(productListUrl).then(productListRowsFromCsv).catch((e: Error) => {
    if (strict) throw new Error(`원가 Product List 탭을 못 읽음: ${e.message}`);
    console.warn(`[원가] Product List 탭을 못 읽어 첫 탭만 씀: ${e.message}`);
    return [] as CostRow[];
  });
  return withSupplement(main, extra);
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
    // 일치 단어가 많을수록, 안 맞는 단어가 적을수록 우선. 동점이면 A표 → B표 → Product List 순.
    const score = 2 + matched * 10 - unmatched;
    if (!best || score > best.score || (score === best.score && TABLE_RANK[row.table] < TABLE_RANK[best.row.table])) {
      best = { row, score, matched, unmatched };
    }
  }
  if (!best) return { cost_unit: null, cost_name: null, cost_match: "none" };
  // 색상/사이즈 행이 따로 있는데 하나도 안 맞아 기본 행을 쓴 경우는 "base"
  const exact = best.unmatched === 0 && (best.matched > 0 || variants === 0);
  return { cost_unit: best.row.cost, cost_name: best.row.name, cost_match: exact ? "exact" : "base" };
}
