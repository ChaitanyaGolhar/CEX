/**
 * Represents a single match between an incoming order and a resting order.
 * The Matching Engine produces these — Settlement consumes them.
 * This entity is the bridge between matching and settlement,
 * keeping the two concerns completely decoupled.
 */
export interface Execution {
  executionId: string;
  symbol: string;
  buyerOrderId: string;
  sellerOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  price: number;
  qty: number;
  timestamp: number;
}

/**
 * The result returned by the Matching Engine after processing an order.
 */
export interface MatchResult {
  /** All executions generated during matching (may be empty if no match). */
  executions: Execution[];
  /** If the incoming order has remaining qty and is a limit order, it rests. */
  restingOrder: boolean;
}
