#!/usr/bin/env node
/**
 * claude-session-coord — SessionStart hook
 *
 * Reads SQLite directly (no MCP needed) and prints a summary of
 * pending coordination messages. Silent if nothing pending.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const DB_PATH = path.join(os.homedir(), ".claude", "coordination", "coord.db");

// No DB yet — nothing to report
if (!fs.existsSync(DB_PATH)) {
  process.exit(0);
}

let Database;
try {
  Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
} catch {
  // better-sqlite3 not installed yet (setup.sh hasn't run)
  process.exit(0);
}

const db = new Database(DB_PATH, { readonly: true, timeout: 3000 });

try {
  const rows = db.prepare(`
    SELECT message_id, session_id, project, message_type, subject, body, ref_message_id, created_at
    FROM coordination_messages
    WHERE status = 'pending'
    ORDER BY created_at DESC
    LIMIT 10
  `).all();

  if (rows.length === 0) {
    process.exit(0);
  }

  // Truncate body for inline display
  function truncateBody(bodyStr, maxLen = 500) {
    if (!bodyStr || bodyStr === "{}" || bodyStr === "null") return "";
    try {
      const parsed = JSON.parse(bodyStr);
      const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
      return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
    } catch {
      return bodyStr.length > maxLen ? bodyStr.slice(0, maxLen) + "..." : bodyStr;
    }
  }

  // Format time ago
  function timeAgo(isoDate) {
    if (!isoDate) return "";
    const diff = Date.now() - new Date(isoDate + "Z").getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  const lines = [`[session-coord] ${rows.length} pending message${rows.length > 1 ? "s" : ""}:`];
  for (const r of rows) {
    const proj = r.project ? ` [${r.project}]` : "";
    const body = truncateBody(r.body);
    const isReply = r.ref_message_id ? ` (reply to ${r.ref_message_id})` : "";
    lines.push("  ─────────────────────────────────────────");
    lines.push(`  📨 ${r.message_id} | ${r.message_type} from ${r.session_id}${proj} (${timeAgo(r.created_at)})${isReply}`);
    lines.push(`  Subject: ${r.subject}`);
    if (body) {
      lines.push(`  Body: ${body}`);
    }
    lines.push(`  → Reply: coord_reply(message_id="${r.message_id}", session_id="<your-session>", body={...})`);
  }
  console.log(lines.join("\n"));
} catch (err) {
  // Silently fail — don't block session start
  process.exit(0);
} finally {
  db.close();
}
