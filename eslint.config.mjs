// Copyright Bottlify Project 2026
// Licenses and contributions: THIRD-PARTY-NOTICES.md

import js from "@eslint/js";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/vendor/**", "tools/cdp_test/reports/**"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: {
      // Identifier existence is already verified by `tsc --checkJs` (jsconfig.json),
      // which knows the real global set per file (node/worker/browser). ESLint's
      // flat config has one global env for everything, so enabling it here would
      // just relitigate what typecheck already checks more precisely.
      "no-undef": "off",
    },
  },
];
