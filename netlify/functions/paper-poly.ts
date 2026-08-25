import { json } from "./lib/http";
import { snapshotMmPaper } from "./lib/polymarket/mmpaper";

type Event = { httpMethod?: string };

export const handler = async (event: Event) => {
  const method = (event.httpMethod || "GET").toUpperCase();
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
  if (method !== "GET") return json(405, { error: "methode", live_orders: false });
  try {
    return json(200, await snapshotMmPaper());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "paper_mm_error";
    return json(500, { error: msg, live_orders: false });
  }
};
