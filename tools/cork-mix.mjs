/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The dynamic instruction mix of a cork run, and what each part of it costs.
 *
 *   node tools/cork-mix.mjs <game-...-blocks.json> [--bundle id] [--top 30]
 *       [--image gamex86.dll@0x5500000]...
 *
 * The blocks file is what `tools/cdp_test/game.mjs` writes beside its report
 * for a run with `--cork-config '{"blockProfile":true}'`: every executed block
 * start and how often it ran. Each block of the bundle's entry image is decoded
 * from its start to the next counted block or the first control transfer, and
 * every instruction is weighted by its block's executions -- the mix the
 * program actually ran, by operation and by operand form. Beside each, the
 * wasm operations cork emits for that form alone (the instruction formed into
 * a region of its own, less an empty one: a static count, cold paths
 * included), so `weighted ops` ranks where translated code spends its work.
 * Blocks outside the entry image and the `--image` ones are counted only.
 *
 * `--runs` adds the runs of two and three forms in a row within a block, by how
 * often they ran: the combinations a translator could do as one -- a compare and
 * its branch, `fld; fmul; faddp`, a copy through a register -- rank first. A
 * profile written by `tools/launch-probe.mjs --cork-out` (`blockCounts`) reads as
 * one of game.mjs's.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBundle } from './btl.mjs';
import { decode } from '../modules/cork/src/decode/decoder.js';
import { formRegion } from '../modules/cork/src/region.js';
import { emitBuilt } from '../modules/cork/src/runtime/emit-built.js';
import { ownLayout } from '../modules/cork/src/runtime/layout.js';
import { features } from '../modules/cork/src/wasm/features.js';

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, /** @type {string} */ fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const profile = JSON.parse(readFileSync(args[0], 'utf8'));
/** @type {[number, number][]} */
const blocks = profile.blocks ?? profile.blockCounts;
const bundleId = flag('--bundle', profile.bundle);
const top = Number(flag('--top', '30'));

const directory = join('bundles', bundleId);
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
// The entry image at its own preferred base, and any other image named as
// `--image gamex86.dll@0x5500000`: a DLL is placed where the run put it, which
// only the run knows (its report names the address).
const extra = args.flatMap((one, at)=>(one === '--image' ? [args[at + 1]] : []));
const opened = await openBundle(join(directory, manifest.bundle?.file ?? 'bundle.btl'));
/** @type {{ va: number, size: number, raw: number, bytes: Buffer }[]} */
const sections = [];
/** @param {string} path @param {number | null} base */
const place = async(path, base)=>{
    const bytes = await opened.read(path);
    const pe = bytes.readUInt32LE(0x3c);
    const imageBase = base ?? bytes.readUInt32LE(pe + 52);
    const optional = bytes.readUInt16LE(pe + 20);
    for (let i = 0, at = pe + 24 + optional; i < bytes.readUInt16LE(pe + 6); i++, at += 40)
    {
        sections.push({ va: imageBase + bytes.readUInt32LE(at + 12),
            size: bytes.readUInt32LE(at + 16), raw: bytes.readUInt32LE(at + 20), bytes });
    }
};
await place(manifest.entry, null);
for (const one of extra)
{
    const [path, base] = one.split('@');
    await place(path, Number(base));
}
await opened.close();
/** @param {number} address */
const section = address=>sections.find(one=>address >= one.va && address < one.va + one.size);
/** @param {number} address */
const read = address=>{
    const one = section(address);
    return one ? one.bytes[one.raw + address - one.va] : 0;
};

/** Static wasm operations of a byte sequence formed into a region, then halted. */
const layout = ownLayout({ ramSize: 1 << 30 });
const found = features();
/** @param {number[]} bytes */
const opsOf = bytes=>{
    const at = 0x1000;
    const code = [...bytes, 0xf4];
    const region = formRegion(a=>(a >= at && a < at + code.length ? code[a - at] : 0xf4), at, {});
    return countOps(emitBuilt(region, 0, layout, found, { hash: true, trapPort: 0xff77 }).module);
};
/** @type {Map<string, number>} */
const costOf = new Map();
const empty = opsOf([]);

const counted = new Set(blocks.map(([address])=>address));
/** Runs of two and three forms in a row (`--runs`), by key. @type {Map<string, number>[]} */
const runs = [new Map(), new Map()];
/** @type {Map<string, { executions: number, cost: number }>} */
const mix = new Map();
let executed = 0;
let outside = 0;
for (const [address, count] of blocks)
{
    if (!section(address))
    {
        outside += count;
        continue;
    }
    /** @type {string[]} */
    const keys = [];
    for (let eip = address; ;)
    {
        const instruction = decode(read, eip);
        if ('refused' in instruction)
        {
            break;
        }
        const key = `${instruction.op} ${instruction.operands.map(formOf).join(',')}`;
        keys.push(key);
        if (!costOf.has(key))
        {
            const bytes = [];
            for (let i = 0; i < instruction.length; i++)
            {
                bytes.push(read(eip + i));
            }
            costOf.set(key, Math.max(0, opsOf(bytes) - empty));
        }
        const row = mix.get(key) ?? { executions: 0, cost: /** @type {number} */ (costOf.get(key)) };
        row.executions += count;
        mix.set(key, row);
        executed += count;
        eip += instruction.length;
        if (/^(j|call|ret|loop|int|iret|hlt)/.test(instruction.op) || counted.has(eip))
        {
            break;
        }
    }
    for (const [n, map] of runs.entries())
    {
        for (let i = n + 1; i < keys.length; i++)
        {
            const run = keys.slice(i - n - 1, i + 1).join(' ; ');
            map.set(run, (map.get(run) ?? 0) + count);
        }
    }
}

let weighted = 0;
for (const row of mix.values())
{
    weighted += row.executions * row.cost;
}
const rows = [...mix].sort((one, two)=>two[1].executions * two[1].cost
    - one[1].executions * one[1].cost);
const images = [manifest.entry, ...extra].join(', ');
console.log(`${blocks.length} blocks, ${executed} instructions in ${images}`
    + `, ${outside} block executions outside it`);
console.log('share  ops-share  ops/insn  form');
for (const [key, row] of rows.slice(0, top))
{
    console.log(`${(100 * row.executions / executed).toFixed(1).padStart(5)}%`
        + `  ${(100 * row.executions * row.cost / weighted).toFixed(1).padStart(8)}%`
        + `  ${String(row.cost).padStart(8)}  ${key}`);
}

if (args.includes('--runs'))
{
    for (const [n, map] of runs.entries())
    {
        console.log(`\nruns of ${n + 2} forms in a row, a share of the instructions executed`);
        for (const [run, count] of [...map].sort((one, two)=>two[1] - one[1]).slice(0, top))
        {
            console.log(`${(100 * count / executed).toFixed(2).padStart(6)}%  ${run}`);
        }
    }
}

/**
 * An operand's form: register, memory (a stack slot, through esp or ebp, apart),
 * immediate, x87 stack or vector register.
 *
 * @param {import('../modules/cork/src/decode/decoder.js').Operand} operand
 */
function formOf(operand){
    switch (operand.kind)
    {
        case 'reg': return `r${operand.size * 8}`;
        case 'mem':
            return `${operand.base === 4 || operand.base === 5 ? 'stack' : 'm'}${operand.size * 8}`;
        case 'imm': return 'i';
        default: return operand.kind;
    }
}

/**
 * The code section's operations, counted by walking each function body.
 *
 * @param {Uint8Array} bytes
 */
function countOps(bytes){
    let at = 8;
    const leb = ()=>{
        let result = 0;
        let shift = 0;
        let byte;
        for (;;)
        {
            byte = bytes[at++];
            result |= (byte & 0x7f) << shift;
            shift += 7;
            if (!(byte & 0x80))
            {
                break;
            }
        }
        return result >>> 0;
    };
    const skipLeb = ()=>{
        while (bytes[at++] & 0x80)
        {
            // continuation bytes
        }
    };
    let ops = 0;
    while (at < bytes.length)
    {
        const id = bytes[at++];
        const size = leb();
        const end = at + size;
        if (id === 10)
        {
            for (let functions = leb(); functions > 0; functions--)
            {
                const bodyEnd = leb() + at;
                for (let groups = leb(); groups > 0; groups--)
                {
                    leb();
                    at++;
                }
                while (at < bodyEnd)
                {
                    const op = bytes[at++];
                    ops++;
                    if (op >= 0x02 && op <= 0x04)
                    {
                        if (bytes[at] === 0x40 || bytes[at] >= 0x6f)
                        {
                            at++;
                        }
                        else
                        {
                            skipLeb();
                        }
                    }
                    else if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12
                        || (op >= 0x20 && op <= 0x24))
                    {
                        leb();
                    }
                    else if (op === 0x0e)
                    {
                        for (let targets = leb(); targets >= 0; targets--)
                        {
                            leb();
                        }
                    }
                    else if (op === 0x11 || op === 0x13 || (op >= 0x28 && op <= 0x3e))
                    {
                        leb();
                        leb();
                    }
                    else if (op === 0x3f || op === 0x40)
                    {
                        at++;
                    }
                    else if (op === 0x41 || op === 0x42)
                    {
                        skipLeb();
                    }
                    else if (op === 0x43)
                    {
                        at += 4;
                    }
                    else if (op === 0x44)
                    {
                        at += 8;
                    }
                    else if (op === 0xfc || op === 0xfd)
                    {
                        const sub = leb();
                        if (op === 0xfd)
                        {
                            if (sub <= 11 || sub === 92 || sub === 93)
                            {
                                leb();
                                leb();
                            }
                            else if (sub >= 84 && sub <= 91)
                            {
                                leb();
                                leb();
                                at++;
                            }
                            else if (sub === 12 || sub === 13)
                            {
                                at += 16;
                            }
                            else if (sub >= 21 && sub <= 34)
                            {
                                at++;
                            }
                        }
                        else if (sub === 10)
                        {
                            at += 2;
                        }
                        else if (sub === 11)
                        {
                            at++;
                        }
                    }
                }
                at = bodyEnd;
            }
        }
        at = end;
    }
    return ops;
}
