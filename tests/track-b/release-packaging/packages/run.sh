#!/bin/sh
set -eu
lock=/tmp/track-b-release-heavy.lock
if ! mkdir "$lock" 2>/dev/null; then
  echo 'Shared heavy-check lock busy; no heavy process started. Retry after current owner finishes.' >&2
  exit 75
fi
trap 'rmdir "$lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$(dirname "$0")/verify.mjs" "$@"
