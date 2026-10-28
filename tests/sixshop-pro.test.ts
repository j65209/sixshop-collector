/**
 * 식스샵 프로 로그인 · 상점 전환 · 주문 받기(src/sixshop-pro.ts · src/sixshop-pro-orders.ts) 시험 — 가짜 서버로, 진짜 계정 없이.
 *   npx tsx tests/sixshop-pro.test.ts
 * 요청 주소 · 본문 · 헤더 7개, 상점 토큰 저장 · 다시 쓰기, 토큰이 안 먹을 때 한 번 다시 받기, 페이지 넘기기, 개인정보 빼기,
 * Access Key(공식 Open API) 상점은 로그인 없이 받는지 확인한다.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sixshop-pro-test-"));
process.env.SIXSHOP_PRO_TOKEN_FILE = join(dir, "tokens.json");
process.env.SIXSHOP_PRO_EMAIL = "owner@example.com";
process.env.SIXSHOP_PRO_PASSWORD = "pw";
delete process.env.SIXSHOP_PRO_LOGIN_TYPE;
const { proLogin } = await import("../src/sixshop-pro.js");

let pass = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${(e as Error).message.split("\n").join("\n       ")}`);
    process.exitCode = 1;
  }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (store: string, days = 30) => `${b64({ alg: "HS256" })}.${b64({ storeName: store, exp: Math.floor(Date.now() / 1000) + days * 86400 })}.sig`;

interface Call { method: string; path: string; body?: Record<string, unknown>; headers: Record<string, string> }
// 서버가 발급한 상점 토큰 — 실행(가짜 서버 인스턴스)이 바뀌어도 유효 (진짜 서버처럼)
const issued: Record<string, string> = {};
function fakeServer(opts: { rejectTokenOnce?: string } = {}) {
  const calls: Call[] = [];
  const rejected = new Set<string>();
  const fetchImpl = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { method: init?.method ?? "GET", path: u.pathname, body: init?.body ? JSON.parse(init.body) : undefined, headers };
    calls.push(call);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.pathname === "/v1/api/account/sign-in") {
      if (call.body?.accountId !== "owner@example.com" || call.body?.password !== "pw") return json({ statusCode: 400, code: "SM-LOGIN-007", message: "비밀번호가 틀렸습니다." }, 400);
      issued["6ashop"] = jwt("6ashop");
      return json({ code: 200, data: { selltore: { userToken: issued["6ashop"], ownerId: 777, currentStore: { name: "6ashop" }, stores: [{ storeName: "6ashop" }, { storeName: "coferry" }] }, meta: {} } });
    }
    if (u.pathname === "/v1/api/owner/auth/store") {
      if (headers.authorization !== `Bearer ${issued["6ashop"]}` || headers["ss-store-id"] !== "6ashop") return json({ statusCode: 401, message: "no" }, 401);
      const s = String(call.body?.storeName);
      issued[s] = jwt(s);
      return json({ code: 200, data: { ownerId: 777, storeName: s, userToken: issued[s] } });
    }
    // 공식 Open API (api.sixshop.io) — Access Key 헤더, 응답이 data 로 안 싸여 있음
    const open = u.host === "api.sixshop.io" && u.pathname === "/order-integration/v2/orders";
    if (u.pathname === "/call/order-integration/v2/orders" || open) {
      const store = headers["ss-store-id"];
      if (open && headers["authorization-core"] !== `key-${store}`) return json({ message: "invalid key" }, 401);
      if (!open && headers.authorization !== `Bearer ${issued[store]}`) return json({ statusCode: 400, message: "store mismatch" }, 400);
      if (opts.rejectTokenOnce === store && !rejected.has(store)) {
        rejected.add(store);
        return json({ statusCode: 401, message: "expired" }, 401);
      }
      const page = Number(u.searchParams.get("page"));
      const mk = (n: number) => ({
        order: { orderId: `${store}-${n}`, orderedAt: "2026-10-27T01:00:00.000Z", paidAt: "2026-10-27T01:00:00.000Z", paymentStatus: "paid", marketCode: "naver-pay", orderAmount: 10000, deliveryFee: 3000, totalAmount: 13000,
          ordererName: "홍길동", ordererTel: "010-0000-0000", receiverAddress: "서울" },
        productOrders: [{ productOrderId: `${store}-${n}-1`, productName: "Bunny bag", productOptionDisplayName: "색상: black", quantity: 1, unitPrice: 10000, status: "purchaseConfirmed",
          productAdditionalOptions: [{ name: "각인", value: "개인 메모" }] }],
      });
      const body = { list: page === 1 ? [mk(1), mk(2)] : [mk(3)], pagination: { totalPages: 2, totalItems: 3 } };
      return json(open ? body : { code: 200, data: body });
    }
    return json({ message: "unexpected" }, 500);
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

console.log("식스샵 프로 로그인 · 주문 (sixshop-pro)");

await test("소유자 로그인 1번 → 상점 전환 → 주문 (헤더 7개 · 두 페이지)", async () => {
  const s = fakeServer();
  const orders = await withFetch(s.fetchImpl, async () => (await proLogin()).orders("coferry", "2026-10-24T15:00:00.000Z", "2026-10-27T06:30:00.000Z"));
  assert.equal(orders.length, 3);
  const paths = s.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, ["POST /v1/api/account/sign-in", "POST /v1/api/owner/auth/store", "GET /call/order-integration/v2/orders", "GET /call/order-integration/v2/orders"]);
  assert.deepEqual(s.calls[0].body, { accountId: "owner@example.com", password: "pw" });
  assert.deepEqual(s.calls[1].body, { storeName: "coferry" });
  const h = s.calls[2].headers;
  for (const k of ["authorization", "x-sixshop-metadata-usertoken", "ss-user-token", "x-sixshop-metadata-storeid", "ss-store-id", "x-sixshop-metadata-userid", "ss-user-id"]) assert.ok(h[k], `헤더 ${k}`);
  assert.equal(h["ss-store-id"], "coferry");
  assert.equal(h["ss-user-id"], "777");
  assert.equal(h["x-sixshop-metadata-usertoken"], h.authorization.replace("Bearer ", ""));
  assert.equal(h.origin, "https://store.sixshop.com");
});

await test("주문에는 구매자 정보 · 추가(작성형) 옵션이 안 담김", async () => {
  const s = fakeServer();
  const orders = await withFetch(s.fetchImpl, async () => (await proLogin()).orders("coferry", "2026-10-24T15:00:00.000Z", "2026-10-27T06:30:00.000Z"));
  const text = JSON.stringify(orders);
  assert.ok(!/홍길동|010-0000|서울|개인 메모/.test(text), text.slice(0, 200));
  assert.equal(orders[0].items[0].optDisplay, "색상: black");
});

await test("받아 둔 상점 토큰은 다음 실행에 다시 씀 (로그인 안 함) · 파일 권한 600", async () => {
  const s = fakeServer();
  await withFetch(s.fetchImpl, async () => (await proLogin()).orders("coferry", "2026-10-24T15:00:00.000Z", "2026-10-27T06:30:00.000Z"));
  assert.ok(!s.calls.some((c) => c.path.includes("sign-in") || c.path.includes("auth/store")), s.calls.map((c) => c.path).join(","));
  if (process.platform !== "win32") assert.equal(statSync(process.env.SIXSHOP_PRO_TOKEN_FILE!).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(process.env.SIXSHOP_PRO_TOKEN_FILE!, "utf8"));
  assert.ok(saved.stores.coferry.exp > Date.now());
  assert.ok(!JSON.stringify(saved).includes("owner@example.com"), "이메일은 해시로만");
  assert.ok(!JSON.stringify(saved).includes('"pw"'), "비밀번호 없음");
});

await test("토큰이 안 먹으면(401) 한 번만 새로 받아 다시", async () => {
  const s = fakeServer({ rejectTokenOnce: "coferry" });
  // 서버가 새로 발급한 토큰만 받으므로, 저장된 토큰은 지금 서버에선 400 → 새로 로그인
  const orders = await withFetch(s.fetchImpl, async () => (await proLogin()).orders("coferry", "2026-10-24T15:00:00.000Z", "2026-10-27T06:30:00.000Z"));
  assert.equal(orders.length, 3);
  assert.equal(s.calls.filter((c) => c.path.includes("sign-in")).length, 1, "로그인 한 번");
});

await test("상점 셋을 받아도 로그인은 한 번", async () => {
  const s = fakeServer();
  process.env.SIXSHOP_PRO_TOKEN_FILE = join(dir, "tokens2.json");
  await withFetch(s.fetchImpl, async () => {
    const pro = await proLogin();
    for (const st of ["coferry", "apeti", "cos-mi"]) await pro.orders(st, "2026-10-24T15:00:00.000Z", "2026-10-27T06:30:00.000Z");
  });
  assert.equal(s.calls.filter((c) => c.path.includes("sign-in")).length, 1);
  assert.equal(s.calls.filter((c) => c.path.includes("auth/store")).length, 3);
});

const R = ["2026-10-24T15:00:00.000Z", "2026-10-27T06:30:00.000Z"] as const;

await test("비밀번호가 틀리면 서버 메시지를 알리고, 같은 비밀번호로는 6시간 쉼 · 고치면 바로 다시", async () => {
  process.env.SIXSHOP_PRO_TOKEN_FILE = join(dir, "tokens3.json");
  process.env.SIXSHOP_PRO_PASSWORD = "wrong";
  const s1 = fakeServer();
  await assert.rejects(withFetch(s1.fetchImpl, async () => (await proLogin()).orders("coferry", ...R)), /비밀번호가 틀렸습니다/);
  const s2 = fakeServer();
  await assert.rejects(withFetch(s2.fetchImpl, async () => (await proLogin()).orders("coferry", ...R)), /잠시 쉬는 중/);
  assert.equal(s2.calls.length, 0, "30분 뒤 실행은 로그인 시도 안 함");
  process.env.SIXSHOP_PRO_PASSWORD = "pw";
  const s3 = fakeServer();
  const orders = await withFetch(s3.fetchImpl, async () => (await proLogin()).orders("coferry", ...R));
  assert.equal(orders.length, 3, "비밀번호를 고치면 바로 다시 로그인");
  assert.ok(!JSON.parse(readFileSync(process.env.SIXSHOP_PRO_TOKEN_FILE!, "utf8")).loginFail, "성공하면 실패 기록 지움");
});

await test(".env 계정이 바뀌면 받아 둔 토큰을 버리고 새로 로그인", async () => {
  process.env.SIXSHOP_PRO_TOKEN_FILE = join(dir, "tokens4.json");
  const s1 = fakeServer();
  await withFetch(s1.fetchImpl, async () => (await proLogin()).orders("coferry", ...R));
  process.env.SIXSHOP_PRO_EMAIL = "other@example.com";
  const s2 = fakeServer();
  await assert.rejects(withFetch(s2.fetchImpl, async () => (await proLogin()).orders("coferry", ...R)), /비밀번호가 틀렸습니다/);
  assert.equal(s2.calls[0].path, "/v1/api/account/sign-in", "옛 토큰을 쓰지 않고 새 계정으로 로그인");
  process.env.SIXSHOP_PRO_EMAIL = "owner@example.com";
});

await test("시험 실행(persist: false)은 토큰 파일을 만들지 않음", async () => {
  process.env.SIXSHOP_PRO_TOKEN_FILE = join(dir, "tokens5.json");
  const s = fakeServer();
  await withFetch(s.fetchImpl, async () => (await proLogin({ persist: false })).orders("coferry", ...R));
  assert.throws(() => statSync(process.env.SIXSHOP_PRO_TOKEN_FILE!));
});

await test("토큰 재사용 규칙 — 30일 토큰은 하루 남을 때까지, 만료를 모르면 7일, 짧은 토큰은 수명의 1/4 남을 때까지", async () => {
  const { tokenUsable } = await import("../src/sixshop-pro.js");
  const now = Date.now();
  const H = 3600_000;
  assert.equal(tokenUsable({ token: "t", userId: "1", exp: now + 29 * 24 * H, fetchedAt: now - 24 * H }, now), true);
  assert.equal(tokenUsable({ token: "t", userId: "1", exp: now + 20 * H, fetchedAt: now - 29 * 24 * H }, now), false);
  assert.equal(tokenUsable({ token: "t", userId: "1", exp: null, fetchedAt: now - 6 * 24 * H }, now), true);
  assert.equal(tokenUsable({ token: "t", userId: "1", exp: null, fetchedAt: now - 8 * 24 * H }, now), false);
  // 20시간짜리 토큰: 받은 지 30분 → 남은 19.5시간 > 5시간 → 다시 씀
  assert.equal(tokenUsable({ token: "t", userId: "1", exp: now + 19.5 * H, fetchedAt: now - 0.5 * H }, now), true);
});

await test("Access Key 상점은 로그인 · 토큰 파일 없이 Open API 로 (헤더 2개 · 두 페이지 · 개인정보 빼기)", async () => {
  process.env.SIXSHOP_PRO_TOKEN_FILE = join(dir, "tokens6.json");
  const saved = { email: process.env.SIXSHOP_PRO_EMAIL, pw: process.env.SIXSHOP_PRO_PASSWORD };
  delete process.env.SIXSHOP_PRO_EMAIL;
  delete process.env.SIXSHOP_PRO_PASSWORD;
  try {
    const s = fakeServer();
    const orders = await withFetch(s.fetchImpl, async () => (await proLogin({ accessKeys: { coferry: "key-coferry" } })).orders("coferry", ...R));
    assert.equal(orders.length, 3);
    assert.deepEqual(s.calls.map((c) => c.path), ["/order-integration/v2/orders", "/order-integration/v2/orders"]);
    assert.equal(s.calls[0].headers["ss-store-id"], "coferry");
    assert.ok(!s.calls[0].headers.authorization, "Bearer 토큰 안 씀");
    assert.ok(!/홍길동|010-0000|서울|개인 메모/.test(JSON.stringify(orders)));
    assert.throws(() => statSync(process.env.SIXSHOP_PRO_TOKEN_FILE!), "토큰 파일 안 만듦");
    // 키 없는 상점은 계정이 필요 — 계정이 없으면 그 상점만 실패
    await assert.rejects(withFetch(s.fetchImpl, async () => (await proLogin({ accessKeys: { coferry: "key-coferry" } })).orders("apeti", ...R)), /SIXSHOP_PRO_EMAIL/);
  } finally {
    process.env.SIXSHOP_PRO_EMAIL = saved.email;
    process.env.SIXSHOP_PRO_PASSWORD = saved.pw;
  }
});

await test("Access Key 가 안 먹으면(401) 로그인으로 돌아가지 않고 실패", async () => {
  const s = fakeServer();
  await assert.rejects(withFetch(s.fetchImpl, async () => (await proLogin({ accessKeys: { coferry: "wrong" } })).orders("coferry", ...R)), /401/);
  assert.ok(!s.calls.some((c) => c.path.includes("sign-in")));
});

console.log(`\n결과: 통과 ${pass}${process.exitCode ? " · 실패 있음" : " · 실패 0"}`);
