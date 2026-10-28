/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a cork-bench workload's executed machine instructions go, exactly
 * (`ir-hot.sh`): callgrind's count of every instruction executed, laid on the
 * code V8 printed for each wasm function (`--print-wasm-code`), by function and
 * by kind -- a stack slot loaded or stored (`frame-load`, `frame-store`: the
 * register allocator's spills and reloads), a register copied (`move`), a
 * constant made, another load or store (`memory`), a branch, a comparison and
 * the rest. What `cork-asm.mjs --classes` estimates from a block profile and
 * the code compiled again, this reads off the run itself; the counts include
 * the warm-up's iterations, so it gives shares, and `ir.sh` the totals.
 *
 *     node ir-hot.mjs CALLGRIND_OUT V8_CODE [--list N] [--frames N] [--range LO-HI]
 *
 *   --list N      the hottest function's instructions that ran at least 1/N as often as its
 *                 hottest one
 *   --frames N    its N most executed spills and reloads
 *   --range LO-HI its instructions between two offsets (hex), with their counts
 */

import { readFileSync } from 'node:fs';

const [outPath, codePath, ...args] = process.argv.slice(2);
/** @param {string} name */
const value = name=>(args.includes(name) ? args[args.indexOf(name) + 1] : null);
if (codePath === undefined)
{
    console.error('usage: node ir-hot.mjs CALLGRIND_OUT V8_CODE [--list N] [--frames N]'
        + ' [--range LO-HI]');
    process.exit(2);
}

/**
 * By address, the instructions executed there in code no file holds -- the
 * JIT's -- from callgrind's `--dump-instr=yes --compress-pos=no` output: self
 * costs only, a call's inclusive line after its `calls=` skipped.
 *
 * @type {Map<bigint, number>}
 */
const executed = new Map();
let jitted = false;
let inclusive = false;
for (const line of readFileSync(outPath, 'utf8').split('\n'))
{
    if (line.startsWith('ob='))
    {
        jitted = line === 'ob=???';
        continue;
    }
    if (line.startsWith('calls='))
    {
        inclusive = true;
        continue;
    }
    const cost = /^0x([0-9a-f]+) \d+ (\d+)/.exec(line);
    if (cost === null)
    {
        continue;
    }
    if (inclusive || !jitted)
    {
        inclusive = false;
        continue;
    }
    const at = BigInt(`0x${cost[1]}`);
    executed.set(at, (executed.get(at) ?? 0) + Number(cost[2]));
}

/** @typedef {{ at: bigint, text: string, line: string, count: number }} Line */
/** @type {{ name: string, lines: Line[] }[]} the functions V8 printed, in order */
const functions = [];
for (const line of readFileSync(codePath, 'utf8').split('\n'))
{
    if (line.startsWith('name: '))
    {
        functions.push({ name: line.slice(6), lines: [] });
        continue;
    }
    const instruction = /^(0x[0-9a-f]+)\s+[0-9a-f]+\s+[0-9a-f]+\s+(.*)$/.exec(line);
    if (instruction !== null && functions.length > 0)
    {
        const at = BigInt(instruction[1]);
        functions[functions.length - 1].lines.push({ at, text: instruction[2], line,
            count: executed.get(at) ?? 0 });
    }
}

/**
 * What an x86-64 instruction in V8's printer is for.
 * @param {string} text
 */
function classOf(text){
    const [mnemonic = '', ...rest] = text.replace(/^REX\.W\s+/, '').split(/\s+/);
    const operands = rest.join(' ');
    if (/\[(rbp|rsp)\b/.test(operands))
    {
        return /^\[(rbp|rsp)/.test(operands) ? 'frame-store' : 'frame-load';
    }
    if (/^mov[lqwb]?$/.test(mnemonic) && /^[a-z][a-z0-9]*,\s*[a-z][a-z0-9]*$/.test(operands))
    {
        return 'move';
    }
    if (/^mov[lqwb]?$/.test(mnemonic) && /^[a-z][a-z0-9]*,\s*(0x[0-9a-f]+|-?\d+)\b/.test(operands)
        || /^xor[lq]?$/.test(mnemonic) && /^([a-z0-9]+),\s*\1$/.test(operands))
    {
        return 'constant';
    }
    if (/^lea/.test(mnemonic))
    {
        return 'other';
    }
    if (operands.includes('['))
    {
        return 'memory';
    }
    if (/^(j|call|ret)/.test(mnemonic))
    {
        return 'branch';
    }
    return /^(cmp|test|set|cmov)/.test(mnemonic) ? 'compare' : 'other';
}

/** @param {Record<string, number>} kinds @param {number} of */
const shares = (kinds, of)=>Object.entries(kinds).sort((a, b)=>b[1] - a[1])
    .map(([kind, count])=>`${kind} ${(100 * count / of).toFixed(1)}%`).join(', ');

let total = 0;
for (const count of executed.values())
{
    total += count;
}
const ran = functions.map(f=>{
    /** @type {Record<string, number>} */
    const kinds = {};
    let sum = 0;
    for (const { text, count } of f.lines)
    {
        const kind = classOf(text);
        kinds[kind] = (kinds[kind] ?? 0) + count;
        sum += count;
    }
    return { f, sum, kinds };
}).filter(one=>one.sum > 0).sort((a, b)=>b.sum - a.sum);
const inCode = ran.reduce((sum, one)=>sum + one.sum, 0);
console.log(`executed in JIT code ${total}, in the printed wasm functions ${inCode}`);
/** @type {Record<string, number>} */
const all = {};
for (const { f, sum, kinds } of ran)
{
    console.log(`${f.name}: ${sum} (${(100 * sum / inCode).toFixed(1)}%) ${shares(kinds, sum)}`);
    for (const [kind, count] of Object.entries(kinds))
    {
        all[kind] = (all[kind] ?? 0) + count;
    }
}
console.log(`all: ${shares(all, inCode)}`);
const hottest = ran[0]?.f;
if (hottest !== undefined && value('--list') !== null)
{
    const most = Math.max(...hottest.lines.map(one=>one.count));
    for (const { count, line } of hottest.lines)
    {
        if (count > 0 && count >= most / Number(value('--list')))
        {
            console.log(String(count).padStart(10), line);
        }
    }
}
if (hottest !== undefined && value('--frames') !== null)
{
    const frames = hottest.lines.filter(one=>one.count > 0 && classOf(one.text).startsWith('frame'))
        .sort((a, b)=>b.count - a.count).slice(0, Number(value('--frames')));
    for (const { count, line } of frames)
    {
        console.log(String(count).padStart(10), line);
    }
}
const range = value('--range');
if (hottest !== undefined && range !== null)
{
    const [low, high] = range.split('-').map(at=>Number.parseInt(at, 16));
    const start = hottest.lines[0].at;
    for (const { at, count, line } of hottest.lines)
    {
        const offset = Number(at - start);
        if (offset >= low && offset <= high)
        {
            console.log(String(count).padStart(10), line);
        }
    }
}
