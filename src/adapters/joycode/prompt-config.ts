/**
 * Static prompt.json + Skill content that registers the `usage-stats` entry for
 * JoyCode. A JoyCode prompt file is a JSON ARRAY of prompt entries; the adapter
 * merges by replacing/adding the entry whose `label === 'usage-stats'`.
 */

/** Label used to identify our managed prompt entry across merges. */
export const USAGE_PROMPT_LABEL = 'usage-stats';

/** The managed prompt entry inserted into the user prompt array. */
export const usagePrompt = {
  label: USAGE_PROMPT_LABEL,
  name: 'usageStats',
  source: 'user' as const,
  description: 'Show local MCP and Skill usage statistics',
  prompt:
    'Call the `query_usage` tool from the `usage-stats` MCP server using the command arguments as filters, then render the structured result.',
};

/** Body of the `usage-stats` SKILL.md written under the user skills root. */
export const usageSkill = `---\nname: usage-stats\ndescription: Use when the user asks to inspect local MCP or Skill usage statistics.\n---\nCall the \`query_usage\` tool from the \`usage-stats\` MCP server using \`$ARGUMENTS\` as filters and render the structured result.`;
