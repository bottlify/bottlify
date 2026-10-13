/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The wasm cork makes of a stretch of x86, as text: a region formed at the
 * entry and emitted as the translator emits one (`regionModule`), turned into
 * the text format by wabt's `wasm2wat` (a development dependency), with the
 * region's own function printed and the module's helpers left out unless
 * asked for. For reading what an instruction becomes before changing how.
 *
 *     node tools/cork-wat.mjs --hex 'd8 57 0c df e0 f6 c4 41 74 e2' [--at 0x1000]
 *     node tools/cork-wat.mjs --file code.bin --at 0x31020580 [--entry 0x310205b2]
 *
 *   --hex BYTES      the code, as hex bytes
 *   --file PATH      the code, a file of bytes lying at --at
 *   --at ADDRESS     where the code lies (default 0x1000)
 *   --entry ADDRESS  where the region starts (default --at)
 *   --hash           with the entry hash and calls as wasm calls, as in a game
 *   --precise        the precise x87 (every exception flag kept)
 *   --module         the whole module, helpers included
 */

import { readFileSync } from 'node:fs';
import wabt from 'wabt';
import { regionModule } from '../modules/cork/src/region-module.js';

const args = process.argv.slice(2);
/** @param {string} name */
const value = name=>(args.includes(name) ? args[args.indexOf(name) + 1] : null);
const at = Number(value('--at') ?? 0x1000);
const entry = Number(value('--entry') ?? at);
const hex = value('--hex');
const file = value('--file');
if (hex === null && file === null)
{
    console.error('usage: node tools/cork-wat.mjs --hex BYTES | --file PATH [--at ADDRESS]'
        + ' [--entry ADDRESS] [--hash] [--precise] [--module]');
    process.exit(2);
}
const code = hex !== null
    ? hex.trim().split(/[\s,]+/).map(byte=>Number.parseInt(byte, 16))
    : [...readFileSync(/** @type {string} */ (file))];

const hash = args.includes('--hash');
const made = regionModule({ code, at, entry, hash, callReturn: hash,
    precise: args.includes('--precise') });
const tools = await wabt();
// What cork's modules use beyond the first release: tail calls into other
// regions, SIMD, shared memory and its atomics, bulk memory.
const module = tools.readWasm(made.wasm, { readDebugNames: true, tail_call: true, simd: true,
    threads: true, bulk_memory: true, sign_extension: true, sat_float_to_int: true,
    multi_value: true, mutable_globals: true });
module.generateNames();
module.applyNames();
const text = module.toText({ foldExprs: false, inlineExport: true });
module.destroy();

console.log(`; region at 0x${made.entry.toString(16)}: ${made.blocks.length} blocks,`
    + ` ${made.blocks.reduce((sum, block)=>sum + block.instructions, 0)} instructions,`
    + ` ${made.bytes} x86 bytes, module ${made.wasm.length} bytes`
    + (Object.keys(made.refused).length > 0 ? `, refused ${JSON.stringify(made.refused)}` : ''));
if (args.includes('--module'))
{
    console.log(text);
}
else
{
    // The exported region alone: from its `(func` to the next one.
    const lines = text.split('\n');
    const start = lines.findIndex(line=>line.includes('(export "region")'));
    const end = lines.findIndex((line, index)=>index > start && /^\s*\(func /.test(line));
    console.log(lines.slice(start, end < 0 ? undefined : end).join('\n'));
}
