#!/usr/bin/env node
/**
 * claude-session-coord — Stop hook for autonomous AI-to-AI conversation
 *
 * Fires after AI completes a response. If in conversation mode (DB-backed):
 *   1. Query conversations table for active conversation
 *   2. If no partner yet → block("Waiting for partner...")
 *   3. Poll for pending [conv] or [conv-end] messages (3s interval, 15s total)
 *   4. [conv-end] found → block(end notice) + exit
 *   5. [conv] found → block(message reinject) + exit
 *   6. Nothing found → exit(0) (idle, Prompt hook resumes on user input)
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const DB_DIR = path.join(os.homedir(), ".claude", "coordination");
const DB_PATH = path.join(DB_DIR, "coord.db");

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Parse stdin ──────────────────────────────────────────────────────────────

let sessionName = null;
try {
  const stdin = fs.readFileSync(0, "utf8").trim();
  if (stdin) {
    const parsed = JSON.parse(stdin);
    if (parsed.cwd) sessionName = path.basename(parsed.cwd);
  }
} catch { /* No stdin or not JSON */ }

if (!sessionName || !fs.existsSync(DB_PATH)) {
  process.exit(0);
}

let Database;
try {
  Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
} catch {
  process.exit(0);
}

// ─── Check conversation in DB ─────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true, timeout: 3000 });
let conv;
try {
  conv = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(sessionName);
} catch {
  // Table doesn't exist yet (MCP server hasn't started) — not in conversation mode
  db.close();
  process.exit(0);
}
db.close();

if (!conv) {
  process.exit(0); // Not in conversation mode
}

if (!conv.partner) {
  // Room created but no one joined yet — exit silently
  process.exit(0);
}

// ─── Poll for partner messages ────────────────────────────────────────────────

const POLL_INTERVAL = 3000;
const MAX_WAIT = 15000;

async function pollForMessages() {
  const startTime = Date.now();
  const startedAt = conv.started_at || "1970-01-01 00:00:00";

  while (true) {
    let pollDb;
    try {
      pollDb = new Database(DB_PATH, { readonly: true, timeout: 3000 });
    } catch {
      process.exit(0);
    }

    try {
      // Check for [conv-end] first
      const endMsg = pollDb.prepare(`
        SELECT message_id, session_id, subject, body, created_at
        FROM coordination_messages
        WHERE status = 'pending' AND session_id = ?
          AND subject LIKE '[conv-end]%'
          AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1
      `).get(conv.partner, startedAt);

      if (endMsg) {
        pollDb.close();
        const output = JSON.stringify({
          decision: "block",
          reason: `[conv] ${conv.partner} ended the conversation.\n\n` +
            `Call coord_conv_end(session_id="${conv.session_id}", summary="...") to save your summary.`,
        });
        process.stdout.write(output);
        process.exit(0);
      }

      // Check for [conv] messages
      const rows = pollDb.prepare(`
        SELECT message_id, session_id, subject, body, created_at
        FROM coordination_messages
        WHERE status = 'pending' AND session_id = ?
          AND subject LIKE '[conv]%'
          AND created_at >= ?
        ORDER BY created_at ASC LIMIT 5
      `).all(conv.partner, startedAt);

      pollDb.close();

      if (rows.length > 0) {
        const lastMsg = rows[rows.length - 1];
        const lines = [];
        lines.push(`[conv] ${conv.partner} (${timeAgo(lastMsg.created_at)}):`);

        for (const r of rows) {
          lines.push(`  ${r.subject}`);
          const body = truncateBody(r.body);
          if (body) {
            for (const bline of body.split("\n")) {
              lines.push(`  ${bline}`);
            }
          }
          lines.push(`  [message_id: ${r.message_id}]`);
        }

        lines.push("");
        lines.push(`\u2192 coord_reply(message_id="${lastMsg.message_id}", session_id="${conv.session_id}", body={...})`);
        lines.push(`\u2192 coord_conv_end(session_id="${conv.session_id}", summary="...")`);

        const output = JSON.stringify({
          decision: "block",
          reason: lines.join("\n"),
          systemMessage: `[conv] ${conv.session_id} \u2194 ${conv.partner} | ${conv.topic}`,
        });
        process.stdout.write(output);
        process.exit(0);
      }
    } catch {
      try { pollDb.close(); } catch { /* ok */ }
    }

    if (Date.now() - startTime >= MAX_WAIT) {
      // Timeout — exit silently so user can type freely
      process.exit(0);
    }

    await sleep(POLL_INTERVAL);
  }
}

pollForMessages().catch(() => process.exit(0));
