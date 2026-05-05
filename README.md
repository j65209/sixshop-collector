# sixshop-collector

식스샵(공홈) 주문건을 1시간마다 자동 수집해 **구글 스프레드시트(재고 ERP)**에 적재합니다.

- 식스샵 공식 공개 API가 없어, **관리자 페이지를 Playwright로 자동 로그인 + 주문 데이터 수집**합니다.
- 주문 한 건이 여러 상품/옵션을 포함하면 **상품 라인별로 한 행씩** 풀어 적재합니다 (재고 차감용).
- 중복은 `(주문번호, 상품명, 옵션)` 키로 방지합니다.

## 데이터 흐름

```
GitHub Actions (cron 매시 5분)
   └─ Playwright(chromium) → sixshop.com 로그인 → /dashboard/shop-orders
        └─ 페이지 XHR 응답 인터셉트(1차) / DOM 파싱(2차)
              └─ Google Sheets API → 주문로그 시트에 append (dedup)
                    └─ _state 시트에 마지막 실행 시각/상태 기록
```

## 시트 구조

| 시트 | 컬럼 |
| --- | --- |
| `주문로그` | 주문번호 / 주문일시 / 상태 / 상품명 / 옵션 / SKU / 수량 / 단가 / 합계 / 결제방법 / 주문자 / 수집일시 |
| `_state` | key / value (`last_run_at`, `last_run_status`) |

재고 시트는 별도 시트에 SKU별 행을 만들고, `=SUMIF(주문로그!F:F, A2, 주문로그!G:G)` 같은 식으로 누적 판매 수량을 자동 집계할 수 있습니다.

## 셋업

### 1) Google 서비스 계정 발급

1. https://console.cloud.google.com/ → 새 프로젝트 → API 라이브러리에서 **Google Sheets API** 사용 설정
2. IAM → 서비스 계정 만들기 → JSON 키 다운로드
3. **이 서비스 계정 이메일을 대상 시트에 "편집자"로 공유**
4. JSON 전체를 한 줄로 만들어 `GOOGLE_SERVICE_ACCOUNT_JSON` 으로 저장

### 2) 로컬 테스트

```bash
cp .env.example .env       # 값 채우기
npm install                # postinstall에서 chromium 자동 설치
HEADLESS=false npm run dev # 첫 실행은 브라우저 보면서 셀렉터 확인
```

> 첫 실행에서 로그인/주문 페이지 셀렉터가 어긋나면 [src/sixshop.ts](src/sixshop.ts)의
> `login()`과 `parseFromXhr()`/`parseFromDom()`을 실제 식스샵 admin 구조에 맞게 보정하세요.
> XHR 응답 스키마(필드명)는 추정값이므로 첫 실행 로그에서 `captured` 객체를 한 번 출력해
> 실제 키(`orderNumber` vs `order_no` 등)를 확인하는 것이 좋습니다.

### 3) GitHub Actions 시크릿

레포의 Settings → Secrets and variables → Actions 에서:

| Secret | 값 |
| --- | --- |
| `SIXSHOP_EMAIL` | 식스샵 관리자 이메일 |
| `SIXSHOP_PASSWORD` | 식스샵 관리자 비밀번호 |
| `SIXSHOP_STORE_ID` | (선택) 멀티스토어인 경우 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 서비스 계정 JSON 전체 (한 줄) |
| `SHEET_ID` | 구글 시트 URL `/d/<여기>` |

Variables(선택):
- `ORDERS_SHEET_NAME` (기본 `주문로그`)
- `STATE_SHEET_NAME` (기본 `_state`)
- `COLLECT_DAYS` (기본 `3` — 매시 실행이라 3일이면 누락 없음)

### 4) 배포 = push

```bash
git init
gh repo create sixshop-collector --private --source=. --remote=origin --push
```

`workflow_dispatch`로 수동 실행해 첫 동작을 검증한 뒤 cron이 매시 5분에 자동 실행됩니다.

## 운영 노트

- **계정 보안**: 가능하면 식스샵에서 별도 운영자 계정을 만들어 이 봇 전용으로 쓰세요.
- **2FA 가능성**: 식스샵이 2FA를 강제하면 자동 로그인 불가 — 그 경우 `auth-state.json` 저장 후 storageState 재사용 방식으로 전환합니다.
- **요율 제한**: 1시간 cron + 최근 3일 조회는 식스샵·구글 모두 무리 없는 수준.
- **실패 알림**: 필요 시 워크플로 끝에 Slack/Discord 웹훅 step 추가 (현재는 GitHub Actions 실패 시 GitHub 자체 알림만).
