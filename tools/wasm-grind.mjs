/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The machine instructions a run executed in V8's optimised wasm code, each
 * counted: callgrind's per-instruction counts (`--dump-instr=yes`) joined with
 * the code V8 printed in the same process (`--print-wasm-code`), by address.
 * What `cork-asm` weighs from block counts and static code, this counts: the
 * cold paths inside a block cost nothing here, spills the register allocator
 * put on the hot path cost what they ran.
 *
 *     valgrind --tool=callgrind --dump-instr=yes --callgrind-out-file=RUN.out \
 *         node --print-wasm-code --no-liftoff tools/cork-bench/bench.mjs vm-x64 \
 *         --bits 64 --reps 1 --warm 10 --iters 30 > RUN.code
 *     node tools/wasm-grind.mjs RUN.out RUN.code [--top N] [--listing N] [--min COUNT]
 *
 * Prints the wasm functions by executed instructions, and with `--listing N` the N
 * heaviest functions' code, each instruction with its count (those run at least
 * `--min` times, default 1). An instruction no function printed is left out of the
 * table and counted in its last line. `--exact` prints only the two counts, all and
 * in printed wasm code, as integers (`tools/cork-bench/ir.sh` with `WASM=1`).
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>{
    const at = args.indexOf(name);
    return at < 0 ? fallback : args[at + 1];
};
const [outPath, codePath] = args.filter((one, at)=>!one.startsWith('--')
    && !args[at - 1]?.startsWith('--'));
if (outPath === undefined || codePath === undefined)
{
    console.error('usage: node tools/wasm-grind.mjs RUN.out RUN.code [--top N] [--listing N]'
        + ' [--min COUNT]');
    process.exit(2);
}

/** Executed count by instruction address (callgrind's self cost, Ir). @type {Map<bigint, number>} */
const counts = new Map();
let total = 0;
{
    let previous = 0n;
    let line = 0;
    let call = false;
    for (const text of readFileSync(outPath, 'utf8').split('\n'))
    {
        if (text.startsWith('calls='))
        {
            call = true;
            continue;
        }
        const first = text.charCodeAt(0);
        // A cost line opens with a position: 0x, a digit, + or - or *.
        if (!(first >= 48 && first <= 57 || first === 43 || first === 45 || first === 42))
        {
            continue;
        }
        const [where, at, cost] = text.split(' ');
        if (where.startsWith('0x'))
        {
            previous = BigInt(where);
        }
        else if (where[0] === '+' || where[0] === '-')
        {
            previous += BigInt(where);
        }
        else if (where !== '*')
        {
            previous = BigInt(where);
        }
        line = at === '*' ? line : at?.[0] === '+' || at?.[0] === '-' ? line + Number(at)
            : Number(at);
        if (call)
        {
            call = false;
            continue;
        }
        const n = Number(cost ?? 0);
        counts.set(previous, (counts.get(previous) ?? 0) + n);
        total += n;
    }
}

/** @type {{ name: string, lines: { address: bigint, text: string }[], ran: number }[]} */
const functions = [];
{
    /** @type {typeof functions[number] | null} */
    let into = null;
    let name = '';
    for (const text of readFileSync(codePath, 'utf8').split('\n'))
    {
        if (text.startsWith('--- WebAssembly code ---'))
        {
            into = null;
            name = '';
            continue;
        }
        if (text.startsWith('name: '))
        {
            name = text.slice(6);
            continue;
        }
        if (text.startsWith('Instructions'))
        {
            into = { name, lines: [], ran: 0 };
            functions.push(into);
            continue;
        }
        const address = /^(0x[0-9a-f]+)\s/.exec(text);
        if (into !== null && address)
        {
            into.lines.push({ address: BigInt(address[1]), text: text.replace(/^0x[0-9a-f]+\s+/, '') });
        }
        else if (into !== null && text.trim() === '')
        {
            into = null;
        }
    }
}
let known = 0;
for (const one of functions)
{
    for (const { address } of one.lines)
    {
        one.ran += counts.get(address) ?? 0;
    }
    known += one.ran;
}
const ranked = functions.filter(one=>one.ran > 0).sort((a, b)=>b.ran - a.ran);
const top = Number(flag('--top', '15'));
if (args.includes('--exact'))
{
    console.log(`${total} ${known}`);
    process.exit(0);
}
console.log(`${(total / 1e6).toFixed(1)} M instructions in all; in printed wasm code`
    + ` ${(known / 1e6).toFixed(1)} M (${(known / total * 100).toFixed(1)}%)`);
for (const one of ranked.slice(0, top))
{
    console.log(`${(one.ran / 1e6).toFixed(2).padStart(9)} M  ${(one.ran / known * 100).toFixed(1)
        .padStart(5)}%  ${one.name}  (${one.lines.length} instructions)`);
}
const min = Number(flag('--min', '1'));
for (const one of ranked.slice(0, Number(flag('--listing', '0'))))
{
    console.log(`\n${one.name}: ${(one.ran / 1e6).toFixed(2)} M`);
    for (const { address, text } of one.lines)
    {
        const ran = counts.get(address) ?? 0;
        if (ran >= min)
        {
            console.log(`${String(ran).padStart(10)}  ${text}`);
        }
    }
}
