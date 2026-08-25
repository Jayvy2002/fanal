import { json } from "./lib/http";
import { handleApi } from "./lib/engine";

type Event = { httpMethod?: string; path?: string; body?: string | null };

export const handler = async (event: Event) => {
  const method = event.httpMethod || "GET";
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
      },
      body: "",
    };
  }
  try {
    const { status, body } = await handleApi("/api/paper-poly", { method, body: event.body ?? undefined });
    return json(status, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "paper_error";
    return json(500, { error: msg, live_orders: false });
  }
};
