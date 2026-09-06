// Copyright Bottlify Project 2026
// Licenses and contributions: THIRD-PARTY-NOTICES.md

import js from "@eslint/js";

export default [
    { ignores: ["**/node_modules/**", "**/dist/**", "**/vendor/**", "tools/cdp_test/reports/**"] },
    js.configs.recommended,
    {
        languageOptions: { ecmaVersion: 2022, sourceType: "module" },
        rules: {
            // ESLint 10 deprecates its formatting rules in favour of @stylistic, but
            // they still work; one rule is not worth a plugin dependency yet. Move to
            // @stylistic if a future major actually removes it.
            indent: ["error", 4, { SwitchCase: 1 }],
            // Identifier existence is already verified by `tsc --checkJs` (jsconfig.json),
            // which knows the real global set per file (node/worker/browser). ESLint's
            // flat config has one global env for everything, so enabling it here would
            // just relitigate what typecheck already checks more precisely.
            "no-undef": "off",
        },
    },
];
