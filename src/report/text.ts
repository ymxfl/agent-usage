import type { UsageReport } from '../core/query.js';

export type Language = 'zh' | 'en';

const labels = {
  en: {
    title: 'Usage statistics',
    totals: 'Totals',
    skills: 'Skills',
    warnings: 'Coverage warnings',
    none: 'None',
    agent: 'Agent',
    kind: 'Kind',
    evidence: 'Evidence',
    precision: 'Precision',
    count: 'Count',
    skill: 'Skill',
    tool: 'Tool',
    attempts: 'Attempts',
    success: 'Success',
    failure: 'Failure',
    unknown: 'Unknown',
    average: 'Avg',
  },
  zh: {
    title: '使用统计',
    totals: '汇总',
    skills: 'Skills',
    warnings: '覆盖率提示',
    none: '无',
    agent: '智能体',
    kind: '类型',
    evidence: '证据',
    precision: '精度',
    count: '次数',
    skill: 'Skill',
    tool: '工具',
    attempts: '尝试',
    success: '成功',
    failure: '失败',
    unknown: '未知',
    average: '平均',
  },
} as const;

function table(headers: string[], rows: string[][], none: string): string[] {
  if (rows.length === 0) return [none];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

function section(title: string, rows: string[]): string[] {
  return [title, ...rows];
}

export function renderUsageReportText(
  report: UsageReport,
  language: Language = 'zh',
): string {
  const t = labels[language];
  const lines = [
    `${t.title} — ${report.rangeLabel}`,
    '',
    ...section(
      t.totals,
      table(
        [t.agent, t.kind, t.evidence, t.precision, t.count],
        report.totals.map((total) => [
          total.agent,
          total.kind,
          total.evidence,
          total.precision,
          String(total.count),
        ]),
        t.none,
      ),
    ),
    '',
    ...section(
      t.skills,
      table(
        [t.agent, t.skill, t.count],
        report.topSkills.map((skill) => [
          skill.agent,
          skill.name,
          String(skill.count),
        ]),
        t.none,
      ),
    ),
    '',
    ...section(
      'MCP',
      table(
        [
          t.agent,
          t.tool,
          t.attempts,
          t.success,
          t.failure,
          t.unknown,
          t.average,
        ],
        report.mcp.map((entry) => {
          const attempts = entry.success + entry.failure + entry.unknown;
          const average =
            entry.averageDurationMs === null
              ? 'n/a'
              : `${Math.round(entry.averageDurationMs)} ms`;
          return [
            entry.agent,
            `${entry.server}.${entry.tool}`,
            String(attempts),
            String(entry.success),
            String(entry.failure),
            String(entry.unknown),
            average,
          ];
        }),
        t.none,
      ),
    ),
  ];

  if (report.warnings.length > 0) {
    lines.push(
      '',
      ...section(
        t.warnings,
        report.warnings.map((warning) => `- ${warning}`),
      ),
    );
  }

  return `${lines.join('\n')}\n`;
}
