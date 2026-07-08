import { describe, it, expect, beforeEach } from "bun:test";
import { ORDERS, ORDERBOOKS, BALANCES, FILLS, TRADES, type OrderBook, type OrderRecord } from "../store/exchange-store.js";
import { processCreateOrder, processCancelOrder, processGetDepth } from "../order-pipeline.js";
import { getOrCreateUserBalances, getOrCreateBalance } from "../utils/helpers.js";

describe("Matching Engine", () => {
  beforeEach(() => {
    // Reset all state before each test
    ORDERS.clear();
    ORDERBOOKS.clear();
    BALANCES.clear();
    FILLS.length = 0;
    TRADES.length = 0;
  });

  function setupBalances(userId: string, asset: string, available: number) {
    const balances = getOrCreateUserBalances(userId);
    const bal = getOrCreateBalance(balances, asset);
    bal.available = available;
    bal.locked = 0;
  }

  function getBalance(userId: string, asset: string) {
    return BALANCES.get(userId)?.[asset] ?? { available: 0, locked: 0 };
  }

  it("Placing a limit buy with insufficient balance throws and creates no order", () => {
    setupBalances("user1", "USDT", 99); // Need 100

    expect(() => {
      processCreateOrder({
        userId: "user1",
        type: "limit",
        side: "buy",
        symbol: "BTCUSDT",
        price: 100,
        qty: 1,
      });
    }).toThrow("Insufficient quote balance");

    expect(ORDERS.size).toBe(0);
  });

  it("Placing a limit sell that doesn't cross the book appears in the order book", () => {
    setupBalances("user1", "BTC", 1);

    const res = processCreateOrder({
      userId: "user1",
      type: "limit",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 1,
    });

    expect(res.order.status).toBe("open");
    
    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.asks.length).toBe(1);
    expect(depth.asks[0].price).toBe(100);
    expect(depth.asks[0].qty).toBe(1);
    expect(depth.bids.length).toBe(0);
  });

  it("Crossing limit orders produce exactly one Fill, balances move, filledQty/status update", () => {
    setupBalances("maker", "BTC", 1);
    setupBalances("taker", "USDT", 200);

    // Maker places sell order
    const makerRes = processCreateOrder({
      userId: "maker",
      type: "limit",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 1,
    });

    expect(makerRes.order.status).toBe("open");
    expect(getBalance("maker", "BTC").locked).toBe(1);

    // Taker places buy order that crosses
    const takerRes = processCreateOrder({
      userId: "taker",
      type: "limit",
      side: "buy",
      symbol: "BTCUSDT",
      price: 120, // Price improvement for taker, matches at 100
      qty: 1,
    });

    // Exactly one Fill was generated for this execution
    expect(FILLS.length).toBe(1);
    const fill = FILLS[0];
    expect(fill.price).toBe(100);
    expect(fill.qty).toBe(1);
    expect(fill.buyOrderId).toBe(takerRes.order.orderId);
    expect(fill.sellOrderId).toBe(makerRes.order.orderId);

    // Both orders updated
    expect(takerRes.order.status).toBe("filled");
    expect(takerRes.order.filledQty).toBe(1);
    
    const updatedMakerOrder = ORDERS.get(makerRes.order.orderId)!;
    expect(updatedMakerOrder.status).toBe("filled");
    expect(updatedMakerOrder.filledQty).toBe(1);

    // Balances moved correctly
    // Maker: 1 BTC locked -> 0 locked, 0 available. Received 100 USDT available
    expect(getBalance("maker", "BTC").locked).toBe(0);
    expect(getBalance("maker", "BTC").available).toBe(0);
    expect(getBalance("maker", "USDT").available).toBe(100);

    // Taker: locked 120 USDT -> unlocked 20, paid 100. Received 1 BTC available
    expect(getBalance("taker", "USDT").locked).toBe(0);
    expect(getBalance("taker", "USDT").available).toBe(100); // 200 - 100 = 100
    expect(getBalance("taker", "BTC").available).toBe(1);

    // Orderbook should be empty
    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.asks.length).toBe(0);
    expect(depth.bids.length).toBe(0);
  });

  it("A market order with sufficient opposite-side liquidity fills completely and never appears in ORDERBOOKS", () => {
    setupBalances("maker", "BTC", 2);
    setupBalances("taker", "USDT", 1000);

    processCreateOrder({
      userId: "maker",
      type: "limit",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 2,
    });

    const takerRes = processCreateOrder({
      userId: "taker",
      type: "market",
      side: "buy",
      symbol: "BTCUSDT",
      price: null,
      qty: 1, // Only buy 1
    });

    expect(takerRes.order.status).toBe("filled");
    expect(takerRes.order.filledQty).toBe(1);

    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.bids.length).toBe(0);
    expect(depth.asks[0].qty).toBe(1); // Remaining 1 BTC on the ask
  });

  it("A market order with zero opposite-side liquidity resolves to cancelled with filledQty: 0", () => {
    setupBalances("taker", "USDT", 1000);

    const takerRes = processCreateOrder({
      userId: "taker",
      type: "market",
      side: "buy",
      symbol: "BTCUSDT",
      price: null,
      qty: 1,
    });

    expect(takerRes.order.status).toBe("cancelled");
    expect(takerRes.order.filledQty).toBe(0);

    // Balances should be unlocked
    expect(getBalance("taker", "USDT").available).toBe(1000);
    expect(getBalance("taker", "USDT").locked).toBe(0);
  });

  it("Cancelling a partially-filled resting limit order unlocks only the remaining locked amount", () => {
    setupBalances("maker", "BTC", 2);
    setupBalances("taker", "USDT", 1000);

    const makerRes = processCreateOrder({
      userId: "maker",
      type: "limit",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 2,
    });
    
    // Maker now has 0 available, 2 locked
    expect(getBalance("maker", "BTC").locked).toBe(2);
    expect(getBalance("maker", "BTC").available).toBe(0);

    // Taker buys 1
    processCreateOrder({
      userId: "taker",
      type: "limit",
      side: "buy",
      symbol: "BTCUSDT",
      price: 100,
      qty: 1,
    });

    // Maker now has 1 locked (for the remaining 1 qty), 0 available BTC (received 100 USDT)
    expect(getBalance("maker", "BTC").locked).toBe(1);
    expect(getBalance("maker", "BTC").available).toBe(0);

    // Cancel the remainder
    processCancelOrder({
      userId: "maker",
      orderId: makerRes.order.orderId
    });

    // Maker should now have 0 locked, 1 available BTC
    expect(getBalance("maker", "BTC").locked).toBe(0);
    expect(getBalance("maker", "BTC").available).toBe(1);
    
    const updatedOrder = ORDERS.get(makerRes.order.orderId)!;
    expect(updatedOrder.status).toBe("cancelled");
    expect(updatedOrder.filledQty).toBe(1); // Did fill 1 before
  });
});
