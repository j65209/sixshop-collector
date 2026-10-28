/**
 * 에이블리 실시간 수집기(src/ably-live.ts runAblyLive) · 로그인 토큰(src/ably-api.ts ablyLogin) 시험 — 네트워크 · 계정 없이.
 *   npx tsx tests/ably-live.test.ts
 * 에이블리 API · 보고서 레포 · 원가 시트를 가짜로 바꿔 끼워 날짜 범위, 오늘만 진행 중 표시, 자정 넘기기, 바뀐 것만 올리기, 55분 규칙,
 * 하루 한 번 8일 다시 계산, 읽기 실패 시 아무것도 안 올리기, 개인정보 빼기, 토큰 저장 · 갱신 · 로그인 실패 쉬기를 확인한다.
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
const { runAblyLive } = await import("../src/ably-live.js");
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
function item(checked: string, paid: number, o: { order?: number; status?: string; coupon?: number; name?: string } = {}): AblyOrderItem {
  seq++;
  return {
    sno: seq, order_sno: o.order ?? seq, ea: 1, status: o.status ?? "배송중", ordered_at: checked.slice(0, 16), checked_at: `${checked}:00`,
    goods_sno: 1, goods_name: o.name ?? "Bunny bag", goods_custom_code: null, option_info: "black", price: paid + (o.coupon ?? 0),
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

function fakes(opts: { nowMs: number; repo?: Map<string, unknown>; items?: AblyOrderItem[]; failGet?: boolean; failOrders?: boolean }) {
  const repo = opts.repo ?? new Map<string, unknown>();
  const calls = { orders: [] as [string, string][], fees: [] as [string, string][], ad: [] as [string, string][], gets: [] as string[], commits: [] as { paths: string[]; message: string }[], logs: [] as string[] };
  const items = opts.items ?? ITEMS;
  return {
    repo, calls,
    deps: {
      nowMs: opts.nowMs,
      orders: async (start: string, end: string) => {
        calls.orders.push([start, end]);
        if (opts.failOrders) throw new Error("GET /seller/order_items/ → 500");
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
      loadCosts: async () => [{ name: "Bunny bag", cost: 5000, table: "A" as const }],
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
  const r = await runAblyLive({ days: null, dry: false, state: settledToday("2026-10-27") }, f.deps);
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
  const r = await runAblyLive({ days: null, dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.equal(f.calls.commits.length, 0);
  assert.deepEqual(r.committed, []);
  assert.ok(f.calls.logs.some((l) => l.includes("바뀐 보고서 없음")));
});

await test("55분이 지나면 숫자가 그대로여도 오늘 보고서 시각만 새로 (어제는 안 건드림)", async () => {
  const f = fakes({ nowMs: at("2026-10-27 16:26"), repo });
  await runAblyLive({ days: null, dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.equal(f.calls.commits.length, 1);
  assert.deepEqual(f.calls.commits[0].paths.sort(), ["ably/daily/2026-10-27.json", "ably/index.json"]);
  assert.equal((repo.get("ably/daily/2026-10-27.json") as Rep).as_of, "16:26");
});

await test("새 주문이 들어오면 오늘만 올림", async () => {
  const f = fakes({ nowMs: at("2026-10-27 16:40"), repo, items: [...ITEMS, item("2026-10-27 16:35", 7000)] });
  await runAblyLive({ days: null, dry: false, state: settledToday("2026-10-27") }, f.deps);
  assert.deepEqual(f.calls.commits[0].paths.sort(), ["ably/daily/2026-10-27.json", "ably/index.json"]);
  assert.equal((repo.get("ably/daily/2026-10-27.json") as Rep).summary.paid, 47000);
});

await test("자정이 지나면 어제(10-27) 보고서는 진행 중 표시 없이 다시 올라감", async () => {
  const items = [...ITEMS, item("2026-10-27 16:35", 7000)];
  const f = fakes({ nowMs: at("2026-10-28 00:10"), repo, items });
  // 06시 전이라 하루 한 번 재계산 아님
  const r = await runAblyLive({ days: null, dry: false, state: settledToday("2026-10-27") }, f.deps);
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
  const r = await runAblyLive({ days: null, dry: true, state: settledToday("2026-10-02") }, f.deps);
  assert.equal(r.settle, true);
  assert.equal(r.dates.length, 8);
  assert.equal(r.dates[7], "2026-09-26");
  assert.deepEqual(f.calls.orders, [["2026-09-26 00:00:00", "2026-10-03 06:10:00"]]);
  assert.deepEqual(f.calls.fees.sort(), [["2026-07", "2026-09"], ["2026-08", "2026-10"]]);
  const before6 = await runAblyLive({ days: null, dry: true, state: settledToday("2026-10-02") }, fakes({ nowMs: at("2026-10-03 05:50") }).deps);
  assert.equal(before6.dates.length, 2);
  const done = await runAblyLive({ days: null, dry: true, state: settledToday("2026-10-03") }, fakes({ nowMs: at("2026-10-03 07:00") }).deps);
  assert.equal(done.settle, false);
  assert.equal(done.dates.length, 2);
  const nDays = await runAblyLive({ days: 5, dry: true, state: {} }, fakes({ nowMs: at("2026-10-03 07:00") }).deps);
  assert.equal(nDays.settle, false, "--days 는 하루 한 번 기록과 상관없음");
  assert.equal(nDays.dates.length, 5);
});

await test("--dry 는 보고서 레포를 읽지도 쓰지도 않음", async () => {
  const f = fakes({ nowMs: at("2026-10-27 15:30") });
  await runAblyLive({ days: null, dry: true, state: {} }, f.deps);
  assert.equal(f.calls.gets.length, 0);
  assert.equal(f.calls.commits.length, 0);
});

await test("GitHub 읽기 실패 · 에이블리 받기 실패면 아무것도 안 올리고 실패", async () => {
  const r1 = new Map(repo);
  const f1 = fakes({ nowMs: at("2026-10-28 09:00"), repo: r1, failGet: true });
  await assert.rejects(runAblyLive({ days: null, dry: false, state: settledToday("2026-10-28") }, f1.deps), /GitHub GET/);
  assert.equal(f1.calls.commits.length, 0);
  const f2 = fakes({ nowMs: at("2026-10-28 09:00"), repo: r1, failOrders: true });
  await assert.rejects(runAblyLive({ days: null, dry: false, state: settledToday("2026-10-28") }, f2.deps), /order_items/);
  assert.equal(f2.calls.commits.length, 0);
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

console.log(`\n결과: 통과 ${pass}${process.exitCode ? " · 실패 있음" : " · 실패 0"}`);
