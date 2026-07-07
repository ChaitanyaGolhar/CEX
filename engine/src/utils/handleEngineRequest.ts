import { BALANCES, ORDERBOOKS, type Balance, type DepthLevel, type OrderBook, type OrderRecord, type RestingOrder } from "../store/exchange-store";

export function aggregateLevels(sideMap: Map<number, RestingOrder[]>, side: "bids" | "asks",): DepthLevel[] {
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

export function removeOrderFromBook(order: RestingOrder): void {
  const orderBook = ORDERBOOKS.get(order.symbol);

  if (!orderBook) {
    throw new Error("Orderbook not found");
  }

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

export function unlockFunds(order: OrderRecord): void {
  const userBalances = BALANCES.get(order.userId);

  if (!userBalances) {
    throw new Error("User balances not found");
  }

  const { baseAsset, quoteAsset } = parseSymbol(order.symbol);

  if (order.side === "buy") {
    const balance = userBalances[quoteAsset];

    if (!balance) {
      throw new Error("Quote balance missing");
    }

    const remainingQty = order.qty - order.filledQty;
    const unlockAmount = remainingQty * (order.price ?? 0);

    balance.locked -= unlockAmount;
    balance.available += unlockAmount;
  } else {
    const balance = userBalances[baseAsset];

    if (!balance) {
      throw new Error("Base balance missing");
    }

    const remainingQty = order.qty - order.filledQty;

    balance.locked -= remainingQty;
    balance.available += remainingQty;
  }
}

function parseSymbol(symbol: string): {
  baseAsset: string;
  quoteAsset: string;
} {
  if (!symbol.endsWith("USDT")) {
    throw new Error(`Unsupported symbol: ${symbol}`);
  }

  return {
    baseAsset: symbol.slice(0, -4),
    quoteAsset: "USDT",
  };
}

export function generateOrderId(): string {
  return crypto.randomUUID();
}

export function generateFillId(): string {
  return crypto.randomUUID();
}

export function getOrCreateUserBalances(userId: string,): Record<string, Balance> {
  let balances = BALANCES.get(userId);

  if (!balances) {
    balances = {};
    BALANCES.set(userId, balances);
  }

  return balances;
}

export function getOrCreateBalance(balances: Record<string, Balance>, asset: string,): Balance {
  if (!balances[asset]) {
    balances[asset] = {
      available: 0,
      locked: 0,
    };
  }

  return balances[asset];
}

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

export function reserveBalances(order: OrderRecord): void {
  const { baseAsset, quoteAsset } = parseSymbol(order.symbol);

  const userBalances = getOrCreateUserBalances(order.userId);

  if (order.side === "buy") {
    const quoteBalance = getOrCreateBalance(
      userBalances,
      quoteAsset,
    );

    const requiredAmount = order.qty * (order.price ?? 0);

    if (quoteBalance.available < requiredAmount) {
      throw new Error("Insufficient quote balance");
    }

    quoteBalance.available -= requiredAmount;
    quoteBalance.locked += requiredAmount;
  } else {
    const baseBalance = getOrCreateBalance(
      userBalances,
      baseAsset,
    );

    if (baseBalance.available < order.qty) {
      throw new Error("Insufficient base balance");
    }

    baseBalance.available -= order.qty;
    baseBalance.locked += order.qty;
  }
}