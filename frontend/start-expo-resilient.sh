#!/bin/bash
# start-expo-resilient.sh
#
# Auto-healing wrapper for `expo start --tunnel`.
# 
# Problem: the ngrok free-tier tunnel that `expo start --tunnel` uses
# disconnects every few minutes during development sessions. When that
# happens, expo crashes with a misleading error, the Metro file-map cache
# gets corrupted, and the iPhone shows a red "Expected MIME-Type" error
# until someone manually restarts everything.
#
# This wrapper:
#   1. Pre-clears the Metro cache before every start (avoids stale cache)
#   2. Watches stderr for known fatal patterns (ngrok timeouts, cache
#      deserialization failures)
#   3. Automatically restarts with exponential backoff (1s, 2s, 4s, 8s, 16s, cap 30s)
#   4. Logs every restart with a clear marker so we can audit what happened
#
# Designed to run UNDER supervisor with autorestart=false (this script
# IS the restart loop).

cd /app/frontend

# Backoff parameters
BACKOFF=1
MAX_BACKOFF=30

# Patterns that mean "the tunnel is dead, restart needed".
FATAL_PATTERNS='(Cannot read properties of undefined|Unable to deserialize cloned data|Tunnel disconnected|ngrok.*timeout|ECONNREFUSED.*ngrok|tunnel session failed|ERR_NGROK)'

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [resilient] === Starting Expo ===" >&2

  # 1) Pre-clear Metro cache (corruption from previous crash)
  rm -rf /tmp/metro-* /app/frontend/.expo/metro-cache /tmp/haste-map-* 2>/dev/null

  # 2) Launch expo and pipe stderr through grep to spot fatal patterns.
  #    We use process substitution so we can both LOG and DETECT.
  set -o pipefail
  yarn expo start --dev-client --tunnel --port 3000 2>&1 | \
    tee /tmp/expo-current.log | \
    while IFS= read -r line; do
      echo "$line"
      if echo "$line" | grep -qE "$FATAL_PATTERNS"; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [resilient] FATAL pattern detected, will restart: $line" >&2
        # Kill the whole pipeline; the outer loop will restart.
        pkill -P $$ -f "expo start" 2>/dev/null
        pkill -f "expo start" 2>/dev/null
        break
      fi
    done

  EXIT_CODE=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [resilient] Expo exited (code=$EXIT_CODE). Restarting in ${BACKOFF}s..." >&2

  sleep "$BACKOFF"

  # Exponential backoff (cap at 30s)
  BACKOFF=$((BACKOFF * 2))
  if [ "$BACKOFF" -gt "$MAX_BACKOFF" ]; then
    BACKOFF=$MAX_BACKOFF
  fi

  # If we've been running for >5min successfully (i.e. expo crashed AFTER
  # being healthy for a while), reset backoff to 1s.
  UPTIME=$(stat -c %Y /tmp/expo-current.log 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if [ $((NOW - UPTIME)) -lt 300 ]; then
    BACKOFF=1
  fi
done
