#!/bin/bash
# claude-session-coord — Setup script
# Installs npm dependencies if missing.

set -e

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Install npm dependencies if node_modules is missing
if [ ! -d "$PLUGIN_DIR/node_modules" ]; then
  cd "$PLUGIN_DIR"
  npm install --production --no-fund --no-audit 2>&1
fi

echo "claude-session-coord ready"
