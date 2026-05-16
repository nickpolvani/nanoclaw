#!/bin/bash
# Persistent NanoClaw supervisor (tmux-run, not launchd — launchd context
# hangs Node's ESM bootstrap on this headless Mac; the user session works).
cd /Users/nicco/Documents/projects/nanoclaw || exit 1
while true; do
  echo "[supervisor] starting NanoClaw $(date '+%F %T')"
  /usr/bin/env -i \
    PATH="/usr/local/bin:/usr/bin:/bin:/Users/nicco/.local/bin" \
    HOME="/Users/nicco" \
    /opt/homebrew/bin/node /Users/nicco/Documents/projects/nanoclaw/dist/index.js
  echo "[supervisor] NanoClaw exited code=$? — restarting in 3s $(date '+%F %T')"
  sleep 3
done
