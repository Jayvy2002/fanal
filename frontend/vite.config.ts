import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fanalApi(): Plugin {
  return {
    name: "fanal-api",
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/")) {
          next();
          return;
        }
        try {
          const chunks: Buffer[] = [];
          if (req.method && req.method !== "GET" && req.method !== "HEAD") {
            await new Promise<void>((resolve, reject) => {
              req.on("data", (c: Buffer) => chunks.push(c));
              req.on("end", () => resolve());
              req.on("error", reject);
            });
          }
          const mod = await server.ssrLoadModule(
            path.resolve(__dirname, "../netlify/functions/lib/engine.ts"),
          );
          const { status, body } = await mod.handleApi(url, {
            method: req.method,
            body: Buffer.concat(chunks).toString("utf8"),
          });
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(status === 204 ? "" : JSON.stringify(body));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "api_error" }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), fanalApi()],
  server: {
    host: true,
    port: 5173,
    fs: { allow: [".."] },
  },
});
