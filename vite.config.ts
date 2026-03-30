import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
  },
  server: {
    proxy: {
      // Forward /api/* to the Express backend during development.
      // This avoids CORS issues with the AWS OIDC endpoints and keeps
      // the browser from ever talking to the backend directly.
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
