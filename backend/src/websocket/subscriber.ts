import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "http";
import { createClient } from "redis";
import jwt from "jsonwebtoken";
import { env } from "../utils/env.js";
import type { TokenPayload } from "../utils/auth.js";
import { URL } from "url";

let subscriberClient: ReturnType<typeof createClient> | null = null;
const channelSubscribers = new Map<string, Set<WebSocket>>();

export async function initWebSocketServer(server: Server): Promise<void> {
  subscriberClient = createClient({ url: env.redisUrl }).on("error", (error) => {
    console.error("Redis subscriber client error", error);
  });
  await subscriberClient.connect();
  console.log("Redis subscriber client connected");

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // 1. Authenticate via token in query string
    let userId: string | null = null;
    
    try {
      // req.url is like "/?token=..."
      const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
      const token = url.searchParams.get("token");
      
      if (!token) {
        ws.close(1008, "Missing token");
        return;
      }
      
      const payload = jwt.verify(token, env.jwtSecret) as TokenPayload;
      userId = payload.userId;
    } catch (err) {
      ws.close(1008, "Invalid token");
      return;
    }

    console.log(`WebSocket client connected (User: ${userId})`);

    ws.on("message", async (message: string) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.method === "SUBSCRIBE" && Array.isArray(parsed.params)) {
          for (const channel of parsed.params) {
            // Restrict private channels
            if (channel.startsWith("orders.") || channel.startsWith("balance.")) {
              const channelUserId = channel.split(".")[1];
              if (channelUserId !== userId) {
                console.warn(`User ${userId} attempted to subscribe to ${channel}`);
                continue; // Reject unauthorized subscription
              }
            }
            subscribeClientToChannel(ws, channel);
          }
        } else if (parsed.method === "UNSUBSCRIBE" && Array.isArray(parsed.params)) {
          for (const channel of parsed.params) {
            unsubscribeClientFromChannel(ws, channel);
          }
        }
      } catch (e) {
        console.error("Invalid WebSocket message", message.toString());
      }
    });

    ws.on("close", () => {
      // Remove client from all channels
      for (const [channel, clients] of channelSubscribers.entries()) {
        if (clients.has(ws)) {
          unsubscribeClientFromChannel(ws, channel);
        }
      }
      console.log(`WebSocket client disconnected (User: ${userId})`);
    });
  });

  console.log("WebSocket server initialized");
}

function subscribeClientToChannel(ws: WebSocket, channel: string): void {
  if (!channelSubscribers.has(channel)) {
    channelSubscribers.set(channel, new Set());
    
    if (subscriberClient) {
      void subscriberClient.subscribe(channel, (message) => {
        const clients = channelSubscribers.get(channel);
        if (clients) {
          const payload = JSON.stringify({
            stream: channel,
            data: JSON.parse(message),
          });
          for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(payload);
            }
          }
        }
      });
    }
  }
  
  channelSubscribers.get(channel)?.add(ws);
}

function unsubscribeClientFromChannel(ws: WebSocket, channel: string): void {
  const clients = channelSubscribers.get(channel);
  if (clients) {
    clients.delete(ws);
    
    // If no more clients are listening to this channel, unsubscribe from Redis
    if (clients.size === 0) {
      channelSubscribers.delete(channel);
      if (subscriberClient) {
        void subscriberClient.unsubscribe(channel);
      }
    }
  }
}
