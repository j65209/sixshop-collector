#!/bin/bash
# 맥미니 자동 설치 관리자 — launchd(com.brightbeed.autoupdate)가 15분마다 + 맥을 켤 때 실행한다.
#   1) GitHub main 의 최신 코드를 전용 사본(~/brightbeed-auto/sixshop-collector)에 그대로 맞춤
#   2) package-lock.json 이 바뀌었으면 npm ci
#   3) mac/jobs/*.job 목록대로 launchd 작업 설치·변경·제거 (이름 com.brightbeed.<작업id>)
# 맥 터미널에서 직접 쓰는 명령:
#   bash ~/brightbeed-auto/sixshop-collector/mac/autoupdate.sh status        상태 보기
#   bash ~/brightbeed-auto/sixshop-collector/mac/autoupdate.sh run <작업id>   지금 한 번 실행
#   bash ~/brightbeed-auto/sixshop-collector/mac/autoupdate.sh sync          지금 바로 GitHub 확인·반영
#   bash ~/brightbeed-auto/sixshop-collector/mac/autoupdate.sh uninstall     관리자와 작업 전부 내리기
# 스크립트가 실행 중에 git 으로 바뀌어도 안전하도록 전부 함수 안에 두고 마지막 줄에서 한 번에 실행한다.

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

mac_cksum(){ cat "$CLONE_DIR"/mac/*.sh 2>/dev/null | cksum; }

# 0 = 그대로, 10 = 새 코드로 바뀜, 1 = 실패
update_code(){
  local cur new err
  cur=$(git -C "$CLONE_DIR" rev-parse HEAD 2>/dev/null) || { log "전용 사본이 깨졌어요 — install.sh 를 다시 실행하세요"; return 1; }
  if ! err=$(git -C "$CLONE_DIR" fetch -q origin main 2>&1); then
    log_once fetch "GitHub 에서 코드를 못 받았어요 (인터넷 연결?) — 다음 확인 때 다시: $(printf '%s' "$err" | head -n 1)"
    return 1
  fi
  clear_once fetch
  new=$(git -C "$CLONE_DIR" rev-parse origin/main 2>/dev/null) || return 1
  [ "$cur" = "$new" ] && return 0
  if ! git -C "$CLONE_DIR" reset -q --hard origin/main; then log "코드 갱신 실패 (${new:0:7})"; return 1; fi
  log "코드 갱신 ${cur:0:7} → ${new:0:7}: $(git -C "$CLONE_DIR" log -1 --format=%s)"
  return 10
}

# package-lock.json 이 바뀌었거나 node_modules 가 없으면 npm ci. 실패하면 6시간 동안은 같은 버전으로 재시도 안 함.
ensure_deps(){
  local want have
  [ -f "$CLONE_DIR/package-lock.json" ] || return 0
  want=$(cksum <"$CLONE_DIR/package-lock.json" | awk '{print $1 "-" $2}')
  have=$(cat "$STATE_DIR/deps.cksum" 2>/dev/null)
  [ -d "$CLONE_DIR/node_modules" ] && [ "$want" = "$have" ] && return 0
  if [ "$(cat "$STATE_DIR/deps.failed" 2>/dev/null)" = "$want" ] && [ -z "$(find "$STATE_DIR/deps.failed" -mmin +360 2>/dev/null)" ]; then
    return 1
  fi
  lock_acquire deps || return 0
  log "의존성 설치 (npm ci) — 처음엔 몇 분 걸려요"
  if (cd "$CLONE_DIR" && npm ci --no-audit --no-fund); then
    echo "$want" >"$STATE_DIR/deps.cksum"; rm -f "$STATE_DIR/deps.failed"
    log "의존성 설치 완료"
  else
    echo "$want" >"$STATE_DIR/deps.failed"
    log "의존성 설치 실패 — 위 내용 확인. 6시간 뒤나 package-lock.json 이 바뀌면 다시 시도"
  fi
  lock_release deps
}

# mac/jobs/*.job 과 launchd 를 맞춤. 이 관리자가 깐 작업(managed.txt)만 내리고, 손으로 깐 다른 작업은 건드리지 않는다.
sync_jobs(){
  local f id label plist tmp seen=" "
  for f in "$CLONE_DIR"/mac/jobs/*.job; do
    [ -f "$f" ] || continue
    id=$(basename "$f" .job)
    if ! valid_id "$id"; then log_once "bad-$id" "작업 이름은 영문 소문자·숫자·- 만 쓸 수 있어요: $f — 건너뜀"; continue; fi
    [ "$(job_get "$f" ENABLED)" = "0" ] && continue
    if ! schedule_ok "$f"; then log_once "bad-$id" "[$id] 일정(AT · WEEKDAYS · EVERY_MIN) 형식이 잘못됐어요 — 건너뜀"; continue; fi
    clear_once "bad-$id"
    seen="$seen$id "
    label="$LABEL_PREFIX$id"; plist="$AGENTS_DIR/$label.plist"
    tmp=$(mktemp "$STATE_DIR/plist.XXXXXX") || continue
    plist_for_job "$id" "$f" >"$tmp"
    if is_managed "$id" && cmp -s "$tmp" "$plist" && lc_loaded "$label"; then rm -f "$tmp"; continue; fi
    if lock_busy "run-$id"; then rm -f "$tmp"; continue; fi   # 실행 중이면 끝난 다음 확인 때 바꿈
    if [ -f "$plist" ] && ! is_managed "$id"; then
      cp "$plist" "$STATE_DIR/backup-$label.$(date +%Y%m%d%H%M%S).plist"
      log "[$id] 손으로 깔아 둔 같은 이름 작업을 자동 관리로 넘겨받음 (원래 설정은 $STATE_DIR 에 백업)"
    fi
    lc_unload "$label"
    cat "$tmp" >"$plist"; rm -f "$tmp"
    if lc_load "$plist"; then
      mark_managed "$id"
      log "[$id] 설치: $(schedule_text "$f") — $(job_get "$f" DESC)"
    else
      log "[$id] 설치 실패 (launchctl bootstrap) — 다음 확인 때 다시"
    fi
  done
  # 저장소에서 지워졌거나 ENABLED=0 인 작업 내리기
  for id in $(managed_list); do
    case "$seen" in *" $id "*) continue ;; esac
    lock_busy "run-$id" && continue
    lc_unload "$LABEL_PREFIX$id"
    rm -f "$AGENTS_DIR/$LABEL_PREFIX$id.plist"
    unmark_managed "$id"
    log "[$id] 내림 (저장소에서 지워졌거나 ENABLED=0)"
  done
}

cmd_sync(){
  local a launchd=0 before rc busy problem
  for a in "$@"; do [ "$a" = "--launchd" ] && launchd=1; done
  if [ ! -d "$CLONE_DIR/.git" ]; then log "전용 사본이 없어요 ($CLONE_DIR) — 먼저 install.sh 를 실행하세요"; return 1; fi
  # 다른 폴더(개발용 사본 등)에서 불렀으면 전용 사본의 스크립트로 넘김 (한 번만 — 경로 표기가 달라도 무한 반복 안 하게)
  if [ "$SELF_DIR" != "$CLONE_DIR/mac" ] && [ "${BB_HANDOFF:-0}" != 1 ]; then
    export BB_HANDOFF=1
    exec /bin/bash "$CLONE_DIR/mac/autoupdate.sh" sync "$@"
  fi
  mkdir -p "$STATE_DIR" "$LOG_DIR" "$AGENTS_DIR"
  if [ $launchd = 1 ]; then trim_log "$MANAGER_LOG"; exec >>"$MANAGER_LOG" 2>&1; fi
  if ! lock_acquire autoupdate; then
    [ $launchd = 1 ] || log "다른 확인이 진행 중이에요 — 잠시 뒤 다시 해 주세요"
    return 0
  fi
  trap "lock_release autoupdate" EXIT
  busy=$(running_jobs)
  if [ -n "$busy" ]; then log_once busy "작업 실행 중($busy) — 끝난 뒤 다음 확인 때 반영"; return 0; fi
  clear_once busy

  before=$(mac_cksum)
  update_code; rc=$?
  if [ $rc = 10 ] && [ "${BB_REEXEC:-0}" != 1 ] && [ "$(mac_cksum)" != "$before" ]; then
    log "관리 스크립트가 바뀌어 새 버전으로 다시 실행"
    export BB_REEXEC=1
    exec /bin/bash "$CLONE_DIR/mac/autoupdate.sh" sync "$@"
  fi
  problem=$(node_problem)
  if [ -n "$problem" ]; then log_once node "$problem — 작업이 실행되지 않아요"; else clear_once node; ensure_deps; fi
  sync_jobs
  printf 'at=%s\ncommit=%s\n' "$(date '+%F %T')" "$(git -C "$CLONE_DIR" rev-parse --short HEAD)" >"$STATE_DIR/last-sync.txt"
  return 0
}

cmd_status(){
  local f id label inst st miss p other=""
  echo "맥미니 자동 설치 관리자 — 상태"
  if [ ! -d "$CLONE_DIR/.git" ]; then
    echo "  아직 설치 안 됨 → sixshop-collector/mac/README.md 의 설치 명령을 맥 터미널에서 실행하세요"
    return 0
  fi
  echo "  코드        $(git -C "$CLONE_DIR" log -1 --format='%h · %cd · %s' --date=format:'%m-%d %H:%M' 2>/dev/null)"
  p=$(grep '^at=' "$STATE_DIR/last-sync.txt" 2>/dev/null | cut -d= -f2-)
  echo "  마지막 확인 ${p:-아직 없음}"
  if lc_loaded "$MANAGER_LABEL"; then echo "  자동 확인   켜짐 (${CHECK_EVERY_MIN}분마다 GitHub 확인)"
  else echo "  자동 확인   꺼짐 — install.sh 를 다시 실행하세요"; fi
  p=$(node_problem); echo "  node        ${p:-$(node -v 2>/dev/null)}"
  if [ -f "$CLONE_DIR/.env" ]; then echo "  설정 파일   $CLONE_DIR/.env"
  else echo "  설정 파일   없음 — $CLONE_DIR/.env 를 만들어야 해요"; fi
  echo
  echo "작업 (mac/jobs/*.job)"
  for f in "$CLONE_DIR"/mac/jobs/*.job; do
    [ -f "$f" ] || continue
    id=$(basename "$f" .job); label="$LABEL_PREFIX$id"
    if [ "$(job_get "$f" ENABLED)" = "0" ]; then inst="꺼둠"
    elif lc_loaded "$label"; then inst="설치됨"
    else inst="미설치"; fi
    echo "  $id — $(job_get "$f" DESC) · $(schedule_text "$f") · $inst"
    st=$(status_get "$id" result)
    case "$st" in
      ok) echo "      마지막 실행 $(status_get "$id" at) 성공 ($(status_get "$id" detail))" ;;
      '') echo "      아직 실행 안 됨" ;;
      *) echo "      마지막 실행 $(status_get "$id" at) 실패 ($(status_get "$id" detail))" ;;
    esac
    miss=$(env_missing "$f")
    [ -n "$miss" ] && echo "      ! .env 에 필요한 값: $miss"
    echo "      로그 $(job_log "$id")"
  done
  # 이 관리자가 관리하지 않는 com.brightbeed.* 작업 (오피스 레포 install-fx-usd.sh 처럼 손으로 깐 것)
  for p in "$AGENTS_DIR"/com.brightbeed.*.plist; do
    [ -f "$p" ] || continue
    label=$(basename "$p" .plist); id=${label#"$LABEL_PREFIX"}
    [ "$label" = "$MANAGER_LABEL" ] && continue
    is_managed "$id" && continue
    other="$other $label"
  done
  if [ -n "$other" ]; then echo; echo "손으로 깐 다른 작업 (이 관리자는 건드리지 않음):$other"; fi
  return 0
}

cmd_run(){
  local id=${1:-} rc
  if ! valid_id "$id" || [ ! -f "$(job_file "$id")" ]; then
    echo "작업 이름을 확인하세요 — 있는 작업: $(job_ids)"
    return 1
  fi
  if lc_loaded "$LABEL_PREFIX$id"; then
    launchctl kickstart "$GUI/$LABEL_PREFIX$id" || return 1
    echo "실행 시작 — 진행 보기: tail -f \"$(job_log "$id")\""
    return 0
  fi
  echo "아직 설치 전이라 여기서 바로 실행해요 …"
  /bin/bash "$CLONE_DIR/mac/run-job.sh" "$id"; rc=$?
  tail -n 15 "$(job_log "$id")" 2>/dev/null
  return $rc
}

cmd_uninstall(){
  local id
  for id in $(managed_list); do
    lc_unload "$LABEL_PREFIX$id"; rm -f "$AGENTS_DIR/$LABEL_PREFIX$id.plist"
    echo "내림: $LABEL_PREFIX$id"
  done
  : >"$STATE_DIR/managed.txt" 2>/dev/null
  lc_unload "$MANAGER_LABEL"; rm -f "$AGENTS_DIR/$MANAGER_LABEL.plist"
  echo "자동 설치 관리자를 껐어요. 코드·설정(.env)은 $BB_AUTO_HOME 에 그대로 있어요."
  echo "다시 켜기: bash \"$CLONE_DIR/mac/install.sh\""
}

main(){
  . "$SELF_DIR/lib.sh"
  local cmd=${1:-status}
  [ $# -gt 0 ] && shift
  case "$cmd" in
    sync) cmd_sync "$@" ;;
    status) cmd_status ;;
    run) cmd_run "$@" ;;
    uninstall) cmd_uninstall ;;
    *) echo "사용법: autoupdate.sh [status | sync | run <작업id> | uninstall]"; return 2 ;;
  esac
}
main "$@"; exit $?
