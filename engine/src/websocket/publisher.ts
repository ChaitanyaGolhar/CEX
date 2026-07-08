import { createClient, type RedisClientType } from "redis";
import { env } from "../utils/env.js";

let publisherClient: RedisClientType | null = null;

export async function connectPublisher(): Promise<void> {
  if (!publisherClient) {
    publisherClient = createClient({ url: env.redisUrl }).on("error", (error) => {
      console.error("Redis publisher client error", error);
    });
    await publisherClient.connect();
    console.log("Redis publisher client connected");
  }
}

export async function publishMessage(channel: string, message: unknown): Promise<void> {
  if (!publisherClient) {
    console.warn("Publisher client not connected");
    return;
  }
  try {
    await publisherClient.publish(channel, JSON.stringify(message));
  } catch (error) {
    console.error(`Failed to publish message to channel ${channel}`, error);
  }
}
