import { createHash } from 'node:crypto';

export type Scope = 'user' | 'project';

export function stableSkillId(
  agent: string,
  scope: Scope,
  canonicalPath: string,
): string {
  const digest = createHash('sha256')
    .update(`${agent}\0${scope}\0${canonicalPath}`)
    .digest('hex')
    .slice(0, 16);

  return `${agent}:${scope}:${digest}`;
}

export function nativeDedupeKey(agent: string, toolUseId: string): string {
  return `${agent}:native:${toolUseId}`;
}

export function injectedDedupeKey(
  connectionId: string,
  skillId: string,
  occurrenceId: string | number,
): string {
  return `injected:${connectionId}:${skillId}:${JSON.stringify(occurrenceId)}`;
}

export function proxyDedupeKey(
  connectionId: string,
  requestId: string | number,
  occurrenceId: string | number,
): string {
  return `proxy:${connectionId}:${JSON.stringify(requestId)}:${JSON.stringify(occurrenceId)}`;
}
