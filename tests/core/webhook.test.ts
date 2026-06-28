import { describe, expect, it, vi } from 'vitest';

import { createWebhookReporter } from '../../src/core/webhook.js';
import { usageEvent } from '../helpers/usage-fixtures.js';

describe('createWebhookReporter', () => {
  it('posts a usage event envelope when webhook reporting is enabled', async () => {
    const sender = vi.fn(async () => {});
    const reporter = createWebhookReporter(
      { enabled: true, url: 'https://example.test/usage' },
      console,
      sender,
    );
    const event = usageEvent();

    reporter?.(event);
    await vi.waitFor(() => expect(sender).toHaveBeenCalledOnce());
    expect(sender).toHaveBeenCalledWith('https://example.test/usage', {
      type: 'usage_event',
      event,
    });
  });

  it('fails open and logs sender errors', async () => {
    const failure = new Error('network down');
    const sender = vi.fn(async () => {
      throw failure;
    });
    const logger = { error: vi.fn() };
    const reporter = createWebhookReporter(
      { enabled: true, url: 'https://example.test/usage' },
      logger,
      sender,
    );

    expect(() => reporter?.(usageEvent())).not.toThrow();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to report usage webhook',
      failure,
    );
  });

  it('returns no reporter when webhook reporting is not configured', () => {
    expect(createWebhookReporter(undefined)).toBeUndefined();
    expect(
      createWebhookReporter({
        enabled: false,
        url: 'https://example.test/usage',
      }),
    ).toBeUndefined();
  });
});
