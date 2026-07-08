import type { OrderBook, OrderRecord, RestingOrder } from "../store/exchange-store.js";
import type { Execution, MatchResult } from "./execution.js";
import { generateExecutionId } from "../utils/helpers.js";
import { findBestPriceInSide } from "../orderbook/orderbook-engine.js";

/**
 * Matches a market order against the opposite side of the orderbook.
 *
 * Market orders:
 *   - Have no price constraint (take any available price)
 *   - NEVER rest in the orderbook
 *   - Remaining unfilled quantity is abandoned (cancelled)
 *
 * Uses price-time priority identical to limit matching,
 * except there is no price crossing check.
 */
export function matchMarketOrder(
  order: OrderRecord,
  book: OrderBook,
): MatchResult {
  const executions: Execution[] = [];
  const isBuy = order.side === "buy";
  const oppositeSide = isBuy ? book.asks : book.bids;

  let remainingQty = order.qty - order.filledQty;

  while (remainingQty > 0) {
    // Find the best opposite price
    const bestPrice = findBestPriceInSide(oppositeSide, isBuy);
    if (bestPrice === null) break; // No more liquidity

    // NO price crossing check — market orders take any price

    const restingOrders = oppositeSide.get(bestPrice);
    if (!restingOrders || restingOrders.length === 0) {
      oppositeSide.delete(bestPrice);
      continue;
    }

    // Consume orders FIFO from front of the array
    while (remainingQty > 0 && restingOrders.length > 0) {
      const resting = restingOrders[0]!;
      const restingRemaining = resting.qty - resting.filledQty;

      if (restingRemaining <= 0) {
        restingOrders.shift();
        continue;
      }

      const execQty = Math.min(remainingQty, restingRemaining);
      const execPrice = resting.price;

      const buyerOrderId = isBuy ? order.orderId : resting.orderId;
      const sellerOrderId = isBuy ? resting.orderId : order.orderId;
      const buyerUserId = isBuy ? order.userId : resting.userId;
      const sellerUserId = isBuy ? resting.userId : order.userId;

      executions.push({
        executionId: generateExecutionId(),
        symbol: order.symbol,
        buyerOrderId,
        sellerOrderId,
        buyerUserId,
        sellerUserId,
        price: execPrice,
        qty: execQty,
        timestamp: Date.now(),
      });

      order.filledQty += execQty;
      resting.filledQty += execQty;
      remainingQty -= execQty;

      if (resting.filledQty >= resting.qty) {
        restingOrders.shift();
        if (restingOrders.length === 0) {
          oppositeSide.delete(bestPrice);
        }
      }
    }

    // Clean up empty price levels
    if (restingOrders.length === 0) {
      oppositeSide.delete(bestPrice);
    }
  }

  return {
    executions,
    restingOrder: false, // Market orders NEVER rest
  };
}
