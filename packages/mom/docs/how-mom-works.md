# How Mom Works

Core behaviors that apply across both Slack and Discord transports.

---

## Startup Behavior

When mom starts, it performs the following:

1. **Connect** - Establishes connection to the platform (WebSocket for Slack, Gateway for Discord)
2. **Load metadata** - Fetches channel and user lists for context
3. **Backfill messages** - Syncs missed messages from channels mom has previously interacted with
4. **Apply profile** - Applies any configured profile settings

---

## Message Backfill

Mom automatically backfills message history on startup to maintain conversation context.

### How it works

- Only channels with existing `log.jsonl` files are backfilled (channels mom has interacted with before)
- Fetches messages newer than the last logged message
- Filters out system messages and other bots (keeps mom's own messages)
- Processes attachments and strips @mentions
- Appends to `log.jsonl` in chronological order

### Limits

- Maximum 3 pages of history per channel
- Slack: 1000 messages per page
- Discord: 100 messages per page

### Required permissions

| Platform | Permissions |
|----------|-------------|
| Slack | `channels:history`, `groups:history`, `im:history`, `mpim:history` |
| Discord | Read Message History |

---

## Message Logging

All messages in channels mom monitors are logged to `<channel>/log.jsonl`:

```json
{"date":"2025-01-15T10:30:00.000Z","ts":"1705312200.000000","user":"U123","userName":"mario","text":"hello mom","attachments":[],"isBot":false}
```

This log serves two purposes:
1. **Backfill deduplication** - Prevents re-logging messages on restart
2. **Historical context** - Mom can search `log.jsonl` for older conversation history beyond its context window

---

## Context Management

Mom maintains two files per channel:

| File | Purpose |
|------|---------|
| `log.jsonl` | Raw message log (user messages + bot responses) |
| `context.jsonl` | LLM context (includes tool results, session headers) |

On each interaction:
1. **Sync** - New messages from `log.jsonl` are synced to `context.jsonl`
2. **Prompt** - User message is added to context
3. **Run** - Agent executes with full context
4. **Compact** - If context exceeds limits, older entries are summarized

---

## Workspace Structure

```
<workspace>/
  settings.json           # Global settings
  memory.md               # Persistent memory (editable by mom)
  discord/
    <guildId>/
      <channelId>/
        log.jsonl
        context.jsonl
        attachments/
    dm/
      <channelId>/
        ...
  <slackChannelId>/       # Slack channels at root level
    log.jsonl
    context.jsonl
    attachments/
```

---

## Idle Detection

Mom tracks activity per channel. After a configurable idle period (default: 1 hour), the next interaction is treated as a "session start" which can trigger additional context injection (e.g., reaction summaries if enabled).

---

## Silent Responses

For periodic/scheduled events where there's nothing actionable, mom can respond with `[SILENT]` to suppress output. This deletes any status message and posts nothing to the channel.
