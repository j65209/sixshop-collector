/**
 * 식스샵 프로 주문 내보내기(src/export-pro-orders.ts) 시험 — 가짜 Open API · 가짜 보고서 레포로, 진짜 키 없이.
 *   npx tsx tests/export-pro-orders.test.ts
 * 기간 인자 · KST 경계, 개인정보 키 거르기(값이 안 담기는지), 페이지 넘기기 · 헤더, 429 다시 시도, 키 없는 상점만 실패,
 * 이미 올린 기간 건너뛰기, --dry 는 기록 없음을 확인한다.
 */
import assert from "node:assert/strict";

process.env.EXPORT_PRO_ORDERS_NO_MAIN = "1";
const m = await import("../src/export-pro-orders.js");
const { HOME_BRANDS } = await import("../src/home-brands.js");
type Manifest = import("../src/export-pro-orders.js").Manifest;

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

const PII_VALUES = /홍길동|김철수|010-1234|010-9999|서울시|06236|문 앞에|각인 JH|6123456789|hong@example\.com|110-222|1\.2\.3\.4|Mozilla/;

/** 개인정보가 잔뜩 든 주문 목록 한 줄 (실제 응답에 있을 법한 키들) */
function rawOrder(store: string, n: number, orderedAt = "2026-10-15T03:00:00.000Z") {
  return {
    order: {
      orderId: `${store}-${n}`, orderedAt, paidAt: orderedAt, cancelledAt: null, paymentStatus: "paid", processStatus: "purchaseConfirmed",
      paymentTypes: "CARD", marketCode: "commerce", orderAmount: 29900, deliveryFee: 3000, discountAmount: 0, totalAmount: 32900, refundAmount: 0,
      orderName: "Heart tiny bag 외 1건",
      ordererName: "홍길동", ordererTel: "010-1234-5678", ordererEmail: "hong@example.com", memberNo: 778899,
      receiver: { name: "김철수", phone: "010-9999-0000", address: "서울시 강남구", zipCode: "06236" },
      deliveryMemo: "문 앞에 놔주세요", invoiceNumber: "6123456789", depositorName: "홍길동", refundBankAccount: "110-222-333",
      userAgent: "Mozilla/5.0", clientIp: "1.2.3.4",
      pointAmount: 500, couponCode: "WELCOME2000", deliveredAt: "2026-10-17T05:00:00.000Z", isGift: false,
      delivery: { companyCode: "CJGLS", status: "delivered", trackingNumber: "6123456789" },
      coupons: [{ name: "웰컴 쿠폰", amount: 2000 }],
    },
    productOrders: [
      {
        productOrderId: `${store}-${n}-1`, productName: "Heart tiny bag (cream)", productOptionNames: ["색상"], productOptionValues: ["cream"],
        productOptionDisplayName: "색상: cream", quantity: 1, unitPrice: 29900, originalUnitPrice: 29900, unitAmount: 29900, discountAmount: 0,
        status: "purchaseConfirmed", claimType: null, sku: "HB-CR", productManageCode: "P001",
        productAdditionalOptions: [{ name: "각인", value: "각인 JH" }], deliveryFee: 3000, productId: "abc123",
      },
    ],
    storeMarket: { marketCode: "commerce", marketOrderId: null },
  };
}

interface Call { url: URL; headers: Record<string, string> }
function fakeApi(opts: { totalPerStore?: number; fail429Once?: boolean; keys?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  let failed = false;
  const total = opts.totalPerStore ?? 3;
  const keys = opts.keys ?? { coferry: "key-coferry", apeti: "key-apeti", "cos-mi": "key-cos-mi" };
  const fetchImpl = (async (input: string | URL, init?: { headers?: Record<string, string> }) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.host !== "api.sixshop.io" || url.pathname !== "/order-integration/v2/orders") return json({ message: "unexpected" }, 500);
    const store = headers["ss-store-id"];
    if (headers["authorization-core"] !== keys[store]) return json({ message: "invalid key" }, 401);
    if (opts.fail429Once && !failed) {
      failed = true;
      return json({ message: "too many" }, 429);
    }
    const page = Number(url.searchParams.get("page"));
    const limit = Number(url.searchParams.get("limit"));
    const all = Array.from({ length: total }, (_, i) => rawOrder(store, i + 1, new Date(Date.parse("2026-10-31T14:00:00.000Z") - i * 3600_000).toISOString()));
    const list = all.slice((page - 1) * limit, page * limit);
    return json({ list, pagination: { totalPages: Math.max(1, Math.ceil(total / limit)), totalItems: total } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function fakeRepo(initial: Record<string, unknown> = {}) {
  const files: Record<string, unknown> = { ...initial };
  const commits: { paths: string[]; message: string }[] = [];
  return {
    files,
    commits,
    getJson: async <T,>(path: string) => (path in files ? (JSON.parse(JSON.stringify(files[path])) as T) : null),
    commit: async (fs: { path: string; content: unknown }[], message: string) => {
      for (const f of fs) files[f.path] = JSON.parse(JSON.stringify(f.content));
      commits.push({ paths: fs.map((f) => f.path), message });
      return "sha";
    },
  };
}

function deps(api: ReturnType<typeof fakeApi>, repo: ReturnType<typeof fakeRepo>, env: Record<string, string> = {}) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  return {
    lines,
    sleeps,
    d: {
      fetch: api.fetchImpl,
      getJson: repo.getJson,
      commit: repo.commit,
      env: (name: string) =>
        ({ SIXSHOP_PRO_ACCESS_KEY_KOP: "key-coferry", SIXSHOP_PRO_ACCESS_KEY_APT: "key-apeti", SIXSHOP_PRO_ACCESS_KEY_KOZ: "key-cos-mi", ...env } as Record<string, string>)[name] || undefined,
      log: (l: string) => lines.push(l),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      now: () => new Date("2026-11-01T13:40:00.000Z"),
      brands: HOME_BRANDS,
    },
  };
}

console.log("식스샵 프로 주문 내보내기 (export-pro-orders)");

await test("--month → 그달 1일 ~ 마지막 날 · 기본 브랜드 코페리 · 아페티 · 코즈미", () => {
  const a = m.parseArgs(["--month", "2026-10"]);
  assert.deepEqual([a.from, a.to, a.label, a.brands, a.dry, a.force], ["2026-10-01", "2026-10-31", "2026-10", ["kop", "apt", "koz"], false, false]);
  assert.equal(m.parseArgs(["--month", "2026-02"]).to, "2026-02-28");
  assert.equal(m.parseArgs(["--month", "2028-02"]).to, "2028-02-29");
  const b = m.parseArgs(["--from", "2026-10-01", "--to", "2026-10-15", "--brands", "kop,pp", "--dry"]);
  assert.deepEqual([b.label, b.brands, b.dry], ["2026-10-01_2026-10-15", ["kop", "pp"], true]);
  assert.throws(() => m.parseArgs(["--month", "2026-13"]));
  assert.throws(() => m.parseArgs(["--from", "2026-10-31", "--to", "2026-10-01"]));
  assert.throws(() => m.parseArgs(["--from", "2026-02-30", "--to", "2026-03-01"]));
  assert.throws(() => m.parseArgs(["--month", "2026-10", "--brands", "kop,zzz"]));
  assert.throws(() => m.parseArgs([]));
});

await test("KST 경계 — 10-01 00:00 KST = 09-30 15:00Z, 10-31 끝 = 10-31 14:59:59.999Z", () => {
  assert.equal(m.kstStartIso("2026-10-01"), "2026-09-30T15:00:00.000Z");
  assert.equal(m.kstEndIso("2026-10-31"), "2026-10-31T14:59:59.999Z");
  assert.equal(m.kst("2026-10-31T14:59:59.000Z"), "2026-10-31 23:59:59");
});

await test("키 이름 낱말 · 개인정보 키 판별 (shippingFee 의 ip 같은 부분 글자는 안 걸림)", () => {
  assert.deepEqual(m.keyWords("storeMarket.marketCode"), ["store", "market", "market", "code"]);
  assert.deepEqual(m.keyWords("PGTransactionId"), ["pg", "transaction", "id"]);
  for (const k of ["ordererTel", "receiverAddress", "receiver.name", "deliveryMemo", "invoiceNumber", "productAdditionalOptions", "memberNo", "clientIp", "userAgent", "refundBankAccount", "zipCode"]) {
    assert.ok(m.piiKey(k), `개인정보로 봐야 함: ${k}`);
  }
  for (const k of ["shippingFee", "deliveryFee", "totalAmount", "paymentStatus", "storeMarket.marketCode", "pointAmount", "deliveredAt", "couponCode"]) {
    assert.ok(!m.piiKey(k), `개인정보 아님: ${k}`);
  }
});

await test("주문 하나 — 알려진 필드 + 안전한 값만, 개인정보 값은 하나도 안 담김 · 뺀 키 이름은 남음", () => {
  const ex = m.newExcluded();
  const o = m.exportOrder(rawOrder("coferry", 1), ex);
  const text = JSON.stringify(o);
  assert.ok(!PII_VALUES.test(text), text);
  assert.equal(o.orderId, "coferry-1");
  assert.equal(o.totalAmount, 32900);
  assert.equal(o.cancelledAt, null, "알려진 필드는 null 이어도 담음");
  assert.equal(o.pointAmount, 500);
  assert.equal(o.couponCode, "WELCOME2000");
  assert.equal(o.deliveredAt, "2026-10-17T05:00:00.000Z");
  assert.equal(o.isGift, false);
  assert.equal(o["delivery.companyCode"], "CJGLS");
  assert.equal(o["delivery.status"], "delivered");
  assert.equal(o["storeMarket.marketCode"], "commerce");
  const it = (o.items as Record<string, unknown>[])[0];
  assert.equal(it.productOptionDisplayName, "색상: cream");
  assert.deepEqual(it.productOptionValues, ["cream"]);
  assert.equal(it.sku, "HB-CR");
  assert.equal(it.deliveryFee, 3000);
  assert.ok(!("productAdditionalOptions" in it));
  for (const k of ["ordererName", "ordererTel", "ordererEmail", "memberNo", "receiver", "deliveryMemo", "invoiceNumber", "depositorName", "refundBankAccount", "userAgent", "clientIp", "orderName", "coupons", "delivery.trackingNumber"]) {
    assert.ok(ex.order.has(k), `excluded.order 에 ${k}: ${[...ex.order].join(",")}`);
  }
  assert.ok(ex.item.has("productAdditionalOptions"));
  assert.ok(ex.item.has("productId"), "모르는 글자 값은 안 담음");
});

await test("세 상점 받기 — Open API 헤더 2개 · 기간 · 두 페이지 · 상점마다 커밋 + manifest", async () => {
  const api = fakeApi({ totalPerStore: 150 });
  const repo = fakeRepo();
  const { d, lines } = deps(api, repo);
  const res = await m.runExport(m.parseArgs(["--month", "2026-10"]), d);
  assert.equal(res.ok, true);
  assert.equal(api.calls.length, 6, "상점마다 2페이지");
  const c = api.calls[0];
  assert.equal(c.headers["authorization-core"], "key-coferry");
  assert.equal(c.headers["ss-store-id"], "coferry");
  assert.equal(c.url.searchParams.get("orderedAtMin"), "2026-09-30T15:00:00.000Z");
  assert.equal(c.url.searchParams.get("orderedAtMax"), "2026-10-31T14:59:59.999Z");
  assert.equal(c.url.searchParams.get("sort"), "-orderedAt");
  assert.deepEqual(repo.commits.map((x) => x.paths[0]), [
    "exports/sixshop-pro-orders/2026-10/kop.json", "exports/sixshop-pro-orders/2026-10/apt.json",
    "exports/sixshop-pro-orders/2026-10/koz.json", "exports/sixshop-pro-orders/2026-10/manifest.json",
  ]);
  const kop = repo.files["exports/sixshop-pro-orders/2026-10/kop.json"] as { counts: { orders: number; items: number; api_total: number }; orders: { orderedAt: string }[]; warnings: string[]; excluded_keys: { order: string[] } };
  assert.deepEqual(kop.counts, { orders: 150, items: 150, api_total: 150 });
  assert.deepEqual(kop.warnings, []);
  assert.ok(kop.orders[0].orderedAt < kop.orders[149].orderedAt, "주문일 오래된 것부터");
  assert.ok(kop.excluded_keys.order.includes("ordererName"));
  assert.ok(!PII_VALUES.test(JSON.stringify(repo.files)), "레포에 올린 어떤 파일에도 개인정보 값 없음");
  const man = repo.files["exports/sixshop-pro-orders/2026-10/manifest.json"] as Manifest;
  assert.deepEqual(man.brands.map((b) => [b.brand, b.ok, b.orders]), [["kop", true, 150], ["apt", true, 150], ["koz", true, 150]]);
  assert.match(lines.join("\n"), /코페리\(coferry\): 주문 150건/);
});

await test("429 는 쉬었다가 다시", async () => {
  const api = fakeApi({ fail429Once: true });
  const repo = fakeRepo();
  const { d, sleeps } = deps(api, repo);
  const res = await m.runExport(m.parseArgs(["--month", "2026-10", "--brands", "kop"]), d);
  assert.equal(res.ok, true);
  assert.equal(api.calls.length, 2);
  assert.ok(sleeps.includes(3000), sleeps.join(","));
});

await test("키 없는 상점만 실패 — 나머지는 올리고 manifest 에 실패 표시", async () => {
  const api = fakeApi();
  const repo = fakeRepo();
  const { d } = deps(api, repo, { SIXSHOP_PRO_ACCESS_KEY_APT: "" });
  const res = await m.runExport(m.parseArgs(["--month", "2026-10"]), d);
  assert.equal(res.ok, false);
  const man = repo.files["exports/sixshop-pro-orders/2026-10/manifest.json"] as Manifest;
  assert.deepEqual(man.brands.map((b) => [b.brand, b.ok]), [["kop", true], ["apt", false], ["koz", true]]);
  assert.match(man.brands[1].error ?? "", /SIXSHOP_PRO_ACCESS_KEY_APT/);
  assert.ok(!("exports/sixshop-pro-orders/2026-10/apt.json" in repo.files));
});

await test("틀린 키(401)는 그 상점만 실패", async () => {
  const api = fakeApi({ keys: { coferry: "key-coferry", apeti: "other", "cos-mi": "key-cos-mi" } });
  const repo = fakeRepo();
  const { d } = deps(api, repo);
  const res = await m.runExport(m.parseArgs(["--month", "2026-10"]), d);
  assert.equal(res.ok, false);
  assert.match(res.manifest.brands.find((b) => b.brand === "apt")?.error ?? "", /401/);
});

await test("이미 올린 기간은 건너뜀 (받기 · 커밋 없음), --force 면 다시", async () => {
  const done: Manifest = {
    kind: "sixshop-pro-orders", period: { from: "2026-10-01", to: "2026-10-31", basis: "" }, generated_at: "2026-11-01T13:00:00.000Z",
    brands: ["kop", "apt", "koz"].map((b) => ({ brand: b, name: b, store: b, ok: true })),
  };
  const api = fakeApi();
  const repo = fakeRepo({ "exports/sixshop-pro-orders/2026-10/manifest.json": done });
  const { d } = deps(api, repo);
  const res = await m.runExport(m.parseArgs(["--month", "2026-10"]), d);
  assert.equal(res.skipped, true);
  assert.equal(api.calls.length, 0);
  assert.equal(repo.commits.length, 0);
  const res2 = await m.runExport(m.parseArgs(["--month", "2026-10", "--force"]), d);
  assert.equal(res2.skipped, false);
  assert.equal(repo.commits.length, 4);
});

await test("일부 브랜드만 다시 받아도 manifest 의 다른 브랜드는 그대로", async () => {
  const api = fakeApi();
  const repo = fakeRepo();
  const { d } = deps(api, repo, { SIXSHOP_PRO_ACCESS_KEY_APT: "" });
  await m.runExport(m.parseArgs(["--month", "2026-10"]), d);
  const { d: d2 } = deps(api, repo);
  const res = await m.runExport(m.parseArgs(["--month", "2026-10", "--brands", "apt"]), d2);
  assert.equal(res.ok, true);
  const man = repo.files["exports/sixshop-pro-orders/2026-10/manifest.json"] as Manifest;
  assert.deepEqual(man.brands.map((b) => [b.brand, b.ok]).sort(), [["apt", true], ["koz", true], ["kop", true]].sort());
});

await test("--dry 는 받기만 — 레포 읽기 · 기록 없음", async () => {
  const api = fakeApi();
  const repo = fakeRepo();
  const { d } = deps(api, repo);
  const res = await m.runExport(m.parseArgs(["--month", "2026-10", "--dry"]), d);
  assert.equal(res.ok, true);
  assert.equal(repo.commits.length, 0);
  assert.equal(api.calls.length, 3);
});

console.log(`\n${pass}개 통과${process.exitCode ? " · 실패 있음" : ""}`);
