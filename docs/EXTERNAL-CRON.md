# 외부 cron 셋업 (cron-job.org)

GitHub Actions schedule cron은 트래픽 따라 **수 시간 지연**되는 패턴 있음.
KST 08:00 정확히 받고 싶으면 외부 cron 서비스로 GHA workflow_dispatch 트리거.

총 5분, cron-job.org 무료 플랜으로 충분.

## STEP 1 — GitHub PAT 발급

1. https://github.com/settings/personal-access-tokens/new

| 항목 | 입력 |
|---|---|
| **Token name** | `sixshop-collector-cron` |
| **Expiration** | `Custom...` → 1년 후 |
| **Repository access** | `Only select repositories` → 본인 `sixshop-collector` 선택 |
| **Repository permissions** ▶ | `Actions` = `Read and write` (나머지는 No access) |

→ **Generate token** → `github_pat_xxxxxxx...` **즉시 복사 저장** (다시 못 봄)

## STEP 2 — cron-job.org 가입

https://cron-job.org/en/signup/ 가입 + 이메일 인증.

## STEP 3 — cron 등록

좌측 **CRONJOBS** → 우상단 **CREATE CRONJOB**

### Common 탭
| 항목 | 입력 |
|---|---|
| **Title** | `sixshop daily collect` |
| **URL** | `https://api.github.com/repos/<본인-username>/sixshop-collector/actions/workflows/collect.yml/dispatches` |
| **Save responses** | ✅ |

### Schedule 섹션
- **Every day at...** 라디오
- **Hours**: `8`, **Minutes**: `00`
- **Timezone**: `Asia/Seoul` (가입 시 자동 잡힘)

### Advanced 탭

**Request method**: `POST`

**Request body**:
```
{"ref":"main"}
```

**Headers** (3개):

| Key | Value |
|---|---|
| `Authorization` | `Bearer ` + STEP 1 PAT (Bearer 다음 공백 1칸) |
| `Accept` | `application/vnd.github+json` |
| `Content-Type` | `application/json` |

→ **CREATE**

## STEP 4 — 테스트

1. 만든 cron 클릭 → 우상단 **TEST RUN**
2. **History** 탭에서 Status code 확인 — `204` 또는 `200` = 성공
3. https://github.com/<본인-username>/sixshop-collector/actions 에서 새 실행 시작됐는지 확인

성공이면 끝. 매일 KST 08:00 자동 트리거됨.

## 트러블슈팅

| Status | 원인 | 해결 |
|---|---|---|
| 401 | PAT 잘못/만료 | STEP 1 재발급, Authorization 갱신 |
| 404 | URL 오타 또는 PAT의 repo 권한 X | URL 정확히 / STEP 1-3 repo 선택 확인 |
| 422 | body 형식 오류 | `{"ref":"main"}` 정확히 (큰따옴표) |

## PAT 갱신 (1년 후)

1. STEP 1 다시 (새 PAT 발급, 기존 PAT 삭제는 안 해도 됨, 만료되면 자동 비활성)
2. cron-job.org → 해당 cron → Edit → Headers → Authorization 값 갱신 → Save
