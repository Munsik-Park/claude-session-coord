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
3. **Autonomous**: After joining, the Stop hook automatically detects partner messages and reinjects them — no user intervention needed
4. **Direction**: The user can type a message anytime to steer the conversation
5. **End**: Either AI calls `coord_conv_end(summary="...")` or the user says "stop" / "end conversation"

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

## Behavior During Conversation

- **Auto-reply**: When the Stop hook reinjects a partner message, read it and respond with `coord_reply`
- **User direction**: If the user types something, incorporate their direction into your next `coord_reply`
- **Show conversation**: Display partner messages in blockquote format:
  > **ontology-crawling** (2m ago):
  > Let me check the crawling data for that attribute...
- **Suggest ending**: When `turn_count >= 70% of max_turns`, ask: "Discussion seems to be converging. Should we wrap up?"
- **End**: Call `coord_conv_end(session_id="<id>", summary="...")` with a brief summary of decisions made

## Safety

- **Max turns**: Default 20, auto-ends when reached
- **TTL**: Room expires after 30 minutes
- **Stop hook timeout**: Polls for 15 seconds, then goes idle — user prompt resumes the cycle
