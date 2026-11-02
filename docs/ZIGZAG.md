# 지그재그 일일 보고서

에이블리 일일 보고서와 **같은 양식**으로 지그재그 하루 손익을 만든다. 오피스 **전략팀 → 플랫폼 탭**이 읽고, 코페리 · 아페티는 **월간 손익 메인보드**도 읽는다.
브랜드: 코페리(`zigzag/kop`) · 아페티(`zigzag/apt`) · 식스에이(`zigzag/6a`) — `src/zigzag-live.ts` `ZIGZAG_BRANDS`.

맥미니 `mac/jobs/zigzag-live.job` 이 **30분마다** 실행. 오늘(진행 중) · 어제를 다시 계산하고 바뀐 것만 커밋 하나로 올린다. 06시 이후 첫 실행은 지난 8일.

```bash
npm run zigzag-live                  # 오늘 · 어제 (+ 그날 첫 06시 이후 실행이면 지난 8일)
npm run zigzag-live -- --days 33     # 지난 기간 채우기 (최대 92)
npm run zigzag-live -- --dry         # 계산만
npx tsx tests/zigzag-live.test.ts    # 시험 (네트워크 · 계정 없음)
```

## 데이터 (파트너센터 GraphQL, 읽기만)

공식 오픈 API 는 직진배송 주문을 안 준다. 프록시 `zigzag_sales.py` 와 같은 로그인 세션 쿠키로 부른다 (`~/projects/zigzag-collector/data/kakaostyle-state-{브랜드}.json`, 식스에이는 `kakaostyle-state.json`. 브라우저 없이 쿠키만으로 됨).
세션 관리와 재로그인은 프록시 platform-sales 몫 — 여기서는 로그인하지 않고, 끊기면 실패로 남긴다 (덮어쓰지 않음).

| 항목 | 출처 |
|---|---|
| 스토어배송 주문 | `SearchPartnerOrderItemList` (주문 검색 화면) |
| 직진배송 주문 | `ZonlySearchOrderItemList` (직진배송 → 주문 검색) |
| 직배 이용료 | `GetWmsFeeSettlementPageList` `total_fee_with_vat` (직진배송 → 이용료 내역, 정산일별 · 부가세 포함) |
| 광고비 | `GetAdPartnerAdSetDailyStatsList` 일별 과금액 (광고 관리자). 광고를 안 돌린 날 · 브랜드는 0 |
| 원가 | 코페리 원가 시트 `matchCost` · 아페티 MD팀 시트 `apetiAblyMatcher` (에이블리 보고서와 같은 표 · 같은 찾기). 식스에이는 원가표 연결 전 — 원가를 빼지 않고 `summary.cost` 를 null 로 둔다 |

구매자 이름 · 이메일 · 수령인은 쿼리에 넣지 않는다.
쓰지 않지만 있는 것: `GetOrderSettlementShopList` · `GetReconcileSummary` (일별 스토어 정산 — 실제 수수료 · 스토어 쿠폰 부담 · 정산액).

## 계산

```
실결제 = 주문 항목 total_amount (쿠폰 빼기 전 주문금액). 취소 · 반품 · 환불(요청 포함) · 입금 전은 뺌. 일부 취소는 남은 수량 비율.
수수료 = 실결제 × 브랜드별 기본 수수료율 (ZIGZAG_BRANDS feeRate, 파트너센터 스토어 기본 수수료 값)
택배비 = 스토어배송 주문번호 수 × 2,200원 — 직진배송은 창고에서 나가고 출고비가 이용료에 있어 뺀다 (사장님 결정 2026-11-02)
순이익 = 실결제 − 수수료 − 직배 이용료 − 택배비 − 광고비 − 원가
날짜 = 주문일 KST
```

## 사장님 시트와 대조 (2026-10, 코페리 · 아페티)

공개 레포라 금액은 적지 않는다 — 실제 값은 비공개 `brightbeed-reports` 와 사장님 시트에서 본다.

- 매출: 시트는 파트너센터 주문금액에 가깝다 (취소 · 반품 포함). 보고서는 뺀 값이라 더 작다.
- 직배 이용료: 시트 값 = 이용료 내역 10/1 ~ 10/28 합 (1원까지 일치). 보고서는 10/31 까지.
- 광고비: 시트와 거의 일치.
- 원가: 코페리는 원가율 차이가 거의 없고 미확인 0건. 아페티는 1원까지 일치.

실제 정산은 기본 수수료율보다 수수료가 높고 스토어 쿠폰 부담이 따로 있다 — 시트에는 쿠폰 부담이 없다.
