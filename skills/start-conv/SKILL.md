---
name: start-conv
description: Start or join an AI-to-AI conversation. Two AI sessions can have an autonomous back-and-forth discussion with Stop hook auto-reinjection.
user_invocable: true
---

# /start-conv — AI-to-AI Autonomous Conversation

## Usage

- `/start-conv new` — Create a new conversation room
- `/start-conv new <topic>` — Create with a topic
- `/start-conv <room-code>` — Join an existing room (e.g. `/start-conv conv-x7k2`)

## How It Works

1. **Create**: One session creates a room and gets a short code (e.g. `conv-x7k2`)
2. **Join**: The other session joins with that code
3. **Wait**: Both sides wait for their user's direction before sending the first message
4. **Autonomous**: After the first message, the Stop hook automatically detects partner messages and reinjects them — no user intervention needed
5. **Direction**: The user can type a message anytime to steer the conversation
6. **End**: Either AI calls `coord_conv_end(summary="...")` or the user says "stop" / "end conversation"

## Prerequisites

The Stop hook must be registered in each project's `.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/work/claude-session-coord/scripts/conv-stop-hook.cjs",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

Without this, the session cannot auto-detect partner messages.

## Actions

### Creating a room (`/start-conv new`)

Derive session_id from the current working directory name (e.g. `ontology-ticket`).

```
coord_conv_start(mode="create", session_id="<cwd-based>", topic="<if provided>")
```

Tell the user the room code so they can share it with the other terminal.

### Joining a room (`/start-conv <code>`)

```
coord_conv_start(mode="join", session_id="<cwd-based>", room_code="<code>")
```

After joining, tell the user the connection is established and **wait for user direction**. Do NOT send any message (greeting or otherwise) until the user gives a topic or instruction.

### After connection (both sides)

Both the creator and joiner must **wait for their user's direction** before sending the first message. The Stop hook will automatically detect when the partner sends a message. Do NOT proactively send greetings or start the conversation on your own.

## Sending the First Message

When the user gives a topic or instruction:

1. Use `coord_post` to send the first message (there is no prior message to reply to):
   ```
   coord_post(session_id="<cwd-based>", message_type="request", subject="[conv] <topic summary>", body={...}, project="<if applicable>")
   ```
2. The `[conv]` prefix in the subject is **required** — it identifies conversation messages.

## Behavior During Conversation

- **Idle waiting**: When the partner hasn't responded yet, the session goes idle automatically (no action needed). The user can type freely during this time. When the user submits any input, the Prompt hook will check for partner messages and display them.
- **User input priority**: If the user types a message, always process it first — even if a hook feedback arrives simultaneously. User direction takes precedence over autonomous conversation flow.
- **Auto-reply**: When the Stop hook reinjects a partner message (shown as "Stop hook feedback"), read it and respond with `coord_reply`:
  ```
  coord_reply(message_id="<from the feedback>", session_id="<cwd-based>", subject="[conv] <response>", body={...})
  ```
- **User direction**: If the user types something, incorporate their direction into your next `coord_reply`
- **Show conversation**: Display partner messages in blockquote format:
  > **ontology-crawling** (2m ago):
  > Let me check the crawling data for that attribute...
- **Suggest ending**: When `turn_count >= 70% of max_turns`, ask: "Discussion seems to be converging. Should we wrap up?"
- **End**: Call `coord_conv_end(session_id="<id>", summary="...")` with a brief summary of decisions made

## Tool Selection Guide

| Tool | Use when | Notes |
|------|----------|-------|
| `coord_conv_start(mode="create")` | Creating a new room | Returns room code |
| `coord_conv_start(mode="join")` | Joining an existing room | Connects both sides |
| `coord_post` | Sending the **first** message in a conversation | No prior message to reply to. Use `[conv]` prefix in subject |
| `coord_reply` | All **subsequent** messages | Acknowledges the partner's message + posts reply |
| `coord_conv_end` | Ending the conversation | Cleans up state, notifies partner |

## Cross-Project Conversations

Two sessions in **different projects** (e.g. `ontology-ticket` and `agent-trade-mcp`) can converse. Each session's `session_id` is derived from its project directory name.

**Requirements for each project:**
- Stop hook registered in `.claude/settings.local.json` (see Prerequisites)
- `session-coord` MCP server accessible (registered via `claude mcp add -s user`)

No additional configuration needed — the shared SQLite DB (`~/.claude/coordination/coord.db`) handles cross-project communication automatically.

## Flow Diagram

```
Terminal A (project-a)                     Terminal B (project-b)
  /start-conv new
  AI-A: "Room conv-x7k2 created"
                                           /start-conv conv-x7k2
                                           AI-B: "Connected. Waiting for direction."

  User: "Discuss data format"
  AI-A → coord_post([conv] ...)
  Stop hook: polls...                      Stop hook: partner msg found!
                                           AI-B reads → coord_reply([conv] ...)
  Stop hook: partner msg found!            Stop hook: polls...
  AI-A reads → coord_reply([conv] ...)
  ...                                      ...
  (autonomous exchange — no user input needed)

  User: "end"
  AI-A → coord_conv_end(summary)           Stop hook: ended_by detected → notify
                                           AI-B → coord_conv_end(summary)
```

## User Intervention

Type anything during the conversation to steer direction:
- **Steer**: "Focus on normalization rules" → AI incorporates into next reply
- **End**: "Stop" or "End conversation" → AI calls `coord_conv_end(summary="...")`

## Safety

| Mechanism | Details |
|-----------|---------|
| Max turns | Default 20 — auto-ends when reached |
| TTL | 30 minutes — state/room files auto-expire |
| Partner termination | `coord_conv_end` marks partner's state with `ended_by` — partner's hook detects and notifies |
| Poll timeout | 15 seconds — session goes idle, user can type freely |
| Stale filter | Only messages created after conversation start are detected (prevents cross-conversation leakage) |
