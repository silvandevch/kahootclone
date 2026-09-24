#!/usr/bin/env bash
set -u
cd /home/silvan/Documents/kahootclone

# Wait for port to free if previous server still hanging on
for i in 1 2 3 4 5; do
  if ! ss -tln 2>/dev/null | grep -q :3000; then break; fi
  sleep 0.5
done

bun server/index.ts > /tmp/kahoot-server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

# Wait until server is actually serving
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS --max-time 1 http://127.0.0.1:3000/api/quizzes > /dev/null 2>&1; then break; fi
  sleep 0.3
done

bun server/e2e.ts