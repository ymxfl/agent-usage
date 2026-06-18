import type { UsageReport } from '../core/query.js';

function section(title: string, rows: string[]): string[] {
  return [title, ...(rows.length === 0 ? ['- None'] : rows)];
}

export function renderUsageReportText(report: UsageReport): string {
  const lines = [
    `Usage statistics — ${report.rangeLabel}`,
    '',
    ...section(
      'Totals',
      report.totals.map(
        (total) =>
          `- ${total.agent} · ${total.kind} · ${total.evidence}: ${total.count}`,
      ),
    ),
    '',
    ...section(
      'Skills',
      report.topSkills.map(
        (skill) => `- ${skill.agent} · ${skill.name}: ${skill.count}`,
      ),
    ),
    '',
    ...section(
      'MCP',
      report.mcp.map((entry) => {
        const average =
          entry.averageDurationMs === null
            ? 'n/a'
            : `${Math.round(entry.averageDurationMs)} ms`;
        return `- ${entry.agent} · ${entry.server} · ${entry.tool}: success ${entry.success}, failure ${entry.failure}, unknown ${entry.unknown}; avg ${average}`;
      }),
    ),
  ];

  if (report.warnings.length > 0) {
    lines.push(
      '',
      ...section(
        'Coverage warnings',
        report.warnings.map((warning) => `- ${warning}`),
      ),
    );
  }

  return `${lines.join('\n')}\n`;
}
