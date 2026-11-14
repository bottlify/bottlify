/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * V8 in node set as Chromium's runs cork's wasm, for a tool that measures it:
 * imported first, before any module is compiled.
 *
 * cork marks its slow paths unlikely -- a spent budget, a flagged page, an
 * exit -- in the `metadata.code.branch_hint` section (`Body.unlikely`).
 * Chromium 141's V8 reads it by default; node 22's reads it only behind
 * `--experimental-wasm-branch-hinting`, and without it TurboFan lays every
 * such path in line and spills around it on the path taken. A measurement in
 * node without the flag times other machine code than a browser runs.
 *
 * The flag is V8's, so it holds for every worker of the process; an engine
 * that reads the hints already takes it as a no-op.
 */

import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--experimental-wasm-branch-hinting');

/** What a measurement's conditions name about the engine. */
export const ENGINE = `node ${process.versions.node}, V8 ${process.versions.v8}, branch hints read`;
