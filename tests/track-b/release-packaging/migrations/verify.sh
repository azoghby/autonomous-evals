#!/bin/sh
set -eu
lock=/tmp/track-b-release-heavy.lock
if ! mkdir "$lock" 2>/dev/null; then
  echo 'BUSY: shared heavy lock; no SQL execution started. Run node --check on the .mjs files or review the manifest, then retry.' >&2
  exit 75
fi
trap 'rmdir "$lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TRACK_B_MIGRATION_LOCK_HELD=1 node "$(dirname "$0")/verify.mjs"
