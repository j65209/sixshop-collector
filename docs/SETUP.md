# 처음 셋업 가이드

이 시스템을 본인 셀러 계정에 적용하는 0부터 단계별 가이드.
약 1시간 소요. 막히면 Claude Code에 "이 단계에서 막혔어"라고 물어보면 됨.

## 사전 준비물 (이미 있어야 할 것)

- 식스샵 셀러 계정 (이메일 + 비밀번호)
- Google 계정
- GitHub 계정
- (옵션, 스마트스토어 운영 시) 네이버 Commerce API 클라이언트 ID/Secret
- 본인 PC에 설치: **Node.js 20+**, **Git**, **GitHub CLI(gh)**

설치 안 됐으면:
- Node.js: https://nodejs.org/en/download (LTS 버전)
- Git: https://git-scm.com/download/win
- gh: https://cli.github.com/

---

## STEP 1 — Google 서비스 계정 + 스프레드시트 (15분)

### 1-1. Google Cloud 프로젝트 만들기
1. https://console.cloud.google.com/ 접속
2. 상단 프로젝트 드롭다운 → **새 프로젝트** → 이름 `sixshop-erp` → 만들기

### 1-2. Google Sheets API 사용 설정
1. 좌측 메뉴 → **API 및 서비스** → **라이브러리**
2. `Google Sheets API` 검색 → **사용 설정**

### 1-3. 서비스 계정 만들기
1. 좌측 → **사용자 인증 정보** → **사용자 인증 정보 만들기** → **서비스 계정**
2. 서비스 계정 이름: `sixshop-bot` → 만들기 → 완료
3. 만들어진 서비스 계정 클릭 → **키** 탭 → **키 추가** → **새 키 만들기** → **JSON** → 다운로드
4. JSON 파일 안전한 곳에 보관 (예: `~/Downloads/sixshop-key.json`)

### 1-4. 구글 스프레드시트 만들기
1. https://sheets.google.com 에서 **빈 스프레드시트**
2. 이름 정하기 (예: `식스샵 ERP 마스터`)
3. 우상단 **공유** 클릭
4. JSON 파일 안의 `client_email` 값 (예: `sixshop-bot@xxx.iam.gserviceaccount.com`) 입력
5. 권한 **편집자** → 보내기
6. 시트 URL 복사: `https://docs.google.com/spreadsheets/d/<여기가SHEET_ID>/edit`

---

## STEP 2 — 코드 받기 (5분)

본인 PC 터미널 (Git Bash 또는 PowerShell):

```bash
cd ~/Desktop                                    # 또는 원하는 폴더
git clone https://github.com/<본인-username>/sixshop-collector.git
cd sixshop-collector
npm install                                     # postinstall에서 chromium 자동 설치
```

`npm install` 1~3분 걸림 (Playwright Chromium 다운로드).

---

## STEP 3 — `.env` 파일 (10분)

루트에 `.env` 파일 생성 (`.gitignore`에 이미 있어서 git에 안 올라감):

```bash
# 식스샵 (브랜드별로 _SUFFIX 다르게)
SIXSHOP_EMAIL=본인_식스샵_이메일
SIXSHOP_PASSWORD=본인_식스샵_비밀번호

# (브랜드 여러 개일 때 추가, brands.ts의 credEnvSuffix와 일치)
# SIXSHOP_EMAIL_BRAND2=두번째_브랜드_이메일
# SIXSHOP_PASSWORD_BRAND2=두번째_브랜드_비밀번호

# 구글 시트
SHEET_ID=STEP_1_4에서_복사한_SHEET_ID
GOOGLE_SERVICE_ACCOUNT_PATH=~/Downloads/sixshop-key.json   # JSON 파일 경로

# 옵션: 스마트스토어 운영 시
# NAVER_CLIENT_ID_PP=네이버_API_클라이언트_ID
# NAVER_CLIENT_SECRET_PP=네이버_API_클라이언트_시크릿
```

---

## STEP 4 — `brands.ts` 본인 브랜드로 변경 (10분)

`src/brands.ts` 파일 열기. 기본 예시는 6thanother / Clear.type / Produktepr (3개 브랜드). **본인 브랜드만 남기고 나머지 지움**.

단일 브랜드, 식스샵만 운영 시 예시:

```ts
export const BRANDS: Brand[] = [
  {
    siteLink: "본인-식스샵-사이트-식별자",       // 식스샵 admin URL의 경로 부분 (예: sixshop.com/dashboard/<여기>)
    displayName: "본인 브랜드명",                  // 로그용 표시
    memberNo: 0,                                  // 식스샵 mall API의 memberNo (모르면 일단 0, 첫 실행 후 mall API 응답에서 확인)
    ordersSheetName: "주문로그",                   // 시트 탭 이름 (자동 생성됨)
    stockSheetName: "재고마스터",                  // 시트 탭 이름 (자동 생성됨)
    stateSheetName: "_state",                     // 시트 탭 이름 (자동 생성됨)
    includeStatuses: ["판매 중"],                  // 또는 ["판매 중", "품절"]
    credEnvSuffix: "",                            // .env의 SIXSHOP_EMAIL/PASSWORD 그대로 사용
    inventoryEnabled: true,                       // 재고마스터 자동 갱신
    // smartStore 필드는 단일 채널이면 빼두기
  },
];
```

**brands.ts에서 안 쓰는 다른 브랜드 다 지우기.** 필요 없는 import 도 정리.

---

## STEP 5 — 첫 실행으로 동작 검증 (5분)

```bash
HEADLESS=false npm run dev
```

- 브라우저 창이 뜸 (식스샵 admin에 자동 로그인 시도)
- 로그인 성공 → 주문 데이터 수집 → 시트에 적재
- 끝나면 시트 열어서 데이터 들어왔는지 확인

성공하면 다음 단계. 에러 나면 Claude Code에 에러 메시지 보여주고 진단 받기.

---

## STEP 6 — GitHub Actions Secrets 등록 (5분)

본인 GitHub repo 페이지에서:
- **Settings → Secrets and variables → Actions → New repository secret**

다음 5개 등록:

| Name | Value |
|---|---|
| `SIXSHOP_EMAIL` | 식스샵 이메일 |
| `SIXSHOP_PASSWORD` | 식스샵 비밀번호 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | STEP 1-3 JSON 파일 내용 **전체 (한 줄로)** — 또는 그대로 복붙해도 GHA에서 정상 처리 |
| `SHEET_ID` | 시트 ID |
| `SIXSHOP_STORE_ID` | (선택) 멀티스토어면 |

브랜드 여러 개면 `_BRAND2` 같은 suffix로 추가.

---

## STEP 7 — GitHub Actions 자동 실행 확인 (3분)

`.github/workflows/collect.yml` 의 cron이 매일 KST 08:00 자동 실행됨.

수동 트리거로 첫 동작 검증:
```bash
gh workflow run collect.yml
```

또는 GitHub 웹: **Actions 탭 → collect-sixshop-orders → Run workflow**

성공하면 셋업 끝 ✅

---

## STEP 8 (선택) — KST 08:00 정확 갱신 보장 (10분)

GitHub Actions schedule cron은 **9시간씩 지연**되는 패턴 있음 (KST 17시쯤 도는 경우 흔함). KST 08:00 정확히 받고 싶으면 외부 cron 서비스로 트리거.

자세한 가이드: [`docs/EXTERNAL-CRON.md`](EXTERNAL-CRON.md)

---

## 셋업 후 운영

[`docs/OPERATION.md`](OPERATION.md) 참고.
