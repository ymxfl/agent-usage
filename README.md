# agent-usage

[English](README.en.md) | **简体中文**

**面向编程智能体的本地优先用量统计工具。**

`agent-usage` 会记录编程智能体加载 Skill、调用 MCP 工具的频次，并让你能在智能体内部通过
`/usage-stats` 查询结果。它的设计原则是：在智能体提供真实事件接口的地方做到精确，在只能估算
的地方如实标注，并且对你的提示词和数据保持沉默——它只存储计数和元数据，绝不存储内容。

当前版本面向 **Claude Code**、**JoyCode** 和 **Codex**，所有与具体智能体相关的行为都被隔离在带版本的适配器
契约之后，使存储与统计的核心逻辑完全不依赖具体智能体。

---

## 为什么需要它

编程智能体越来越多地通过 Skill 和 MCP 服务器来完成任务，但很少能回答这样的问题：
*"我实际上在用哪些 Skill？哪些 MCP 工具比较慢？哪些又在失败？"* `agent-usage` 在本地为你给出
答案，无需把数据发送到任何外部服务。

## 工作原理

每个智能体适配器会根据自己实际能看到的内容，选择最合适的观测策略；每条记录的事件都会打上
**证据（evidence）**标签，因此报表绝不会把精确计数和估算计数混在一起、呈现一个具有误导性的总数。

| 策略 | 观测内容 | 证据 | 精度 |
| --- | --- | --- | --- |
| **原生钩子**（Claude Code、Codex） | 通过平台钩子获取精确的 Skill 调用或 MCP 工具调用 | `native_hook` | 精确 |
| **注入式 MCP 计数**（JoyCode、Codex） | 一段托管指令，要求智能体每次使用被注入的 Skill 时调用 `record_skill` | `injected_mcp` | 尽力而为 |
| **stdio MCP 代理**（JoyCode） | 一个透明的 JSON-RPC 代理，转发 stdio MCP 流量并记录尝试、结果和耗时 | `mcp_proxy` | 精确 |
| **Codex 会话日志同步**（Codex） | 从 `~/.codex/sessions/**/*.jsonl` 读取 MCP 完成事件，补齐 native hook 未执行时的 MCP 统计 | `session_log` | 精确 |

### 统计内容

- **注入式 Skill 计数事件**（`skill_session_load`）——注入式适配器使用的可移植尽力而为指标。
  事件名会为了 schema 兼容继续保留；当智能体遵循注入指令时，同一会话内重复调用
  `record_skill` 也会被计数。
- **Skill 调用**（`skill_invocation`）——在适配器支持时（Claude Code），统计每一次原生 Skill 调用。
- **MCP 调用**（`mcp_call`）——每次工具请求计为一次尝试，结果为 `success`（成功）、`failure`
  （失败）或 `unknown`（未知，即请求已发起，但连接或进程在返回结果前结束）。

`usage-stats` 服务器自身的 `record_skill` 和 `query_usage` 调用不计入 MCP 统计；在执行前就被拒绝的
调用也不计入已执行的调用数。

## 支持的智能体

| 智能体 | Skill（原生钩子） | Skill（注入式） | MCP（原生） | MCP（会话日志） | MCP（stdio 代理） | Skill 监听 |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| `claude-code` | ✅ | ✅ | ✅ | — | — | — |
| `joycode` | — | ✅ | — | — | ✅ | ✅ |
| `codex` | — | ✅ | ✅ | ✅ | — | — |

Codex 适配器当前只扫描 `~/.codex/skills` 下的一层用户 Skill，并跳过 `.system` 等隐藏目录；插件 Skill、
系统 Skill 和其他导入路径暂不纳入注入统计。

## 隐私

按设计，`agent-usage` **绝不存储**：

- 提示词或对话内容
- Skill 正文内容
- MCP 参数或返回结果
- 环境变量、API 密钥或认证头

所存储的路径仅限于本地安装状态。遥测使用稳定 ID 和可选的项目显示名，而非完整路径。代理只读取
聚合所需的 JSON-RPC 方法和工具名，除此之外一概不解析。

## 环境要求

- **Node.js ≥ 24**（使用内置的 `node:sqlite`）
- 一个受支持的编程智能体（Claude Code、JoyCode 和/或 Codex）

## 构建

CLI 以单个打包后的 ESM 文件发布。克隆并构建：

```bash
git clone https://github.com/ymxfl/agent-usage.git
cd agent-usage
npm install
npm run build      # -> dist/agent-usage.mjs
```

随后可以直接调用，或把可执行文件放到 `PATH` 上：

```bash
node dist/agent-usage.mjs --help
# 或
npm link           # 暴露 `agent-usage` 命令
```

常用 npm 脚本：

| 脚本 | 用途 |
| --- | --- |
| `npm run build` | 将 `src/cli.ts` 打包为 `dist/agent-usage.mjs`（esbuild） |
| `npm run check` | 用 `tsc --noEmit` 做类型检查 |
| `npm test` | 运行 Vitest 测试套件 |
| `npm run test:watch` | 监听模式运行测试 |

## 使用方法

所有采集均为**手动开启（opt-in）**。全新安装时不会记录任何数据，直到你通过 `configure` 显式选择
目标。

日常配置可以直接运行交互式向导：

```bash
agent-usage
```

向导会先让你选择操作类型，再选择智能体；配置目标时支持对 Skill 和 MCP server 做多选。下面的显式
命令仍然保留，适合脚本化和可重复配置。

### 1. 为某个智能体安装

安装计数用的 MCP 服务器、`/usage-stats` 命令，以及（对 Claude Code 而言）原生钩子——默认作用域
为用户级。

```bash
agent-usage install claude-code
agent-usage install joycode
agent-usage install codex
```

### 2. 查看可观测的内容

```bash
agent-usage list-targets claude-code
agent-usage list-targets codex
```

列出已发现的 Skill 和 MCP 服务器，包括各自支持的采集模式、当前已选模式、未匹配的模式以及任何
问题。`health` 会在不修改配置的情况下汇报相同的覆盖情况。

### 3. 选择要采集的目标

模式匹配区分大小写、对完整名称锚定，并支持 `*` 通配符。MCP 标识符使用 `server` 或 `server.tool`
形式；选中某个 server 即选中其全部工具。

```bash
# 按证据模式选择特定 Skill
agent-usage configure claude-code --native-skill review --inject-skill deploy

# 选择某个 MCP 服务器（及其工具）
agent-usage configure claude-code --mcp 'github.*'

# 或一次性全选
agent-usage configure joycode --all-skills injected_mcp --all-mcp
```

重复使用的选项会**整体替换**为最终期望的白名单（是替换，不是追加）。生成的策略保存在
`~/.agent-usage/config.json`，由 CLI、钩子、注入器、监听器和代理共享。

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
    },
    "codex": {
      "skills": { "injected_mcp": ["pointed"] },
      "mcp": ["dom-pointer"]
    }
  }
}
```

### 4. 查询报表

在智能体内部：

```
/usage-stats
```

……或在终端查询。默认为最近 7 天。

```bash
agent-usage report              # 最近 7 天
agent-usage report today
agent-usage report 30d --agent claude-code --kind mcp_call
```

报表按智能体和证据/精度拆分总量，列出最常用的 Skill，并展示 MCP 的尝试次数及其成功/失败/未知
结果和平均耗时，此外还有覆盖率告警（`best-effort` 尽力而为、`stdio-only` 仅限 stdio、只读 Skill、
钩子策略被阻止、待同步等）。

```text
使用统计 — 7d

汇总
| 智能体 | 类型 | 证据 | 精度 | 次数 |
| --- | --- | --- | --- | --- |
| claude-code | mcp_call | native_hook | exact | 128 |
| codex | mcp_call | session_log | exact | 4 |
| joycode | skill_session_load | injected_mcp | best_effort | 7 |

Skills
| 智能体 | Skill | 次数 |
| --- | --- | --- |
| joycode | pointed | 7 |

MCP
| 智能体 | 工具 | 尝试 | 成功 | 失败 | 未知 | 平均 |
| --- | --- | --- | --- | --- | --- | --- |
| codex | dom-pointer.get-pointed-element | 4 | 4 | 0 | 0 | 5 ms |

覆盖率提示
- Injected MCP skill usage is best-effort and may be incomplete.
```

### 5. Webhook 与本地 Web 控制台

你可以把每条新写入的使用事件转发到一个 HTTP webhook。被本地数据库 dedupe 忽略的重复事件不会
再次上报；webhook 失败也不会阻塞智能体的正常调用。

```bash
agent-usage webhook set https://example.test/usage
agent-usage webhook show
agent-usage webhook unset
```

如需本地可视化查看，启动浏览器控制台：

```bash
agent-usage web
```

默认监听 `http://127.0.0.1:17891`。页面可以查看 targets、执行常见的安装/同步/修复/卸载操作、查看
表格报表、配置 webhook URL，并可一键设置为内置本地接收地址（`/webhook/usage`），实时观察上报
事件。操作按钮会先确认再执行，并在页面上展示结果；统计模式下拉框会用颜色区分“不统计 / 原生钩子
/ 注入计数”，已启用统计的 Skill 和 MCP 服务会自动排在列表顶部。

### 生命周期命令

| 命令 | 用途 |
| --- | --- |
| `install <agent>` | 注册 MCP 服务器、命令和钩子 |
| `sync [agent]` | 为新发现的 Skill 注入；封装新增的 stdio MCP 服务器；同步 Codex 会话日志 |
| `health [agent]` | 只汇报覆盖情况，不做任何修改 |
| `repair [agent]` | 根据清单恢复缺失的托管条目 |
| `uninstall <agent>` | 移除托管块/条目；保留无关配置 |
| `uninstall <agent> --purge-data -y` | 在移除最后一个适配器后，额外删除共享数据库 |

`uninstall` 默认保留 `~/.agent-usage/usage.db`，因此移除某个智能体不会抹除另一个智能体的历史。
在所有适配器被移除前，`--purge-data` 会被拒绝，且在非交互式会话中必须加 `--yes`。

### 内部命令

`agent-usage mcp --agent <id>` 运行计数用的 MCP 服务器（暴露 `record_skill` 和 `query_usage`），
`agent-usage proxy --agent <id> --server <name> <command…>` 运行 stdio MCP 代理。这些通常由
`install`/`sync` 自动接入，一般无需手动调用。

## 架构

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

**核心层（core）**负责事件 schema 校验与迁移、稳定的 Skill ID 生成、带有限忙时重试的 SQLite WAL
写入、去重、时间范围聚合，以及终端报表渲染。它**完全不包含**任何具体智能体的路径逻辑。

每个**适配器（adapter）**组合三个策略接口——`SkillInstrumentationStrategy`、
`McpObservationStrategy` 和 `ConfigMutationStrategy`——并实现
[`AgentAdapter`](src/adapters/types.ts) 契约：

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

**新增一个智能体**只需新增一个适配器、选定策略、准备配置 fixtures 和契约测试——无需改动核心
存储或报表。

数据存放在 `~/.agent-usage/`：

```text
~/.agent-usage/
├── usage.db            # SQLite（WAL 模式）
├── config.json         # 选择策略
├── state/
│   ├── installs.json
│   ├── joycode-*.json
│   └── codex-*.json
└── logs/
    └── errors.log
```

存储错误会被记录，但**绝不阻塞**原始的智能体、Skill 或 MCP 调用——采集遵循"失败放行（fail-open）"。

## 项目结构

```text
src/
├── cli.ts                  # commander CLI 入口
├── core/                   # 与具体 Agent 无关：数据库、事件、查询、选择、仓库
├── adapters/
│   ├── claude/             # Claude Code：原生钩子 + 插件文件
│   ├── codex/              # Codex：Skill 注入 + hooks.json + config.toml + 会话日志同步
│   ├── joycode/            # JoyCode：注入式计数 + stdio 代理 + Skill 监听
│   ├── registry.ts
│   └── types.ts            # AgentAdapter 契约
├── mcp/                    # usage-stats MCP 服务器与服务
├── proxy/                  # 透明的 stdio JSON-RPC 代理 + 协议观测器
└── report/                 # 终端报表渲染
tests/                      # Vitest —— 核心、适配器、注入、代理、集成
scripts/build.mjs           # esbuild 打包
docs/superpowers/           # 设计规格与实现计划
```

## 已知限制

- **JoyCode 的 Skill 遥测是尽力而为的**——它依赖模型遵循注入的指令。指令会要求每次使用 Skill
  都调用 `record_skill`，包括同一会话内重复使用；但如果 JoyCode 复用缓存上下文，或模型跳过计数
  调用，仍可能漏记。
- **JoyCode 的远程 MCP 传输方式**（HTTP/SSE/Streamable HTTP）在本版本中不被统计；只有经过代理的
  stdio MCP 流量会被精确观测。
- **新建的 JoyCode Skill 可能与监听器竞争**——在其创建的那次会话中可能漏记；系统保证在下一次
  调用或下一次会话中完成补齐，而非保证当次会话内零丢失。
- **Codex Skill 统计是注入式的**——当前只处理 `~/.codex/skills` 下的用户 Skill；如果 Codex 未遵循
  注入指令，Skill 计数仍可能漏记。
- **Codex MCP 统计优先使用 native hook，并用会话日志补齐**。如果 Codex hook 尚未在 `/hooks` 中被
  信任，`sync codex` 或启动 `agent-usage mcp --agent codex` 时仍会从本地 session log 补齐已选 MCP
  服务的完成事件。
- 本地 Web 控制台只监听本机地址，当前没有提供托管式远程仪表盘。

完整的目标、计数语义和验收标准，请参见
[设计规格](docs/superpowers/specs/2026-06-18-cross-agent-usage-stats-design.md)。

## 开发

```bash
npm install
npm run check     # 类型检查
npm test          # 完整套件
```

所有文件改动在文件层面是事务性的：先解析校验再修改、写入同目录的临时文件、保留权限、原子化重命名
到位，最后仅在成功后更新状态清单。冲突的用户编辑绝不会被静默覆盖。

## 许可证

[MIT](LICENSE) © 2026 ymxfl
