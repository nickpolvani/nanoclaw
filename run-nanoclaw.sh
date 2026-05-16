#!/bin/bash
# Launch NanoClaw with the exact clean environment that works when run
# manually. launchd's injected environment causes Node's ESM bootstrap to
# hang in GetNearestParentPackageJSON; env -i scrubs it.
cd /Users/nicco/Documents/projects/nanoclaw || exit 1
exec /usr/bin/env -i \
  PATH="/usr/local/bin:/usr/bin:/bin:/Users/nicco/.local/bin" \
  HOME="/Users/nicco" \
  /opt/homebrew/bin/node /Users/nicco/Documents/projects/nanoclaw/dist/index.js
