#!/usr/bin/env node
/**
 * claude-session-coord — SessionStart / UserPromptSubmit hook
 *
 * Reads SQLite directly (no MCP needed) and prints coordination messages.
 *
 * Two modes:
 * 1. Conversation Mode: When conversations table has active row for this session,
 *    show partner's pending messages in conversation format.
 * 2. Normal Mode: Show all pending messages. Silent if nothing pending.
 *
 * Session identification: derived from cwd field in stdin JSON.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const DB_DIR = path.join(os.homedir(), ".claude", "coordination");
const DB_PATH = path.join(DB_DIR, "coord.db");

if (!fs.existsSync(DB_PATH)) {
  process.exit(0);
}

let Database;
try {
  Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
} catch {
  process.exit(0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(isoDate) {
  if (!isoDate) return "";
  const dateStr = isoDate.endsWith("Z") ? isoDate : isoDate + "Z";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

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

// ─── Parse stdin ──────────────────────────────────────────────────────────────

let sessionName = null;
let userPrompt = null;
try {
  const stdin = fs.readFileSync(0, "utf8").trim();
  if (stdin) {
    const parsed = JSON.parse(stdin);
    if (parsed.cwd) sessionName = path.basename(parsed.cwd);
    if (parsed.user_prompt && typeof parsed.user_prompt === "string" && parsed.user_prompt.trim()) {
      userPrompt = parsed.user_prompt.trim();
    }
  }
} catch { /* No stdin or not JSON */ }

// ─── Open DB ──────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true, timeout: 3000 });

try {
  // Check conversation mode via DB
  let conv = null;
  if (sessionName) {
    try {
      conv = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(sessionName);
    } catch { /* table doesn't exist yet */ }
  }

  if (conv && conv.partner) {
    // ━━━ CONVERSATION MODE ━━━
    const startedAt = conv.started_at || "1970-01-01 00:00:00";

    const rows = db.prepare(`
      SELECT message_id, session_id, subject, body, created_at
      FROM coordination_messages
      WHERE status = 'pending' AND session_id = ?
        AND created_at >= ?
      ORDER BY created_at ASC LIMIT 10
    `).all(conv.partner, startedAt);

    if (rows.length === 0) {
      console.log(`[conv] ${conv.session_id} \u2194 ${conv.partner} | ${conv.topic}`);
      console.log(`\u23F3 Waiting for response from ${conv.partner}...`);
      process.exit(0);
    }

    const lines = [];
    lines.push(`[conv] ${conv.session_id} \u2194 ${conv.partner} | ${conv.topic}`);
    lines.push(`started: ${timeAgo(conv.started_at)}`);
    lines.push("\u2501".repeat(50));

    let lastMsgId = null;
    for (const r of rows) {
      const body = truncateBody(r.body);
      lines.push("");
      lines.push(`\uD83D\uDCAC ${r.session_id} (${timeAgo(r.created_at)}):`);
      lines.push(`   ${r.subject}`);
      if (body) {
        for (const bline of body.split("\n")) {
          lines.push(`   ${bline}`);
        }
      }
      lines.push(`   [message_id: ${r.message_id}]`);
      lastMsgId = r.message_id;
    }

    lines.push("");
    lines.push("\u2501".repeat(50));

    if (userPrompt) {
      lines.push(`[conv] User direction: "${userPrompt}"`);
      lines.push("");
    }

    lines.push(`\u2192 reply: coord_reply(message_id="${lastMsgId}", session_id="${conv.session_id}", body={...})`);
    lines.push(`\u2192 end:   coord_conv_end(session_id="${conv.session_id}")`);

    console.log(lines.join("\n"));

  } else {
    // ━━━ NORMAL MODE ━━━
    const rows = db.prepare(`
      SELECT message_id, session_id, project, message_type, subject, body, ref_message_id, created_at
      FROM coordination_messages
      WHERE status = 'pending'
      ORDER BY created_at DESC LIMIT 10
    `).all();

    if (rows.length === 0) {
      process.exit(0);
    }

    const lines = [`[session-coord] ${rows.length} pending message${rows.length > 1 ? "s" : ""}:`];
    for (const r of rows) {
      const proj = r.project ? ` [${r.project}]` : "";
      const body = truncateBody(r.body);
      const isReply = r.ref_message_id ? ` (reply to ${r.ref_message_id})` : "";
      lines.push("  " + "\u2500".repeat(41));
      lines.push(`  \uD83D\uDCE8 ${r.message_id} | ${r.message_type} from ${r.session_id}${proj} (${timeAgo(r.created_at)})${isReply}`);
      lines.push(`  Subject: ${r.subject}`);
      if (body) {
        lines.push(`  Body: ${body}`);
      }
      lines.push(`  \u2192 Reply: coord_reply(message_id="${r.message_id}", session_id="<your-session>", body={...})`);
    }
    console.log(lines.join("\n"));
  }
} catch {
  process.exit(0);
} finally {
  db.close();
}
