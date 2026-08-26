#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${TMPDIR:-/tmp}/capturely-development.pid"
LOG_FILE="${TMPDIR:-/tmp}/capturely-development.log"
ELECTRON_BINARY="$ROOT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

stop_previous_run() {
  if [[ -f "$PID_FILE" ]]; then
    local previous_pid
    previous_pid="$(cat "$PID_FILE")"
    if kill -0 "$previous_pid" 2>/dev/null; then
      kill "$previous_pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}

build() {
  (cd "$ROOT_DIR" && npm run build)
}

launch() {
  (
    cd "$ROOT_DIR"
    nohup "$ELECTRON_BINARY" . >"$LOG_FILE" 2>&1 < /dev/null &
    echo $! >"$PID_FILE"
  )
}

stop_previous_run
build

case "$MODE" in
  run)
    launch
    ;;
  --debug|debug)
    (cd "$ROOT_DIR" && npx electron --inspect-brk .)
    ;;
  --logs|logs|--telemetry|telemetry)
    launch
    tail -n 80 -f "$LOG_FILE"
    ;;
  --verify|verify)
    launch
    sleep 2
    kill -0 "$(cat "$PID_FILE")"
    echo "Capturely development app is running."
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
