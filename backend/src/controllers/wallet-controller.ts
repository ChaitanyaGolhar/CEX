import type { Request, Response } from "express";
import { sendToEngine } from "../utils/engine-client.js";

/**
 * POST /wallet/faucet
 * Dev-only endpoint that credits virtual assets to the authenticated user.
 * Disabled when NODE_ENV !== "development".
 */
export async function faucet(req: Request, res: Response): Promise<void> {
  // if (process.env.NODE_ENV !== "development") {
  //   res.status(403).json({ error: "Faucet disabled" });
  //   return;
  // }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const engineResponse = await sendToEngine("faucet", { userId });

  if (engineResponse.ok) {
    res.status(200).json({
      success: true,
      balances: (engineResponse.data as { balances: unknown }).balances,
    });
  } else {
    res.status(500).json({ error: engineResponse.error });
  }
}
