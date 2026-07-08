import type { OrderBook, OrderRecord, RestingOrder } from "../store/exchange-store.js";
import type { Execution, MatchResult } from "./execution.js";
import { generateExecutionId } from "../utils/helpers.js";
import { findBestPriceInSide } from "../orderbook/orderbook-engine.js";

/**
 * Matches a limit order against the opposite side of the orderbook.
 * Implements Price-Time Priority:
 *   - Buy: matches against the LOWEST ask prices first.
 *   - Sell: matches against the HIGHEST bid prices first.
 *   - Within each price level, orders are consumed FIFO.
 *
 * The execution price is always the resting (maker) order's price.
 * The execution qty is min(incomingRemaining, restingRemaining).
 *
 * This function ONLY produces Execution objects.
 * It does NOT modify balances or generate trades.
 */
export function matchLimitOrder(
  order: OrderRecord,
  book: OrderBook,
): MatchResult {
  const executions: Execution[] = [];

  // Limit orders must have a price
  if (order.price === null) {
    return { executions, restingOrder: false };
  }

  const isBuy = order.side === "buy";
  const oppositeSide = isBuy ? book.asks : book.bids;

  let remainingQty = order.qty - order.filledQty;

  // Keep matching while there's remaining quantity
  while (remainingQty > 0) {
    // Find the best opposite price
    const bestPrice = findBestPriceInSide(oppositeSide, isBuy);
    if (bestPrice === null) break;

    // Check if prices cross
    if (isBuy && order.price < bestPrice) break;
    if (!isBuy && order.price > bestPrice) break;

    // Get orders at this price level (FIFO array)
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
        // Stale order, remove it
        restingOrders.shift();
        continue;
      }

      // Execution quantity is the minimum of both remaining quantities
      const execQty = Math.min(remainingQty, restingRemaining);

      // Execution price is always the resting (maker) order's price
      const execPrice = resting.price;

      // Determine buyer and seller
      const buyerOrderId = isBuy ? order.orderId : resting.orderId;
      const sellerOrderId = isBuy ? resting.orderId : order.orderId;
      const buyerUserId = isBuy ? order.userId : resting.userId;
      const sellerUserId = isBuy ? resting.userId : order.userId;

      // Generate execution
      const execution: Execution = {
        executionId: generateExecutionId(),
        symbol: order.symbol,
        buyerOrderId,
        sellerOrderId,
        buyerUserId,
        sellerUserId,
        price: execPrice,
        qty: execQty,
        timestamp: Date.now(),
      };

      executions.push(execution);

      // Update filled quantities
      order.filledQty += execQty;
      resting.filledQty += execQty;
      remainingQty -= execQty;

      // Remove fully filled resting orders
      if (resting.filledQty >= resting.qty) {
        restingOrders.shift();
        // If price level is now empty, clean it up
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

  // Determine if remaining quantity should rest in the book
  const shouldRest = remainingQty > 0;

  return {
    executions,
    restingOrder: shouldRest,
  };
}
