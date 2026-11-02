# 스마트스토어 일일 보고서

에이블리 일일 보고서와 **같은 양식**으로 스마트스토어 하루 손익을 만든다. 오피스 **전략팀 → 플랫폼 탭**이 읽는다.
브랜드: 프로덕트피알(`smartstore/pp`) — `src/smartstore-live.ts` `SMARTSTORE_BRANDS`.
코페리 스마트스토어는 커머스API 앱이 사용 불가 상태(`auth.eapp-application.status.invalid`)라 뺐다. 앱을 살리면 브랜드만 추가.

맥미니 `mac/jobs/smartstore-live.job` 이 **30분마다** 실행. 오늘(진행 중) · 어제를 다시 계산하고 바뀐 것만 커밋 하나로 올린다. 06시 이후 첫 실행은 지난 8일.

```bash
npm run smartstore-live                 # 오늘 · 어제 (+ 그날 첫 06시 이후 실행이면 지난 8일)
npm run smartstore-live -- --days 33    # 지난 기간 채우기 (최대 92)
npm run smartstore-live -- --dry        # 계산만
npx tsx tests/smartstore-live.test.ts   # 시험 (네트워크 · 계정 없음)
```

env (맥미니 `.env`): `SMARTSTORE_PP_CLIENT_ID` · `SMARTSTORE_PP_CLIENT_SECRET` (프록시 `config.env` 와 같은 값) · `REPORTS_GITHUB_TOKEN`

## 받기

네이버 커머스 API. 기간 안에 상태가 바뀐 상품 주문 번호(`last-changed-statuses`, 23시간씩) → 상세(`product-orders/query`, 300건씩) → 결제일로 나눔.
결제 자체가 상태 변경이라 결제일이 그 기간인 주문은 전부 잡힌다. 상세가 하나라도 빠지거나 살아 있는 주문의 상품명 · 금액 · 정산 예정이 비어 있으면 그 회차는 올리지 않는다.
응답에 구매자 이름 · 연락처 · 주소가 오지만 `pickProductOrder` 에서 버린다.

## 계산

```
상품 매출 = 상품 금액(totalProductAmount) − 판매자 부담 할인(sellerBurdenDiscountAmount). 네이버 부담 할인은 정산으로 채워져 빼지 않는다 (그래서 고객 결제액 totalPaymentAmount 와 다를 수 있다)
실결제 = 상품 매출 + 고객이 낸 배송비(deliveryFeeAmount − deliveryDiscountAmount, 묶음배송 번호당 한 번)
수수료 = 상품 매출 − 정산 예정 금액(expectedSettlementAmount) = paymentCommission + knowledgeShoppingSellingInterlockCommission — 주문별 실제 값
택배비 = 주문번호 수 × 2,200원
순이익 = 실결제 − 수수료 − 택배비 − 광고비 − 원가
날짜 = 결제일 KST
```

- 제외: `CANCELED` · `RETURNED` · `CANCELED_BY_NOPAYMENT`, 취소 · 반품 요청 중 (거부되면 유지). 교환은 매출 유지.
- 원가: 프로덕트피알 공홈과 같은 대응표 (`src/home-brands.ts` `PP_MAP`, 발주 리스트 위안 × 300). 7컬러 자카드 케이블 · 헤어 핀 등 시트에 없는 상품은 "미확인".
- 광고비: 네이버 광고 미연결 — 0 으로 두고 오피스에 "광고 시트 미입력" 표시.
- 오피스 마케팅팀 매출 카드(프록시 `smartstore_sales.py`)는 고객 결제액만 · 취소 포함이라 이 보고서 실결제와 다르다.
