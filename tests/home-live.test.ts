/**
 * 공홈 실시간 수집기(src/home-live.ts runLive) · 보고서 레포 커밋(src/reports-repo.ts commitFiles) 시험 — 네트워크 · 로그인 없이.
 *   npx tsx tests/home-live.test.ts
 * 식스샵 프로 주문 · 보고서 레포 · 광고비 · 원가 시트를 가짜로 바꿔 끼워 날짜 범위, 진행 중 표시, 바뀐 것만 올리기, 하루 한 번 8일 다시 계산,
 * liveSince 보호, 브랜드 하나 실패, 커밋 경합 재시도를 확인한다.
 */
import assert from "node:assert/strict";

process.env.HOME_LIVE_NO_MAIN = "1";
process.env.REPORTS_GITHUB_TOKEN = "test-token";
const { runLive } = await import("../src/home-live.js");
const { HOME_BRANDS } = await import("../src/home-brands.js");
const { commitFiles } = await import("../src/reports-repo.js");
type ProOrder = import("../src/home-report-pro.js").ProOrder;

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

const kstIso = (s: string) => new Date(Date.parse(`${s.replace(" ", "T")}:00+09:00`)).toISOString();
const at = (s: string) => Date.parse(`${s.replace(" ", "T")}:00+09:00`);
let seq = 0;
function order(o: { ordered: string; paid: string | null; payment?: string; market?: string; total: number; ship?: number; refund?: number; items: [string, number, number, string?][] }): ProOrder {
  return {
    id: `T${++seq}`,
    orderedAt: kstIso(o.ordered),
    paidAt: o.paid ? kstIso(o.paid) : null,
    payment: o.payment ?? "paid",
    market: o.market ?? "commerce",
    orderAmount: o.total - (o.ship ?? 0),
    deliveryFee: o.ship ?? 0,
    totalAmount: o.total,
    refundAmount: o.refund ?? 0,
    items: o.items.map(([name, qty, unitPrice, status], i) => ({ poid: `T${seq}-${i}`, name, qty, unitPrice, status: status ?? "purchaseConfirmed" })),
  };
}

// 10-26 · 10-27 주문 (KST)
const ORDERS: ProOrder[] = [
  order({ ordered: "2026-10-27 10:00", paid: "2026-10-27 10:00", total: 30000, ship: 3500, items: [["Bunny bag", 1, 26500]] }),
  order({ ordered: "2026-10-27 15:00", paid: "2026-10-27 15:01", market: "naver-pay", total: 20000, items: [["Mush bag", 1, 20000]] }),
  // 자정 직전 주문 → 다음 날 결제 = 결제일 10-27
  order({ ordered: "2026-10-26 23:50", paid: "2026-10-27 00:10", market: "naver-pay", total: 15000, items: [["Mush bag", 1, 15000]] }),
  order({ ordered: "2026-10-26 12:00", paid: "2026-10-26 12:00", total: 40000, ship: 3500, items: [["Bunny bag", 1, 36500]] }),
  order({ ordered: "2026-10-26 13:00", paid: "2026-10-26 13:00", payment: "cancelled", total: 9999, items: [["Bunny bag", 1, 9999, "cancelled"]] }),
  // 부분 환불: 두 개 중 하나 반품 완료 → 남은 상품 + 배송비
  order({ ordered: "2026-10-26 14:00", paid: "2026-10-26 14:00", payment: "partially-refunded", total: 53500, ship: 3500, refund: 25000,
    items: [["Bunny bag", 1, 25000], ["Mush bag", 1, 25000, "returnAccepted"]] }),
  // 입금 전 무통장 — 결제일 없음
  order({ ordered: "2026-10-27 09:00", paid: null, payment: "cancelled", total: 12000, items: [["Mush bag", 1, 12000, "cancelled"]] }),
];

function fakes(opts: { nowMs: number; repo?: Map<string, unknown>; failStore?: string } ) {
  const repo = opts.repo ?? new Map<string, unknown>();
  const calls = { orders: [] as { store: string; fromIso: string; toIso: string }[], commits: [] as { paths: string[]; message: string }[], logs: [] as string[] };
  const costs = async () => [{ name: "Bunny bag", cost: 5000, table: "A" as const }, { name: "Mush bag", cost: 4000, table: "A" as const }];
  const brands = {
    ...Object.fromEntries(Object.entries(HOME_BRANDS).map(([id, b]) => [id, { ...b, loadCosts: costs, makeMatcher: undefined, costMatch: undefined, unitsPerLine: undefined }])),
    // 원가 시트가 없는 브랜드
    zz: { ...HOME_BRANDS.kop, name: "시험", proStore: "zzstore", noCostSheet: true, loadCosts: async () => [] },
  };
  return {
    repo, calls,
    deps: {
      nowMs: opts.nowMs,
      orders: async (store: string, fromIso: string, toIso: string) => {
        calls.orders.push({ store, fromIso, toIso });
        if (store === opts.failStore) throw new Error("가짜 로그인 실패");
        return ORDERS.filter((o) => o.orderedAt >= fromIso && o.orderedAt <= toIso);
      },
      getJson: async <T,>(path: string) => (repo.has(path) ? (JSON.parse(JSON.stringify(repo.get(path))) as T) : null),
      commit: async (files: { path: string; content: unknown }[], message: string) => {
        calls.commits.push({ paths: files.map((f) => f.path), message });
        for (const f of files) repo.set(f.path, JSON.parse(JSON.stringify(f.content)));
        return "abc1234def";
      },
      loadAd: async (_brand: string, date: string) =>
        date === "2026-10-27" ? { spend: 10000, order_price: null, basis: "메타 추정", estimated: true } : { spend: 20000, order_price: 50000, basis: "광고 시트" },
      brands,
      log: (l: string) => calls.logs.push(l),
    },
  };
}
type Rep = { as_of?: string; assumptions: Record<string, unknown>; summary: Record<string, number> };
type Idx = { days: { date: string; as_of?: string; paid: number }[] };

console.log("공홈 실시간 수집기 (runLive)");
const repo = new Map<string, unknown>();
repo.set("home/kop/index.json", { days: [{ date: "2026-09-06", orders: 1, paid: 1, net: 1, ad_spend: 0, coupon_orders: 0, cost: 0 }] });

await test("오늘 · 어제 계산, 주문은 가장 오래된 날 이틀 앞부터 지금까지", async () => {
  const f = fakes({ nowMs: at("2026-10-27 15:30"), repo });
  const r = await runLive({ days: null, brands: ["kop"], dry: false, state: { settled: "2026-10-27" } }, f.deps);
  assert.deepEqual(r.dates, ["2026-10-27", "2026-10-26"]);
  assert.equal(r.settle, false);
  assert.equal(f.calls.orders[0].store, "coferry");
  assert.equal(f.calls.orders[0].fromIso, "2026-10-23T15:00:00.000Z"); // 10-24 00:00 KST
  assert.equal(f.calls.orders[0].toIso, new Date(at("2026-10-27 15:30")).toISOString());
  assert.equal(f.calls.commits.length, 1, "커밋 하나");
  assert.deepEqual(f.calls.commits[0].paths.sort(), ["home/kop/daily/2026-10-26.json", "home/kop/daily/2026-10-27.json", "home/kop/index.json"]);
});

await test("결제일 기준 금액 — 자정 넘긴 결제 · 취소 · 부분 환불 · 입금 전", () => {
  const d27 = repo.get("home/kop/daily/2026-10-27.json") as Rep;
  const d26 = repo.get("home/kop/daily/2026-10-26.json") as Rep;
  assert.equal(d27.summary.orders, 3);
  assert.equal(d27.summary.paid, 65000);
  assert.equal(d27.summary.naverpay_orders, 2);
  assert.equal(d26.summary.orders, 2);
  assert.equal(d26.summary.paid, 40000 + 28500); // 부분 환불 = 53,500 − 25,000
  assert.equal(d26.summary.cost, 5000 + 5000);
});

await test("오늘 보고서만 진행 중 표시 (as_of · partial_day) · 메타 추정 광고비 표시", () => {
  const d27 = repo.get("home/kop/daily/2026-10-27.json") as Rep;
  const d26 = repo.get("home/kop/daily/2026-10-26.json") as Rep;
  assert.equal(d27.as_of, "15:30");
  assert.equal(d27.assumptions.partial_day, true);
  assert.equal(d27.assumptions.ad_estimated, true);
  assert.equal(d26.as_of, undefined);
  assert.equal(d26.assumptions.partial_day, undefined);
  const idx = repo.get("home/kop/index.json") as Idx;
  assert.deepEqual(idx.days.map((d) => d.date), ["2026-10-27", "2026-10-26", "2026-09-06"], "지난 줄 유지 · 최신부터");
  assert.equal(idx.days[0].as_of, "15:30");
  assert.equal(idx.days[1].as_of, undefined);
});

await test("10분 뒤 같은 숫자면 커밋 안 함", async () => {
  const f = fakes({ nowMs: at("2026-10-27 15:40"), repo });
  await runLive({ days: null, brands: ["kop"], dry: false, state: { settled: "2026-10-27" } }, f.deps);
  assert.equal(f.calls.commits.length, 0);
});

await test("55분 넘게 지나면 오늘 보고서만 시각을 새로 올림", async () => {
  const f = fakes({ nowMs: at("2026-10-27 16:30"), repo });
  await runLive({ days: null, brands: ["kop"], dry: false, state: { settled: "2026-10-27" } }, f.deps);
  assert.equal(f.calls.commits.length, 1);
  assert.deepEqual(f.calls.commits[0].paths.sort(), ["home/kop/daily/2026-10-27.json", "home/kop/index.json"]);
  assert.equal((repo.get("home/kop/daily/2026-10-27.json") as Rep).as_of, "16:30");
});

await test("자정이 지나면 어제가 된 보고서에서 진행 중 표시가 빠짐", async () => {
  const f = fakes({ nowMs: at("2026-10-28 00:10"), repo });
  const r = await runLive({ days: null, brands: ["kop"], dry: false, state: { settled: "2026-10-27" } }, f.deps);
  assert.deepEqual(r.dates, ["2026-10-28", "2026-10-27"]);
  assert.equal(r.settle, false, "06시 전엔 8일 다시 계산 안 함");
  const d27 = repo.get("home/kop/daily/2026-10-27.json") as Rep;
  assert.equal(d27.as_of, undefined);
  assert.equal(d27.assumptions.partial_day, undefined);
  const idx = repo.get("home/kop/index.json") as Idx;
  assert.equal(idx.days.find((d) => d.date === "2026-10-27")?.as_of, undefined);
  assert.equal(idx.days[0].date, "2026-10-28");
  assert.equal(idx.days[0].as_of, "00:10");
});

await test("06시 이후 첫 실행은 지난 8일 (liveSince 전 날짜는 안 건드림)", async () => {
  const f = fakes({ nowMs: at("2026-10-28 06:30") });
  const r = await runLive({ days: null, brands: ["kop", "apt"], dry: false, state: { settled: "2026-10-27" } }, f.deps);
  assert.equal(r.settle, true);
  assert.equal(r.dates.length, 8);
  assert.equal(r.dates[7], "2026-10-21");
  const paths = f.calls.commits[0].paths;
  assert.ok(paths.includes("home/kop/daily/2026-10-21.json"), "코페리는 10-20 부터라 10-21 포함");
  assert.ok(!paths.some((p) => p.startsWith("home/apt/daily/2026-10-21")), "아페티는 10-22 부터");
  assert.ok(paths.includes("home/apt/daily/2026-10-22.json"));
  assert.equal(f.calls.orders[0].fromIso, "2026-10-18T15:00:00.000Z"); // 10-19 00:00 KST
});

await test("그날 이미 다시 계산했으면 오늘 · 어제만", async () => {
  const f = fakes({ nowMs: at("2026-10-28 07:00") });
  const r = await runLive({ days: null, brands: ["kop"], dry: false, state: { settled: "2026-10-28" } }, f.deps);
  assert.equal(r.settle, false);
  assert.equal(r.dates.length, 2);
});

await test("브랜드 하나가 실패해도 나머지는 올리고 실패를 알림", async () => {
  const f = fakes({ nowMs: at("2026-10-27 15:30"), failStore: "apeti" });
  const r = await runLive({ days: null, brands: ["kop", "apt"], dry: false, state: { settled: "2026-10-27" } }, f.deps);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /아페티/);
  assert.ok(f.calls.commits[0].paths.every((p) => p.startsWith("home/kop/")));
});

await test("광고 시트 · 메타 둘 다 없는 날은 전에 올린 메타 추정값을 그대로 둠", async () => {
  const r2 = new Map<string, unknown>();
  // 어제(10-27)일 때 메타로 추정해 올려 둔 보고서
  const f1 = fakes({ nowMs: at("2026-10-28 09:00"), repo: r2 });
  f1.deps.loadAd = async (_b: string, date: string) =>
    date === "2026-10-27" ? { spend: 777000, order_price: 900000, basis: "메타 광고 데이터로 추정 (10/28 09:00 기준)", estimated: true } : { spend: null, order_price: null, basis: "광고 시트 — 못 읽음 (HTTP 404)" };
  await runLive({ days: 2, brands: ["kop"], dry: false, state: {} }, f1.deps);
  assert.equal((r2.get("home/kop/daily/2026-10-27.json") as Rep).summary.ad_spend, 777000);
  // 이틀 뒤 8일 다시 계산 — 10-27 은 메타 데이터 범위 밖이고 광고 시트도 없음
  const f2 = fakes({ nowMs: at("2026-10-30 06:30"), repo: r2 });
  f2.deps.loadAd = async () => ({ spend: null, order_price: null, basis: "광고 시트 — 못 읽음 (HTTP 404)" });
  await runLive({ days: null, brands: ["kop"], dry: false, state: { settled: "2026-10-29" } }, f2.deps);
  const d27 = r2.get("home/kop/daily/2026-10-27.json") as Rep;
  assert.equal(d27.summary.ad_spend, 777000);
  assert.equal(d27.assumptions.ad_estimated, true);
});

await test("GitHub 읽기가 잠깐 실패하면 그 브랜드는 아무것도 안 올림 (index 를 비운 채 덮어쓰지 않음)", async () => {
  const r4 = new Map<string, unknown>();
  r4.set("home/kop/index.json", { days: Array.from({ length: 20 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, orders: 1, paid: 1, net: 1, ad_spend: 0, coupon_orders: 0, cost: 0 })) });
  const f = fakes({ nowMs: at("2026-10-27 15:30"), repo: r4 });
  f.deps.getJson = async <T,>(path: string) => {
    if (path.endsWith("index.json")) throw new Error("GitHub GET home/kop/index.json → 503");
    return (r4.has(path) ? r4.get(path) : null) as T | null;
  };
  const r = await runLive({ days: 2, brands: ["kop", "apt"], dry: false, state: {} }, f.deps);
  assert.equal(r.failed.length, 2);
  assert.equal(f.calls.commits.length, 0);
  assert.equal((r4.get("home/kop/index.json") as { days: unknown[] }).days.length, 20);
});

await test("광고 시트를 못 읽은 날은 올라가 있던 광고비(시트 값)를 그대로 두고 degraded 로 알림", async () => {
  const r5 = new Map<string, unknown>();
  const f1 = fakes({ nowMs: at("2026-10-27 23:00"), repo: r5 });
  f1.deps.loadAd = async () => ({ spend: 896750, order_price: 2824100, basis: "오피스 광고 시트" });
  await runLive({ days: 2, brands: ["kop"], dry: false, state: {} }, f1.deps);
  const f2 = fakes({ nowMs: at("2026-10-28 06:30"), repo: r5 });
  f2.deps.loadAd = async () => ({ spend: null, order_price: null, basis: "오피스 광고 시트 — 못 읽음 (HTTP 503)", unavailable: true });
  const r = await runLive({ days: null, brands: ["kop"], dry: false, state: { settled: "2026-10-27" } }, f2.deps);
  const d26 = r5.get("home/kop/daily/2026-10-26.json") as Rep;
  assert.equal(d26.summary.ad_spend, 896750);
  assert.equal(d26.assumptions.ad_basis, "오피스 광고 시트");
  assert.ok(r.degraded.length > 0);
  const { settleDone } = await import("../src/home-live.js");
  assert.equal(settleDone(r, Object.keys(HOME_BRANDS), false), false, "못 읽은 원본이 있으면 재계산 완료로 안 침");
});

await test("메타 추정이 0원이어도 그 날이 메타 범위를 벗어나면 0원 추정을 그대로 둠", async () => {
  const r6 = new Map<string, unknown>();
  const f1 = fakes({ nowMs: at("2026-10-27 23:00"), repo: r6 });
  f1.deps.loadAd = async () => ({ spend: 0, order_price: 0, basis: "메타 광고 데이터로 추정", estimated: true });
  await runLive({ days: 2, brands: ["kop"], dry: false, state: {} }, f1.deps);
  const f2 = fakes({ nowMs: at("2026-10-29 06:30"), repo: r6 });
  f2.deps.loadAd = async () => ({ spend: null, order_price: null, basis: "오피스 광고 시트 — 광고 시트 없음" });
  await runLive({ days: null, brands: ["kop"], dry: false, state: { settled: "2026-10-28" } }, f2.deps);
  const d26 = r6.get("home/kop/daily/2026-10-26.json") as Rep;
  assert.equal(d26.assumptions.ad_estimated, true);
  assert.equal(d26.assumptions.ad_basis, "메타 광고 데이터로 추정");
});

await test("하루 한 번 재계산 완료는 전 브랜드 · 실패 없음 · 시험 실행 아닐 때만", async () => {
  const { settleDone } = await import("../src/home-live.js");
  const ok = { dates: ["2026-10-28"], settle: true, committed: [], failed: [], degraded: [] };
  const all = Object.keys(HOME_BRANDS);
  assert.equal(settleDone(ok, all, false), true);
  assert.equal(settleDone(ok, ["kop"], false), false, "--brands 일부만");
  assert.equal(settleDone(ok, all, true), false, "--dry");
  assert.equal(settleDone({ ...ok, failed: ["x"] }, all, false), false);
  assert.equal(settleDone({ ...ok, settle: false }, all, false), false);
});

await test("원가 시트가 없는 브랜드는 원가 미반영 (0원으로 빼지 않음)", async () => {
  const r3 = new Map<string, unknown>();
  const f = fakes({ nowMs: at("2026-10-27 15:30"), repo: r3 });
  await runLive({ days: 2, brands: ["zz"], dry: false, state: {} }, f.deps);
  const d26 = r3.get("home/zz/daily/2026-10-26.json") as Rep & { orders: { cost_match: unknown }[] };
  assert.equal(d26.summary.cost, null);
  assert.equal(d26.summary.cost_missing_items, 0);
  assert.equal(d26.orders[0].cost_match, null);
  assert.equal((r3.get("home/zz/index.json") as { days: { cost: unknown }[] }).days[0].cost, null);
  assert.equal(f.calls.orders[0].store, "zzstore");
});

await test("--dry 는 읽기 · 커밋 없음", async () => {
  const f = fakes({ nowMs: at("2026-10-27 15:30") });
  let reads = 0;
  const deps = { ...f.deps, getJson: async () => { reads++; return null; } };
  await runLive({ days: 2, brands: ["kop"], dry: true, state: {} }, deps);
  assert.equal(reads, 0);
  assert.equal(f.calls.commits.length, 0);
});

console.log("보고서 레포 커밋 (commitFiles)");
await test("파일 여러 개를 커밋 하나로 — 다른 커밋이 먼저 올라가면 새 HEAD 위에 다시", async () => {
  const seen: string[] = [];
  let heads = ["h1", "h2"];
  let patches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url).replace("https://api.github.com/repos/j65209/brightbeed-reports/git", "");
    const m = init?.method ?? "GET";
    seen.push(`${m} ${u}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (m === "GET" && u === "/ref/heads/main") return json({ object: { sha: heads[0] } });
    if (m === "GET" && u.startsWith("/commits/")) return json({ tree: { sha: `tree-of-${u.slice(9)}` } });
    if (m === "POST" && u === "/trees") {
      const b = JSON.parse(init!.body!);
      assert.equal(b.tree.length, 2);
      assert.equal(b.tree[0].mode, "100644");
      return json({ sha: `t-${b.base_tree}` }, 201);
    }
    if (m === "POST" && u === "/commits") return json({ sha: `c-${JSON.parse(init!.body!).parents[0]}` }, 201);
    if (m === "PATCH" && u === "/refs/heads/main") {
      patches++;
      if (patches === 1) { heads = heads.slice(1); return json({ message: "Update is not a fast forward" }, 422); }
      return json({ object: { sha: JSON.parse(init!.body!).sha } });
    }
    return json({ message: "unexpected" }, 500);
  }) as typeof fetch;
  try {
    const sha = await commitFiles([{ path: "home/kop/a.json", content: { a: 1 } }, { path: "home/kop/b.json", content: { b: 2 } }], "msg");
    assert.equal(sha, "c-h2", "두 번째 시도는 새 HEAD(h2) 위에");
    assert.equal(patches, 2);
    assert.ok(seen.includes("POST /trees"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("커밋할 파일이 없으면 GitHub 안 부름", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  try {
    assert.equal(await commitFiles([], "msg"), null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n결과: 통과 ${pass}${process.exitCode ? " · 실패 있음" : " · 실패 0"}`);
