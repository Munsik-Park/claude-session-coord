#!/usr/bin/env node
/**
 * claude-session-coord MCP Server
 *
 * SQLite-backed inter-session coordination for Claude Code.
 * Provides 8 tools: coord_post, coord_board, coord_check, coord_ack, coord_reply, coord_history,
 *                    coord_conv_start, coord_conv_end
 *
 * Protocol: stdio (JSON-RPC via stdin/stdout)
 * Storage:  ~/.claude/coordination/coord.db (SQLite WAL mode)
 */

// ─── Console protection (stdout = MCP JSON-RPC, must not be polluted) ────────
const _origLog = console.log;
console.log = (...args) => console.error("[session-coord]", ...args);

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");

// ─── Database setup ──────────────────────────────────────────────────────────

const DB_DIR = path.join(os.homedir(), ".claude", "coordination");
fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, "coord.db");
const db = new Database(DB_PATH, { timeout: 5000 });
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS coordination_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id      TEXT UNIQUE NOT NULL,
    session_id      TEXT NOT NULL,
    project         TEXT NOT NULL DEFAULT '',
    message_type    TEXT NOT NULL CHECK (message_type IN
                      ('role_claim','status_update','handoff','ack','request','info')),
    subject         TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '{}',
    ref_message_id  TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','acknowledged','completed','expired')),
    expires_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cm_session   ON coordination_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_cm_project   ON coordination_messages(project);
  CREATE INDEX IF NOT EXISTS idx_cm_status    ON coordination_messages(status);
  CREATE INDEX IF NOT EXISTS idx_cm_type      ON coordination_messages(message_type);
  CREATE INDEX IF NOT EXISTS idx_cm_created   ON coordination_messages(created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_cm_room ON coordination_messages(room_code);

  CREATE TABLE IF NOT EXISTS conversations (
    session_id TEXT PRIMARY KEY,
    partner TEXT,
    room_code TEXT,
    topic TEXT DEFAULT '',
    started_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrations
try {
  db.prepare("SELECT room_code FROM coordination_messages LIMIT 0").run();
} catch {
  db.exec("ALTER TABLE coordination_messages ADD COLUMN room_code TEXT");
}
try {
  db.prepare("SELECT last_poll_at FROM conversations LIMIT 0").run();
} catch {
  db.exec("ALTER TABLE conversations ADD COLUMN last_poll_at TEXT");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genMessageId() {
  return "coord-" + randomUUID().slice(0, 8);
}

function timeAgo(isoDate) {
  if (!isoDate) return "";
  const diff = Date.now() - new Date(isoDate + "Z").getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function err(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "coord_post",
    description:
      "Post a coordination message to other sessions. Use when completing work that affects other concurrent sessions.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Identifier for the sending session (e.g. 'ontology-evolution', 'data-crawling')",
        },
        message_type: {
          type: "string",
          enum: ["role_claim", "status_update", "handoff", "ack", "request", "info"],
          description:
            "Message type: handoff (schema/interface change), info (FYI), request (action needed), role_claim (area ownership), status_update (progress), ack (acknowledgment)",
        },
        subject: {
          type: "string",
          description: "Brief subject line describing the message",
        },
        body: {
          type: "object",
          description: "Structured payload (JSON object with details)",
          additionalProperties: true,
        },
        project: {
          type: "string",
          description: "Project scope filter (e.g. 'ontology-ticket'). Empty string = global.",
        },
        ref_message_id: {
          type: "string",
          description: "Reference to a previous message_id (for threading)",
        },
        expires_at: {
          type: "string",
          description: "ISO 8601 expiration datetime (optional)",
        },
      },
      required: ["session_id", "message_type", "subject"],
    },
  },
  {
    name: "coord_board",
    description:
      "Dashboard view: session counts + pending messages. Call at session start to see what needs attention.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Filter by project (optional)",
        },
      },
    },
  },
  {
    name: "coord_check",
    description: "Check pending messages, optionally filtered by session, type, or project.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Filter by sender session" },
        message_type: {
          type: "string",
          enum: ["role_claim", "status_update", "handoff", "ack", "request", "info"],
          description: "Filter by message type",
        },
        project: { type: "string", description: "Filter by project" },
        limit: { type: "integer", description: "Max results (default 20)", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "coord_ack",
    description:
      "Acknowledge a message (mark as acknowledged) and optionally post a reply.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The message_id to acknowledge",
        },
        ack_session_id: {
          type: "string",
          description: "Session acknowledging the message",
        },
        ack_note: {
          type: "string",
          description: "Optional note to include in the ack reply",
        },
      },
      required: ["message_id", "ack_session_id"],
    },
  },
  {
    name: "coord_reply",
    description:
      "Reply to a coordination message. Acknowledges the original and posts a response in one step. Use for AI-to-AI conversations.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The message_id to reply to (required)",
        },
        session_id: {
          type: "string",
          description: "Your session identifier (required)",
        },
        body: {
          type: "object",
          description: "Structured reply payload (JSON object)",
          additionalProperties: true,
        },
        subject: {
          type: "string",
          description: "Override subject (defaults to 'RE: <original subject>')",
        },
      },
      required: ["message_id", "session_id"],
    },
  },
  {
    name: "coord_history",
    description: "Browse full message history with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project" },
        session_id: { type: "string", description: "Filter by session" },
        message_type: {
          type: "string",
          enum: ["role_claim", "status_update", "handoff", "ack", "request", "info"],
        },
        status: {
          type: "string",
          enum: ["pending", "acknowledged", "completed", "expired"],
        },
        limit: { type: "integer", description: "Max results (default 50)", minimum: 1, maximum: 200 },
        offset: { type: "integer", description: "Offset for pagination", minimum: 0 },
      },
    },
  },
  {
    name: "coord_conv_start",
    description:
      "Start or join an AI-to-AI conversation room. Use mode='create' to create a new room, mode='join' to join an existing room by code.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["create", "join"],
          description: "create = new room, join = join existing room by code",
        },
        session_id: {
          type: "string",
          description: "Your session identifier (e.g. 'ontology-ticket')",
        },
        topic: {
          type: "string",
          description: "Conversation topic (optional)",
        },
        room_code: {
          type: "string",
          description: "Room code to join (required for mode='join')",
        },
      },
      required: ["mode", "session_id"],
    },
  },
  {
    name: "coord_conv_end",
    description:
      "End a conversation mode. Acknowledges remaining pending messages from partner and optionally posts a summary.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Your session identifier",
        },
        summary: {
          type: "string",
          description: "Optional summary of what was discussed/decided",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "coord_wait_for_reply",
    description:
      "Wait for partner's reply in conversation mode. Polls DB for up to timeout seconds. Returns partner message when found, or timeout notice. Use this after sending a message to wait for the partner's response.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Your session identifier (e.g. 'ontology-ticket')",
        },
        timeout: {
          type: "integer",
          description: "Max wait time in seconds (default 60, max 120)",
          minimum: 5,
          maximum: 120,
        },
      },
      required: ["session_id"],
    },
  },
];

// ─── Tool handlers ───────────────────────────────────────────────────────────

function handleCoordPost(args) {
  const { session_id, message_type, subject, body, project, ref_message_id, expires_at } = args;
  if (!session_id || !message_type || !subject) {
    return err("session_id, message_type, and subject are required");
  }

  const messageId = genMessageId();
  const bodyJson = JSON.stringify(body || {});
  const proj = project || "";

  // Auto-attach room_code if in conversation mode
  const conv = db.prepare("SELECT room_code FROM conversations WHERE session_id = ?").get(session_id);
  const roomCode = conv ? conv.room_code : null;

  const stmt = db.prepare(`
    INSERT INTO coordination_messages
      (message_id, session_id, project, message_type, subject, body, ref_message_id, expires_at, room_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(messageId, session_id, proj, message_type, subject, bodyJson, ref_message_id || null, expires_at || null, roomCode);

  return ok(JSON.stringify({
    message_id: messageId,
    status: "pending",
    message: `Message posted: [${message_type}] ${subject}`,
  }, null, 2));
}

function handleCoordBoard(args) {
  const { project } = args || {};

  // Session counts
  let countQuery = `
    SELECT session_id, status, COUNT(*) as cnt
    FROM coordination_messages
  `;
  const countParams = [];
  if (project) {
    countQuery += " WHERE project = ?";
    countParams.push(project);
  }
  countQuery += " GROUP BY session_id, status ORDER BY session_id";

  const counts = db.prepare(countQuery).all(...countParams);

  // Pending messages
  let pendingQuery = `
    SELECT message_id, session_id, project, message_type, subject, created_at
    FROM coordination_messages
    WHERE status = 'pending'
  `;
  const pendingParams = [];
  if (project) {
    pendingQuery += " AND project = ?";
    pendingParams.push(project);
  }
  pendingQuery += " ORDER BY created_at DESC LIMIT 20";

  const pending = db.prepare(pendingQuery).all(...pendingParams);

  // Format output
  const lines = [];
  lines.push("=== Coordination Board ===");

  if (project) lines.push(`Project: ${project}`);
  lines.push("");

  // Session summary
  const sessions = {};
  for (const row of counts) {
    if (!sessions[row.session_id]) sessions[row.session_id] = {};
    sessions[row.session_id][row.status] = row.cnt;
  }

  if (Object.keys(sessions).length === 0) {
    lines.push("No messages yet.");
  } else {
    lines.push("Sessions:");
    for (const [sid, statuses] of Object.entries(sessions)) {
      const parts = Object.entries(statuses).map(([s, c]) => `${s}:${c}`);
      lines.push(`  ${sid}: ${parts.join(", ")}`);
    }
  }

  lines.push("");

  if (pending.length === 0) {
    lines.push("No pending messages.");
  } else {
    lines.push(`Pending (${pending.length}):`);
    for (const msg of pending) {
      const ago = timeAgo(msg.created_at);
      const proj = msg.project ? ` [${msg.project}]` : "";
      lines.push(`  ${msg.message_id} | ${msg.message_type} | from ${msg.session_id}${proj}`);
      lines.push(`    "${msg.subject}" (${ago})`);
    }
  }

  return ok(lines.join("\n"));
}

function handleCoordCheck(args) {
  const { session_id, message_type, project, limit } = args || {};

  let query = "SELECT * FROM coordination_messages WHERE status = 'pending'";
  const params = [];

  if (session_id) {
    query += " AND session_id = ?";
    params.push(session_id);
  }
  if (message_type) {
    query += " AND message_type = ?";
    params.push(message_type);
  }
  if (project) {
    query += " AND project = ?";
    params.push(project);
  }

  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit || 20);

  const rows = db.prepare(query).all(...params);

  if (rows.length === 0) {
    return ok("No pending messages found.");
  }

  const results = rows.map((r) => ({
    message_id: r.message_id,
    session_id: r.session_id,
    project: r.project || undefined,
    message_type: r.message_type,
    subject: r.subject,
    body: JSON.parse(r.body || "{}"),
    ref_message_id: r.ref_message_id || undefined,
    created_at: r.created_at,
    age: timeAgo(r.created_at),
  }));

  return ok(JSON.stringify(results, null, 2));
}

function handleCoordAck(args) {
  const { message_id, ack_session_id, ack_note } = args;
  if (!message_id || !ack_session_id) {
    return err("message_id and ack_session_id are required");
  }

  // Find the original message
  const original = db.prepare(
    "SELECT * FROM coordination_messages WHERE message_id = ?"
  ).get(message_id);

  if (!original) {
    return err(`Message not found: ${message_id}`);
  }

  if (original.status !== "pending") {
    return err(`Message already ${original.status}: ${message_id}`);
  }

  // Update status
  db.prepare(
    "UPDATE coordination_messages SET status = 'acknowledged', updated_at = datetime('now') WHERE message_id = ?"
  ).run(message_id);

  // Post ack reply
  const ackId = genMessageId();
  const ackBody = JSON.stringify({
    original_message_id: message_id,
    original_subject: original.subject,
    note: ack_note || "Acknowledged",
  });

  db.prepare(`
    INSERT INTO coordination_messages
      (message_id, session_id, project, message_type, subject, body, ref_message_id, status)
    VALUES (?, ?, ?, 'ack', ?, ?, ?, 'completed')
  `).run(
    ackId,
    ack_session_id,
    original.project || "",
    `ACK: ${original.subject}`,
    ackBody,
    message_id
  );

  return ok(JSON.stringify({
    acknowledged: message_id,
    ack_message_id: ackId,
    message: `Acknowledged: "${original.subject}" from ${original.session_id}`,
  }, null, 2));
}

function handleCoordReply(args) {
  const { message_id, session_id, body, subject } = args;
  if (!message_id || !session_id) {
    return err("message_id and session_id are required");
  }

  // Find the original message
  const original = db.prepare(
    "SELECT * FROM coordination_messages WHERE message_id = ?"
  ).get(message_id);

  if (!original) {
    return err(`Message not found: ${message_id}`);
  }

  // Step 1: Acknowledge the original (only if still pending)
  if (original.status === "pending") {
    db.prepare(
      "UPDATE coordination_messages SET status = 'acknowledged', updated_at = datetime('now') WHERE message_id = ?"
    ).run(message_id);
  }

  // Step 2: Post the reply as a new pending message
  const replyId = genMessageId();
  const replySubject = subject || `RE: ${original.subject}`;
  const replyBody = JSON.stringify(body || {});

  // Inherit room_code from original message or current conversation
  const conv = db.prepare("SELECT room_code FROM conversations WHERE session_id = ?").get(session_id);
  const roomCode = original.room_code || (conv ? conv.room_code : null);

  db.prepare(`
    INSERT INTO coordination_messages
      (message_id, session_id, project, message_type, subject, body, ref_message_id, status, room_code)
    VALUES (?, ?, ?, 'request', ?, ?, ?, 'pending', ?)
  `).run(
    replyId,
    session_id,
    original.project || "",
    replySubject,
    replyBody,
    message_id,
    roomCode
  );

  return ok(JSON.stringify({
    acknowledged: message_id,
    reply_message_id: replyId,
    subject: replySubject,
    message: `Replied to "${original.subject}" from ${original.session_id}`,
  }, null, 2));
}

function handleCoordHistory(args) {
  const { project, session_id, message_type, status, limit, offset } = args || {};

  let query = "SELECT * FROM coordination_messages WHERE 1=1";
  const params = [];

  if (project) {
    query += " AND project = ?";
    params.push(project);
  }
  if (session_id) {
    query += " AND session_id = ?";
    params.push(session_id);
  }
  if (message_type) {
    query += " AND message_type = ?";
    params.push(message_type);
  }
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }

  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit || 50);
  params.push(offset || 0);

  const rows = db.prepare(query).all(...params);

  const results = rows.map((r) => ({
    message_id: r.message_id,
    session_id: r.session_id,
    project: r.project || undefined,
    message_type: r.message_type,
    subject: r.subject,
    body: JSON.parse(r.body || "{}"),
    status: r.status,
    ref_message_id: r.ref_message_id || undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return ok(JSON.stringify({
    count: results.length,
    messages: results,
  }, null, 2));
}

// ─── Conversation mode (DB-backed) ──────────────────────────────────────────

function handleCoordConvStart(args) {
  const { mode, session_id, topic, room_code } = args;
  if (!mode || !session_id) {
    return err("mode and session_id are required");
  }

  // Check for existing active conversation
  const existing = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(session_id);
  if (existing) {
    return err(`Already in conversation mode with ${existing.partner || "unknown"}. End it first with coord_conv_end.`);
  }

  if (mode === "create") {
    const code = "conv-" + randomUUID().slice(0, 4);

    db.prepare(
      "INSERT INTO conversations (session_id, room_code, topic) VALUES (?, ?, ?)"
    ).run(session_id, code, topic || "");

    return ok(JSON.stringify({
      status: "waiting_for_partner",
      room_code: code,
      session_id,
      message: `Room created: ${code}. Tell the other session to run: /start-conv ${code}`,
    }, null, 2));
  }

  if (mode === "join") {
    if (!room_code) {
      return err("room_code is required for join mode");
    }

    // Find the creator by room_code
    const creator = db.prepare(
      "SELECT * FROM conversations WHERE room_code = ?"
    ).get(room_code);

    if (!creator) {
      return err(`Room not found: ${room_code}. It may have been deleted.`);
    }

    const convTopic = topic || creator.topic || "";

    // Update creator's partner
    db.prepare(
      "UPDATE conversations SET partner = ?, topic = ? WHERE session_id = ?"
    ).run(session_id, convTopic, creator.session_id);

    // Insert joiner row (use creator's started_at as baseline for message filtering)
    db.prepare(
      "INSERT INTO conversations (session_id, partner, room_code, topic, started_at) VALUES (?, ?, ?, ?, ?)"
    ).run(session_id, creator.session_id, room_code, convTopic, creator.started_at);

    // Clean up stale pending [conv] messages from BEFORE this room was created
    try {
      const stale = db.prepare(`
        SELECT message_id FROM coordination_messages
        WHERE status = 'pending'
          AND subject LIKE '[conv]%'
          AND (session_id = ? OR session_id = ?)
          AND created_at < ?
      `).all(session_id, creator.session_id, creator.started_at);
      for (const row of stale) {
        db.prepare(
          "UPDATE coordination_messages SET status = 'acknowledged', updated_at = datetime('now') WHERE message_id = ?"
        ).run(row.message_id);
      }
    } catch { /* non-critical */ }

    return ok(JSON.stringify({
      status: "connected",
      room_code,
      partner: creator.session_id,
      topic: convTopic,
      message: `Joined room ${room_code}. Connected with ${creator.session_id}. Waiting for user direction to start conversation.`,
    }, null, 2));
  }

  return err(`Unknown mode: ${mode}. Use 'create' or 'join'.`);
}

function handleCoordConvEnd(args) {
  const { session_id, summary } = args;
  if (!session_id) {
    return err("session_id is required");
  }

  const conv = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(session_id);
  if (!conv) {
    return err(`No active conversation for ${session_id}`);
  }

  const partner = conv.partner;

  // Acknowledge incoming pending [conv] messages from partner
  let pendingAcked = 0;
  if (partner) {
    const incoming = db.prepare(`
      SELECT message_id FROM coordination_messages
      WHERE status = 'pending' AND session_id = ?
        AND (subject LIKE '[conv]%' OR subject LIKE '[conv-end]%')
    `).all(partner);

    for (const row of incoming) {
      db.prepare(
        "UPDATE coordination_messages SET status = 'acknowledged', updated_at = datetime('now') WHERE message_id = ?"
      ).run(row.message_id);
    }
    pendingAcked = incoming.length;
  }

  // Post [conv-end] so partner's Stop hook can detect it
  const endMessageId = genMessageId();
  const endBody = JSON.stringify({
    type: "conversation_end",
    topic: conv.topic,
    partner,
    summary: summary || null,
  });
  db.prepare(`
    INSERT INTO coordination_messages
      (message_id, session_id, project, message_type, subject, body, status, room_code)
    VALUES (?, ?, '', 'info', ?, ?, 'pending', ?)
  `).run(endMessageId, session_id, `[conv-end] ${conv.topic}`, endBody, conv.room_code);

  // Delete own row from conversations (partner's row stays — their hook detects [conv-end])
  db.prepare("DELETE FROM conversations WHERE session_id = ?").run(session_id);

  return ok(JSON.stringify({
    status: "conversation_ended",
    session_id,
    partner,
    topic: conv.topic,
    pending_acked: pendingAcked,
    end_message_id: endMessageId,
    message: `Conversation with ${partner || "unknown"} ended. ${pendingAcked} pending message(s) acknowledged.`,
  }, null, 2));
}

// ─── coord_wait_for_reply ─────────────────────────────────────────────────

async function handleCoordWaitForReply(args) {
  const { session_id, timeout } = args;
  if (!session_id) {
    return err("session_id is required");
  }

  const conv = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(session_id);
  if (!conv) {
    return err(`No active conversation for ${session_id}`);
  }

  const maxWait = Math.min((timeout || 5), 120) * 1000;
  const pollInterval = 3000;
  const roomCode = conv.room_code;
  const startTime = Date.now();

  // Mark polling active so Stop hook skips duplicate detection
  db.prepare("UPDATE conversations SET last_poll_at = datetime('now') WHERE session_id = ?").run(session_id);

  // First check (instant, no sleep)
  const checkOnce = (partner) => {
    if (!partner) return null;

    // Check for [conv-end]
    const endMsg = db.prepare(`
      SELECT message_id, session_id, subject, body, created_at
      FROM coordination_messages
      WHERE status = 'pending' AND session_id = ?
        AND subject LIKE '[conv-end]%'
        AND room_code = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(partner, roomCode);

    if (endMsg) {
      return { status: "partner_ended", partner, message: `${partner} ended the conversation.`, message_id: endMsg.message_id, body: endMsg.body };
    }

    // Check for [conv] messages
    const rows = db.prepare(`
      SELECT message_id, session_id, subject, body, created_at
      FROM coordination_messages
      WHERE status = 'pending' AND session_id = ?
        AND subject LIKE '[conv]%'
        AND room_code = ?
      ORDER BY created_at ASC LIMIT 5
    `).all(partner, roomCode);

    if (rows.length > 0) {
      const lastMsg = rows[rows.length - 1];
      const messages = rows.map(r => ({ message_id: r.message_id, subject: r.subject, body: r.body, created_at: r.created_at, age: timeAgo(r.created_at) }));
      return { status: "message_received", partner, messages, reply_to: lastMsg.message_id, hint: `Use coord_reply(message_id="${lastMsg.message_id}", session_id="${session_id}", ...) to respond.` };
    }

    return null;
  };

  // Immediate first check (no sleep)
  {
    const current = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(session_id);
    const partner = current ? current.partner : null;
    const result = checkOnce(partner);
    if (result) return ok(JSON.stringify(result, null, 2));
  }

  // Poll loop with sleep
  while (Date.now() - startTime < maxWait) {
    const remaining = maxWait - (Date.now() - startTime);
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, remaining)));

    const current = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(session_id);
    const partner = current ? current.partner : null;
    const result = checkOnce(partner);
    if (result) return ok(JSON.stringify(result, null, 2));
  }

  // Timeout
  const finalConv = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(session_id);
  const partner = finalConv ? finalConv.partner : null;
  return ok(JSON.stringify({
    status: "timeout",
    partner: partner || "none",
    waited_seconds: Math.round((Date.now() - startTime) / 1000),
    message: `No reply within ${Math.round(maxWait / 1000)}s. Call again to keep waiting.`,
  }, null, 2));
}

// ─── Tool dispatcher ─────────────────────────────────────────────────────────

const HANDLER_MAP = {
  coord_post: handleCoordPost,
  coord_board: handleCoordBoard,
  coord_check: handleCoordCheck,
  coord_ack: handleCoordAck,
  coord_reply: handleCoordReply,
  coord_history: handleCoordHistory,
  coord_conv_start: handleCoordConvStart,
  coord_conv_end: handleCoordConvEnd,
  coord_wait_for_reply: handleCoordWaitForReply,
};

// ─── MCP Server setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: "session-coord", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLER_MAP[name];
  if (!handler) {
    return err(`Unknown tool: ${name}`);
  }
  try {
    return await handler(args || {});
  } catch (error) {
    console.error(`Tool error [${name}]:`, error);
    return err(error.message);
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[session-coord] MCP server started (SQLite:", DB_PATH, ")");

  const cleanup = () => {
    try { db.close(); } catch (_) {}
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

main().catch((error) => {
  console.error("[session-coord] Fatal:", error);
  process.exit(1);
});
