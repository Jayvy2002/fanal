import { json } from "./lib/http";
import { buildBook } from "./lib/engine";
import { isPredictSymbol } from "./lib/predictor";

type Event = { queryStringParameters?: Record<string, string | undefined> };

export const handler = async (event: Event) => {
  const symbol = event.queryStringParameters?.symbol;
  try {
    return json(200, await buildBook(isPredictSymbol(symbol) ? symbol : "BTC-USD"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "book_error";
    return json(500, { error: msg });
  }
};
