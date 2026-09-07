// Copyright © 2026 Bottlify Project
// Licensed under the Mozilla Public License, version 2.0
// See LICENSE for details

// @types/node's process.d.ts contains `typeof import("punycode")` (for
// process.getBuiltinModule typings). @types/node also ships its own ambient
// `declare module "punycode"`, but that ambient shadow only applies when no
// real "punycode" package resolves on disk. Any devDependency that pulls in
// the real (legacy, untyped) npm `punycode` package — e.g. eslint's
// ajv -> uri-js -> punycode chain — makes that real, typeless JS file win
// module resolution instead, and with allowJs+checkJs on, tsc then
// type-checks that third-party file itself and fails on it. The `paths`
// remap in jsconfig.json points the "punycode" specifier at this stub so
// resolution never reaches node_modules/punycode for typechecking purposes.
declare module "punycode" {
  const punycode: unknown;
  export = punycode;
}
