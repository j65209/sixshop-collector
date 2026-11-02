/**
 * 스마트스토어 실시간 보고서 (프로덕트피알) — 맥미니가 30분마다 실행 (mac/jobs/smartstore-live.job).
 * 오피스 전략팀 → 플랫폼 탭 "프로덕트피알 · 스마트스토어" 카드가 읽는다. brightbeed-reports 의 smartstore/pp/ 에 커밋 하나로 올린다.
 * 코페리 스마트스토어는 커머스API 앱이 사용 불가 상태라 뺐다 (앱을 살리면 SMARTSTORE_BRANDS 에 추가, 원가는 코페리 시트).
 * 계산은 src/smartstore-report.ts, 규칙은 docs/SMARTSTORE.md. 시험: tests/smartstore-live.test.ts
 *
 * 사용법:
 *   npm run smartstore-live                 # 오늘 · 어제 (+ 그날 첫 06시 이후 실행이면 지난 8일)
 *   npm run smartstore-live -- --days 33    # 지난 기간 채우기 (최대 92)
 *   npm run smartstore-live -- --dry        # 계산만 — 기록 · 상태 파일 안 씀
 *
 * env: SMARTSTORE_PP_CLIENT_ID · SMARTSTORE_PP_CLIENT_SECRET (프록시 config.env 와 같은 값) · REPORTS_GITHUB_TOKEN
 *      (선택) SMARTSTORE_LIVE_STATE(상태 파일 위치)
 * 네이버 응답에 구매자 이름 · 연락처 · 주소가 오지만 pickProductOrder 에서 버리고 저장하지 않는다.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { changedFiles, liveWindow, markPartial, MAX_DAYS, won } from "./live-common.js";
import { commitFiles, ghGetJson, REPORTS_REPO } from "./reports-repo.js";
import { buildSmartstoreReport, isExcludedSs, ssOrdersOn, type SsProductOrder } from "./smartstore-report.js";
import type { CostOf } from "./zigzag-live.js";

export interface SmartstoreBrand {
  name: string;
  dir: string;
  /** env 이름 — SMARTSTORE_{envKey}_CLIENT_ID · _CLIENT_SECRET */
  envKey: string;
}

export const SMARTSTORE_BRANDS: Record<string, SmartstoreBrand> = {
  pp: { name: "프로덕트피알", dir: "smartstore/pp", envKey: "PP" },
};

/** 네이버 상품 주문 상세 한 건 → 보고서에 쓰는 칸만 (구매자 정보를 버림) */
export function pickProductOrder(row: { order?: Record<string, unknown>; productOrder?: Record<string, unknown> }): SsProductOrder {
  const o = row.order ?? {};
  const p = row.productOrder ?? {};
  const n = (k: string) => Number(p[k]) || 0;
  const s = (v: unknown) => (v == null ? "" : String(v));
  return {
    product_order_id: s(p.productOrderId),
    order_id: s(o.orderId),
    package_no: s(p.packageNumber) || s(o.orderId),
    payment_date: s(o.paymentDate),
    status: s(p.productOrderStatus),
    claim_type: s(p.claimType),
    claim_status: s(p.claimStatus),
    name: s(p.productName),
    option: s(p.productOption),
    code: s(p.sellerProductCode),
    product_id: s(p.originalProductId ?? p.productId),
    quantity: n("quantity"),
    unit_price: n("unitPrice"),
    product_amount: n("totalProductAmount"),
    seller_discount: n("sellerBurdenDiscountAmount"),
    // 고객 결제액(totalPaymentAmount)이 아니라 판매자 매출 — 네이버 부담 할인은 네이버가 정산으로 채워 준다
    paid: n("totalProductAmount") - n("sellerBurdenDiscountAmount"),
    settle: n("expectedSettlementAmount"),
    delivery_fee: n("deliveryFeeAmount") - n("deliveryDiscountAmount"),
  };
}

/** 칸 이름이 바뀌면 전부 0원 · 빈 이름으로 조용히 올라가므로 내용을 보고 막는다 (실제 주문 전체에서 해당 없음을 확인) */
export function assertReadableOrders(rows: SsProductOrder[]): void {
  const bad = rows.filter((o) => !isExcludedSs(o) && (!o.order_id || !o.name || !(o.quantity > 0) || !(o.product_amount > 0) || (o.paid > 0 && !(o.settle > 0))));
  if (bad.length) throw new Error(`주문 ${bad.length}건의 내용이 비어 있음 (첫 건 ${bad[0].product_order_id}) — 네이버 응답 칸이 바뀐 듯`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** from(YYYY-MM-DD, KST 00:00) ~ 지금 사이에 상태가 바뀐 상품 주문 — 결제일이 그 기간인 주문은 전부 여기에 든다 (결제 자체가 상태 변경) */
export async function fetchProductOrders(creds: { clientId: string; clientSecret: string }, from: string, nowMs: number): Promise<SsProductOrder[]> {
  const { BASE_URL, fetchWithRetry, getAccessToken, toKstIso } = await import("./smartstore.js");
  const token = await getAccessToken(creds);
  const headers = { Authorization: `Bearer ${token}` };
  const ids = new Set<string>();
  const CHUNK = 23 * 3600_000; // 한 번에 24시간까지만 받는다
  for (let t = Date.parse(`${from}T00:00:00+09:00`); t < nowMs; t += CHUNK) {
    const url = new URL(`${BASE_URL}/v1/pay-order/seller/product-orders/last-changed-statuses`);
    url.searchParams.set("lastChangedFrom", toKstIso(new Date(t)));
    url.searchParams.set("lastChangedTo", toKstIso(new Date(Math.min(t + CHUNK, nowMs))));
    for (let page = 0; ; page++) {
      if (page >= 50) throw new Error("상태 변경 목록이 50쪽을 넘음 — 잘린 채로 쓰지 않음");
      const r = await fetchWithRetry(url, { headers });
      if (!r.ok) throw new Error(`스마트스토어 상태 변경 조회 ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const d = ((await r.json()) as { data?: { lastChangeStatuses?: { productOrderId: string }[]; more?: { moreFrom?: string; moreSequence?: string } | null } }).data;
      for (const it of d?.lastChangeStatuses ?? []) ids.add(it.productOrderId);
      if (!d?.more?.moreFrom) break;
      url.searchParams.set("lastChangedFrom", d.more.moreFrom);
      if (d.more.moreSequence) url.searchParams.set("moreSequence", d.more.moreSequence);
    }
    await sleep(150);
  }
  const all = [...ids];
  const out: SsProductOrder[] = [];
  for (let i = 0; i < all.length; i += 300) {
    const r = await fetchWithRetry(`${BASE_URL}/v1/pay-order/seller/product-orders/query`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ productOrderIds: all.slice(i, i + 300) }),
    });
    if (!r.ok) throw new Error(`스마트스토어 주문 상세 ${r.status}: ${(await r.text()).slice(0, 160)}`);
    for (const row of ((await r.json()) as { data?: Record<string, never>[] }).data ?? []) out.push(pickProductOrder(row));
  }
  // 상세가 빠진 주문이 있으면 그날 숫자가 틀리므로 올리지 않는다
  if (out.length < all.length) throw new Error(`주문 상세 ${all.length - out.length}건을 못 받음 (${out.length}/${all.length})`);
  return out;
}

export interface SmartstoreLiveDeps {
  nowMs: number;
  orders: (brand: string, from: string) => Promise<SsProductOrder[]>;
  costOf: (brand: string) => Promise<CostOf>;
  costBasis: (brand: string) => string;
  getJson: <T>(path: string) => Promise<T | null>;
  commit: (files: { path: string; content: unknown }[], message: string) => Promise<string | null>;
  brands: Record<string, SmartstoreBrand>;
  log: (line: string) => void;
}

export async function runSmartstoreLive(args: { days: number | null; brands: string[]; dry: boolean; state: { settled?: string } }, deps: SmartstoreLiveDeps) {
  const { today, asOf, settle, dates, oldest } = liveWindow(deps.nowMs, args.days, args.state.settled);
  deps.log(`[smartstore-live] ${today} ${asOf} · ${oldest} ~ ${today} (${dates.length}일${settle ? " — 하루 한 번 지난 날 다시 계산" : ""}) · ${args.brands.join(", ")}${args.dry ? " · 시험(기록 안 함)" : ""}`);
  const files: { path: string; content: unknown }[] = [];
  const committed: string[] = [];
  const failed: string[] = [];
  for (const id of args.brands) {
    const cfg = deps.brands[id];
    try {
      const [rows, costOf] = await Promise.all([deps.orders(id, oldest), deps.costOf(id)]);
      assertReadableOrders(rows);
      const reports = dates.map((date) => {
        const built = buildSmartstoreReport(date, ssOrdersOn(rows, date), costOf, { market: cfg.name, costBasis: deps.costBasis(id) });
        built.generated_at = new Date(deps.nowMs).toISOString();
        const s = built.summary;
        deps.log(`[smartstore-live] ${cfg.name} ${date}${date === today ? ` (${asOf} 기준)` : ""} 주문 ${s.orders} · 실결제 ${won(s.paid)} (배송비 ${won(s.shipping_income)}) · 수수료 ${won(s.fees_est)} · 원가 ${won(s.cost)} · 원가 미확인 ${s.cost_missing_items}건 · 순이익 ${won(s.net)}`);
        return markPartial(built, date === today, asOf);
      });
      if (args.dry) continue;
      const changed = await changedFiles(cfg.dir, reports, { today, nowMs: deps.nowMs, label: id, getJson: deps.getJson });
      files.push(...changed.files);
      committed.push(...changed.done);
    } catch (e) {
      failed.push(`${cfg.name}: ${(e as Error).message}`);
      deps.log(`[smartstore-live] ${cfg.name} 실패: ${(e as Error).message}`);
    }
  }
  if (!args.dry) {
    if (files.length) {
      const sha = await deps.commit(files, `smartstore live ${today} ${asOf}: ${committed.join(" · ")}`);
      deps.log(`[smartstore-live] ${REPORTS_REPO} 파일 ${files.length}개 커밋 ${sha?.slice(0, 7) ?? ""} (${committed.join(", ")})`);
    } else {
      deps.log("[smartstore-live] 바뀐 보고서 없음 — 커밋 안 함");
    }
  }
  return { dates, settle, committed, failed };
}

/* ---------------- 실행 ---------------- */

const STATE_FILE = process.env.SMARTSTORE_LIVE_STATE ?? join(homedir(), "brightbeed-auto", "state", "smartstore-live.json");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const days = argv.includes("--days") ? Number(argv[argv.indexOf("--days") + 1]) : null;
  if (days != null && !(Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) throw new Error(`--days 는 1 ~ ${MAX_DAYS}`);
  const brands = Object.keys(SMARTSTORE_BRANDS);
  const { HOME_BRANDS, loadCostMatcher } = await import("./home-brands.js");
  let state: { settled?: string } = {};
  try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { settled?: string }; } catch { /* 첫 실행 */ }
  const res = await runSmartstoreLive(
    { days, brands, dry, state },
    {
      nowMs: Date.now(),
      orders: (id, from) => {
        const key = SMARTSTORE_BRANDS[id].envKey;
        const clientId = process.env[`SMARTSTORE_${key}_CLIENT_ID`];
        const clientSecret = process.env[`SMARTSTORE_${key}_CLIENT_SECRET`];
        if (!clientId || !clientSecret) throw new Error(`Missing required env: SMARTSTORE_${key}_CLIENT_ID · _CLIENT_SECRET`);
        return fetchProductOrders({ clientId, clientSecret }, from, Date.now());
      },
      // 원가 표를 못 읽으면 실패 — 지난 보고서를 "원가 미확인"으로 덮지 않게. 프로덕트피알 공홈과 같은 대응표
      costOf: async (id) => (await loadCostMatcher(HOME_BRANDS[id])).matcher as CostOf,
      costBasis: (id) => HOME_BRANDS[id].costBasis,
      getJson: ghGetJson,
      commit: commitFiles,
      brands: SMARTSTORE_BRANDS,
      log: (line) => console.log(line),
    },
  );
  if (res.settle && !dry && !res.failed.length) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, settled: res.dates[0] }));
  }
  if (res.failed.length) throw new Error(`실패 — ${res.failed.join(" / ")}`);
}

// 시험(tests/smartstore-live.test.ts)은 runSmartstoreLive 만 불러 쓰려고 SMARTSTORE_LIVE_NO_MAIN=1 을 켠다
if (process.env.SMARTSTORE_LIVE_NO_MAIN !== "1") {
  main().catch((e) => {
    console.error("[smartstore-live] 실패:", (e as Error).message);
    process.exit(1);
  });
}
