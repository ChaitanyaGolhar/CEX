import { ORDERS, FILLS, type OrderRecord, type Fill } from "./store/exchange-store.js";
import { MARKETS } from "./config/markets.js";

// ─── List Orders ─────────────────────────────────────────────────────────────

export function processListOrders(payload: Record<string, unknown>): { orders: OrderRecord[] } {
  const userId = payload.userId as string;
  const status = payload.status as string | undefined;
  const symbol = payload.symbol as string | undefined;
  // Cursor and limit can be implemented later, skipping for MVP
  // const limit = payload.limit ? Number(payload.limit) : 50;

  if (!userId) throw new Error("userId is required");

  let orders = Array.from(ORDERS.values()).filter((o) => o.userId === userId);

  if (symbol) {
    orders = orders.filter((o) => o.symbol === symbol);
  }

  if (status && status !== "all") {
    orders = orders.filter((o) => o.status === status);
  }

  orders.sort((a, b) => b.createdAt - a.createdAt);

  return { orders };
}

// ─── Get Public Trades ───────────────────────────────────────────────────────

export function processGetPublicTrades(payload: Record<string, unknown>): { symbol: string; trades: Omit<Fill, "buyOrderId" | "sellOrderId">[] } {
  const symbol = payload.symbol as string;
  if (!symbol) throw new Error("symbol is required");

  const trades = FILLS.filter((f) => f.symbol === symbol).map((f) => {
    // Strip user/order specific IDs for public feed
    return {
      fillId: f.fillId,
      symbol: f.symbol,
      price: f.price,
      qty: f.qty,
      createdAt: f.createdAt,
    };
  });
  
  trades.sort((a, b) => b.createdAt - a.createdAt);

  return { symbol, trades };
}

// ─── Get My Trades ───────────────────────────────────────────────────────────

export function processGetMyTrades(payload: Record<string, unknown>): { trades: Fill[] } {
  const userId = payload.userId as string;
  const symbol = payload.symbol as string | undefined;

  if (!userId) throw new Error("userId is required");

  // A trade belongs to the user if they were the buyer or seller
  // We can determine this by checking if the fill's buyOrderId or sellOrderId belongs to the user
  const userOrderIds = new Set(
    Array.from(ORDERS.values())
      .filter((o) => o.userId === userId)
      .map((o) => o.orderId)
  );

  let trades = FILLS.filter((f) => userOrderIds.has(f.buyOrderId) || userOrderIds.has(f.sellOrderId));

  if (symbol) {
    trades = trades.filter((f) => f.symbol === symbol);
  }

  trades.sort((a, b) => b.createdAt - a.createdAt);

  return { trades };
}

// ─── Get Markets ─────────────────────────────────────────────────────────────

export function processGetMarkets(): { markets: typeof MARKETS } {
  return { markets: MARKETS };
}

// ─── Get Klines ──────────────────────────────────────────────────────────────

export function processGetKlines(payload: Record<string, unknown>) {
  const symbol = payload.symbol as string;
  const interval = (payload.interval as string) || "1m";
  
  if (!symbol) throw new Error("symbol is required");

  // Determine bucket size in ms
  let bucketMs = 60 * 1000;
  if (interval === "5m") bucketMs = 5 * 60 * 1000;
  if (interval === "1h") bucketMs = 60 * 60 * 1000;

  const trades = FILLS.filter((f) => f.symbol === symbol);
  
  const buckets = new Map<number, any>();

  for (const trade of trades) {
    const bucketTime = Math.floor(trade.createdAt / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketTime);
    
    if (!bucket) {
      buckets.set(bucketTime, {
        time: bucketTime,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.qty,
      });
    } else {
      bucket.high = Math.max(bucket.high, trade.price);
      bucket.low = Math.min(bucket.low, trade.price);
      bucket.close = trade.price; // assuming trades are processed in chronological order
      bucket.volume += trade.qty;
    }
  }

  // Trades might not be strictly chronological if FILLS array got out of order (though it shouldn't)
  // Let's ensure it's sorted first
  const sortedTrades = [...trades].sort((a, b) => a.createdAt - b.createdAt);
  
  const accurateBuckets = new Map<number, any>();
  for (const trade of sortedTrades) {
    const bucketTime = Math.floor(trade.createdAt / bucketMs) * bucketMs;
    const bucket = accurateBuckets.get(bucketTime);
    
    if (!bucket) {
      accurateBuckets.set(bucketTime, {
        time: bucketTime,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.qty,
      });
    } else {
      bucket.high = Math.max(bucket.high, trade.price);
      bucket.low = Math.min(bucket.low, trade.price);
      bucket.close = trade.price;
      bucket.volume += trade.qty;
    }
  }

  const candles = Array.from(accurateBuckets.values()).sort((a, b) => a.time - b.time);

  return { symbol, interval, candles };
}
