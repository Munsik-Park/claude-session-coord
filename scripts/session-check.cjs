#!/usr/bin/env node
/**
 * claude-session-coord — SessionStart / UserPromptSubmit hook
 *
 * Reads SQLite directly (no MCP needed) and prints coordination messages.
 *
 * Two modes:
 * 1. Conversation Mode: When conv-mode-{session}.json exists and is active,
 *    only show partner's pending messages in conversation format.
 *    If no pending messages, show "waiting" indicator.
 * 2. Normal Mode: Show all pending messages. Silent if nothing pending.
 *
 * Session identification: derived from cwd field in stdin JSON
 * (UserPromptSubmit hook receives JSON with cwd on stdin).
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const DB_DIR = path.join(os.homedir(), ".claude", "coordination");
const DB_PATH = path.join(DB_DIR, "coord.db");

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(isoDate) {
  if (!isoDate) return "";
  // Handle both "2026-03-04T10:30:00" (no Z) and "2026-03-04T10:30:00.000Z" (has Z)
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

function readConvState(sessionName) {
  const stateFile = path.join(DB_DIR, `conv-mode-${sessionName}.json`);
  if (!fs.existsSync(stateFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!data.active) return null;

    // Check expiry
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      try { fs.unlinkSync(stateFile); } catch { /* ok */ }
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function updateConvTurnCount(sessionName, newCount, lastMessageId) {
  const stateFile = path.join(DB_DIR, `conv-mode-${sessionName}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    data.turn_count = newCount;
    if (lastMessageId) data.last_message_id = lastMessageId;
    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
  } catch {
    // Non-critical — don't block hook
  }
}

// ─── Parse stdin for cwd and user_prompt (UserPromptSubmit sends JSON) ────────

let sessionName = null;
let userPrompt = null;
try {
  const stdin = fs.readFileSync(0, "utf8").trim();
  if (stdin) {
    const parsed = JSON.parse(stdin);
    if (parsed.cwd) {
      sessionName = path.basename(parsed.cwd);
    }
    if (parsed.user_prompt && typeof parsed.user_prompt === "string" && parsed.user_prompt.trim()) {
      userPrompt = parsed.user_prompt.trim();
    }
  }
} catch {
  // No stdin or not JSON — SessionStart hook case (no stdin)
}

// ─── Open DB ──────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true, timeout: 3000 });

try {
  const convState = sessionName ? readConvState(sessionName) : null;

  // Check if partner ended the conversation
  if (convState && convState.ended_by) {
    const stateFile = path.join(DB_DIR, `conv-mode-${sessionName}.json`);
    try { fs.unlinkSync(stateFile); } catch { /* ok */ }
    console.log(`[conv] ${convState.ended_by} ended the conversation.`);
    console.log(`Call coord_conv_end(session_id="${convState.session_id}", summary="...") to save your summary.`);
    process.exit(0);
  }

  if (convState) {
    // ━━━ CONVERSATION MODE ━━━
    // Only show partner's pending messages (created after conversation started)
    const convStartedAt = convState.started_at || "1970-01-01T00:00:00Z";
    const startedAtFormatted = convStartedAt.replace("T", " ").replace("Z", "").slice(0, 19);
    const rows = db.prepare(`
      SELECT message_id, session_id, project, message_type, subject, body, ref_message_id, created_at
      FROM coordination_messages
      WHERE status = 'pending' AND session_id = ?
        AND created_at >= ?
      ORDER BY created_at ASC
      LIMIT 10
    `).all(convState.partner, startedAtFormatted);

    if (rows.length === 0) {
      // No messages from partner yet
      console.log(`[conv] ${convState.session_id} \u2194 ${convState.partner} | ${convState.topic}`);
      console.log(`\u23F3 Waiting for response from ${convState.partner}...`);
      process.exit(0);
    }

    // Build conversation-mode output
    const startedAgo = timeAgo(convState.started_at);
    const newTurnCount = convState.turn_count + rows.length;
    const lines = [];

    lines.push(`[conv] ${convState.session_id} \u2194 ${convState.partner} | ${convState.topic}`);
    lines.push(`turn: ${newTurnCount} | started: ${startedAgo}`);
    lines.push("\u2501".repeat(50));

    let lastMsgId = convState.last_message_id;
    for (const r of rows) {
      const body = truncateBody(r.body);
      lines.push("");
      lines.push(`\uD83D\uDCAC ${r.session_id} (${timeAgo(r.created_at)}):`);
      lines.push(`   ${r.subject}`);
      if (body) {
        // Indent body lines
        for (const bline of body.split("\n")) {
          lines.push(`   ${bline}`);
        }
      }
      lines.push(`   [message_id: ${r.message_id}]`);
      lastMsgId = r.message_id;
    }

    lines.push("");
    lines.push("\u2501".repeat(50));

    // Show user direction if provided
    if (userPrompt) {
      lines.push(`[conv] User direction: "${userPrompt}"`);
      lines.push("");
    }

    lines.push(`\u2192 reply: coord_reply(message_id="${lastMsgId}", session_id="${convState.session_id}", body={...})`);
    lines.push(`\u2192 end:   coord_conv_end(session_id="${convState.session_id}")`);

    console.log(lines.join("\n"));

    // Update turn count in state file
    updateConvTurnCount(sessionName, newTurnCount, lastMsgId);

  } else {
    // ━━━ NORMAL MODE ━━━
    const rows = db.prepare(`
      SELECT message_id, session_id, project, message_type, subject, body, ref_message_id, created_at
      FROM coordination_messages
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT 10
    `).all();

    if (rows.length === 0) {
      // No pending messages — silent exit (saves tokens)
      process.exit(0);
    }

    const lines = [`[session-coord] ${rows.length} pending message${rows.length > 1 ? "s" : ""}:`];
    for (const r of rows) {
      const proj = r.project ? ` [${r.project}]` : "";
      const body = truncateBody(r.body);
      const isReply = r.ref_message_id ? ` (reply to ${r.ref_message_id})` : "";
      lines.push("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
      lines.push(`  \uD83D\uDCE8 ${r.message_id} | ${r.message_type} from ${r.session_id}${proj} (${timeAgo(r.created_at)})${isReply}`);
      lines.push(`  Subject: ${r.subject}`);
      if (body) {
        lines.push(`  Body: ${body}`);
      }
      lines.push(`  \u2192 Reply: coord_reply(message_id="${r.message_id}", session_id="<your-session>", body={...})`);
    }
    console.log(lines.join("\n"));
  }
} catch (err) {
  // Silently fail — don't block session start
  process.exit(0);
} finally {
  db.close();
}
