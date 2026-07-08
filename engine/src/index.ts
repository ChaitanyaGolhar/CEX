import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import {
  processCreateOrder,
  processCancelOrder,
  processGetDepth,
  processGetOrder,
  processGetUserBalance,
  processGetTicker,
} from "./order-pipeline.js";

// ─── Engine Command Types ────────────────────────────────────────────────────

import type {
  EngineCommandType,
  EngineRequest,
  EngineResponse,
} from "../../backend/src/types/engine.js";

import { connectPublisher } from "./websocket/publisher.js";

// ─── Redis Clients ───────────────────────────────────────────────────────────

const brokerClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis broker client error", error);
});

const responseClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis response client error", error);
});

await Promise.all([brokerClient.connect(), responseClient.connect(), connectPublisher()]);

// ─── Response Helper ─────────────────────────────────────────────────────────

async function sendResponse(responseQueue: string, response: EngineResponse): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

import {
  processListOrders,
  processGetPublicTrades,
  processGetMyTrades,
  processGetMarkets,
  processGetKlines,
} from "./query-pipeline.js";

import { processFaucet } from "./wallet/wallet-service.js";

// ─── Command Dispatcher ──────────────────────────────────────────────────────

/**
 * Dispatches engine commands to the appropriate handler.
 * Each handler is an isolated module with a single responsibility.
 * The engine processes one command completely before the next (deterministic).
 */
function handleEngineRequest(message: EngineRequest): unknown {
  switch (message.type) {
    case "create_order":
      return processCreateOrder(message.payload);

    case "cancel_order":
      return processCancelOrder(message.payload);

    case "get_depth":
      return processGetDepth(message.payload);

    case "get_order":
      return processGetOrder(message.payload);

    case "get_user_balance":
      return processGetUserBalance(message.payload);

    case "get_ticker":
      return processGetTicker(message.payload);

    case "list_orders":
      return processListOrders(message.payload);

    case "get_public_trades":
      return processGetPublicTrades(message.payload);

    case "get_my_trades":
      return processGetMyTrades(message.payload);

    case "get_markets":
      return processGetMarkets();

    case "get_klines":
      return processGetKlines(message.payload);

    case "faucet":
      return processFaucet(message.payload);

    default: {
      const exhaustiveCheck: never = message.type;
      throw new Error(`Unsupported engine command: ${exhaustiveCheck}`);
    }
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

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