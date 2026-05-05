# 다른 브랜드 추가하기

이 시스템은 **브랜드 1개 = repo 1개 + 시트 1개 + cron 1개** 구조입니다.
새 브랜드 추가 시 아래 순서대로 진행하면 30분 안에 동일한 ERP가 새로 셋업됩니다.

> 호칭 규칙: 이 자동화 시스템을 사용자는 **"재고"** 또는 **"ERP"**라고 부릅니다.

## 1. 새 GitHub repo 만들기 (template 활용)

이 repo를 GitHub UI에서 **template repo**로 마킹해두면(`Settings → Template repository`) 새 브랜드용 repo를 한 번에 생성할 수 있습니다.

```bash
# template으로 마킹된 상태에서:
gh repo create sixshop-collector-{브랜드명} \
  --private \
  --template j65209/sixshop-collector \
  --clone

cd sixshop-collector-{브랜드명}
```

template이 아직 아니면 그냥 fork 또는 새 repo로 클론해서 origin 변경.

## 2. 새 구글 시트 만들기

- https://sheets.google.com → 새 빈 시트
- 이름: 예) "{브랜드명} 재고 ERP"
- URL의 `/d/` 다음 ID 복사 → 시크릿용

## 3. 서비스 계정 발급 (브랜드별로 새로 발급 권장)

기존 6thanother용 서비스 계정을 재사용해도 동작은 하지만 권한 분리를 위해 **브랜드별 새 서비스 계정** 권장.

1. https://console.cloud.google.com → 새 프로젝트 (예: `sixshop-{브랜드명}`)
2. **API 라이브러리 → Google Sheets API → 사용 설정**
3. **서비스 계정 만들기** → JSON 키 다운로드
4. JSON의 `client_email`을 새 시트에 **편집자**로 공유
5. JSON 한 줄로 변환 (Actions secret용):
   ```bash
   node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('~/Downloads/sixshop-{브랜드명}-xxxxx.json'))))"
   ```

## 4. Actions secrets 등록

```bash
cd sixshop-collector-{브랜드명}

# 식스샵 계정
echo -n "{브랜드}@example.com" | gh secret set SIXSHOP_EMAIL
echo -n "비밀번호" | gh secret set SIXSHOP_PASSWORD
echo -n "" | gh secret set SIXSHOP_STORE_ID

# 구글 시트
echo -n "{시트ID}" | gh secret set SHEET_ID
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('/path/to/key.json'))))" \
  | gh secret set GOOGLE_SERVICE_ACCOUNT_JSON

# 확인
gh secret list
```

## 5. 첫 실행

```bash
# 로컬에서 .env 채우고 (템플릿: .env.example)
cp .env.example .env
# 값 채운 뒤
HEADLESS=true npm run dev          # 주문 + 재고 한 번 동기화
```

또는 GitHub Actions 페이지에서 **Run workflow** 수동 실행.

## 6. cron 시간 결정

기본은 매일 KST 08:00 (`0 23 * * *` UTC). 브랜드별로 다른 시간을 원하면 `.github/workflows/collect.yml`의 cron 표현식 수정.

## 7. 시트 구조 확인

첫 실행 후 자동 생성됨:
- `주문로그` 탭: 매일 새 주문 라인 누적
- `재고마스터` 탭: 8개 컬럼 (카테고리 / 상품명 / 옵션 / SKU / 현재재고 / 판매수량 / 남은재고 / 리오더 알림)
- `_state` 탭: 마지막 실행 시각/상태

옵션 있는 상품(현재재고 0으로 표시되는 것)은 사장님이 시트에서 직접 입력. 다음 cron부터 그 값이 보존됩니다.

## 자주 묻는 질문

**Q. 한 brand에서 식스샵 비번 바뀌면?**
→ `gh secret set SIXSHOP_PASSWORD` 한 번 다시 실행

**Q. 새 상품 등록했는데 재고마스터에 없음**
→ 다음 cron(다음날 8시)에 자동 추가. 즉시 반영 원하면 로컬에서 `npm run seed-inventory`

**Q. 여러 브랜드를 한 시트에서 관리?**
→ 비추천. SUMIF 매칭 충돌 + 권한 관리 복잡. 브랜드당 시트 1개 원칙 유지.
