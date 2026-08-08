import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Ignore generated output and coverage
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },

  // TypeScript-ESLint recommended rules for all .ts files
  ...tseslint.configs.recommended,

  // Disable formatting rules that conflict with Prettier
  eslintConfigPrettier,
);
