/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How much bigger cork's wasm is than the x86 it translates: every
 * instruction of a stretch of code emitted as the translator emits it in a
 * game (the entry hash, calls as wasm calls, loose stacks, loops as wasm
 * loops), the bytes each instruction took in its region's body -- the checks
 * its memory plan put before it included, its exits' code (written at the
 * region's end) not -- set against its own length.
 *
 *   node tools/cork-expansion.mjs --report REPORT.json [--top N] [--json]
 *   node tools/cork-expansion.mjs --code FILE --at ADDRESS [--top N] [--json]
 *
 * `--report` takes the code a report carries (`hotCode`: the pages the
 * hottest blocks of a run lie in), `--code` a file of bytes that lie at
 * `--at`. Regions are formed from every function start in the bytes -- the
 * first byte past a run of int3 or nop padding, and the start of each piece --
 * and each instruction is counted once, wherever regions overlap. The rows
 * are by form (mnemonic and operand kinds): how many, the x86 bytes, the wasm
 * bytes, and the ratio of the two, the forms over `--over` (3 by default)
 * marked; the total weighs each form by how often it occurs in the code read,
 * which for a report's pages is the code the run spent its time in.
 *
 * A diagnostic: the emitter reports the bytes only in a diagnostic build,
 * which a checkout run in node is.
 */

import { readFileSync } from 'node:fs';
import { regionModule } from '../modules/cork/src/region-module.js';
import { formOf } from '../modules/cork/src/runtime/profile-forms.js';

const args = process.argv.slice(2);
/** @param {string} name @param {string | undefined} [fallback] */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const top = Number(flag('--top', '40'));
const over = Number(flag('--over', '3'));

/** @type {{ at: number, bytes: Uint8Array }[]} */
const pieces = [];
const report = flag('--report');
if (report)
{
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    for (const page of parsed.hotCode ?? [])
    {
        pieces.push({ at: page.address, bytes: Buffer.from(page.base64, 'base64') });
    }
}
const file = flag('--code');
if (file)
{
    pieces.push({ at: Number(flag('--at', '0')), bytes: readFileSync(file) });
}
if (pieces.length === 0)
{
    console.error('usage: --report REPORT.json | --code FILE --at ADDRESS');
    process.exit(2);
}

// Neighbouring pages as one piece, so a function crossing a page is whole.
pieces.sort((left, right)=>left.at - right.at);
/** @type {{ at: number, bytes: Uint8Array }[]} */
const joined = [];
for (const piece of pieces)
{
    const last = joined[joined.length - 1];
    if (last && last.at + last.bytes.length === piece.at)
    {
        last.bytes = Buffer.concat([last.bytes, piece.bytes]);
    }
    else
    {
        joined.push({ at: piece.at, bytes: Uint8Array.from(piece.bytes) });
    }
}

/**
 * Where functions start in a piece: past each run of two or more int3 or nop
 * bytes, and at its own start.
 *
 * @param {Uint8Array} bytes
 */
const startsIn = bytes=>{
    const starts = [0];
    let run = 0;
    for (let offset = 0; offset < bytes.length; offset++)
    {
        if (bytes[offset] === 0xcc || bytes[offset] === 0x90)
        {
            run++;
            continue;
        }
        if (run >= 2)
        {
            starts.push(offset);
        }
        run = 0;
    }
    return starts;
};

/** @type {Map<number, { form: string, x86: number, wasm: number, lowered: boolean }>} */
const seen = new Map();
let regions = 0;
let failed = 0;
for (const { at, bytes } of joined)
{
    for (const start of startsIn(bytes))
    {
        try
        {
            regionModule({ code: bytes, at, entry: at + start, hash: true, callReturn: true,
                looseStacks: true, structure: true,
                expansion: (instruction, wasm, lowered)=>{
                    if (!seen.has(instruction.eip))
                    {
                        seen.set(instruction.eip, { form: formOf(instruction),
                            x86: instruction.length, wasm, lowered });
                    }
                } });
            regions++;
        }
        catch {
            failed++;
        }
    }
}

/** @type {Map<string, { count: number, x86: number, wasm: number, refused: number }>} */
const byForm = new Map();
let x86 = 0;
let wasm = 0;
for (const one of seen.values())
{
    const row = byForm.get(one.form) ?? { count: 0, x86: 0, wasm: 0, refused: 0 };
    row.count++;
    row.x86 += one.x86;
    row.wasm += one.wasm;
    row.refused += one.lowered ? 0 : 1;
    byForm.set(one.form, row);
    x86 += one.x86;
    wasm += one.wasm;
}
const rows = [...byForm].map(([form, row])=>({ form, ...row, ratio: row.wasm / row.x86 }))
    .sort((left, right)=>right.wasm - left.wasm);
if (args.includes('--json'))
{
    console.log(JSON.stringify({ regions, failed, instructions: seen.size, x86, wasm,
        ratio: wasm / x86, rows }, null, 1));
}
else
{
    console.log(`regions ${regions} (${failed} not formed), instructions ${seen.size},`
        + ` x86 ${x86} bytes, wasm ${wasm} bytes: x${(wasm / x86).toFixed(2)}`);
    console.log(`wasm bytes an instruction: ${(wasm / seen.size).toFixed(1)}`
        + ` (x86: ${(x86 / seen.size).toFixed(1)})`);
    console.log('form'.padEnd(34) + 'count'.padStart(7) + 'x86 B'.padStart(8)
        + 'wasm B'.padStart(9) + '  B/insn  ratio  share of wasm');
    for (const row of rows.slice(0, top))
    {
        console.log(row.form.slice(0, 33).padEnd(34) + String(row.count).padStart(7)
            + String(row.x86).padStart(8) + String(row.wasm).padStart(9)
            + `  ${(row.wasm / row.count).toFixed(0).padStart(6)}`
            + `  x${row.ratio.toFixed(1).padEnd(6)}${(100 * row.wasm / wasm).toFixed(1)}%`
            + (row.ratio > over ? '  over' : '')
            + (row.refused > 0 ? `  refused ${row.refused}` : ''));
    }
}
