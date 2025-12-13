# @mariozechner/pi-agent-core

General-purpose agent runtime built on top of `@mariozechner/pi-ai`.

This package provides:
- An `Agent` state machine that executes multi-turn runs
- Streaming event subscription (`AgentEvent`) for UIs/CLIs
- Tool execution plumbing (`AgentTool`) with TypeBox schemas
- A transport abstraction (`ProviderTransport`) for multi-provider support

It is used by:
- `@mariozechner/pi-coding-agent` (interactive CLI)
- `@mariozechner/pi-mom` (Slack bot)
- `@mariozechner/mom-discord` (Discord bot)

## Install

```bash
npm install @mariozechner/pi-agent-core
```

## Quick Usage

```ts
import { Agent, ProviderTransport } from "@mariozechner/pi-agent-core";
import { getModel, Type } from "@mariozechner/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are helpful.",
    model: getModel("anthropic", "claude-sonnet-4-5"),
    thinkingLevel: "off",
    tools: [
      {
        name: "echo",
        label: "echo",
        description: "Echo a string",
        parameters: Type.Object({ label: Type.String(), text: Type.String() }),
        execute: async (_id, { text }) => ({ content: [{ type: "text", text }], details: undefined }),
      },
    ],
  },
  transport: new ProviderTransport({ getApiKey: async () => process.env.ANTHROPIC_API_KEY! }),
});

agent.subscribe((event) => {
  if (event.type === "message_end") console.log(event.message);
});

await agent.prompt("hello");
```

