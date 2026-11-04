import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "app/vendor/**", "node_modules/**", "desktop/src-tauri/target/**", "service/.venv/**", "service/htmlcov/**",
      "packaging/arch/pkg/**", "packaging/arch/src/**",
    ],
  },
  js.configs.recommended,
  { rules: { "no-unused-vars": ["error", { ignoreRestSiblings: true }] } },
  { files: ["app/js/**", "desktop/ui/**"], languageOptions: { globals: globals.browser } },
  { files: ["**/tests/**", "tools/**", "eslint.config.js"], languageOptions: { globals: globals.node } },
];
