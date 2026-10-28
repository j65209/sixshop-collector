/**
 * 공홈(식스샵 프로) 실시간 보고서 — 맥미니가 30분마다 실행 (mac/jobs/home-live.job). 오피스 전략팀 → 공홈 탭이 읽는다.
 *   오늘(진행 중) · 어제 보고서를 다시 계산해서 바뀐 것만 brightbeed-reports 에 커밋 하나로 올린다.
 *   하루 한 번(06시 이후 첫 실행)은 지난 8일을 다시 계산 — 늦은 취소 · 환불, 주말에 밀린 광고 시트 입력 반영.
 * 계산은 src/home-report-pro.ts (결제일 기준), 원가 · 광고비 · 브랜드 설정은 src/home-brands.ts · src/home-ad.ts 로
 * 하루치 수집기(src/home-daily.ts)와 똑같다. 규칙: docs/HOME-DAILY.md "실시간" · "식스샵 프로" 절. 시험: tests/home-live.test.ts
 *
 * 사용법:
 *   npm run home-live                     # 오늘 · 어제 (+ 그날 첫 06시 이후 실행이면 지난 8일)
 *   npm run home-live -- --days 8         # 오늘부터 8일
 *   npm run home-live -- --dry            # 계산만 — 기록 · 상태 파일 안 씀
 *   npm run home-live -- --brands kop,apt # 일부 브랜드만
 *
 * env: SIXSHOP_PRO_EMAIL · SIXSHOP_PRO_PASSWORD (식스샵 프로 관리자 — 코페리 · 아페티 · 코즈미가 다 보이는 계정) · REPORTS_GITHUB_TOKEN
 *      (선택) HOME_LIVE_STATE(상태 파일 위치) · HOME_FEE_RATE 등 (src/home-brands.ts)
 * 구매자 이름 · 연락처 · 주소 · 메모 · 작성형 옵션은 어디에도 저장하지 않는다 (src/sixshop-pro-orders.ts slimOrder).
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadAd } from "./home-ad.js";
import { FEE_RATE, loadCostMatcher, HOME_BRANDS, NAVER_FEE_RATE, SHIPPING_COST, type HomeBrand } from "./home-brands.js";
import type { HomeAd } from "./home-report.js";
import { buildProReport, type ProOrder } from "./home-report-pro.js";
import { commitFiles, ghGetJson, indexRowOf, mergeIndexRows, REPORTS_REPO, sameContent, type IndexRow } from "./reports-repo.js";

const DAY = 86400_000;
export const SETTLE_DAYS = 8;
export const SETTLE_HOUR = 6;
// 오늘 보고서는 숫자가 그대로여도 이만큼 지나면 다시 올림 — 오피스의 "HH:MM 기준" 이 너무 오래돼 보이지 않게
export const PARTIAL_REFRESH_MIN = 55;

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** KST 날짜 00:00 의 UTC ISO */
const kstMidnightIso = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 9 * 3600_000).toISOString();
const won = (n: number) => Math.round(n).toLocaleString("ko-KR");

export interface LiveState { settled?: string }

interface PrevReport {
  generated_at?: string;
  assumptions?: { ad_estimated?: boolean; ad_basis?: string };
  summary?: { ad_spend?: number; ad_order_price?: number };
}

export interface LiveDeps {
  nowMs: number;
  /** 식스샵 프로 — 상점 주문 (주문일 fromIso ~ toIso) */
  orders: (store: string, fromIso: string, toIso: string) => Promise<ProOrder[]>;
  /** 보고서 레포 파일 읽기 (없으면 null) · 여러 파일 한 커밋 */
  getJson: <T>(path: string) => Promise<T | null>;
  commit: (files: { path: string; content: unknown }[], message: string) => Promise<string | null>;
  loadAd: (brand: string, date: string) => Promise<HomeAd>;
  brands: Record<string, HomeBrand>;
  log: (line: string) => void;
}

export interface LiveArgs {
  /** 날짜 수 — null 이면 오늘 · 어제 (그날 첫 06시 이후 실행이면 SETTLE_DAYS) */
  days: number | null;
  brands: string[];
  dry: boolean;
  state: LiveState;
}

export interface LiveResult {
  dates: string[];
  settle: boolean;
  committed: string[];
  failed: string[];
  /** 이번에 못 읽은 원본(광고 시트)이 있어 이전 값을 지킨 날 — 하루 한 번 재계산을 끝난 것으로 치지 않음 */
  degraded: string[];
}

export async function runLive(args: LiveArgs, deps: LiveDeps): Promise<LiveResult> {
  const now = new Date(deps.nowMs + 9 * 3600_000); // KST 를 UTC 필드로
  const today = now.toISOString().slice(0, 10);
  const asOf = now.toISOString().slice(11, 16);
  const settle = args.days == null && now.getUTCHours() >= SETTLE_HOUR && args.state.settled !== today;
  const nDays = args.days ?? (settle ? SETTLE_DAYS : 2);
  const dates = Array.from({ length: nDays }, (_, i) => addDays(today, -i));
  // 주문은 가장 오래된 날 이틀 앞부터 (무통장 · 자정 넘긴 결제는 다음 날 결제) — 지금 시각까지 (받는 동안 새 주문에 페이지가 밀리지 않게 고정)
  const fromIso = kstMidnightIso(addDays(dates[dates.length - 1], -2));
  const toIso = new Date(deps.nowMs).toISOString();
  deps.log(`[home-live] ${today} ${asOf} · ${dates[dates.length - 1]} ~ ${today} (${nDays}일${settle ? " — 하루 한 번 지난 날 다시 계산" : ""}) · ${args.brands.join(", ")}${args.dry ? " · 시험(기록 안 함)" : ""}`);

  const files: { path: string; content: unknown }[] = [];
  const committed: string[] = [];
  const failed: string[] = [];
  const degraded: string[] = [];

  for (const id of args.brands) {
    const cfg = deps.brands[id];
    const brandDates = dates.filter((d) => d >= cfg.liveSince);
    if (!brandDates.length) continue;
    try {
      const [orders, { rows: costRows, matcher: costMatcher }] = await Promise.all([deps.orders(cfg.proStore, fromIso, toIso), loadCostMatcher(cfg)]);
      const dir = `home/${id}`;
      const brandFiles: { path: string; content: unknown }[] = [];
      const rows: IndexRow[] = [];
      for (const date of brandDates) {
        const path = `${dir}/daily/${date}.json`;
        const prev = args.dry ? null : await deps.getJson<PrevReport>(path);
        let ad = await deps.loadAd(id, date);
        const prevAd = prev?.summary?.ad_spend != null
          ? { spend: prev.summary.ad_spend, order_price: prev.summary.ad_order_price ?? null, basis: String(prev.assumptions?.ad_basis ?? ""), estimated: !!prev.assumptions?.ad_estimated }
          : null;
        if (ad.unavailable) {
          // 광고 시트를 이번에 못 읽음 — 올라가 있던 값(시트든 메타 추정이든)을 그대로 두고, 다음 실행에서 다시
          degraded.push(`${cfg.name} ${date.slice(5)}`);
          if (prevAd) ad = prevAd;
        } else if (ad.spend == null && prevAd?.estimated) {
          // 광고 시트도 메타 데이터(오늘 · 어제만)도 없는 날 — 전에 올린 메타 추정값(0원 포함)을 그대로 둠
          ad = prevAd;
        }
        const built = buildProReport(orders, {
          date, brand: id, market: cfg.name, feeRate: FEE_RATE, naverFeeRate: NAVER_FEE_RATE, shippingCost: SHIPPING_COST,
          costRows, costBasis: cfg.costBasis, ad, costMatcher, costUnavailable: cfg.noCostSheet,
        });
        built.generated_at = new Date(deps.nowMs).toISOString();
        const partial = date === today;
        const report = partial ? { ...built, as_of: asOf, assumptions: { ...built.assumptions, partial_day: true } } : built;
        const s = report.summary;
        deps.log(
          `[home-live] ${cfg.name} ${date}${partial ? ` (${asOf} 기준)` : ""} 주문 ${s.orders}(네이버페이 ${s.naverpay_orders}) · 실결제 ${won(s.paid)} · 광고비 ${won(s.ad_spend)}${ad.estimated ? "(메타 추정)" : ad.spend == null ? "(미입력)" : ""} · 원가 ${s.cost == null ? "미반영" : won(s.cost)} · 순이익 ${won(s.net)} · 원가 미확인 ${s.cost_missing_items}건`,
        );
        if (args.dry) continue;
        const stale = partial && prev?.generated_at != null && deps.nowMs - Date.parse(prev.generated_at) >= PARTIAL_REFRESH_MIN * 60_000;
        if (prev && sameContent(prev, report) && !stale) continue;
        brandFiles.push({ path, content: report });
        rows.push(indexRowOf(report));
        committed.push(`${id} ${date.slice(5)}`);
      }
      if (rows.length) {
        const idx = (await deps.getJson<{ days: IndexRow[] }>(`${dir}/index.json`)) ?? { days: [] };
        // 날이 지났는데 남은 "진행 중" 표시는 지움 (지난 날 보고서는 다시 계산하면서 as_of 없이 올라감)
        const days = mergeIndexRows(idx.days, rows).map((d) => (d.date !== today && d.as_of ? (({ as_of: _, ...rest }) => rest)(d) : d));
        brandFiles.push({ path: `${dir}/index.json`, content: { updated_at: new Date(deps.nowMs).toISOString(), days } });
      }
      files.push(...brandFiles);
    } catch (e) {
      failed.push(`${cfg.name}: ${(e as Error).message}`);
      deps.log(`[home-live] ${cfg.name} 실패: ${(e as Error).message}`);
    }
  }

  if (!args.dry) {
    if (files.length) {
      const sha = await deps.commit(files, `home live ${today} ${asOf}: ${committed.join(" · ")}`);
      deps.log(`[home-live] ${REPORTS_REPO} 파일 ${files.length}개 커밋 ${sha?.slice(0, 7) ?? ""} (${committed.join(", ")})`);
    } else {
      deps.log("[home-live] 바뀐 보고서 없음 — 커밋 안 함");
    }
  }
  if (degraded.length) deps.log(`[home-live] 광고 시트를 못 읽어 이전 광고비를 그대로 둔 날: ${degraded.join(", ")} — 다음 실행에서 다시`);
  return { dates, settle, committed, failed, degraded };
}

/** 하루 한 번 재계산을 끝난 것으로 칠지 — 전 브랜드를 문제없이 끝냈을 때만 (일부 브랜드만 돌렸거나 실패 · 못 읽은 원본이 있으면 30분 뒤 다시) */
export function settleDone(res: LiveResult, brands: string[], dry: boolean, all = Object.keys(HOME_BRANDS)): boolean {
  return res.settle && !dry && all.every((b) => brands.includes(b)) && !res.failed.length && !res.degraded.length;
}

/* ---------------- 실행 ---------------- */

const STATE_FILE = process.env.HOME_LIVE_STATE ?? join(homedir(), "brightbeed-auto", "state", "home-live.json");

function readState(): LiveState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as LiveState;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const days = argv.includes("--days") ? Number(argv[argv.indexOf("--days") + 1]) : null;
  if (days != null && !(Number.isInteger(days) && days >= 1 && days <= 31)) throw new Error("--days 는 1 ~ 31");
  const brands = argv.includes("--brands") ? (argv[argv.indexOf("--brands") + 1] ?? "").split(",") : Object.keys(HOME_BRANDS);
  for (const b of brands) if (!HOME_BRANDS[b]) throw new Error(`없는 브랜드: ${b} (${Object.keys(HOME_BRANDS).join(", ")})`);

  const { proLogin } = await import("./sixshop-pro.js");
  const pro = await proLogin({ persist: !dry });
  const state = readState();
  const res = await runLive(
    { days, brands, dry, state },
    {
      nowMs: Date.now(),
      orders: (store, fromIso, toIso) => pro.orders(store, fromIso, toIso),
      getJson: ghGetJson,
      commit: commitFiles,
      loadAd,
      brands: HOME_BRANDS,
      log: (line) => console.log(line),
    },
  );
  if (settleDone(res, brands, dry)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, settled: res.dates[0] }));
  }
  if (res.failed.length) throw new Error(`${res.failed.length}개 브랜드 실패 — ${res.failed.join(" / ")}`);
}

// 시험(tests/home-live.test.ts)은 runLive 만 불러 쓰려고 HOME_LIVE_NO_MAIN=1 을 켠다
if (process.env.HOME_LIVE_NO_MAIN !== "1") {
  main().catch((e) => {
    console.error("[home-live] 실패:", (e as Error).message);
    process.exit(1);
  });
}
