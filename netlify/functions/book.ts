import { json } from "./lib/http";
import { buildBook } from "./lib/engine";

export const handler = async () => {
  try {
    return json(200, await buildBook());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "book_error";
    return json(502, { error: msg });
  }
};
