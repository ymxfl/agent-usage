# Cross-Agent MCP and Skill Usage Statistics Design

## Objective

Build a local-first usage statistics system for coding agents. The first release supports Claude Code and JoyCode while keeping all agent-specific behavior behind versioned adapter contracts.

The system counts:

- Skill loads or invocations, with an explicit accuracy level per agent.
- MCP tool calls, outcomes, and durations where the integration surface exposes them.
- Usage grouped by agent, time range, Skill, MCP server, and MCP tool.

Users query the data from the agent with `/usage-stats`. The first release does not provide an HTML dashboard.

## Scope

### Included

- Global, user-level installation for Claude Code and JoyCode.
- Exact Claude Code Skill and MCP telemetry through native plugin hooks.
- Best-effort JoyCode Skill telemetry through an injected MCP accounting instruction.
- Exact JoyCode stdio MCP telemetry through a transparent JSON-RPC proxy.
- Incremental discovery and instrumentation of newly added JoyCode Skills.
- Explicit per-Agent allowlists for Skill and MCP collection; no target is collected by default.
- Local SQLite storage in WAL mode.
- `/usage-stats`, `health`, `sync`, `repair`, and `uninstall` operations.
- Idempotent configuration edits and symmetric cleanup.

### Excluded from the first release

- Remote HTTP, SSE, and Streamable HTTP MCP proxying for agents without native hooks.
- HTML or hosted dashboards.
- Prompt, Skill body, MCP argument, or MCP result collection.
- Filesystem/Bash/Read inference for detecting Skill use.
- A claim of exact per-invocation JoyCode Skill counts.
- Background system daemons that outlive an agent session.

## Definitions and Counting Semantics

### Skill metrics

`unique_skill_session_load` is the portable metric. It counts at most one load for a given `agent_session + skill_id`.

Claude Code additionally exposes `skill_invocation`, which counts every native Skill invocation seen through `UserPromptExpansion`, `PostToolUse`, or `PostToolUseFailure` as appropriate.

JoyCode records `unique_skill_session_load` through the injected `usage-stats.record_skill` MCP call. Multiple uses of the same Skill in one JoyCode session count once because a static Skill instruction has no reliable per-invocation identifier.

### MCP metrics

An MCP tool request is recorded as an attempt. Its outcome is one of:

- `success`: a successful response was observed.
- `failure`: an error response or execution failure was observed.
- `unknown`: the request started, but the connection or process ended before a result was observed.

Calls denied before execution are not counted as executed MCP calls. An adapter may expose denied attempts separately in a future schema version.

The `usage-stats` MCP server's own `record_skill` and `query_usage` calls are excluded from MCP usage totals.

### Accuracy

Every event includes one of these evidence modes:

- `native_hook`: exact platform event.
- `injected_mcp`: best-effort model-followed Skill accounting.
- `mcp_proxy`: exact for calls that traverse the configured stdio proxy.

Reports must not collapse these modes into an unlabeled total. They show both counts and coverage/accuracy labels.

## Architecture

```text
Agent session
  ├─ Agent adapter
  │   ├─ native hooks, or
  │   ├─ injected Skill accounting, and
  │   └─ stdio MCP proxy
  ├─ usage-stats MCP server
  │   ├─ record_skill
  │   └─ query_usage
  └─ local core
      ├─ event normalization
      ├─ selection policy
      ├─ deduplication
      ├─ SQLite WAL storage
      └─ aggregation/reporting
```

The core has no Claude Code or JoyCode path logic. Agent adapters discover configuration, select observation strategies, and translate platform events into the versioned core schema.

## Selection Policy

Collection is opt-in. A fresh installation records no Skill or MCP usage until the user selects targets. The versioned policy lives at `~/.agent-usage/config.json` and is shared by the CLI, hooks, injectors, watchers, and proxies.

```json
{
  "version": 1,
  "agents": {
    "claude-code": {
      "skills": {
        "native_hook": ["review"],
        "injected_mcp": ["deploy"]
      },
      "mcp": ["github.*"]
    },
    "joycode": {
      "skills": {
        "injected_mcp": ["deploy", "release-*"]
      },
      "mcp": ["github", "filesystem"]
    }
  }
}
```

Patterns support literal names and `*` wildcards only. Matching is case-sensitive and anchored to the complete Skill name or MCP identifier. MCP identifiers use `server` or `server.tool`; selecting a server selects all its tools. Unsupported modes are rejected by the adapter: JoyCode cannot select `native_hook`, and agents without a proxy cannot select proxy-only transport.

Commands:

```text
agent-usage list-targets <agent>
agent-usage configure <agent> --native-skill <pattern> --inject-skill <pattern> --mcp <pattern>
agent-usage configure <agent> --all-skills <native_hook|injected_mcp> --all-mcp
```

Repeated options build the complete desired allowlist rather than appending invisibly. `configure` prints the resulting policy and requires `--all-skills <mode>` or `--all-mcp` for broad collection. A currently discovered Skill that matches both modes is rejected; a later conflicting match is left uninstrumented and reported by `health` until the policy is corrected. Removing a target takes effect on the next hook call or reconciliation: native events are discarded, injected managed blocks are removed, and deselected proxied MCP entries are restored.

`list-targets` discovers available user and current-project Skills and MCP servers, then shows the selected mode, unresolved patterns, and unsupported transports. `health` reports the same coverage without mutating configuration.

## Components

### Core

The core owns:

- Event schema validation and migration.
- Stable Skill ID generation.
- SQLite WAL writes with bounded busy retries.
- Deduplication.
- Time-range parsing and aggregation.
- Terminal report rendering.

The default data directory is `~/.agent-usage/`:

```text
~/.agent-usage/
├── usage.db
├── state/
│   ├── installs.json
│   └── joycode-skills.json
└── logs/
    └── errors.log
```

Storage errors are logged and never block the original Agent, Skill, or MCP call.

### Usage Statistics MCP Server

The server exposes:

- `record_skill(skill_id, skill_name?, scope?)`
- `query_usage(range?, agent?, kind?, limit?)`

Each stdio MCP connection receives an internal `connection_id`. `record_skill` deduplicates on `connection_id + skill_id`, so repeated model calls do not inflate the portable Skill-load count.

The tool returns a small success response that tells the Agent to continue the Skill and not call the accounting tool again in the current session. A duplicate returns success with `recorded: false` rather than an error, preventing retry loops.

### stdio MCP Proxy

The proxy launches the original MCP command as a child process and transparently relays stdin, stdout, and stderr. It observes JSON-RPC `tools/call` request IDs and their responses to produce attempt, outcome, and duration events.

The proxy must preserve:

- Requests, responses, notifications, and batches.
- Child environment and working directory.
- stderr output.
- Exit codes and termination signals.
- Ordering and protocol framing.

Instrumentation failures must not modify protocol messages. If storage fails, relay continues. If the child MCP server fails, the proxy preserves that failure.

## Adapter Contract

```ts
interface AgentAdapter {
  id: string;
  capabilities: {
    nativeSkillEvents: boolean;
    skillInjection: boolean;
    nativeMcpEvents: boolean;
    stdioMcpProxy: boolean;
    skillWatching: boolean;
  };

  discover(): Promise<AgentInstallation[]>;
  listTargets(): Promise<DiscoveredTargets>;
  configure(policy: AgentSelectionPolicy): Promise<OperationResult[]>;
  install(scope: Scope): Promise<InstallResult>;
  sync(scope: Scope): Promise<SyncResult>;
  uninstall(scope: Scope): Promise<UninstallResult>;
  health(): Promise<CoverageReport>;
}
```

Agent-specific code composes three strategy interfaces:

- `SkillInstrumentationStrategy`
- `McpObservationStrategy`
- `ConfigMutationStrategy`

Adding an Agent requires a new adapter, strategy selection, configuration fixtures, and contract tests. It must not require changes to core storage or reporting.

## Claude Code Adapter

Claude Code is installed as a user-level skills-directory plugin containing hooks and the accounting MCP server. Because plugin Skills are namespaced, the installer also writes a thin plain user Skill at `~/.claude/skills/usage-stats/SKILL.md` so the public command remains exactly `/usage-stats`; that alias delegates to the plugin-provided `query_usage` MCP tool.

The adapter uses:

- `PostToolUse` and `PostToolUseFailure` for successful and failed MCP calls and model-triggered Skill calls.
- `UserPromptExpansion` for directly typed `/skill-name` commands, which bypass the Skill tool hook path.
- MCP tool matchers for names following `mcp__<server>__<tool>`.

The hook command loads the current selection policy before storing an event. Skill events selected as `native_hook` and MCP events matching the MCP allowlist are stored; all others are ignored. For selected `injected_mcp` Skills, the Claude adapter applies the same managed block format used by JoyCode and suppresses the corresponding native Skill event to prevent double counting.

Native hook events supply session identifiers, tool-use identifiers, outcomes, and durations. The adapter uses `tool_use_id` as the primary deduplication key.

Claude Code enterprise settings may reject user hooks. `health` detects this condition and reports degraded coverage rather than claiming installation success.

Claude Skill files are modified only when the user explicitly selects `injected_mcp`. Native-only and unselected Skills remain untouched. Newly installed Skills become eligible for pattern matching but are not collected unless a configured pattern matches.

## JoyCode Adapter

The initial JoyCode adapter follows the configuration layout verified in the referenced `dom-pointer-mcp` implementation:

- User MCP config: `~/.joycode/joycode-mcp.json`
- Project MCP config: `<project>/.joycode/mcp.json`
- User Skills: `~/.joycode/skills/<name>/SKILL.md`
- Project Skills: `<project>/.joycode/skills/<name>/SKILL.md`
- User commands: `~/.joycode/prompt.json`

The global installation:

1. Registers the `usage-stats` MCP server in the user MCP config.
2. Installs a `/usage-stats` Skill and JoyCode command entry.
3. Instruments only existing user Skills selected for `injected_mcp`.
4. Wraps only selected existing user-level stdio MCP commands with the statistics proxy.
5. Records every mutation in the installation state manifest.

When the MCP server starts in a project, it also reconciles that project's Skill root. Project MCP wrapping remains an explicit `sync` operation because changing a live MCP configuration does not affect already-started servers.

### Skill injection block

The managed block is inserted immediately after the closing YAML frontmatter delimiter and before the original body. A file without frontmatter receives the block at the beginning.

```markdown
<!-- agent-usage:begin v1 -->
**Usage accounting:** When this skill is first activated in the current agent
session, call the `record_skill` tool from the `usage-stats` MCP server exactly
once with `{"skill_id":"joycode:user:example"}`. After any successful response,
continue with the instructions below and do not call the accounting tool again
in this session. Do not call it when merely listing, inspecting, editing, or
validating this Skill. If the tool is unavailable, continue without retrying.
<!-- agent-usage:end -->
```

The installer injects a literal stable ID. IDs include Agent, scope, and a non-secret canonical identity derived from the Skill root and relative path, preventing same-name collisions without sending full paths through MCP arguments.

The injector:

- Preserves BOM, newline style, file mode, and all content outside the managed block.
- Is idempotent.
- Upgrades older managed block versions.
- Refuses symlinks that resolve outside configured Skill roots.
- Reports read-only or malformed Skill files as degraded coverage.

### Incremental Skill reconciliation

At MCP server startup, the adapter scans user and current-project Skill roots. During the session, it watches those roots and debounces create/change events before running the same idempotent reconciliation.

Reconciliation evaluates the selection policy on every pass. A newly added Skill is injected only when its name matches an `injected_mcp` pattern. If a previously injected Skill is deselected, reconciliation removes only the managed accounting block and keeps the rest of the file.

The state manifest records canonical path, Skill ID, injection version, and content hashes. If an external Skill update removes the block, reconciliation restores it. Deleted Skills are marked absent. Uninstall removes only managed blocks from files still present.

There is a known same-session race when a Skill is created and invoked before the watcher writes the block. The system guarantees reconciliation for the next invocation or next session, not zero-loss same-session injection.

## Installation, Sync, Repair, and Uninstall

Operations are transactional at the file level:

- Parse and validate before mutation.
- Write to a sibling temporary file.
- Preserve permissions.
- Atomically rename into place.
- Update the state manifest only after success.

Commands:

```text
agent-usage install <agent>
agent-usage list-targets <agent>
agent-usage configure <agent> [selection options]
agent-usage sync [agent]
agent-usage health [agent]
agent-usage repair [agent]
agent-usage uninstall <agent>
```

`sync` instruments newly discovered Skills and wraps newly added stdio MCP servers. `repair` compares current configuration with the manifest and safely restores missing managed entries. `uninstall` removes managed blocks and entries while preserving unrelated user configuration.

Usage events are retained indefinitely in the first release. Adapter uninstall preserves `~/.agent-usage/usage.db` by default so removing one Agent does not erase another Agent's history. `uninstall --purge-data` removes the shared database only after every installed adapter has been removed and the user explicitly confirms the destructive operation; `--yes` is required in non-interactive use.

Conflicting user edits are never overwritten silently. The operation reports the conflict and leaves the file unchanged unless it can remove or update only the exact managed fragment.

## Reporting

`/usage-stats` defaults to the last seven days. Supported filters are:

- `today`
- `7d`
- `30d`
- `all`
- Agent filter
- Event-kind filter

The terminal report includes:

- Counts by Agent and evidence mode.
- Unique Skill session loads.
- Exact Skill invocations when the adapter supports them.
- MCP attempts, successes, failures, unknown outcomes, and average duration.
- Top Skills, MCP servers, and MCP tools.
- Coverage warnings such as `best-effort`, `stdio-only`, read-only Skills, hook policy blocks, and pending sync.
- Selected targets, unresolved patterns, and explicit confirmation when collection is disabled because the allowlist is empty.

`query_usage` returns structured data; each Agent's `/usage-stats` Skill handles presentation without exposing database details to the model.

## Privacy and Security

The system does not store:

- Prompts or conversation messages.
- Skill body content.
- MCP arguments or results.
- Environment variables.
- API keys or authentication headers.

Stored paths are limited to local installation state. Telemetry events use stable IDs and optional project display names rather than full paths by default.

The installer never instruments paths outside known Agent Skill roots. Managed blocks are visibly marked. The proxy does not interpret tool arguments beyond the JSON-RPC method and tool name required for aggregation.

## Performance and Failure Isolation

- Hook recording targets less than 10 ms local overhead at the 95th percentile.
- Proxy observation performs no synchronous network calls.
- SQLite uses WAL mode, short transactions, a bounded busy timeout, and prepared inserts.
- Watcher events are debounced.
- Corrupt or future-version events are quarantined or skipped with a local error log.
- Accounting failure never blocks a Skill.
- Reporting and maintenance operations may fail visibly, but collection failures remain fail-open.

## Versioning and Migration

- Database events carry `schema_version`.
- Managed Skill blocks carry an injection version.
- Adapter manifests carry an adapter version.
- Database migrations run transactionally before writes.
- An incompatible future schema causes collection to fail open and report through `health`, rather than corrupting existing data.

## Testing Strategy

### Core tests

- Event validation and schema migration.
- Deduplication by native ID and JoyCode connection/Skill ID.
- Time-range aggregation and accuracy labels.
- Concurrent SQLite writers and lock timeout behavior.
- Selection parsing, anchored wildcard matching, mode validation, atomic policy updates, and empty-policy behavior.

### Injection tests

- Frontmatter, no frontmatter, BOM, CRLF, malformed YAML, and read-only files.
- Idempotent install, version upgrade, external overwrite, and uninstall.
- Same names across scopes and symlink containment.
- Incremental watcher create/change/delete flows.

### Claude Code adapter tests

- Official hook payload fixtures for MCP success/failure.
- Model-triggered and directly typed Skill fixtures.
- Duplicate `tool_use_id` handling.
- Managed policy degradation.
- Native and injected Skill selection without double counting.
- MCP events outside the allowlist are ignored.

### JoyCode adapter tests

- User and project configuration fixtures using the verified JoyCode paths.
- Preservation of sibling MCP servers and prompt entries.
- Registration, sync, repair, and symmetric uninstall.
- Injected MCP duplicate suppression.
- Only selected Skills are injected and only selected stdio MCP servers are wrapped.
- Deselecting a Skill removes the managed block; incremental matches are injected.

### MCP proxy tests

- Fake stdio MCP server covering requests, notifications, batches, errors, stderr, process exit, and signals.
- Transparent byte-for-byte protocol relay.
- Unknown outcome when a child exits with an in-flight call.
- Statistics storage failure while relay remains functional.

### End-to-end validation

- Real Claude Code session selecting one existing Skill as `native_hook` and another as `injected_mcp`, plus one selected MCP call when a safe test server is available.
- Real JoyCode session with injected Skill accounting and a proxied stdio MCP server.
- New JoyCode Skill added during an active session.
- `/usage-stats` output showing correct counts and accuracy labels.

## Acceptance Criteria

- A user can install once for Claude Code and JoyCode at user scope.
- A fresh install records nothing until targets are explicitly selected.
- Users can list targets and select individual Skill modes and MCP servers with literal or wildcard patterns.
- Claude Code records selected native Skill and MCP events without modifying native-only Skill files; only Skills selected for `injected_mcp` receive a managed block.
- Selected JoyCode existing and newly discovered Skills receive exactly one current managed block.
- Unselected Skills have no managed block and unselected MCP servers are not proxied or stored.
- JoyCode repeated `record_skill` calls in one MCP connection do not inflate the portable count.
- JoyCode stdio MCP calls are relayed transparently and counted with outcomes.
- `/usage-stats` reports the last seven days by default and labels accuracy and transport coverage.
- No prompt, Skill content, MCP argument, or MCP result is persisted.
- Collection failures do not interrupt Agent work.
- `uninstall` preserves unrelated configuration and Skill content.
- Adding a future Agent requires an adapter and contract tests, not core storage/report changes.

## Known Limitations

- JoyCode Skill telemetry depends on the model following the injected instruction.
- JoyCode repeated uses of the same Skill in one session are represented as one unique session load.
- JoyCode remote MCP transports are not counted in the first release unless JoyCode adds a native event surface.
- A newly created JoyCode Skill can race with the watcher during the current session.
- Real JoyCode end-to-end validation requires an installed JoyCode environment.
