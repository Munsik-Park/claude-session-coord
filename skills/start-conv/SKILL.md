---
name: start-conv
description: Start or join an AI-to-AI conversation using MCP tool-based message waiting.
user_invocable: true
---

# /start-conv — AI-to-AI Conversation

## Usage

- `/start-conv new` — Create a new conversation room
- `/start-conv new <topic>` — Create with a topic
- `/start-conv <room-code>` — Join an existing room (e.g. `/start-conv conv-x7k2`)

## How It Works

1. **Create**: One session creates a room and gets a short code (e.g. `conv-x7k2`)
2. **Join**: The other session joins with that code
3. **Wait**: Both sides wait for their user's direction before sending the first message
4. **Message exchange**: After sending a message, call `coord_wait_for_reply` to wait for partner's response
5. **Direction**: The user can type a message anytime to steer the conversation (interrupts the wait)
6. **End**: AI autonomously ends when conclusions are reached, or user says "stop"

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

After joining, tell the user the connection is established and **wait for user direction**.

### After connection (both sides)

Both the creator and joiner must **wait for their user's direction** before sending the first message. Do NOT proactively send greetings or start the conversation on your own.

## Conversation Flow

When the user gives a topic or instruction:

1. **Send message**: `coord_post` (first message) or `coord_reply` (subsequent)
2. **Wait for reply**: `coord_wait_for_reply(session_id="<id>", timeout=60)`
3. **Process reply**: Read partner's message, formulate response
4. **Repeat**: Send reply → wait → process → send → ...
5. **End**: When conclusions are reached, call `coord_conv_end`

### Example turn:

```
# Send first message
coord_post(session_id="ontology-ticket", message_type="request",
  subject="[conv] Let's discuss attribute normalization",
  body={"message": "..."})

# Wait for partner's response (blocks up to 60s)
coord_wait_for_reply(session_id="ontology-ticket", timeout=60)

# Partner's message is returned → read and respond
coord_reply(message_id="<from wait result>", session_id="ontology-ticket",
  subject="[conv] Response about normalization",
  body={"message": "..."})

# Wait again...
coord_wait_for_reply(session_id="ontology-ticket", timeout=60)
```

## Tool Selection Guide

| Tool | Use when | Notes |
|------|----------|-------|
| `coord_conv_start(mode="create")` | Creating a new room | Returns room code |
| `coord_conv_start(mode="join")` | Joining an existing room | Connects both sides |
| `coord_post` | Sending the **first** message | No prior message to reply to. Use `[conv]` prefix in subject |
| `coord_reply` | All **subsequent** messages | Acknowledges the partner's message + posts reply |
| `coord_wait_for_reply` | After sending a message | Polls DB up to 60s, returns partner message or timeout |
| `coord_conv_end` | Ending the conversation | Notifies partner via `[conv-end]` message |

## Behavior Rules

- **User input priority**: If the user types while `coord_wait_for_reply` is running, the wait is interrupted. Process user input first.
- **User direction during conversation**: Incorporate user's input into your next message to partner.
- **Show conversation**: Display partner messages in blockquote format:
  > **ontology-crawling** (2m ago):
  > Let me check the crawling data for that attribute...
- **Autonomous ending**: When AI determines conclusions have been reached, call `coord_conv_end` with summary, explain results to user, and stop.
- **Timeout handling**: If `coord_wait_for_reply` returns timeout, tell the user partner hasn't responded. User decides whether to wait more or end.

## Cross-Project Conversations

Two sessions in **different projects** can converse. Each session's `session_id` is derived from its project directory name.

**Requirements for each project:**
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
  AI-A → coord_wait_for_reply(60s)         AI-B → coord_wait_for_reply(60s)
                                           (message found!)
                                           AI-B reads → coord_reply([conv] ...)
                                           AI-B → coord_wait_for_reply(60s)
  (message found!)
  AI-A reads → coord_reply([conv] ...)
  AI-A → coord_wait_for_reply(60s)
  ...                                      ...
  (autonomous exchange via tool-based waiting)

  AI-A determines conclusion reached
  AI-A → coord_conv_end(summary)
  AI-A explains results to user
                                           AI-B: coord_wait returns "partner_ended"
                                           AI-B → coord_conv_end(summary)
```

## User Intervention

Type anything during the conversation to steer direction:
- **Steer**: "Focus on normalization rules" → AI incorporates into next reply
- **End**: "Stop" or "End conversation" → AI calls `coord_conv_end(summary="...")`

## Safety

| Mechanism | Details |
|-----------|---------|
| Wait timeout | Default 60s per wait call — returns timeout, user decides |
| Partner termination | `coord_conv_end` posts `[conv-end]` — `coord_wait_for_reply` detects and returns |
| Stale filter | Only messages created after conversation start are detected |
| User interrupt | User can type anytime to interrupt wait and steer conversation |
