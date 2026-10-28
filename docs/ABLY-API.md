# 에이블리 셀러 어드민 API (비공식)

2026-10-27, my.a-bly.com(코페리 마켓) 화면에서 캡처. 공식 오픈 API가 아니라 셀러 어드민이 내부적으로 쓰는 API라 예고 없이 바뀔 수 있다.

- Base: `https://api.a-bly.com`
- 인증: `Authorization: JWT <access_token>` 헤더 (`Bearer` 는 401). 쿠키 아님.
- 로그인: `POST /seller/login/` `{email, password}` → `{access_token, refresh_token}` — 2026-10-28 맥미니에서 확인 (값은 안 보고 응답 키만).
  - 아이디 필드는 **`email`** 하나. `username` · `id` 는 400 `{code: 1, message: "이메일은 필수 항목입니다"}`. 비밀번호 불일치는 `{code: 2}`.
  - 응답 키는 `token` 이 아니라 **`access_token`** (JWT **1시간**) · `refresh_token` (JWT **7일**).
  - 갱신: `POST /seller/refresh/` `{refresh_token}` → 새 `access_token` · 새 `refresh_token`(또 7일). 셀러 어드민 화면(app.js `loginService.refresh`)과 같은 방식.
  - 화면에 MFA(`login/mfa`) 경로도 있음 — 지금 코페리 계정은 안 걸림. 걸리면 로그인 응답에 토큰이 없어 실패로 알림.
- 토큰 저장 (`src/ably-api.ts` `ablyLogin`): 맥미니 `~/brightbeed-auto/state/ably-token.json` (권한 600, 이메일 해시로 계정에 묶음).
  access_token 이 15분 넘게 남았으면 그대로 → 아니면 refresh → 그것도 안 되면 로그인. 401 이면 한 번만 새로 받아 다시.
  **로그인이 실패하면 같은 비밀번호로는 6시간 쉼** (계정 잠금 방지, .env 를 고치면 바로 다시). `--dry` 는 파일을 쓰지 않음.
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

## 코드

- `src/ably-api.ts` — 로그인 · 토큰 저장 · 주문(`fetchOrders`, per_page 100 + total-count 확인, 개인정보는 받은 즉시 버림) · 정산 · 광고비 · 기획전 · 쿠폰
- `src/ably-report.ts` — `buildAblyReport` 등 계산 (네트워크 없음)
- `src/ably-daily.ts` — 매일 07:10 실행 파일 (어제 하루 · 구글시트 · `--raw` 지난 기간 채우기)
- `src/ably-live.ts` — 30분마다 실행 파일 (아래)

## 일일 보고서 수집기

`npm run ably-daily [YYYY-MM-DD]` → `src/ably-daily.ts`. 결과는 비공개 레포 `j65209/brightbeed-reports`의 `ably/daily/{date}.json`·`ably/index.json`과 구글시트 `에이블리_일일`·`에이블리_주문` 탭. 오피스 "전략팀 → 플랫폼 탭 → 코페리 · 에이블리"가 프록시로 읽는다 (전략팀은 전승훈·전수빈·김수민만).

맥미니에서 매일 07:10 자동 실행 — `mac/jobs/ably-daily.job` (자동 설치 관리자, [`mac/README.md`](../mac/README.md)). 설정값은 맥미니 `~/brightbeed-auto/sixshop-collector/.env`.

## 실시간 (30분마다) — `src/ably-live.ts`

맥미니 `mac/jobs/ably-live.job` 이 **30분마다** 실행. **오늘(진행 중) · 어제** 보고서를 다시 계산해 바뀐 것만
`ably/daily/{날짜}.json` · `ably/index.json` 에 **커밋 하나로** 올린다 (`commitFiles`). 공홈 실시간(`src/home-live.ts`)과 같은 규칙.
06시 이후 그날 첫 실행은 **지난 8일**을 다시 계산 — 늦은 취소 · 반품 (상태 `~/brightbeed-auto/state/ably-live.json` `{settled}`, 실패 없을 때만 기록).

```bash
npm run ably-live                 # 오늘 · 어제 (+ 그날 첫 06시 이후 실행이면 지난 8일)
npm run ably-live -- --days 8     # 오늘부터 8일
npm run ably-live -- --dry        # 계산만 — 레포 · 상태 파일 · 토큰 파일 안 씀
```

- 한 번 실행에 API: `order_items` 를 `date_type=checked_at` 로 가장 오래된 날 00:00 ~ 지금 한 번(per_page 100, total-count 로 건수 확인),
  정산 `histories` 는 필요한 달마다(`feeWindow`), 광고비 `statistics_timeseries` 는 기간 한 번, 기획전 · 쿠폰은 한 번. 로그인은 거의 안 함(토큰 저장 · refresh).
- 오늘 보고서에는 `as_of`(계산 시각 HH:MM, KST) · `assumptions.partial_day: true` — index.json 줄에도 `as_of`. 자정이 지나면 그날은 `as_of` 없이 다시 올라간다.
  숫자가 그대로면 안 올리지만 55분이 지나면 오늘 파일 시각만 새로 올림. 지난 날짜 쿠폰은 그날 이후 시작한 것을 뺀다 (`couponsAsOf`).
- 실패 처리: 에이블리 · GitHub 읽기 · 원가 시트(보충 탭 포함) 중 하나라도 실패하면 **아무것도 덮지 않고** 종료 코드 1 (`ghGetJson` 은 404 만 "없음").
- env: `ABLY_EMAIL` · `ABLY_PASSWORD` · `ABLY_AD_MARKET_SNO` · `REPORTS_GITHUB_TOKEN`. 시험: `npx tsx tests/ably-live.test.ts` (네트워크 · 계정 없이).
- 매일 07:10 `ably-daily`(어제 하루 + 구글시트)는 그대로 둔다 — 같은 날짜 파일을 같은 계산으로 다시 쓰는 것이라 충돌 없음.

## 지난 기간 채우기 (`--raw`)

맥미니 매일 실행 전 기간을 채울 때. 로그인된 셀러 어드민 화면(크롬, 코페리 계정)에서 데이터를 한 번에 받아 파일로 저장하고
(구매자 정보 없이 — 주문은 `AblyOrderItem` 필드만), 이 PC 에서 날짜마다 같은 계산(`buildAblyReport`)으로 보고서를 만들어 **커밋 하나**로 올린다.

```bash
npx tsx src/ably-daily.ts --raw ably-kop-orders-2026-08-28_2026-10-27.json --dry   # 계산만
REPORTS_GITHUB_TOKEN=… npx tsx src/ably-daily.ts --raw ably-kop-orders-….json      # 올리기 (구글시트는 안 씀)
```

파일: `{from, to, orders[], ad[{datetime, charge, order_price}], fees{"YYYY-MM": 그 달 기준 3개월 정산 내역[]}, events[], coupons[]}`
— 주문은 `order_items` 를 `date_type=checked_at` 로 from 00:00 ~ to 23:59 (per_page 100, `total-count` 와 건수 맞출 것),
광고비는 `statistics_timeseries` 를 기간 전체로 한 번. 2026-10-28 에 8/28 ~ 10/27(61일, 1,707건)을 이렇게 채움.
쿠폰 · 기획전 목록은 지금 기준이라 지난 날짜엔 그날 이후 시작한 쿠폰은 뺀다. 크롬이 다른 마켓 계정으로 로그인돼 있으면
광고비(ad_market 46903)가 404 — 코페리 계정인지 먼저 확인.

## 기타

- 통계: `GET /seller/statistics/`, `GET /seller/statistics/goods/` (`results[]`)
- 대시보드: `/seller/dashboard/{delivery,cancel,exchanges,balance_account,ad_performance}/`
- 상품: `POST /seller/goods/search/`, `GET /seller/goods/{id}/`
- 광고: `/seller/ad_campaigns/`, `/seller/ad_promotion/payback/info/`
