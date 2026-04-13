#!/bin/bash
# Standalone RSS + Newsletter check - no pi/LLM overhead
# Usage: crontab -e → */15 * * * * ~/.pi/agent/extensions/rss-reader/scripts/check.sh

# Source fnm for correct node/tsx path
export PATH="$HOME/.local/share/fnm/node-versions/v22.20.0/installation/bin:$PATH"

cd "$(dirname "$0")/.."
exec tsx scripts/check-worker.ts "$@"
