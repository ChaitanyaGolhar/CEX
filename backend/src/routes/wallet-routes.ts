import { Router } from "express";
import { faucet } from "../controllers/wallet-controller.js";
import { requireAuth } from "../utils/auth.js";
import { asyncHandler } from "../utils/async-handler.js";

export const walletRouter = Router();

walletRouter.post("/wallet/faucet", requireAuth, asyncHandler(faucet));
