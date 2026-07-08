import {
  ORDERS,
  ORDERBOOKS,
  BALANCES,
  type OrderRecord,
  type RestingOrder,
  type DepthResponse,
  type UserBalanceResponse,
  type Trade,
} from "./store/exchange-store.js";
import {
  validateCreateOrder,
  validateCancelOrder,
  validateGetOrder,
  validateGetDepth,
  validateGetUserBalance,
} from "./validation/validation.js";
import { reserveBalances, unlockFunds, reserveMarketBuy } from "./balance/balance-engine.js";
import { addOrderToBook, removeOrderFromBook, aggregateLevels } from "./orderbook/orderbook-engine.js";
import { matchOrder } from "./matching/matching-engine.js";
import { settleExecutions } from "./settlement/settlement-engine.js";
import { generateTrades } from "./trade/trade-engine.js";
import { updateTicker, getTicker } from "./market-data/ticker.js";
import { generateFills } from "./trade/fill-engine.js";
import { publishMessage } from "./websocket/publisher.js";
import { generateOrderId, getOrCreateOrderBook, parseSymbol, getOrCreateUserBalances, getOrCreateBalance } from "./utils/helpers.js";
import type { Execution } from "./matching/execution.js";

// ─── Response Types ──────────────────────────────────────────────────────────

export interface CreateOrderResponse {
  order: OrderRecord;
  executions: Execution[];
  trades: Trade[];
}

// ─── Order Processing Pipeline ───────────────────────────────────────────────

/**
 * The canonical order processing pipeline.
 * Every order passes through the same stages:
 *
 *   1. Validate input
 *   2. Generate order record
 *   3. Reserve funds
 *   4. Match against orderbook
 *   5. Sync resting order state to ORDERS
 *   6. Settle executions (transfer assets)
 *   7. Unlock excess reservation (price improvement / market order excess)
 *   8. Generate trades
 *   9. Generate fills
 *   10. Update order statuses (incoming + resting)
 *   11. Calculate averagePrice
 *   12. Handle market order remaining (cancel unfilled portion)
 *   13. Rest remaining quantity (limit orders only)
 *   14. Return result
 */
export function processCreateOrder(payload: Record<string, unknown>): CreateOrderResponse {
  // 1. Validate
  const input = validateCreateOrder(payload);

  // 2. Create order record
  const orderId = generateOrderId();
  const order: OrderRecord = {
    orderId,
    userId: input.userId,
    side: input.side,
    type: input.type,
    symbol: input.symbol,
    price: input.price,
    qty: input.qty,
    filledQty: 0,
    status: "open",
    fills: [],
    averagePrice: null,
    createdAt: Date.now(),
  };

  // 3. Reserve funds
  // Market buys lock entire available quote (no fixed price to calculate).
  // All other orders use standard reservation.
  let marketBuyLockedAmount = 0;
  if (order.type === "market" && order.side === "buy") {
    marketBuyLockedAmount = reserveMarketBuy(order);
  } else {
    reserveBalances(order);
  }

  // Store order only after reservation succeeds
  ORDERS.set(orderId, order);

  // 4. Match against orderbook
  const book = getOrCreateOrderBook(input.symbol);
  const matchResult = matchOrder(order, book);

  // 5. Sync resting order filledQty to ORDERS store.
  //    The matching engine updates filledQty on the book's RestingOrder objects,
  //    which are separate references from the OrderRecords in ORDERS.
  //    We sync here using execution data to keep them consistent.
  for (const execution of matchResult.executions) {
    const restingOrderId = order.side === "buy"
      ? execution.sellerOrderId
      : execution.buyerOrderId;
    const restingOrderRecord = ORDERS.get(restingOrderId);
    if (restingOrderRecord) {
      restingOrderRecord.filledQty += execution.qty;
    }
  }

  // 6. Settle executions (transfer assets)
  if (matchResult.executions.length > 0) {
    settleExecutions(matchResult.executions);
  }

  // 7. Unlock excess reservation for buy orders
  unlockExcessReservation(order, matchResult.executions, marketBuyLockedAmount);

  // 8. Generate trades
  const trades = generateTrades(matchResult.executions);

  // Update ticker
  updateTicker(trades);

  // 9. Generate fills
  generateFills(matchResult.executions);

  // 10. Update order statuses
  updateOrderStatus(order);

  // Also update status of matched resting orders
  for (const execution of matchResult.executions) {
    const restingOrderId = order.side === "buy"
      ? execution.sellerOrderId
      : execution.buyerOrderId;
    const restingOrderRecord = ORDERS.get(restingOrderId);
    if (restingOrderRecord) {
      updateOrderStatus(restingOrderRecord);
    }
  }

  // 11. Calculate averagePrice (from fills attached to each order)
  order.averagePrice = calculateAveragePriceFromOrder(order);

  // Also update averagePrice for matched resting orders
  for (const execution of matchResult.executions) {
    const restingOrderId = order.side === "buy"
      ? execution.sellerOrderId
      : execution.buyerOrderId;
    const restingOrderRecord = ORDERS.get(restingOrderId);
    if (restingOrderRecord) {
      restingOrderRecord.averagePrice = calculateAveragePriceFromOrder(restingOrderRecord);
    }
  }

  // 12. Handle market order remaining quantity (never rests)
  if (order.type === "market" && order.filledQty < order.qty) {
    if (order.filledQty === 0) {
      order.status = "cancelled";
    }
    // If filledQty > 0 but < qty: status stays "partially_filled" (set by updateOrderStatus)
  }

  // 13. Rest remaining quantity in the orderbook (limit orders only)
  if (matchResult.restingOrder && order.type === "limit" && order.price !== null) {
    const restingOrder: RestingOrder = {
      orderId: order.orderId,
      userId: order.userId,
      side: order.side,
      type: "limit",
      symbol: order.symbol,
      price: order.price,
      qty: order.qty,
      filledQty: order.filledQty,
      status: order.status,
      createdAt: order.createdAt,
    };
    addOrderToBook(restingOrder);
  }

  // 14. Publish WebSocket events
  void publishMessage(`depth.${input.symbol}`, processGetDepth({ symbol: input.symbol }));
  
  if (trades.length > 0) {
    for (const trade of trades) {
      void publishMessage(`trade.${input.symbol}`, trade);
    }
    const updatedTicker = getTicker(input.symbol as string);
    if (updatedTicker) {
      void publishMessage(`ticker.${input.symbol}`, updatedTicker);
    }
  }

  // Publish to private channels for all involved users
  const involvedUsers = new Set<string>();
  involvedUsers.add(order.userId);
  for (const execution of matchResult.executions) {
    involvedUsers.add(execution.buyerUserId);
    involvedUsers.add(execution.sellerUserId);
  }

  for (const uid of involvedUsers) {
    // Send full balance state
    void publishMessage(`balance.${uid}`, processGetUserBalance({ userId: uid }));
    
    // Send updated order state for any order belonging to this user that was modified
    if (order.userId === uid) {
      void publishMessage(`orders.${uid}`, order);
    }
    
    for (const execution of matchResult.executions) {
      const restingOrderId = order.side === "buy" ? execution.sellerOrderId : execution.buyerOrderId;
      const restingOrderRecord = ORDERS.get(restingOrderId);
      if (restingOrderRecord && restingOrderRecord.userId === uid) {
        void publishMessage(`orders.${uid}`, restingOrderRecord);
      }
    }
  }

  // 15. Return result
  return {
    order,
    executions: matchResult.executions,
    trades,
  };
}

// ─── Cancel Order ────────────────────────────────────────────────────────────

export function processCancelOrder(payload: Record<string, unknown>): OrderRecord {
  const { orderId } = validateCancelOrder(payload);
  const userId = payload.userId;

  const order = ORDERS.get(orderId);

  if (!order) {
    throw new Error("order not found");
  }

  // User ownership check — return same error to avoid revealing existence
  if (typeof userId === "string" && order.userId !== userId) {
    throw new Error("order not found");
  }

  if (order.status === "filled") {
    throw new Error("filled orders cannot be cancelled");
  }

  if (order.status === "cancelled") {
    throw new Error("order already cancelled");
  }

  if (order.type !== "limit") {
    throw new Error("Only resting limit orders can be cancelled");
  }

  // Remove from orderbook
  removeOrderFromBook(order as RestingOrder);

  // Unlock reserved funds
  unlockFunds(order);

  // Update status
  order.status = "cancelled";

  // Publish updated depth
  void publishMessage(`depth.${order.symbol}`, processGetDepth({ symbol: order.symbol }));
  void publishMessage(`orders.${order.userId}`, order);
  void publishMessage(`balance.${order.userId}`, processGetUserBalance({ userId: order.userId }));

  return order;
}

// ─── Get Ticker ──────────────────────────────────────────────────────────────

export function processGetTicker(payload: Record<string, unknown>): any {
  if (typeof payload.symbol !== "string") {
    throw new Error("Invalid symbol");
  }
  const ticker = getTicker(payload.symbol);
  if (!ticker) {
    throw new Error("ticker not found");
  }
  return ticker;
}

// ─── Get Depth ───────────────────────────────────────────────────────────────

export function processGetDepth(payload: Record<string, unknown>): DepthResponse {
  const { symbol } = validateGetDepth(payload);

  const orderBook = ORDERBOOKS.get(symbol);

  if (!orderBook) {
    return {
      symbol,
      bids: [],
      asks: [],
    };
  }

  return {
    symbol,
    bids: aggregateLevels(orderBook.bids, "bids"),
    asks: aggregateLevels(orderBook.asks, "asks"),
  };
}

// ─── Get User Balance ────────────────────────────────────────────────────────

export function processGetUserBalance(payload: Record<string, unknown>): UserBalanceResponse {
  const { userId } = validateGetUserBalance(payload);

  const balances = BALANCES.get(userId);

  return {
    userId,
    balances: balances ?? {},
  };
}

// ─── Get Order ───────────────────────────────────────────────────────────────

export function processGetOrder(payload: Record<string, unknown>): OrderRecord {
  const { orderId } = validateGetOrder(payload);
  const userId = payload.userId;

  const order = ORDERS.get(orderId);

  if (!order) {
    throw new Error("order not found");
  }

  // User ownership check — return same error to avoid revealing existence
  if (typeof userId === "string" && order.userId !== userId) {
    throw new Error("order not found");
  }

  return order;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Updates order status based on filledQty.
 * Called after matching for both incoming and resting orders.
 */
function updateOrderStatus(order: OrderRecord): void {
  if (order.status === "cancelled") return;

  if (order.filledQty >= order.qty) {
    order.status = "filled";
  } else if (order.filledQty > 0) {
    order.status = "partially_filled";
  } else {
    order.status = "open";
  }
}

/**
 * Calculates average execution price from an order's fills.
 * Returns null if the order has no fills.
 */
function calculateAveragePriceFromOrder(order: OrderRecord): number | null {
  if (order.fills.length === 0) return null;

  const totalValue = order.fills.reduce((sum, fill) => sum + fill.price * fill.qty, 0);
  const totalQty = order.fills.reduce((sum, fill) => sum + fill.qty, 0);

  if (totalQty === 0) return null;

  return totalValue / totalQty;
}

/**
 * Unlocks excess reserved balance for buy orders after settlement.
 *
 * Handles two cases:
 *   1. Limit buy fills at a better price than the order price (price improvement).
 *      Excess = sum((orderPrice - execPrice) * execQty)
 *   2. Market buy didn't consume all locked quote balance.
 *      Excess = lockedAmount - totalSettledCost
 *   3. Market sell didn't fully fill (unlock remaining base).
 */
function unlockExcessReservation(
  order: OrderRecord,
  executions: Execution[],
  marketBuyLockedAmount: number,
): void {
  if (order.type === "market") {
    if (order.side === "buy") {
      // Market buy: unlock all locked quote that wasn't consumed by settlement
      const totalSettled = executions.reduce((sum, e) => sum + e.price * e.qty, 0);
      const excess = marketBuyLockedAmount - totalSettled;
      if (excess > 0) {
        const { quoteAsset } = parseSymbol(order.symbol);
        const userBalances = getOrCreateUserBalances(order.userId);
        const quoteBalance = getOrCreateBalance(userBalances, quoteAsset);
        quoteBalance.locked -= excess;
        quoteBalance.available += excess;
      }
    } else {
      // Market sell: unlock unfilled base qty (market sells don't rest)
      const unfilledQty = order.qty - order.filledQty;
      if (unfilledQty > 0) {
        const { baseAsset } = parseSymbol(order.symbol);
        const userBalances = getOrCreateUserBalances(order.userId);
        const baseBalance = getOrCreateBalance(userBalances, baseAsset);
        baseBalance.locked -= unfilledQty;
        baseBalance.available += unfilledQty;
      }
    }
  } else if (order.type === "limit" && order.side === "buy" && order.price !== null) {
    // Limit buy: unlock price improvement excess
    // When a buy order fills at a lower price than the order price,
    // the difference was locked but not needed.
    const excess = executions.reduce((sum, exec) => {
      return sum + (order.price! - exec.price) * exec.qty;
    }, 0);
    if (excess > 0) {
      const { quoteAsset } = parseSymbol(order.symbol);
      const userBalances = getOrCreateUserBalances(order.userId);
      const quoteBalance = getOrCreateBalance(userBalances, quoteAsset);
      quoteBalance.locked -= excess;
      quoteBalance.available += excess;
    }
  }
  // Limit sell: no excess possible (locked exact qty of base asset)
}
