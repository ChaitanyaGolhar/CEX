import { describe, test, expect, beforeEach } from "bun:test";
import {
  BALANCES,
  ORDERBOOKS,
  ORDERS,
  FILLS,
  TRADES,
  type OrderRecord,
  type RestingOrder,
} from "../src/store/exchange-store.js";
import {
  processCreateOrder,
  processCancelOrder,
  processGetDepth,
  processGetOrder,
  processGetUserBalance,
} from "../src/order-pipeline.js";
import {
  getOrCreateUserBalances,
  getOrCreateBalance,
} from "../src/utils/helpers.js";
import { addOrderToBook } from "../src/orderbook/orderbook-engine.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function resetExchangeState(): void {
  BALANCES.clear();
  ORDERBOOKS.clear();
  ORDERS.clear();
  FILLS.length = 0;
  TRADES.length = 0;
}

function seedBalance(userId: string, asset: string, available: number): void {
  const balances = getOrCreateUserBalances(userId);
  const balance = getOrCreateBalance(balances, asset);
  balance.available = available;
  balance.locked = 0;
}

function seedRestingOrder(params: {
  orderId: string;
  userId: string;
  side: "buy" | "sell";
  symbol: string;
  price: number;
  qty: number;
}): RestingOrder {
  const order: RestingOrder = {
    orderId: params.orderId,
    userId: params.userId,
    side: params.side,
    type: "limit",
    symbol: params.symbol,
    price: params.price,
    qty: params.qty,
    filledQty: 0,
    status: "open",
    createdAt: Date.now(),
  };

  // Store in ORDERS as OrderRecord
  const orderRecord: OrderRecord = {
    ...order,
    fills: [],
    averagePrice: null,
  };
  ORDERS.set(order.orderId, orderRecord);

  // Add to orderbook
  addOrderToBook(order);

  // Reserve balance
  const balances = getOrCreateUserBalances(params.userId);
  if (params.side === "sell") {
    const base = params.symbol.slice(0, -4);
    const bal = getOrCreateBalance(balances, base);
    bal.available -= params.qty;
    bal.locked += params.qty;
  } else {
    const bal = getOrCreateBalance(balances, "USDT");
    const amount = params.qty * params.price;
    bal.available -= amount;
    bal.locked += amount;
  }

  return order;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CREATE ORDER
// ═══════════════════════════════════════════════════════════════════════════════

describe("1. Create Order", () => {
  beforeEach(() => {
    resetExchangeState();
  });

  // ── Case 1: Limit Buy Order Does Not Match ────────────────────────────────

  test("Case 1: Limit buy does not match when price below best ask", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    // Existing ask at 200
    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 200,
      qty: 5,
    });

    // Buy at 100 — below best ask of 200
    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    expect(result.order.status).toBe("open");
    expect(result.order.filledQty).toBe(0);
    expect(result.order.averagePrice).toBeNull();
    expect(result.order.fills).toHaveLength(0);

    // Depth should show both orders
    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.bids).toHaveLength(1);
    expect(depth.bids[0]!.price).toBe(100);
    expect(depth.bids[0]!.qty).toBe(5);
    expect(depth.asks).toHaveLength(1);
    expect(depth.asks[0]!.price).toBe(200);
    expect(depth.asks[0]!.qty).toBe(5);
  });

  // ── Case 2: Limit Buy Matches Best Ask ────────────────────────────────────

  test("Case 2: Limit buy matches best ask at equal price", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    expect(result.order.status).toBe("filled");
    expect(result.order.filledQty).toBe(5);
    expect(result.order.averagePrice).toBe(100);

    // Seller order should also be filled
    const sellerOrder = ORDERS.get("sell-1")!;
    expect(sellerOrder.status).toBe("filled");
    expect(sellerOrder.filledQty).toBe(5);
  });

  // ── Case 3: Limit Buy Has Better Price Than Best Ask ──────────────────────

  test("Case 3: Limit buy fills at resting price, not order price", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    // Buy at 200 — should fill at the resting price of 100
    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 200,
      qty: 5,
    });

    expect(result.order.status).toBe("filled");
    expect(result.order.filledQty).toBe(5);
    expect(result.order.averagePrice).toBe(100); // NOT 200

    // Buyer's balance should reflect the lower execution price
    const buyerBal = BALANCES.get("buyer1")!;
    expect(buyerBal["BTC"]!.available).toBe(5);
    // Paid 500 USDT (5 * 100), not 1000 (5 * 200)
    expect(buyerBal["USDT"]!.available).toBe(100000 - 500);
    expect(buyerBal["USDT"]!.locked).toBe(0);
  });

  // ── Case 4: Limit Sell Order Does Not Match ───────────────────────────────

  test("Case 4: Limit sell does not match when price above best bid", () => {
    seedBalance("buyer1", "USDT", 100000);
    seedBalance("seller1", "BTC", 10);

    // Existing bid at 100
    seedRestingOrder({
      orderId: "buy-1",
      userId: "buyer1",
      side: "buy",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    // Sell at 200 — above best bid of 100
    const result = processCreateOrder({
      userId: "seller1",
      side: "sell",
      type: "limit",
      symbol: "BTCUSDT",
      price: 200,
      qty: 5,
    });

    expect(result.order.status).toBe("open");
    expect(result.order.filledQty).toBe(0);
    expect(result.order.averagePrice).toBeNull();
    expect(result.order.fills).toHaveLength(0);
  });

  // ── Case 5: Limit Sell Has Better Price Than Best Bid ─────────────────────

  test("Case 5: Limit sell fills at resting bid price, not order price", () => {
    seedBalance("buyer1", "USDT", 100000);
    seedBalance("seller1", "BTC", 10);

    // Existing bid at 200
    seedRestingOrder({
      orderId: "buy-1",
      userId: "buyer1",
      side: "buy",
      symbol: "BTCUSDT",
      price: 200,
      qty: 5,
    });

    // Sell at 100 — best bid is 200, so fills at 200
    const result = processCreateOrder({
      userId: "seller1",
      side: "sell",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    expect(result.order.status).toBe("filled");
    expect(result.order.filledQty).toBe(5);
    expect(result.order.averagePrice).toBe(200); // NOT 100

    // Seller gets 200 * 5 = 1000 USDT
    const sellerBal = BALANCES.get("seller1")!;
    expect(sellerBal["USDT"]!.available).toBe(1000);
  });

  // ── Case 6: Partial Fill ──────────────────────────────────────────────────

  test("Case 6: Limit buy partially fills, remainder rests", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    // Only 3 BTC available at 100
    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 3,
    });

    // Buy 10 — only 3 available
    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 10,
    });

    expect(result.order.status).toBe("partially_filled");
    expect(result.order.filledQty).toBe(3);
    expect(result.order.averagePrice).toBe(100);

    // Depth: remaining 7 should rest on bids
    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.bids).toHaveLength(1);
    expect(depth.bids[0]!.price).toBe(100);
    expect(depth.bids[0]!.qty).toBe(7);
    expect(depth.asks).toHaveLength(0);
  });

  // ── Case 7: Match Multiple Price Levels ───────────────────────────────────

  test("Case 7: Buy sweeps multiple price levels", () => {
    seedBalance("s1", "BTC", 10);
    seedBalance("s2", "BTC", 10);
    seedBalance("s3", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({ orderId: "sell-100", userId: "s1", side: "sell", symbol: "BTCUSDT", price: 100, qty: 2 });
    seedRestingOrder({ orderId: "sell-110", userId: "s2", side: "sell", symbol: "BTCUSDT", price: 110, qty: 3 });
    seedRestingOrder({ orderId: "sell-120", userId: "s3", side: "sell", symbol: "BTCUSDT", price: 120, qty: 5 });

    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 120,
      qty: 10,
    });

    expect(result.order.status).toBe("filled");
    expect(result.order.filledQty).toBe(10);

    // Average price: (2*100 + 3*110 + 5*120) / 10 = (200+330+600)/10 = 113
    expect(result.order.averagePrice).toBe(113);

    expect(result.executions).toHaveLength(3);
    expect(result.executions[0]!.price).toBe(100);
    expect(result.executions[0]!.qty).toBe(2);
    expect(result.executions[1]!.price).toBe(110);
    expect(result.executions[1]!.qty).toBe(3);
    expect(result.executions[2]!.price).toBe(120);
    expect(result.executions[2]!.qty).toBe(5);
  });

  // ── Case 8: Limit Buy Should Not Cross Above Allowed Price ────────────────

  test("Case 8: Limit buy stops matching above its price", () => {
    seedBalance("s1", "BTC", 10);
    seedBalance("s2", "BTC", 10);
    seedBalance("s3", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({ orderId: "sell-100", userId: "s1", side: "sell", symbol: "BTCUSDT", price: 100, qty: 2 });
    seedRestingOrder({ orderId: "sell-110", userId: "s2", side: "sell", symbol: "BTCUSDT", price: 110, qty: 3 });
    seedRestingOrder({ orderId: "sell-130", userId: "s3", side: "sell", symbol: "BTCUSDT", price: 130, qty: 5 });

    // Buy at 110 — can match 100 and 110, but NOT 130
    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 110,
      qty: 10,
    });

    expect(result.order.status).toBe("partially_filled");
    expect(result.order.filledQty).toBe(5);

    // Average price: (2*100 + 3*110) / 5 = (200+330)/5 = 106
    expect(result.order.averagePrice).toBe(106);

    // Depth: remaining 5 at 110 as bid, 5 at 130 as ask
    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.bids).toHaveLength(1);
    expect(depth.bids[0]!.price).toBe(110);
    expect(depth.bids[0]!.qty).toBe(5);
    expect(depth.asks).toHaveLength(1);
    expect(depth.asks[0]!.price).toBe(130);
    expect(depth.asks[0]!.qty).toBe(5);
  });

  // ── Case 9: Market Buy Fully Filled ───────────────────────────────────────

  test("Case 9: Market buy fully filled", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "market",
      symbol: "BTCUSDT",
      qty: 5,
    });

    expect(result.order.status).toBe("filled");
    expect(result.order.filledQty).toBe(5);
    expect(result.order.averagePrice).toBe(100);

    // Buyer gets BTC
    const buyerBal = BALANCES.get("buyer1")!;
    expect(buyerBal["BTC"]!.available).toBe(5);
  });

  // ── Case 10: Market Buy Partially Filled ──────────────────────────────────

  test("Case 10: Market buy partially filled, remaining cancelled", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 2,
    });

    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "market",
      symbol: "BTCUSDT",
      qty: 5,
    });

    expect(result.order.status).toBe("partially_filled");
    expect(result.order.filledQty).toBe(2);
    expect(result.order.averagePrice).toBe(100);

    // Market orders should NOT rest on the book
    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.bids).toHaveLength(0);
    expect(depth.asks).toHaveLength(0);

    // Buyer paid only 200 USDT (2 * 100), rest unlocked
    const buyerBal = BALANCES.get("buyer1")!;
    expect(buyerBal["USDT"]!.available).toBe(100000 - 200);
    expect(buyerBal["USDT"]!.locked).toBe(0);
    expect(buyerBal["BTC"]!.available).toBe(2);
  });

  // ── Case 11: Market Order With Empty Book ─────────────────────────────────

  test("Case 11: Market buy with empty book is cancelled", () => {
    seedBalance("buyer1", "USDT", 100000);

    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "market",
      symbol: "BTCUSDT",
      qty: 5,
    });

    expect(result.order.status).toBe("cancelled");
    expect(result.order.filledQty).toBe(0);
    expect(result.order.averagePrice).toBeNull();
    expect(result.order.fills).toHaveLength(0);

    // Balance unchanged
    const buyerBal = BALANCES.get("buyer1")!;
    expect(buyerBal["USDT"]!.available).toBe(100000);
    expect(buyerBal["USDT"]!.locked).toBe(0);
  });

  // ── Case 12: Price-Time Priority (FIFO) ───────────────────────────────────

  test("Case 12: Same price orders match in FIFO order", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("seller2", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    // First sell order
    seedRestingOrder({
      orderId: "sell-first",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    // Second sell order at same price
    seedRestingOrder({
      orderId: "sell-second",
      userId: "seller2",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    // Buy 5 — should match the first sell order
    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    expect(result.executions).toHaveLength(1);
    // First sell order should be matched (FIFO)
    expect(result.executions[0]!.sellerOrderId).toBe("sell-first");
    expect(result.executions[0]!.qty).toBe(5);

    // First seller filled, second still open
    const seller1Order = ORDERS.get("sell-first")!;
    expect(seller1Order.status).toBe("filled");

    const seller2Order = ORDERS.get("sell-second")!;
    expect(seller2Order.status).toBe("open");
    expect(seller2Order.filledQty).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. GET DEPTH
// ═══════════════════════════════════════════════════════════════════════════════

describe("2. Get Depth", () => {
  beforeEach(() => {
    resetExchangeState();
  });

  // ── Case 1: Empty Order Book ──────────────────────────────────────────────

  test("Case 1: Empty order book returns empty arrays", () => {
    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.symbol).toBe("BTCUSDT");
    expect(depth.bids).toHaveLength(0);
    expect(depth.asks).toHaveLength(0);
  });

  // ── Case 2: Bids Sorted Highest First ─────────────────────────────────────

  test("Case 2: Bids sorted highest price first", () => {
    seedBalance("b1", "USDT", 100000);
    seedBalance("b2", "USDT", 100000);
    seedBalance("b3", "USDT", 100000);

    seedRestingOrder({ orderId: "b-100", userId: "b1", side: "buy", symbol: "BTCUSDT", price: 100, qty: 5 });
    seedRestingOrder({ orderId: "b-120", userId: "b2", side: "buy", symbol: "BTCUSDT", price: 120, qty: 3 });
    seedRestingOrder({ orderId: "b-90", userId: "b3", side: "buy", symbol: "BTCUSDT", price: 90, qty: 2 });

    const depth = processGetDepth({ symbol: "BTCUSDT" });

    expect(depth.bids).toHaveLength(3);
    expect(depth.bids[0]!.price).toBe(120);
    expect(depth.bids[0]!.qty).toBe(3);
    expect(depth.bids[1]!.price).toBe(100);
    expect(depth.bids[1]!.qty).toBe(5);
    expect(depth.bids[2]!.price).toBe(90);
    expect(depth.bids[2]!.qty).toBe(2);
  });

  // ── Case 3: Asks Sorted Lowest First ──────────────────────────────────────

  test("Case 3: Asks sorted lowest price first", () => {
    seedBalance("s1", "BTC", 20);
    seedBalance("s2", "BTC", 20);
    seedBalance("s3", "BTC", 20);

    seedRestingOrder({ orderId: "s-120", userId: "s1", side: "sell", symbol: "BTCUSDT", price: 120, qty: 3 });
    seedRestingOrder({ orderId: "s-100", userId: "s2", side: "sell", symbol: "BTCUSDT", price: 100, qty: 5 });
    seedRestingOrder({ orderId: "s-90", userId: "s3", side: "sell", symbol: "BTCUSDT", price: 90, qty: 2 });

    const depth = processGetDepth({ symbol: "BTCUSDT" });

    expect(depth.asks).toHaveLength(3);
    expect(depth.asks[0]!.price).toBe(90);
    expect(depth.asks[0]!.qty).toBe(2);
    expect(depth.asks[1]!.price).toBe(100);
    expect(depth.asks[1]!.qty).toBe(5);
    expect(depth.asks[2]!.price).toBe(120);
    expect(depth.asks[2]!.qty).toBe(3);
  });

  // ── Case 4: Same Price Orders Grouped ─────────────────────────────────────

  test("Case 4: Orders at same price aggregated into single level", () => {
    seedBalance("b1", "USDT", 100000);
    seedBalance("b2", "USDT", 100000);

    seedRestingOrder({ orderId: "b-1", userId: "b1", side: "buy", symbol: "BTCUSDT", price: 100, qty: 5 });
    seedRestingOrder({ orderId: "b-2", userId: "b2", side: "buy", symbol: "BTCUSDT", price: 100, qty: 3 });

    const depth = processGetDepth({ symbol: "BTCUSDT" });

    expect(depth.bids).toHaveLength(1);
    expect(depth.bids[0]!.price).toBe(100);
    expect(depth.bids[0]!.qty).toBe(8);
  });

  // ── Case 5: Filled Orders Not Visible ─────────────────────────────────────

  test("Case 5: Filled orders do not appear in depth", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    // Fully fill the sell order
    processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.bids).toHaveLength(0);
    expect(depth.asks).toHaveLength(0);
  });

  // ── Case 6: Cancelled Orders Not Visible ──────────────────────────────────

  test("Case 6: Cancelled orders do not appear in depth", () => {
    seedBalance("seller1", "BTC", 10);

    const result = processCreateOrder({
      userId: "seller1",
      side: "sell",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    // Cancel it
    processCancelOrder({
      userId: "seller1",
      orderId: result.order.orderId,
    });

    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.bids).toHaveLength(0);
    expect(depth.asks).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. GET BALANCE
// ═══════════════════════════════════════════════════════════════════════════════

describe("3. Get Balance", () => {
  beforeEach(() => {
    resetExchangeState();
  });

  // ── Case 1: User Balance ──────────────────────────────────────────────────

  test("Case 1: Returns user balances correctly", () => {
    seedBalance("user1", "USDT", 1000000);
    seedBalance("user1", "BTC", 1000);

    const result = processGetUserBalance({ userId: "user1" });

    expect(result.balances["USDT"]!.available).toBe(1000000);
    expect(result.balances["USDT"]!.locked).toBe(0);
    expect(result.balances["BTC"]!.available).toBe(1000);
    expect(result.balances["BTC"]!.locked).toBe(0);
  });

  // ── Case 2: Buyer Balance After Fill ──────────────────────────────────────

  test("Case 2: Buyer balance updated after fill", () => {
    seedBalance("buyer1", "USDT", 1000000);
    seedBalance("buyer1", "BTC", 1000);
    seedBalance("seller1", "BTC", 100);

    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    const buyerBal = BALANCES.get("buyer1")!;
    // USD decreases by 500 (5 * 100)
    expect(buyerBal["USDT"]!.available).toBe(1000000 - 500);
    // BTC increases by 5
    expect(buyerBal["BTC"]!.available).toBe(1000 + 5);
  });

  // ── Case 3: Seller Balance After Fill ─────────────────────────────────────

  test("Case 3: Seller balance updated after fill", () => {
    seedBalance("seller1", "USDT", 1000000);
    seedBalance("seller1", "BTC", 1000);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({
      orderId: "buy-1",
      userId: "buyer1",
      side: "buy",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    processCreateOrder({
      userId: "seller1",
      side: "sell",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    const sellerBal = BALANCES.get("seller1")!;
    // BTC decreases by 5
    expect(sellerBal["BTC"]!.available).toBe(1000 - 5);
    // USD increases by 500
    expect(sellerBal["USDT"]!.available).toBe(1000000 + 500);
  });

  // ── Case 4: Balance Locking ───────────────────────────────────────────────

  test("Case 4: Buy order locks USDT, cancel unlocks it", () => {
    seedBalance("buyer1", "USDT", 1000000);

    // Place open buy order — should lock USDT
    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    let bal = BALANCES.get("buyer1")!;
    expect(bal["USDT"]!.available).toBe(1000000 - 500);
    expect(bal["USDT"]!.locked).toBe(500);

    // Cancel — should unlock
    processCancelOrder({
      userId: "buyer1",
      orderId: result.order.orderId,
    });

    bal = BALANCES.get("buyer1")!;
    expect(bal["USDT"]!.available).toBe(1000000);
    expect(bal["USDT"]!.locked).toBe(0);
  });

  test("Case 4b: Sell order locks BTC, cancel unlocks it", () => {
    seedBalance("seller1", "BTC", 1000);

    const result = processCreateOrder({
      userId: "seller1",
      side: "sell",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    let bal = BALANCES.get("seller1")!;
    expect(bal["BTC"]!.available).toBe(1000 - 5);
    expect(bal["BTC"]!.locked).toBe(5);

    processCancelOrder({
      userId: "seller1",
      orderId: result.order.orderId,
    });

    bal = BALANCES.get("seller1")!;
    expect(bal["BTC"]!.available).toBe(1000);
    expect(bal["BTC"]!.locked).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. GET ORDER
// ═══════════════════════════════════════════════════════════════════════════════

describe("4. Get Order", () => {
  beforeEach(() => {
    resetExchangeState();
  });

  // ── Case 1: Open Order ────────────────────────────────────────────────────

  test("Case 1: Returns open order correctly", () => {
    seedBalance("user1", "USDT", 100000);

    const createResult = processCreateOrder({
      userId: "user1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    const order = processGetOrder({
      userId: "user1",
      orderId: createResult.order.orderId,
    });

    expect(order.orderId).toBe(createResult.order.orderId);
    expect(order.side).toBe("buy");
    expect(order.type).toBe("limit");
    expect(order.symbol).toBe("BTCUSDT");
    expect(order.price).toBe(100);
    expect(order.qty).toBe(5);
    expect(order.filledQty).toBe(0);
    expect(order.status).toBe("open");
    expect(order.fills).toHaveLength(0);
  });

  // ── Case 2: Partially Filled Order ────────────────────────────────────────

  test("Case 2: Returns partially filled order", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 4,
    });

    const createResult = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 10,
    });

    const order = processGetOrder({
      userId: "buyer1",
      orderId: createResult.order.orderId,
    });

    expect(order.status).toBe("partially_filled");
    expect(order.qty).toBe(10);
    expect(order.filledQty).toBe(4);
  });

  // ── Case 3: Filled Order ──────────────────────────────────────────────────

  test("Case 3: Returns filled order", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 10,
    });

    const createResult = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 10,
    });

    const order = processGetOrder({
      userId: "buyer1",
      orderId: createResult.order.orderId,
    });

    expect(order.status).toBe("filled");
    expect(order.filledQty).toBe(10);
  });

  // ── Case 4: Unknown Order ────────────────────────────────────────────────

  test("Case 4: Unknown order returns error", () => {
    expect(() =>
      processGetOrder({ userId: "user1", orderId: "nonexistent-id" }),
    ).toThrow("Order not found");
  });

  // ── Case 5: Another User's Order ─────────────────────────────────────────

  test("Case 5: Cannot read another user's order", () => {
    seedBalance("user1", "USDT", 100000);

    const createResult = processCreateOrder({
      userId: "user1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    // user2 trying to read user1's order
    expect(() =>
      processGetOrder({
        userId: "user2",
        orderId: createResult.order.orderId,
      }),
    ).toThrow("Order not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CANCEL ORDER
// ═══════════════════════════════════════════════════════════════════════════════

describe("5. Cancel Order", () => {
  beforeEach(() => {
    resetExchangeState();
  });

  // ── Case 1: Cancel Open Limit Order ───────────────────────────────────────

  test("Case 1: Cancel open limit order", () => {
    seedBalance("user1", "USDT", 100000);

    const createResult = processCreateOrder({
      userId: "user1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 10,
    });

    const cancelled = processCancelOrder({
      userId: "user1",
      orderId: createResult.order.orderId,
    });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.qty).toBe(10);
    expect(cancelled.filledQty).toBe(0);

    // Should be removed from depth
    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.bids).toHaveLength(0);
  });

  // ── Case 2: Cancel Partially Filled Order ─────────────────────────────────

  test("Case 2: Cancel partially filled order", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    // Create buy order for 10
    const buyResult = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 10,
    });

    // Partially fill it with a sell for 4
    seedRestingOrder({
      orderId: "does-not-matter",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 4,
    });

    // Actually, let me restructure: buyer rests, seller fills partially
    resetExchangeState();
    seedBalance("buyer1", "USDT", 100000);
    seedBalance("seller1", "BTC", 10);

    // Buyer places order first (rests in book)
    const restingBuy = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 10,
    });

    // Seller partially fills it
    processCreateOrder({
      userId: "seller1",
      side: "sell",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 4,
    });

    // Verify partially filled
    const orderBefore = processGetOrder({
      userId: "buyer1",
      orderId: restingBuy.order.orderId,
    });
    expect(orderBefore.status).toBe("partially_filled");
    expect(orderBefore.filledQty).toBe(4);

    // Cancel it
    const cancelled = processCancelOrder({
      userId: "buyer1",
      orderId: restingBuy.order.orderId,
    });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.qty).toBe(10);
    expect(cancelled.filledQty).toBe(4);

    // Remaining 6 qty should be removed from depth
    const depth = processGetDepth({ symbol: "BTCUSDT" });
    expect(depth.bids).toHaveLength(0);

    // Remaining locked USDT should be unlocked (6 * 100 = 600)
    const buyerBal = BALANCES.get("buyer1")!;
    expect(buyerBal["USDT"]!.locked).toBe(0);
  });

  // ── Case 3: Cancel Filled Order ───────────────────────────────────────────

  test("Case 3: Cannot cancel filled order", () => {
    seedBalance("seller1", "BTC", 10);
    seedBalance("buyer1", "USDT", 100000);

    seedRestingOrder({
      orderId: "sell-1",
      userId: "seller1",
      side: "sell",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    const result = processCreateOrder({
      userId: "buyer1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    expect(() =>
      processCancelOrder({
        userId: "buyer1",
        orderId: result.order.orderId,
      }),
    ).toThrow("Filled order cannot be cancelled");
  });

  // ── Case 4: Cancel Already Cancelled Order ────────────────────────────────

  test("Case 4: Cannot cancel already cancelled order", () => {
    seedBalance("user1", "USDT", 100000);

    const result = processCreateOrder({
      userId: "user1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    processCancelOrder({
      userId: "user1",
      orderId: result.order.orderId,
    });

    expect(() =>
      processCancelOrder({
        userId: "user1",
        orderId: result.order.orderId,
      }),
    ).toThrow("Order already cancelled");
  });

  // ── Case 5: Cancel Unknown Order ──────────────────────────────────────────

  test("Case 5: Cannot cancel unknown order", () => {
    expect(() =>
      processCancelOrder({ userId: "user1", orderId: "nonexistent-id" }),
    ).toThrow("Order not found");
  });

  // ── Case 6: Cancel Another User's Order ───────────────────────────────────

  test("Case 6: Cannot cancel another user's order", () => {
    seedBalance("user1", "USDT", 100000);

    const result = processCreateOrder({
      userId: "user1",
      side: "buy",
      type: "limit",
      symbol: "BTCUSDT",
      price: 100,
      qty: 5,
    });

    // user2 trying to cancel user1's order
    expect(() =>
      processCancelOrder({
        userId: "user2",
        orderId: result.order.orderId,
      }),
    ).toThrow("Order not found");
  });
});
