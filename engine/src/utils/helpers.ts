import { BALANCES, ORDERBOOKS, type Balance, type OrderBook } from "../store/exchange-store.js";

import { MARKETS } from "../config/markets.js";

// ─── Symbol Parsing ──────────────────────────────────────────────────────────

export function parseSymbol(symbol: string): {
  baseAsset: string;
  quoteAsset: string;
} {
  const market = MARKETS.find((m) => m.symbol === symbol);
  
  if (!market) {
    throw new Error(`Unsupported symbol: ${symbol}`);
  }

  return {
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
  };
}

// ─── ID Generation ───────────────────────────────────────────────────────────

export function generateOrderId(): string {
  return crypto.randomUUID();
}

export function generateFillId(): string {
  return crypto.randomUUID();
}

export function generateTradeId(): string {
  return crypto.randomUUID();
}

export function generateExecutionId(): string {
  return crypto.randomUUID();
}

// ─── Balance Helpers ─────────────────────────────────────────────────────────

export function getOrCreateUserBalances(userId: string): Record<string, Balance> {
  let balances = BALANCES.get(userId);

  if (!balances) {
    balances = {};
    BALANCES.set(userId, balances);
  }

  return balances;
}

export function getOrCreateBalance(
  balances: Record<string, Balance>,
  asset: string,
): Balance {
  if (!balances[asset]) {
    balances[asset] = {
      available: 0,
      locked: 0,
    };
  }

  return balances[asset];
}

// ─── OrderBook Helpers ───────────────────────────────────────────────────────

export function getOrCreateOrderBook(symbol: string): OrderBook {
  let orderBook = ORDERBOOKS.get(symbol);

  if (!orderBook) {
    orderBook = {
      bids: new Map(),
      asks: new Map(),
    };

    ORDERBOOKS.set(symbol, orderBook);
  }

  return orderBook;
}
