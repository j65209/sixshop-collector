/**
 * 지그재그 실시간 수집기(src/zigzag-live.ts runZigzagLive) · 보고서 계산(src/zigzag-report.ts) 시험 — 네트워크 · 계정 없음.
 *   npx tsx tests/zigzag-live.test.ts
 * 순이익 계산, 취소 · 반품 빼기, 일부 취소, 날짜 범위 · 진행 중 표시, 원가 · 광고 시트를 못 읽으면 아무것도 안 올리기,
 * 바뀐 것만 커밋, index 칸(수수료 · 이용료), 개인정보 칸이 없는지를 확인한다.
 */
import assert from "node:assert/strict";

process.env.ZIGZAG_LIVE_NO_MAIN = "1";
const { runZigzagLive, ZIGZAG_BRANDS } = await import("../src/zigzag-live.js");
const { buildZigzagReport, zigzagItemsOn } = await import("../src/zigzag-report.js");
type Item = import("../src/zigzag-api.js").ZigzagOrderItem;

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
function item(when: string, amount: number, o: Partial<Item> = {}): Item {
  seq++;
  return {
    order_item_number: `i${seq}`, order_number: `o${seq}`, fulfillment: "merchant", date_created: at(when), status: "CONFIRMED",
    quantity: 1, remaining_quantity: 1, total_amount: amount, seller_coupon: 0, product_id: "p", name: "Cordu dot bag", option: "Ivory / one size", price: amount, code: "", ...o,
  };
}
const costOf = () => ({ cost_unit: 1000, cost_name: "시트 행", cost_match: "exact" as const });
const noAd = { charge: 0, adOrderPrice: 0, basis: "없음" };
const opts = { market: "코페리", costBasis: "시험" };

await test("순이익 = 실결제 − 수수료 9.5% − 이용료 − 택배비 − 광고비 − 원가", () => {
  const r = buildZigzagReport("2026-11-01", { items: [item("2026-11-01 10:00", 100000), item("2026-11-01 11:00", 50000)], directFee: 3000, ad: { charge: 10000, adOrderPrice: 0, basis: "" } }, costOf, opts);
  const s = r.summary;
  assert.equal(s.paid, 150000);
  assert.equal(s.fees_est, 14250);
  assert.equal(s.shipping, 4400);
  assert.equal(s.cost, 2000);
  assert.equal(s.direct_fee, 3000);
  assert.equal(s.net, 150000 - 14250 - 3000 - 4400 - 10000 - 2000);
  assert.equal(r.assumptions.fee_rate, 0.095);
});

await test("취소 · 반품 · 입금 전은 매출 · 주문 · 원가에서 뺀다", () => {
  const items = ["CANCELLED", "CANCELLED_BEFORE_TRANSFER", "RETURNED", "RETURN_REQUESTED", "CANCEL_REQUEST", "BEFORE_TRANSFER"].map((status) => item("2026-11-01 10:00", 9000, { status }));
  const s = buildZigzagReport("2026-11-01", { items: [...items, item("2026-11-01 10:00", 1000)], directFee: 0, ad: noAd }, costOf, opts).summary;
  assert.equal(s.paid, 1000);
  assert.equal(s.orders, 1);
  assert.equal(s.cost, 1000);
  assert.equal(s.excluded_items, 6);
});

await test("같은 주문의 여러 항목은 택배비 한 번 · 일부 취소는 남은 수량만큼", () => {
  const s = buildZigzagReport("2026-11-01", {
    items: [item("2026-11-01 10:00", 30000, { order_number: "A", quantity: 3, remaining_quantity: 1 }), item("2026-11-01 10:00", 5000, { order_number: "A" })],
    directFee: 0, ad: noAd,
  }, costOf, opts).summary;
  assert.equal(s.orders, 1);
  assert.equal(s.shipping, 2200);
  assert.equal(s.paid, 15000);
  assert.equal(s.qty, 2);
});

await test("직진배송 주문은 택배비를 안 뺀다 — 스토어배송이 섞인 주문은 한 번", () => {
  const s = buildZigzagReport("2026-11-01", {
    items: [
      item("2026-11-01 10:00", 10000, { order_number: "Z1", fulfillment: "zigzin" }),
      item("2026-11-01 10:00", 10000, { order_number: "Z2", fulfillment: "zigzin" }),
      item("2026-11-01 10:00", 10000, { order_number: "M1" }),
      item("2026-11-01 10:00", 10000, { order_number: "MIX" }),
      item("2026-11-01 10:00", 10000, { order_number: "MIX", fulfillment: "zigzin" }),
      item("2026-11-01 10:00", 10000, { order_number: "M2", status: "CANCELLED" }),
    ],
    directFee: 5000, ad: noAd,
  }, costOf, opts).summary;
  assert.equal(s.orders, 4);
  assert.equal(s.ship_orders, 2);
  assert.equal(s.shipping, 4400);
  assert.equal(s.net, 50000 - 4750 - 5000 - 4400 - 5000);
});

await test("날짜는 주문일 KST — 자정 전후가 갈린다", () => {
  const items = [item("2026-11-01 23:59", 1), item("2026-11-02 00:01", 2)];
  assert.equal(zigzagItemsOn(items, "2026-11-01").length, 1);
  assert.equal(zigzagItemsOn(items, "2026-11-02")[0].total_amount, 2);
});

await test("보고서에 구매자 칸이 없다", () => {
  const r = buildZigzagReport("2026-11-01", { items: [item("2026-11-01 10:00", 1)], directFee: 0, ad: noAd }, costOf, opts);
  assert.doesNotMatch(JSON.stringify(r.orders), /orderer|receiver|email|phone|address|mobile/i);
});

/* ---- 실행 ---- */
const NOW = at("2026-11-02 14:30");
function deps(over: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = {};
  const commits: { files: { path: string; content: unknown }[]; message: string }[] = [];
  const asked: { items: string[][]; fees: string[] } = { items: [], fees: [] };
  const orders = [item("2026-11-02 09:00", 10000), item("2026-11-01 09:00", 20000)];
  return {
    store, commits, asked,
    d: {
      nowMs: NOW,
      api: async () => ({
        items: async (from: string, to: string) => { asked.items.push([from, to]); return orders; },
        fees: async (m: string) => { asked.fees.push(m); return { "2026-11-01": 500 }; },
      }),
      costOf: async () => costOf,
      adDays: async () => ({ "2026-11-01": { krw: 700, rev: 0 } }),
      getJson: async <T>(path: string) => (store[path] ?? null) as T | null,
      commit: async (files: { path: string; content: unknown }[], message: string) => { commits.push({ files, message }); for (const f of files) store[f.path] = JSON.parse(JSON.stringify(f.content)); return "sha"; },
      brands: ZIGZAG_BRANDS,
      log: () => {},
      ...over,
    },
  };
}
const args = { days: null, brands: ["kop", "apt"], dry: false, state: { settled: "2026-11-02" } };

await test("오늘 · 어제를 커밋 하나로 — 오늘만 진행 중, index 에 수수료 · 이용료 칸", async () => {
  const t = deps();
  const res = await runZigzagLive(args, t.d as never);
  assert.deepEqual(res.dates, ["2026-11-02", "2026-11-01"]);
  assert.equal(t.commits.length, 1);
  const idx = t.store["zigzag/kop/index.json"] as { days: Record<string, unknown>[] };
  assert.equal(idx.days[0].date, "2026-11-02");
  assert.equal(idx.days[0].as_of, "14:30");
  assert.equal(idx.days[1].as_of, undefined);
  assert.equal(idx.days[1].direct_fee, 500);
  assert.equal(idx.days[1].fees_est, 1900);
  assert.equal(idx.days[1].ship_orders, 1);
  assert.equal(idx.days[1].ad_spend, 700);
  assert.ok(t.store["zigzag/apt/daily/2026-11-01.json"]);
  assert.equal((t.store["zigzag/apt/daily/2026-11-01.json"] as { summary: { ad_spend: number } }).summary.ad_spend, 0); // 아페티는 광고 시트 없음
});

await test("바뀐 게 없으면 지난 날은 안 올림", async () => {
  const t = deps();
  await runZigzagLive(args, t.d as never);
  const n = t.commits.length;
  const res = await runZigzagLive(args, t.d as never);
  assert.equal(t.commits.length, n);
  assert.deepEqual(res.committed, []);
});

await test("06시 이후 그날 첫 실행은 지난 8일", async () => {
  const t = deps();
  const res = await runZigzagLive({ ...args, state: {} }, t.d as never);
  assert.equal(res.dates.length, 8);
  assert.equal(res.settle, true);
  assert.deepEqual(t.asked.items[0], ["2026-10-26", "2026-11-02"]);
  assert.deepEqual(t.asked.fees.slice(0, 2).sort(), ["2026-10", "2026-11"]);
});

for (const [name, over] of [
  ["주문을 못 받으면", { api: async () => { throw new Error("지그재그 → 401"); } }],
  ["원가 표를 못 읽으면", { costOf: async () => { throw new Error("원가 시트 500"); } }],
  ["광고 시트를 못 읽으면", { adDays: async () => { throw new Error("광고 시트 500"); } }],
] as const) {
  await test(`${name} 그 브랜드는 아무것도 안 올림`, async () => {
    const t = deps(over);
    const res = await runZigzagLive({ ...args, brands: ["kop"] }, t.d as never);
    assert.equal(res.failed.length, 1);
    assert.equal(t.commits.length, 0);
  });
}

await test("시험 실행(--dry)은 기록하지 않음", async () => {
  const t = deps();
  await runZigzagLive({ ...args, dry: true }, t.d as never);
  assert.equal(t.commits.length, 0);
  assert.deepEqual(Object.keys(t.store), []);
});

console.log(`\n${pass}개 통과`);
