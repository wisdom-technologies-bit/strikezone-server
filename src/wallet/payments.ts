import { env } from "../lib/env.js";

/**
 * The money mode, as one descriptor.
 *
 * `MONEY_MODE` may only change three things: the currency code written to the
 * ledger, the label the interface shows, and which payment adapter would take a
 * deposit. Every rule, every balance, every ledger entry and every tournament
 * payout is byte-for-byte identical in both modes, which is what makes virtual
 * play a rehearsal for real play rather than a different game.
 */
export interface PaymentAdapter {
  readonly mode: "virtual" | "real";
  /** The ISO-style currency code stored on wallet accounts and ledger rows. */
  readonly currency: string;
  /** What the interface calls the unit, for example "coins" or "kobo amounts". */
  readonly label: string;
  /** The unit's scale: 100 minor units to one major unit, always. */
  readonly minorPerMajor: number;
  /** True when money can leave and enter the system through a provider. */
  readonly external: boolean;
}

/**
 * Virtual play uses XTS, ISO 4217's code reserved for testing. It is three
 * letters (so it satisfies the ledger's currency format), it can never be
 * confused with a real currency, and it keeps virtual and real balances in
 * separate accounts even in the same database.
 */
const VIRTUAL_CURRENCY = "XTS";

/** The adapter the process uses, from the environment and nowhere else. */
export function paymentAdapter(): PaymentAdapter {
  if (env.MONEY_MODE === "real") {
    return {
      mode: "real",
      currency: env.CURRENCY,
      label: `${env.CURRENCY} (minor units)`,
      minorPerMajor: 100,
      external: true,
    };
  }

  return {
    mode: "virtual",
    currency: VIRTUAL_CURRENCY,
    label: "virtual coins",
    minorPerMajor: 100,
    external: false,
  };
}

/** The currency this process keeps its ledger in. */
export function ledgerCurrency(): string {
  return paymentAdapter().currency;
}
