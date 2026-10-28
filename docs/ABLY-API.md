# 에이블리 셀러 어드민 API (비공식)

2026-10-27, my.a-bly.com(코페리 마켓) 화면에서 캡처. 공식 오픈 API가 아니라 셀러 어드민이 내부적으로 쓰는 API라 예고 없이 바뀔 수 있다.

- Base: `https://api.a-bly.com`
- 인증: `Authorization` 헤더 (로그인 토큰). 쿠키 아님.
- 로그인: `POST /seller/login/` (아이디·비밀번호) → 토큰
- CORS: `Access-Control-Allow-Origin: https://my.a-bly.com` 만 허용 → **github.io(오피스)에서 브라우저로 직접 호출 불가**. 서버/러너에서 호출해야 함.
- 셀러 어드민은 새로고침하면 로그인이 풀림 (토큰을 메모리/탭 단위로 보관).

## 주문 — `GET /seller/order_items/`

파라미터: `order=-checked_at`, `page`, `per_page`(30), `delivery_type[]`(standard·today·combine·reserved), `start_date`, `end_date`(`YYYY-MM-DD HH:mm:ss`), `date_type=checked_at`
건수: `GET /seller/order_items/total-count/` (같은 파라미터)

응답: `{ per_page, current_page, order_items[], has_more_window, window_start_page_number, window_max_page_number }`

`order_items[]` 주요 필드:

| 필드 | 뜻 |
|---|---|
| `sno` / `order_sno` | 주문상품번호 / 주문번호 (배송비 2,000원은 order_sno 단위로 1회) |
| `ordered_at`, `checked_at` | 주문일, 주문확인일 |
| `status`, `processing_sub_status` | 주문 상태 |
| `goods_sno`, `goods_name`, `goods_custom_code`, `option_info`, `ea` | 상품·옵션·수량 |
| `price` | 판매가 |
| `exact_coupon_discount` | 쿠폰 할인액 (0보다 크면 쿠폰 사용) |
| `exact_emoney_discount`, `exact_pay_benefit_discount` | 적립금·결제혜택 할인 |
| `exact_amount` | **실결제금액** |
| `coupon_amount_for_ably` 등 `*_for_ably` | 할인 중 에이블리 부담분 |
| `balance_accounts_scheduled_at` | 정산 예정일 |
| `delivery_type`, `pay_method_name`, `channel` | 배송유형, 결제수단, 채널 |
| `buyer_*`, `receiver_*`, `memo` | **개인정보 — 저장·커밋 금지** |

예) price 17,400 − 쿠폰 2,080 = exact_amount 15,320 (쿠폰 중 354원은 에이블리 부담)

## 정산

- `GET /seller/balance_accounts/histories/?start_date&end_date` → `balance_accounts_histories[]` — 날짜는 **`YYYY-MM`(월)**. 일자(`YYYY-MM-DD`)를 넣으면 500
  - `payment_amount`(결제액), `payment_fees`(결제수수료), `platform_fees`(판매수수료), `category_fees`, `promotion_amount`(프로모션 차감), `delivery_amount`, `logistics_fee`, `total_amount`(정산액), `scheduled_at`, `is_completed`, `period`
  - 실측: 결제 11,119,481 → 결제수수료 4.4%, 판매수수료 23.1%, 정산 9,718,964
- `GET /seller/balance_accounts/goods/?page&per_page&start_date&end_date` → 상품별 `quantity`, `payment_amount`, `amount`(정산액). 합계 `total_payment_amount`, `total_amount`

## 기획전 — `GET /seller/event-applications/?page&per_page&is_apply_period`

`event_application_list[]`: `name`, `event_type`, `discount_type`, `apply_start_date`~`apply_end_date`, **`event_start_date`~`event_end_date`**, `is_applied`, `applied_status`, `applied_goods_count`, `approved_goods_count`, `is_need_seller_coupon`
→ 오늘이 event 기간 안이고 `approved_goods_count > 0`이면 "진행 중".

## 쿠폰 — `GET /seller/coupons/?filter_type&coupon_type&page&per_page`

`coupons[]`: `management_name`, `discount_type`(`"1"` 정률 · `"0"` 정액), `issue_state`(complete·suspend …), `discount_price`/`discount_percent`, `minimum_price`, `max_discount_price`, `used_count`, `total_count`, `coupon_discount`, `roas`, `started_at`~`finished_at`, `issue_state`

## 광고비 — `GET /seller/ad_markets/{ad_market_sno}/statistics_timeseries/?start_at&end_at&periodicity=daily`

배열 `[{ datetime, charge(광고비), order_price(광고 기여 매출), order_count, display, click, roas, … }]`. 날짜는 `YYYY-MM-DD`. 코페리 ad_market_sno = 46903.

## 일일 보고서 수집기

`npm run ably-daily [YYYY-MM-DD]` → `src/ably-daily.ts`. 결과는 비공개 레포 `j65209/brightbeed-reports`의 `ably/daily/{date}.json`·`ably/index.json`과 구글시트 `에이블리_일일`·`에이블리_주문` 탭. 오피스 "전략팀 → 플랫폼 탭 → 코페리 · 에이블리"가 프록시로 읽는다 (전략팀은 전승훈·전수빈·김수민만).

맥미니에서 매일 07:10 자동 실행 — `mac/jobs/ably-daily.job` (자동 설치 관리자, [`mac/README.md`](../mac/README.md)). 설정값은 맥미니 `~/brightbeed-auto/sixshop-collector/.env`.

## 기타

- 통계: `GET /seller/statistics/`, `GET /seller/statistics/goods/` (`results[]`)
- 대시보드: `/seller/dashboard/{delivery,cancel,exchanges,balance_account,ad_performance}/`
- 상품: `POST /seller/goods/search/`, `GET /seller/goods/{id}/`
- 광고: `/seller/ad_campaigns/`, `/seller/ad_promotion/payback/info/`
