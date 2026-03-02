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
| Shared interface/schema changed | `handoff` | DB migration, API contract change, ontology update |
| Another session needs to act on your output | `request` | "Reprocess items with new extraction rules" |
| Work completed that others should know about | `info` | "50 items registered", "benchmark results ready" |
| Claiming ownership of a work area | `role_claim` | "I'm handling the data crawling pipeline" |

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

- `session_id`: Use descriptive names (e.g. `ontology-evolution`, `data-crawling`, `frontend-dev`)
- `project`: Use when multiple projects share the coordination DB
- `subject`: Keep brief — the body carries details
- `body`: Structured JSON with actionable information

## Acknowledging Messages

When you see a pending message relevant to your session:
1. Read and understand the message
2. Take any required action
3. Acknowledge with `coord_ack` (include a note about what you did)
