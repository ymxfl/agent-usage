import { describe, expect, it } from 'vitest';

import type { UsageReport } from '../../src/core/query.js';
import { renderUsageReportText } from '../../src/report/text.js';

describe('renderUsageReportText', () => {
  it('renders a deterministic report with evidence, outcomes, rounded averages, and warnings', () => {
    const report: UsageReport = {
      rangeLabel: 'last 7 days',
      totals: [
        {
          agent: 'codex',
          kind: 'skill_invocation',
          evidence: 'native_hook',
          precision: 'exact',
          count: 3,
        },
        {
          agent: 'joycode',
          kind: 'mcp_call',
          evidence: 'mcp_proxy',
          precision: 'best_effort',
          count: 1,
        },
      ],
      topSkills: [
        { agent: 'codex', name: 'test-driven-development', count: 3 },
      ],
      mcp: [
        {
          agent: 'codex',
          server: 'github',
          tool: 'issues/list',
          success: 2,
          failure: 1,
          unknown: 1,
          averageDurationMs: 12.6,
        },
        {
          agent: 'codex',
          server: 'web',
          tool: 'search',
          success: 0,
          failure: 0,
          unknown: 1,
          averageDurationMs: null,
        },
      ],
      warnings: [
        'Injected MCP skill usage is best-effort and may be incomplete.',
        'JoyCode MCP coverage is stdio-only',
      ],
    };

    expect(renderUsageReportText(report)).toBe(`Usage statistics — last 7 days

Totals
- codex · skill_invocation · [native_hook, exact]: 3
- joycode · mcp_call · [mcp_proxy, best_effort]: 1

Skills
- codex · test-driven-development: 3

MCP
- codex · github.issues/list: 4 attempts (success 2, failure 1, unknown 1); avg 13 ms
- codex · web.search: 1 attempt (success 0, failure 0, unknown 1); avg n/a

Coverage warnings
- Injected MCP skill usage is best-effort and may be incomplete.
- JoyCode MCP coverage is stdio-only
`);
  });

  it('renders explicit empty sections and no warning section when coverage is complete', () => {
    expect(renderUsageReportText({
      rangeLabel: 'today',
      totals: [],
      topSkills: [],
      mcp: [],
      warnings: [],
    })).toBe(`Usage statistics — today

Totals
- None

Skills
- None

MCP
- None
`);
  });
});
