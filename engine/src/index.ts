import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import { BALANCES, ORDERBOOKS, ORDERS, type CreateOrderInput, type DepthResponse, type OrderRecord, type RestingOrder, type UserBalanceResponse } from "./store/exchange-store.js";
import { aggregateLevels, generateOrderId, removeOrderFromBook, unlockFunds } from "./utils/handleEngineRequest.js";

export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

export interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const brokerClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis broker client error", error);
});

const responseClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis response client error", error);
});

await Promise.all([brokerClient.connect(), responseClient.connect()]);


async function sendResponse(responseQueue: string, response: EngineResponse): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

function handleEngineRequest(message: EngineRequest): unknown {
    switch(message.type){
      case "cancel_order":
        return cancelOrder(message.payload);

      case "create_order":
        return createOrder(message.payload);

      case "get_depth":
        return getDepth(message.payload);

      case "get_order":
        return getOrder(message.payload);

      case "get_user_balance":
        return getUserBalance(message.payload);

      default: {
        const exhaustiveCheck: never = message.type;
        throw new Error(`Unsupported engine command: ${exhaustiveCheck}`);
      }
    }

    function createOrder(payload: Record<string, unknown>): OrderRecord {
      const userId = payload.userId;
      const side = payload.side;
      const type = payload.type;
      const symbol = payload.symbol;
      const price = payload.price;
      const qty = payload.qty;

      if (typeof userId !== "string" || userId.trim() === "") {
        throw new Error("Invalid userId");
      }

      if (side !== "buy" && side !== "sell") {
        throw new Error("Invalid side");
      }

      if (type !== "market" && type !== "limit") {
        throw new Error("Invalid order type");
      }

      if (typeof symbol !== "string" || symbol.trim() === "") {
        throw new Error("Invalid symbol");
      }

      const normalizedSymbol = symbol.trim().toUpperCase();

      if (
        typeof qty !== "number" ||
        !Number.isFinite(qty) ||
        qty <= 0
      ) {
        throw new Error("Invalid qty");
      }

      if (type === "limit") {
        if (
          typeof price !== "number" ||
          !Number.isFinite(price) ||
          price <= 0
        ) {
          throw new Error("Invalid limit price");
        }
      }

      if (type === "market") {
        if (price !== null && price !== undefined) {
          throw new Error("Market orders cannot specify price");
        }
      }

      let normalizedPrice: number | null;

      if (type === "market") {
        normalizedPrice = null;
      } else {
        if (
          typeof price !== "number" ||
          !Number.isFinite(price) ||
          price <= 0
        ) {
          throw new Error("Invalid limit price");
        }

        normalizedPrice = price;
      }

      const input: CreateOrderInput = {
        userId,
        side,
        type,
        symbol: normalizedSymbol,
        price: normalizedPrice,
        qty,
      };

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
        createdAt: Date.now(),
      };

      ORDERS.set(orderId, order);

      return order;
    }

    function getDepth(payload: Record<string, unknown>): DepthResponse {
    const symbol = payload.symbol;

    if (typeof symbol !== "string" || symbol.trim() === "") {
      throw new Error("Invalid symbol");
    }

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
    
    function getUserBalance(payload: Record<string, unknown>,): UserBalanceResponse {
    const userId = payload.userId;

    if (typeof userId !== "string" || userId.trim() === "") {
      throw new Error("Invalid userId");
    }

    const balances = BALANCES.get(userId);

    return {
      userId,
      balances: balances ?? {},
    };
    }

    function getOrder(payload: Record<string, unknown>): OrderRecord {
      const orderId = payload.orderId;

      if (typeof orderId !== "string" || orderId.trim() === "") {
        throw new Error("Invalid orderId");
      }

      const order = ORDERS.get(orderId);

      if (!order) {
        throw new Error("Order not found");
      }

      return order;
    }

    function cancelOrder(payload: Record<string, unknown>): OrderRecord {
      const orderId = payload.orderId;

      if (typeof orderId !== "string" || orderId.trim() === "") {
        throw new Error("Invalid orderId");
      }

      const order = ORDERS.get(orderId);

      if (!order) {
        throw new Error("Order not found");
      }

      if (order.status === "filled") {
        throw new Error("Filled order cannot be cancelled");
      }

      if (order.status === "cancelled") {
        throw new Error("Order already cancelled");
      }

      if (order.type !== "limit") {
        throw new Error("Only resting limit orders can be cancelled");
      }

      removeOrderFromBook(order as RestingOrder);

      unlockFunds(order);

      order.status = "cancelled";

      return order;
    }
}

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

for (;;) {
  const item = await brokerClient.brPop(env.incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;
  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    const data = handleEngineRequest(message);
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}