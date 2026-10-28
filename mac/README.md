# 맥미니 자동 설치 관리자

GitHub(main)에 올린 수집기를 맥미니(서버)가 **알아서 설치·실행**하게 하는 장치. 맥에서는 **처음 한 번만** 설치하면 된다.

## 처음 한 번 — 맥 터미널에 붙여 넣기

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/j65209/sixshop-collector/main/mac/install.sh)
```

1. `~/brightbeed-auto/sixshop-collector` 에 전용 사본을 받는다 (사람이 손대지 않는 폴더 — 매번 GitHub main 과 똑같이 맞춤)
2. 이 맥에 있던 `sixshop-collector/.env` 를 찾아 복사한다 (없으면 `.env.example` 로 새로 만들고 채울 값을 알려 줌)
3. 의존성 설치(`npm ci`) + `mac/jobs/` 의 작업을 launchd 에 등록
4. `com.brightbeed.autoupdate` 등록 — 15분마다(+ 맥을 켤 때) GitHub 확인

다시 실행해도 안전하다 (점검·갱신만). node 20 이상 필요 (`brew install node`).

## 그 다음부터 — 자동

| GitHub 에 올린 것 | 맥미니가 하는 일 (15분 안에) |
|---|---|
| 코드 수정 | 새 코드로 맞춤 → 다음 실행부터 반영 |
| `mac/jobs/<작업id>.job` 추가 | launchd 작업 설치 (`com.brightbeed.<작업id>`) |
| `.job` 의 시각 변경 | 다시 등록 |
| `.job` 삭제 또는 `ENABLED=0` | 작업 내림 |
| `package-lock.json` 변경 | `npm ci` |
| `mac/*.sh` 변경 | 관리자 자신도 새 버전으로 바뀜 |

맥에서 직접 할 일은 **새 비밀번호·토큰을 `.env` 에 넣을 때뿐** — 레포가 공개라 GitHub 에는 못 올린다:
`open -e ~/brightbeed-auto/sixshop-collector/.env`

## 작업 추가하기 — `mac/jobs/<작업id>.job`

작업 id = 파일 이름 (영문 소문자·숫자·`-`). 한 줄에 `키=값` (셸로 실행하지 않고 글자로만 읽음):

```
DESC=에이블리 일일 보고서 (코페리)
RUN=npm run ably-daily
AT=07:10
REQUIRES=ABLY_EMAIL ABLY_PASSWORD ABLY_AD_MARKET_SNO REPORTS_GITHUB_TOKEN
TIMEOUT_MIN=20
```

| 키 | 뜻 |
|---|---|
| `RUN` | 레포 폴더에서 실행할 명령 (필수) |
| `AT` | 실행 시각 `HH:MM` — 여러 개는 공백으로 (`09:00 18:30`) |
| `WEEKDAYS` | 특정 요일만: `1`=월 … `7`=일, 예 `1 2 3 4 5` (없으면 매일) |
| `EVERY_MIN` | `AT` 대신 N분마다 |
| `REQUIRES` | `.env` 에 꼭 있어야 하는 키. `A\|B` = 둘 중 하나. 비었거나 `.env.example` 의 예시값이면 실행하지 않고 상태에 표시 |
| `TIMEOUT_MIN` | 최대 실행 시간 (기본 60분, 넘으면 강제 종료) |
| `ENABLED` | `0` 이면 꺼 둠 |
| `DESC` | 설명 (상태 화면에 표시) |

로그는 `~/Library/Logs/brightbeed-<작업id>.log` — 오피스 레포 `scripts/mac/install-fx-usd.sh` 와 같은 이름 규칙.

## 확인 · 문제 해결 (맥 터미널)

```bash
bash ~/brightbeed-auto/sixshop-collector/mac/autoupdate.sh status          # 상태 (작업별 마지막 실행 · 빠진 설정값)
bash ~/brightbeed-auto/sixshop-collector/mac/autoupdate.sh run ably-daily  # 지금 한 번 실행
bash ~/brightbeed-auto/sixshop-collector/mac/autoupdate.sh sync            # 15분 기다리지 않고 바로 반영
tail -f ~/Library/Logs/brightbeed-ably-daily.log                           # 작업 로그
tail -f ~/Library/Logs/brightbeed-autoupdate.log                           # 자동 설치 기록
```

- 작업별 결과: `~/brightbeed-auto/state/status-<작업id>.txt`
- 손으로 깐 다른 작업(예: 오피스 레포의 `com.brightbeed.fx-usd`)은 건드리지 않는다. 같은 이름의 `.job` 을 만들면 원래 설정을 `state/` 에 백업하고 넘겨받는다.
- 작업이 실행 중이면 그 확인 차례는 건너뛰고 다음에 반영한다 (실행 중인 작업을 끊지 않음).
- 끄기: `bash ~/brightbeed-auto/sixshop-collector/mac/autoupdate.sh uninstall` (코드·`.env` 는 남음)

## 주의

- `main` 에 올라간 코드는 맥미니에서 그대로 실행된다 — push 권한은 지금처럼 본인 계정만.
- LaunchAgent 라 맥에 로그인돼 있어야 돈다. 잠자던 시각의 작업은 깨어날 때 실행된다.
- 스크립트는 macOS 기본 bash 3.2 로 돈다 — 고칠 때 `lib.sh` 머리말의 금지 문법 참고.
- 맥 없이 시험: `bash mac/tests/fake-mac.sh` — 가짜 launchctl·npm 으로 설치부터 내리기까지 전체 흐름 확인.
