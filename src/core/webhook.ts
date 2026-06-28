import type { UsageEvent } from './event.js';
import type { WebhookConfig } from './selection.js';

export interface WebhookLogger {
  error(message: string, error: unknown): void;
}

export interface WebhookEnvelope {
  type: 'usage_event';
  event: UsageEvent;
}

export type WebhookSender = (
  url: string,
  envelope: WebhookEnvelope,
) => Promise<void>;

export const defaultWebhookSender: WebhookSender = async (url, envelope) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  if (!response.ok) {
    throw new Error(`Webhook POST failed with HTTP ${response.status}`);
  }
};

export function createWebhookReporter(
  config: WebhookConfig | undefined,
  logger: WebhookLogger = console,
  sender: WebhookSender = defaultWebhookSender,
): ((event: UsageEvent) => void) | undefined {
  if (config === undefined || config.enabled !== true) return undefined;

  return (event) => {
    void sender(config.url, { type: 'usage_event', event }).catch((error) => {
      logger.error('Failed to report usage webhook', error);
    });
  };
}
