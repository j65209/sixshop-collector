# 시스템 구조

이 ERP가 어떻게 동작하는지 — Claude Code가 코드 작업할 때 컨텍스트로 사용.

## 큰 그림

```
[GitHub Actions cron]              [사용자 PC, 옵션]
       │                                  │
       ├─ index.ts                        ├─ sync-smartstore.ts
       │   ├─ 식스샵 admin 로그인          │   └─ 네이버 Commerce API
       │   ├─ 주문 fetch → 주문로그 시트   │       └─ SS 주문로그 시트
       │   └─ inventoryEnabled 브랜드 →    │
       │       seed-inventory.ts          └─ refresh-pp-master.ts
       │       └─ 재고마스터 시트              └─ 식스샵 raw + SS API + 매핑
       │           (단일 채널: 7-col)              → PP 재고마스터 dashboard
       │           (다채널: raw 7-col)
       │
       └─ Google Sheets API
```

## 채널 구성

### 단일 채널 브랜드 (식스샵만)
- `brands.ts`에 `smartStore` 필드 **없음**
- GHA cron이 식스샵 주문/재고 → 한 시트(`재고마스터`)에 박음
- **사용자 PC 의존 없음** — 100% 자동

### 다채널 브랜드 (식스샵 + 스마트스토어)
- `brands.ts`에 `smartStore` 필드 **있음**
- GHA가 식스샵 raw → `식스샵 재고마스터` 시트
- 사용자 PC가 `vm-pp-cycle` (sync-ss + refresh-pp-master) → 합산 dashboard 시트
- **이유**: 네이버 Commerce API가 IP 화이트리스트라 GHA 클라우드 IP 거부

## 파일별 역할

### 핵심 (모든 셋업에 필요)
- `src/brands.ts` — 브랜드 정의 (이게 진실의 원천)
- `src/config.ts` — 환경변수 로딩
- `src/sixshop.ts` — 식스샵 admin 자동화 (Playwright)
- `src/index.ts` — GHA cron 메인. 모든 브랜드 순회
- `src/sheets.ts` — Google Sheets API 헬퍼
- `src/seed-inventory.ts` — 재고마스터 시트 갱신 (단일 채널 7-col)
- `src/types.ts` — 데이터 타입 (OrderItem, OrderRow)
- `.github/workflows/collect.yml` — GHA workflow 정의

### 다채널 전용 (스마트스토어 운영 시만)
- `src/smartstore.ts` — 네이버 Commerce API 호출
- `src/sync-smartstore.ts` — SS 주문 sync (사용자 PC에서 수동)
- `src/refresh-pp-master.ts` — 식스샵+SS 합산 dashboard 갱신 (사용자 PC에서 수동)
- `src/setup-pp-mapping.ts` — 식스샵 ↔ SS 매핑 시트 셋업

### 디버그/탐색 (참고만)
- `src/probe-ss.ts` — SS API 응답 구조 탐색
- `src/list-products.ts` — SS 상품 목록 dump

## 데이터 흐름 (단일 채널)

```
1. GHA cron 트리거 (KST 08:00)
2. index.ts main()
   for each brand in BRANDS:
     a) loginAsBrand(page, brand)         # sixshop.ts
     b) fetchOrdersForBrand → orders[]    # sixshop.ts (Playwright XLSX 다운로드)
     c) appendNewOrders → 주문로그 시트    # sheets.ts (dedup)
     d) refreshInventoryForBrand          # seed-inventory.ts
        - downloadProductsCsv             # 식스샵 상품 CSV
        - fetchOptionStocks (mall API)    # 옵션별 재고
        - computeSalesByKey               # 어제 판매 (lastRunAt 기반)
        - pushToStockSheet → 재고마스터    # 7-col: 카테고리/상품명/옵션/SKU/현재재고/어제판매/남은재고/리오더
3. _state 시트에 last_run_at + last_run_status 기록
```

## 데이터 흐름 (다채널, PP 패턴 참고)

```
[GHA cron]
1~3. 위와 동일. 단 stockSheetName이 "PP 식스샵 재고마스터" (raw, hidden)

[사용자 PC, vm-pp-cycle]
4. sync-smartstore.ts
   - 네이버 Commerce API로 SS 주문 fetch
   - "PP SS주문로그" 시트에 append
5. refresh-pp-master.ts
   - "PP 식스샵 재고마스터" raw 읽기
   - "PP 매핑" 시트 읽기 (식스샵상품명 ↔ SS상품번호)
   - SS API로 옵션재고 fetch
   - "PP SS주문로그"에서 어제 SS 판매 합산 (status 필터)
   - token 매칭으로 식스샵 옵션 row에 attribute (식스샵+SS 합)
   - "PP 재고마스터" dashboard 시트에 박음 (7-col 식스샵 패턴 + SS attribution)
```

## 핵심 설계 결정

### 1. Playwright + Google Sheets API
- **왜**: 식스샵 공식 API 없음. admin 페이지 자동화가 유일한 길
- **trade-off**: 식스샵 사이트 구조 변경되면 코드 fix 필요. 단 자주 안 바뀜

### 2. GHA cron + Google Sheets로 백엔드 X
- **왜**: 별도 서버/DB 운영 비용 X. GitHub 무료 한도 내. 시트가 곧 데이터베이스 + UI
- **trade-off**: 시트 행 수 1만 넘어가면 느려짐. 셀러 1인 운영 규모에는 충분

### 3. dedup 키 = (주문번호, 상품명, 옵션, 수량, 합계)
- **왜**: 한 주문에 같은 상품/옵션이 두 번 들어가는 케이스 있음 (수량/금액 다름)
- **trade-off**: 식스샵 admin에서 부분환불·할인 후처리하면 quantity/lineTotal 변경되어 같은 라인이 두 번 적재될 수 있음. 발생 시 시트 수동 정리

### 4. 단일 채널 = 1 sheet, 다채널 = 3 sheets (raw/sync/dashboard)
- **왜**: SS는 IP 화이트리스트라 GHA에서 못 부름. raw vs dashboard 분리해야 단계 가능
- **trade-off**: 다채널 브랜드는 사용자 PC 의존. 24/7 머신 필요

### 5. cron-job.org로 GHA 트리거
- **왜**: GitHub schedule cron이 9시간씩 지연됨 (KST 08:00 → KST 17시)
- **trade-off**: 외부 의존 추가. PAT 보안 관리 필요

### 6. tokenizeOption으로 식스샵 ↔ SS 옵션 매칭
- **왜**: 두 채널 옵션 표기 다름 (예: 식스샵 "여성" vs SS "여성용"). 토큰 set 비교로 흡수
- **stop-list**: `to`, `type`, `size`, `free`, `color`, `여성`, `여성용`, `남성`, `남성용`, `공용`, `남녀공용`
- **trade-off**: 토큰 mismatch 시 매칭 실패 (unmatched 행에 표시)

## 운영 패턴

- **로컬 개발**: `HEADLESS=false npm run dev` 로 브라우저 보면서 디버그
- **로컬 시드**: `npm run seed-inventory` 로 재고마스터만 즉시 갱신
- **GHA 수동 트리거**: `gh workflow run collect.yml`
- **VM cron (다채널)**: `npm run vm-pp-cycle` (sync-ss + refresh-pp-master)

## 확장 시 고려

### 새 브랜드 추가
1. `brands.ts` BRANDS 배열에 새 객체
2. `.env` 또는 GHA Secrets에 자격증명 (suffix 따라)
3. 끝. 시트 탭은 자동 생성됨

### 새 채널 추가 (예: 쿠팡, 에이블리)
- 새 채널 fetch 모듈 (예: `ably.ts`)
- `brands.ts` brand 객체에 `ably` 같은 새 필드
- `vm-cron-cycle` 변형 (또는 GHA에 통합 — IP 화이트리스트 정책에 따라)
- dashboard 갱신기 (`refresh-XX-master.ts`)
- 매핑 시트 + setup 스크립트

PP 패턴 그대로 복사해서 변형하면 됨.
