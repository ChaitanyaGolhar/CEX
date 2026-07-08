import type { DepthLevel, OrderBook, RestingOrder } from "../store/exchange-store.js";
import { getOrCreateOrderBook } from "../utils/helpers.js";

// ─── Add Order to Book ───────────────────────────────────────────────────────

/**
 * Adds a resting limit order to the appropriate side of the orderbook.
 * Preserves FIFO ordering within each price level.
 */
export function addOrderToBook(order: RestingOrder): void {
  const orderBook = getOrCreateOrderBook(order.symbol);

  const sideMap =
    order.side === "buy"
      ? orderBook.bids
      : orderBook.asks;

  const restingOrders = sideMap.get(order.price) ?? [];

  restingOrders.push(order);

  sideMap.set(order.price, restingOrders);
}

// ─── Remove Order from Book ──────────────────────────────────────────────────

/**
 * Removes a specific order from the orderbook.
 * Cleans up empty price levels.
 */
export function removeOrderFromBook(order: RestingOrder): void {
  const orderBook = getOrCreateOrderBook(order.symbol);

  const sideMap = order.side === "buy"
    ? orderBook.bids
    : orderBook.asks;

  const restingOrders = sideMap.get(order.price);

  if (!restingOrders) {
    throw new Error("Price level not found");
  }

  const filteredOrders = restingOrders.filter(
    (restingOrder) => restingOrder.orderId !== order.orderId,
  );

  if (filteredOrders.length === 0) {
    sideMap.delete(order.price);
  } else {
    sideMap.set(order.price, filteredOrders);
  }
}

// ─── Best Price Queries ──────────────────────────────────────────────────────

/**
 * Finds the best price in a side map.
 * Used by matching algorithms to locate the best opposite level.
 *
 * For buy incoming (looking at asks): returns the LOWEST price.
 * For sell incoming (looking at bids): returns the HIGHEST price.
 */
export function findBestPriceInSide(
  sideMap: Map<number, RestingOrder[]>,
  isBuyIncoming: boolean,
): number | null {
  if (sideMap.size === 0) return null;

  let best: number | null = null;

  for (const price of sideMap.keys()) {
    if (best === null) {
      best = price;
    } else if (isBuyIncoming && price < best) {
      // Buy incoming → looking at asks → want lowest
      best = price;
    } else if (!isBuyIncoming && price > best) {
      // Sell incoming → looking at bids → want highest
      best = price;
    }
  }

  return best;
}

/**
 * Returns the best (highest) bid price, or null if no bids exist.
 */
export function getBestBid(book: OrderBook): number | null {
  if (book.bids.size === 0) return null;

  let best: number | null = null;

  for (const price of book.bids.keys()) {
    if (best === null || price > best) {
      best = price;
    }
  }

  return best;
}

/**
 * Returns the best (lowest) ask price, or null if no asks exist.
 */
export function getBestAsk(book: OrderBook): number | null {
  if (book.asks.size === 0) return null;

  let best: number | null = null;

  for (const price of book.asks.keys()) {
    if (best === null || price < best) {
      best = price;
    }
  }

  return best;
}

// ─── Depth Aggregation ───────────────────────────────────────────────────────

/**
 * Aggregates resting orders at each price level into depth levels.
 * Returns sorted array: bids descending by price, asks ascending.
 */
export function aggregateLevels(
  sideMap: Map<number, RestingOrder[]>,
  side: "bids" | "asks",
): DepthLevel[] {
  const levels: DepthLevel[] = [];

  for (const [price, orders] of sideMap.entries()) {
    const qty = orders.reduce((sum, order) => {
      return sum + (order.qty - order.filledQty);
    }, 0);

    if (qty > 0) {
      levels.push({
        price,
        qty,
      });
    }
  }

  if (side === "bids") {
    levels.sort((a, b) => b.price - a.price);
  } else {
    levels.sort((a, b) => a.price - b.price);
  }

  return levels;
}
