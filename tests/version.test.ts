import { describe, expect, it } from 'vitest';

import { APP_VERSION, EVENT_SCHEMA_VERSION } from '../src/version.js';

describe('version constants', () => {
  it('exposes the application version', () => {
    expect(APP_VERSION).toBe('0.1.0');
  });

  it('exposes the event schema version', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });
});
