/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Evaluates an expression in the launcher tab and prints the answer; a string
 * is printed as it is, anything else as JSON. The engine is `window.__bottlify__`.
 *
 *   node tools/cdp_test/live/eval.mjs "document.body.innerText.slice(-2000)"
 */
import { connect } from './connect.mjs';

const { evaluate } = await connect();
const value = await evaluate(process.argv[2] ?? 'location.href');
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
process.exit(0);
