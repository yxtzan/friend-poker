import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const serverOrigin = env.VITE_SERVER_ORIGIN ?? "http://localhost:3000";

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/identity": { target: serverOrigin, changeOrigin: true },
        "/health": { target: serverOrigin, changeOrigin: true },
        "/socket.io": { target: serverOrigin, ws: true, changeOrigin: true },
      },
    },
  };
});
