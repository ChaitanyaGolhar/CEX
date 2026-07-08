import { FILLS, ORDERS, type Fill } from "../store/exchange-store.js";
import type { Execution } from "../matching/execution.js";
import { generateFillId } from "../utils/helpers.js";

/**
 * Fill Engine — generates fill records from executions.
 *
 * A Fill represents one order's participation in a trade.
 * Each execution produces TWO fills: one for the buyer, one for the seller.
 * Fills are pushed to both the global FILLS array and each OrderRecord.fills.
 */
export function generateFills(executions: Execution[]): Fill[] {
  const fills: Fill[] = [];

  for (const execution of executions) {
    const fill: Fill = {
      fillId: generateFillId(),
      symbol: execution.symbol,
      price: execution.price,
      qty: execution.qty,
      buyOrderId: execution.buyerOrderId,
      sellOrderId: execution.sellerOrderId,
      createdAt: execution.timestamp,
    };

    fills.push(fill);
    FILLS.push(fill);

    // Attach fill to the respective order records
    const buyerOrder = ORDERS.get(execution.buyerOrderId);
    if (buyerOrder) {
      buyerOrder.fills.push(fill);
    }

    const sellerOrder = ORDERS.get(execution.sellerOrderId);
    if (sellerOrder) {
      sellerOrder.fills.push(fill);
    }
  }

  return fills;
}
