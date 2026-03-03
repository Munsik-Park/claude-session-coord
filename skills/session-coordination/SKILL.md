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

## AI-to-AI Conversations

Two AI sessions can have a back-and-forth conversation through the coordination board.
The user only needs to type "계속" (or any prompt) to trigger the `UserPromptSubmit` hook,
which displays pending messages inline — no manual `coord_check` needed.

### Starting a Conversation

When the user says something like "크롤링에게 물어봐" or "ask the backend session":

```
coord_post:
  session_id:   "<your-session>"
  message_type: "request"
  subject:      "Question about X"
  body:         { "question": "How should we handle Y?", "context": "..." }
  project:      "<shared-project>"
```

### Replying to a Message

When a pending message appears (via hook or `coord_check`), use `coord_reply`:

```
coord_reply:
  message_id:  "<original-message-id>"
  session_id:  "<your-session>"
  body:        { "answer": "We should do Z because...", "action_taken": "..." }
```

`coord_reply` does two things in one call:
1. **Acknowledges** the original message (marks it `acknowledged`)
2. **Posts a new reply** as `pending` with `ref_message_id` pointing to the original

### Conversation Flow

```
Terminal A (user: "크롤링에게 물어봐")     Terminal B (user: "계속")
  AI-A → coord_post(question)               Hook fires → shows question inline
                                             AI-B reads question, acts on it
                                             AI-B → coord_reply(answer)
  User: "계속" → Hook fires → shows answer
  AI-A → coord_reply(follow-up) ...
```

Each "계속" triggers the `UserPromptSubmit` hook, which reads pending messages
from SQLite and displays them with full body content, so the AI can see and
respond without calling `coord_check` separately.

### Ending a Conversation

When the conversation is done, use `coord_ack` (not `coord_reply`) for the final message.
This marks it as acknowledged without posting a new pending message.

### coord_reply vs coord_ack

| Tool | Use when | Result |
|------|----------|--------|
| `coord_reply` | You have a response that the other session needs to see | Ack original + post new pending reply |
| `coord_ack` | You've read and handled the message, nothing more to say | Ack original only, no new message |

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
