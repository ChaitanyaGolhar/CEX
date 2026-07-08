import type { Trade } from "../store/exchange-store.js";
import { TRADES } from "../store/exchange-store.js";
import type { Execution } from "../matching/execution.js";
import { generateTradeId } from "../utils/helpers.js";

/**
 * Trade Engine — creates trade records from executions.
 *
 * A Trade represents a completed market event visible in trade history.
 * Every execution produces exactly one trade.
 */
export function generateTrades(executions: Execution[]): Trade[] {
  const trades: Trade[] = [];

  for (const execution of executions) {
    const trade: Trade = {
      tradeId: generateTradeId(),
      symbol: execution.symbol,
      buyerOrderId: execution.buyerOrderId,
      sellerOrderId: execution.sellerOrderId,
      buyerUserId: execution.buyerUserId,
      sellerUserId: execution.sellerUserId,
      price: execution.price,
      qty: execution.qty,
      createdAt: execution.timestamp,
    };

    trades.push(trade);
    TRADES.push(trade);
  }

  return trades;
}
