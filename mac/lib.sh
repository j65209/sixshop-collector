# 맥미니 자동 설치 관리자 — 공통 경로·함수. install.sh · autoupdate.sh · run-job.sh 가 source 한다.
# macOS 기본 bash 3.2 에서 돌아야 함: 연관 배열 · mapfile · ${x,,} · set -u 같은 bash 4 문법·옵션 금지.
# 경로는 환경변수로 바꿀 수 있다 (mac/tests/fake-mac.sh 가 가짜 맥 환경에서 쓰는 용도).

BB_AUTO_HOME="${BB_AUTO_HOME:-$HOME/brightbeed-auto}"   # 자동 설치 전용 폴더 (사람이 손대지 않는 곳)
CLONE_DIR="$BB_AUTO_HOME/sixshop-collector"              # 전용 사본 — 매번 GitHub main 과 똑같이 맞춘다
STATE_DIR="$BB_AUTO_HOME/state"
LOG_DIR="${BB_LOG_DIR:-$HOME/Library/Logs}"
AGENTS_DIR="${BB_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
REPO_URL="${BB_REPO_URL:-https://github.com/j65209/sixshop-collector.git}"
LABEL_PREFIX="com.brightbeed."                           # scripts/mac/install-fx-usd.sh(오피스 레포)와 같은 이름 규칙
MANAGER_LABEL="com.brightbeed.autoupdate"
MANAGER_LOG="$LOG_DIR/brightbeed-autoupdate.log"
CHECK_EVERY_MIN=15
GUI="gui/$(id -u)"

# launchd 는 PATH 가 거의 비어 있다 — 맥미니 node 위치(install-fx-usd.sh 와 같은 순서)를 앞에 붙인다
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# 느린 네트워크에서 git 이 끝없이 기다리거나 비밀번호를 묻지 않게
export GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=60 GIT_TERMINAL_PROMPT=0

log(){ printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

# 같은 경고를 15분마다 반복해서 쓰지 않게 — 내용이 바뀌었을 때만 기록. 해결되면 clear_once.
log_once(){
  local f="$STATE_DIR/once-$1"; shift
  [ "$(cat "$f" 2>/dev/null)" = "$*" ] && return 0
  printf '%s' "$*" >"$f"
  log "$*"
}
clear_once(){ rm -f "$STATE_DIR/once-$1"; }

# ---------- 잠금 (mkdir 은 원자적. 주인 프로세스가 죽었으면 풀고 다시 잡는다) ----------
lock_busy(){
  local d="$STATE_DIR/$1.lock" p
  [ -d "$d" ] || return 1
  p=$(cat "$d/pid" 2>/dev/null)
  if [ -z "$p" ]; then
    # 막 잡는 중이라 pid 를 아직 못 쓴 경우 — 10분 넘게 비어 있으면 버려진 잠금
    [ -n "$(find "$d" -maxdepth 0 -mmin +10 2>/dev/null)" ] && return 1
    return 0
  fi
  kill -0 "$p" 2>/dev/null
}
lock_acquire(){
  local d="$STATE_DIR/$1.lock"
  if mkdir "$d" 2>/dev/null; then echo $$ >"$d/pid"; return 0; fi
  [ "$(cat "$d/pid" 2>/dev/null)" = "$$" ] && return 0   # exec 로 자기 자신을 새 버전으로 다시 띄운 경우
  lock_busy "$1" && return 1
  rm -rf "$d"
  mkdir "$d" 2>/dev/null && { echo $$ >"$d/pid"; return 0; }
  return 1
}
lock_release(){ rm -rf "$STATE_DIR/$1.lock"; }
# 지금 실행 중인 작업 id 들 (공백 구분)
running_jobs(){
  local d id out=""
  for d in "$STATE_DIR"/run-*.lock; do
    [ -d "$d" ] || continue
    id=${d##*/run-}; id=${id%.lock}
    lock_busy "run-$id" && out="$out $id"
  done
  printf '%s' "${out# }"
}

# ---------- 작업 정의 (mac/jobs/<id>.job) ----------
# KEY=값 한 줄 형식만 읽는다 — 셸로 실행하지 않으므로 값 안의 $(...) 등은 그냥 글자.
job_get(){
  local line v
  line=$(grep -E "^[[:space:]]*$2[[:space:]]*=" "$1" 2>/dev/null | tail -n 1)
  [ -n "$line" ] || return 0
  v=${line#*=}
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  case "$v" in
    \"*\") v=${v#\"}; v=${v%\"} ;;
    \'*\') v=${v#\'}; v=${v%\'} ;;
  esac
  printf '%s' "$v"
}
valid_id(){ case "$1" in ''|-*|*[!a-z0-9-]*) return 1 ;; esac; return 0; }
job_file(){ printf '%s' "$CLONE_DIR/mac/jobs/$1.job"; }
job_ids(){
  local f out=""
  for f in "$CLONE_DIR"/mac/jobs/*.job; do [ -f "$f" ] && out="$out $(basename "$f" .job)"; done
  printf '%s' "${out# }"
}
job_log(){ printf '%s' "$LOG_DIR/brightbeed-$1.log"; }

# 일정이 올바른지: AT="HH:MM ..." (+ WEEKDAYS="1 2 3 4 5", 1=월 … 7=일) 또는 EVERY_MIN=N
schedule_ok(){
  local every at wd t d
  every=$(job_get "$1" EVERY_MIN); at=$(job_get "$1" AT); wd=$(job_get "$1" WEEKDAYS)
  if [ -n "$every" ]; then
    case "$every" in *[!0-9]*) return 1 ;; esac
    [ "$every" -ge 1 ] 2>/dev/null
    return
  fi
  [ -n "$at" ] || return 1
  for t in $at; do
    case "$t" in [0-9]:[0-5][0-9]|[01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) ;; *) return 1 ;; esac
  done
  for d in $wd; do case "$d" in [0-7]) ;; *) return 1 ;; esac; done
  return 0
}
schedule_text(){
  local every at wd d names="" sep=""
  every=$(job_get "$1" EVERY_MIN); at=$(job_get "$1" AT); wd=$(job_get "$1" WEEKDAYS)
  if [ -n "$every" ]; then printf '%s분마다' "$every"; return; fi
  if [ -z "$wd" ]; then names="매일"
  elif [ "$wd" = "1 2 3 4 5" ]; then names="평일"
  else
    for d in $wd; do
      case "$d" in 1) d=월;; 2) d=화;; 3) d=수;; 4) d=목;; 5) d=금;; 6) d=토;; 0|7) d=일;; esac
      names="$names$sep$d"; sep="·"
    done
  fi
  printf '%s %s' "$names" "$at"
}

xml_esc(){ printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# launchd plist — 실행은 항상 run-job.sh <id> (작업 내용은 실행 때 .job 에서 다시 읽음)
plist_for_job(){
  local id=$1 f=$2 every at wd t h m d log
  log=$(job_log "$id")
  every=$(job_get "$f" EVERY_MIN); at=$(job_get "$f" AT); wd=$(job_get "$f" WEEKDAYS)
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_esc "$LABEL_PREFIX$id")</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml_esc "$CLONE_DIR/mac/run-job.sh")</string><string>$(xml_esc "$id")</string></array>
EOF
  if [ -n "$every" ]; then
    printf '  <key>StartInterval</key><integer>%s</integer>\n' "$((every * 60))"
  else
    printf '  <key>StartCalendarInterval</key>\n  <array>\n'
    for t in $at; do
      h=$((10#${t%%:*})); m=$((10#${t#*:}))
      if [ -n "$wd" ]; then
        for d in $wd; do
          printf '    <dict><key>Weekday</key><integer>%s</integer><key>Hour</key><integer>%s</integer><key>Minute</key><integer>%s</integer></dict>\n' "$d" "$h" "$m"
        done
      else
        printf '    <dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>%s</integer></dict>\n' "$h" "$m"
      fi
    done
    printf '  </array>\n'
  fi
  cat <<EOF
  <key>StandardOutPath</key><string>$(xml_esc "$log")</string>
  <key>StandardErrorPath</key><string>$(xml_esc "$log")</string>
</dict>
</plist>
EOF
}

# ---------- launchd ----------
lc_loaded(){ launchctl print "$GUI/$1" >/dev/null 2>&1; }
lc_unload(){ launchctl bootout "$GUI/$1" >/dev/null 2>&1 || true; }
# 방금 내린 작업을 바로 다시 올리면 가끔 실패해서 몇 번 재시도 (마지막 시도는 에러를 보여 줌)
lc_load(){
  local i
  for i in 1 2 3; do
    launchctl bootstrap "$GUI" "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  launchctl bootstrap "$GUI" "$1"
}

# ---------- 자동 관리 목록 (이 관리자가 설치한 작업 id) ----------
managed_list(){ [ -f "$STATE_DIR/managed.txt" ] && grep -v '^$' "$STATE_DIR/managed.txt"; return 0; }
is_managed(){ managed_list | grep -qx "$1"; }
mark_managed(){ is_managed "$1" || echo "$1" >>"$STATE_DIR/managed.txt"; }
unmark_managed(){
  local rest
  rest=$(managed_list | grep -vx "$1")
  if [ -n "$rest" ]; then printf '%s\n' "$rest" >"$STATE_DIR/managed.txt"; else : >"$STATE_DIR/managed.txt"; fi
}

# ---------- .env (전용 사본 안. 레포가 공개라 비밀번호는 GitHub 에 올리지 않고 여기에만) ----------
env_value(){
  local line
  [ -f "$CLONE_DIR/.env" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$CLONE_DIR/.env" | tail -n 1)
  [ -n "$line" ] || return 0
  printf '%s' "${line#*=}" | sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'\$/\\1/"
}
# .env.example 의 예시값은 "없음"으로 친다
is_placeholder(){ case "$1" in ''|*...|changeme|you@example.com|your-store-id|*xxxxx*) return 0 ;; esac; return 1; }
# 작업의 REQUIRES 중 .env 에 없는 키 (공백 구분). "A|B" 는 둘 중 하나만 있으면 됨.
env_missing(){
  local reqs req alt ok out=""
  reqs=$(job_get "$1" REQUIRES)
  for req in $reqs; do
    ok=0
    for alt in $(printf '%s' "$req" | tr '|' ' '); do
      is_placeholder "$(env_value "$alt")" || { ok=1; break; }
    done
    [ $ok = 1 ] || out="$out $req"
  done
  printf '%s' "${out# }"
}

# ---------- 작업별 마지막 실행 결과 ----------
status_write(){ # status_write <id> <ok|fail|skip> <설명>
  printf 'result=%s\nat=%s\ndetail=%s\ncommit=%s\n' "$2" "$(date '+%F %T')" "$3" \
    "$(git -C "$CLONE_DIR" rev-parse --short HEAD 2>/dev/null)" >"$STATE_DIR/status-$1.txt"
}
status_get(){ grep -E "^$2=" "$STATE_DIR/status-$1.txt" 2>/dev/null | head -n 1 | cut -d= -f2-; }

# 로그가 2MB 를 넘으면 마지막 3000줄만 남김 (실행 중이 아닐 때만 부를 것)
trim_log(){
  local f=$1 size
  [ -f "$f" ] || return 0
  size=$(wc -c <"$f" | tr -d ' ')
  [ "${size:-0}" -gt 2097152 ] || return 0
  tail -n 3000 "$f" >"$f.tmp" && cat "$f.tmp" >"$f"
  rm -f "$f.tmp"
}

# ---------- 서버 상태 보고 (비공개 보고서 레포 mac/status.json) ----------
# 맥에 가지 않고도 이 PC·오피스에서 맥미니가 살아 있는지, 작업이 어떻게 됐는지 보는 용도.
# 자동 확인(sync)이 끝날 때와 작업이 끝날 때 올린다 — 내용이 바뀌었거나 3시간이 지났을 때만 (15분마다 커밋 방지).
json_str(){ printf '"%s"' "$(printf '%s' "$1" | tr '\t\r\n' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }

deps_state(){
  [ -d "$CLONE_DIR/node_modules" ] || { if [ -f "$STATE_DIR/deps.failed" ]; then printf failed; else printf missing; fi; return 0; }
  if [ "$(cksum <"$CLONE_DIR/package-lock.json" 2>/dev/null | awk '{print $1 "-" $2}')" = "$(cat "$STATE_DIR/deps.cksum" 2>/dev/null)" ]; then
    printf ok
  else
    printf outdated
  fi
}

status_json(){
  local f id inst sep="" last nodev envf mgr
  last=$(grep '^at=' "$STATE_DIR/last-sync.txt" 2>/dev/null | cut -d= -f2-)
  nodev=$(node_problem); [ -n "$nodev" ] || nodev=$(node -v 2>/dev/null)
  if [ -f "$CLONE_DIR/.env" ]; then envf=true; else envf=false; fi
  if lc_loaded "$MANAGER_LABEL"; then mgr=on; else mgr=off; fi
  printf '{\n "updated_at": %s,\n "last_sync": %s,\n "commit": %s,\n "node": %s,\n "deps": %s,\n "env_file": %s,\n "manager": %s,\n "jobs": [' \
    "$(json_str "$(date '+%F %T')")" "$(json_str "$last")" "$(json_str "$(git -C "$CLONE_DIR" rev-parse --short HEAD 2>/dev/null)")" \
    "$(json_str "$nodev")" "$(json_str "$(deps_state)")" "$envf" "$(json_str "$mgr")"
  for f in "$CLONE_DIR"/mac/jobs/*.job; do
    [ -f "$f" ] || continue
    id=$(basename "$f" .job)
    if [ "$(job_get "$f" ENABLED)" = "0" ]; then inst=off
    elif lc_loaded "$LABEL_PREFIX$id"; then inst=installed
    else inst=not_installed; fi
    printf '%s\n  {"id": %s, "desc": %s, "schedule": %s, "state": %s, "running": %s, "last_result": %s, "last_at": %s, "last_detail": %s, "missing_env": %s}' \
      "$sep" "$(json_str "$id")" "$(json_str "$(job_get "$f" DESC)")" "$(json_str "$(schedule_text "$f")")" "$(json_str "$inst")" \
      "$(if lock_busy "run-$id"; then echo true; else echo false; fi)" \
      "$(json_str "$(status_get "$id" result)")" "$(json_str "$(status_get "$id" at)")" "$(json_str "$(status_get "$id" detail)")" \
      "$(json_str "$(env_missing "$f")")"
    sep=","
  done
  printf '\n ]\n}\n'
}

push_status(){
  local tok repo api tmp now sha shaj body
  tok=$(env_value REPORTS_GITHUB_TOKEN)
  is_placeholder "$tok" && return 0
  command -v curl >/dev/null 2>&1 || return 0
  repo=$(env_value REPORTS_REPO); repo=${repo:-j65209/brightbeed-reports}
  tmp="$STATE_DIR/status.json"
  status_json >"$tmp"
  # 시각만 바뀐 건 변경으로 안 침 — 작업이 또 성공한 것(마지막 실행 시각 · "완료 N초") · 실행 중 여부도. 30분마다 도는 작업이 커밋을 쌓지 않게
  now=$(grep -v -E '"(updated_at|last_sync)"' "$tmp" | sed -e 's/"last_at": "[^"]*"/"last_at": ""/' -e 's/"last_detail": "완료 [0-9]*초"/"last_detail": "완료"/' -e 's/"running": [a-z]*/"running": false/' | cksum)
  if [ "$now" = "$(cat "$STATE_DIR/status.pushed" 2>/dev/null)" ] && [ -z "$(find "$STATE_DIR/status.pushed" -mmin +180 2>/dev/null)" ]; then
    return 0
  fi
  api="https://api.github.com/repos/$repo/contents/mac/status.json"
  sha=$(curl -fsS -m 20 -H "Authorization: Bearer $tok" -H "Accept: application/vnd.github+json" "$api" 2>/dev/null \
    | grep -o '"sha": *"[0-9a-f]*"' | head -n 1 | sed 's/.*"\([0-9a-f]*\)"$/\1/')
  shaj=""; [ -n "$sha" ] && shaj=",\"sha\":\"$sha\""
  body="{\"message\":\"mac: 상태 $(date '+%F %T')\",\"content\":\"$(base64 <"$tmp" | tr -d '\n')\"$shaj}"
  if curl -fsS -m 30 -X PUT -H "Authorization: Bearer $tok" -H "Accept: application/vnd.github+json" -d "$body" "$api" >/dev/null 2>&1; then
    printf '%s' "$now" >"$STATE_DIR/status.pushed"
    clear_once status
  else
    log_once status "서버 상태를 GitHub(비공개 보고서 레포 mac/status.json)에 못 올렸어요 — .env 토큰 권한·인터넷 확인"
  fi
}

# node 20+ (package.json engines). 없으면 이유를 돌려줌
node_problem(){
  local v
  command -v node >/dev/null 2>&1 || { printf 'node 가 없어요 (brew install node)'; return 0; }
  v=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  [ "${v:-0}" -ge 20 ] 2>/dev/null || printf 'node 20 이상이 필요해요 (지금 %s)' "$(node -v 2>/dev/null)"
  return 0
}
