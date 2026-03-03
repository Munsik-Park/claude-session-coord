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
`);

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
          description: "Conversation topic (create: optional, join: optional)",
        },
        project: {
          type: "string",
          description: "Project scope (optional)",
        },
        room_code: {
          type: "string",
          description: "Room code to join (required for mode='join')",
        },
        max_turns: {
          type: "integer",
          description: "Max conversation turns (default 20)",
          minimum: 2,
          maximum: 100,
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

  const stmt = db.prepare(`
    INSERT INTO coordination_messages
      (message_id, session_id, project, message_type, subject, body, ref_message_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(messageId, session_id, proj, message_type, subject, bodyJson, ref_message_id || null, expires_at || null);

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

  db.prepare(`
    INSERT INTO coordination_messages
      (message_id, session_id, project, message_type, subject, body, ref_message_id, status)
    VALUES (?, ?, ?, 'request', ?, ?, ?, 'pending')
  `).run(
    replyId,
    session_id,
    original.project || "",
    replySubject,
    replyBody,
    message_id
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

// ─── Conversation mode helpers ───────────────────────────────────────────────

function convStateFile(sessionId) {
  return path.join(DB_DIR, `conv-mode-${sessionId}.json`);
}

function readConvState(sessionId) {
  const p = convStateFile(sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return data.active ? data : null;
  } catch {
    return null;
  }
}

function convRoomFile(code) {
  return path.join(DB_DIR, `conv-room-${code}.json`);
}

function handleCoordConvStart(args) {
  const { mode, session_id, topic, project, room_code, max_turns } = args;
  if (!mode || !session_id) {
    return err("mode and session_id are required");
  }

  // Check for existing active conversation
  const existing = readConvState(session_id);
  if (existing) {
    return err(`Already in conversation mode with ${existing.partner}. End it first with coord_conv_end.`);
  }

  const maxT = max_turns || 20;
  const proj = project || "";
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  if (mode === "create") {
    // Generate short room code
    const code = "conv-" + randomUUID().slice(0, 4);

    // Create room file
    const room = {
      code,
      creator: session_id,
      topic: topic || "",
      project: proj,
      max_turns: maxT,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    };
    fs.writeFileSync(convRoomFile(code), JSON.stringify(room, null, 2));

    // Create creator's state file (partner unknown yet)
    const state = {
      active: true,
      session_id,
      partner: null,
      room_code: code,
      project: proj,
      topic: topic || "",
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
      turn_count: 0,
      max_turns: maxT,
      last_message_id: null,
    };
    fs.writeFileSync(convStateFile(session_id), JSON.stringify(state, null, 2));

    return ok(JSON.stringify({
      status: "waiting_for_partner",
      room_code: code,
      session_id,
      max_turns: maxT,
      expires_at: expiresAt,
      message: `Room created: ${code}. Tell the other session to run: /start-conv ${code}`,
    }, null, 2));
  }

  if (mode === "join") {
    if (!room_code) {
      return err("room_code is required for join mode");
    }

    // Read room file
    const roomPath = convRoomFile(room_code);
    if (!fs.existsSync(roomPath)) {
      return err(`Room not found: ${room_code}. It may have expired or been deleted.`);
    }

    let room;
    try {
      room = JSON.parse(fs.readFileSync(roomPath, "utf8"));
    } catch {
      return err(`Failed to read room file: ${room_code}`);
    }

    // Check room expiry
    if (room.expires_at && new Date(room.expires_at) < new Date()) {
      try { fs.unlinkSync(roomPath); } catch { /* ok */ }
      return err(`Room ${room_code} has expired.`);
    }

    const creator = room.creator;
    const convTopic = topic || room.topic || "";
    const convProject = project || room.project || "";

    // Update room file with joiner info
    room.joiner = session_id;
    room.joined_at = new Date().toISOString();
    if (topic) room.topic = topic;
    fs.writeFileSync(roomPath, JSON.stringify(room, null, 2));

    // Create joiner's state file
    const joinerState = {
      active: true,
      session_id,
      partner: creator,
      room_code,
      project: convProject,
      topic: convTopic,
      started_at: new Date().toISOString(),
      expires_at: room.expires_at,
      turn_count: 0,
      max_turns: room.max_turns || maxT,
      last_message_id: null,
    };
    fs.writeFileSync(convStateFile(session_id), JSON.stringify(joinerState, null, 2));

    // Update creator's state file with partner info
    const creatorStatePath = convStateFile(creator);
    if (fs.existsSync(creatorStatePath)) {
      try {
        const creatorState = JSON.parse(fs.readFileSync(creatorStatePath, "utf8"));
        creatorState.partner = session_id;
        if (convTopic) creatorState.topic = convTopic;
        fs.writeFileSync(creatorStatePath, JSON.stringify(creatorState, null, 2));
      } catch { /* non-critical */ }
    }

    // Clean up stale pending messages between the two sessions
    try {
      const stale = db.prepare(`
        SELECT message_id FROM coordination_messages
        WHERE status = 'pending'
          AND subject LIKE '[conv]%'
          AND (session_id = ? OR session_id = ?)
      `).all(session_id, creator);
      for (const row of stale) {
        db.prepare(
          "UPDATE coordination_messages SET status = 'acknowledged', updated_at = datetime('now') WHERE message_id = ?"
        ).run(row.message_id);
      }
    } catch { /* non-critical */ }

    // No auto-message on join — both sides wait for user direction
    return ok(JSON.stringify({
      status: "connected",
      room_code,
      partner: creator,
      topic: convTopic,
      message: `Joined room ${room_code}. Connected with ${creator}. Waiting for user direction to start conversation.`,
    }, null, 2));
  }

  return err(`Unknown mode: ${mode}. Use 'create' or 'join'.`);
}

function handleCoordConvEnd(args) {
  const { session_id, summary } = args;
  if (!session_id) {
    return err("session_id is required");
  }

  const state = readConvState(session_id);
  if (!state) {
    return err(`No active conversation for ${session_id}`);
  }

  const partner = state.partner;

  // Acknowledge all remaining pending [conv] messages from BOTH sides
  let pendingAcked = 0;
  const sessionsToClean = [session_id];
  if (partner) sessionsToClean.push(partner);

  for (const sid of sessionsToClean) {
    const pending = db.prepare(`
      SELECT message_id FROM coordination_messages
      WHERE status = 'pending' AND session_id = ?
        AND (subject LIKE '[conv]%' OR subject LIKE '[conv-end]%')
    `).all(sid);

    for (const row of pending) {
      db.prepare(
        "UPDATE coordination_messages SET status = 'acknowledged', updated_at = datetime('now') WHERE message_id = ?"
      ).run(row.message_id);
    }
    pendingAcked += pending.length;
  }

  // Post [conv-end] as PENDING so partner's Stop hook can detect it
  const endMessageId = genMessageId();
  const endBody = JSON.stringify({
    type: "conversation_end",
    topic: state.topic,
    partner: partner,
    turn_count: state.turn_count,
    summary: summary || null,
  });
  db.prepare(`
    INSERT INTO coordination_messages
      (message_id, session_id, project, message_type, subject, body, ref_message_id, status)
    VALUES (?, ?, ?, 'info', ?, ?, ?, 'pending')
  `).run(
    endMessageId,
    session_id,
    state.project || "",
    `[conv-end] ${state.topic}`,
    endBody,
    state.last_message_id
  );

  // Delete own state file
  try { fs.unlinkSync(convStateFile(session_id)); } catch { /* ok */ }

  // Mark partner's state as ended (don't delete — let their hook detect it)
  if (partner) {
    const partnerStatePath = convStateFile(partner);
    if (fs.existsSync(partnerStatePath)) {
      try {
        const partnerState = JSON.parse(fs.readFileSync(partnerStatePath, "utf8"));
        partnerState.ended_by = session_id;
        fs.writeFileSync(partnerStatePath, JSON.stringify(partnerState, null, 2));
      } catch { /* non-critical — delete as fallback */ }
    }
  }

  // Delete room file
  if (state.room_code) {
    try { fs.unlinkSync(convRoomFile(state.room_code)); } catch { /* ok */ }
  }

  return ok(JSON.stringify({
    status: "conversation_ended",
    session_id,
    partner,
    topic: state.topic,
    turns: state.turn_count,
    pending_acked: pendingAcked,
    end_message_id: endMessageId,
    message: `Conversation with ${partner || "unknown"} ended. ${pendingAcked} pending message(s) acknowledged.`,
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
    return handler(args || {});
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
