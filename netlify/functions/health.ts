import { json } from "./lib/http";
import { buildHealth } from "./lib/engine";

export const handler = async () => json(200, await buildHealth());
