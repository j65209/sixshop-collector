/**
 * 스마트스토어 실시간 수집기(src/smartstore-live.ts) · 보고서 계산(src/smartstore-report.ts) 시험 — 네트워크 · 계정 없음.
 *   npx tsx tests/smartstore-live.test.ts
 * 실결제(상품 + 묶음별 배송비), 실제 수수료, 네이버 부담 할인, 취소 · 반품 빼기(교환 · 거부는 유지), 구매자 정보 버리기, 읽기 실패 · 빈 내용이면 안 올리기를 확인한다.
 */
import assert from "node:assert/strict";

process.env.SMARTSTORE_LIVE_NO_MAIN = "1";
const { runSmartstoreLive, pickProductOrder, assertReadableOrders, SMARTSTORE_BRANDS } = await import("../src/smartstore-live.js");
const { buildSmartstoreReport, isExcludedSs, ssOrdersOn } = await import("../src/smartstore-report.js");
type Row = import("../src/smartstore-report.js").SsProductOrder;

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

let seq = 0;
function row(o: Partial<Row> = {}): Row {
  seq++;
  return {
    product_order_id: `p${seq}`, order_id: `o${seq}`, package_no: `k${seq}`, payment_date: "2026-11-01T10:00:00.000+09:00", status: "PURCHASE_DECIDED", claim_type: "", claim_status: "",
    name: "180도 회전 고속충전케이블", option: "컬러: 피치 / 기종옵션: C type - C type", code: "", product_id: "1", quantity: 1, unit_price: 10500, product_amount: 10500, seller_discount: 4000, paid: 6500, settle: 6110, delivery_fee: 3000, ...o,
  };
}
const costOf = () => ({ cost_unit: 1000, cost_name: "행", cost_match: "exact" as const });
const opts = { market: "프로덕트피알", costBasis: "시험" };

await test("실결제 = 상품 + 고객 배송비, 순이익 = 실결제 − 실제 수수료 − 택배비 − 원가", () => {
  const s = buildSmartstoreReport("2026-11-01", [row()], costOf, opts).summary;
  assert.equal(s.gross, 6500);
  assert.equal(s.shipping_income, 3000);
  assert.equal(s.paid, 9500);
  assert.equal(s.fees_est, 390);
  assert.equal(s.shipping, 2200);
  assert.equal(s.cost, 1000);
  assert.equal(s.net, 9500 - 390 - 2200 - 1000);
});

await test("같은 묶음배송의 배송비는 한 번 · 택배비도 주문번호당 한 번", () => {
  const s = buildSmartstoreReport("2026-11-01", [row({ order_id: "A", package_no: "K" }), row({ order_id: "A", package_no: "K" })], costOf, opts).summary;
  assert.equal(s.shipping_income, 3000);
  assert.equal(s.orders, 1);
  assert.equal(s.shipping, 2200);
  assert.equal(s.qty, 2);
});

await test("취소 · 반품은 요청부터 빼고, 교환 · 거부된 요청은 유지", () => {
  assert.equal(isExcludedSs({ status: "CANCELED", claim_type: "CANCEL", claim_status: "CANCEL_DONE" }), true);
  assert.equal(isExcludedSs({ status: "RETURNED", claim_type: "RETURN", claim_status: "RETURN_DONE" }), true);
  assert.equal(isExcludedSs({ status: "DELIVERED", claim_type: "RETURN", claim_status: "RETURN_REQUEST" }), true);
  assert.equal(isExcludedSs({ status: "PAYED", claim_type: "CANCEL", claim_status: "CANCEL_REQUEST" }), true);
  assert.equal(isExcludedSs({ status: "DELIVERED", claim_type: "CANCEL", claim_status: "CANCEL_REJECT" }), false);
  assert.equal(isExcludedSs({ status: "EXCHANGED", claim_type: "EXCHANGE", claim_status: "EXCHANGE_DONE" }), false);
  assert.equal(isExcludedSs({ status: "DELIVERED", claim_type: "EXCHANGE", claim_status: "COLLECTING" }), false);
  const s = buildSmartstoreReport("2026-11-01", [row({ status: "CANCELED", claim_type: "CANCEL", claim_status: "CANCEL_DONE" })], costOf, opts).summary;
  assert.equal(s.paid, 0);
  assert.equal(s.excluded_items, 1);
});

await test("날짜는 결제일 KST", () => {
  const rows = [row({ payment_date: "2026-11-01T23:59:00.000+09:00" }), row({ payment_date: "2026-11-02T00:01:00.000+09:00" }), row({ payment_date: "" })];
  assert.equal(ssOrdersOn(rows, "2026-11-01").length, 1);
  assert.equal(ssOrdersOn(rows, "2026-11-02").length, 1);
});

await test("구매자 정보는 버린다", () => {
  const p = pickProductOrder({ order: { orderId: "O", paymentDate: "2026-11-01T10:00:00.000+09:00", ordererName: "홍길동", ordererTel: "010", ordererId: "id" }, productOrder: { productOrderId: "P", productName: "상품", shippingAddress: { name: "홍길동", tel1: "010", baseAddress: "서울" }, totalProductAmount: 1000, deliveryFeeAmount: 3000, deliveryDiscountAmount: 3000 } });
  assert.doesNotMatch(JSON.stringify(p), /홍길동|010|서울/);
  assert.equal(p.delivery_fee, 0);
  assert.equal(p.paid, 1000);
});

await test("네이버 부담 할인은 매출에서 안 뺀다 — 매출 − 수수료 = 정산 예정 (실제 주문 한 건)", () => {
  const p = pickProductOrder({ order: { orderId: "O" }, productOrder: { productOrderId: "P", productName: "상품", quantity: 1, totalProductAmount: 10500, sellerBurdenDiscountAmount: 3000, totalPaymentAmount: 2600, expectedSettlementAmount: 7050, deliveryFeeAmount: 3000 } });
  assert.equal(p.paid, 7500);
  const s = buildSmartstoreReport("2026-11-01", [{ ...p, payment_date: "2026-11-01T10:00:00.000+09:00" }], costOf, opts).summary;
  assert.equal(s.fees_est, 450);
  assert.equal(s.gross - s.fees_est, 7050);
});

await test("취소 · 반품 줄은 내용 검증에서 제외 · 전액 할인은 통과", () => {
  assert.doesNotThrow(() => assertReadableOrders([row({ status: "CANCELED", claim_type: "CANCEL", claim_status: "CANCEL_DONE", name: "" }), row({ paid: 0, settle: 0 })]));
});

const NOW = Date.parse("2026-11-02T14:30:00+09:00");
function deps(over: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = {};
  const commits: unknown[] = [];
  const rows = [row({ payment_date: "2026-11-02T09:00:00.000+09:00" }), row({ payment_date: "2026-11-01T09:00:00.000+09:00" })];
  return {
    store, commits,
    d: {
      nowMs: NOW,
      orders: async () => rows,
      costOf: async () => costOf,
      costBasis: () => "시험",
      getJson: async <T>(path: string) => (store[path] ?? null) as T | null,
      commit: async (files: { path: string; content: unknown }[]) => { commits.push(files); for (const f of files) store[f.path] = JSON.parse(JSON.stringify(f.content)); return "sha"; },
      brands: SMARTSTORE_BRANDS,
      log: () => {},
      ...over,
    },
  };
}
const args = { days: null, brands: ["pp"], dry: false, state: { settled: "2026-11-02" } };

await test("오늘 · 어제를 커밋 하나로 — 오늘만 진행 중 · 다시 돌려도 안 바뀌면 안 올림", async () => {
  const t = deps();
  const res = await runSmartstoreLive(args, t.d as never);
  assert.deepEqual(res.dates, ["2026-11-02", "2026-11-01"]);
  assert.equal(t.commits.length, 1);
  const idx = t.store["smartstore/pp/index.json"] as { days: Record<string, unknown>[] };
  assert.equal(idx.days[0].as_of, "14:30");
  assert.equal(idx.days[1].as_of, undefined);
  assert.equal(idx.days[1].paid, 9500);
  await runSmartstoreLive(args, t.d as never);
  assert.equal(t.commits.length, 1);
});

for (const [name, over] of [
  ["주문을 못 받으면", { orders: async () => { throw new Error("스마트스토어 500"); } }],
  ["원가 표를 못 읽으면", { costOf: async () => { throw new Error("시트 500"); } }],
  ["상품명이 비어 있으면 (네이버 칸 변경)", { orders: async () => [row({ name: "" })] }],
  ["금액이 비어 있으면 (네이버 칸 변경)", { orders: async () => [row({ product_amount: 0, paid: 0, settle: 0 })] }],
  ["정산 예정이 비어 있으면 (네이버 칸 변경)", { orders: async () => [row({ settle: 0 })] }],
] as const) {
  await test(`${name} 아무것도 안 올림`, async () => {
    const t = deps(over);
    const res = await runSmartstoreLive(args, t.d as never);
    assert.equal(res.failed.length, 1);
    assert.equal(t.commits.length, 0);
  });
}

console.log(`\n${pass}개 통과`);
