import { Router } from "express";
import {
  cancelOrder,
  createOrder,
  getBalance,
  getDepth,
  getOrder,
  getTicker,
  listOrders,
  getPublicTrades,
  getMyTrades,
  getMarkets,
  getKlines,
} from "../controllers/exchange-controller.js";
import { requireAuth } from "../utils/auth.js";
import { asyncHandler } from "../utils/async-handler.js";

export const exchangeRouter = Router();

exchangeRouter.post("/order", requireAuth, asyncHandler(createOrder));
exchangeRouter.get("/depth/:symbol", requireAuth, asyncHandler(getDepth));
exchangeRouter.get("/ticker/:symbol", requireAuth, asyncHandler(getTicker));
exchangeRouter.get("/balance", requireAuth, asyncHandler(getBalance));
exchangeRouter.get("/order/:orderId", requireAuth, asyncHandler(getOrder));
exchangeRouter.delete("/order/:orderId", requireAuth, asyncHandler(cancelOrder));

exchangeRouter.get("/orders", requireAuth, asyncHandler(listOrders));
exchangeRouter.get("/trades/me", requireAuth, asyncHandler(getMyTrades));
exchangeRouter.get("/trades/:symbol", asyncHandler(getPublicTrades)); // public
exchangeRouter.get("/markets", asyncHandler(getMarkets)); // public
exchangeRouter.get("/klines/:symbol", asyncHandler(getKlines)); // public
