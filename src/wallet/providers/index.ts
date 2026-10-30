import { paymentAdapter } from "../payments.js";
import { ManualProvider } from "./manual.js";
import { MockProvider } from "./mock.js";
import type { PaymentProvider } from "./provider.js";

/**
 * Which provider handles money in this process.
 *
 * Virtual play uses the mock, which settles instantly. Real money starts on the
 * manual provider until a card provider is implemented and tested. The choice is
 * configuration, not code: `MONEY_MODE` decides, and nothing else does.
 */

const providers = new Map<string, PaymentProvider>();

function build(name: string): PaymentProvider | null {
  switch (name) {
    case "mock":
      return new MockProvider();
    case "manual":
      return new ManualProvider();
    default:
      return null;
  }
}

/** The provider for a name, or null when no such provider is configured. */
export function providerByName(name: string): PaymentProvider | null {
  const cached = providers.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const built = build(name);
  if (built !== null) {
    providers.set(name, built);
  }
  return built;
}

/** The provider this process uses for its own deposits and withdrawals. */
export function activeProvider(): PaymentProvider {
  const wanted = paymentAdapter().mode === "real" ? "manual" : "mock";
  const provider = providerByName(wanted);
  if (provider === null) {
    throw new Error(`no payment provider named ${wanted}`);
  }
  return provider;
}

export type { PaymentProvider };
export { ManualProvider, MockProvider };
export { ProviderNotConfiguredError } from "./provider.js";
export type { DepositIntent, PayoutResult, WebhookVerdict } from "./provider.js";
