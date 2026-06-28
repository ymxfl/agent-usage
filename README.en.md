# agent-usage

**English** | [简体中文](README.md)

**Local-first usage statistics for coding agents.**

`agent-usage` records how often a coding agent loads Skills and calls MCP tools, then
answers `/usage-stats` from inside the agent. It is designed to be accurate where an
agent exposes a real event surface, honest about where it can only estimate, and silent
about your prompts and data — it stores counts and metadata, never content.

The current release targets **Claude Code**, **JoyCode**, and **Codex**, with all agent-specific
behavior isolated behind a versioned adapter contract so the storage and reporting core
stays agent-agnostic.

---

## Why

Coding agents increasingly route work through Skills and MCP servers, but there is rarely
a clear answer to *"which Skills do I actually use, which MCP tools are slow, and which
ones are failing?"* `agent-usage` gives you that answer locally, without shipping your
data anywhere.

## How it works

Each agent adapter picks the best available observation strategy for what it can actually
see, and every recorded event is tagged with its **evidence** so reports never collapse
exact and estimated counts into one misleading number.

| Strategy | What it observes | Evidence | Precision |
| --- | --- | --- | --- |
| **Native hooks** (Claude Code, Codex) | Exact platform Skill invocations or MCP tool calls through platform hooks | `native_hook` | `exact` |
| **Injected MCP accounting** (JoyCode, Codex) | A managed instruction that asks the agent to call `record_skill` every time an injected Skill is used | `injected_mcp` | `best_effort` |
| **stdio MCP proxy** (JoyCode) | A transparent JSON-RPC proxy that relays stdio MCP traffic and records attempts, outcomes, and durations | `mcp_proxy` | `exact` |
| **Codex session-log sync** (Codex) | Reads MCP completion events from `~/.codex/sessions/**/*.jsonl` when native hooks are unavailable or untrusted | `session_log` | `exact` |

### What is counted

- **Injected Skill accounting events** (`skill_session_load`) — the portable
  best-effort metric used by injected adapters. The event name is retained for schema
  compatibility, but repeated `record_skill` calls are counted when the agent follows
  the injected instruction.
- **Skill invocations** (`skill_invocation`) — every native Skill invocation, where the
  adapter supports it (Claude Code).
- **MCP calls** (`mcp_call`) — each tool request is an attempt with an outcome of
  `success`, `failure`, or `unknown` (started but the connection/process ended before a
  result).

The `usage-stats` server's own `record_skill` and `query_usage` calls are excluded from
MCP totals, and calls denied before execution are not counted as executed calls.

## Supported agents

| Agent | Skills (native hook) | Skills (injected) | MCP (native) | MCP (session log) | MCP (stdio proxy) | Skill watching |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| `claude-code` | ✅ | ✅ | ✅ | — | — | — |
| `joycode` | — | ✅ | — | — | ✅ | ✅ |
| `codex` | — | ✅ | ✅ | ✅ | — | — |

The Codex adapter currently scans only first-level user Skills under
`~/.codex/skills` and skips hidden directories such as `.system`.

## Privacy

By design, `agent-usage` **never stores**:

- Prompts or conversation messages
- Skill body content
- MCP arguments or results
- Environment variables, API keys, or auth headers

Stored paths are limited to local installation state. Telemetry uses stable IDs and
optional project display names rather than full paths. The proxy only inspects the
JSON-RPC method and tool name required for aggregation — nothing more.

## Requirements

- **Node.js ≥ 24** (uses the built-in `node:sqlite`)
- A supported coding agent (Claude Code, JoyCode, and/or Codex)

## Build

The CLI ships as a single bundled ESM file. Clone and build it:

```bash
git clone https://github.com/ymxfl/agent-usage.git
cd agent-usage
npm install
npm run build      # -> dist/agent-usage.mjs
```

Then either invoke it directly or make the binary available on your `PATH`:

```bash
node dist/agent-usage.mjs --help
# or
npm link           # exposes the `agent-usage` command
```

Useful npm scripts:

| Script | Purpose |
| --- | --- |
| `npm run build` | Bundle `src/cli.ts` to `dist/agent-usage.mjs` (esbuild) |
| `npm run check` | Type-check with `tsc --noEmit` |
| `npm test` | Run the Vitest suite |
| `npm run test:watch` | Watch-mode tests |

## Usage

All collection is **opt-in**. A fresh install records nothing until you explicitly select
targets with `configure`.

For day-to-day setup, run the interactive wizard and follow the menus:

```bash
agent-usage
```

The wizard lets you choose an operation, choose an agent, and multi-select Skills and
MCP servers when configuring targets. The explicit commands below remain available for
scripts and repeatable setup.

### 1. Install for an agent

Installs the accounting MCP server, the `/usage-stats` command, and (for Claude Code) the
native hooks — at user scope by default.

```bash
agent-usage install claude-code
agent-usage install joycode
agent-usage install codex
```

### 2. See what can be observed

```bash
agent-usage list-targets claude-code
agent-usage list-targets codex
```

Lists discovered Skills and MCP servers with the modes each supports, what is currently
selected, unresolved patterns, and any issues. `health` reports the same coverage without
mutating configuration.

### 3. Select what to collect

Patterns are case-sensitive, anchored to the full name, and support `*` wildcards. MCP
identifiers use `server` or `server.tool`; selecting a server selects all its tools.

```bash
# Specific Skills, by evidence mode
agent-usage configure claude-code --native-skill review --inject-skill deploy

# An MCP server (and its tools)
agent-usage configure claude-code --mcp 'github.*'

# Or select everything in one shot
agent-usage configure joycode --all-skills injected_mcp --all-mcp
```

Repeated options build the **complete desired allowlist** (they replace, they don't
append). The resulting policy lives at `~/.agent-usage/config.json` and is shared by the
CLI, hooks, injectors, watchers, and proxies.

```json
{
  "version": 1,
  "agents": {
    "claude-code": {
      "skills": { "native_hook": ["review"], "injected_mcp": ["deploy"] },
      "mcp": ["github.*"]
    },
    "joycode": {
      "skills": { "injected_mcp": ["deploy", "release-*"] },
      "mcp": ["github", "filesystem"]
    }
  }
}
```

### 4. Ask for the report

From inside the agent:

```
/usage-stats
```

…or from the terminal. Defaults to the last 7 days.

```bash
agent-usage report              # last 7 days
agent-usage report today
agent-usage report 30d --agent claude-code --kind mcp_call
```

The report breaks down totals by agent and evidence/precision, lists top Skills, and shows
MCP attempts with success / failure / unknown outcomes and average duration, plus coverage
warnings (`best-effort`, `stdio-only`, read-only Skills, hook policy blocks, pending sync).

```text
Usage statistics — 7d

Totals
- claude-code · skill_session_load · [native_hook, exact]: 42
- claude-code · mcp_call · [native_hook, exact]: 128
- joycode · skill_session_load · [injected_mcp, best_effort]: 7

Skills
- claude-code · review: 42

MCP
- claude-code · github.create_issue: 5 attempts (success 5, failure 0, unknown 0); avg 318 ms

Coverage warnings
- Injected MCP skill usage is best-effort and may be incomplete.
```

### 5. Webhooks and local web console

You can forward every newly recorded usage event to an HTTP webhook. Duplicate events
ignored by the local database are not reported again, and webhook failures never block
the agent.

```bash
agent-usage webhook set https://example.test/usage
agent-usage webhook show
agent-usage webhook unset
```

For local inspection, start the browser console:

```bash
agent-usage web
```

It listens on `http://127.0.0.1:17891` by default. The page can view targets, run common
install/sync/repair/uninstall operations with confirmation and result messages, read table
reports, configure the webhook URL, and set it to the built-in local receiver
(`/webhook/usage`) so you can watch usage events arrive in real time. Enabled Skills and
MCP servers are shown first, and Skill mode selectors use distinct colors for disabled,
native-hook, and injected accounting modes.

### Lifecycle commands

| Command | Purpose |
| --- | --- |
| `install <agent>` | Register the MCP server, command, and hooks |
| `sync [agent]` | Instrument newly discovered Skills; wrap new stdio MCP servers; sync Codex session logs |
| `health [agent]` | Report coverage without changing anything |
| `repair [agent]` | Restore missing managed entries from the manifest |
| `uninstall <agent>` | Remove managed blocks/entries; preserves unrelated config |
| `uninstall <agent> --purge-data -y` | Also delete the shared database (after the last adapter is gone) |

`uninstall` preserves `~/.agent-usage/usage.db` by default, so removing one agent never
erases another's history. `--purge-data` is refused until every adapter is removed and is
guarded by `--yes` in non-interactive sessions.

### Internal commands

`agent-usage mcp --agent <id>` runs the accounting MCP server (exposing `record_skill` and
`query_usage`), and `agent-usage proxy --agent <id> --server <name> <command…>` runs the
stdio MCP proxy. These are wired in automatically by `install`/`sync`; you normally don't
invoke them by hand.

## Architecture

```text
Agent session
  ├─ Agent adapter
  │   ├─ native hooks, and/or
  │   ├─ injected Skill accounting, and/or
  │   ├─ stdio MCP proxy, and/or
  │   └─ Codex session-log sync
  ├─ usage-stats MCP server
  │   ├─ record_skill
  │   └─ query_usage
  └─ local core
      ├─ event normalization
      ├─ selection policy
      ├─ deduplication
      ├─ SQLite WAL storage
      └─ aggregation / reporting
```

The **core** owns event schema validation and migration, stable Skill ID generation,
SQLite WAL writes with bounded busy retries, deduplication, time-range aggregation, and
terminal report rendering. It has **no** agent-specific path logic.

Each **adapter** composes three strategy interfaces — `SkillInstrumentationStrategy`,
`McpObservationStrategy`, and `ConfigMutationStrategy` — and implements the
[`AgentAdapter`](src/adapters/types.ts) contract:

```ts
interface AgentAdapter {
  readonly id: string;
  readonly capabilities: Capabilities;
  discover(): Promise<string[]>;
  listTargets(): Promise<DiscoveredTargets>;
  configure(policy: AgentSelectionPolicy): Promise<OperationResult[]>;
  install(scope: Scope): Promise<OperationResult[]>;
  sync(scope: Scope): Promise<OperationResult[]>;
  repair(scope: Scope): Promise<OperationResult[]>;
  uninstall(scope: Scope): Promise<OperationResult[]>;
  health(): Promise<CoverageReport>;
  createMcpLifecycle?(): Promise<McpLifecycle | undefined>;
}
```

**Adding an agent** requires a new adapter, strategy selection, configuration fixtures,
and contract tests — never changes to core storage or reporting.

Data lives under `~/.agent-usage/`:

```text
~/.agent-usage/
├── usage.db            # SQLite (WAL mode)
├── config.json         # selection policy
├── state/
│   ├── installs.json
│   ├── joycode-*.json
│   └── codex-*.json
└── logs/
    └── errors.log
```

Storage errors are logged and **never block** the original agent, Skill, or MCP call —
collection is fail-open.

## Project structure

```text
src/
├── cli.ts                  # commander CLI entrypoint
├── core/                   # agent-agnostic: db, events, query, selection, repository
├── adapters/
│   ├── claude/             # Claude Code: native hooks + plugin files
│   ├── codex/              # Codex: Skill injection + hooks.json + config.toml + session-log sync
│   ├── joycode/            # JoyCode: injected accounting + stdio proxy + skill watcher
│   ├── registry.ts
│   └── types.ts            # AgentAdapter contract
├── mcp/                    # usage-stats MCP server + service
├── proxy/                  # transparent stdio JSON-RPC proxy + protocol observer
└── report/                 # terminal report rendering
tests/                      # Vitest — core, adapters, injection, proxy, integration
scripts/build.mjs           # esbuild bundle
docs/superpowers/           # design spec and implementation plans
```

## Known limitations

- **JoyCode Skill telemetry is best-effort** — it depends on the model following the
  injected instruction. The instruction requests a `record_skill` call on every Skill
  use, including repeated uses in one session, but JoyCode can still miss counts if the
  model reuses cached context or skips the accounting call.
- **JoyCode remote MCP transports** (HTTP/SSE/Streamable HTTP) are not counted in this
  release; only stdio MCP traffic that traverses the proxy is observed exactly.
- A **newly created JoyCode Skill can race** with the watcher during the session it is
  created; reconciliation is guaranteed for the next invocation or next session, not for
  zero-loss same-session injection.
- **Codex Skill telemetry is injected** and currently covers only user Skills under
  `~/.codex/skills`.
- **Codex MCP telemetry prefers native hooks and falls back to session-log sync**. If a
  Codex hook has not been trusted through `/hooks`, `sync codex` or
  `agent-usage mcp --agent codex` can still backfill selected MCP completion events from
  local session logs.
- The web console is local-only; there is no hosted dashboard.

See the [design spec](docs/superpowers/specs/2026-06-18-cross-agent-usage-stats-design.md)
for the full objectives, counting semantics, and acceptance criteria.

## Development

```bash
npm install
npm run check     # type-check
npm test          # full suite
```

All file mutations are transactional at the file level: parse and validate before
mutation, write to a sibling temp file, preserve permissions, atomically rename into
place, and update the state manifest only after success. Conflicting user edits are never
overwritten silently.

## License

[MIT](LICENSE) © 2026 ymxfl
