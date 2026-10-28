/**
 * 공홈 보고서 브랜드 설정 — src/home-daily.ts(하루치 · 받아 둔 파일) 와 src/home-live.ts(30분마다 실시간) 가 같이 쓴다.
 * id 는 오피스 BRAND_SECTIONS 와 같게 (전략팀 공홈 카드가 brightbeed-reports 의 home/{id} 를 읽음).
 */
import { fetchCsv, loadCostRows, loadCostTables, matchCost, parseCsv, type CostMatch, type CostRow, type CostTable } from "./ably-cost.js";
import { costBook, matchCostV2, type CostBookOptions } from "./cost-match.js";
import { OFFICE_RAW } from "./home-ad.js";

// 결제수수료 추정 — 실제 요율 확인 전 가정값 (식스샵 자체 결제 · 네이버페이 주문형 따로)
export const FEE_RATE = Number(process.env.HOME_FEE_RATE ?? 0.035);
export const NAVER_FEE_RATE = Number(process.env.HOME_NAVERPAY_FEE_RATE ?? 0.035);
export const SHIPPING_COST = Number(process.env.HOME_SHIPPING_COST ?? 2200);
// 1688 위안 단가 → 원. 아페티 · 코즈미 MD팀 시트(공급가 = ￥ × 300)와 같은 가정 — 실제 구매대행 입금은 ￥ × 약 245~250 + 국제배송 · 통관
export const CNY_KRW = Number(process.env.HOME_CNY_KRW ?? 300);

export type CostMatcher = (goodsName: string, goodsCode: string, option: string) => CostMatch;

export interface HomeBrand {
  name: string;
  credEnvSuffix: string;
  /** 식스샵 프로 상점 이름 (store.sixshop.com/{proStore}) */
  proStore: string;
  /** 이 날짜부터 프로 데이터에 자사몰 + 네이버페이 주문형이 다 있음 — 실시간 수집기는 그 전 날짜를 절대 덮어쓰지 않는다 */
  liveSince: string;
  costBasis: string;
  loadCosts: () => Promise<CostRow[]>;
  /** 있으면 옵션을 읽는 원가 매칭 2판(src/cost-match.ts) — 묶음 · 선택형 상품이 많은 브랜드 */
  costMatch?: CostBookOptions;
  /** 원가 시트가 아직 없음 — 보고서를 "원가 미반영"으로 */
  noCostSheet?: boolean;
  /** 시트 이름으로는 못 찾는 브랜드 — 원가 찾기를 직접 만든다 (프로덕트피알) */
  makeMatcher?: () => Promise<CostMatcher>;
  /** 주문 한 줄(수량 1)에 든 상품 개수 — "[1+1]" 은 2 (아코이하우스) */
  unitsPerLine?: (goodsName: string) => number;
}

// MD팀 구글시트(링크 공개)의 원가 표: 탭 gid · 상품명 열 · 원가(원) 열 (0부터 센 번호) · 머리글 줄 수. 앞 탭이 우선.
interface SheetTab { gid: string; nameCol: number; costCol: number; skip: number }
const sheetTables = (id: string, tabs: SheetTab[]): CostTable[] =>
  tabs.map((t, i) => ({
    url: `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${t.gid}`,
    nameCol: t.nameCol, costCol: t.costCol, skip: t.skip, table: (["A", "B", "P"] as const)[Math.min(i, 2)],
  }));
// 아페티 · 코즈미 시트는 E열이 위안(￥), F열 "공급가"(원) = ￥ × 300 이 원가 (2026-10 전 행 확인)
const APETI_SHEET = "1u6u15dxSUthAYKxqjYH8zLSdOAeWAiFtM24dVYZwOS0";
const APETI_COSTS: SheetTab[] = [
  { gid: "1838386820", nameCol: 2, costCol: 5, skip: 1 }, // Product List — 기준 표
  { gid: "390277054", nameCol: 2, costCol: 5, skip: 1 }, // 공홈 가격 수정 표 — 공홈 SET 줄 · "(재등록)" 없는 이름 보충
  { gid: "141680769", nameCol: 2, costCol: 5, skip: 1 }, // 플랫폼 세트 — con ring 등 보충 (ORION 값이 한 칸씩 밀려 있어 맨 뒤)
];
const KOZMI_SHEET = "1TS-HqffOap11AdGwiffMr38KwHAUq1fmcjmmBPdKLMU";
const KOZMI_COSTS: SheetTab[] = [
  { gid: "1819637012", nameCol: 2, costCol: 5, skip: 1 }, // Product List
  { gid: "59467872", nameCol: 0, costCol: 1, skip: 1 }, // 50%할인이벤트 — A 상품명 · B 공급가 ("drop set" 보충)
];
// 아페티 공홈 옵션 · SET 표기 → 시트 이름 (2026-09 ~ 10 주문에 실제로 나온 표기). 새 표기가 나오면 보고서에 "미확인"으로 뜸
const APETI_ALIASES: CostBookOptions["aliases"] = [
  [/baby\s*-?\s*a\s*\+\s*b/i, "Baby ring-A + Baby ring-B"],
  [/baby\s*-\s*a\b/i, "Baby ring-A"],
  [/baby\s*-\s*b\b/i, "Baby ring-B"],
  [/hide\s*\+\s*big\s*star\s*set/i, "hide star ring + BIG star ring"],
  [/hide\s*star\s*\+\s*big\s*star\s*ring/i, "hide star ring + BIG star ring"],
  [/big\s*star\s*\+\s*hide\s*star\s*ring/i, "BIG star ring + hide star ring"],
  [/white\s*heart\s*\+\s*heart\s*ring\s*set/i, "White heart ring + heart ring"],
  [/luna\s*\+\s*line\s*ring\s*set/i, "Luna line ring (Luna) + Luna line ring (Line)"],
  [/^\s*line\s*ring\s*$/i, "Luna line ring (Line)"],
  [/lily\s*\+\s*vine\s*ring\s*set/i, "Lily vine ring (lily) + Lily vine ring (vine)"],
  [/^\s*vine\s*ring\s*$/i, "Lily vine ring (vine)"],
  [/small\s*queen\s*\+\s*big\s*queen\s*ring/i, "Small queen ring + Big queen ring"],
  [/^\s*queen\s*ring\s*set\s*$/i, "Small queen ring + Big queen ring"],
  [/nova\s*star\s*set/i, "Nova star ring-A + Nova star ring-B"],
  [/nova\s*star\s*-\s*([ab])/i, "Nova star ring-$1"],
  [/^\s*orion\s*set\s*$/i, "ORION- A + ORION - B + ORION - C"],
  [/^\s*oreo\s*set\s*$/i, "OREO - A + OREO - B"],
  [/eo-a\s*oreo-b/i, "OREO - A + OREO - B"],
  [/doraemi\s*-?\s*set/i, "DORAEMI 1 + DORAEMI 2 + DORAEMI 3"],
  [/^\s*o\s*&\s*loof\s*necklace\s*$/i, "N - O & Loof"],
  [/^\s*o\s*necklace\s*$/i, "N - O"],
];
// Bold ORION ring: "TYPE: White/Matt ORION ring" + "TYPE: A · B · C · A+B+C" 두 칸을 합쳐 시트 이름으로
const apetiSpecial = (goodsName: string, option: string): string[] | null => {
  if (!/bold\s*orion/i.test(goodsName)) return null;
  const color = /matt/i.test(option) ? "Matt" : /white/i.test(option) ? "White" : null;
  const one = option.match(/TYPE:\s*([ABC])\s*$/i)?.[1];
  const letters = /a\s*\+\s*b\s*\+\s*c/i.test(option) ? ["A", "B", "C"] : one ? [one.toUpperCase()] : [];
  return color && letters.length ? letters.map((l) => `${color} ORION - ${l}`) : null;
};

// 발주 리스트(사장님 마스터 상품 리스트, 링크 공개) — 브랜드별 탭: A열 상품 링크 · C열 한글옵션명 · D열 1688옵션명 · E열 1688 단가(￥). 원 단위 열 없음
const ORDER_LIST_SHEET = "1enzaVYWZF7MRYnFTdtfajwvogvk4I7EgZ54Gr1d40uI";
const orderListUrl = (gid: string) => `https://docs.google.com/spreadsheets/d/${ORDER_LIST_SHEET}/gviz/tq?tqx=out:csv&gid=${gid}`;

/* 클리어타입: 시트 C열이 "Fenghuang" · "ThreadDuo" 같은 짧은 이름 — 공홈 이름에서 따옴표 · "925 Open Ring" · "Necklace" 를 떼고 그대로 찾음.
   ("4s" 925 Open Ring · GAO · HALIFAX · 도시 이름 목걸이는 시트에 없어 미확인 — 2026-10 기준) */
const CT_ALIASES: Record<string, string> = { sprialhine: "Spiralhine" }; // 공홈 오타
const ctSpecial = (goodsName: string): string[] => {
  const bare = goodsName.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC")
    .replace(/["“”]/g, "").replace(/\s*925\s*op(?:en|ne)\s*ring\s*$/i, "").replace(/\s*necklace\s*$/i, "").trim();
  return [CT_ALIASES[bare.toLowerCase()] ?? bare];
};

/* 프로덕트피알: 시트 C열이 한글 내부명(180도 케이블 · 포니 파우치 …)이라 공홈 상품 → 시트 행 대응표로 찾음 (2026-08 ~ 10 주문으로 맞춤).
   색상 줄은 C열 · E열이 비어 있어 위 줄 값을 이어 씀. 180도 케이블 · 포인원은 D열(C-C / U-C / U-8 · 길이)마다 단가가 다름.
   대응표에 없는 상품(Jacquard 케이블 · Flower Keychain · Ball hanger 등 — 시트에 없음)은 미확인. 새 상품은 여기에 추가 */
interface PpRow { name: string; opt: string; cny: number }
type PpPick = { name: string; opt?: RegExp; guess?: boolean } | null;
const PP_MAP: [RegExp, (option: string) => PpPick][] = [
  [/180°?\s*fast\s*charging\s*cable/i, (o) => {
    const v = /c\s*type\s*->\s*c\s*type/i.test(o) ? "C-C" : /usb\s*->\s*c\s*type/i.test(o) ? "U-C" : /usb\s*->\s*(apple|8\s*pin)/i.test(o) ? "U-8" : null;
    return v ? { name: "180도 케이블", opt: new RegExp(`^${v}$`) } : null;
  }],
  // 기존 · 신규 포인원 중 어느 쪽인지 확인 전 — 6색이 2026-05 신규 발주와 같아 신규로 (기본값 표시)
  [/4\s*in\s*1\s*fast\s*charging\s*cable/i, (o) => ({ name: "신규 포인원", opt: /1\.5/.test(o) ? /^1\.5$/ : /^2$/, guess: true })],
  [/poni\s*mesh\s*pouch/i, () => ({ name: "포니 파우치" })],
  [/padded\s*color\s*pouch/i, () => ({ name: "패딩 파우치 옐로우" })],
  [/compact\s*phone\s*stand/i, () => ({ name: "휴대폰 거치대 레드" })], // 裸装 0.55 — 색상 무관
  [/360°?\s*rotating\s*phone\s*holder/i, (o) =>
    /블랙|black/i.test(o) ? { name: "휴대폰 거치대 블랙", opt: /旋转/ } : /화이트|white/i.test(o) ? { name: "휴대폰 거치대 화이트", opt: /旋转/ } : { name: "휴대폰 거치대 실버" }],
  [/pixel\s*mini\s*handle\s*pouch/i, () => ({ name: "픽셀 파우치" })],
  [/traveler\s*pouch/i, () => ({ name: "트레블 파우치 퍼플" })],
  [/curve\s*toilet\s*mini\s*brush/i, () => ({ name: "변기솔" })],
  [/character\s*snack\s*clip/i, () => ({ name: "과자집게 아이보리" })],
  [/freestanding\s*holder/i, () => ({ name: "프리스탠딩 홀더" })],
  [/w(?:i|ri|ir)st\s*rest\s*mouse\s*pad/i, () => ({ name: "마우스패드" })], // 공홈 표기 "Wirst"
  [/soft\s*silicone\s*carry\s*pouch/i, () => ({ name: "실리콘 파우치" })],
  // 추정 대응 (확인 전 — 기본값 표시)
  [/cloud\s*grip\s*glass\s*mini\s*brush/i, () => ({ name: "거울닦이", guess: true })],
  [/basic\s*to(?:il|li)e?t\s*slippers/i, () => ({ name: "신규 슬리퍼", guess: true })], // 공홈 표기 "Toliet"
];
const space1 = (x: string) => x.replace(/\s+/g, " ").trim();
async function loadPpRows(gid: string): Promise<PpRow[]> {
  const out: PpRow[] = [];
  let name = "";
  let cny = 0;
  for (const r of parseCsv(await fetchCsv(orderListUrl(gid))).slice(1)) {
    const link = (r[0] ?? "").trim();
    const n = space1(r[2] ?? "");
    const opt = space1(r[3] ?? "");
    const c = Number(String(r[4] ?? "").replace(/[^0-9.]/g, "")) || 0;
    if (!n && !opt && !c) continue;
    if (n) name = n;
    // 단가가 빈 줄 = 위 상품의 색상 · 옵션 줄 (상품 링크가 있는 줄은 새 상품이라 이어 쓰지 않음)
    if (c) cny = c;
    else if (link) cny = 0;
    if (cny > 0) out.push({ name, opt, cny });
  }
  return out;
}
async function makePpMatcher(): Promise<CostMatcher> {
  const rows = await loadPpRows("869295271");
  if (!rows.length) throw new Error("발주 리스트 · 프로덕트피알 제품 리스트 탭에 단가가 없어요");
  return (goodsName, _code, option) => {
    const hit = PP_MAP.find(([re]) => re.test(goodsName));
    const pick = hit ? hit[1](option ?? "") : null;
    const row = pick ? rows.find((r) => r.name === pick.name && (!pick.opt || pick.opt.test(r.opt))) : undefined;
    if (!pick || !row) return { cost_unit: null, cost_name: null, cost_match: "none" };
    return { cost_unit: Math.round(row.cny * CNY_KRW), cost_name: `${row.name}${row.opt ? ` (${row.opt})` : ""} ￥${row.cny}`, cost_match: pick.guess ? "base" : "exact" };
  };
}

/* 아코이하우스: 오피스 아코이 기획전 계산기 상품 원가 (beaduniverse data/promo-akoi.json items[].name · costKrw — 룩북 시트 "생산 단가"와 같음) */
async function loadOfficePromoCosts(brand: string): Promise<CostRow[]> {
  const r = await fetch(`${OFFICE_RAW}/data/promo-${brand}.json?_t=${Date.now()}`);
  if (!r.ok) throw new Error(`오피스 기획전 계산기 원가 data/promo-${brand}.json ${r.status}`);
  const items = ((await r.json()) as { data?: { items?: { name?: string; costKrw?: number }[] } }).data?.items ?? [];
  const rows = items
    .filter((x) => x.name?.trim() && (x.costKrw ?? 0) > 0)
    .map((x) => ({ name: x.name!.trim(), cost: Math.round(x.costKrw!), table: "A" as const }));
  if (!rows.length) throw new Error(`data/promo-${brand}.json 에 원가가 없어요`);
  return rows;
}

export const HOME_BRANDS: Record<string, HomeBrand> = {
  kop: {
    name: "코페리", credEnvSuffix: "_KOP", proStore: "coferry", liveSince: "2026-10-20",
    costBasis: "MD팀 코페리 시트 — 첫 탭(C·E · P·Q열) → Product List 탭 보충, 상품명·옵션으로 매칭",
    loadCosts: () => loadCostRows(undefined, undefined, true),
  },
  apt: {
    name: "아페티", credEnvSuffix: "_APT", proStore: "apeti", liveSince: "2026-10-22",
    costBasis: "MD팀 아페티 시트 — Product List → 공홈 가격 수정 표 → 플랫폼 세트 F열(공급가), 옵션에 고른 반지·목걸이까지 읽어 매칭",
    loadCosts: () => loadCostTables(sheetTables(APETI_SHEET, APETI_COSTS)),
    costMatch: { aliases: APETI_ALIASES, special: apetiSpecial },
  },
  koz: {
    name: "코즈미", credEnvSuffix: "_KOZ", proStore: "cos-mi", liveSince: "2026-09-03",
    costBasis: "MD팀 코즈미 시트 — Product List F열(공급가) → 50%할인이벤트 B열 보충, 옵션에 고른 상품까지 읽어 매칭",
    loadCosts: () => loadCostTables(sheetTables(KOZMI_SHEET, KOZMI_COSTS)),
    costMatch: {},
  },
  // 아래 셋은 처음부터 식스샵 프로 (자사몰 + 네이버페이 주문형, 2026-08-21 부터 확인). 광고 시트가 없어 광고비는 메타 데이터 추정만.
  pp: {
    name: "프로덕트피알", credEnvSuffix: "_PP", proStore: "produktepr", liveSince: "2026-08-23",
    costBasis: `발주 리스트 시트 · 프로덕트피알 제품 리스트 E열(1688 단가 위안) × ${CNY_KRW} 가정, 공홈 상품 → 한글 내부명 대응표 (확인 전 대응은 기본값)`,
    loadCosts: async () => [],
    makeMatcher: makePpMatcher,
  },
  akoi: {
    name: "아코이하우스", credEnvSuffix: "_AKOI", proStore: "akoihaus1", liveSince: "2026-08-23",
    costBasis: "오피스 아코이 기획전 계산기 원가(data/promo-akoi.json — 룩북 시트 생산 단가와 같음), [1+1] 은 두 켤레",
    loadCosts: () => loadOfficePromoCosts("akoi"),
    unitsPerLine: (goodsName) => (/^\s*\[\s*1\s*\+\s*1\s*\]/.test(goodsName) ? 2 : 1),
  },
  ct: {
    name: "클리어타입", credEnvSuffix: "_CT", proStore: "cleartype1", liveSince: "2026-08-23",
    costBasis: `발주 리스트 시트 · 클리어타입 제품 리스트 E열(1688 단가 위안) × ${CNY_KRW} 가정, 상품명(따옴표 · 925 Open Ring · Necklace 뗌)으로 매칭`,
    loadCosts: () => loadCostTables([{ url: orderListUrl("979624320"), nameCol: 2, costCol: 4, skip: 1, table: "A", multiplier: CNY_KRW }]),
    costMatch: { special: ctSpecial },
  },
};

/** 브랜드에 맞는 원가 찾기 — 시트를 읽어 한 번 색인해 둔다 (2판 · 직접 만든 찾기 · [1+1] 배수) */
export async function loadCostMatcher(cfg: HomeBrand): Promise<{ rows: CostRow[]; matcher: CostMatcher }> {
  let rows: CostRow[] = [];
  let base: CostMatcher;
  if (cfg.makeMatcher) {
    base = await cfg.makeMatcher();
  } else {
    rows = await cfg.loadCosts();
    if (cfg.costMatch) {
      const book = costBook(rows, cfg.costMatch);
      base = (name, code, option) => matchCostV2(book, name, code, option);
    } else {
      base = (name, code, option) => matchCost(rows, name, code, option);
    }
  }
  const units = cfg.unitsPerLine;
  const matcher: CostMatcher = !units ? base : (name, code, option) => {
    const m = base(name, code, option);
    const k = units(name);
    return k === 1 || m.cost_unit == null ? m : { ...m, cost_unit: m.cost_unit * k, cost_name: `${m.cost_name} × ${k}` };
  };
  return { rows, matcher };
}
