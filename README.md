# claude-session-coord

Inter-session coordination plugin for [Claude Code](https://claude.ai/code).

When running multiple Claude Code sessions concurrently (e.g., one for backend evolution, another for data crawling), they need a way to exchange messages — handoffs, status updates, and requests. This plugin provides that coordination layer.

## How It Works

```
Session A                    SQLite DB                    Session B
   │                    (~/.claude/coordination/)              │
   │── coord_post ──────────▶ INSERT ◀──────── coord_check ──│
   │                              │                            │
   │                         SessionStart                      │
   │                         hook reads DB                     │
   │                         on startup ──────▶ "2 pending"   │
```

- **MCP Server** (stdio): 5 tools for posting, checking, and acknowledging messages
- **SQLite**: Zero-config storage in `~/.claude/coordination/coord.db`
- **SessionStart Hook**: Automatically shows pending messages when a new session starts

## Installation

```bash
claude plugin add ~/work/claude-session-coord
# or from GitHub:
claude plugin add https://github.com/Munsik-Park/claude-session-coord
```

## Tools

### `coord_post`
Post a coordination message to other sessions.

```
session_id:   "ontology-evolution"
message_type: "handoff"
subject:      "New property: hasPoolType added to Accommodation"
body:         { "property": "hasPoolType", "domains": ["Accommodation"] }
project:      "ontology-ticket"  (optional)
```

### `coord_board`
Dashboard view showing session activity and pending messages.

```
=== Coordination Board ===

Sessions:
  ontology-evolution: pending:2, acknowledged:5
  data-crawling: pending:0, acknowledged:3

Pending (2):
  coord-a1b2c3d4 | handoff | from ontology-evolution [ontology-ticket]
    "New property: hasPoolType" (2h ago)
  coord-e5f6g7h8 | info | from data-crawling [ontology-ticket]
    "50 items registered" (30m ago)
```

### `coord_check`
Query pending messages with optional filters.

| Parameter | Description |
|-----------|-------------|
| `session_id` | Filter by sender |
| `message_type` | `handoff`, `info`, `request`, `role_claim`, `status_update`, `ack` |
| `project` | Filter by project scope |
| `limit` | Max results (default 20) |

### `coord_ack`
Acknowledge a pending message and optionally post a reply note.

```
message_id:     "coord-a1b2c3d4"
ack_session_id: "data-crawling"
ack_note:       "Updated extraction prompts for hasPoolType"
```

### `coord_history`
Browse full message history with filters for project, session, type, and status.

## Message Types

| Type | When to Use |
|------|-------------|
| `handoff` | Shared interface/schema changed — other sessions must adapt |
| `request` | Another session needs to take action |
| `info` | FYI — no action required |
| `role_claim` | Declaring ownership of a work area |
| `status_update` | Progress report |
| `ack` | Auto-created when acknowledging a message |

## Session Start Notification

When a new Claude Code session starts, the plugin automatically checks for pending messages:

```
[session-coord] 2 pending messages:
  coord-a1b2c3d4 | handoff from ontology-evolution [ontology-ticket]: "New property: hasPoolType" (2h ago)
  coord-e5f6g7h8 | info from data-crawling [ontology-ticket]: "50 items registered" (30m ago)
```

If there are no pending messages, the hook is silent.

## Design Decisions

- **SQLite over PostgreSQL**: Zero infrastructure. No Docker, no server process. The DB file lives in `~/.claude/coordination/` and is shared across all sessions on the machine.
- **stdio MCP over HTTP**: Claude Code manages the server lifecycle — starts on use, stops on session end. No port conflicts, no process management.
- **WAL mode**: Enables concurrent reads from multiple sessions while one writes.
- **Behavioral Skill**: Guides Claude on *when* to send messages (most work doesn't need coordination).

## Requirements

- Node.js >= 18
- Claude Code with plugin support

## License

MIT
