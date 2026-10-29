/**
 * 에이블리 실시간 수집기(src/ably-live.ts runAblyLive) · 로그인 토큰(src/ably-api.ts ablyLogin) 시험 — 네트워크 · 계정 없이.
 *   npx tsx tests/ably-live.test.ts
 * 에이블리 API · 보고서 레포 · 원가 시트를 가짜로 바꿔 끼워 날짜 범위, 오늘만 진행 중 표시, 자정 넘기기, 바뀐 것만 올리기, 55분 규칙,
 * 하루 한 번 8일 다시 계산, 읽기 실패 시 아무것도 안 올리기, 아페티 원가(MD팀 아페티 시트 · 에이블리 옵션 읽기) · 원가 없는 마켓(식스에이), 마켓 하나 실패,
 * 개인정보 빼기, 토큰 저장 · 갱신 · 로그인 실패 쉬기 · 마켓별 계정을 확인한다.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ABLY_LIVE_NO_MAIN = "1";
const tmp = mkdtempSync(join(tmpdir(), "ably-live-test-"));
process.env.ABLY_TOKEN_FILE = join(tmp, "ably-token.json");
process.env.ABLY_EMAIL = "seller@example.com";
process.env.ABLY_PASSWORD = "pw";
const { runAblyLive, settleDone } = await import("../src/ably-live.js");
const { ABLY_BRANDS, apetiAblyMatcher } = await import("../src/ably-brands.js");
const { ablyLogin, fetchOrders, pickOrderItem } = await import("../src/ably-api.js");
type AblyOrderItem = import("../src/ably-api.js").AblyOrderItem;

let pass = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${(e as Error).message.split("\n").join("\n       ")}`);
    process.exitCode = 1;
  }
}

const at = (s: string) => Date.parse(`${s.replace(" ", "T")}:00+09:00`);
let seq = 0;
function item(checked: string, paid: number, o: { order?: number; status?: string; coupon?: number; name?: string; option?: string } = {}): AblyOrderItem {
  seq++;
  return {
    sno: seq, order_sno: o.order ?? seq, ea: 1, status: o.status ?? "배송중", ordered_at: checked.slice(0, 16), checked_at: `${checked}:00`,
    goods_sno: 1, goods_name: o.name ?? "Bunny bag", goods_custom_code: null, option_info: o.option ?? "black", price: paid + (o.coupon ?? 0),
    exact_coupon_discount: o.coupon ?? 0, exact_emoney_discount: 0, exact_pay_benefit_discount: 0, exact_amount: paid,
    coupon_amount_for_ably: 0, delivery_type: "standard", pay_method_name: "카드", balance_accounts_scheduled_at: null,
  };
}

const ITEMS: AblyOrderItem[] = [
  item("2026-10-27 10:00", 20000, { coupon: 2000 }),
  item("2026-10-27 15:00", 15000, { order: 900 }),
  item("2026-10-27 15:10", 5000, { order: 900 }), // 같은 주문번호 → 배송비 한 번
  item("2026-10-26 12:00", 30000),
  item("2026-10-26 13:00", 9999, { status: "취소완료" }),
];

// MD팀 아페티 시트 가짜 행 (실제 이름 · 공급가 일부) — 실제 별칭 · 특례로 에이블리 옵션을 읽는지 네트워크 없이 본다
const APT_ROWS = ([
  ["Baby ring-A(재등록)", 1080], ["Baby ring-B(재등록)", 1320], ["Baby set", 2400, "B"], ["R-07", 1146], ["R-08", 1146], ["R-06", 735], ["R-22", 660],
  ["H ring", 990], ["Thin ring", 1131], ["OL ring", 1260], ["OL 1+1", 2520, "B"], ["Frost ring(재등록)", 948], ["Veil ring(재등록)", 1224],
  ["Twinkle ring", 1236], ["Layer ring", 1158], ["Two-line ring", 981], ["heart ring", 1554], ["White heart ring(재등록)", 1200],
  ["ORION- A", 1056], ["ORION - B", 966], ["ORION - C", 897], ["Matt ORION - A", 1170], ["Matt ORION - B", 1080], ["Matt ORION - C", 990],
  ["Small queen ring", 1137], ["Big queen ring", 1137], ["N - Drop", 2079], ["DORAEMI 3", 1140], ["N - Daisy", 807], ["Dolly ring", 342],
  ["Cross ring", 1050], ["Cross set", 1104, "B"], ["Ripple ring", 1005], ["1+1 기획", 2370, "B"], ["set", 4017, "P"],
] as [string, number, ("A" | "B" | "P")?][]).map(([name, cost, table]) => ({ name, cost, table: table ?? ("A" as const) }));

function fakes(opts: { nowMs: number; repo?: Map<string, unknown>; items?: AblyOrderItem[]; failGet?: boolean; failOrders?: string; failLogin?: string; failAptCosts?: boolean }) {
  const repo = opts.repo ?? new Map<string, unknown>();
  const calls = { api: [] as string[], orders: [] as [string, string][], fees: [] as [string, string][], ad: [] as [string, string][], costs: 0, aptCosts: 0, gets: [] as string[], commits: [] as { paths: string[]; message: string }[], logs: [] as string[] };
  const items = opts.items ?? ITEMS;
  return {
    repo, calls,
    deps: {
      nowMs: opts.nowMs,
      api: async (brand: string) => {
        calls.api.push(brand);
        if (opts.failLogin === brand) throw new Error("Missing required env: ABLY_PASSWORD_6A");
        return {
          orders: async (start: string, end: string) => {
            calls.orders.push([start, end]);
            if (opts.failOrders === brand) throw new Error("GET /seller/order_items/ → 500");
            return items.filter((o) => o.checked_at >= start && o.checked_at <= end);
          },
          feeHistories: async (s: string, e: string) => {
            calls.fees.push([s, e]);
            return [{ is_completed: true, scheduled_at: "2026-10-10", payment_amount: 1000000, payment_fees: 44000, platform_fees: 231000, category_fees: 0 }];
          },
          adRows: async (from: string, to: string) => {
            calls.ad.push([from, to]);
            return [{ datetime: "2026-10-27T00:00:00", charge: 3000, order_price: 9000 }, { datetime: "2026-10-26T00:00:00", charge: 4000, order_price: 0 }];
          },
          events: async () => [],
          coupons: async () => [],
        };
      },
      loadCosts: async () => {
        calls.costs++;
        return [{ name: "Bunny bag", cost: 5000, table: "A" as const }];
      },
      // 아페티 원가는 실제 설정(근거 문구 · 별칭 · 특례) 그대로, 시트만 가짜 행으로
      brands: {
        ...ABLY_BRANDS,
        apt: {
          ...ABLY_BRANDS.apt,
          cost: {
            ...ABLY_BRANDS.apt.cost!,
            load: async () => {
              calls.aptCosts++;
              if (opts.failAptCosts) throw new Error("MD팀 아페티 시트 Product List 에서 원가를 0개밖에 못 읽음");
              return apetiAblyMatcher(APT_ROWS);
            },
          },
        },
      },
      getJson: async <T,>(path: string) => {
        calls.gets.push(path);
        if (opts.failGet) throw new Error("GitHub GET ably/daily → 502");
        return repo.has(path) ? (JSON.parse(JSON.stringify(repo.get(path))) as T) : null;
      },
      commit: async (files: { path: string; content: unknown }[], message: string) => {
        calls.commits.push({ paths: files.map((f) => f.path), message });
        for (const f of files) repo.set(f.path, JSON.parse(JSON.stringify(f.content)));
        return "abc1234def";
      },
      log: (l: string) => calls.logs.push(l),
    },
  };
}
type Rep = { as_of?: string; generated_at: string; assumptions: Record<string, unknown>; summary: Record<string, number>; orders: Record<string, unknown>[] };
type Idx = { days: { date: string; as_of?: string; paid: number }[] };

console.log("에이블리 실시간 수집기 (runAblyLive)");
const repo = new Map<string, unknown>();
repo.set("ably/index.json", { days: [{ date: "2026-09-06", orders: 1, paid: 1, net: 1, ad_spend: 0, coupon_orders: 0, cost: 0 }] });
const settledToday = (d: string) => ({ settled: d });

await test("오늘 · 어제 계산 — 주문은 어제 00:00 ~ 지금 한 번, 광고비 기간 한 번, 정산은 달마다 한 번, 커밋 하나", async () => {
  const f = fakes({ nowMs: at("2026-10-27 15:30"), repo });
  const r = await runAblyLive({ days: null, brands: ["kop"], dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.deepEqual(r.dates, ["2026-10-27", "2026-10-26"]);
  assert.equal(r.settle, false);
  assert.deepEqual(f.calls.orders, [["2026-10-26 00:00:00", "2026-10-27 15:30:00"]]);
  assert.deepEqual(f.calls.ad, [["2026-10-26", "2026-10-27"]]);
  assert.deepEqual(f.calls.fees, [["2026-08", "2026-10"]]);
  assert.equal(f.calls.commits.length, 1);
  assert.deepEqual(f.calls.commits[0].paths.sort(), ["ably/daily/2026-10-26.json", "ably/daily/2026-10-27.json", "ably/index.json"]);
});

await test("결제일별 금액 — 취소 제외 · 주문번호당 배송비 · 광고비 · 원가 · 수수료", () => {
  const d27 = repo.get("ably/daily/2026-10-27.json") as Rep;
  const d26 = repo.get("ably/daily/2026-10-26.json") as Rep;
  assert.equal(d27.summary.orders, 2);
  assert.equal(d27.summary.items, 3);
  assert.equal(d27.summary.paid, 40000);
  assert.equal(d27.summary.coupon_orders, 1);
  assert.equal(d27.summary.shipping, 2 * 2200);
  assert.equal(d27.summary.ad_spend, 3000);
  assert.equal(d27.summary.cost, 3 * 5000);
  assert.equal(d27.summary.fees_est, Math.round(40000 * 0.275));
  assert.equal(d26.summary.orders, 1);
  assert.equal(d26.summary.excluded_items, 1);
  assert.equal(d26.summary.ad_spend, 4000);
});

await test("오늘만 진행 중 표시 (as_of · partial_day) — 보고서와 index 줄 모두", () => {
  const d27 = repo.get("ably/daily/2026-10-27.json") as Rep;
  const d26 = repo.get("ably/daily/2026-10-26.json") as Rep;
  assert.equal(d27.as_of, "15:30");
  assert.equal(d27.assumptions.partial_day, true);
  assert.equal(d26.as_of, undefined);
  assert.equal(d26.assumptions.partial_day, undefined);
  const idx = repo.get("ably/index.json") as Idx;
  assert.deepEqual(idx.days.map((d) => [d.date, d.as_of]), [["2026-10-27", "15:30"], ["2026-10-26", undefined], ["2026-09-06", undefined]]);
});

await test("숫자가 그대로면 커밋 안 함 (55분 안)", async () => {
  const f = fakes({ nowMs: at("2026-10-27 16:00"), repo });
  const r = await runAblyLive({ days: null, brands: ["kop"], dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.equal(f.calls.commits.length, 0);
  assert.deepEqual(r.committed, []);
  assert.ok(f.calls.logs.some((l) => l.includes("바뀐 보고서 없음")));
});

await test("55분이 지나면 숫자가 그대로여도 오늘 보고서 시각만 새로 (어제는 안 건드림)", async () => {
  const f = fakes({ nowMs: at("2026-10-27 16:26"), repo });
  await runAblyLive({ days: null, brands: ["kop"], dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.equal(f.calls.commits.length, 1);
  assert.deepEqual(f.calls.commits[0].paths.sort(), ["ably/daily/2026-10-27.json", "ably/index.json"]);
  assert.equal((repo.get("ably/daily/2026-10-27.json") as Rep).as_of, "16:26");
});

await test("새 주문이 들어오면 오늘만 올림", async () => {
  const f = fakes({ nowMs: at("2026-10-27 16:40"), repo, items: [...ITEMS, item("2026-10-27 16:35", 7000)] });
  await runAblyLive({ days: null, brands: ["kop"], dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.deepEqual(f.calls.commits[0].paths.sort(), ["ably/daily/2026-10-27.json", "ably/index.json"]);
  assert.equal((repo.get("ably/daily/2026-10-27.json") as Rep).summary.paid, 47000);
});

await test("자정이 지나면 어제(10-27) 보고서는 진행 중 표시 없이 다시 올라감", async () => {
  const items = [...ITEMS, item("2026-10-27 16:35", 7000)];
  const f = fakes({ nowMs: at("2026-10-28 00:10"), repo, items });
  // 06시 전이라 하루 한 번 재계산 아님
  const r = await runAblyLive({ days: null, brands: ["kop"], dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.equal(r.settle, false);
  assert.deepEqual(r.dates, ["2026-10-28", "2026-10-27"]);
  const d27 = repo.get("ably/daily/2026-10-27.json") as Rep;
  assert.equal(d27.as_of, undefined);
  assert.equal(d27.assumptions.partial_day, undefined);
  assert.equal(d27.summary.paid, 47000, "숫자는 그대로");
  assert.equal((repo.get("ably/daily/2026-10-28.json") as Rep).as_of, "00:10");
  const idx = repo.get("ably/index.json") as Idx;
  assert.deepEqual(idx.days.slice(0, 2).map((d) => [d.date, d.as_of]), [["2026-10-28", "00:10"], ["2026-10-27", undefined]]);
});

await test("06시 이후 그날 첫 실행은 지난 8일 — 달이 걸치면 정산은 달마다 한 번 · 이미 했으면 2일", async () => {
  const f = fakes({ nowMs: at("2026-10-03 06:10") });
  const r = await runAblyLive({ days: null, brands: ["kop"], dry: true, state: settledToday("2026-10-02") }, f.deps);
  assert.equal(r.settle, true);
  assert.equal(r.dates.length, 8);
  assert.equal(r.dates[7], "2026-09-26");
  assert.deepEqual(f.calls.orders, [["2026-09-26 00:00:00", "2026-10-03 06:10:00"]]);
  assert.deepEqual(f.calls.fees.sort(), [["2026-07", "2026-09"], ["2026-08", "2026-10"]]);
  const before6 = await runAblyLive({ days: null, brands: ["kop"], dry: true, state: settledToday("2026-10-02") }, fakes({ nowMs: at("2026-10-03 05:50") }).deps);
  assert.equal(before6.dates.length, 2);
  const done = await runAblyLive({ days: null, brands: ["kop"], dry: true, state: settledToday("2026-10-03") }, fakes({ nowMs: at("2026-10-03 07:00") }).deps);
  assert.equal(done.settle, false);
  assert.equal(done.dates.length, 2);
  const nDays = await runAblyLive({ days: 5, brands: ["kop"], dry: true, state: {} }, fakes({ nowMs: at("2026-10-03 07:00") }).deps);
  assert.equal(nDays.settle, false, "--days 는 하루 한 번 기록과 상관없음");
  assert.equal(nDays.dates.length, 5);
});

await test("--dry 는 보고서 레포를 읽지도 쓰지도 않음", async () => {
  const f = fakes({ nowMs: at("2026-10-27 15:30") });
  await runAblyLive({ days: null, brands: ["kop"], dry: true, state: {} }, f.deps);
  assert.equal(f.calls.gets.length, 0);
  assert.equal(f.calls.commits.length, 0);
});

await test("GitHub 읽기 실패 · 에이블리 받기 실패면 아무것도 안 올리고 실패", async () => {
  const r1 = new Map(repo);
  const f1 = fakes({ nowMs: at("2026-10-28 09:00"), repo: r1, failGet: true });
  const res1 = await runAblyLive({ days: null, brands: ["kop"], dry: false, state: settledToday("2026-10-28") }, f1.deps);
  assert.match(res1.failed.join(), /GitHub GET/);
  assert.equal(f1.calls.commits.length, 0);
  const f2 = fakes({ nowMs: at("2026-10-28 09:00"), repo: r1, failOrders: "kop" });
  const res2 = await runAblyLive({ days: null, brands: ["kop"], dry: false, state: settledToday("2026-10-28") }, f2.deps);
  assert.match(res2.failed.join(), /order_items/);
  assert.equal(f2.calls.commits.length, 0);
});

const APT_ITEMS: AblyOrderItem[] = [
  item("2026-10-27 10:00", 22200, { name: "✨에이블리 단독 세트할인✨ Baby ring set", option: "Baby set/free" }),
  item("2026-10-27 11:00", 26000, { name: "🔥1+1 품절직전! 초초초특가!🔥Silver 925 OL ring set 레이어드 반지", option: "1+1/free" }),
  item("2026-10-27 12:00", 23900, { name: "❤️‍🔥[NCT WISH 착용] 6set 1+1 에이블리 기획!❤️‍🔥 페미닌 러블리 반지", option: "Frost/Veil" }),
  item("2026-10-26 12:00", 14000, { name: "🔥최대할인🔥Silver925 R-22", option: "silver/." }),
];

await test("아페티 · 식스에이 — ably/apt · ably/6a 경로, 아페티는 MD팀 아페티 시트 원가 · 식스에이는 원가 미반영(cost null · 순이익에 원가 안 뺌)", async () => {
  const r = new Map<string, unknown>();
  const f = fakes({ nowMs: at("2026-10-27 15:30"), repo: r, items: APT_ITEMS });
  const res = await runAblyLive({ days: null, brands: ["apt", "6a"], dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.deepEqual(res.failed, []);
  assert.equal(f.calls.costs, 0, "코페리 원가 시트 안 읽음");
  assert.equal(f.calls.aptCosts, 1, "아페티 시트는 실행마다 한 번");
  assert.deepEqual(f.calls.api, ["apt", "6a"]);
  assert.equal(f.calls.commits.length, 1, "두 마켓 커밋 하나");
  assert.deepEqual(f.calls.commits[0].paths.sort(), [
    "ably/6a/daily/2026-10-26.json", "ably/6a/daily/2026-10-27.json", "ably/6a/index.json",
    "ably/apt/daily/2026-10-26.json", "ably/apt/daily/2026-10-27.json", "ably/apt/index.json",
  ]);
  const d = r.get("ably/apt/daily/2026-10-27.json") as Rep & { market: string };
  assert.equal(d.market, "아페티");
  assert.deepEqual(d.orders.map((o) => [o.cost_match, o.cost, o.cost_name]), [
    ["exact", 2400, "Baby ring-A + Baby ring-B"],
    ["exact", 2520, "OL ring + OL ring"],
    ["exact", 2172, "Frost ring + Veil ring"],
  ]);
  assert.equal(d.summary.cost, 2400 + 2520 + 2172);
  assert.equal(d.summary.cost_missing_items, 0);
  assert.match(String(d.assumptions.cost_basis), /MD팀 아페티 시트/);
  assert.equal(d.summary.net, d.summary.settle_est - d.summary.shipping - d.summary.ad_spend - d.summary.cost, "순이익 = 정산 − 배송비 − 광고비 − 원가");
  assert.equal((r.get("ably/apt/daily/2026-10-26.json") as Rep).summary.cost, 660);
  assert.equal(d.as_of, "15:30");
  assert.deepEqual((r.get("ably/apt/index.json") as Idx).days.map((x) => [x.date, x.as_of]), [["2026-10-27", "15:30"], ["2026-10-26", undefined]]);
  assert.equal(((r.get("ably/apt/index.json") as { days: { cost: unknown }[] }).days[0]).cost, 7092, "index 줄에도 원가");

  const s = r.get("ably/6a/daily/2026-10-27.json") as Rep & { market: string };
  assert.equal(s.market, "식스에이");
  assert.equal(s.summary.cost, null);
  assert.equal(s.summary.cost_missing_items, 0);
  assert.match(String(s.assumptions.cost_basis), /원가 미반영/);
  assert.equal(s.summary.net, s.summary.settle_est - s.summary.shipping - s.summary.ad_spend, "순이익 = 정산 − 배송비 − 광고비");
  assert.ok(s.orders.every((o) => o.cost_unit === null && o.cost === 0));
  assert.equal(((r.get("ably/6a/index.json") as { days: { cost: unknown }[] }).days[0]).cost, null, "index 줄도 원가 null (오피스 '원가 전')");
});

await test("아페티 시트를 못 읽으면 아페티만 실패 — 아페티 파일은 하나도 안 덮음, 식스에이는 그대로 올림", async () => {
  const r = new Map<string, unknown>();
  const f = fakes({ nowMs: at("2026-10-27 15:30"), repo: r, items: APT_ITEMS, failAptCosts: true });
  const res = await runAblyLive({ days: null, brands: ["apt", "6a"], dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0], /^아페티: MD팀 아페티 시트/);
  assert.ok(f.calls.commits[0].paths.every((p) => p.startsWith("ably/6a/")));
});

await test("마켓 하나가 실패해도(로그인 설정 없음) 나머지는 올림 · 하루 한 번 재계산은 끝난 걸로 안 침", async () => {
  const r = new Map<string, unknown>();
  const f = fakes({ nowMs: at("2026-10-28 06:30"), repo: r, failLogin: "6a" });
  const res = await runAblyLive({ days: null, brands: ["kop", "apt", "6a"], dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.equal(res.settle, true);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0], /식스에이: Missing required env: ABLY_PASSWORD_6A/);
  assert.equal(f.calls.commits.length, 1);
  const paths = f.calls.commits[0].paths;
  assert.ok(paths.includes("ably/index.json") && paths.includes("ably/apt/index.json"));
  assert.ok(!paths.some((p) => p.startsWith("ably/6a/")), "실패한 마켓 파일은 없음");
  assert.equal(settleDone(res, ["kop", "apt", "6a"], false), false, "실패가 있으면 30분 뒤 다시 8일");
  const ok = await runAblyLive({ days: null, brands: ["kop", "apt", "6a"], dry: false, state: settledToday("2026-10-27") }, fakes({ nowMs: at("2026-10-28 07:00"), repo: r }).deps);
  assert.equal(settleDone(ok, ["kop", "apt", "6a"], false), true);
  assert.equal(settleDone(ok, ["kop"], false), false, "일부 마켓만 돌린 건 끝난 걸로 안 침");
  assert.equal(settleDone(ok, ["kop", "apt", "6a"], true), false, "--dry 도");
});

await test("원가 시트를 못 읽으면 코페리만 실패 — 아페티는 그대로 올림", async () => {
  const r = new Map<string, unknown>();
  const f = fakes({ nowMs: at("2026-10-27 15:30"), repo: r });
  f.deps.loadCosts = async () => { throw new Error("원가 Product List 탭을 못 읽음"); };
  const res = await runAblyLive({ days: null, brands: ["kop", "apt"], dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0], /^코페리/);
  assert.ok(f.calls.commits[0].paths.every((p) => p.startsWith("ably/apt/")));
});

console.log("\n에이블리 아페티 원가 (apetiAblyMatcher · src/cost-match.ts matchCostAbly)");
const aptCost = apetiAblyMatcher(APT_ROWS);
const cost = (name: string, option: string) => {
  const m = aptCost(name, "", option);
  return [m.cost_match, m.cost_unit, m.cost_name];
};
const YR = "❤️‍🔥[NCT WISH 착용] 1+1 할인 여리여리 기획 세트! Silver925❤️‍🔥Twinkle Flower Layer Rose white heart ring";
const LAYER = "💫레이어드 기획 1+1 최저가!💫 Silver925 BEST 실버 레이어드링 반지 세트";

await test("옵션 칸 — 구매 형식(1+1 · 단품), 고른 두 반지 합, '+' 추가 상품, ring 뗀 이름, 사이즈 · 색상 칸 건너뜀", () => {
  assert.deepEqual(cost(YR, "1+1/Twinkle ring/Layer ring"), ["exact", 2394, "Twinkle ring + Layer ring"]);
  assert.deepEqual(cost(YR, "1+1/Layer ring/Two line ring"), ["exact", 2139, "Layer ring + Two-line ring"]);
  assert.deepEqual(cost(YR, "단품/Layer ring/없음"), ["exact", 1158, "Layer ring"]);
  assert.deepEqual(cost(LAYER, "H ring/+R-06"), ["exact", 1725, "H ring + R-06"]);
  assert.deepEqual(cost(LAYER, "R-06/+R-06"), ["exact", 1470, "R-06 + R-06"]);
  assert.deepEqual(cost(LAYER, "H ring/+Thin"), ["exact", 2121, "H ring + Thin ring"]);
  assert.deepEqual(cost("❤️‍🔥[NCT WISH 착용] 6set 1+1 에이블리 기획!❤️‍🔥 페미닌 러블리 반지", "Frost/Veil"), ["exact", 2172, "Frost ring + Veil ring"]);
  assert.deepEqual(cost("✨반지세트 1+1할인 초초초특가✨Silver925 7080 ring set 레이어드 반지", "R-08/OPEN RING"), ["exact", 1146, "R-08"]);
});

await test("세트 표기 — 구성 상품 합 (7080 · Baby · ORION · queen · 도레미 · Heart ring set 의 'set')", () => {
  assert.deepEqual(cost("✨반지세트 1+1할인 초초초특가✨Silver925 7080 ring set 레이어드 반지", "07.08set/OPEN RING"), ["exact", 2292, "R-07 + R-08"]);
  assert.deepEqual(cost("✨에이블리 단독 세트할인✨ Baby ring set", "Baby set/free"), ["exact", 2400, "Baby ring-A + Baby ring-B"]);
  assert.deepEqual(cost("✨에이블리 단독 세트할인✨ Baby ring set", "Baby-B/free"), ["exact", 1320, "Baby ring-B"]);
  assert.deepEqual(cost("💫기획세트 2+1 최저가!💫 ORION RING SET 레이어드 반지 세트", "오리온 SET (A+B+C)/free"), ["exact", 2919, "ORION- A + ORION - B + ORION - C"]);
  assert.deepEqual(cost("💫기획세트 2+1 최저가!💫 ORION RING SET 레이어드 반지 세트", "Matt ORION SET (A+B+C)/free"), ["exact", 3240, "Matt ORION - A + Matt ORION - B + Matt ORION - C"]);
  assert.deepEqual(cost("💫기획세트 2+1 최저가!💫 ORION RING SET 레이어드 반지 세트", "오리온-C/free"), ["exact", 897, "ORION - C"]);
  assert.deepEqual(cost("[Silver925] Queen ring set", "queen ring set/free"), ["exact", 2274, "Small queen ring + Big queen ring"]);
  assert.deepEqual(cost("🩵1+1세트! 목걸이&반지 다 드려요🩵돌리 세트", "N - Daisy + Dolly ring SET/선택 없음"), ["exact", 1149, "N - Daisy + Dolly ring"]);
  assert.deepEqual(cost("DORAEMI RING", "도레미-3/free"), ["exact", 1140, "DORAEMI 3"]);
  assert.deepEqual(cost("🔥최대할인🔥Silver925 Heart ring set", "set/free"), ["exact", 2754, "heart ring + White heart ring"]);
  assert.deepEqual(cost("🔥최대할인🔥Silver925 Heart ring set", "heart ring/free"), ["exact", 1554, "heart ring"]);
});

await test("옵션에 상품이 없으면 상품명 (홍보 문구 · [태그] 뗌) — '1+1' 이면 두 개, 못 읽은 옵션 값은 찾은 이름 안에 있어야", () => {
  assert.deepEqual(cost("🔥1+1 품절직전! 초초초특가!🔥Silver 925 OL ring set 레이어드 반지", "1+1/free"), ["exact", 2520, "OL ring + OL ring"]);
  assert.deepEqual(cost("🔥1+1 품절직전! 초초초특가!🔥Silver 925 OL ring set 레이어드 반지", "OL ring/free"), ["exact", 1260, "OL ring"]);
  assert.deepEqual(cost("[Silver925/당일출고] R-06", "silver//"), ["exact", 735, "R-06"]);
  assert.deepEqual(cost("🔥최대할인🔥Silver925 R-22", "silver/."), ["exact", 660, "R-22"]);
  assert.deepEqual(cost("N - Drop", "Drop/선택 없음"), ["exact", 2079, "N - Drop"]);
  assert.deepEqual(cost("N - Drop", "Teardrop/선택 없음"), ["none", null, null], "옵션 값이 상품명 상품과 다름");
});

await test("짐작하지 않음 — 모르는 옵션 · 일부만 읽힘 · 상품명에 시트 상품 여럿 → 미확인, '1+1 기획' · 'set' 같은 줄은 안 잡음", () => {
  assert.deepEqual(cost(YR, "1+1/Twinkle ring/Mystery ring"), ["none", null, null], "두 반지 중 하나만 읽힘");
  assert.deepEqual(cost("❤️‍🔥[NCT WISH 착용] 6set 1+1 에이블리 기획!❤️‍🔥 페미닌 러블리 반지", "Glaze/Lilia"), ["none", null, null], "시트에 없는 반지");
  assert.deepEqual(cost(YR, "free"), ["none", null, null], "상품명에 시트 상품이 여럿");
  assert.deepEqual(cost("Bunny bag", "black"), ["none", null, null]);
  assert.deepEqual(cost("🩵1+1세트! 목걸이&반지 다 드려요🩵돌리 세트", "N - Mystery + Dolly ring SET/선택 없음"), ["none", null, null], "세트 조각 하나가 시트에 없음");
  assert.deepEqual(cost("[Silver925] Cross ring", "Cross/Free"), ["exact", 1050, "Cross ring"], "ring 뗀 이름이 'Cross set' 줄로 안 감");
  assert.deepEqual(cost(LAYER, "Frost + Veil/free"), ["exact", 2172, "Frost ring + Veil ring"], "조각마다 ring 붙임");
});

await test("개수 — 시트 '1+1' 줄은 이미 두 개, 이름의 '1+1' 은 두 개, 구매 형식 칸(단품)이 덜 떼어진 홍보 문구보다 우선", () => {
  assert.deepEqual(cost("Silver925 OL 1+1 반지", "free"), ["exact", 2520, "OL 1+1"]);
  assert.deepEqual(cost("Ripple ring 1+1", "free"), ["exact", 2010, "Ripple ring + Ripple ring"]);
  assert.deepEqual(cost("🔥🔥1+1 특가🔥 Silver925 R-22", "단품/free"), ["exact", 660, "R-22"]);
});

await test("아페티 시트 실제 연결 (ABLY_BRANDS.apt.cost.load) — Product List 원가가 100개 미만이면 실패, 넘으면 그 시트로 원가 찾기", async () => {
  const realFetch = globalThis.fetch;
  const tab = (n: number) => ["업데이트 날짜,카테고리,상품명,플랫폼 기획 상품,￥,공급가", ...Array.from({ length: n }, (_, i) => `,Ring,Test ring ${i + 1},,1,${1000 + i}`)].join("\n");
  const serve = (n: number) => (async (url: string | URL) => new Response(tab(String(url).includes("gid=1838386820") ? n : 0))) as typeof fetch;
  try {
    globalThis.fetch = serve(5);
    await assert.rejects(ABLY_BRANDS.apt.cost!.load(), /Product List 에서 원가를 5개밖에 못 읽음/);
    globalThis.fetch = serve(150);
    const m = await ABLY_BRANDS.apt.cost!.load();
    assert.deepEqual(m("[Silver925] Test ring 7", "", "Test ring 7/free"), { cost_unit: 1006, cost_name: "Test ring 7", cost_match: "exact" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log("\n에이블리 API (ably-api)");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sec: number, extra: Record<string, unknown> = {}) => `${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + sec, ...extra })}.sig`;
let issued = 0;
function fakeAbly(opts: { rejectAccessOnce?: boolean; refreshFails?: boolean; items?: Record<string, unknown>[]; total?: number } = {}) {
  const calls: { method: string; path: string; body?: Record<string, unknown>; auth?: string }[] = [];
  let rejected = false;
  const valid = new Set<string>();
  const fetchImpl = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const auth = init?.headers?.Authorization;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body, auth });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.pathname === "/seller/login/") {
      if (!("email" in body)) return json({ message: "이메일은 필수 항목입니다", code: 1 }, 400);
      if (body.email !== "seller@example.com" || body.password !== "pw") return json({ message: "비밀번호가 일치하지 않습니다", code: 2 }, 400);
      const a = jwt(3600, { n: ++issued });
      return json({ access_token: a, refresh_token: jwt(7 * 86400, { r: issued }) });
    }
    if (u.pathname === "/seller/refresh/") {
      if (opts.refreshFails) return json({ detail: "invalid" }, 401);
      const a = jwt(3600, { n: ++issued });
      return json({ access_token: a, refresh_token: jwt(7 * 86400, { r: issued }) });
    }
    if (opts.rejectAccessOnce && !rejected) {
      rejected = true;
      return json({ detail: "expired" }, 401);
    }
    if (!auth?.startsWith("JWT ")) return json({ detail: "no credentials" }, 401);
    valid.add(auth);
    if (u.pathname === "/seller/order_items/total-count/") return json({ total_count: opts.total ?? (opts.items ?? []).length });
    if (u.pathname === "/seller/order_items/") {
      const page = Number(u.searchParams.get("page"));
      const all = opts.items ?? [];
      return json({ order_items: all.slice((page - 1) * 100, page * 100) });
    }
    return json({ ok: true });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

await test("로그인은 email 필드 · access_token 을 JWT 헤더로 · 토큰 파일 600, 비밀번호 · 이메일 안 담김", async () => {
  const s = fakeAbly();
  await withFetch(s.fetchImpl, async () => (await ablyLogin()).get("/seller/coupons/"));
  assert.deepEqual(s.calls.map((c) => c.path), ["/seller/login/", "/seller/coupons/"]);
  assert.deepEqual(Object.keys(s.calls[0].body!).sort(), ["email", "password"]);
  assert.match(s.calls[1].auth!, /^JWT /);
  const file = process.env.ABLY_TOKEN_FILE!;
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes("seller@example.com") && !text.includes('"pw"'));
});

await test("다음 실행은 저장한 토큰을 그대로 (로그인 · 갱신 안 함)", async () => {
  const s = fakeAbly();
  await withFetch(s.fetchImpl, async () => (await ablyLogin()).get("/seller/coupons/"));
  assert.deepEqual(s.calls.map((c) => c.path), ["/seller/coupons/"]);
});

await test("401 이면 한 번만 refresh_token 으로 갱신해 다시 (로그인 안 함)", async () => {
  const s = fakeAbly({ rejectAccessOnce: true });
  await withFetch(s.fetchImpl, async () => (await ablyLogin()).get("/seller/coupons/"));
  assert.deepEqual(s.calls.map((c) => c.path), ["/seller/coupons/", "/seller/refresh/", "/seller/coupons/"]);
});

await test("refresh 가 안 되면 로그인 한 번", async () => {
  const s = fakeAbly({ rejectAccessOnce: true, refreshFails: true });
  await withFetch(s.fetchImpl, async () => (await ablyLogin()).get("/seller/coupons/"));
  assert.deepEqual(s.calls.map((c) => c.path), ["/seller/coupons/", "/seller/refresh/", "/seller/login/", "/seller/coupons/"]);
});

await test("비밀번호가 틀리면 알리고, 같은 비밀번호로는 6시간 쉼 · 고치면 바로 다시", async () => {
  process.env.ABLY_TOKEN_FILE = join(tmp, "t2.json");
  process.env.ABLY_PASSWORD = "wrong";
  const s1 = fakeAbly();
  await assert.rejects(withFetch(s1.fetchImpl, async () => (await ablyLogin()).get("/seller/coupons/")), /비밀번호 불일치/);
  assert.equal(s1.calls.filter((c) => c.path === "/seller/login/").length, 1, "필드를 바꿔 가며 다시 시도하지 않음");
  const s2 = fakeAbly();
  await assert.rejects(withFetch(s2.fetchImpl, async () => (await ablyLogin()).get("/seller/coupons/")), /잠시 쉬는 중/);
  assert.equal(s2.calls.length, 0, "30분 뒤 실행은 로그인 시도 안 함");
  process.env.ABLY_PASSWORD = "pw";
  const s3 = fakeAbly();
  await withFetch(s3.fetchImpl, async () => (await ablyLogin()).get("/seller/coupons/"));
  assert.ok(!JSON.parse(readFileSync(process.env.ABLY_TOKEN_FILE!, "utf8")).loginFail, "성공하면 실패 기록 지움");
});

await test("시험 실행(persist: false)은 토큰 파일을 만들지 않음", async () => {
  process.env.ABLY_TOKEN_FILE = join(tmp, "t3.json");
  const s = fakeAbly();
  await withFetch(s.fetchImpl, async () => (await ablyLogin({ persist: false })).get("/seller/coupons/"));
  assert.throws(() => statSync(process.env.ABLY_TOKEN_FILE!));
});

await test("주문은 페이지를 넘겨 다 받고 total-count 로 확인 · 구매자 정보는 버림", async () => {
  const raw = Array.from({ length: 150 }, (_, i) => ({ ...item("2026-10-27 10:00", 1000), sno: 10000 + i, buyer_name: "홍길동", buyer_phone: "010-0000-0000", receiver_address: "서울", memo: "문 앞" }));
  const s = fakeAbly({ items: raw });
  const got = await withFetch(s.fetchImpl, async () => fetchOrders(await ablyLogin(), "2026-10-27 00:00:00", "2026-10-27 23:59:59"));
  assert.equal(got.length, 150);
  assert.equal(s.calls.filter((c) => c.path === "/seller/order_items/").length, 2);
  assert.ok(!/홍길동|010-0000|서울|문 앞|buyer_|receiver_|memo/.test(JSON.stringify(got)));
  const short = fakeAbly({ items: raw.slice(0, 50), total: 80 });
  await assert.rejects(withFetch(short.fetchImpl, async () => fetchOrders(await ablyLogin(), "2026-10-27 00:00:00", "2026-10-27 23:59:59")), /건수가 안 맞아요/);
  assert.deepEqual(Object.keys(pickOrderItem({ sno: 1, buyer_name: "x" })).includes("buyer_name"), false);
});

await test("마켓별 계정(envSuffix) — ABLY_EMAIL_APT 로 로그인 · 토큰 파일 따로 · 계정 설정이 없으면 그 마켓만 오류", async () => {
  process.env.ABLY_EMAIL_APT = "apt@example.com";
  process.env.ABLY_PASSWORD_APT = "apw";
  const file = join(tmp, "apt-token.json");
  const calls: Record<string, unknown>[] = [];
  const f = (async (url: string, init?: { body?: string }) => {
    if (init?.body) calls.push(JSON.parse(init.body));
    if (new URL(url).pathname === "/seller/login/") return new Response(JSON.stringify({ access_token: jwt(3600), refresh_token: jwt(86400 * 7) }));
    return new Response("{}");
  }) as typeof fetch;
  await withFetch(f, async () => (await ablyLogin({ envSuffix: "_APT", tokenFile: file })).get("/seller/coupons/"));
  assert.deepEqual(calls[0], { email: "apt@example.com", password: "apw" });
  assert.ok(statSync(file).isFile());
  await assert.rejects(ablyLogin({ envSuffix: "_6A", tokenFile: join(tmp, "6a.json") }), /ABLY_EMAIL_6A/);
});

console.log(`\n결과: 통과 ${pass}${process.exitCode ? " · 실패 있음" : " · 실패 0"}`);
