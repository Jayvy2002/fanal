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
          const mod = await server.ssrLoadModule(
            path.resolve(__dirname, "../netlify/functions/lib/engine.ts"),
          );
          const { status, body } = await mod.handleApi(url);
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(body));
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
