import type { CreateOrderInput } from "../store/exchange-store.js";

// ─── Create Order Validation ─────────────────────────────────────────────────

export function validateCreateOrder(payload: Record<string, unknown>): CreateOrderInput {
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

  return {
    userId,
    side,
    type,
    symbol: normalizedSymbol,
    price: normalizedPrice,
    qty,
  };
}

// ─── Cancel Order Validation ─────────────────────────────────────────────────

export function validateCancelOrder(payload: Record<string, unknown>): { orderId: string } {
  const orderId = payload.orderId;

  if (typeof orderId !== "string" || orderId.trim() === "") {
    throw new Error("Invalid orderId");
  }

  return { orderId };
}

// ─── Get Order Validation ────────────────────────────────────────────────────

export function validateGetOrder(payload: Record<string, unknown>): { orderId: string } {
  const orderId = payload.orderId;

  if (typeof orderId !== "string" || orderId.trim() === "") {
    throw new Error("Invalid orderId");
  }

  return { orderId };
}

// ─── Get Depth Validation ────────────────────────────────────────────────────

export function validateGetDepth(payload: Record<string, unknown>): { symbol: string } {
  const symbol = payload.symbol;

  if (typeof symbol !== "string" || symbol.trim() === "") {
    throw new Error("Invalid symbol");
  }

  return { symbol };
}

// ─── Get User Balance Validation ─────────────────────────────────────────────

export function validateGetUserBalance(payload: Record<string, unknown>): { userId: string } {
  const userId = payload.userId;

  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("Invalid userId");
  }

  return { userId };
}
