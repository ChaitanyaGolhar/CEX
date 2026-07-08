import type { Trade } from "../store/exchange-store.js";

export interface TickerData {
  symbol: string;
  lastPrice: string;
  highPrice: string;
  lowPrice: string;
  baseVolume: string;
  quoteVolume: string;
  priceChange: string;
  priceChangePercent: string;
  openPrice: string;
}

// In-memory ticker store (for the current session)
export const TICKERS = new Map<string, TickerData>();

/**
 * Updates the ticker data for a given symbol based on new trades.
 */
export function updateTicker(trades: Trade[]): void {
  for (const trade of trades) {
    const symbol = trade.symbol;
    const price = trade.price;
    const qty = trade.qty;
    const quoteQty = price * qty;

    let ticker = TICKERS.get(symbol);

    if (!ticker) {
      ticker = {
        symbol,
        lastPrice: price.toString(),
        highPrice: price.toString(),
        lowPrice: price.toString(),
        baseVolume: qty.toString(),
        quoteVolume: quoteQty.toString(),
        priceChange: "0",
        priceChangePercent: "0",
        openPrice: price.toString(),
      };
      TICKERS.set(symbol, ticker);
    } else {
      const openPrice = parseFloat(ticker.openPrice);
      const currentHigh = parseFloat(ticker.highPrice);
      const currentLow = parseFloat(ticker.lowPrice);
      const currentBaseVol = parseFloat(ticker.baseVolume);
      const currentQuoteVol = parseFloat(ticker.quoteVolume);

      const newHigh = Math.max(currentHigh, price);
      const newLow = Math.min(currentLow, price);
      const newBaseVol = currentBaseVol + qty;
      const newQuoteVol = currentQuoteVol + quoteQty;

      const priceChange = price - openPrice;
      const priceChangePercent = (priceChange / openPrice) * 100;

      ticker.lastPrice = price.toString();
      ticker.highPrice = newHigh.toString();
      ticker.lowPrice = newLow.toString();
      ticker.baseVolume = newBaseVol.toString();
      ticker.quoteVolume = newQuoteVol.toString();
      ticker.priceChange = priceChange.toString();
      ticker.priceChangePercent = priceChangePercent.toFixed(2);
    }
  }
}

/**
 * Retrieves the ticker data for a symbol.
 */
export function getTicker(symbol: string): TickerData | null {
  return TICKERS.get(symbol) || null;
}
