/**
 * 지그재그 실시간 보고서 (코페리 · 아페티) — 맥미니가 30분마다 실행 (mac/jobs/zigzag-live.job).
 * 오피스 전략팀 → 플랫폼 탭 "{브랜드} · 지그재그" 카드와 월간 손익 메인보드가 읽는다.
 *   오늘(진행 중) · 어제 보고서를 다시 계산해서 바뀐 것만 brightbeed-reports 의 zigzag/{브랜드}/ 에 커밋 하나로 올린다.
 *   하루 한 번(06시 이후 첫 실행)은 지난 8일을 다시 계산 — 늦은 취소 · 반품, 이용료 정산 반영.
 * 에이블리 실시간(src/ably-live.ts)과 같은 구조. 받기는 src/zigzag-api.ts, 계산은 src/zigzag-report.ts.
 * 원가: 코페리 = 코페리 원가 시트 · 아페티 = MD팀 아페티 시트 (에이블리 보고서와 같은 표 · 같은 찾기).
 * 광고비: 오피스 광고 시트 data/ad-sheets/zigzag-{브랜드}.json (프록시 zigzag_ads.py 가 매일 08:00 채움). 시트가 없는 브랜드는 광고 없음.
 * 규칙: docs/ZIGZAG.md. 시험: tests/zigzag-live.test.ts
 *
 * 사용법:
 *   npm run zigzag-live                     # 오늘 · 어제 (+ 그날 첫 06시 이후 실행이면 지난 8일)
 *   npm run zigzag-live -- --days 40        # 오늘부터 40일 (최대 92 — 지난 기간 채우기)
 *   npm run zigzag-live -- --brands apt     # 일부 브랜드만
 *   npm run zigzag-live -- --dry            # 계산만 — 기록 · 상태 파일 안 씀
 *
 * env: REPORTS_GITHUB_TOKEN · (선택) ZIGZAG_LIVE_STATE(상태 파일 위치) · ZIGZAG_STATE_DIR(세션 파일 폴더)
 * 구매자 이름 · 연락처 · 주소 · 메모는 받지도 저장하지도 않는다 (src/zigzag-api.ts).
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CostMatch } from "./ably-cost.js";
import type { ZigzagOrderItem } from "./zigzag-api.js";
import { buildZigzagReport, zigzagItemsOn } from "./zigzag-report.js";
import { commitFiles, ghGetJson, indexRowOf, mergeIndexRows, REPORTS_REPO, sameContent, type IndexRow } from "./reports-repo.js";

const DAY = 86400_000;
export const SETTLE_DAYS = 8;
export const SETTLE_HOUR = 6;
export const MAX_DAYS = 92;
export const PARTIAL_REFRESH_MIN = 55;

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const won = (n: number) => Math.round(n).toLocaleString("ko-KR");

export type CostOf = (goodsName: string, goodsCode: string, option: string) => CostMatch;

export interface ZigzagBrand {
  name: string;
  /** brightbeed-reports 안 경로 */
  dir: string;
  /** 파트너센터 스토어 주소 (프록시 zigzag_sales.py 와 같음) */
  mainDomain: string;
  /** 광고 시트 파일 이름 — 없으면 광고 없는 브랜드 */
  adSheet?: string;
  costBasis: string;
}

export const ZIGZAG_BRANDS: Record<string, ZigzagBrand> = {
  kop: {
    name: "코페리", dir: "zigzag/kop", mainDomain: "cq-3o0mllwj", adSheet: "zigzag-kop",
    costBasis: "코페리 원가 시트 (에이블리 보고서와 같은 표), 상품명 · 옵션으로 매칭",
  },
  apt: {
    name: "아페티", dir: "zigzag/apt", mainDomain: "cq-jf6zas91",
    costBasis: "MD팀 아페티 시트 (에이블리 보고서와 같은 표 · 같은 찾기)",
  },
};

export interface ZigzagMarketApi {
  items: (from: string, to: string) => Promise<ZigzagOrderItem[]>;
  /** 달 YYYY-MM 의 일별 직진배송 이용료 */
  fees: (month: string) => Promise<Record<string, number>>;
}

export interface ZigzagLiveDeps {
  nowMs: number;
  api: (brand: string) => Promise<ZigzagMarketApi>;
  /** 브랜드의 원가 찾기 — 시트를 못 읽으면 던짐 (원가 0으로 덮지 않게) */
  costOf: (brand: string) => Promise<CostOf>;
  /** 광고 시트 날짜별 — 파일이 없으면 null, 못 읽으면 던짐 */
  adDays: (sheet: string) => Promise<Record<string, { krw?: number; rev?: number }> | null>;
  getJson: <T>(path: string) => Promise<T | null>;
  commit: (files: { path: string; content: unknown }[], message: string) => Promise<string | null>;
  brands: Record<string, ZigzagBrand>;
  log: (line: string) => void;
}

export interface ZigzagLiveArgs {
  days: number | null;
  brands: string[];
  dry: boolean;
  state: { settled?: string };
}

export async function runZigzagLive(args: ZigzagLiveArgs, deps: ZigzagLiveDeps) {
  const now = new Date(deps.nowMs + 9 * 3600_000); // KST 를 UTC 필드로
  const today = now.toISOString().slice(0, 10);
  const asOf = now.toISOString().slice(11, 16);
  const settle = args.days == null && now.getUTCHours() >= SETTLE_HOUR && args.state.settled !== today;
  const nDays = args.days ?? (settle ? SETTLE_DAYS : 2);
  const dates = Array.from({ length: nDays }, (_, i) => addDays(today, -i));
  const oldest = dates[dates.length - 1];
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  deps.log(`[zigzag-live] ${today} ${asOf} · ${oldest} ~ ${today} (${nDays}일${settle ? " — 하루 한 번 지난 날 다시 계산" : ""}) · ${args.brands.join(", ")}${args.dry ? " · 시험(기록 안 함)" : ""}`);

  const files: { path: string; content: unknown }[] = [];
  const committed: string[] = [];
  const failed: string[] = [];

  for (const id of args.brands) {
    const cfg = deps.brands[id];
    try {
      const api = await deps.api(id);
      const [items, feeList, costOf, ads] = await Promise.all([
        api.items(oldest, today),
        Promise.all(months.map((m) => api.fees(m))),
        deps.costOf(id),
        cfg.adSheet ? deps.adDays(cfg.adSheet) : Promise.resolve(null),
      ]);
      const fees = Object.assign({}, ...feeList) as Record<string, number>;

      const brandFiles: { path: string; content: unknown }[] = [];
      const rows: IndexRow[] = [];
      const brandDone: string[] = [];
      for (const date of dates) {
        const adDay = ads?.[date];
        const built = buildZigzagReport(
          date,
          {
            items: zigzagItemsOn(items, date),
            directFee: fees[date] ?? 0,
            ad: {
              charge: adDay?.krw ?? 0,
              adOrderPrice: adDay?.rev ?? 0,
              basis: !cfg.adSheet ? "지그재그 광고 없음" : adDay ? "오피스 광고 시트 (지그재그 광고 관리자)" : "광고 시트 미입력 — 매일 08:00 채움",
            },
          },
          costOf,
          { market: cfg.name, costBasis: cfg.costBasis },
        );
        built.generated_at = new Date(deps.nowMs).toISOString();
        const partial = date === today;
        const report = partial ? { ...built, as_of: asOf, assumptions: { ...built.assumptions, partial_day: true } } : built;
        const s = report.summary;
        deps.log(`[zigzag-live] ${cfg.name} ${date}${partial ? ` (${asOf} 기준)` : ""} 주문 ${s.orders} · 실결제 ${won(s.paid)} · 광고비 ${won(s.ad_spend)} · 이용료 ${won(s.direct_fee)} · 원가 ${won(s.cost)} · 원가 미확인 ${s.cost_missing_items}건 · 순이익 ${won(s.net)}`);
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
        const days = mergeIndexRows(idx.days, rows).map((d) => (d.date !== today && d.as_of ? (({ as_of: _, ...rest }) => rest)(d) : d));
        brandFiles.push({ path: `${cfg.dir}/index.json`, content: { updated_at: new Date(deps.nowMs).toISOString(), days } });
      }
      files.push(...brandFiles);
      committed.push(...brandDone);
    } catch (e) {
      failed.push(`${cfg.name}: ${(e as Error).message}`);
      deps.log(`[zigzag-live] ${cfg.name} 실패: ${(e as Error).message}`);
    }
  }

  if (!args.dry) {
    if (files.length) {
      const sha = await deps.commit(files, `zigzag live ${today} ${asOf}: ${committed.join(" · ")}`);
      deps.log(`[zigzag-live] ${REPORTS_REPO} 파일 ${files.length}개 커밋 ${sha?.slice(0, 7) ?? ""} (${committed.join(", ")})`);
    } else {
      deps.log("[zigzag-live] 바뀐 보고서 없음 — 커밋 안 함");
    }
  }
  return { dates, settle, committed, failed };
}

/* ---------------- 실행 ---------------- */

const STATE_FILE = process.env.ZIGZAG_LIVE_STATE ?? join(homedir(), "brightbeed-auto", "state", "zigzag-live.json");

function readState(): { settled?: string } {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as { settled?: string };
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const days = argv.includes("--days") ? Number(argv[argv.indexOf("--days") + 1]) : null;
  if (days != null && !(Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) throw new Error(`--days 는 1 ~ ${MAX_DAYS}`);
  const brands = argv.includes("--brands") ? (argv[argv.indexOf("--brands") + 1] ?? "").split(",") : Object.keys(ZIGZAG_BRANDS);
  for (const b of brands) if (!ZIGZAG_BRANDS[b]) throw new Error(`없는 브랜드: ${b} (${Object.keys(ZIGZAG_BRANDS).join(", ")})`);

  const api = await import("./zigzag-api.js");
  const { loadCostRows, matchCost } = await import("./ably-cost.js");
  const { ABLY_BRANDS } = await import("./ably-brands.js");
  const { OFFICE_RAW } = await import("./home-ad.js");
  const state = readState();
  const res = await runZigzagLive(
    { days, brands, dry, state },
    {
      nowMs: Date.now(),
      api: async (id) => {
        const gql = api.zigzagClient(id, ZIGZAG_BRANDS[id].mainDomain);
        return { items: (from, to) => api.fetchZigzagItems(gql, from, to), fees: (m) => api.fetchZigzinFees(gql, m) };
      },
      // 원가 표를 못 읽으면 실패 — 지난 보고서를 "원가 미확인"으로 덮지 않게
      costOf: async (id) => {
        if (id === "kop") {
          const rows = await loadCostRows(undefined, undefined, true);
          return (n, c, o) => matchCost(rows, n, c, o);
        }
        return (await ABLY_BRANDS.apt.cost!.load()) as CostOf;
      },
      adDays: async (sheet) => {
        const r = await fetch(`${OFFICE_RAW}/data/ad-sheets/${sheet}.json?_t=${Date.now()}`);
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`광고 시트 ${sheet} → ${r.status}`);
        return ((await r.json()) as { days?: Record<string, { krw?: number; rev?: number }> }).days ?? {};
      },
      getJson: ghGetJson,
      commit: commitFiles,
      brands: ZIGZAG_BRANDS,
      log: (line) => console.log(line),
    },
  );
  if (res.settle && !dry && Object.keys(ZIGZAG_BRANDS).every((b) => brands.includes(b)) && !res.failed.length) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, settled: res.dates[0] }));
  }
  if (res.failed.length) throw new Error(`${res.failed.length}개 브랜드 실패 — ${res.failed.join(" / ")}`);
}

// 시험(tests/zigzag-live.test.ts)은 runZigzagLive 만 불러 쓰려고 ZIGZAG_LIVE_NO_MAIN=1 을 켠다
if (process.env.ZIGZAG_LIVE_NO_MAIN !== "1") {
  main().catch((e) => {
    console.error("[zigzag-live] 실패:", (e as Error).message);
    process.exit(1);
  });
}
