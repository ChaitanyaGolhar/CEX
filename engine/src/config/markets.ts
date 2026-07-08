export interface MarketConfig {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  minQty: number;
}

export const MARKETS: MarketConfig[] = [
  {
    symbol: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    tickSize: 0.01,
    minQty: 0.001,
  },
  {
    symbol: "ETHUSDT",
    baseAsset: "ETH",
    quoteAsset: "USDT",
    tickSize: 0.01,
    minQty: 0.01,
  },
];
