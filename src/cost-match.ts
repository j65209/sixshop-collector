/**
 * 원가 매칭 2판 — 공홈(식스샵 프로) 아페티 · 코즈미용. 코페리 · 에이블리는 src/ably-cost.ts matchCost 그대로.
 *
 * 두 브랜드 공홈은 상품 하나에 옵션으로 실제 상품을 고르는 묶음 · 선택형이 많다:
 *   "Twinkle ring | 구매형식: 2개 구매 | Ring: Layer ring | 추가 Ring: Rose ring"  → Layer ring + Rose ring
 *   "Drop Ring SET | 구매 형식: 1+1 / Drop ring: Star Drop Ring / 추가 Drop ring: Bubble Drop Ring" → 두 반지 합
 *   "Link Necklace | Necklace: Eve Necklace" → 실제로 나간 건 Eve (판매가도 Eve 가격)
 * 찾는 순서:
 *   ① 브랜드 특례(special)  ② 옵션 "키: 값" 의 값에 적힌 시트 상품(들)의 합 — "구매 형식: 단품"이면 첫 상품만, "없음"은 건너뜀
 *   ③ "[SET] A + B" 상품명  ④ 상품명 = 시트 이름
 *   ⑤ 기존 방식(앞 두 단어 키 + 나머지 단어로 색상 · 사이즈 고르기)인데 단어 경계를 지킴 ("heart ring" 이 "art ring" 으로 안 잡힘),
 *      한 단어 이름(R-08) · 한글 색상(-블랙) · 번호 범위(2-6)도 봄. 동점이면 긴 키 → 앞 표.
 * 시트 이름의 "(재등록)" 은 지우고 비교. 2026-10 주문으로 잰 결과는 docs/HOME-DAILY.md "원가" 절.
 */
import type { CostMatch, CostRow } from "./ably-cost.js";

/** 옵션 · SET 표기 → 시트 이름 ("A + B" 는 두 상품의 합) */
export type CostAlias = [RegExp, string];

export interface CostBookOptions {
  aliases?: CostAlias[];
  /** 브랜드 특례 — 시트 이름 목록을 돌려주면 그 합을 씀 */
  special?: (goodsName: string, option: string) => string[] | null;
}

interface BookRow extends CostRow {
  words: string[];
}

export interface CostBook {
  rows: BookRow[];
  /** 정규화 이름 → 행 (짧은 이름 포함, 앞 표 우선) — 별칭 · 특례 결과 찾기용 */
  all: Map<string, BookRow>;
  /** 값 전체가 시트 이름과 같은지 ("… set" 은 "… necklace" · "… ring" · 없음 으로도) */
  equal: Map<string, BookRow>;
  /** 옵션 값 안에서 찾을 시트 이름 — 긴 것부터 */
  keys: string[];
  opts: CostBookOptions;
}

const KO_COLOR: Record<string, string> = {
  블랙: "black", 화이트: "white", 퍼플: "purple", 그린: "green", 핑크: "pink", 블루: "blue", 레드: "red", 민트: "mint",
  실버: "silver", 골드: "gold", 아이보리: "ivory", 브라운: "brown", 네이비: "navy", 베이지: "beige", 그레이: "gray", 옐로우: "yellow",
};
const KO_COLOR_RE = new RegExp(Object.keys(KO_COLOR).join("|"), "g");
const SYNONYM: Record<string, string> = { bl: "black", bk: "black", blk: "black", w: "white", wh: "white", iv: "ivory", br: "brown", grey: "gray" };
// 이름 하나만으로는 상품이라 할 수 없는 줄 ("set" 4,017원 · "1+1 …")
const GENERIC = /^(set|11.*)$/;

const norm = (s: string) => s.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
const clean = (s: string) => s.replace(/\(재등록\)/g, "").trim();

/** 단어로 나눔 — 숫자 범위 "2-6" 은 "~2-6", "Necklace-블랙" 은 한글 앞에서 나눠 black */
export function costWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[()\[\]/,&+|:]/g, " ")
    .split(/\s+/)
    .flatMap((t) => (/^\d+-\d+$/.test(t) ? [`~${t}`] : t.split(/-(?=[가-힣])/)))
    .map((t) => (t.startsWith("~") ? t : norm(t.replace(KO_COLOR_RE, (m) => KO_COLOR[m]))))
    .filter(Boolean)
    .map((t) => SYNONYM[t] ?? t);
}
const keyOf = (s: string) => costWords(clean(s)).join("");

const TABLE_RANK: Record<CostRow["table"], number> = { A: 0, B: 1, P: 2 };

export function costBook(rows: CostRow[], opts: CostBookOptions = {}): CostBook {
  const book: CostBook = { rows: [], all: new Map(), equal: new Map(), keys: [], opts };
  for (const r of rows) {
    const row: BookRow = { ...r, words: costWords(clean(r.name)) };
    book.rows.push(row);
    const k = row.words.join("");
    if (!k || book.all.has(k)) continue;
    book.all.set(k, row);
    if (GENERIC.test(k)) continue;
    book.equal.set(k, row);
    if (k.length >= 3) book.keys.push(k);
  }
  // "Planet + Lumi set" = 옵션 "Planet + Lumi Necklace"
  for (const [k, row] of [...book.equal]) {
    if (!k.endsWith("set") || k.length <= 3) continue;
    const base = k.slice(0, -3);
    for (const v of [base, `${base}necklace`, `${base}ring`]) if (!book.equal.has(v)) book.equal.set(v, row);
  }
  book.keys.sort((a, b) => b.length - a.length);
  return book;
}

/** 단어 경계(앞 · 뒤)에 걸리는 위치들 */
function boundaries(words: string[]) {
  const starts = new Set<number>();
  const ends = new Set<number>();
  let pos = 0;
  for (const t of words) {
    starts.add(pos);
    pos += t.length;
    ends.add(pos);
  }
  return { hay: words.join(""), starts, ends };
}

/** 글 한 덩어리(옵션 값 · SET 상품명)에 적힌 시트 상품들 — 별칭 → 값 전체 일치 → 긴 이름부터 겹치지 않게 */
function scan(book: CostBook, text: string): BookRow[] {
  let v = text;
  for (const [re, rep] of book.opts.aliases ?? []) {
    if (!re.test(v)) continue;
    v = v.replace(re, rep);
    const named = v.split(/\s\+\s/).map((p) => book.all.get(keyOf(p)));
    if (named.every(Boolean)) return named as BookRow[];
    break;
  }
  const whole = book.equal.get(keyOf(v));
  if (whole) return [whole];
  const { hay, starts, ends } = boundaries(costWords(v));
  const used = new Array<boolean>(hay.length).fill(false);
  const got: BookRow[] = [];
  for (const k of book.keys) {
    for (let i = hay.indexOf(k); i >= 0; i = hay.indexOf(k, i + 1)) {
      if (!starts.has(i) || !ends.has(i + k.length) || used.slice(i, i + k.length).some(Boolean)) continue;
      used.fill(true, i, i + k.length);
      got.push(book.all.get(k)!);
    }
  }
  if (got.length === 1 && /1\s*\+\s*1/.test(v)) got.push(got[0]); // "Ripple ring 1+1"
  return got;
}

/** 옵션 "키: 값" 들에 적힌 실제 상품(들). 못 읽으면 null */
function fromOption(book: CostBook, option: string): BookRow[] | null {
  if (!option) return null;
  const got: BookRow[] = [];
  let single = false; // "구매 형식: 단품" — 추가 상품을 골라도 단품 가격 그대로라 첫 상품만
  for (const seg of option.split(/\s+[\/|]\s+/)) {
    const m = seg.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    if (/구매\s*형식/.test(m[1])) {
      single = /단품/.test(m[2]);
      continue;
    }
    const value = m[2].trim();
    if (!value || /없음/.test(value)) continue;
    got.push(...scan(book, value));
    if (single && got.length) break;
  }
  return got.length ? got : null;
}

/** "[SET] R-07 + R-08" 같은 SET 상품명 (두 개 이상 읽혀야 인정) */
function fromSetName(book: CostBook, goodsName: string): BookRow[] | null {
  if (!/^\s*\[(\d\s*)?set\]/i.test(goodsName)) return null;
  const got = scan(book, goodsName.replace(/^\s*\[[^\]]*\]\s*/, ""));
  return got.length >= 2 ? got : null;
}

function fromSpecial(book: CostBook, goodsName: string, option: string): BookRow[] | null {
  const names = book.opts.special?.(goodsName, option);
  if (!names?.length) return null;
  const rows = names.map((n) => book.all.get(keyOf(n)));
  return rows.every(Boolean) ? (rows as BookRow[]) : null;
}

const sumOf = (rows: BookRow[]): CostMatch => ({
  cost_unit: rows.reduce((s, r) => s + r.cost, 0),
  cost_name: rows.map((r) => clean(r.name)).join(" + "),
  cost_match: "exact",
});

export function matchCostV2(book: CostBook, goodsName: string, goodsCode: string, option: string): CostMatch {
  const bundle = fromSpecial(book, goodsName, option) ?? fromOption(book, option) ?? fromSetName(book, goodsName);
  if (bundle) return sumOf(bundle);
  const same = book.equal.get(keyOf(goodsName));
  if (same) return sumOf([same]);

  const { hay, starts, ends } = boundaries(costWords(`${goodsName} ${goodsCode}`));
  const at = (key: string) => {
    for (let i = hay.indexOf(key); i >= 0; i = hay.indexOf(key, i + 1)) if (starts.has(i) && ends.has(i + key.length)) return true;
    return false;
  };
  const hayWords = new Set(costWords(`${goodsName} ${goodsCode} ${option}`));
  const hit = (w: string) => {
    if (!w.startsWith("~")) return hayWords.has(w);
    const [a, b] = w.slice(1).split("-").map(Number);
    return [...hayWords].some((h) => /^\d+$/.test(h) && Number(h) >= a && Number(h) <= b);
  };
  let best: { row: BookRow; score: number; matched: number; unmatched: number; klen: number } | null = null;
  let variants = 0;
  for (const row of book.rows) {
    const t = row.words;
    const n = t.length >= 2 && !t[1].startsWith("~") ? 2 : /^[a-z]+\d+$/.test(t[0] ?? "") ? 1 : 0;
    const key = t.slice(0, n).join("");
    if (!n || !at(key)) continue;
    const rest = t.slice(n);
    if (rest.length) variants++;
    const matched = rest.filter(hit).length;
    const unmatched = rest.length - matched;
    const score = 2 + matched * 10 - unmatched;
    if (
      !best || score > best.score ||
      (score === best.score && (key.length > best.klen || (key.length === best.klen && TABLE_RANK[row.table] < TABLE_RANK[best.row.table])))
    ) {
      best = { row, score, matched, unmatched, klen: key.length };
    }
  }
  if (!best) return { cost_unit: null, cost_name: null, cost_match: "none" };
  const exact = best.unmatched === 0 && (best.matched > 0 || variants === 0);
  return { cost_unit: best.row.cost, cost_name: clean(best.row.name), cost_match: exact ? "exact" : "base" };
}
