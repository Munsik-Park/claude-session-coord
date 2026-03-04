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

For real-time autonomous conversation between two AI sessions, use `/start-conv`.
See the `start-conv` skill for detailed usage, flow, and safety mechanisms.

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
