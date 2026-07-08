import type { OrderBook, OrderRecord } from "../store/exchange-store.js";
import type { MatchResult } from "./execution.js";
import { matchLimitOrder } from "./limit-matcher.js";
import { matchMarketOrder } from "./market-matcher.js";

/**
 * Matching Engine — the heart of the exchange.
 *
 * Routes incoming orders to the appropriate matching algorithm
 * based on order type (limit or market).
 *
 * Responsibilities:
 *   - Determine which orders trade
 *   - Calculate execution price and quantity
 *   - Update filledQty on matched orders
 *   - Remove filled resting orders from the book
 *   - Return Execution objects
 *
 * NOT responsible for:
 *   - Balance updates / settlement
 *   - Trade / fill record creation
 *   - Market data updates
 *   - WebSocket events
 */
export function matchOrder(
  order: OrderRecord,
  book: OrderBook,
): MatchResult {
  switch (order.type) {
    case "limit":
      return matchLimitOrder(order, book);

    case "market":
      return matchMarketOrder(order, book);

    default: {
      const exhaustiveCheck: never = order.type;
      throw new Error(`Unsupported order type: ${exhaustiveCheck}`);
    }
  }
}
