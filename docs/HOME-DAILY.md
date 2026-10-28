# 공홈(식스샵) 일일 보고서

에이블리 일일 보고서(`docs/ABLY-API.md`)와 **같은 양식**으로 공홈 하루 손익을 만든다. 오피스 **전략팀 → 공홈 탭**이 읽는다.
브랜드는 `src/home-daily.ts` 의 `HOME_BRANDS` — 코페리(kop) · 아페티(apt) · 코즈미(koz). 원가는 브랜드마다 MD팀 구글시트.

> **2026-10 코페리 · 아페티 · 코즈미는 식스샵 프로로 옮김** → 아래 "식스샵 프로" 절. 일반 식스샵 엑셀 수집(아래 "실행")은
> 옮기기 전 기간을 채울 때만 쓴다. 맥미니 `home-daily-kop.job` 은 프로 실시간 수집이 생길 때까지 꺼 둠(`ENABLED=0`).

## 식스샵 프로

관리자(`store.sixshop.com/{상점}`) 주문 목록 API `storemanager-be.sixshop.io/call/order-integration/v2/orders`
(`page` · `limit=100` · `sort=-orderedAt` · `orderedAtMin/Max` UTC ISO) 응답을 **개인정보 없이 줄인 JSON** 으로 받아 계산한다 (`src/home-report-pro.ts`).
로그인 토큰은 관리자 화면 요청 헤더에만 있다 — 파일·레포 어디에도 남기지 않는다. 지금은 관리자에 로그인한 브라우저에서 받아 둔 파일로 만든다.

```bash
npx tsx src/home-daily.ts kop 2026-10-27 --pro-json kop-orders.json --out r.json   # 계산만 (기록 없음)
```

JSON: `{store, from, to, orders:[{id, orderedAt, paidAt, payment, market, totalAmount, deliveryFee, sectionDeliveryFee, discountDeliveryFee,
discountAmount, totalDiscountAmount, refundAmount, types, items:[{poid, name, optDisplay, optValues, qty, unitPrice, originalUnitPrice, unitAmount, discount, status, sku, pcode}]}]}`
— `from`~`to` 밖의 날짜는 거절 (그 기간 주문이 다 있다는 뜻). 이름·연락처·주소·메모·작성형 옵션은 넣지 않는다.

규칙 (2026-10 세 상점 주문 3,600여 건으로 확인):

- 날짜 = `paidAt` 을 KST 로 (**결제일** — 오피스 마케팅팀 실시간 매출 pro-sales 와 같은 기준, 3개 상점 82일 모두 일치).
  입금 전 무통장(`paidAt` 없음)은 안 센다 (미입금은 24시간 뒤 `cancelled`). 무통장 · 자정 넘긴 네이버페이 포인트 결제는 다음 날 결제라
  주문 데이터는 그날보다 **이틀 앞 주문부터** 있어야 한다 (`proCoversDay`). `market`: `commerce`(자사몰 결제) · `naver-pay`(네이버페이 주문형).
- `totalAmount = Σ(unitPrice × qty) − (totalDiscountAmount − discountAmount) + deliveryFee + sectionDeliveryFee − discountDeliveryFee`
  · 상품 줄: `unitAmount = originalUnitPrice × qty`, `unitAmount − discount = unitPrice × qty`. `discountAmount = Σ 상품 줄 discount`.
- `payment`: `paid` · `partially-refunded`(일부 환불) · `under-refunded`(네이버페이 반품 보류, 아직 환불 전) → 매출 후보. `cancelled` · `refunded` → 제외.
  `cancelled` 에 `totalAmount − refundAmount` 를 쓰면 안 된다 — 네이버페이 결제 후 취소는 배송비만 남거나 상품 줄이 수량 0 으로 지워진 채 환불 0 으로 남는다.
- 상품 줄 `status` 에 cancel · refund · return 이 들어가면(요청 · 보류 포함) 제외. 남은 상품이 없는 주문은 제외.
  오피스 실시간 매출은 진행 중인 요청 · 보류(`refundRequested` · `returnRequested` · `returnHoldback` · `returnReturnArrived`)를 아직 매출로 센다 —
  보고서는 에이블리 보고서처럼 미리 뺀다 (승인되면 `refundAmount` 가 생기고, 철회되면 다시 계산할 때 들어온다).
- 주문 실결제 = min(`totalAmount − refundAmount`, 남은 상품 금액 − 주문 단위 추가 할인 + 배송비).
  주문 단위 추가 할인 = `totalDiscountAmount − discountAmount` (코즈미 자사몰 2,000원 쿠폰류만 있음 — 보고서 `coupon_discount`).
  `discountAmount` · 상품 줄 `discount` 는 정가 대비 할인이라 이미 판매가에 반영돼 있다 (다시 빼지 않음). 배송비는 주문 단위 값만 (상품 줄 `deliveryFee` 는 줄마다 반복).
- 네이버페이 주문형이 프로에 들어온 날: 코페리 **10-20**, 아페티 **10-22**, 코즈미 9월부터 (10-16 ~ 10-19 만 0건 — 연동 바꾸는 사이로 보임).
  그 전 프로 데이터는 구 식스샵에서 옮겨 온 **자사몰 주문만** (주문번호 `YYYYMMDD`+5자 — 코페리 10-06 ~ 10-20, 아페티 09-01 ~ 10-21) —
  네이버페이 주문형은 옮겨 오지 않았다. 주문번호 16자리 숫자 = 네이버페이, 12자리 영숫자 = 프로 자사몰.
  → 그 기간은 프로 데이터로 만들지 않고 구 식스샵 주문 엑셀(`--xlsx`)로 채운다. 코페리 10-17 ~ 10-19 는 프로에 결제 0건 (구 식스샵 확인 필요).

## 실행 (일반 식스샵 — 옮기기 전 기간)

맥미니 자동 설치 관리자가 `mac/jobs/home-daily-kop.job` 대로 **매일 07:20 · 21:00** 실행했다 (지금은 꺼 둠 — 위 참고. 둘 다 어제분, 밤 실행은 낮에 들어온 광고비·늦은 취소 반영).

```bash
npm run home-daily -- kop                                    # 어제
npm run home-daily -- kop 2026-10-27                         # 특정 날짜 (최근 약 10일 안 — 엑셀이 최근 주문부터라)
npm run home-daily -- kop 2026-10-27 --dry                   # 수집·계산만
npx tsx src/home-daily.ts kop 2026-10-05 --xlsx 주문.xlsx --out r.json   # 받아 둔 엑셀로 계산만 (로그인·기록 없음)
```

env (맥미니 `~/brightbeed-auto/sixshop-collector/.env`): `SIXSHOP_EMAIL_KOP` · `SIXSHOP_PASSWORD_KOP` · `REPORTS_GITHUB_TOKEN`
(선택) `HOME_FEE_RATE` · `HOME_NAVERPAY_FEE_RATE` (기본 둘 다 0.035) · `HOME_SHIPPING_COST` (기본 2200)

## 데이터

| 항목 | 출처 |
|---|---|
| 주문 | 식스샵 관리자 주문 엑셀 — "상품별로 행 나누기", 상태 전체, 최근 주문부터 (`src/sixshop.ts`, ERP 와 같은 로그인·다운로드) |
| 원가 | 코페리: MD팀 "코페리" 구글시트 첫 탭 C·E열(+P·Q열) → 없으면 **Product List** 탭 C·E열 (`src/ably-cost.ts` matchCost) · 아페티 · 코즈미: 아래 "아페티 · 코즈미 원가" |
| 광고비 | 오피스 광고 시트 `beaduniverse/data/ad-sheets/kop.json` 그날 `krw` (없으면 `usd` × 환율) — 마케팅팀이 다음 날 입력 |
| 기록 | 비공개 레포 `brightbeed-reports` 의 `home/kop/daily/{date}.json` · `home/kop/index.json` (`src/reports-repo.ts`) |

## 아페티 · 코즈미 원가

시트 E열이 위안(￥), **F열 "공급가"(원) = ￥ × 300** 이 원가 (전 행 확인). 코페리처럼 C·E열로 읽으면 위안을 원으로 읽는다.

| 브랜드 | 탭 (앞이 우선, `src/home-daily.ts` `APETI_COSTS` · `KOZMI_COSTS`) |
|---|---|
| 아페티 | Product List(gid 1838386820) C·F → 공홈 가격 수정 표(390277054) C·F → 플랫폼 세트(141680769) C·F |
| 코즈미 | Product List(1819637012) C·F → 50%할인이벤트(59467872) A·B |

두 브랜드 공홈은 상품 하나에 **옵션으로 실제 상품을 고르는** 묶음 · 선택형이 많아 원가 매칭 2판(`src/cost-match.ts` matchCostV2)을 쓴다 —
옵션 "키: 값"의 값에 적힌 시트 상품을 합산 ("구매 형식: 단품"이면 첫 상품만), "[SET] A + B" 상품명, 단어 경계 · 한 단어 이름(R-08) ·
한글 색상 · 번호 범위(2-6). 아페티 옵션 표기 별칭(`APETI_ALIASES`) · Bold ORION 특례는 `home-daily.ts`.
2026-09 ~ 10 주문(아페티 4,557개 · 코즈미 871개)으로 잰 결과: 아페티 전부 확인(기존 방식 미확인 1,297개), 코즈미 미확인 0 · 기본값 3.
새 옵션 표기가 나오면 보고서에 "미확인"으로 뜬다 → 별칭 추가.

MD팀 확인할 것: 아페티 플랫폼 세트 탭 White/Matt ORION 값이 한 칸씩 밀림(Product List 값을 씀) · con ring 은 플랫폼 세트에만 900원 · tid ring 0원.
코즈미 Product List ↔ 발주 리스트 위안이 다른 5개(Seastar · Green Orb · White Pearl · Candy · Pearl beads 블랙 — 행이 밀려 복사된 듯).

## 식스샵 주문 엑셀 규칙 (2026-10 코페리 실제 파일로 확인)

- 상품마다 한 행. **주문 단위 값(결제 금액 · 배송비 · 쿠폰/할인 코드/총 할인 · 적립금 · 상품 합계 금액)은 그 주문 모든 행에 반복** → 주문번호당 한 번.
- `결제 금액 = Σ 상품별 결제 금액 + 배송비`, `Σ 상품별 결제 금액 = 상품 합계 금액 − 총 할인 금액 − 사용한 적립금`
- 날짜는 `주문 일자` 뿐 (결제일 열 없음). 가상 계좌는 입금 전 `입금 대기`.
- 부분 취소가 있으면 금액 열은 원래 값, `부분 취소 후 잔액` 이 남은 금액.
- 한 번에 최근 1,000건까지 — 코페리는 약 10일치.
- 결제 방법에 `(네이버페이 주문형)` 이 붙은 주문이 **절반 이상**. 오피스 마케팅팀 "브랜드별 실시간 매출"의 공홈 숫자(맥미니 pro-sales)가
  프로로 옮기기 전 기간엔 식스샵 결제만과 같았는데 (2026-09-28: 1,276,400원, 네이버페이 포함 전체 2,858,600원), 그 기간 프로 데이터에
  네이버페이 주문형이 없어서였다 — pro-sales 자체는 네이버페이를 포함해 센다 (위 "식스샵 프로" 절).

## 계산

```
실결제 = Σ 주문 결제 금액 (상품 + 고객이 낸 배송비, 부분 취소는 잔액)        ← 네이버페이 주문형 포함
수수료 = 식스샵 결제분 × HOME_FEE_RATE + 네이버페이분 × HOME_NAVERPAY_FEE_RATE   ← 실제 요율 확인 전 가정값
배송비 = 주문 수 × 2,200원 (택배비)
순이익 = 실결제 − 수수료 − 배송비 − 광고비 − 원가
```

- 제외: 주문 상태에 취소·반품·환불(요청 포함)·입금 대기, 상품별 주문 상태 "전체 취소" 상품.
- 수량은 `수량 − 취소/반품 상품 수량`.
- 주문 단위 할인은 상품별 결제 금액 비율로 상품 줄에 나눠 표시.
- 기획전 · 쿠폰 목록은 아직 수집 안 함 (보고서 `events_note` · `coupons_note`).
- 저장 안 하는 열: 주문자·배송지 정보, 연락처, 메모, 작성형 옵션(고객이 쓴 글).
- 엑셀 열 이름이 바뀌면 보고서 `assumptions.missing_columns` 에 남는다.
