import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/catalog": "http://localhost:3001",
      "/mcp": "http://localhost:3001",
      "/openapi.json": "http://localhost:3001",
      "/.well-known": "http://localhost:3001",
    },
  },
});
