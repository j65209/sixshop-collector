# 식스샵 + 스마트스토어 통합 ERP 시스템

> **이 문서는 다른 Claude/사람한테 시스템 전체를 한 번에 설명하기 위한 단일 진입점.**
> 레포: `j65209/sixshop-collector` (private). 운영 주체: brightbeed.

## 1. 시스템 한 줄 요약

3개 브랜드(6A · CT · PP)의 식스샵 주문/재고를 GitHub Actions cron으로 매일 1회 자동 수집하고, PP 브랜드는 추가로 네이버 스마트스토어 판매 데이터까지 통합해서 단일 Google Sheet(`브랜드 재고현황`)에서 재고를 효율적으로 관리하는 시스템.

## 2. 데이터 흐름

```
[식스샵 대시보드 3개]    [네이버 스마트스토어 PP]
      ↓ Playwright              ↓ Naver Commerce API
      ↓ (GHA cron)              ↓ (사용자 PC, 수동)
      ↓                         ↓
      ↓                  PP SS주문로그 시트 (SS상품번호 K열로 매핑키 보유)
      ↓                         ↓
   {6A,CT,PP} 주문로그         PP 매핑 시트 (식스샵상품명 ↔ SS상품번호)
      ↓                         ↓ SUMIF
   {6A,CT,PP} 재고마스터  ────→ PP 매핑 시트의 통합 뷰 (식스샵재고+식스샵판매+SS판매)
```

## 3. 브랜드별 시트 탭

스프레드시트: `브랜드 재고현황` (`SHEET_ID`는 GitHub Secret)

| 탭 이름 | 용도 | 갱신 |
|---|---|---|
| **6A 재고마스터** | 6A 옵션별 재고/판매/남은재고 (8-col) | GHA cron 매일 |
| **CT 재고마스터** | CT 옵션별 재고/판매/남은재고 (8-col) | GHA cron 매일 |
| **PP 재고마스터** | PP 옵션별 재고/판매/남은재고 (8-col, 식스샵만) | GHA cron 매일 |
| 6A 주문로그 | 6A 식스샵 누적 주문 | GHA cron, 숨김 |
| CT 주문로그 | CT 식스샵 누적 주문 | GHA cron, 숨김 |
| PP 주문로그 | PP 식스샵 누적 주문 | GHA cron, 숨김 |
| {brand} _state | 마지막 실행/상태 | GHA cron, 숨김 |
| **PP SS주문로그** | PP 스마트스토어 주문 (productOrderId로 dedup) | `npm run sync-ss` 수동 |
| **PP 매핑** | PP **product-level 통합 대시보드** (재고관리 메인 뷰) | 수식이 자동 계산 |

### 재고마스터 컬럼 (모든 브랜드 동일, 8-col)

| 열 | 의미 |
|---|---|
| A | 카테고리 |
| B | 상품명 |
| C | 옵션 |
| D | SKU |
| E | 현재재고(M.D완료) |
| F | 판매수량(M.D완료) — 식스샵 주문로그 SUMIFS |
| G | 남은재고 = E - F |
| H | 리오더 알림 (≤5: ⚠리오더, ≤10: ⚡임박) |

J1 셀: `최신화: YYYY-MM-DD HH:MM` (KST). 헤더에 필터 적용.

### PP 매핑 시트 컬럼 (8-col)

| 열 | 의미 | 수식 |
|---|---|---|
| A | 식스샵 상품명 | (수동/setup 스크립트) |
| B | SS상품번호 (originalProductId) | (수동/setup 스크립트) |
| C | 비고 | "SS 미판매" 등 |
| D | 식스샵 총재고 | `=SUMIF('PP 재고마스터'!B:B, A{r}, 'PP 재고마스터'!E:E)` |
| E | 식스샵 총판매 | `=SUMIF('PP 재고마스터'!B:B, A{r}, 'PP 재고마스터'!F:F)` |
| F | SS 판매 (30일 누적) | `=IF(B{r}="", 0, SUMIF('PP SS주문로그'!K:K, B{r}, 'PP SS주문로그'!H:H))` |
| G | 남은재고 | `=D{r}-E{r}-F{r}` |
| H | 리오더 알림 | `=IF(G{r}<=20, "⚠ 리오더", IF(G{r}<=50, "⚡ 임박", ""))` |

### PP SS주문로그 컬럼 (11-col)

| 열 | 의미 |
|---|---|
| A | 주문번호 (orderId) |
| B | 상품주문번호 (productOrderId) — dedup 키 |
| C | 주문일시 (KST) |
| D | 상태 (PAYED/DELIVERING/PURCHASE_DECIDED 등) |
| E | 상품명 |
| F | 옵션 |
| G | SKU (sellerProductCode, 보통 비어있음) |
| H | 수량 — 매핑 SUMIF 합산 대상 |
| I | 결제금액 |
| J | 수집일시 (KST) |
| **K** | **SS상품번호 (originalProductId)** — 매핑 시트와 SUMIF 매칭 키 |

## 4. 운영 절차

### 일일 자동 (GitHub Actions)
- 매일 KST 08:00 (cron `0 23 * * *` UTC)
- `.github/workflows/collect.yml` → `tsx src/index.ts`
- 3개 브랜드 순회: 식스샵 로그인 → 주문 수집 → 재고 새로고침
- 사용 시크릿: `SIXSHOP_EMAIL[_brand]`, `SIXSHOP_PASSWORD[_brand]`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SHEET_ID`

### 수동 (사용자 PC)
- 스마트스토어 동기화: `npm run sync-ss`
  - 기본 7일 윈도우. `SS_DAYS=30` 환경변수로 조정.
  - `SS_REBUILD=1`이면 PP SS주문로그 clear 후 재적재 (스키마 변경 시).
  - **반드시 사용자 집 IP에서 실행** — 네이버 커머스 API에 IP 화이트리스트 등록되어있음.
  - GitHub Actions에서 못 돌리는 이유: Azure 데이터센터 IP 동적이라 화이트리스트 불가
- 매핑 시트 재구성: `npm run setup-pp-mapping`
  - `src/setup-pp-mapping.ts`의 `MAPPING` 객체 수정 후 실행
  - 31개 상품 + 식스샵상품명 → SS originalProductId

### 권한/인증
- 식스샵: 브랜드별 이메일+비번 (GHA Secrets)
- 네이버 커머스 API: Application ID + Secret (사용자 PC `.env`만, GHA에서 안 씀)
  - 등록 페이지: https://apicenter.commerce.naver.com/
  - 권한 그룹: 상품 조회, 주문 판매자
  - 사용자 IP 등록 필수 (집 IP 변경 시 재등록)
- Google Sheets: 서비스 계정 `sixshop-bot@sixshop-collector.iam.gserviceaccount.com`
  - 시트 편집 권한 부여됨

## 5. 핵심 파일 (`src/`)

| 파일 | 책임 |
|---|---|
| `index.ts` | GHA 진입점. 브랜드 순회 → 주문 수집 → 재고 새로고침 |
| `brands.ts` | 브랜드 정의 (siteLink, displayName, ordersSheetName, smartStore 옵션 등) |
| `config.ts` | env loading (`.env` 또는 GHA secrets) |
| `sheets.ts` | Google Sheets API 래퍼 (ensureBrandSchema, append, readKeys) |
| `sixshop.ts` | Playwright 식스샵 로그인 + 주문 fetch + 상품 CSV download |
| `seed-inventory.ts` | 재고마스터 갱신 (CSV 파싱, mall API 옵션재고, SUMIFS 수식, 필터, J1 타임스탬프) |
| `types.ts` | OrderItem/OrderRow/rowKey/toRow |
| `smartstore.ts` | 네이버 커머스 API (bcrypt OAuth, last-changed-statuses + product-orders/query, 24h 청크 + rate-limit retry) |
| `sync-smartstore.ts` | SS 동기화 진입점 (수동 실행) |
| `setup-pp-mapping.ts` | PP 매핑 시트 생성/갱신 (수동 실행) |
| `probe-ss.ts` | 진단용. seller/account, channels, products/search 호출 |
| `list-products.ts` | 진단용. 양쪽 상품 리스트 dump |

## 6. PP 상품 매핑 (29개 + 미매핑 2개)

`src/setup-pp-mapping.ts`의 `MAPPING` 객체에 정의되어 있음. 식스샵 상품명 → SS `originalProductId` (=`originProductNo`):

```
Jacquard Fast Charging Cable (7color)   → 11449641752
180° Fast Charging Cable (8color)        → 12626896003  (1.5m, 판매중만)
Metallic Hair Pin                         → 12659660500
Freestanding Holder (Silver)              → 10412786795
Miniature Refrigerator Magnet             → 12434433055
Metallic Ribbon Passport Case             → 12757255891
Curve Toilet Mini Brush (4color)          → 12659581106
Soft Silicone Carry Pouch (9color)        → 12659697137
Cloud Grip Glass Mini Brush (3color)      → 12659521325
Stripe Sucker Drawstring Pouch (4color)   → 12717146576
Poni Mesh pouch bag (4color)              → 11491934097
TRAVELER pouch bag (5color)               → 11524947528
Corduroy Drawstring Pouch (5color)        → 12659557092
Wirst Rest Mouse Pad (8color)             → 13316384937
Kitsch Pop Hair Pin                       → 12659617268
Check Mirror Smart Tok (4color)           → 12717131712
Toy Screw Hook (Set)                      → 12659711603
Pixel Mini Handle Pouch (4color)          → 12434723552
Compact Phone Stand (6color)              → 12659544857
Ball hanger (6color)                      → null  (SS 미판매)
STAINLESS STEEL TRAY (silver)             → 11779969107
1+1 Silk Scrunch (9color)                 → 11525494276
Basic Toliet Slippers (6color)            → 13316409005
Character Snack Clip (4color)             → 12659492397
360° Rotating Phone Holder                → null  (SS 미판매)
Food Bottle Opener                        → 12560362204
Fuzzy Stripe Slippers (3color)            → 12659591974
Padded Color Pouch (4color)               → 12659675938
Cotton Lunch Mini Bag (5color)            → 12659568722
Arrow Magnet (Set)                        → 12659476551
Light UV 99.9 Umbrella (7color)           → 12359059623
```

## 7. 알려진 이슈 / 제약

- **PP 식스샵 vs SS 옵션 mismatch**: 식스샵은 (color × connector × length)을 옵션으로, SS는 length별로 별도 상품. 그래서 매핑은 product-level만. 옵션별 매칭은 불가능 (실수 위험).
- **SS 30일 판매 vs 식스샵 현재재고 불일치**: 180° Cable처럼 SS에서 빠르게 팔린 상품은 남은재고 음수 (-4663) — 즉시 리오더 신호.
- **집 IP 변경 시 sync-ss 인증 실패**: 네이버 커머스 API는 등록 IP만 허용. https://api.ipify.org 로 IP 확인 후 https://apicenter.commerce.naver.com 가서 재등록.
- **GitHub Actions 큐 적체**: 자원 부족 시 5~10분 대기 후 시작.
- **재고마스터 일부 옵션의 stock 99999**: 식스샵에서 "재고 관리 안 함"으로 설정된 상품. mall API에서 정확한 옵션재고 가져오는 로직 있음.
- **PP 매핑 새 상품 추가 시**: `src/setup-pp-mapping.ts` MAPPING 객체에 한 줄 추가 → `npm run setup-pp-mapping` 재실행.

## 8. 환경변수 (`.env` for local sync-ss)

```
NAVER_CLIENT_ID_PP=<네이버 Application ID>
NAVER_CLIENT_SECRET_PP=<네이버 Application Secret, $2a$04$... bcrypt salt>
GOOGLE_SERVICE_ACCOUNT_PATH=C:/Users/.../sixshop-collector-XXX.json
SHEET_ID=<Google Sheet ID>
```

GHA Secrets:
```
SIXSHOP_EMAIL, SIXSHOP_PASSWORD       (6A)
SIXSHOP_EMAIL_CLEARTYPE, ...           (CT)
SIXSHOP_EMAIL_PP, ...                  (PP)
GOOGLE_SERVICE_ACCOUNT_JSON            (JSON 한 줄)
SHEET_ID
```

## 9. 외부 시스템에서 ERP 연결하려면

이 ERP는 **Google Sheet 한 장이 단일 진실의 원천**. 외부 도구(예: 브라이트비드 오피스 웹 페이지)에서 데이터 보거나 트리거하려면:

- **읽기**: Google Sheets API로 `SHEET_ID` 직접 조회 (서비스 계정 JSON 또는 OAuth)
  - 예: PP 매핑 시트 A:H를 fetch해서 리오더 필요한 상품만 필터
- **재고 갱신 트리거**: GitHub Actions `workflow_dispatch` API 호출
  - `POST https://api.github.com/repos/j65209/sixshop-collector/actions/workflows/collect.yml/dispatches`
  - 토큰: GitHub fine-grained PAT (Actions write 권한)
- **SS 동기화 트리거**: 사용자 PC에서만 실행 가능 (네이버 IP 화이트리스트). 외부에서 트리거 불가 — 사용자가 직접 cmd 실행하거나 Windows 작업 스케줄러 등록

원격 트리거는 식스샵 GHA 워크플로 정도만 가능. SS 동기화는 본질적으로 로컬 작업.

---

**최종 갱신**: 2026-05-06. 변경 시 본 문서도 같이 업데이트.
