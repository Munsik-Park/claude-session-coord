---
name: session-coordination
description: Inter-session coordination rules. Guides when to send messages to other sessions. Use when completing tasks that affect other concurrent sessions or projects.
---

# Inter-Session Coordination Rules

## When to Send Messages

Most work does NOT require coordination messages.
Only post when your work has **cross-session impact**.

### Outbound Checklist (self-check after each commit or task completion)

| Condition | message_type | Example |
|-----------|-------------|---------|
| Shared interface/schema changed | `handoff` | API endpoint added, DB migration, ontology update |
| Another session needs to act on your output | `request` | "Need product detail API" |
| Work completed that others should know about | `info` | "50 items registered", "benchmark ready" |
| Claiming ownership of a work area | `role_claim` | "I'm handling the API server" |

### Decision Flow

```
Did I change something another session depends on?
  YES → handoff
  NO  → Did I produce output another session consumes?
          YES → info
          NO  → Did I discover something requiring another session's action?
                  YES → request
                  NO  → Do nothing (most common path)
```

## When to Check Messages

- **Session start**: Automatically checked by SessionStart hook
- **User asks**: "Check for messages" or "Check coordination board"
- **Before major decisions**: Check if another session has posted relevant context

## Message Conventions

- `session_id`: Use descriptive names (e.g. `backend`, `frontend`, `data-crawling`)
- `project`: Use when multiple projects share the coordination DB (e.g. `shopping-mall`)
- `subject`: Keep brief — the body carries details
- `body`: Structured JSON with actionable information (e.g. API specs, schema changes)

## Acknowledging Messages

When you see a pending message relevant to your session:
1. Read and understand the message (`coord_check`)
2. Take any required action (implement, update code, etc.)
3. Acknowledge with `coord_ack` (include a note about what you did)

## Example: Backend→Frontend Handoff

```
coord_post:
  session_id:   "backend"
  message_type: "handoff"
  subject:      "Product listing API ready: GET /api/products"
  body: {
    "endpoint": "GET /api/products",
    "response": { "products": [{ "id": "string", "name": "string", "price": "number" }] }
  }
  project: "shopping-mall"
```

## Conversation Mode (Autonomous AI-to-AI)

Two AI sessions can have an **autonomous** back-and-forth conversation using the Stop hook.
After the conversation starts, the AIs exchange messages automatically — the user only intervenes to steer direction or end the conversation.

Use `/start-conv` to begin. See the `start-conv` skill for detailed usage.

### How It Works

```
AI responds → Stop hook fires
  → Check conv state file
  → Query SQLite for partner's pending messages
  → Found → {"decision":"block","reason":"<msg>"} → auto-reinject → AI responds again
  → Not found → poll 3s intervals, max 15s
  → Timeout → exit 0 (idle) → user prompt resumes the cycle
```

### Starting a Conversation

1. **Terminal A**: User runs `/start-conv new` → AI creates a room, gets code (e.g. `conv-x7k2`)
2. **Terminal B**: User runs `/start-conv conv-x7k2` → AI joins, waits for user direction
3. **User gives topic**: Either side's user types a topic/instruction → AI sends first message
4. **Both terminals**: Stop hooks begin autonomous message exchange

### Turn Progression (Autonomous)

```
Terminal A                                Terminal B
  /start-conv new                           /start-conv conv-x7k2
  AI-A: "Room conv-x7k2 created"           AI-B: "Connected. Waiting for direction."

  User: "Discuss crawling attributes"
  AI-A → coord_reply(question)
  Stop hook → polls...                      Stop hook → partner msg found!
                                            AI-B → auto-response → coord_reply
  Stop hook → partner msg found!            Stop hook → polls...
  AI-A → auto-response → coord_reply
  Stop hook → polls...                      Stop hook → partner msg found!
  ...                                       ...
  (autonomous exchange continues)
```

### User Intervention

The user can type **at any time** to steer the conversation:
- Direction: "Focus on normalization rules" → AI includes this in next reply
- End: "Stop" or "End conversation" → AI calls `coord_conv_end`

### Displaying Conversation Content

Show partner messages in blockquote format:

```
> **ontology-crawling** (2m ago):
> hasPoolType is already being extracted from crawled data...
```

### Ending a Conversation

**AI suggests ending** when:
- `turn_count >= 70% of max_turns`
- The topic has been resolved
- No further action items remain

**On end:**
```
coord_conv_end:
  session_id: "<your-session>"
  summary:    "Agreed to add hasPoolType extraction. Crawling will add it in next sprint."
```

This acknowledges remaining partner messages, posts a `[conv-end]` info message, and deletes **both** state files + room file.

### Safety Mechanisms

| Mechanism | Details |
|-----------|---------|
| Max turns | Default 20 — auto-ends when reached |
| TTL | 30 minutes — state files auto-expire |
| Partner termination | `coord_conv_end` deletes both sides' state files |
| Poll timeout | 15 seconds — then idle until user input |

### Tool Selection Guide

| Tool | Use when | Result |
|------|----------|--------|
| `coord_conv_start` (create) | Creating a new conversation room | Room file + creator state file |
| `coord_conv_start` (join) | Joining an existing room | Connects both state files + first message |
| `coord_reply` | Responding during conversation | Ack original + post new pending reply |
| `coord_conv_end` | Ending the conversation | Ack pending + end msg + delete all state/room files |
| `coord_ack` | One-off acknowledgment (outside conversation) | Ack only, no new message |

### Normal Mode (Outside Conversation)

When not in conversation mode, hooks behave normally:
- Pending messages = 0 → silent exit (saves tokens)
- Pending messages > 0 → shows all pending messages in standard format

## Example: Frontend→Backend Request

```
coord_post:
  session_id:   "frontend"
  message_type: "request"
  subject:      "Need product detail API: GET /api/products/:id"
  body: {
    "reason": "Product click navigates to detail page",
    "expected_response": { "id": "string", "name": "string", "description": "string" }
  }
  project: "shopping-mall"
```
