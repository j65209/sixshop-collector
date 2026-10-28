/**
 * 공홈(식스샵) 일일 보고서 수집기 — 에이블리 일일 보고서(src/ably-daily.ts)와 같은 양식.
 * 맥미니 자동 설치 관리자가 실행 (mac/jobs/home-daily-<브랜드>.job). 오피스 전략팀 → 공홈 탭이 읽는다.
 *
 * 사용법:
 *   npx tsx src/home-daily.ts kop                              # 어제(KST)
 *   npx tsx src/home-daily.ts kop 2026-10-27                   # 특정 날짜
 *   npx tsx src/home-daily.ts kop 2026-10-27 --dry             # 수집·계산만, 기록 안 함
 *   npx tsx src/home-daily.ts kop 2026-10-05 --xlsx 주문.xlsx   # 받아 둔 주문 엑셀로 계산만 (로그인·기록 안 함)
 *   (--xlsx 는 여러 번 줄 수 있음 — 엑셀이 1,000건씩 끊겨 있을 때 합쳐서 지난 기간 채우기.
 *    --out 파일.json 을 붙이면 만든 보고서를 파일로도 저장)
 *
 * 하는 일:
 *   1. 식스샵 관리자 로그인 → 주문 엑셀(상품별로 행 나누기 · 상태 전체 · 최근 주문부터) — ERP 와 같은 방식(src/sixshop.ts)
 *   2. 그날 주문만 · 취소/반품/입금 대기 제외 → 계산은 src/home-report.ts
 *   3. 원가: MD팀 코페리 구글시트(src/ably-cost.ts) · 광고비: 오피스 광고 시트(beaduniverse data/ad-sheets/{브랜드}.json)
 *   4. 비공개 레포 brightbeed-reports 의 home/{브랜드}/daily/{date}.json · home/{브랜드}/index.json (src/reports-repo.ts)
 * 구매자 이름·연락처·주소·메모는 어디에도 저장하지 않는다.
 *
 * env: SIXSHOP_EMAIL_<브랜드> · SIXSHOP_PASSWORD_<브랜드> (예: SIXSHOP_EMAIL_KOP) · REPORTS_GITHUB_TOKEN
 *      (선택) HOME_FEE_RATE(식스샵 결제, 기본 0.035) · HOME_NAVERPAY_FEE_RATE(네이버페이 주문형, 기본 0.035)
 *             HOME_SHIPPING_COST(주문당 택배비, 기본 2200) · REPORTS_REPO
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { read, utils } from "xlsx";
import type { Brand } from "./brands.js";
import { loadCostRows, loadCostTables, type CostTable, type CostRow } from "./ably-cost.js";
import { costBook, matchCostV2, type CostBookOptions } from "./cost-match.js";
import { buildHomeReport, coversWholeDay, type HomeAd, type XlsxRow } from "./home-report.js";
import { buildProReport, proCoversDay, type ProOrder } from "./home-report-pro.js";
import { REPORTS_REPO, writeDailyReport } from "./reports-repo.js";

const OFFICE_RAW = "https://raw.githubusercontent.com/j65209/beaduniverse/main";
// 결제수수료 추정 — 실제 요율 확인 전 가정값 (식스샵 자체 결제 · 네이버페이 주문형 따로)
const FEE_RATE = Number(process.env.HOME_FEE_RATE ?? 0.035);
const NAVER_FEE_RATE = Number(process.env.HOME_NAVERPAY_FEE_RATE ?? 0.035);
const SHIPPING_COST = Number(process.env.HOME_SHIPPING_COST ?? 2200);

// 공홈 보고서를 만드는 브랜드 — id 는 오피스 BRAND_SECTIONS 와 같게 (전략팀 공홈 카드가 home/{id} 를 읽음).
// proStore: 식스샵 프로 상점 이름(store.sixshop.com/{proStore}) · cost: MD팀 구글시트의 원가 표
interface HomeBrand {
  name: string;
  credEnvSuffix: string;
  proStore: string;
  costBasis: string;
  loadCosts: () => Promise<CostRow[]>;
  /** 있으면 옵션을 읽는 원가 매칭 2판(src/cost-match.ts) — 묶음 · 선택형 상품이 많은 브랜드 */
  costMatch?: CostBookOptions;
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
const HOME_BRANDS: Record<string, HomeBrand> = {
  kop: {
    name: "코페리", credEnvSuffix: "_KOP", proStore: "coferry",
    costBasis: "MD팀 코페리 시트 — 첫 탭(C·E · P·Q열) → Product List 탭 보충, 상품명·옵션으로 매칭",
    loadCosts: () => loadCostRows(),
  },
  apt: {
    name: "아페티", credEnvSuffix: "_APT", proStore: "apeti",
    costBasis: "MD팀 아페티 시트 — Product List → 공홈 가격 수정 표 → 플랫폼 세트 F열(공급가), 옵션에 고른 반지·목걸이까지 읽어 매칭",
    loadCosts: () => loadCostTables(sheetTables(APETI_SHEET, APETI_COSTS)),
    costMatch: { aliases: APETI_ALIASES, special: apetiSpecial },
  },
  koz: {
    name: "코즈미", credEnvSuffix: "_KOZ", proStore: "cos-mi",
    costBasis: "MD팀 코즈미 시트 — Product List F열(공급가) → 50%할인이벤트 B열 보충, 옵션에 고른 상품까지 읽어 매칭",
    loadCosts: () => loadCostTables(sheetTables(KOZMI_SHEET, KOZMI_COSTS)),
    costMatch: {},
  },
};

function yesterdayKst(): string {
  return new Date(Date.now() + 9 * 3600_000 - 24 * 3600_000).toISOString().slice(0, 10);
}

/* ---------------- 주문 엑셀 ---------------- */

function readXlsx(path: string): XlsxRow[] {
  const wb = read(readFileSync(path));
  return utils.sheet_to_json<XlsxRow>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

/** 여러 엑셀을 합침 (지난 기간 채우기용) — 같은 주문번호가 여러 파일에 있으면 뒤에 준 파일 것을 씀 */
function readXlsxFiles(paths: string[]): XlsxRow[] {
  const byOrder = new Map<string, XlsxRow[]>();
  for (const p of paths) {
    const fileOrders = new Map<string, XlsxRow[]>();
    for (const r of readXlsx(p)) {
      const k = String(r["주문번호"] ?? "");
      if (!fileOrders.has(k)) fileOrders.set(k, []);
      fileOrders.get(k)!.push(r);
    }
    for (const [k, rs] of fileOrders) byOrder.set(k, rs);
  }
  return [...byOrder.values()].flat();
}

/** 식스샵 프로 주문 JSON 여러 개를 합침 (같은 주문번호는 뒤 파일 것) — 그날이 어느 파일 기간 안에 있는지도 확인 */
function readProFiles(paths: string[], date: string): { orders: ProOrder[]; covered: boolean } {
  const byId = new Map<string, ProOrder>();
  let covered = false;
  for (const p of paths) {
    const j = JSON.parse(readFileSync(p, "utf8")) as { from: string; to: string; orders: ProOrder[] };
    if (proCoversDay(j.from, j.to, date)) covered = true;
    for (const o of j.orders) byId.set(o.id, o);
  }
  return { orders: [...byId.values()], covered };
}

async function fetchRows(brandId: string, cfg: HomeBrand): Promise<XlsxRow[]> {
  if (cfg.proStore) {
    throw new Error(`${cfg.name}은 식스샵 프로 상점이라 일반 식스샵 엑셀로 못 받아요 — 식스샵 프로 실시간 수집은 준비 중 (--pro-json 으로 받아 둔 주문 사용)`);
  }
  // playwright 는 실제 수집 때만 불러옴 (--xlsx 시험은 브라우저 없이)
  const { newBrowser, newBrandPage, loginAsBrand, fetchOrdersForBrand } = await import("./sixshop.js");
  const brand: Brand = {
    siteLink: brandId, displayName: cfg.name, memberNo: 0,
    ordersSheetName: "", stockSheetName: "", stateSheetName: "", includeStatuses: [],
    credEnvSuffix: cfg.credEnvSuffix, inventoryEnabled: false,
  };
  const browser = await newBrowser();
  try {
    const page = await newBrandPage(browser);
    await loginAsBrand(page, brand);
    const items = await fetchOrdersForBrand(page, brand, { paidOnly: false });
    return items.map((it) => it.raw as XlsxRow);
  } finally {
    await browser.close();
  }
}

/* ---------------- 광고비 (오피스 광고 시트 — 오피스 index.html _adshCalc 와 같은 계산) ---------------- */

interface AdDay { krw?: number; usd?: number; rev?: number; revUsd?: number; fx?: number }

async function fxRate(date: string): Promise<number | null> {
  const r = await fetch(`${OFFICE_RAW}/data/fx-usd.json?_t=${Date.now()}`).catch(() => null);
  if (!r?.ok) return null;
  const rates = ((await r.json()) as { rates?: Record<string, { rate: number }> }).rates ?? {};
  const days = Object.keys(rates).filter((d) => d <= date).sort();
  return days.length ? rates[days[days.length - 1]].rate : null;
}

async function loadAd(brand: string, date: string): Promise<HomeAd> {
  const basis = `오피스 광고 시트 (메타, data/ad-sheets/${brand}.json)`;
  try {
    const r = await fetch(`${OFFICE_RAW}/data/ad-sheets/${brand}.json?_t=${Date.now()}`);
    if (!r.ok) return { spend: null, order_price: null, basis: `${basis} — 못 읽음 (HTTP ${r.status})` };
    const day = ((await r.json()) as { days?: Record<string, AdDay> }).days?.[date];
    if (!day) return { spend: null, order_price: null, basis: `${basis} — ${date} 광고비 미입력` };
    const rate = day.fx ?? (day.usd != null || day.revUsd != null ? await fxRate(date) : null);
    const spend = day.krw ?? (day.usd != null && rate ? day.usd * rate : null);
    const orderPrice = day.rev ?? (day.revUsd != null && rate ? day.revUsd * rate : null);
    return { spend, order_price: orderPrice, basis: spend == null ? `${basis} — ${date} 광고비 미입력` : basis };
  } catch (e) {
    return { spend: null, order_price: null, basis: `${basis} — 못 읽음 (${(e as Error).message})` };
  }
}

/* ---------------- main ---------------- */

async function main(): Promise<void> {
  const pos: string[] = [];
  const xlsxPaths: string[] = [];
  const proPaths: string[] = [];
  let dry = false;
  let outPath: string | null = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--xlsx") xlsxPaths.push(argv[++i] ?? "");
    else if (argv[i] === "--pro-json") proPaths.push(argv[++i] ?? "");
    else if (argv[i] === "--dry") dry = true;
    else if (argv[i] === "--out") outPath = argv[++i] ?? null;
    else pos.push(argv[i]);
  }
  const brandId = pos[0] ?? "";
  const cfg = HOME_BRANDS[brandId];
  if (!cfg) throw new Error(`브랜드를 지정하세요: ${Object.keys(HOME_BRANDS).join(", ")} (예: npx tsx src/home-daily.ts kop)`);
  const date = pos[1] ?? yesterdayKst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`날짜 형식은 YYYY-MM-DD: ${date}`);
  const offline = xlsxPaths.length > 0 || proPaths.length > 0;

  const [costRows, ad] = await Promise.all([cfg.loadCosts(), loadAd(brandId, date)]);
  const book = cfg.costMatch ? costBook(costRows, cfg.costMatch) : null;
  const opts = {
    date, brand: brandId, market: cfg.name, feeRate: FEE_RATE, naverFeeRate: NAVER_FEE_RATE, shippingCost: SHIPPING_COST,
    costRows, costBasis: cfg.costBasis, ad,
    costMatcher: book ? (name: string, code: string, option: string) => matchCostV2(book, name, code, option) : undefined,
  };
  let report;
  if (proPaths.length) {
    // 식스샵 프로 주문 데이터 (관리자 주문 API 를 개인정보 없이 줄인 JSON — docs/HOME-DAILY.md)
    const { orders, covered } = readProFiles(proPaths, date);
    if (!covered) throw new Error(`주문 데이터 파일(${proPaths.join(", ")})의 기간에 ${date} 가 없어요`);
    report = buildProReport(orders, opts);
  } else {
    const rows = xlsxPaths.length ? readXlsxFiles(xlsxPaths) : await fetchRows(brandId, cfg);
    if (!coversWholeDay(rows, date)) {
      throw new Error(`주문 엑셀(${rows.length}행)이 ${date} 하루 전체를 담고 있지 않아요 — 엑셀은 최근 주문부터라 오래된 날짜는 빠질 수 있어요`);
    }
    report = buildHomeReport(rows, opts);
  }
  const s = report.summary;
  const won = (n: number) => n.toLocaleString("ko-KR");
  console.log(
    `[home-daily] ${cfg.name} ${date} 주문 ${s.orders}(네이버페이 ${s.naverpay_orders}) · 실결제 ${won(s.paid)} (배송비 수입 ${won(s.shipping_income)}) · 광고비 ${won(s.ad_spend)} · 원가 ${won(s.cost)} · 순이익 ${won(s.net)} · 원가 미확인 ${s.cost_missing_items}건`,
  );
  if ("missing_columns" in report.assumptions && report.assumptions.missing_columns) {
    console.warn(`[home-daily] 엑셀에 없는 열: ${report.assumptions.missing_columns.join(", ")} — 식스샵 엑셀 양식이 바뀌었는지 확인`);
  }
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`[home-daily] 보고서 파일: ${outPath}`);
  }
  if (offline || dry) {
    console.log("[home-daily] 시험 실행 — 기록하지 않음");
    return;
  }
  await writeDailyReport(`home/${brandId}`, report, `home ${brandId}`);
  console.log(`[home-daily] ${REPORTS_REPO}/home/${brandId}/daily/${date}.json 기록`);
}

main().catch((e) => {
  console.error("[home-daily] 실패:", (e as Error).message);
  process.exit(1);
});
