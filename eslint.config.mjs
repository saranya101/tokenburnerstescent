import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    files: ["packages/intent-engine/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { "patterns": ["**/mock-bank/**", "@parlance/api/**"] }],
    },
  },
);
