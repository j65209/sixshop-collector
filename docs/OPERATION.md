# 매일 운영 가이드

셋업 끝난 후 일상 운영 매뉴얼.

## 매일 자동으로 일어나는 일

```
KST 08:00  →  외부 cron(또는 GHA schedule) 트리거
          →  GitHub Actions 실행 (약 5~10분)
                ├─ 식스샵 admin 로그인 (Playwright)
                ├─ 어제~오늘 신규 주문 수집 → 주문로그 시트에 append
                └─ 옵션별 재고 fetch → 재고마스터 시트 갱신
KST 08:10  →  사장님이 시트 열어서 확인
```

## 시트 보는 법

### 재고마스터 시트
| 컬럼 | 의미 |
|---|---|
| **카테고리** | 식스샵에 등록한 카테고리 |
| **상품명** | 식스샵 상품명 |
| **옵션** | 옵션 조합 (예: "컬러: 블루 / 사이즈: M") |
| **SKU** | 상품 코드 (식스샵에 입력한 거) |
| **현재재고** | 식스샵 mall API 실시간 재고 |
| **어제 판매** | 직전 cron 이후 결제완료 주문 합계 |
| **남은재고** | 현재재고 - 어제판매 |
| **리오더 알림** | 5개 이하 ⚠ 리오더 / 10개 이하 ⚡ 임박 |

### 주문로그 시트
| 컬럼 | 의미 |
|---|---|
| 주문번호 / 주문일시 / 상태 / 상품명 / 옵션 / SKU / 수량 / 단가 / 합계 / 결제방법 / 주문자 / 수집일시 | (기본) |

신규 주문만 append되며 중복은 자동 차단.

### _state 시트
| key | value |
|---|---|
| `last_run_at` | 마지막 cron 실행 시각 (KST) |
| `last_run_status` | `ok:N` (N개 신규) 또는 `error:...` |

문제 시 여기 먼저 확인.

---

## 자주 쓰는 명령

본인 PC 터미널 (코드 폴더에서):

### 즉시 갱신 (수동 트리거)
```bash
gh workflow run collect.yml
```
GitHub Actions 페이지에서 진행 확인. 5~10분 후 시트에 반영.

### 로컬에서 직접 실행 (디버그용)
```bash
HEADLESS=false npm run dev   # 브라우저 보면서
HEADLESS=true npm run dev    # 백그라운드
```

### 빌드 (TypeScript 변경 시)
```bash
npm run build
```

---

## 문제 대응

### "시트가 갱신 안 됐어요"
1. **GHA 실행됐는지**: https://github.com/<본인-username>/sixshop-collector/actions 에서 가장 최근 실행 status 확인
2. **success인데 시트 비어있음**: 시트 ID 잘못, 서비스 계정 권한 미공유, 시트 탭 이름 안 맞음
3. **failure**: 실행 로그 클릭 → 어디서 실패했는지 확인. 보통:
   - 식스샵 사이트 일시적 느림 (timeout) — 자동 재시도되어 다음 cron에 잡힘. 한두 번 실패는 정상
   - 식스샵 비밀번호 변경됨 — Secrets 업데이트
   - 식스샵 사이트 구조 변경 — 코드 fix 필요

### "주문이 두 번 들어갔어요"
- dedup 키 = `(주문번호, 상품명, 옵션, 수량, 합계)` join
- 식스샵 admin에서 부분환불·할인 후처리하면 quantity/lineTotal 변경 → 같은 주문이 두 줄로 들어갈 수 있음
- 시트에서 수동 삭제 또는 코드 수정 (Claude Code에 "주문 dedup 키에서 quantity 빼줘"라고 부탁)

### "이전 주문이 안 들어와요"
- 코드 기본 윈도우 = 7일치
- 더 길게 받으려면: GitHub Actions Variables에 `COLLECT_DAYS=14` 같이 추가
- 또는 단발성: `COLLECT_DAYS=30 npm run dev` 로컬 실행

### "PAT 만료 알림이 와요" (외부 cron 사용 시)
- cron-job.org → 해당 cron → Edit → Headers → Authorization 값 갱신
- 새 PAT은 https://github.com/settings/personal-access-tokens/new 에서 발급
- 자세한 절차는 [`EXTERNAL-CRON.md`](EXTERNAL-CRON.md)

---

## 상품 추가/삭제할 때

식스샵 admin에서 새 상품 등록하거나 기존 상품 삭제하면:
- **자동 반영**: 재고마스터는 매 cron마다 식스샵 데이터 기반으로 새로 박힘. 수동 작업 X
- **단, 상품명 바뀌면**: 주문로그 dedup이 상품명 기준이라 동일 주문이 새 행으로 들어올 수 있음 — 가능하면 상품명 변경은 신중

## 옵션 추가할 때

식스샵 admin에서 옵션 추가:
- **자동 반영**: 재고마스터에 새 옵션 row 자동 추가 (다음 cron부터)
- 옵션별 재고는 mall API에서 가져옴

---

## 리오더 알림

재고마스터의 "리오더 알림" 컬럼:
- ⚠ **리오더** = 남은재고 5개 이하
- ⚡ **임박** = 남은재고 10개 이하

임계치 변경하려면 `src/seed-inventory.ts` 의 IF 조건 숫자 수정 + commit/push.

---

## Claude Code로 운영하는 법

본인 PC에 Claude Code 설치되어 있으면, 코드 폴더에서 Claude Code 열고:

- "오늘 cron 결과 확인해줘" → GHA 로그 확인 + 결과 요약
- "이 시트의 PP 재고마스터에 [상품명] 보여줘" → Sheets API로 시트 읽고 보고
- "리오더 임계치를 10/20으로 바꿔줘" → 코드 수정 + commit + push
- "[브랜드명] 추가해줘" → brands.ts 수정 + Secrets 안내
- "[에러 메시지] 봐봐" → 진단 + fix 제안

코드 베이스 구조는 [`ARCHITECTURE.md`](ARCHITECTURE.md) 참고하면 더 정확한 답 받음.
