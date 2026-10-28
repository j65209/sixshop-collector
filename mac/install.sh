#!/bin/bash
# 맥미니 자동 설치 관리자 설치 — 맥 터미널에 아래 한 줄을 붙여 넣고 처음 한 번만 실행:
#   bash <(curl -fsSL https://raw.githubusercontent.com/j65209/sixshop-collector/main/mac/install.sh)
# 다시 실행해도 안전하다 (이미 깔려 있으면 점검·갱신만). 하는 일:
#   1) ~/brightbeed-auto/sixshop-collector 에 전용 사본 (GitHub main 그대로 — 사람이 손대지 않는 폴더)
#   2) 설정 파일(.env): 이 맥에 이미 있는 sixshop-collector/.env 를 찾아 복사, 없으면 .env.example 로 새로 만듦
#   3) 지금 한 번 확인 — 의존성 설치(npm ci) + mac/jobs 의 작업 등록
#   4) com.brightbeed.autoupdate 등록 — 15분마다 GitHub 를 확인해 바뀐 코드·새 작업을 알아서 반영
# 비밀번호·토큰은 GitHub 에 올리지 않는다 (레포가 공개) — 이 맥의 .env 에만 둔다.

# .env 의 상대경로 파일(예: GOOGLE_SERVICE_ACCOUNT_PATH=./sa.json)도 같이 복사
copy_rel_file(){
  local v
  v=$(env_value "$2")
  case "$v" in ''|/*|'~'*) return 0 ;; esac
  [ -f "$1/$v" ] || return 0
  mkdir -p "$(dirname "$CLONE_DIR/$v")"
  cp "$1/$v" "$CLONE_DIR/$v" && chmod 600 "$CLONE_DIR/$v" && echo "    같이 복사: $v"
}

setup_env(){
  local envf="$CLONE_DIR/.env" c src=""
  if [ -f "$envf" ]; then echo "    이미 있음: $envf"; return 0; fi
  # 오피스 레포가 ~/projects/Brightbeed 라 같은 폴더부터. (Desktop·Documents 는 macOS 가 접근 허락을 물을 수 있음)
  for c in "$HOME/projects/sixshop-collector" "$HOME/sixshop-collector" "$HOME/Developer/sixshop-collector" \
           "$HOME/Desktop/projects/sixshop-collector" "$HOME/Desktop/sixshop-collector" \
           "$HOME/Documents/sixshop-collector" "$HOME/Documents/GitHub/sixshop-collector"; do
    if [ -f "$c/.env" ]; then src=$c; break; fi
  done
  if [ -z "$src" ]; then
    c=$(find "$HOME" -maxdepth 3 \( -path "$HOME/Library" -o -path "$BB_AUTO_HOME" \) -prune \
          -o -type f -name .env -path '*sixshop-collector*' -print 2>/dev/null | head -n 1)
    [ -n "$c" ] && src=$(dirname "$c")
  fi
  if [ -n "$src" ]; then
    cp "$src/.env" "$envf" && chmod 600 "$envf"
    echo "    이 맥에 있던 설정을 복사했어요: $src/.env"
    copy_rel_file "$src" GOOGLE_SERVICE_ACCOUNT_PATH
  else
    cp "$CLONE_DIR/.env.example" "$envf" && chmod 600 "$envf"
    echo "    이 맥에 기존 설정이 없어 새로 만들었어요 — 값을 채워 주세요: open -e \"$envf\""
  fi
}

install_manager(){
  local plist="$AGENTS_DIR/$MANAGER_LABEL.plist"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$MANAGER_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml_esc "$CLONE_DIR/mac/autoupdate.sh")</string><string>sync</string><string>--launchd</string></array>
  <key>StartInterval</key><integer>$((CHECK_EVERY_MIN * 60))</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$(xml_esc "$MANAGER_LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_esc "$MANAGER_LOG")</string>
</dict>
</plist>
EOF
  lc_unload "$MANAGER_LABEL"
  lc_load "$plist"
}

main(){
  local home=${BB_AUTO_HOME:-$HOME/brightbeed-auto}
  local url=${BB_REPO_URL:-https://github.com/j65209/sixshop-collector.git}
  local clone="$home/sixshop-collector" p f miss=""
  export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
  if [ "$(uname)" != Darwin ] && [ "${BB_ALLOW_NON_MAC:-0}" != 1 ]; then echo "맥(macOS)에서만 설치할 수 있어요"; return 1; fi
  command -v git >/dev/null 2>&1 || { echo "git 이 없어요 — 터미널에서 xcode-select --install 을 먼저 실행하세요"; return 1; }

  # 1) 전용 사본을 받고, 그 안의 최신 install.sh 로 넘겨서 나머지를 진행
  if [ "${BB_INSTALL_STAGE:-1}" != 2 ]; then
    echo "1/4 코드 받기 → $clone"
    if [ -d "$clone/.git" ]; then
      git -C "$clone" fetch -q origin main && git -C "$clone" reset -q --hard origin/main \
        || { echo "    코드 갱신 실패 — 인터넷 연결을 확인하세요"; return 1; }
    else
      mkdir -p "$home" && git clone -q "$url" "$clone" \
        || { echo "    코드 받기 실패 — 인터넷 연결을 확인하세요"; return 1; }
    fi
    export BB_INSTALL_STAGE=2 BB_AUTO_HOME="$home"
    exec /bin/bash "$clone/mac/install.sh" "$@"
  fi

  . "$clone/mac/lib.sh"
  mkdir -p "$STATE_DIR" "$LOG_DIR" "$AGENTS_DIR"
  p=$(node_problem)
  [ -n "$p" ] && echo "    ! $p — 설치해 두면 자동 확인이 알아서 이어서 진행해요"

  echo "2/4 설정 파일(.env)"
  setup_env

  echo "3/4 의존성 설치·작업 등록 (처음엔 몇 분 걸려요)"
  /bin/bash "$CLONE_DIR/mac/autoupdate.sh" sync

  echo "4/4 자동 확인 등록 (${CHECK_EVERY_MIN}분마다 GitHub 확인)"
  if install_manager; then echo "    완료"; else echo "    ! 등록 실패 — 위 메시지를 확인하세요"; return 1; fi

  echo
  /bin/bash "$CLONE_DIR/mac/autoupdate.sh" status
  for f in "$CLONE_DIR"/mac/jobs/*.job; do
    [ -f "$f" ] && [ -n "$(env_missing "$f")" ] && miss=1
  done
  echo
  if [ -n "$miss" ]; then
    echo "남은 일: 위 '! .env 에 필요한 값'을 채워 주세요 → open -e \"$CLONE_DIR/.env\""
    echo "         채운 뒤 바로 확인: bash \"$CLONE_DIR/mac/autoupdate.sh\" run <작업id>"
  fi
  echo "끝. 이제 GitHub 에 올린 작업은 이 맥이 ${CHECK_EVERY_MIN}분 안에 알아서 설치·실행해요."
}
main "$@"; exit $?
