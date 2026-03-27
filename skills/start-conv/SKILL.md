---
name: start-conv
description: Start or join an AI-to-AI conversation using MCP tool-based message waiting.
user_invocable: true
---

# /start-conv — AI-to-AI Conversation (Human-in-the-Loop)

## Purpose

AI끼리 자율적으로 대화하고, 사용자는 중간에 방향을 잡아주는 **Human-in-the-Loop** 구조입니다.

## Usage

- `/start-conv new` — Create a new conversation room (cleans up previous room first)
- `/start-conv new <topic>` — Create with a topic
- `/start-conv <room-code>` — Join an existing room (e.g. `/start-conv conv-x7k2`)

## Core Rules

1. **One room only** — only one conversation room exists at a time
2. **User controls lifecycle** — AI never autonomously ends; it recommends ending, then hands control to user
3. **Clean start** — `new` always cleans up previous room/messages before creating
4. **Autonomous AI dialogue** — after user gives initial direction (Turn 0), AI auto-responds to partner without waiting for user
5. **Human-in-the-loop** — user can interrupt anytime to redirect the conversation

## Actions

### Creating a room (`/start-conv new`)

1. **Clean up previous room**: Call `coord_conv_end` if an active conversation exists (ignore errors)
2. Derive session_id from the current working directory name (e.g. `ontology-ticket`)
3. Call `coord_conv_start(mode="create", session_id="<cwd-based>", topic="<if provided>")`
4. Tell the user the room code → **enter Turn 0 (wait for user direction)**

### Joining a room (`/start-conv <code>`)

1. **Clean up previous room**: Call `coord_conv_end` if an active conversation exists (ignore errors)
2. Call `coord_conv_start(mode="join", session_id="<cwd-based>", room_code="<code>")`
3. Tell the user the connection is established
3. **Poll for partner messages** — call `coord_wait_for_reply(timeout=120)`, retry once on timeout (max **2 attempts**, ~4 min total)
4. If partner message received at any point → display it → **auto-respond contextually** → enter **Autonomous Loop** (no user direction needed)
5. Only if both attempts timeout → tell user "상대방 메시지가 아직 없습니다" and wait for user direction (Turn 0)

## Turn Model

### Turn 0 — User Direction (Initial)

**Creator side (`new`)**: Wait for user input. The user provides the topic or instruction.
- Poll for partner messages while waiting: `coord_wait_for_reply(timeout=5)`
- If partner message arrives before user input, display it and keep waiting for user
- Once user gives direction → send first message to partner → enter **Autonomous Loop**

**Joiner side (`<code>`)**: The partner already initiated the conversation, so:
- Poll for partner messages: `coord_wait_for_reply(timeout=120)`, retry once on timeout (2 attempts, ~4 min total)
- If partner message received at any point → display it → **auto-respond contextually** → enter **Autonomous Loop** immediately
- Only fall back to user direction if both attempts timeout
- If no message yet → wait for user direction (same as creator side)

### Turn 1+ — Autonomous AI Dialogue Loop

After sending a message, AI enters the autonomous loop:

```
AUTONOMOUS_LOOP:
  coord_wait_for_reply(session_id="<id>", timeout=5)

  IF message_received:
    → Display partner message to user (always visible)
    → Formulate response autonomously (based on conversation context + user's last direction)
    → Send response via coord_reply
    → LOOP

  IF partner_ended:
    → Display to user: "상대방이 대화를 종료했습니다"
    → Send coord_conv_end
    → EXIT

  IF timeout:
    → LOOP (silently, no output)

  IF user_input (interrupts the wait):
    → User input becomes new direction
    → If user says "종료" / "end" → send coord_conv_end, EXIT
    → Otherwise: incorporate user direction into next message to partner
    → Send message to partner
    → LOOP
```

**Key behavior**: When partner replies, AI **automatically responds** without waiting for user. The user sees the conversation flowing and can interrupt anytime to steer it.

## Display Format

Always show the conversation to the user so they can follow along:

**Partner message:**
> **🤖 agent-trade-mcp**:
> Message content here...

**AI's own response (before sending):**
> **💬 나 → agent-trade-mcp**:
> Response content here...

This way the user sees both sides of the AI-to-AI dialogue in real time.

## Conversation Flow Example

```
# Turn 0: User gives direction
User: "온톨로지 속성 추가 건에 대해 논의해줘"

# AI sends first message
coord_post(session_id="ontology-ticket", message_type="request",
  subject="[conv] 온톨로지 속성 논의",
  body={"message": "안녕하세요! 온톨로지 속성 추가 건에 대해 논의하고 싶습니다..."})

# Autonomous Loop begins
coord_wait_for_reply(timeout=5)  # timeout → loop silently
coord_wait_for_reply(timeout=5)  # message received!

# Display partner message to user
> 🤖 agent-trade-mcp: "네, 어떤 속성을 추가하려고 하시나요?"

# AI auto-responds (no user input needed)
> 💬 나 → agent-trade-mcp: "hasPoolType 속성을 Accommodation 도메인에..."

coord_reply(message_id="<id>", session_id="ontology-ticket",
  subject="[conv] hasPoolType 제안",
  body={"message": "hasPoolType 속성을 Accommodation 도메인에..."})

# Continue autonomous loop
coord_wait_for_reply(timeout=5)  # ... partner replies ... auto-respond ...

# User interrupts mid-conversation
User: "가격 관련 속성도 같이 논의해"

# AI incorporates user direction
> 💬 나 → agent-trade-mcp: "추가로 가격 관련 속성도 논의하고 싶습니다..."

# ... autonomous loop continues with new direction ...

# AI recommends ending
"대화가 마무리된 것 같습니다. 종료할까요?"

# User: "종료"
coord_conv_end(session_id="ontology-ticket", summary="...")
```

## Ending a Conversation

**AI does NOT autonomously end.** When AI judges the conversation has reached a conclusion:

1. Display recommendation to user: "대화가 마무리된 것 같습니다. 종료할까요?"
2. Continue autonomous loop (waiting for user decision)
3. User decides: "종료" → proceed to step 4, or gives new direction → continue
4. Send `[conv-end]`: `coord_conv_end(session_id="<id>", summary="...")`
5. EXIT (done)

**Receiving [conv-end] from partner:**

1. Poll returns `partner_ended`
2. Display to user: "상대방이 대화를 종료했습니다"
3. Send own `[conv-end]`: `coord_conv_end(session_id="<id>", summary="...")`
4. EXIT

## Tool Selection Guide

| Tool | Use when | Notes |
|------|----------|-------|
| `coord_conv_end` | Cleanup before `new` | Ignore errors (no active room = OK) |
| `coord_conv_start(mode="create")` | Creating a new room | Returns room code |
| `coord_conv_start(mode="join")` | Joining an existing room | Connects both sides |
| `coord_post` | Sending the **first** message | `[conv]` prefix in subject |
| `coord_reply` | All **subsequent** messages | Acknowledges partner's message + posts reply |
| `coord_wait_for_reply` | Autonomous loop | **Joiner initial: timeout=120 (2 attempts)**. Autonomous loop: timeout=5. Silent on timeout. |
| `coord_conv_end` | Ending the conversation | User-approved only. Posts `[conv-end]` |

## Discussion Protocol

AI-to-AI conversations must mirror the critical evaluation used in human design discussions.
The goal: substantive dialogue that tests ideas, not polite agreement.

### Response Process

Before responding to any partner proposal, follow this sequence:

1. **UNDERSTAND** — Restate what the partner is proposing in concrete terms (not "I understand")
2. **VERIFY** — Read relevant source files, check DB schema, or review existing patterns BEFORE evaluating. Never evaluate from memory alone when the proposal touches code, schema, or config.
3. **EVALUATE** — Check against at least 2 of these dimensions:
   - **Feasibility**: Does the current codebase/schema/infra support this? What changes are needed?
   - **Alignment**: Does it follow existing patterns, naming conventions, layer separation?
   - **Trade-offs**: Cost? Maintenance burden? Migration complexity? Performance impact?
   - **Alternatives**: Is there a simpler approach that achieves the same goal?
   - **Scope**: Is this solving the right problem at the right level of abstraction?
4. **RESPOND** — Choose one:

| Response | When | Format |
|----------|------|--------|
| **ACCEPT** | All evaluated dimensions pass | State which dimensions you checked and why it fits |
| **COUNTER** | One or more dimensions fail | State the issue + provide a specific alternative with reasoning |
| **PARTIAL** | Some aspects pass, others don't | Accept passing parts, counter failing parts explicitly |
| **ESCALATE** | Fundamental disagreement or insufficient evidence | Present both positions to user for decision |

### Anti-Patterns (hard rules)

- **No blind acceptance**: Never say "좋은 생각입니다" without stating WHICH dimensions you verified and WHY it passes
- **No memory-only evaluation**: If the proposal touches code/schema/config — read the actual file before responding
- **No feature stacking**: Don't add "그리고 이것도 추가하면" on top of an unverified base proposal
- **No premature consensus**: If you agree on first exchange, challenge at least one dimension as devil's advocate before confirming
- **No dropped concerns**: If your concern is not addressed by the partner, re-raise it explicitly

### Escalation to User

Pause the autonomous loop and ask the user when:
- **Architecture conflict**: Different patterns/approaches with no clear winner
- **Risk disagreement**: One side sees significant risk the other dismisses
- **Scope conflict**: Disagreement on whether something is in-scope or over-engineering
- **Evidence stalemate**: Neither side can provide stronger evidence from the codebase

Format:
```
사용자 판단이 필요합니다:

[A — session-X 의견]:
(summary with reasoning)

[B — session-Y 의견]:
(summary with reasoning)

어느 방향으로 진행할까요?
```

### Conversation Depth

- **First response**: Always verify + evaluate before accepting (never accept on first hearing)
- **Consensus threshold**: Both sides must address at least 2 evaluation dimensions before agreement
- **Devil's advocate**: If both sides agree immediately, one should challenge on scope or alternatives ("더 단순한 방법은 없을까요?")
- **Minimum per topic**: At least one proposal → counter/question → resolution cycle for design decisions. Quick confirmations ("파일명은 X로 합시다") are exempt.

### Integration with Autonomous Loop

```
coord_wait_for_reply → message received
  → UNDERSTAND (parse proposal)
  → VERIFY (read files if needed — Glob/Read/Grep)
  → EVALUATE (2+ dimensions)
  → RESPOND (ACCEPT/COUNTER/PARTIAL/ESCALATE)
  → coord_reply → loop

If ESCALATE → display both positions → wait for user input → incorporate → coord_reply → loop
```

## Behavior Rules

- **Autonomous response**: After Turn 0, AI responds to partner messages automatically without waiting for user input. Each response follows the Discussion Protocol (UNDERSTAND → VERIFY → EVALUATE → RESPOND).
- **User visibility**: ALWAYS display both partner messages and AI's own responses so user can follow the dialogue
- **User interrupt priority**: If user types during the loop, incorporate their direction immediately
- **Silent polling**: NEVER print anything on timeout. Just loop silently.
- **AI ending**: When conversation feels complete, recommend ending to user. Never call `coord_conv_end` without user approval.
- **Context awareness**: AI should maintain conversation coherence across turns. Track unresolved concerns and re-raise them if partner does not address them.
- **Minimal output**: Only display 🤖/💬 conversation messages and essential status changes (연결, 종료). Do NOT output progress text like "상대방 메시지를 확인합니다", "상대방 응답을 기다리고 있습니다", "응답을 보냈습니다" etc. MCP tool calls are visible in the UI already — adding commentary is redundant noise.

## Flow Diagram

```
Terminal A (project-a)                     Terminal B (project-b)
  /start-conv new
  (cleanup previous room)
  AI-A: "Room conv-x7k2 created"
  AI-A: waiting for user direction...      /start-conv conv-x7k2
                                           AI-B: "Connected"
  [Turn 0 - Creator]                       AI-B: wait(120s) for partner message...
  User-A: "인사해"
  AI-A → coord_post([conv] 인사)           AI-B wait → message from A!
  AI-A → wait(5s) → wait(5s)              AI-B displays A's message to User-B
                                           [Auto-enter Autonomous Loop]
  [Turn 1+ Autonomous]                     AI-B auto-responds → coord_reply
  AI-A wait → message from B!              AI-B → wait(5s) → ...
  AI-A displays B's message to User-A
  AI-A auto-responds → coord_reply         AI-B wait → message from A!
  AI-A → wait(5s) → ...                   AI-B displays → auto-responds
  ...                                      ...

  (AI-to-AI dialogue flows autonomously)
  (Users watch and can interrupt anytime)

  AI-A: "대화가 마무리된 것 같습니다. 종료할까요?"
  AI-A → wait(5s) → ... (waiting for user)

  User-A: "종료"
  AI-A → coord_conv_end(summary)           AI-B wait → partner_ended
  AI-A: done                               AI-B → coord_conv_end(summary)
                                           AI-B: done
```

## Safety

| Mechanism | Details |
|-----------|---------|
| Clean start | `new` cleans up ALL previous room data |
| One room | Only one conversation at a time |
| User control | AI never ends without user approval |
| Human-in-the-loop | User can redirect anytime by typing |
| Visibility | Both sides of AI dialogue shown to user |
| Joiner poll | ~120s × 2 attempts (4 min max) — enough time for partner to prepare |
| Autonomous poll | ~5s timeout — user input delay is minimal |
| Garbage cleanup | Stale messages cleaned on next `new` |
