/**
 * 에이블리 실시간 보고서 (코페리 · 아페티 · 식스에이) — 맥미니가 30분마다 실행 (mac/jobs/ably-live.job).
 * 오피스 전략팀 → 플랫폼 탭 "{마켓} · 에이블리" 카드가 읽는다.
 *   오늘(진행 중) · 어제 보고서를 다시 계산해서 바뀐 것만 brightbeed-reports 의 {dir}/daily/{날짜}.json · {dir}/index.json 에
 *   전 마켓 합쳐 커밋 하나로 올린다 (dir: 코페리 ably · 아페티 ably/apt · 식스에이 ably/6a — src/ably-brands.ts).
 *   하루 한 번(06시 이후 첫 실행)은 지난 8일을 다시 계산 — 늦은 취소 · 반품, 정산 수수료율 변화 반영.
 * 공홈 실시간(src/home-live.ts)과 같은 구조. 받기는 src/ably-api.ts, 계산은 src/ably-report.ts 로 매일 07:10 수집기(src/ably-daily.ts)와 똑같다.
 * 원가 시트는 코페리만 — 아페티 · 식스에이는 원가 미반영 보고서 (summary.cost = null, 오피스 "원가 미반영").
 * 규칙: docs/ABLY-API.md "실시간 (30분마다)". 시험: tests/ably-live.test.ts
 *
 * 사용법:
 *   npm run ably-live                       # 전 마켓 오늘 · 어제 (+ 그날 첫 06시 이후 실행이면 지난 8일)
 *   npm run ably-live -- --days 8           # 오늘부터 8일 (최대 92 — 새 마켓 지난 기간 채우기)
 *   npm run ably-live -- --brands apt,6a    # 일부 마켓만
 *   npm run ably-live -- --dry              # 계산만 — 기록 · 상태 파일 · 토큰 파일 안 씀
 *
 * env: 마켓마다 ABLY_EMAIL · ABLY_PASSWORD · ABLY_AD_MARKET_SNO (+ envSuffix _APT · _6A) · REPORTS_GITHUB_TOKEN
 *      (선택) ABLY_LIVE_STATE(상태 파일 위치)
 * 구매자 이름 · 연락처 · 주소 · 메모는 어디에도 저장하지 않는다 (주문은 AblyOrderItem 필드만, src/ably-api.ts pickOrderItem).
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CostRow } from "./ably-cost.js";
import type { AblyAdRow, AblyCoupon, AblyEvent, AblyOrderItem, SettlementHistory } from "./ably-api.js";
import { ABLY_BRANDS, type AblyBrand } from "./ably-brands.js";
import { adOn, buildAblyReport, couponsAsOf, eventsOn, feeRateFrom, feeWindow, ordersOn } from "./ably-report.js";
import { commitFiles, ghGetJson, indexRowOf, mergeIndexRows, REPORTS_REPO, sameContent, type IndexRow } from "./reports-repo.js";

const DAY = 86400_000;
export const SETTLE_DAYS = 8;
export const SETTLE_HOUR = 6;
export const MAX_DAYS = 92;
// 오늘 보고서는 숫자가 그대로여도 이만큼 지나면 다시 올림 — 오피스의 "HH:MM 기준" 이 너무 오래돼 보이지 않게
export const PARTIAL_REFRESH_MIN = 55;

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const won = (n: number) => Math.round(n).toLocaleString("ko-KR");

export interface AblyLiveState { settled?: string }

/** 마켓 하나의 에이블리 API — 결제일(checked_at) start ~ end ("YYYY-MM-DD HH:mm:ss", KST) 주문 · 정산 내역(월) · 광고비 일별 · 기획전 · 쿠폰 */
export interface AblyMarketApi {
  orders: (start: string, end: string) => Promise<AblyOrderItem[]>;
  feeHistories: (startMonth: string, endMonth: string) => Promise<SettlementHistory[]>;
  adRows: (from: string, to: string) => Promise<AblyAdRow[]>;
  events: () => Promise<AblyEvent[]>;
  coupons: () => Promise<AblyCoupon[]>;
}

export interface AblyLiveDeps {
  nowMs: number;
  /** 마켓 id → API (로그인은 처음 부를 때 — 계정 설정이 없으면 그 마켓만 실패) */
  api: (brand: string) => Promise<AblyMarketApi>;
  /** 원가 시트 — 원가를 쓰는 마켓(코페리)이 있을 때만 부름 */
  loadCosts: () => Promise<CostRow[]>;
  /** 보고서 레포 파일 읽기 (없으면 null, 그 밖의 오류는 던짐) · 여러 파일 한 커밋 */
  getJson: <T>(path: string) => Promise<T | null>;
  commit: (files: { path: string; content: unknown }[], message: string) => Promise<string | null>;
  brands: Record<string, AblyBrand>;
  log: (line: string) => void;
}

export interface AblyLiveArgs {
  /** 날짜 수 — null 이면 오늘 · 어제 (그날 첫 06시 이후 실행이면 SETTLE_DAYS) */
  days: number | null;
  brands: string[];
  dry: boolean;
  state: AblyLiveState;
}

export interface AblyLiveResult {
  dates: string[];
  settle: boolean;
  committed: string[];
  /** 실패한 마켓 — 그 마켓 파일은 하나도 안 올림 (받기 · 읽기 중 하나라도 실패하면 덮어쓸 근거가 없으므로) */
  failed: string[];
}

export async function runAblyLive(args: AblyLiveArgs, deps: AblyLiveDeps): Promise<AblyLiveResult> {
  const now = new Date(deps.nowMs + 9 * 3600_000); // KST 를 UTC 필드로
  const today = now.toISOString().slice(0, 10);
  const asOf = now.toISOString().slice(11, 16);
  const settle = args.days == null && now.getUTCHours() >= SETTLE_HOUR && args.state.settled !== today;
  const nDays = args.days ?? (settle ? SETTLE_DAYS : 2);
  const dates = Array.from({ length: nDays }, (_, i) => addDays(today, -i));
  const oldest = dates[dates.length - 1];
  const nowKst = now.toISOString().slice(0, 19).replace("T", " ");
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  deps.log(`[ably-live] ${today} ${asOf} · ${oldest} ~ ${today} (${nDays}일${settle ? " — 하루 한 번 지난 날 다시 계산" : ""}) · ${args.brands.join(", ")}${args.dry ? " · 시험(기록 안 함)" : ""}`);

  // 원가 시트는 한 번만 (원가를 쓰는 마켓이 있을 때)
  let costs: Promise<CostRow[]> | null = null;
  const files: { path: string; content: unknown }[] = [];
  const committed: string[] = [];
  const failed: string[] = [];

  for (const id of args.brands) {
    const cfg = deps.brands[id];
    try {
      const api = await deps.api(id);
      // 한 번에: 주문은 가장 오래된 날 00:00 ~ 지금 (받는 동안 새 주문에 페이지가 밀리지 않게 끝을 고정), 정산은 필요한 달마다, 나머지는 한 번
      const [items, feeList, adRows, events, coupons, costRows] = await Promise.all([
        api.orders(`${oldest} 00:00:00`, nowKst),
        Promise.all(months.map((m) => { const w = feeWindow(`${m}-01`); return api.feeHistories(w.startMonth, w.endMonth); })),
        api.adRows(oldest, today),
        api.events(),
        api.coupons(),
        cfg.costs ? (costs ??= deps.loadCosts()) : Promise.resolve([] as CostRow[]),
      ]);
      const fees = Object.fromEntries(months.map((m, i) => [m, feeList[i]]));

      const brandFiles: { path: string; content: unknown }[] = [];
      const rows: IndexRow[] = [];
      const brandDone: string[] = [];
      for (const date of dates) {
        const built = buildAblyReport(
          date,
          { items: ordersOn(items, date), fee: feeRateFrom(fees[date.slice(0, 7)], date), ad: adOn(adRows, date), events: eventsOn(events, date), coupons: couponsAsOf(coupons, date) },
          costRows,
          { market: cfg.name, costUnavailable: !cfg.costs },
        );
        built.generated_at = new Date(deps.nowMs).toISOString();
        const partial = date === today;
        const report = partial ? { ...built, as_of: asOf, assumptions: { ...built.assumptions, partial_day: true } } : built;
        const s = report.summary;
        deps.log(
          `[ably-live] ${cfg.name} ${date}${partial ? ` (${asOf} 기준)` : ""} 주문 ${s.orders} · 실결제 ${won(s.paid)} · 광고비 ${won(s.ad_spend)} · 원가 ${s.cost == null ? "미반영" : `${won(s.cost)} · 원가 미확인 ${s.cost_missing_items}건`} · 순이익 ${won(s.net)}`,
        );
        if (args.dry) continue;
        const path = `${cfg.dir}/daily/${date}.json`;
        const prev = await deps.getJson<{ generated_at?: string }>(path);
        const stale = partial && prev?.generated_at != null && deps.nowMs - Date.parse(prev.generated_at) >= PARTIAL_REFRESH_MIN * 60_000;
        if (prev && sameContent(prev, report) && !stale) continue;
        brandFiles.push({ path, content: report });
        rows.push(indexRowOf(report));
        brandDone.push(`${id} ${date.slice(5)}`);
      }
      if (rows.length) {
        const idx = (await deps.getJson<{ days: IndexRow[] }>(`${cfg.dir}/index.json`)) ?? { days: [] };
        // 날이 지났는데 남은 "진행 중" 표시는 지움 (지난 날 보고서는 다시 계산하면서 as_of 없이 올라감)
        const days = mergeIndexRows(idx.days, rows).map((d) => (d.date !== today && d.as_of ? (({ as_of: _, ...rest }) => rest)(d) : d));
        brandFiles.push({ path: `${cfg.dir}/index.json`, content: { updated_at: new Date(deps.nowMs).toISOString(), days } });
      }
      files.push(...brandFiles);
      committed.push(...brandDone);
    } catch (e) {
      failed.push(`${cfg.name}: ${(e as Error).message}`);
      deps.log(`[ably-live] ${cfg.name} 실패: ${(e as Error).message}`);
    }
  }

  if (!args.dry) {
    if (files.length) {
      const sha = await deps.commit(files, `ably live ${today} ${asOf}: ${committed.join(" · ")}`);
      deps.log(`[ably-live] ${REPORTS_REPO} 파일 ${files.length}개 커밋 ${sha?.slice(0, 7) ?? ""} (${committed.join(", ")})`);
    } else {
      deps.log("[ably-live] 바뀐 보고서 없음 — 커밋 안 함");
    }
  }
  return { dates, settle, committed, failed };
}

/** 하루 한 번 재계산을 끝난 것으로 칠지 — 전 마켓을 실패 없이 끝냈을 때만 (일부 마켓만 돌렸거나 실패가 있으면 30분 뒤 다시) */
export function settleDone(res: AblyLiveResult, brands: string[], dry: boolean, all = Object.keys(ABLY_BRANDS)): boolean {
  return res.settle && !dry && all.every((b) => brands.includes(b)) && !res.failed.length;
}

/* ---------------- 실행 ---------------- */

const STATE_FILE = process.env.ABLY_LIVE_STATE ?? join(homedir(), "brightbeed-auto", "state", "ably-live.json");

function readState(): AblyLiveState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as AblyLiveState;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const days = argv.includes("--days") ? Number(argv[argv.indexOf("--days") + 1]) : null;
  if (days != null && !(Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) throw new Error(`--days 는 1 ~ ${MAX_DAYS}`);
  const brands = argv.includes("--brands") ? (argv[argv.indexOf("--brands") + 1] ?? "").split(",") : Object.keys(ABLY_BRANDS);
  for (const b of brands) if (!ABLY_BRANDS[b]) throw new Error(`없는 마켓: ${b} (${Object.keys(ABLY_BRANDS).join(", ")})`);

  const api = await import("./ably-api.js");
  const { loadCostRows } = await import("./ably-cost.js");
  const state = readState();
  const res = await runAblyLive(
    { days, brands, dry, state },
    {
      nowMs: Date.now(),
      api: async (id) => {
        const sfx = ABLY_BRANDS[id].envSuffix;
        const marketSno = process.env[`ABLY_AD_MARKET_SNO${sfx}`];
        if (!marketSno) throw new Error(`Missing required env: ABLY_AD_MARKET_SNO${sfx}`);
        const c = await api.ablyLogin({ persist: !dry, envSuffix: sfx });
        return {
          orders: (start, end) => api.fetchOrders(c, start, end),
          feeHistories: (s, e) => api.fetchFeeHistories(c, s, e),
          adRows: (from, to) => api.fetchAdRows(c, marketSno, from, to),
          events: () => api.fetchEventList(c),
          coupons: () => api.fetchCouponList(c),
        };
      },
      // 원가 보충 탭을 못 읽으면 실패 — 30분마다 지난 보고서를 "원가 미확인"으로 덮지 않게
      loadCosts: () => loadCostRows(undefined, undefined, true),
      getJson: ghGetJson,
      commit: commitFiles,
      brands: ABLY_BRANDS,
      log: (line) => console.log(line),
    },
  );
  if (settleDone(res, brands, dry)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, settled: res.dates[0] }));
  }
  if (res.failed.length) throw new Error(`${res.failed.length}개 마켓 실패 — ${res.failed.join(" / ")}`);
}

// 시험(tests/ably-live.test.ts)은 runAblyLive 만 불러 쓰려고 ABLY_LIVE_NO_MAIN=1 을 켠다
if (process.env.ABLY_LIVE_NO_MAIN !== "1") {
  main().catch((e) => {
    console.error("[ably-live] 실패:", (e as Error).message);
    process.exit(1);
  });
}
