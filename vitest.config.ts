import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test-cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    // 本地攻击演示保留为手工 PoC，不纳入修复后的默认回归套件。
    exclude: [
      ...configDefaults.exclude,
      "src/poc-*.test.ts",
      "tests-worker/**",
      "tests/**/*.spec.ts",
    ],
  },
});
