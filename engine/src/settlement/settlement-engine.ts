import type { Execution } from "../matching/execution.js";
import { parseSymbol, getOrCreateUserBalances, getOrCreateBalance } from "../utils/helpers.js";

/**
 * Settlement Engine — processes executions and transfers assets.
 *
 * For each execution in a spot trade:
 *   Buyer:
 *     - Unlock quote (price × qty) from locked
 *     - Credit base (qty) to available
 *   Seller:
 *     - Unlock base (qty) from locked
 *     - Credit quote (price × qty) to available
 *
 * This module NEVER determines which orders trade.
 * It only moves assets based on Execution objects from the Matching Engine.
 */
export function settleExecutions(executions: Execution[]): void {
  for (const execution of executions) {
    settleExecution(execution);
  }
}

function settleExecution(execution: Execution): void {
  const { baseAsset, quoteAsset } = parseSymbol(execution.symbol);

  const quoteAmount = execution.price * execution.qty;

  // ─── Buyer Settlement ────────────────────────────────────────────────
  // Buyer had quote asset locked → unlock quote, credit base
  const buyerBalances = getOrCreateUserBalances(execution.buyerUserId);

  const buyerQuoteBalance = getOrCreateBalance(buyerBalances, quoteAsset);
  buyerQuoteBalance.locked -= quoteAmount;

  const buyerBaseBalance = getOrCreateBalance(buyerBalances, baseAsset);
  buyerBaseBalance.available += execution.qty;

  // ─── Seller Settlement ───────────────────────────────────────────────
  // Seller had base asset locked → unlock base, credit quote
  const sellerBalances = getOrCreateUserBalances(execution.sellerUserId);

  const sellerBaseBalance = getOrCreateBalance(sellerBalances, baseAsset);
  sellerBaseBalance.locked -= execution.qty;

  const sellerQuoteBalance = getOrCreateBalance(sellerBalances, quoteAsset);
  sellerQuoteBalance.available += quoteAmount;
}
