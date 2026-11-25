#!/usr/bin/env bash
# macOS: 원격 디버깅 포트를 연 Chrome 을 별도 프로필로 실행한다 (대시보드의 "CDP 연결" 모드용).
# 최신 Chrome 은 기본 프로필에서는 --remote-debugging-port 를 무시하므로 전용 프로필 디렉터리를 사용한다.
# 이 창에서 예매 사이트에 한 번 로그인해 두면 세션이 프로필에 유지된다. (비밀번호는 Chrome 이 관리하며 이 프로그램은 저장하지 않음)
set -euo pipefail
PORT="${1:-9222}"
PROFILE="${TICKET_ASSIST_CHROME_PROFILE:-$HOME/.ticket-assist/chrome-cdp-profile}"
mkdir -p "$PROFILE"
if [[ "$(uname)" == "Darwin" ]]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  CHROME="$(command -v google-chrome || command -v chromium || true)"
fi
[[ -x "$CHROME" ]] || { echo "Chrome 을 찾을 수 없습니다: $CHROME" >&2; exit 1; }
echo "Chrome 실행: 포트 $PORT, 프로필 $PROFILE"
echo "대시보드 → 브라우저 → 'CDP 연결' → http://127.0.0.1:$PORT"
exec "$CHROME" --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check
