import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AdapterRegistry } from '../adapters/registry.js';
import type { Scope } from '../adapters/types.js';
import type { UsageEvent } from '../core/event.js';
import {
  emptySelectionConfig,
  type AgentSelectionPolicy,
  type SelectionConfig,
} from '../core/selection.js';
import {
  namedRangeStart,
  type NamedRange,
  type QueryFilter,
} from '../core/query.js';
import type { CliRuntime } from '../cli.js';

type LifecycleOperation = 'install' | 'sync' | 'repair' | 'uninstall';

export interface AgentUsageWebServer {
  url: string;
  close(): Promise<void>;
}

export interface AgentUsageWebServerOptions {
  registry: AdapterRegistry;
  runtime: CliRuntime;
  host?: string;
  port?: number;
}

interface SseClient {
  id: number;
  response: ServerResponse;
}

const namedRanges = ['today', '7d', '30d', 'all'] as const;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  if (body.trim().length === 0) return {};
  return JSON.parse(body);
}

function method(request: IncomingMessage): string {
  return request.method?.toUpperCase() ?? 'GET';
}

function isNamedRange(value: string | null): value is NamedRange {
  return value !== null && (namedRanges as readonly string[]).includes(value);
}

function localWebhookUrl(baseUrl: string): string {
  return `${baseUrl}/webhook/usage`;
}

function html(baseUrl: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agent-usage</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f7;
      --panel: #ffffff;
      --line: #dbe2e7;
      --line-strong: #c6d1d9;
      --text: #172026;
      --muted: #667784;
      --accent: #176b87;
      --accent-soft: #e7f3f6;
      --danger: #b3261e;
      --danger-soft: #fff0ee;
      --success-soft: #eef8f1;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
    button, select, input { font: inherit; }
    button { min-height: 32px; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; color: var(--text); cursor: pointer; }
    button:hover { border-color: var(--accent); }
    button:disabled { cursor: wait; opacity: .62; }
    button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    button.danger { color: var(--danger); border-color: #e0aaa5; background: #fff; }
    input, select { min-height: 32px; padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; color: var(--text); }
    input { min-width: min(560px, 100%); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #e7ecef; padding: 8px 7px; vertical-align: top; }
    th { font-size: 12px; color: var(--muted); font-weight: 650; background: #f8fafb; }
    h1, h2, h3 { margin: 0; }
    h1 { font-size: 18px; }
    h2 { font-size: 17px; }
    h3 { font-size: 14px; }
    pre { overflow: auto; margin: 0; padding: 10px; background: #0f151a; color: #d8e4eb; border-radius: 6px; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
    .side { padding: 16px 12px; border-right: 1px solid var(--line); background: #fbfcfd; }
    .brand { display: grid; gap: 4px; margin: 2px 6px 18px; }
    .brand small { color: var(--muted); }
    .nav { display: grid; gap: 4px; }
    .nav button { justify-content: flex-start; width: 100%; text-align: left; border-color: transparent; background: transparent; }
    .nav button.active { background: var(--accent-soft); border-color: #c4dee7; color: #0e5269; }
    .content { min-width: 0; display: grid; grid-template-rows: auto 1fr; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
    .topbar-title { display: grid; gap: 2px; }
    .topbar-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .view-wrap { padding: 18px; display: grid; gap: 16px; align-content: start; }
    .view { display: none; gap: 16px; }
    .view.active { display: grid; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .55fr); gap: 16px; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 12px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; gap: 6px; }
    .metric span { color: var(--muted); font-size: 12px; }
    .metric strong { font-size: 22px; }
    .muted { color: var(--muted); }
    .pill { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line-strong); background: #fff; color: var(--muted); font-size: 12px; }
    .pill.on { color: #17613b; border-color: #b8dbc5; background: var(--success-soft); }
    .pill.warn { color: #7d4f00; border-color: #e5c587; background: #fff8e8; }
    .status { padding: 10px 12px; border-radius: 8px; background: var(--accent-soft); border: 1px solid #c4dee7; white-space: pre-wrap; }
    .status.error { background: var(--danger-soft); border-color: #efb5b5; color: #7d1f1f; }
    .agent-list { display: grid; gap: 14px; }
    .agent-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .agent-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; padding: 14px; border-bottom: 1px solid var(--line); }
    .agent-body { display: grid; gap: 14px; padding: 14px; }
    .agent-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--line); }
    .tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; }
    .tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .report-grid { display: grid; gap: 14px; }
    .empty { color: var(--muted); padding: 10px 0; }
    .event-layout { display: grid; grid-template-columns: minmax(280px, .55fr) minmax(0, 1fr); gap: 14px; }
    .event-list { display: grid; gap: 8px; align-content: start; max-height: 520px; overflow: auto; }
    .event-item { width: 100%; text-align: left; background: #fff; border: 1px solid var(--line); }
    .event-item.active { border-color: var(--accent); background: var(--accent-soft); }
    @media (max-width: 880px) {
      .shell { grid-template-columns: 1fr; }
      .side { position: sticky; top: 0; z-index: 2; border-right: 0; border-bottom: 1px solid var(--line); }
      .nav { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .nav button { text-align: center; justify-content: center; }
      .summary, .split, .event-layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="side">
      <div class="brand">
        <h1>agent-usage</h1>
        <small>本地用量控制台</small>
      </div>
      <nav class="nav">
        <button class="active" data-view-target="overview">总览</button>
        <button data-view-target="agents">智能体</button>
        <button data-view-target="report">报表</button>
        <button data-view-target="events">实时上报</button>
      </nav>
    </aside>
    <div class="content">
      <header class="topbar">
        <div class="topbar-title">
          <h2 id="page-title">总览</h2>
          <span class="muted" id="local-webhook">本地 webhook：${localWebhookUrl(baseUrl)}</span>
        </div>
        <div class="topbar-actions">
          <span id="webhook-badge" class="pill">webhook 未启用</span>
          <button id="refresh-state">刷新</button>
        </div>
      </header>
      <main class="view-wrap">
        <section class="view active" data-view="overview">
          <div class="summary">
            <div class="metric"><span>智能体数量</span><strong id="metric-agents">0</strong></div>
            <div class="metric"><span>已启用技能</span><strong id="metric-skills">0</strong></div>
            <div class="metric"><span>已启用 MCP</span><strong id="metric-mcp">0</strong></div>
            <div class="metric"><span>上报事件</span><strong id="metric-events">0</strong></div>
          </div>
          <div class="split">
            <section class="panel">
              <div class="toolbar">
                <h2>webhook 设置</h2>
                <span id="webhook-status" class="pill">未启用</span>
              </div>
              <div class="row" style="margin-top: 12px">
                <input id="webhook-url" placeholder="请输入 webhook 地址">
                <button id="save-webhook" class="primary">保存</button>
                <button id="use-local">使用本地地址</button>
                <button id="disable-webhook">停用</button>
              </div>
            </section>
            <section class="panel">
              <h2>最近操作</h2>
              <div id="operation-status" class="status muted" style="margin-top: 12px">暂无操作结果</div>
            </section>
          </div>
        </section>
        <section class="view" data-view="agents">
          <div class="toolbar">
            <h2>智能体配置</h2>
            <span class="muted">选择技能统计模式或 MCP 服务后，点击保存配置生效。</span>
          </div>
          <div id="agents" class="agent-list"></div>
        </section>
        <section class="view" data-view="report">
          <div class="panel">
            <div class="toolbar">
              <h2>用量报表</h2>
              <div class="row">
                <select id="range"><option value="today">今天</option><option value="7d" selected>最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部</option></select>
                <button id="refresh-report">刷新报表</button>
              </div>
            </div>
            <div id="report" class="report-grid">
              <div id="report-totals"></div>
              <div id="report-skills"></div>
              <div id="report-mcp"></div>
              <div id="report-warnings"></div>
            </div>
          </div>
        </section>
        <section class="view" data-view="events">
          <div class="toolbar">
            <h2>实时上报</h2>
            <div class="row">
              <button id="copy-local-webhook">复制本地地址</button>
              <button id="clear-events">清空显示</button>
            </div>
          </div>
          <div class="event-layout">
            <section class="panel">
              <h3>事件列表</h3>
              <div id="events" class="event-list" style="margin-top: 10px"></div>
            </section>
            <section class="panel">
              <h3>事件详情</h3>
              <pre id="event-detail" style="margin-top: 10px">暂无事件</pre>
            </section>
          </div>
        </section>
      </main>
    </div>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    let currentState = null;
    let receivedEvents = [];
    let activeEventIndex = -1;
    async function json(url, options) {
      const response = await fetch(url, options);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || response.statusText);
      return body;
    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char]));
    }
    function setStatus(message, isError = false) {
      const target = $('operation-status');
      target.textContent = message;
      target.className = 'status' + (isError ? ' error' : '');
    }
    function resultText(result) {
      if (!Array.isArray(result) || result.length === 0) return '无返回结果';
      return result.map((item) => {
        const path = item.path ? ' (' + item.path + ')' : '';
        return item.status + ': ' + item.message + path;
      }).join('\\n');
    }
    function tableHtml(title, headers, rows) {
      if (rows.length === 0) return '<h3>' + title + '</h3><div class="empty">无</div>';
      return '<h3>' + title + '</h3><table><thead><tr>' +
        headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.map((row) => '<tr>' + row.map((cell) => '<td>' + escapeHtml(cell) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>';
    }
    function renderReport(report) {
      $('report-totals').innerHTML = tableHtml('汇总', ['智能体','类型','证据','精度','次数'],
        report.totals.map((row) => [row.agent, row.kind, row.evidence, row.precision, row.count]));
      $('report-skills').innerHTML = tableHtml('技能', ['智能体','技能','次数'],
        report.topSkills.map((row) => [row.agent, row.name, row.count]));
      $('report-mcp').innerHTML = tableHtml('MCP', ['智能体','工具','尝试','成功','失败','未知','平均'],
        report.mcp.map((row) => {
          const attempts = row.success + row.failure + row.unknown;
          const average = row.averageDurationMs === null ? 'n/a' : Math.round(row.averageDurationMs) + ' ms';
          return [row.agent, row.server + '.' + row.tool, attempts, row.success, row.failure, row.unknown, average];
        }));
      $('report-warnings').innerHTML = report.warnings.length === 0
        ? ''
        : '<h3>覆盖率提示</h3><ul>' + report.warnings.map((warning) => '<li>' + escapeHtml(warning) + '</li>').join('') + '</ul>';
    }
    function switchView(name) {
      document.querySelectorAll('[data-view-target]').forEach((button) => {
        button.classList.toggle('active', button.dataset.viewTarget === name);
      });
      document.querySelectorAll('[data-view]').forEach((view) => {
        view.classList.toggle('active', view.dataset.view === name);
      });
      const labels = { overview: '总览', agents: '智能体', report: '报表', events: '实时上报' };
      $('page-title').textContent = labels[name] || '总览';
    }
    function modeLabel(mode) {
      if (mode === 'native_hook') return '原生钩子';
      if (mode === 'injected_mcp') return '注入计数';
      return '不统计';
    }
    function capabilityTags(capabilities) {
      const items = [
        ['技能原生事件', capabilities.nativeSkillEvents],
        ['技能注入', capabilities.skillInjection],
        ['MCP 原生事件', capabilities.nativeMcpEvents],
        ['MCP 代理', capabilities.stdioMcpProxy],
        ['技能监听', capabilities.skillWatching]
      ];
      return items.map(([label, on]) => '<span class="pill ' + (on ? 'on' : '') + '">' + label + '：' + (on ? '支持' : '不支持') + '</span>').join('');
    }
    function renderOverview(state) {
      const selectedSkills = state.agents.reduce((sum, agent) => sum + agent.targets.skills.filter((skill) => skill.selectedMode).length, 0);
      const selectedMcp = state.agents.reduce((sum, agent) => sum + agent.targets.mcp.filter((server) => server.selected).length, 0);
      $('metric-agents').textContent = String(state.agents.length);
      $('metric-skills').textContent = String(selectedSkills);
      $('metric-mcp').textContent = String(selectedMcp);
      $('metric-events').textContent = String(receivedEvents.length);
      const enabled = state.config.webhook?.enabled === true;
      const label = enabled ? 'webhook 已启用' : 'webhook 未启用';
      $('webhook-badge').textContent = label;
      $('webhook-badge').className = 'pill ' + (enabled ? 'on' : 'warn');
      $('webhook-status').textContent = enabled ? '已启用' : '未启用';
      $('webhook-status').className = 'pill ' + (enabled ? 'on' : 'warn');
    }
    function renderEvents() {
      $('metric-events').textContent = String(receivedEvents.length);
      if (receivedEvents.length === 0) {
        $('events').innerHTML = '<div class="empty">暂无上报事件</div>';
        $('event-detail').textContent = '暂无事件';
        return;
      }
      $('events').innerHTML = receivedEvents.map((event, index) => {
        const payload = event.event || event;
        const title = [payload.agent, payload.kind, payload.name].filter(Boolean).join(' · ') || '上报事件';
        return '<button class="event-item ' + (index === activeEventIndex ? 'active' : '') + '" data-event-index="' + index + '">' + escapeHtml(title) + '</button>';
      }).join('');
      document.querySelectorAll('[data-event-index]').forEach((button) => {
        button.onclick = () => {
          activeEventIndex = Number(button.dataset.eventIndex);
          renderEvents();
        };
      });
      if (activeEventIndex < 0 || activeEventIndex >= receivedEvents.length) activeEventIndex = 0;
      $('event-detail').textContent = JSON.stringify(receivedEvents[activeEventIndex], null, 2);
    }
    async function loadState() {
      const state = await json('/api/state');
      currentState = state;
      receivedEvents = state.received || receivedEvents;
      $('webhook-url').value = state.config.webhook?.url || '';
      renderOverview(state);
      renderEvents();
      $('agents').innerHTML = state.agents.map((agent) => {
        const skills = agent.targets.skills.map((s) => {
          const options = ['none'].concat(s.supportedModes).map((mode) => {
            const selected = (mode === 'none' && !s.selectedMode) || mode === s.selectedMode ? ' selected' : '';
            return '<option value="' + mode + '"' + selected + '>' + modeLabel(mode) + '</option>';
          }).join('');
          return '<tr><td>' + escapeHtml(s.name) + '</td><td>' + escapeHtml(s.scope) + '</td><td><select data-agent="' + escapeHtml(agent.id) + '" data-skill="' + escapeHtml(s.name) + '">' + options + '</select></td></tr>';
        }).join('');
        const mcp = agent.targets.mcp.map((m) => {
          return '<tr><td>' + escapeHtml(m.server) + '</td><td>' + escapeHtml(m.scope) + '</td><td>' + escapeHtml(m.transport) + '</td><td><input type="checkbox" data-agent="' + escapeHtml(agent.id) + '" data-mcp="' + escapeHtml(m.server) + '"' + (m.selected ? ' checked' : '') + '></td></tr>';
        }).join('');
        return '<article class="agent-card"><div class="agent-head"><div><h3>' + escapeHtml(agent.id) + '</h3><div class="row" style="margin-top: 8px">' + capabilityTags(agent.capabilities) + '</div></div>' +
          '<div class="agent-actions">' +
          '<button data-agent="' + escapeHtml(agent.id) + '" data-op="install">安装</button>' +
          '<button data-agent="' + escapeHtml(agent.id) + '" data-op="sync">同步</button>' +
          '<button data-agent="' + escapeHtml(agent.id) + '" data-op="repair">修复</button>' +
          '<button class="danger" data-agent="' + escapeHtml(agent.id) + '" data-op="uninstall">卸载</button>' +
          '<button class="primary" data-agent="' + escapeHtml(agent.id) + '" data-configure="true">保存配置</button>' +
          '</div></div><div class="agent-body">' +
          '<div class="tabs"><button class="active" data-tab-target="' + escapeHtml(agent.id) + ':skills">技能</button><button data-tab-target="' + escapeHtml(agent.id) + ':mcp">MCP 服务</button></div>' +
          '<div class="tab-panel active" data-tab="' + escapeHtml(agent.id) + ':skills"><table><tr><th>技能</th><th>范围</th><th>统计模式</th></tr>' + skills + '</table></div>' +
          '<div class="tab-panel" data-tab="' + escapeHtml(agent.id) + ':mcp"><table><tr><th>MCP 服务</th><th>范围</th><th>传输</th><th>统计</th></tr>' + mcp + '</table></div>' +
          '</div></article>';
      }).join('');
      document.querySelectorAll('[data-tab-target]').forEach((button) => {
        button.onclick = () => {
          const [agent] = button.dataset.tabTarget.split(':');
          document.querySelectorAll('[data-tab-target^="' + agent + ':"]').forEach((item) => item.classList.toggle('active', item === button));
          document.querySelectorAll('[data-tab^="' + agent + ':"]').forEach((item) => item.classList.toggle('active', item.dataset.tab === button.dataset.tabTarget));
        };
      });
      document.querySelectorAll('[data-op]').forEach((button) => {
        button.onclick = async () => {
          const agent = button.dataset.agent;
          const operation = button.dataset.op;
          const labels = { install: '安装', sync: '同步', repair: '修复', uninstall: '卸载' };
          if (!confirm('确定要对 ' + agent + ' 执行“' + labels[operation] + '”吗？')) return;
          button.disabled = true;
          setStatus('正在执行' + labels[operation] + ' · ' + agent + ' ...');
          try {
            const response = await json('/api/operation', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ agent, operation, scope: 'user' })
            });
            setStatus(labels[operation] + ' · ' + agent + ' 完成\\n' + resultText(response.result));
            await loadState();
          } catch (error) {
            setStatus(labels[operation] + ' · ' + agent + ' 失败：' + error.message, true);
          } finally {
            button.disabled = false;
          }
        };
      });
      document.querySelectorAll('[data-configure]').forEach((button) => {
        button.onclick = async () => {
          const agent = button.dataset.agent;
          if (!confirm('保存 ' + agent + ' 的统计配置？')) return;
          const policy = { skills: { native_hook: [], injected_mcp: [] }, mcp: [] };
          document.querySelectorAll('[data-agent="' + agent + '"][data-skill]').forEach((select) => {
            if (select.value === 'native_hook') policy.skills.native_hook.push(select.dataset.skill);
            if (select.value === 'injected_mcp') policy.skills.injected_mcp.push(select.dataset.skill);
          });
          document.querySelectorAll('[data-agent="' + agent + '"][data-mcp]').forEach((checkbox) => {
            if (checkbox.checked) policy.mcp.push(checkbox.dataset.mcp);
          });
          await json('/api/configure', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent, policy })
          });
          setStatus('保存配置 · ' + agent + ' 完成');
          await loadState();
        };
      });
    }
    async function loadReport() {
      const body = await json('/api/report?range=' + encodeURIComponent($('range').value));
      renderReport(body.report);
    }
    document.querySelectorAll('[data-view-target]').forEach((button) => {
      button.onclick = () => switchView(button.dataset.viewTarget);
    });
    $('save-webhook').onclick = async () => {
      await json('/api/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, url: $('webhook-url').value })
      });
      setStatus('webhook 设置已保存');
      await loadState();
    };
    $('use-local').onclick = async () => { await json('/api/webhook/local', { method: 'POST' }); setStatus('已使用本地 webhook 地址'); await loadState(); };
    $('disable-webhook').onclick = async () => { if (!confirm('确定停用 webhook 上报吗？')) return; await json('/api/webhook', { method: 'DELETE' }); setStatus('webhook 已停用'); await loadState(); };
    $('refresh-report').onclick = loadReport;
    $('refresh-state').onclick = async () => { await loadState(); await loadReport(); };
    $('clear-events').onclick = () => { receivedEvents = []; activeEventIndex = -1; renderEvents(); };
    $('copy-local-webhook').onclick = async () => {
      await navigator.clipboard?.writeText('${localWebhookUrl(baseUrl)}');
      setStatus('已复制本地 webhook 地址');
    };
    const source = new EventSource('/api/events');
    source.addEventListener('usage', (event) => {
      receivedEvents.unshift(JSON.parse(event.data));
      activeEventIndex = 0;
      renderEvents();
    });
    loadState().then(loadReport).catch((error) => alert(error.message));
  </script>
</body>
</html>`;
}

export async function startAgentUsageWebServer(
  options: AgentUsageWebServerOptions,
): Promise<AgentUsageWebServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 17891;
  const clients: SseClient[] = [];
  const received: unknown[] = [];
  let nextClientId = 1;
  let baseUrl = '';

  const loadConfig = async (): Promise<SelectionConfig> =>
    options.runtime.loadSelectionConfig(options.runtime.paths().config);

  const saveConfig = async (config: SelectionConfig): Promise<void> =>
    options.runtime.saveSelectionConfig(options.runtime.paths().config, config);

  const broadcast = (event: unknown): void => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      client.response.write(`event: usage\ndata: ${payload}\n\n`);
    }
  };

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', baseUrl);

      if (method(request) === 'GET' && requestUrl.pathname === '/') {
        sendText(response, 200, 'text/html; charset=utf-8', html(baseUrl));
        return;
      }

      if (method(request) === 'GET' && requestUrl.pathname === '/api/events') {
        const client: SseClient = { id: nextClientId, response };
        nextClientId += 1;
        clients.push(client);
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        response.write(': connected\n\n');
        request.once('close', () => {
          const index = clients.findIndex((item) => item.id === client.id);
          if (index >= 0) clients.splice(index, 1);
        });
        return;
      }

      if (method(request) === 'POST' && requestUrl.pathname === '/webhook/usage') {
        const body = await readJson(request);
        received.unshift(body);
        if (received.length > 100) received.length = 100;
        broadcast(body);
        sendJson(response, 202, { ok: true });
        return;
      }

      if (method(request) === 'GET' && requestUrl.pathname === '/api/state') {
        const config = await loadConfig().catch(() => emptySelectionConfig());
        const agents = await Promise.all(
          options.registry.list().map(async (adapter) => ({
            id: adapter.id,
            capabilities: adapter.capabilities,
            targets: await adapter.listTargets(),
            health: await adapter.health(),
          })),
        );
        sendJson(response, 200, {
          config,
          agents,
          localWebhookUrl: localWebhookUrl(baseUrl),
          received,
        });
        return;
      }

      if (method(request) === 'POST' && requestUrl.pathname === '/api/webhook/local') {
        const config = await loadConfig().catch(() => emptySelectionConfig());
        await saveConfig({
          ...config,
          webhook: { enabled: true, url: localWebhookUrl(baseUrl) },
        });
        sendJson(response, 200, { ok: true, url: localWebhookUrl(baseUrl) });
        return;
      }

      if (requestUrl.pathname === '/api/webhook') {
        const config = await loadConfig().catch(() => emptySelectionConfig());
        if (method(request) === 'DELETE') {
          const { webhook: _webhook, ...nextConfig } = config;
          await saveConfig(nextConfig);
          sendJson(response, 200, { ok: true });
          return;
        }
        if (method(request) === 'POST') {
          const body = await readJson(request) as {
            enabled?: boolean;
            url?: string;
          };
          await saveConfig({
            ...config,
            webhook: {
              enabled: body.enabled ?? true,
              url: body.url ?? '',
            },
          });
          sendJson(response, 200, { ok: true });
          return;
        }
      }

      if (method(request) === 'POST' && requestUrl.pathname === '/api/operation') {
        const body = await readJson(request) as {
          agent?: string;
          operation?: LifecycleOperation;
          scope?: Scope;
        };
        if (
          body.agent === undefined ||
          body.operation === undefined ||
          !['install', 'sync', 'repair', 'uninstall'].includes(body.operation)
        ) {
          sendJson(response, 400, { error: 'invalid operation' });
          return;
        }
        const result = await options.registry
          .get(body.agent)
          [body.operation](body.scope ?? 'user');
        sendJson(response, 200, { ok: true, result });
        return;
      }

      if (method(request) === 'POST' && requestUrl.pathname === '/api/configure') {
        const body = await readJson(request) as {
          agent?: string;
          policy?: AgentSelectionPolicy;
        };
        if (body.agent === undefined || body.policy === undefined) {
          sendJson(response, 400, { error: 'missing agent or policy' });
          return;
        }
        const result = await options.registry.get(body.agent).configure(body.policy);
        sendJson(response, 200, { ok: true, result });
        return;
      }

      if (method(request) === 'GET' && requestUrl.pathname === '/api/report') {
        const requestedRange = requestUrl.searchParams.get('range');
        const range: NamedRange = isNamedRange(requestedRange)
          ? requestedRange
          : '7d';
        const database = options.runtime.openDatabase(options.runtime.paths().database);
        try {
          const repository = options.runtime.createRepository(database);
          const since = namedRangeStart(range);
          const filter: QueryFilter =
            since === undefined ? {} : { since };
          const report = repository.report(filter, range);
          const { renderUsageReportText } = await import('../report/text.js');
          sendJson(response, 200, {
            report,
            text: renderUsageReportText(report, options.runtime.language()),
          });
        } finally {
          database.close();
        }
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      options.runtime.logger.error('Web server request failed', error);
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://${host}:${address.port}`;

  return {
    url: baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of [...clients]) client.response.end();
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      }),
  };
}
