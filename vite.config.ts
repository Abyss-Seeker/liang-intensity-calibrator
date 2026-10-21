import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [
    {
      name: "local-comment-source",
      apply: "serve",
      enforce: "pre",
      configureServer(server) {
        // Vite bypasses Cloudflare's edge, so it does not supply this header.
        // Derive it from the actual socket, never from a browser-supplied value.
        // This middleware is dev-only and is not included in the built Worker.
        server.middlewares.use((request, _response, next) => {
          const path = request.url?.split("?")[0];
          if (path === "/api/comments" || path?.startsWith("/api/comments/")) {
            const address = request.socket.remoteAddress;
            // Cloudflare's Node-to-Request adapter reads rawHeaders rather
            // than headers, so update both representations and remove every
            // client-supplied occurrence before inserting the socket address.
            for (let i = request.rawHeaders.length - 2; i >= 0; i -= 2) {
              if (request.rawHeaders[i].toLowerCase() === "cf-connecting-ip") request.rawHeaders.splice(i, 2);
            }
            if (address) {
              const ip = address.replace(/^::ffff:/, "");
              request.headers["cf-connecting-ip"] = ip;
              request.rawHeaders.push("CF-Connecting-IP", ip);
            } else delete request.headers["cf-connecting-ip"];
          }
          next();
        });
      },
    },
    cloudflare({ persistState: mode !== "e2e" }),
  ],
}));
