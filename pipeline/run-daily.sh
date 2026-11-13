#!/usr/bin/env bash
# Daily entry point (called by the systemd timer). Safe to run by hand.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v22.12.0/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.."
# wait for network (the timer can fire right after boot)
for i in $(seq 1 30); do
  getent hosts www.youtube.com >/dev/null 2>&1 && break
  sleep 10
done
# keep yt-dlp fresh; YouTube changes often and old versions break
.venv/bin/pip install -q -U yt-dlp youtube-transcript-api >/dev/null 2>&1 || true
exec .venv/bin/python pipeline/pipeline.py "$@"
