#!/bin/bash
# 가짜 맥 환경에서 자동 설치 관리자 전체 흐름 시험 — 맥이 없어도(Windows Git Bash 등) 돌릴 수 있다.
#   bash mac/tests/fake-mac.sh
# launchctl · node · npm · uname · pkill 을 가짜 명령으로 바꾸고, 지금 폴더의 mac/ 를 담은 가짜 GitHub 저장소를 만들어
# 설치 → 확인(변경 없음 · 일정 변경 · 작업 추가/삭제/끄기 · 스크립트 변경) → 작업 실행 → 상태 → 내리기 를 확인한다.
# 주의: 진짜 macOS bash 3.2 문법 문제는 여기서 못 잡는다 — lib.sh 머리말의 금지 문법을 지킬 것.

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T=$(mktemp -d "${TMPDIR:-/tmp}/bbauto-test.XXXXXX")
export HOME="$T/home" BB_ALLOW_NON_MAC=1 FAKE_LAUNCHD="$T/launchd" BB_REPO_URL="$T/origin.git"
unset BB_AUTO_HOME BB_INSTALL_STAGE BB_REEXEC BB_HANDOFF BB_LOG_DIR BB_AGENTS_DIR
mkdir -p "$HOME/.local/node/bin" "$FAKE_LAUNCHD/loaded"
AH="$HOME/brightbeed-auto"; C="$AH/sixshop-collector"; AG="$HOME/Library/LaunchAgents"; LG="$HOME/Library/Logs"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS + 1)); echo "  ok   $1"; else FAIL=$((FAIL + 1)); echo "  FAIL $1"; fi; }
edit(){ sed "$1" "$2" >"$2.tmp" && mv "$2.tmp" "$2"; }   # sed -i 는 맥/리눅스 문법이 달라서
G="git -c core.autocrlf=false -c user.name=t -c user.email=t@t"   # Windows 줄바꿈 경고 없이
push(){ (cd "$T/src" && $G add -A && $G commit -qm "$1" && $G push -q "$T/origin.git" main); }
sync(){ bash "$C/mac/autoupdate.sh" sync >"$T/sync.log" 2>&1; }

# ---------- 가짜 명령 ($HOME/.local/node/bin 은 lib.sh 가 PATH 맨 앞에 붙임) ----------
fake(){ cat >"$HOME/.local/node/bin/$1"; chmod +x "$HOME/.local/node/bin/$1"; }
fake uname <<'EOF'
#!/bin/bash
echo Darwin
EOF
fake node <<'EOF'
#!/bin/bash
case "$1" in -v) echo v22.11.0 ;; -p) echo 22 ;; esac
EOF
fake npm <<'EOF'
#!/bin/bash
echo "npm $*" >>"$FAKE_LAUNCHD/calls.log"
case "$1" in
  ci) mkdir -p node_modules; echo "fake npm ci" ;;
  run) echo "fake run $2"; [ -n "${FAKE_JOB_MSG:-}" ] && echo "$FAKE_JOB_MSG"; sleep "${FAKE_JOB_SLEEP:-0}"; exit "${FAKE_JOB_RC:-0}" ;;
esac
EOF
fake launchctl <<'EOF'
#!/bin/bash
echo "launchctl $*" >>"$FAKE_LAUNCHD/calls.log"
L="$FAKE_LAUNCHD/loaded"
case "$1" in
  bootstrap) label=$(sed -n 's:.*<key>Label</key><string>\(.*\)</string>.*:\1:p' "$3" | head -n 1)
             [ -e "$L/$label" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
             cp "$3" "$L/$label" ;;
  bootout)   label=${2##*/}; [ -e "$L/$label" ] || exit 3; rm -f "$L/$label" ;;
  print)     label=${2##*/}; [ -e "$L/$label" ] || exit 113; echo "state = waiting" ;;
  kickstart) echo "kickstart ${2##*/}" >>"$FAKE_LAUNCHD/kicks.log" ;;
esac
EOF
fake pkill <<'EOF'
#!/bin/bash
# -P <부모pid> 만 흉내 (Git Bash 엔 pkill 이 없다)
sig=-TERM; pp=
while [ $# -gt 0 ]; do case "$1" in -P) pp=$2; shift 2 ;; -*) sig=$1; shift ;; *) shift ;; esac; done
[ -n "$pp" ] || exit 1
for p in $(ps | awk -v pp="$pp" 'NR > 1 && $2 == pp {print $1}'); do kill "$sig" "$p" 2>/dev/null; done
exit 0
EOF
fake curl <<'EOF'
#!/bin/bash
# GitHub contents API 흉내 — PUT 은 본문을 저장하고, GET 은 저장된 게 있으면 sha 를 돌려줌
echo "curl $*" >>"$FAKE_LAUNCHD/curl.log"
method=GET; data=""; url=""
while [ $# -gt 0 ]; do case "$1" in -X) method=$2; shift 2 ;; -d) data=$2; shift 2 ;; -H|-m) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
store="$FAKE_LAUNCHD/gh-$(printf '%s' "$url" | sed 's#.*/contents/##; s#/#_#g')"
if [ "$method" = PUT ]; then printf '%s' "$data" >"$store"; echo "PUT $url" >>"$FAKE_LAUNCHD/puts.log"; echo '{}'; exit 0; fi
[ -f "$store" ] || exit 22
echo '{"name": "status.json", "sha": "abc123"}'
EOF
# 가짜 GitHub 에 올라간 상태 파일 내용 (base64 풀어서)
gh_status(){ sed 's/.*"content":"\([^"]*\)".*/\1/' "$FAKE_LAUNCHD/gh-mac_status.json" 2>/dev/null | base64 -d 2>/dev/null; }
puts(){ grep -c "mac/status.json" "$FAKE_LAUNCHD/puts.log" 2>/dev/null || echo 0; }

# ---------- 가짜 GitHub 저장소 = 지금 작업 폴더의 mac/ + package 파일 ----------
mkdir -p "$T/src"
cp -R "$REPO/mac" "$T/src/mac"
cp "$REPO/package.json" "$REPO/package-lock.json" "$REPO/.env.example" "$REPO/.gitignore" "$REPO/.gitattributes" "$T/src/"
(cd "$T/src" && $G init -q -b main && $G add -A && $G commit -qm init && $G clone -q --bare . "$T/origin.git")

# 이 맥에 원래 있던 사본의 .env (설치가 찾아서 복사해야 함) + 상대경로 키 파일
mkdir -p "$HOME/projects/sixshop-collector/keys"
cat >"$HOME/projects/sixshop-collector/.env" <<'EOF'
ABLY_EMAIL=me@example.co.kr
ABLY_PASSWORD=pw
ABLY_AD_MARKET_SNO=46903   # 코페리
REPORTS_GITHUB_TOKEN=ghp_test
SIXSHOP_PRO_EMAIL=pro@example.co.kr
SIXSHOP_PRO_PASSWORD=pw
GOOGLE_SERVICE_ACCOUNT_PATH=./keys/sa.json
EOF
echo '{}' >"$HOME/projects/sixshop-collector/keys/sa.json"

echo "1) 처음 설치"
out=$(bash "$REPO/mac/install.sh" 2>&1); printf '%s\n' "$out" | sed 's/^/     | /'
check "전용 사본 생성" '[ -d "$C/.git" ]'
check ".env 를 찾아 복사" 'grep -q "^ABLY_EMAIL=me@example.co.kr" "$C/.env"'
check "상대경로 키 파일도 복사" '[ -f "$C/keys/sa.json" ]'
check "의존성 설치(npm ci)" 'grep -q "npm ci" "$FAKE_LAUNCHD/calls.log" && [ -d "$C/node_modules" ]'
check "ably-daily 매일 07:10" 'grep -q "<dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>10</integer></dict>" "$AG/com.brightbeed.ably-daily.plist"'
check "ably-daily 실행 경로" 'grep -q "<string>$C/mac/run-job.sh</string><string>ably-daily</string>" "$AG/com.brightbeed.ably-daily.plist"'
check "ably-daily launchd 등록" '[ -e "$FAKE_LAUNCHD/loaded/com.brightbeed.ably-daily" ]'
check "관리자 15분마다 + 켤 때" 'grep -q "<integer>900</integer>" "$AG/com.brightbeed.autoupdate.plist" && grep -q "RunAtLoad" "$AG/com.brightbeed.autoupdate.plist" && [ -e "$FAKE_LAUNCHD/loaded/com.brightbeed.autoupdate" ]'
check "자동 관리 목록" 'grep -qx ably-daily "$AH/state/managed.txt"'
check "공홈 실시간 작업 30분마다" '[ -e "$FAKE_LAUNCHD/loaded/com.brightbeed.home-live" ] && grep -q "<key>StartInterval</key><integer>1800</integer>" "$AG/com.brightbeed.home-live.plist"'
check "설치 끝 안내" 'printf "%s" "$out" | grep -q "끝. 이제 GitHub"'
check "다 채워져 있으면 남은 일 없음" '! printf "%s" "$out" | grep -q "남은 일"'

echo "2) 바뀐 게 없을 때"
: >"$FAKE_LAUNCHD/calls.log"; sync
check "다시 깔지 않음" '! grep -q -E "bootstrap|npm ci" "$FAKE_LAUNCHD/calls.log"'
check "조용함 (로그 없음)" '[ ! -s "$T/sync.log" ]'

echo "2-1) 서버 상태 보고 (비공개 보고서 레포 mac/status.json)"
check "상태 파일 올림" 'gh_status | grep -q "\"id\": \"ably-daily\"" && gh_status | grep -q "\"manager\": \"on\"" && gh_status | grep -q "\"deps\": \"ok\""'
n=$(puts); sync
check "바뀐 게 없으면 다시 안 올림" '[ "$(puts)" = "$n" ]'
if [ -n "${BB_TEST_NODE:-}" ]; then
  check "올린 상태 파일은 올바른 JSON" 'gh_status | "$BB_TEST_NODE" -e "JSON.parse(require(\"fs\").readFileSync(0, \"utf8\"))"'
fi

echo "3) GitHub 에서 시각 변경"
edit 's/^AT=07:10$/AT=07:20/' "$T/src/mac/jobs/ably-daily.job"; push "시각 변경"; sync
check "새 코드 받음" 'grep -q "코드 갱신" "$T/sync.log"'
check "07:20 으로 다시 등록" 'grep -q "<integer>7</integer><key>Minute</key><integer>20</integer>" "$AG/com.brightbeed.ably-daily.plist" && [ -e "$FAKE_LAUNCHD/loaded/com.brightbeed.ably-daily" ]'

echo "4) 새 작업 추가 → 삭제"
printf 'DESC=시험 작업\nRUN=npm run test-job\nAT=09:00 18:30\nWEEKDAYS=1 2 3 4 5\n' >"$T/src/mac/jobs/test-job.job"; push "작업 추가"; sync
check "새 작업 자동 설치" '[ -e "$FAKE_LAUNCHD/loaded/com.brightbeed.test-job" ]'
check "평일 5일 × 2개 시각 = 10칸" '[ "$(grep -c "<key>Weekday</key>" "$AG/com.brightbeed.test-job.plist")" = 10 ]'
rm "$T/src/mac/jobs/test-job.job"; push "작업 삭제"; sync
check "지운 작업은 내림" '[ ! -e "$FAKE_LAUNCHD/loaded/com.brightbeed.test-job" ] && [ ! -f "$AG/com.brightbeed.test-job.plist" ] && ! grep -qx test-job "$AH/state/managed.txt"'

echo "5) 잘못된 일정은 건너뜀"
printf 'DESC=틀린 작업\nRUN=true\nAT=25:00\n' >"$T/src/mac/jobs/bad-time.job"; push "틀린 일정"; sync
check "등록 안 하고 경고" '[ ! -e "$FAKE_LAUNCHD/loaded/com.brightbeed.bad-time" ] && grep -q "형식이 잘못됐어요" "$T/sync.log"'
sync
check "같은 경고는 반복 안 함" '[ ! -s "$T/sync.log" ]'
rm "$T/src/mac/jobs/bad-time.job"; push "틀린 일정 삭제"; sync

echo "6) ENABLED=0 으로 끄기 → 다시 켜기"
echo "ENABLED=0" >>"$T/src/mac/jobs/ably-daily.job"; push "끄기"; sync
check "꺼진 작업 내림" '[ ! -e "$FAKE_LAUNCHD/loaded/com.brightbeed.ably-daily" ]'
edit '/^ENABLED=0$/d' "$T/src/mac/jobs/ably-daily.job"; push "켜기"; sync
check "다시 켜면 설치" '[ -e "$FAKE_LAUNCHD/loaded/com.brightbeed.ably-daily" ]'

echo "6-1) RUN_NOW 로 원격 시험 실행"
echo "RUN_NOW=t1" >>"$T/src/mac/jobs/ably-daily.job"; push "지금 실행 t1"; : >"$FAKE_LAUNCHD/kicks.log"; sync
check "값이 생기면 한 번 실행" 'grep -q "kickstart com.brightbeed.ably-daily" "$FAKE_LAUNCHD/kicks.log" && grep -q "RUN_NOW=t1" "$T/sync.log"'
: >"$FAKE_LAUNCHD/kicks.log"; sync
check "같은 값이면 다시 안 함" '[ ! -s "$FAKE_LAUNCHD/kicks.log" ]'
edit 's/^RUN_NOW=t1$/RUN_NOW=t2/' "$T/src/mac/jobs/ably-daily.job"; push "지금 실행 t2"; sync
check "값을 바꾸면 또 한 번" 'grep -q "kickstart com.brightbeed.ably-daily" "$FAKE_LAUNCHD/kicks.log"'

echo "7) 관리 스크립트가 바뀌면 새 버전으로 다시 실행"
echo "# 변경 시험" >>"$T/src/mac/lib.sh"; push "lib 변경"; sync
check "새 버전으로 재실행" 'grep -q "새 버전으로 다시 실행" "$T/sync.log"'
check "끝난 뒤 잠금 풀림" '[ ! -d "$AH/state/autoupdate.lock" ]'

echo "8) 손으로 깐 같은 이름 작업 넘겨받기 · 다른 작업은 그대로"
printf '<plist><dict><key>Label</key><string>com.brightbeed.legacy</string></dict></plist>\n' >"$AG/com.brightbeed.legacy.plist"
cp "$AG/com.brightbeed.legacy.plist" "$FAKE_LAUNCHD/loaded/com.brightbeed.legacy"
printf '<plist><dict><key>Label</key><string>com.brightbeed.fx-usd</string></dict></plist>\n' >"$AG/com.brightbeed.fx-usd.plist"
cp "$AG/com.brightbeed.fx-usd.plist" "$FAKE_LAUNCHD/loaded/com.brightbeed.fx-usd"
printf 'DESC=옛 작업\nRUN=true\nAT=06:00\n' >"$T/src/mac/jobs/legacy.job"; push "넘겨받기"; sync
check "백업 후 자동 관리로" 'ls "$AH/state"/backup-com.brightbeed.legacy.*.plist >/dev/null 2>&1 && grep -qx legacy "$AH/state/managed.txt" && grep -q "<integer>6</integer>" "$AG/com.brightbeed.legacy.plist"'
check "관계없는 fx-usd 는 그대로" 'grep -q "fx-usd" "$AG/com.brightbeed.fx-usd.plist" && [ -e "$FAKE_LAUNCHD/loaded/com.brightbeed.fx-usd" ]'

echo "9) 작업 실행 (run-job.sh)"
FAKE_JOB_RC=0 bash "$C/mac/run-job.sh" ably-daily
check "성공 기록" 'grep -qx "result=ok" "$AH/state/status-ably-daily.txt"'
check "끝나자마자 상태 파일에 결과" 'gh_status | grep -q "\"last_result\": \"ok\"" && gh_status | grep -q "\"running\": false"'
n=$(puts); sleep 1; FAKE_JOB_RC=0 bash "$C/mac/run-job.sh" ably-daily
check "또 성공이면 상태를 다시 안 올림 (30분 작업이 커밋을 쌓지 않게)" '[ "$(puts)" = "$n" ]'
check "로그에 시작 · 완료" 'grep -q "\[ably-daily\] 시작: npm run ably-daily" "$LG/brightbeed-ably-daily.log" && grep -q "\[ably-daily\] 완료" "$LG/brightbeed-ably-daily.log" && grep -q "fake run ably-daily" "$LG/brightbeed-ably-daily.log"'
FAKE_JOB_RC=3 bash "$C/mac/run-job.sh" ably-daily
check "실패 기록 (종료 코드 3)" 'grep -qx "detail=종료 코드 3" "$AH/state/status-ably-daily.txt"'
FAKE_JOB_RC=1 FAKE_JOB_MSG="[ably-daily] 실패: 에이블리 로그인 실패" bash "$C/mac/run-job.sh" ably-daily
check "실패하면 마지막 오류 줄도 상태에 (맥에 가지 않고 원인 보기)" 'grep -qxF "detail=종료 코드 1 — [ably-daily] 실패: 에이블리 로그인 실패" "$AH/state/status-ably-daily.txt"'
cp "$C/.env" "$T/env.bak"; grep -v "^ABLY_PASSWORD" "$T/env.bak" >"$C/.env"
bash "$C/mac/run-job.sh" ably-daily
check "설정값 없으면 실행 안 함" 'grep -qx "detail=설정값 없음: ABLY_PASSWORD" "$AH/state/status-ably-daily.txt"'
echo "ABLY_PASSWORD=..." >>"$C/.env"; bash "$C/mac/run-job.sh" ably-daily
check "예시값(...)도 없는 것으로" 'grep -qx "detail=설정값 없음: ABLY_PASSWORD" "$AH/state/status-ably-daily.txt"'
cp "$T/env.bak" "$C/.env"
grep -v "^REPORTS_GITHUB_TOKEN" "$T/env.bak" >"$C/.env"; n=$(puts)
bash "$C/mac/run-job.sh" ably-daily
check "토큰이 없으면 상태를 안 올림" '[ "$(puts)" = "$n" ]'
cp "$T/env.bak" "$C/.env"
FAKE_JOB_SLEEP=3 bash "$C/mac/run-job.sh" ably-daily & bg=$!
sleep 1
bash "$C/mac/run-job.sh" ably-daily
check "동시 실행은 건너뜀" 'grep -q "이미 실행 중" "$LG/brightbeed-ably-daily.log"'
sync
check "작업 실행 중엔 갱신 미룸" 'grep -q "작업 실행 중(ably-daily)" "$T/sync.log"'
wait $bg
check "끝나면 실행 잠금 풀림" '[ ! -d "$AH/state/run-ably-daily.lock" ]'
check "4번째 실행은 성공" 'grep -qx "result=ok" "$AH/state/status-ably-daily.txt"'

echo "10) 의존성은 package-lock.json 이 바뀔 때만"
: >"$FAKE_LAUNCHD/calls.log"; sync
check "그대로면 npm ci 안 함" '! grep -q "npm ci" "$FAKE_LAUNCHD/calls.log"'
echo " " >>"$T/src/package-lock.json"; push "lock 변경"; sync
check "바뀌면 npm ci" 'grep -q "npm ci" "$FAKE_LAUNCHD/calls.log"'

echo "11) 상태 보기 · 지금 실행"
st=$(bash "$C/mac/autoupdate.sh" status 2>&1); printf '%s\n' "$st" | sed 's/^/     | /'
check "자동 확인 켜짐" 'printf "%s" "$st" | grep -q "자동 확인   켜짐"'
check "작업 줄" 'printf "%s" "$st" | grep -q "ably-daily — 에이블리 일일 보고서 (코페리) · 매일 07:20 · 설치됨"'
check "손으로 깐 작업 표시" 'printf "%s" "$st" | grep -q "com.brightbeed.fx-usd"'
bash "$C/mac/autoupdate.sh" run ably-daily >/dev/null 2>&1
check "run → launchctl kickstart" 'grep -q "kickstart com.brightbeed.ably-daily" "$FAKE_LAUNCHD/kicks.log"'

echo "12) 개발용 사본에서 sync 를 불러도 전용 사본으로 넘김"
bash "$REPO/mac/autoupdate.sh" sync >"$T/sync.log" 2>&1; rc=$?
check "정상 종료" '[ $rc = 0 ] && [ ! -d "$AH/state/autoupdate.lock" ]'

echo "13) 다시 설치해도 안전"
out=$(bash "$REPO/mac/install.sh" 2>&1)
check "기존 .env 유지" 'printf "%s" "$out" | grep -q "이미 있음" && grep -q "^ABLY_PASSWORD=pw$" "$C/.env"'
check "작업 그대로 등록" '[ -e "$FAKE_LAUNCHD/loaded/com.brightbeed.ably-daily" ] && [ -e "$FAKE_LAUNCHD/loaded/com.brightbeed.autoupdate" ]'

echo "14) 내리기"
bash "$C/mac/autoupdate.sh" uninstall >/dev/null 2>&1
check "관리 작업 · 관리자 내림" '[ ! -e "$FAKE_LAUNCHD/loaded/com.brightbeed.ably-daily" ] && [ ! -e "$FAKE_LAUNCHD/loaded/com.brightbeed.legacy" ] && [ ! -e "$FAKE_LAUNCHD/loaded/com.brightbeed.autoupdate" ] && [ ! -f "$AG/com.brightbeed.autoupdate.plist" ]'
check "손으로 깐 작업은 그대로" '[ -f "$AG/com.brightbeed.fx-usd.plist" ]'

echo "15) 문법 검사"
for s in "$REPO"/mac/*.sh "$REPO"/mac/tests/*.sh; do check "bash -n ${s#$REPO/}" 'bash -n "$s"'; done

echo
echo "결과: 통과 $PASS · 실패 $FAIL"
if [ $FAIL = 0 ]; then rm -rf "$T"; else echo "시험 폴더 남겨 둠: $T"; fi
[ $FAIL = 0 ]
