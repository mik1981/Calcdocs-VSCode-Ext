import * as path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/unit/vscode.mock.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    exclude: [
      "node_modules",
      "out",
      "dist",
      ".vscode-test",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "src/extension.ts",
        "**/*.d.ts",
      ],
    },
    setupFiles: [],
  },
});
