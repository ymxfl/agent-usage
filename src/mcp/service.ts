import { randomUUID } from 'node:crypto';

import type { UsageEvent } from '../core/event.js';
import { injectedDedupeKey, type Scope } from '../core/identity.js';
import {
  namedRangeStart,
  type NamedRange,
  type QueryFilter,
  type UsageReport,
} from '../core/query.js';

export interface UsageMcpRepository {
  insert(event: UsageEvent): boolean;
  report(filter: QueryFilter, rangeLabel: string): UsageReport;
}

export interface UsageMcpLogger {
  error(message: string, error: unknown): void;
}

export interface RecordSkillInput {
  skill_id: string;
  skill_name?: string | undefined;
  scope?: Scope | undefined;
}

export interface QueryUsageInput {
  range?: NamedRange | undefined;
  agent?: string | undefined;
  kind?: UsageEvent['kind'] | undefined;
}

export interface RecordSkillResult {
  ok: boolean;
  recorded: boolean;
  next: 'continue';
}

export class UsageMcpService {
  readonly #repository: UsageMcpRepository;
  readonly #agent: string;
  readonly #connectionId: string;
  readonly #logger: UsageMcpLogger;

  constructor(
    repository: UsageMcpRepository,
    agent: string,
    connectionId: string = randomUUID(),
    logger: UsageMcpLogger = console,
  ) {
    this.#repository = repository;
    this.#agent = agent;
    this.#connectionId = connectionId;
    this.#logger = logger;
  }

  recordSkill(input: RecordSkillInput): RecordSkillResult {
    const event: UsageEvent = {
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      agent: this.#agent,
      sessionId: this.#connectionId,
      kind: 'skill_session_load',
      name: input.skill_name || input.skill_id,
      skillId: input.skill_id,
      outcome: 'unknown',
      evidence: 'injected_mcp',
      precision: 'best_effort',
      dedupeKey: injectedDedupeKey(this.#connectionId, input.skill_id),
    };

    try {
      return {
        ok: true,
        recorded: this.#repository.insert(event),
        next: 'continue',
      };
    } catch (error) {
      this.#logger.error('Failed to record injected skill usage', error);
      return { ok: false, recorded: false, next: 'continue' };
    }
  }

  queryNamedRange(input: QueryUsageInput = {}): UsageReport {
    const range = input.range ?? '7d';
    const since = namedRangeStart(range, new Date());
    const filter: QueryFilter = {
      ...(since === undefined ? {} : { since }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    };

    return this.#repository.report(filter, range);
  }
}
