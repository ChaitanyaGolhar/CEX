import type { Balance, UserBalanceResponse } from "../store/exchange-store.js";
import { getOrCreateUserBalances, getOrCreateBalance } from "../utils/helpers.js";

// ─── Faucet Configuration ────────────────────────────────────────────────────

const FAUCET_AMOUNTS: Record<string, number> = {
  USDT: 100_000,
  BTC: 10,
  ETH: 100,
  SOL: 1_000,
};

// ─── Faucet Processing ──────────────────────────────────────────────────────

/**
 * Credits virtual assets to a user's balance.
 * Reuses existing balance helpers — never manipulates storage directly.
 *
 * Rules:
 *  - Amounts are added to existing available balances (additive, not reset).
 *  - Locked balances remain unchanged.
 *  - Missing asset balances are created automatically via getOrCreateBalance.
 */
export function processFaucet(payload: Record<string, unknown>): UserBalanceResponse {
  const userId = payload.userId;

  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("Invalid userId");
  }

  const userBalances = getOrCreateUserBalances(userId);

  for (const [asset, amount] of Object.entries(FAUCET_AMOUNTS)) {
    const balance: Balance = getOrCreateBalance(userBalances, asset);
    balance.available += amount;
  }

  return {
    userId,
    balances: userBalances,
  };
}
