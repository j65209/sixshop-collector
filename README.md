# sixshop-collector

식스샵(공홈) 주문/재고를 자동 수집해 **구글 스프레드시트**에 적재하는 ERP.
스마트스토어와도 합산 가능 (옵션).

- 식스샵 공식 API 없어 **Playwright로 admin 자동화**
- 스마트스토어는 네이버 Commerce 공식 API 사용
- GHA cron + (옵션) cron-job.org로 매일 KST 08:00 자동 실행

## 📚 문서

| 문서 | 언제 |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | **처음 셋업** — 0부터 1시간 가이드 |
| [`docs/OPERATION.md`](docs/OPERATION.md) | **매일 운영** — 시트 보는 법, 명령, 문제 대응 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | **코드 구조** — Claude Code가 작업할 때 읽는 컨텍스트 |
| [`docs/EXTERNAL-CRON.md`](docs/EXTERNAL-CRON.md) | **cron-job.org 셋업** — KST 08:00 정확 갱신 보장 |

## 🚀 빠른 시작

처음이면:
> Claude Code 열고 "docs/SETUP.md 따라 처음 셋업 진행해줘"

이미 운영 중이면:
> "오늘 cron 결과 확인해줘" / "수동 트리거해줘" 등

## 🏗 데이터 흐름 요약

### 단일 채널 (식스샵만)
```
GHA cron (KST 08:00) → Playwright 식스샵 admin
   → 주문 fetch → 주문로그 시트
   → 옵션재고 fetch → 재고마스터 시트 (현재재고/어제판매/남은재고/리오더)
```

### 다채널 (식스샵 + 스마트스토어, PP 패턴)
```
GHA cron → 식스샵 raw 시트 (hidden)
사용자 PC vm-pp-cycle:
   sync-smartstore.ts → SS 주문로그 시트
   refresh-pp-master.ts → 합산 dashboard (식스샵+SS 토큰 매칭)
```

이유: 네이버 Commerce API는 IP 화이트리스트라 GHA에서 못 부름. 다채널은 24/7 PC 또는 사용자 PC 의존.

## 🔑 자격증명 요약

`.env` (로컬) + GitHub Secrets (GHA):
- `SIXSHOP_EMAIL` / `SIXSHOP_PASSWORD` (브랜드별 suffix)
- `GOOGLE_SERVICE_ACCOUNT_JSON` + `SHEET_ID`
- (다채널) `NAVER_CLIENT_ID_PP` / `NAVER_CLIENT_SECRET_PP`

자세한 발급 절차는 [`docs/SETUP.md`](docs/SETUP.md).

## 📦 npm scripts

| 명령 | 용도 |
|---|---|
| `npm run dev` | GHA가 도는 메인 실행 (로컬에서 동일 동작) |
| `npm run seed-inventory` | 재고마스터만 즉시 갱신 |
| `npm run sync-ss` | (PP 전용) SS 주문 sync |
| `npm run vm-pp-cycle` | (PP 전용) sync-ss + refresh-pp-master |
| `npm run setup-pp-mapping` | (PP 전용) 매핑 시트 셋업 |
| `npm run build` | TypeScript 컴파일 |

## 🤖 Claude Code 활용

이 repo는 Claude Code로 운영하기 좋게 docs 정리되어 있음. Claude한테 다음 식으로 부탁:
- "오늘 cron 결과 확인해줘"
- "[브랜드] 추가해줘"
- "리오더 임계치를 X로 바꿔줘"
- "[에러 메시지] 진단해줘"
- "docs/SETUP.md 따라 처음 셋업 진행해줘"

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)가 컨텍스트 제공.
