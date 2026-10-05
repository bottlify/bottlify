// Copyright © 2026 Bottlify Project
// Licensed under the Mozilla Public License, version 2.0
// See LICENSE for details

import js from '@eslint/js';
import { houseStyle } from './eslint-rules.mjs';

export default [
    {
        // Flat config does not read .gitignore, so everything that is not our
        // source has to be listed here explicitly — otherwise third-party trees
        // (a Ghidra virtualenv, prebuilt binaries) get linted and drown the report.
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/vendor/**',
            'tools/cdp_test/reports/**',
            '.ghidra/**',
            '.ghidra-home/**',
            // A title's bundle content beside its manifest (its sidecar kernels)
            // is not this project's code.
            'bundles/**',
            // What the cork bench's browser runner builds from a checkout.
            'modules/cork/bench/browser/bundles/**',
            // Agents' scratch checkouts: full copies of the tree that are not this tree.
            '.claude/**',
            'dbg/**',
            '.certs/**',
            'roadmap/**',
            // The launcher is its own application, with its own package.json,
            // its own framework and its own conventions. Holding it to the
            // engine's house style would be a style argument, not a check.
            'ui/**',
        ],
    },
    js.configs.recommended,
    {
        languageOptions: { ecmaVersion: 2025, sourceType: 'module' },
        plugins: { style: houseStyle },
        rules: {
            // ESLint 10 deprecates its formatting rules in favour of @stylistic, but
            // they still work; a handful of rules is not worth a plugin dependency
            // yet. Move to @stylistic if a future major actually removes them.
            indent: ['error', 4, { SwitchCase: 1 }],

            // Identifier existence is already verified by `tsc --checkJs` (jsconfig.json),
            // which knows the real global set per file (node/worker/browser). ESLint's
            // flat config has one global env for everything, so enabling it here would
            // just relitigate what typecheck already checks more precisely.
            'no-undef': 'off',

            // --- correctness ---
            // `== null` stays legal: it tests null-or-undefined in one comparison,
            // which is what the two places using it actually mean.
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-shadow': 'error',
            'no-throw-literal': 'error',
            'no-unmodified-loop-condition': 'error',
            'no-self-compare': 'error',
            'no-useless-call': 'error',
            'no-useless-concat': 'error',
            'no-else-return': 'error',
            'no-use-before-define': [
                'error', { functions: false, classes: false, variables: false }],
            'block-scoped-var': 'error',
            'no-extra-bind': 'error',
            'no-extra-label': 'error',
            'no-iterator': 'error',
            'no-lone-blocks': 'error',
            'no-multi-str': 'error',
            'no-proto': 'error',
            'no-label-var': 'error',
            'no-template-curly-in-string': 'error',
            // `event` as an implicit global is a browser-era footgun, and part of
            // this tree does run in a page and a worker.
            'no-restricted-globals': ['error', 'event'],

            // --- consistency ---
            semi: ['error', 'always'],
            'eol-last': 'error',
            'no-trailing-spaces': 'error',
            'no-multiple-empty-lines': ['error', { max: 2 }],
            // Alignment before an end-of-line comment is deliberate: hand-assembled
            // machine code is laid out in columns (see cpu/internal/boot-rom.js), and
            // collapsing those spaces would destroy the only thing making it readable.
            'no-multi-spaces': ['error', { ignoreEOLComments: true }],
            'comma-spacing': 'error',
            'key-spacing': 'error',
            'keyword-spacing': 'error',
            'space-in-parens': 'error',
            'object-curly-spacing': ['error', 'always'],
            'array-bracket-spacing': 'error',
            'block-spacing': 'error',
            'no-whitespace-before-property': 'error',
            'spaced-comment': ['error', 'always'],
            quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
            'space-before-function-paren': ['error', 'never'],
            'space-before-blocks': [
                'error', { functions: 'never', keywords: 'never', classes: 'always' }],
            'arrow-parens': ['error', 'as-needed'],
            // `no-extra-parens` is deliberately absent: a JSDoc cast is written
            // `/** @type {T} */ (expr)`, and those parentheses are syntactically
            // redundant but semantically load-bearing. Its autofix silently
            // stripped three of them here, turning the casts into no-ops that
            // typecheck caught only afterwards -- exactly the failure mode worth
            // avoiding in a checkJs codebase.
            'style/arrow-spaces': 'error',
            'style/non-ascii': 'error',
            'style/spaces-around-assignment': 'error',

            // --- backlog: warnings, not errors ---
            // These four arrived with an existing codebase and have no autofix, so
            // enforcing them immediately would mean 241 mechanical edits in one
            // sweep. They are cleaned up as each file is touched for other reasons
            // instead. `npm run lint` caps warnings at the current count, so the
            // backlog can only shrink: a new violation pushes the total over the
            // cap and fails. Lower the cap as it drains, then promote to 'error'.
            'max-len': ['warn', 100, 8, { ignoreUrls: true, ignorePattern: '/.+/' }],
            'style/bracket-placement': 'warn',
            'style/oneline-ifs': 'warn',
            'style/error-names': 'warn',
        },
    },
];
