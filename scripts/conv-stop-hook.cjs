#!/usr/bin/env node
/**
 * claude-session-coord — Stop hook for autonomous AI-to-AI conversation
 *
 * Fires after AI completes a response. If in conversation mode:
 *   1. Check state file for active conversation
 *   2. Query SQLite for partner's pending messages
 *   3. If found → {"decision":"block","reason":"<msg>"} → auto-reinject
 *   4. If not found → poll every 3s for up to 15s
 *   5. After timeout → exit 0 (idle, user prompt resumes later)
 *
 * Safety: max_turns limit, 30min TTL, graceful expiry cleanup
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const DB_DIR = path.join(os.homedir(), ".claude", "coordination");
const DEBUG_LOG = path.join(DB_DIR, "conv-debug.log");

function debugLog(msg) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(DEBUG_LOG, `[${ts}] ${msg}\n`); } catch { /* ok */ }
}
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

function readConvState(sessionName) {
  const stateFile = path.join(DB_DIR, `conv-mode-${sessionName}.json`);
  if (!fs.existsSync(stateFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return data.active ? data : null;
  } catch {
    return null;
  }
}

function deleteStateFile(sessionName) {
  const stateFile = path.join(DB_DIR, `conv-mode-${sessionName}.json`);
  try { fs.unlinkSync(stateFile); } catch { /* ok */ }
}

function updateConvState(sessionName, updates) {
  const stateFile = path.join(DB_DIR, `conv-mode-${sessionName}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    Object.assign(data, updates);
    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
  } catch { /* non-critical */ }
}

function isExpired(state) {
  if (!state.expires_at) return false;
  return new Date(state.expires_at) < new Date();
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
    if (parsed.cwd) {
      sessionName = path.basename(parsed.cwd);
    }
  }
} catch {
  // No stdin or not JSON
}

// ─── Guard: No DB or no session ──────────────────────────────────────────────

if (!sessionName || !fs.existsSync(DB_PATH)) {
  process.exit(0);
}

let Database;
try {
  Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
} catch {
  process.exit(0);
}

// ─── Check conversation state ────────────────────────────────────────────────

const convState = readConvState(sessionName);
if (!convState) {
  // Not in conversation mode — let Stop proceed normally
  process.exit(0);
}

// Check if partner ended the conversation
// Even if ended, deliver any unread partner messages first
if (convState.ended_by) {
  let unreadLines = [];
  try {
    const db = new Database(DB_PATH, { readonly: true, timeout: 3000 });
    const convStartedAt = convState.started_at || "1970-01-01T00:00:00Z";
    const rows = db.prepare(`
      SELECT message_id, session_id, subject, body, created_at
      FROM coordination_messages
      WHERE status IN ('pending', 'acknowledged') AND session_id = ?
        AND (subject LIKE '[conv]%')
        AND created_at >= ?
      ORDER BY created_at ASC
      LIMIT 5
    `).all(convState.ended_by, convStartedAt.replace("T", " ").replace("Z", "").slice(0, 19));
    db.close();

    if (rows.length > 0) {
      unreadLines.push(`[conv] Unread message(s) from ${convState.ended_by}:`);
      for (const r of rows) {
        unreadLines.push(`  ${r.subject}`);
        const body = truncateBody(r.body);
        if (body) {
          for (const bline of body.split("\n")) {
            unreadLines.push(`  ${bline}`);
          }
        }
        unreadLines.push(`  [message_id: ${r.message_id}]`);
      }
      unreadLines.push("");
    }
  } catch { /* DB read failed — proceed with end notice */ }

  const endNotice = `[conv] ${convState.ended_by} ended the conversation.\n\n` +
    `Call coord_conv_end(session_id="${convState.session_id}", summary="...") to save your summary.`;

  const output = JSON.stringify({
    decision: "block",
    reason: unreadLines.length > 0
      ? unreadLines.join("\n") + "\n" + endNotice
      : endNotice,
  });
  deleteStateFile(sessionName);
  process.stdout.write(output);
  process.exit(0);
}

// Check expiry
if (isExpired(convState)) {
  deleteStateFile(sessionName);
  process.exit(0);
}

// Check max turns
if (convState.turn_count >= (convState.max_turns || 20)) {
  // Output a friendly termination notice, then let Stop proceed
  const output = JSON.stringify({
    decision: "block",
    reason: `[conv] Max turns (${convState.max_turns || 20}) reached. Conversation auto-ending.\n\n` +
      `Call coord_conv_end(session_id="${convState.session_id}", summary="...") to save a summary.`,
  });
  process.stdout.write(output);
  process.exit(0);
}

// ─── Poll for partner messages ───────────────────────────────────────────────

const POLL_INTERVAL = 3000; // 3 seconds
const MAX_WAIT = 15000;     // 15 seconds total

async function pollForMessages() {
  const startTime = Date.now();
  let currentPartner = convState.partner; // may be null if room just created

  while (true) {
    // Re-read state file to pick up partner changes (e.g. joiner updated it)
    const freshState = readConvState(sessionName);
    if (!freshState) {
      process.exit(0);
    }
    // Check if partner ended while we were polling
    if (freshState.ended_by) {
      const output = JSON.stringify({
        decision: "block",
        reason: `[conv] ${freshState.ended_by} ended the conversation.\n\n` +
          `Call coord_conv_end(session_id="${freshState.session_id}", summary="...") to save your summary.`,
      });
      deleteStateFile(sessionName);
      process.stdout.write(output);
      process.exit(0);
    }
    if (isExpired(freshState)) {
      deleteStateFile(sessionName);
      process.exit(0);
    }
    currentPartner = freshState.partner;

    // If we still don't have a partner, keep polling (waiting for join)
    if (currentPartner) {
      let db;
      try {
        db = new Database(DB_PATH, { readonly: true, timeout: 3000 });
      } catch (e) {
        debugLog(`DB open failed: ${e.message}`);
        process.exit(0);
      }

      try {
        // Only fetch messages created AFTER this conversation started
        const convStartedAt = freshState.started_at || "1970-01-01T00:00:00Z";
        const startedAtFormatted = convStartedAt.replace("T", " ").replace("Z", "").slice(0, 19);
        debugLog(`[${sessionName}] polling partner=${currentPartner} started_at>=${startedAtFormatted}`);
        const rows = db.prepare(`
          SELECT message_id, session_id, project, message_type, subject, body, ref_message_id, created_at
          FROM coordination_messages
          WHERE status = 'pending' AND session_id = ?
            AND created_at >= ?
          ORDER BY created_at ASC
          LIMIT 5
        `).all(currentPartner, startedAtFormatted);

        debugLog(`[${sessionName}] found ${rows.length} messages`);
        if (rows.length > 0) {
          debugLog(`[${sessionName}] first msg: ${rows[0].message_id} subject=${rows[0].subject}`);
          // Found partner messages — build reinject payload
          const newTurnCount = freshState.turn_count + 1;
          const lastMsg = rows[rows.length - 1];

          const lines = [];
          lines.push(`[conv] ${currentPartner} (${timeAgo(lastMsg.created_at)}):`);

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
          lines.push(`\u2192 coord_reply(message_id="${lastMsg.message_id}", session_id="${freshState.session_id}", body={...})`);
          lines.push(`\u2192 coord_conv_end(session_id="${freshState.session_id}", summary="...")`);

          const output = JSON.stringify({
            decision: "block",
            reason: lines.join("\n"),
            systemMessage: `[conv] Turn ${newTurnCount} | ${freshState.session_id} \u2194 ${currentPartner} | ${freshState.topic}`,
          });

          // Update turn count
          updateConvState(sessionName, {
            turn_count: newTurnCount,
            last_message_id: lastMsg.message_id,
          });

          process.stdout.write(output);
          db.close();
          process.exit(0);
        }

        db.close();
      } catch {
        try { db.close(); } catch { /* ok */ }
      }
    }

    // Check if we've exceeded max wait per poll cycle
    const elapsed = Date.now() - startTime;
    if (elapsed >= MAX_WAIT) {
      // Re-read state — check TTL expiry as the only exit condition
      const latestState = readConvState(sessionName);
      if (!latestState) {
        process.exit(0); // conversation ended externally
      }
      if (isExpired(latestState)) {
        deleteStateFile(sessionName);
        process.exit(0);
      }
      if (latestState.ended_by) {
        // Partner ended while we were polling — handled at top of next cycle
        process.exit(0);
      }

      // Conversation still active — re-block to keep polling
      const waitPolls = (latestState.wait_polls || 0) + 1;
      updateConvState(sessionName, { wait_polls: waitPolls });
      const label = latestState.turn_count === 0
        ? `Waiting for partner's first message... (poll ${waitPolls})`
        : `Waiting for partner's response... (poll ${waitPolls})`;
      const output = JSON.stringify({
        decision: "block",
        reason: `[conv-wait] ${label}`,
      });
      process.stdout.write(output);
      process.exit(0);
    }

    // Wait before next poll
    await sleep(POLL_INTERVAL);
  }
}

pollForMessages().catch(() => process.exit(0));
