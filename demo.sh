#!/usr/bin/env bash
# Scripted demo runner for screen recording.
#   ./demo.sh 1        quiet run -> few vibration blips -> temperature rising warning  (~40s, 5 rounds)
#   ./demo.sh 2        tear spotted -> 3 verification rounds -> confirmed -> belt STOPS (~44s, verify = 3x8 = 24s)
#   ./demo.sh 3        small tear (warning) -> next round ~16x bigger -> belt STOPS     (~20s)
#   ./demo.sh 4        bonus: tear spotted but doesn't persist -> false alarm, keeps running (~40s)
#   ./demo.sh reset    stop any running demo + clear dashboard back to normal
# Optional 2nd argument = seconds to wait before it starts (time to switch windows):
#   ./demo.sh 2 3
HOST="${BACKEND_URL:-http://localhost:8000}"
case "$1" in
  1|2|3|4) curl -s -X POST "$HOST/api/demo/run/$1?delay=${2:-0}"; echo ;;
  reset)   curl -s -X POST "$HOST/api/demo/reset"; echo ;;
  *) sed -n '2,10p' "$0" ;;
esac
