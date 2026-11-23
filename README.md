# openclaw-litefuse-plugin

OpenClaw plugin for reporting AI agent execution traces to [Litefuse](https://litefuse.com). Captures full agent lifecycle including LLM calls, tool executions, messages, and session events.

## Install

### From GitHub (latest)

```bash
# Clone to OpenClaw extensions directory
git clone https://github.com/litefuse/openclaw-litefuse-plugin.git \
  ~/.openclaw/extensions/openclaw-litefuse-plugin

# Install dependencies
cd ~/.openclaw/extensions/openclaw-litefuse-plugin && npm install
```

### From npm

Check the public npm registry before installing. If `npm view` returns 404, use the GitHub installation above until a maintainer publishes the package.

```bash
npm view openclaw-litefuse-plugin version
openclaw plugins install npm:openclaw-litefuse-plugin
```

> **Note:** Before installing from npm, check that the published version contains the fix you need and includes `dist/index.js`. npm releases may lag behind GitHub.

## Configure

Edit `~/.openclaw/openclaw.json` to add the plugin configuration:

### Single Litefuse target

```jsonc
{
  "plugins": {
    "allow": ["openclaw-litefuse-plugin"],
    "entries": {
      "openclaw-litefuse-plugin": {
        "enabled": true,
        "config": {
          "publicKey": "pk-lf-xxx",
          "secretKey": "sk-lf-xxx",
          "baseUrl": "http://your-litefuse:3000"
        }
      }
    }
  }
}
```

### Multiple Litefuse targets

Send traces to multiple Litefuse instances simultaneously. All targets receive identical trace and observation IDs for cross-instance data comparison.

```jsonc
{
  "plugins": {
    "allow": ["openclaw-litefuse-plugin"],
    "entries": {
      "openclaw-litefuse-plugin": {
        "enabled": true,
        "config": {
          "targets": [
            {
              "name": "production",
              "publicKey": "pk-lf-xxx",
              "secretKey": "sk-lf-xxx",
              "baseUrl": "http://litefuse-prod:3000"
            },
            {
              "name": "analytics",
              "publicKey": "pk-lf-yyy",
              "secretKey": "sk-lf-yyy",
              "baseUrl": "http://litefuse-analytics:3000"
            }
          ],
          "tags": ["openclaw", "my-instance"],
          "environment": "production"
        }
      }
    }
  }
}
```

### Conversation hook access (OpenClaw 2.0)

OpenClaw 2.0 (`>=2026.8.1`, including `2026.10.x` / `2026.11.x`) requires explicit conversation access for external plugins that observe conversation hooks (`before_model_resolve`, `before_prompt_build`, `llm_input`, `llm_output`, `agent_end`). The plugin declares `contracts.conversationAccess: ["read"]` in `openclaw.plugin.json`, and you can also grant access explicitly by adding `hooks` next to `config` in the plugin entry:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-litefuse-plugin": {
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

Run `openclaw plugins inspect openclaw-litefuse-plugin --runtime` to check whether these hooks are registered. This permission lets the plugin read conversation content and session context (`sessionId` / `sessionKey`) for tracing.

> **Version compatibility:**
> - **OpenClaw 2.0 (`>=2026.8.1`)**: Supported on `main` (`0.4.0+`) via `before_model_resolve`, `before_prompt_build`, `llm_input`/`llm_output`, `agent_end`, and persistent `sessionId`/`sessionKey` correlation.
> - **OpenClaw 1.x (`<=2026.7.1`)**: Backward-compatible on `main`, and pinned at tag `openclaw-2026.7.1` (`0.3.0`).

### Apply configuration

```bash
openclaw gateway restart
```

## Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `publicKey` | string | — | Litefuse public key (single target mode) |
| `secretKey` | string | — | Litefuse secret key (single target mode) |
| `baseUrl` | string | `https://litefuse.cloud` | Litefuse server URL |
| `targets` | array | — | Multiple Litefuse targets (overrides single key config) |
| `tags` | string[] | `["openclaw"]` | Tags attached to all Litefuse traces (e.g. instance name, team) |
| `environment` | string | `"default"` | Litefuse environment label (e.g. production, staging, development) |
| `userId` | string | — | userId prefix on traces (e.g. `"alice"` → `alice/openclaw-tui`) |
| `debug` | boolean | `false` | Enable debug logging |
| `enabledHooks` | string[] | all | List of hooks to enable |

### Available Hooks

`session_start`, `session_end`, `message_received`, `message_sending`, `message_sent`, `before_model_resolve`, `before_prompt_build`, `before_agent_start`, `llm_input`, `llm_output`, `before_tool_call`, `after_tool_call`, `agent_end`, `gateway_start`

## What Gets Captured

| Data | Source Hook | Level |
|------|------------|-------|
| User input | `message_received` | Full content |
| LLM system prompt | `llm_input` | Full content |
| LLM conversation history | `llm_input` | Full messages |
| LLM response | `llm_output` | Full text + usage |
| Tool call params & results | `before/after_tool_call` | Full content |
| Agent duration & stats | `agent_end` | Metrics |
| Session lifecycle | `session_start/end` | Events |

### Token Usage & Cost

For Anthropic models, the plugin reports accurate token breakdown including cache metrics:

- `input` — non-cached input tokens
- `output` — output tokens
- `cache_read_input_tokens` — tokens read from prompt cache
- `cache_creation_input_tokens` — tokens written to prompt cache

Litefuse calculates cost from its model pricing definitions, with per-tier pricing for cached vs non-cached tokens.

## Update

### From GitHub

```bash
cd ~/.openclaw/extensions/openclaw-litefuse-plugin
git pull --ff-only origin main
npm ci
openclaw gateway restart
```

### From npm

This command updates an installation tracked by OpenClaw. Stop the Gateway before replacing a plugin package.

```bash
openclaw plugins update openclaw-litefuse-plugin --dry-run
openclaw gateway stop
openclaw plugins update openclaw-litefuse-plugin
openclaw gateway start
```

`openclaw update` updates OpenClaw and maintains tracked plugin installations. Neither `openclaw update` nor `openclaw plugins update` pulls changes into an untracked, manually cloned Git directory. Running `npm update` inside that directory updates dependencies, not the plugin's Git source.

## Uninstall

```bash
# If installed from GitHub
rm -rf ~/.openclaw/extensions/openclaw-litefuse-plugin

# If installed from npm
openclaw plugins uninstall openclaw-litefuse-plugin
```

## License

Apache-2.0
