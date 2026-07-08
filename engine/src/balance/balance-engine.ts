import type { OrderRecord } from "../store/exchange-store.js";
import { parseSymbol, getOrCreateUserBalances, getOrCreateBalance } from "../utils/helpers.js";

// ─── Reserve Balance ─────────────────────────────────────────────────────────

/**
 * Reserves funds for an incoming limit order (or market sell).
 * Buy orders lock quote asset (price × qty).
 * Sell orders lock base asset (qty).
 */
export function reserveBalances(order: OrderRecord): void {
  const { baseAsset, quoteAsset } = parseSymbol(order.symbol);

  const userBalances = getOrCreateUserBalances(order.userId);

  if (order.side === "buy") {
    const quoteBalance = getOrCreateBalance(
      userBalances,
      quoteAsset,
    );

    const requiredAmount = order.qty * (order.price ?? 0);

    if (quoteBalance.available < requiredAmount) {
      throw new Error("Insufficient quote balance");
    }

    quoteBalance.available -= requiredAmount;
    quoteBalance.locked += requiredAmount;
  } else {
    const baseBalance = getOrCreateBalance(
      userBalances,
      baseAsset,
    );

    if (baseBalance.available < order.qty) {
      throw new Error("Insufficient base balance");
    }

    baseBalance.available -= order.qty;
    baseBalance.locked += order.qty;
  }
}

// ─── Market Buy Reservation ──────────────────────────────────────────────────

/**
 * Reserves funds for a market buy order.
 * Since market orders have no price, the entire available quote balance is locked.
 * Returns the locked amount so the pipeline can unlock excess after settlement.
 */
export function reserveMarketBuy(order: OrderRecord): number {
  const { quoteAsset } = parseSymbol(order.symbol);

  const userBalances = getOrCreateUserBalances(order.userId);
  const quoteBalance = getOrCreateBalance(userBalances, quoteAsset);

  if (quoteBalance.available <= 0) {
    throw new Error("Insufficient quote balance");
  }

  const lockAmount = quoteBalance.available;
  quoteBalance.locked += lockAmount;
  quoteBalance.available = 0;

  return lockAmount;
}

// ─── Unlock Funds ────────────────────────────────────────────────────────────

/**
 * Unlocks reserved funds for an order (e.g., on cancellation).
 * Calculates remaining unfilled quantity and unlocks the corresponding amount.
 */
export function unlockFunds(order: OrderRecord): void {
  const userBalances = getOrCreateUserBalances(order.userId);

  const { baseAsset, quoteAsset } = parseSymbol(order.symbol);

  if (order.side === "buy") {
    const balance = userBalances[quoteAsset];

    if (!balance) {
      throw new Error("Quote balance missing");
    }

    const remainingQty = order.qty - order.filledQty;
    const unlockAmount = remainingQty * (order.price ?? 0);

    balance.locked -= unlockAmount;
    balance.available += unlockAmount;
  } else {
    const balance = userBalances[baseAsset];

    if (!balance) {
      throw new Error("Base balance missing");
    }

    const remainingQty = order.qty - order.filledQty;

    balance.locked -= remainingQty;
    balance.available += remainingQty;
  }
}
