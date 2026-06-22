import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

export const skillModes = ['native_hook', 'injected_mcp'] as const;
export type SkillMode = (typeof skillModes)[number];

const selectionPatternsSchema = z
  .array(z.string().min(1, 'Selection patterns must not be empty'))
  .transform((patterns) => [...new Set(patterns)]);

const agentSelectionSchema = z.strictObject({
  skills: z.strictObject({
    native_hook: selectionPatternsSchema,
    injected_mcp: selectionPatternsSchema,
  }),
  mcp: selectionPatternsSchema,
});

export type AgentSelectionPolicy = z.infer<typeof agentSelectionSchema>;

const selectionConfigSchema = z.strictObject({
  version: z.literal(1),
  agents: z.record(z.string(), agentSelectionSchema),
});

export type SelectionConfig = z.infer<typeof selectionConfigSchema>;

export function emptyAgentSelection(): AgentSelectionPolicy {
  return {
    skills: { native_hook: [], injected_mcp: [] },
    mcp: [],
  };
}

export function emptySelectionConfig(): SelectionConfig {
  return { version: 1, agents: {} };
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchSelectionPattern(pattern: string, value: string): boolean {
  const source = pattern.split('*').map(escapeRegexLiteral).join('.*');
  return new RegExp(`^${source}$`).test(value);
}

export function selectedSkillMode(
  policy: AgentSelectionPolicy,
  name: string,
): SkillMode | undefined {
  const nativeHook = policy.skills.native_hook.some((pattern) =>
    matchSelectionPattern(pattern, name),
  );
  const injectedMcp = policy.skills.injected_mcp.some((pattern) =>
    matchSelectionPattern(pattern, name),
  );

  if (nativeHook && injectedMcp) {
    throw new Error(
      `Skill "${name}" matches both native_hook and injected_mcp`,
    );
  }

  if (nativeHook) return 'native_hook';
  if (injectedMcp) return 'injected_mcp';
  return undefined;
}

export function selectedMcp(
  policy: AgentSelectionPolicy,
  server: string,
  tool: string,
): boolean {
  const qualifiedTool = `${server}.${tool}`;
  return policy.mcp.some(
    (pattern) =>
      matchSelectionPattern(pattern, server) ||
      matchSelectionPattern(pattern, qualifiedTool),
  );
}

export async function loadSelectionConfig(path: string): Promise<SelectionConfig> {
  try {
    const contents = await readFile(path, 'utf8');
    return selectionConfigSchema.parse(JSON.parse(contents));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptySelectionConfig();
    }
    throw error;
  }
}

export async function saveSelectionConfig(
  path: string,
  config: SelectionConfig,
): Promise<void> {
  const parsed = selectionConfigSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
