#!/bin/bash
# launchd(com.brightbeed.<작업id>)가 정해진 시각에 실행: run-job.sh <작업id>
# 작업 내용(RUN · REQUIRES · TIMEOUT_MIN)은 실행할 때마다 mac/jobs/<작업id>.job 에서 다시 읽는다.
# 결과: ~/Library/Logs/brightbeed-<작업id>.log 와 ~/brightbeed-auto/state/status-<작업id>.txt
# 스크립트가 실행 중에 git 으로 바뀌어도 안전하도록 전부 main 안에 두고 마지막 줄에서 한 번에 실행한다.

main(){
  . "$(cd "$(dirname "$0")" && pwd)/lib.sh"
  local id=${1:-} f logf missing run timeout pid wd rc start dur
  valid_id "$id" || { echo "사용법: run-job.sh <작업id>"; return 2; }
  f=$(job_file "$id"); logf=$(job_log "$id")
  mkdir -p "$STATE_DIR" "$LOG_DIR"

  if ! lock_acquire "run-$id"; then
    log "[$id] 이미 실행 중 — 이번 실행은 건너뜀" >>"$logf"
    return 0
  fi
  trap "lock_release 'run-$id'" EXIT   # 지금 값으로 펼쳐 둠 — 함수가 끝나면 지역변수 id 는 사라진다
  trim_log "$logf"
  exec >>"$logf" 2>&1

  if [ ! -f "$f" ]; then log "[$id] 작업 정의가 없어요 ($f) — 저장소에서 지워진 작업"; return 0; fi
  if [ "$(job_get "$f" ENABLED)" = "0" ]; then log "[$id] 꺼진 작업 — 건너뜀"; return 0; fi

  # 자동 설치 관리자가 의존성(npm ci)을 까는 중이면 최대 15분 기다림
  local waited=0
  while lock_busy deps && [ $waited -lt 900 ]; do sleep 10; waited=$((waited + 10)); done
  if [ ! -d "$CLONE_DIR/node_modules" ]; then
    log "[$id] 실패: 의존성이 아직 안 깔렸어요 — $MANAGER_LOG 확인"
    status_write "$id" fail "의존성 미설치"
    return 1
  fi
  missing=$(env_missing "$f")
  if [ -n "$missing" ]; then
    log "[$id] 실패: .env 에 설정값이 없어요 — $missing ($CLONE_DIR/.env)"
    status_write "$id" fail "설정값 없음: $missing"
    return 1
  fi

  run=$(job_get "$f" RUN)
  if [ -z "$run" ]; then log "[$id] 실패: RUN 이 비어 있어요"; status_write "$id" fail "RUN 없음"; return 1; fi
  timeout=$(job_get "$f" TIMEOUT_MIN); case "$timeout" in ''|*[!0-9]*) timeout=60 ;; esac

  log "[$id] 시작: $run (코드 $(git -C "$CLONE_DIR" rev-parse --short HEAD 2>/dev/null))"
  start=$(date +%s)
  cd "$CLONE_DIR" || { status_write "$id" fail "폴더 없음"; return 1; }
  /bin/bash -c "$run" &
  pid=$!
  # 시간 초과 감시 — 넘으면 작업과 그 자식 프로세스를 끈다
  ( sleep $((timeout * 60)); log "[$id] 시간 초과 (${timeout}분) — 강제 종료"; pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null ) &
  wd=$!
  wait "$pid"; rc=$?
  pkill -P "$wd" 2>/dev/null; kill "$wd" 2>/dev/null
  dur=$(( $(date +%s) - start ))
  if [ $rc = 0 ]; then
    log "[$id] 완료 (${dur}초)"
    status_write "$id" ok "완료 ${dur}초"
  else
    log "[$id] 실패: 종료 코드 $rc (${dur}초)"
    status_write "$id" fail "종료 코드 $rc"
  fi
  return $rc
}
main "$@"; exit $?
