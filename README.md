# claude-session-coord

Inter-session coordination plugin for [Claude Code](https://claude.ai/code).

Multiple Claude Code sessions can exchange messages — handoffs, status updates, and requests — through a shared SQLite DB.

## How It Works

```
Session A                    SQLite DB                    Session B
   │                    (~/.claude/coordination/)              │
   │── coord_post ──────────▶ INSERT ◀──────── coord_check ──│
   │                              │                            │
   │                         SessionStart                      │
   │                         hook reads DB                     │
   │                         on startup ──────▶ "1 pending"   │
```

- **MCP Server** (stdio): 5 tools for posting, checking, and acknowledging messages
- **SQLite**: Zero-config storage in `~/.claude/coordination/coord.db` (WAL mode for concurrent access)
- **SessionStart Hook**: Automatically shows pending messages when a new session starts

## Installation

```bash
# 1. Clone
git clone https://github.com/Munsik-Park/claude-session-coord.git ~/work/claude-session-coord
cd ~/work/claude-session-coord && npm install --production

# 2. Register MCP server (adds 5 tools to all Claude Code sessions)
claude mcp add -s user session-coord -- node ~/work/claude-session-coord/scripts/mcp-server.cjs

# 3. Register SessionStart hook (auto-notifies pending messages)
# Add to ~/.claude/settings.json:
```

Add the SessionStart hook to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/work/claude-session-coord/scripts/session-check.cjs",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

This will:
- Create `~/.claude/coordination/` directory (SQLite DB storage, auto-created on first use)
- Add 5 tools to all Claude Code sessions (`coord_post`, `coord_board`, `coord_check`, `coord_ack`, `coord_history`)
- Auto-notify pending messages on every session start, `/clear`, or `/compact`

## Scenario: Two AI Sessions Building a Shopping Mall

### Setup

Two repos, one project:
- **repo-backend**: API server (AI-A works here)
- **repo-frontend**: Web client (AI-B works here)

The user opens two terminals and runs Claude Code in each.

### Step 1: Tell Each AI Its Role

#### Terminal 1 — repo-backend (AI-A)

User writes in CLAUDE.md or first prompt:

```
You are the "backend" session. Project: "shopping-mall".
Another session "frontend" is building the web client in repo-frontend.

Rules:
- When you add/change an API endpoint → coord_post a handoff to frontend
- When you change DB schema → coord_post a handoff to frontend
- On session start → coord_board to check pending messages
- When you see a message from frontend → read it, act, then coord_ack
```

#### Terminal 2 — repo-frontend (AI-B)

```
You are the "frontend" session. Project: "shopping-mall".
Another session "backend" is building the API server in repo-backend.

Rules:
- When backend changes an API → you'll get a notification — update your code
- When you need a new API or a change → coord_post a request to backend
- On session start → coord_board to check pending messages
- When you see a message from backend → read it, act, then coord_ack
```

**Three things the user must provide:**
1. **Session name** (`session_id`): "You are backend"
2. **Other session's existence and role**: "frontend is building the web client"
3. **When to send messages**: "When you change an API, post a handoff"

### Step 2: AI-A Completes Work and Notifies

AI-A implements the product listing API, then:

```
AI-A thinks: "I made an API endpoint — I should tell frontend"

→ coord_post:
  session_id:   "backend"
  message_type: "handoff"
  subject:      "Product listing API ready: GET /api/products"
  body: {
    "endpoint": "GET /api/products",
    "response": { "products": [{ "id": "string", "name": "string", "price": "number" }] },
    "query_params": { "category": "optional", "page": "optional, default 1" }
  }
  project: "shopping-mall"
```

The message is stored in SQLite with `status: pending`.

### Step 3: AI-B Discovers the Message

**Path A — Automatic (SessionStart Hook):**

When AI-B's session starts (new session, `/clear`, or `/compact`):

```
[session-coord] 1 pending message:
  coord-a1b2c3d4 | handoff from backend [shopping-mall]: "Product listing API ready: GET /api/products" (15m ago)
```

AI-B sees this notification and calls `coord_check` to get details.

**Path B — Manual:**

User: "Check for messages"
AI-B → `coord_board` or `coord_check` → sees pending messages

### Step 4: AI-B Reads and Acts

```
AI-B: calls coord_check to get full details

→ Result:
  message_id: "coord-a1b2c3d4"
  from: "backend"
  subject: "Product listing API ready: GET /api/products"
  body: { endpoint, response format, query_params }

AI-B actions:
  1. Write fetch code matching the API spec
  2. Acknowledge when done:

→ coord_ack:
  message_id:     "coord-a1b2c3d4"
  ack_session_id: "frontend"
  ack_note:       "Product listing page done. GET /api/products integrated."
```

### Step 5: AI-B Sends a Reverse Request

AI-B needs an API that doesn't exist yet:

```
→ coord_post:
  session_id:   "frontend"
  message_type: "request"
  subject:      "Need product detail API: GET /api/products/:id"
  body: {
    "reason": "Product click should navigate to detail page",
    "expected_response": {
      "id": "string", "name": "string", "price": "number",
      "description": "string", "images": ["string"]
    }
  }
  project: "shopping-mall"
```

AI-A discovers this → implements the API → posts a handoff → AI-B integrates.

### Full Flow

```
User                     AI-A (backend)              SQLite DB                AI-B (frontend)
  │                            │                          │                          │
  ├──"Build API"──▶ AI-A       │                          │              AI-B ◀──"Build page"──┤
  │                ├─ impl ─┤  │                          │                          │
  │                └─ coord_post("API done") ──▶ INSERT   │                          │
  │                            │                ─ ─ ─ ─ ─▶ SessionStart hook         │
  │                            │                          │   "1 pending message"    │
  │                            │              coord_check ◀──────────┘               │
  │                            │                          │   Read spec → build UI   │
  │                            │              coord_ack  ◀─────────────┘              │
  │                            │                          │                          │
  │                            │                          │   "Need detail API"      │
  │                            │              coord_post ◀──────────────────────────── │
  │           coord_check ◀────────────────────┘          │                          │
  │                ├─ impl ─┤                             │                          │
  │                └─ coord_post("detail API done") ──▶   │                          │
  │                            │                          │           ... cycle ...   │
```

## Tools

### `coord_post`
Post a coordination message to other sessions.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `session_id` | Yes | Sender's identifier (e.g. `"backend"`, `"frontend"`) |
| `message_type` | Yes | `handoff` / `info` / `request` / `role_claim` / `status_update` / `ack` |
| `subject` | Yes | Brief subject line |
| `body` | No | Structured JSON payload with details |
| `project` | No | Project scope filter (e.g. `"shopping-mall"`) |
| `ref_message_id` | No | Reference to a previous message (for threading) |
| `expires_at` | No | ISO 8601 expiration datetime |

### `coord_board`
Dashboard view: session summary + pending messages.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `project` | No | Filter by project |

### `coord_check`
Query pending messages with optional filters.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `session_id` | No | Filter by sender |
| `message_type` | No | Filter by type |
| `project` | No | Filter by project |
| `limit` | No | Max results (default 20) |

### `coord_ack`
Acknowledge a pending message and optionally post a reply note.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `message_id` | Yes | The message to acknowledge |
| `ack_session_id` | Yes | Session acknowledging the message |
| `ack_note` | No | Note about what was done |

### `coord_history`
Browse full message history with filters.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `project` | No | Filter by project |
| `session_id` | No | Filter by session |
| `message_type` | No | Filter by type |
| `status` | No | `pending` / `acknowledged` / `completed` / `expired` |
| `limit` | No | Max results (default 50) |
| `offset` | No | Pagination offset |

## Message Types

| Type | When to Use |
|------|-------------|
| `handoff` | Shared interface/schema changed — other sessions must adapt |
| `request` | Another session needs to take action |
| `info` | FYI — no action required |
| `role_claim` | Declaring ownership of a work area |
| `status_update` | Progress report |
| `ack` | Auto-created when acknowledging a message |

## What the User Does vs. Doesn't Do

### Must do (one-time)
| Task | Description |
|------|-------------|
| Install the plugin | `claude mcp add` (once) |
| Tell each AI its role | session_id, the other session's existence and role |
| Define message rules | "Post a handoff when you change an API" etc. |

### Doesn't need to do
| Task | Why |
|------|-----|
| Run a server | stdio MCP — Claude Code manages the process lifecycle |
| Install a database | SQLite — one file, auto-created |
| Relay messages | AIs read/write SQLite directly |
| Say "check messages" every time | SessionStart hook auto-notifies |

### Can optionally do
- "Check for messages" → AI calls `coord_board` immediately
- "Tell frontend about this" → AI calls `coord_post`
- Write rules in CLAUDE.md → no need to repeat every session

## Constraints

- **Same machine only**: Sessions share a SQLite file, so they must be on the same computer
- **Not real-time**: Messages are checked on session start or user instruction (no polling)
- **AI judgment**: "Should I notify?" is decided by the AI based on rules. More specific rules = more accurate notifications

## Design Decisions

- **SQLite over PostgreSQL**: Zero infrastructure. No Docker, no server. The DB file in `~/.claude/coordination/` is shared across all sessions.
- **stdio MCP over HTTP**: Claude Code manages the server lifecycle — starts on use, stops on session end. No port conflicts.
- **WAL mode**: Concurrent reads from multiple sessions while one writes.
- **Behavioral rules over automation**: The AI decides *when* to send messages based on user-defined rules.

## Requirements

- Node.js >= 18
- Claude Code with MCP support

## License

MIT
