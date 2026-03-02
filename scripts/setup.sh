#!/bin/bash
# claude-session-coord — Setup hook
# Creates coordination DB directory and installs npm dependencies.

set -e

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_DIR="$HOME/.claude/coordination"

mkdir -p "$DB_DIR"

# Install npm dependencies if node_modules is missing
if [ ! -d "$PLUGIN_DIR/node_modules" ]; then
  cd "$PLUGIN_DIR"
  npm install --production --no-fund --no-audit 2>&1
fi

echo "Session coordination initialized at $DB_DIR"
