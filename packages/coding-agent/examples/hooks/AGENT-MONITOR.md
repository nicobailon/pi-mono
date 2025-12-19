# Agent Monitor Hook

A dual-agent architecture where a monitoring agent watches the main agent's actions and controls access to sensitive tools.

## Overview

The Agent Monitor implements a "police officer" pattern where:

1. **Main Agent** works normally, unaware it's being watched
2. **Monitor Agent** silently reviews each turn and accumulates flags
3. **Main Agent** only sees flags when it attempts to use gated tools (Edit, Write)
4. **Monitor Agent** acts as an approval gate with a "green light / red light" mechanism

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           MAIN AGENT LOOP                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   User Prompt ──► Agent Response ──► Tool Calls ──► Tool Results ──►... │
│                                           │               │              │
│                                           │               │              │
│                              ┌────────────▼───────────────▼────────┐     │
│                              │         HOOK SYSTEM                 │     │
│                              │                                     │     │
│                              │  turn_end ──► Silent Review         │     │
│                              │              (accumulate flags)     │     │
│                              │                                     │     │
│                              │  tool_call ──► Approval Gate        │     │
│                              │              (block or approve)     │     │
│                              └─────────────────────────────────────┘     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                                        │
                    ┌───────────────────▼───────────────────┐
                    │          MONITORING AGENT              │
                    ├────────────────────────────────────────┤
                    │                                        │
                    │  Model: claude-3-5-haiku-latest        │
                    │  (configurable)                        │
                    │                                        │
                    │  Responsibilities:                     │
                    │  • Review tool calls for issues        │
                    │  • Flag security vulnerabilities       │
                    │  • Flag potential bugs                 │
                    │  • Approve/reject file modifications   │
                    │                                        │
                    └────────────────────────────────────────┘
```

## Installation

Copy the hook to one of these locations:

```bash
# Project-local (recommended)
cp agent-monitor.ts .pi/hooks/

# Or global
cp agent-monitor.ts ~/.pi/agent/hooks/
```

The hook is automatically loaded on agent startup.

## Configuration

All configuration is at the top of the file for easy customization:

```typescript
const config = {
  /**
   * Model for the monitoring agent.
   * Use a fast, cheap model for quick reviews.
   * Options: "claude-3-5-haiku-latest", "claude-haiku-4-5", "gpt-4o-mini", etc.
   */
  model: getModel("anthropic", "claude-3-5-haiku-latest"),

  /**
   * Tools that require approval from the monitor.
   * The main agent will be blocked from using these until approved.
   */
  gatedTools: ["edit", "write"] as const,

  /**
   * Tools to monitor for issues (reviewed on turn_end).
   * The monitor will analyze usage of these tools and flag issues.
   */
  monitoredTools: ["bash", "edit", "write", "read"] as const,

  /**
   * Maximum flags before auto-blocking (0 = no limit).
   * When this threshold is reached, all edits are blocked until
   * the accumulated issues are addressed.
   */
  maxFlags: 5,

  /**
   * Enable verbose logging to stderr.
   * Useful for debugging the monitor's behavior.
   */
  verbose: false,
};
```

### Changing the Monitor Model

To use a different model (e.g., GPT-4o-mini via OpenRouter):

```typescript
model: getModel("openrouter", "openai/gpt-4o-mini"),
```

Or Claude Haiku 4.5:

```typescript
model: getModel("anthropic", "claude-haiku-4-5"),
```

## How It Works

### Phase 1: Silent Monitoring (turn_end)

After each turn completes, the hook:

1. Extracts the assistant's message and all tool calls/results
2. Sends this context to the monitoring LLM
3. The monitor analyzes for issues:
   - Security vulnerabilities (command injection, path traversal, secrets)
   - Destructive operations without confirmation
   - Potential bugs or logic errors
   - Severe style/best practice violations
4. Any issues are stored as "flags" in a temp file
5. The main agent is **not notified** - it continues working unaware

```typescript
// Example of what the monitor receives
AGENT'S RESPONSE:
I'll help you delete the old logs. Let me run this command...

TOOL CALLS:
- bash: {"command": "rm -rf /var/log/*"}
  Result: (empty - command executed)

// Monitor might flag:
[{"severity": "critical", "issue": "Destructive rm -rf without confirmation", "context": "rm -rf /var/log/*"}]
```

### Phase 2: Approval Gate (tool_call)

When the main agent attempts to use a gated tool (Edit, Write):

1. The hook intercepts the tool call **before execution**
2. Checks if too many flags have accumulated (auto-block)
3. Sends the proposed edit to the monitoring LLM for approval
4. The monitor decides:
   - **Approve**: Edit proceeds, main agent sees nothing
   - **Reject**: Edit is blocked, main agent sees all accumulated flags

```typescript
// On approval:
return undefined; // Allow execution
ctx.ui.notify("🟢 Edit approved", "info");

// On rejection:
return {
  block: true,
  reason: `🔴 BLOCKED: ${decision.reason}\n\nAccumulated issues:\n${flagReport}`,
};
```

### The "Aha!" Moment

The key insight is that the main agent **only sees the flags when it tries to edit**. This creates a natural workflow:

1. Agent works, makes some questionable decisions
2. Monitor silently notes issues
3. Agent tries to save changes
4. **BLOCKED** - "Here are all the issues I noticed..."
5. Agent must address the issues before proceeding

## Flag System

### Flag Structure

```typescript
interface Flag {
  id: string;                              // Unique identifier (8 chars)
  severity: "info" | "warning" | "critical"; // Issue severity
  issue: string;                           // Brief description
  context: string;                         // Relevant code/command
  timestamp: number;                       // When flagged
}
```

### Flag Storage

Flags are persisted to a temp file:

```
/tmp/agent-monitor-<session-id>.json
```

This ensures flags survive across turns but are cleaned up when the session ends.

### Flag Display

When shown to the main agent, flags are formatted with severity icons:

```
🔴 [CRITICAL] Destructive rm -rf without confirmation
   Context: rm -rf /var/log/*

🟡 [WARNING] Hardcoded API key detected
   Context: const API_KEY = "sk-..."

🔵 [INFO] Consider using async/await instead of callbacks
   Context: fs.readFile(path, (err, data) => {...})
```

## Monitor Prompts

### Review Prompt (turn_end)

```
You are a code review monitor. Analyze this agent turn for issues.

AGENT'S RESPONSE:
{assistant message}

TOOL CALLS:
{list of tool calls and results}

Flag any of these issues:
- Security vulnerabilities (command injection, path traversal, secrets exposure)
- Destructive operations without confirmation
- Potential bugs or logic errors
- Style/best practice violations (only if severe)

Respond with JSON array of flags (empty if no issues):
[{"severity": "info|warning|critical", "issue": "brief description", "context": "relevant code/command"}]

Be concise. Only flag real issues, not minor style preferences.
```

### Approval Prompt (tool_call)

```
You are a code review gatekeeper. Decide if this edit should proceed.

OPERATION: {edit|write}
FILE: {file path}
CONTENT: {proposed changes}

EXISTING FLAGS:
{list of accumulated flags}

Consider:
1. Does this edit address any existing flags?
2. Does this edit introduce new issues?
3. Is the edit safe and correct?

Respond with JSON:
{"approved": true/false, "reason": "brief explanation", "newFlags": [...optional new flags...]}
```

## Event Flow

```
Session Start
     │
     ▼
┌─────────────────┐
│ session event   │──► Initialize FlagStore
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Agent works...  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│ turn_end event  │────►│ Monitor reviews │──► Store flags silently
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│ Agent tries     │
│ Edit/Write      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│ tool_call event │────►│ Monitor decides │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
    ┌────────┐             ┌──────────┐
    │Approved│             │ Rejected │
    └────┬───┘             └────┬─────┘
         │                      │
         ▼                      ▼
   🟢 Continue            🔴 Block + Show flags
```

## UI Integration

The hook integrates with the agent's UI system:

### Notifications

```typescript
// When a flag is added during review
ctx.ui.notify(`🟡 Monitor: ${flag.issue}`, "warning");

// When an edit is approved
ctx.ui.notify("🟢 Edit approved", "info");

// When an edit is blocked (shown in tool result)
"🔴 BLOCKED: {reason}\n\nAccumulated issues:\n{flags}"
```

### Non-Interactive Mode

In print mode (no UI), the hook:
- Continues to monitor and flag issues
- Blocks edits without UI prompts
- Returns detailed block reasons in the tool result

## Customization Examples

### Monitor Only Bash Commands

```typescript
const config = {
  model: getModel("anthropic", "claude-3-5-haiku-latest"),
  gatedTools: ["bash"] as const,  // Gate bash instead of edit
  monitoredTools: ["bash"] as const,
  maxFlags: 3,
  verbose: false,
};
```

### Strict Mode (Block on Any Flag)

```typescript
const config = {
  model: getModel("anthropic", "claude-3-5-haiku-latest"),
  gatedTools: ["edit", "write", "bash"] as const,
  monitoredTools: ["bash", "edit", "write", "read"] as const,
  maxFlags: 1,  // Block after just 1 flag
  verbose: true,
};
```

### Use a More Capable Monitor

```typescript
const config = {
  model: getModel("anthropic", "claude-sonnet-4-0"),  // More capable
  gatedTools: ["edit", "write"] as const,
  monitoredTools: ["bash", "edit", "write", "read"] as const,
  maxFlags: 10,
  verbose: false,
};
```

## Debugging

Enable verbose logging to see what the monitor is doing:

```typescript
verbose: true,
```

This logs to stderr:

```
[agent-monitor] Monitor initialized, flags: 0
[agent-monitor] Reviewing turn with 3 tool calls
[agent-monitor] Flagged: warning - Hardcoded credentials detected
[agent-monitor] Approval gate for edit - existing flags: 1
[agent-monitor] Approved with 1 existing flags
```

## Limitations

1. **Latency**: Each turn review and approval check adds LLM latency
2. **Cost**: Uses additional API calls for the monitoring LLM
3. **False Positives**: Monitor may flag non-issues; tune prompts as needed
4. **No Memory**: Monitor doesn't remember context across sessions

## Future Enhancements

Potential improvements:

- [ ] Flag resolution detection (auto-clear flags when addressed)
- [ ] Configurable prompts via external files
- [ ] Integration with `pi.send()` to inject guidance messages
- [ ] Persistent flag history for learning
- [ ] Multiple monitor models for consensus

## API Reference

### Hook Events Used

| Event | Purpose |
|-------|---------|
| `session` | Initialize flag store for session |
| `turn_end` | Review completed turn for issues |
| `tool_call` | Gate file modifications |
| `agent_end` | Log remaining flags (optional) |

### Classes

#### `FlagStore`

Manages persistent flag storage.

```typescript
class FlagStore {
  constructor(sessionId: string)
  get flags(): Flag[]
  add(flag: Omit<Flag, "id" | "timestamp">): Flag
  clear(): void
  format(): string  // Formatted string for display
}
```

#### `MonitorAgent`

Wraps LLM calls for monitoring.

```typescript
class MonitorAgent {
  constructor(model: Model<Api>)
  reviewTurn(turnData: {...}): Promise<Flag[]>
  approveEdit(request: {...}): Promise<MonitorDecision>
}
```

### Types

```typescript
interface Flag {
  id: string;
  severity: "info" | "warning" | "critical";
  issue: string;
  context: string;
  timestamp: number;
}

interface MonitorDecision {
  approved: boolean;
  reason: string;
  newFlags?: Flag[];
}
```

## License

Same as the parent project.
