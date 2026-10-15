/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shape of a run's calls, from its block profile: what a benchmark of
 * calling conventions has to reproduce to measure what the engine would pay.
 *
 *   node tools/cork-calls.mjs <blocks.json> [--bundle id] [--image name.dll@0x2b3b000]...
 *       [--file path.exe@0x400000]... [--exclude 0x2b50c40-0x2b50cd2]... [--out profile.json]
 *
 * The blocks file is what `tools/cdp_test/game.mjs` writes for a run with
 * `--cork-config '{"blockProfile":true}'` (or any `{ blocks: [[address, count,
 * ...]] }`). The code comes from the bundle's entry image and its `--image`s
 * placed where the run put them, or from `--file`s on disk; blocks in the
 * `--exclude` ranges are left out (a wait loop whose turns say nothing of the
 * program's own calls). Each counted block is decoded to its first control
 * transfer or the next counted block, and every executed call is classed:
 *
 *   direct      `call rel`
 *   indirect    `call r32` or `call [m]` through a register
 *   import      `call [address]`, a fixed slot: an import's, through the host
 *
 * and the registers around it read: those the code after its return reads
 * before writing (`liveAfter`), and for a direct call those the callee's first
 * block reads before writing (`liveIn`). A block ends before every register is
 * decided, so each count is a lower bound and the undecided ones are counted
 * beside it. esp is always live and counted in neither. How deep the calls
 * nest is not in a block profile: it is written `not measured`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBundle } from './btl.mjs';
import { decode } from '../modules/cork/src/decode/decoder.js';

const args = process.argv.slice(2);
/** @param {string} name */
const all = name=>args.flatMap((one, at)=>(one === name ? [args[at + 1]] : []));
/** @param {string} name @param {string} [fallback] */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const profile = JSON.parse(readFileSync(args[0], 'utf8'));
const excluded = all('--exclude').map(range=>range.split('-').map(Number));

/** @type {{ va: number, size: number, raw: number, bytes: Buffer }[]} */
const sections = [];
/** @param {Buffer} bytes @param {number | null} base */
const place = (bytes, base)=>{
    const pe = bytes.readUInt32LE(0x3c);
    const imageBase = base ?? bytes.readUInt32LE(pe + 52);
    const optional = bytes.readUInt16LE(pe + 20);
    for (let i = 0, at = pe + 24 + optional; i < bytes.readUInt16LE(pe + 6); i++, at += 40)
    {
        sections.push({ va: imageBase + bytes.readUInt32LE(at + 12),
            size: bytes.readUInt32LE(at + 16), raw: bytes.readUInt32LE(at + 20), bytes });
    }
};
const bundleId = flag('--bundle', profile.bundle);
if (bundleId)
{
    const directory = join('bundles', bundleId);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    const opened = await openBundle(join(directory, manifest.bundle?.file ?? 'bundle.btl'));
    place(await opened.read(manifest.entry), null);
    for (const one of all('--image'))
    {
        const [path, base] = one.split('@');
        place(await opened.read(path), Number(base));
    }
    await opened.close();
}
for (const one of all('--file'))
{
    const [path, base] = one.split('@');
    place(readFileSync(path), base === undefined ? null : Number(base));
}
/** @param {number} address */
const section = address=>sections.find(one=>address >= one.va && address < one.va + one.size);
/** @param {number} address */
const read = address=>{
    const one = section(address);
    return one ? one.bytes[one.raw + address - one.va] : 0;
};

/** The 32-bit register an operand names: al..bl and ah..bh are eax..ebx. @param {any} operand */
const regOf = operand=>(operand.size === 1 ? operand.reg & 3 : operand.reg);
const ESP = 4;
/** Operations that write their destination without reading it. */
const WRITE_ONLY = /^(mov|movzx|movsx|lea|pop|set|movs[sd]?x?$)/;
/** Operations that read their destination without writing it. */
const READ_ONLY = /^(cmp|test|push|bt$)/;

/**
 * The registers an instruction reads and writes, as far as liveness needs:
 * a destination is read unless the operation only writes it, `xor r, r` and
 * `sub r, r` read nothing, and the implicit ones (the stack's, the string
 * operations', a one-operand multiply's) are counted.
 *
 * @param {import('../modules/cork/src/decode/decoder.js').Instruction} instruction
 */
function accessOf(instruction){
    const reads = new Set();
    const writes = new Set();
    const { op, operands } = instruction;
    operands.forEach((operand, index)=>{
        if (operand.kind === 'mem')
        {
            for (const reg of [operand.base, operand.index])
            {
                if (reg !== undefined && reg >= 0)
                {
                    reads.add(reg);
                }
            }
            return;
        }
        if (operand.kind !== 'reg')
        {
            return;
        }
        const reg = regOf(operand);
        if (index > 0)
        {
            reads.add(reg);
            return;
        }
        const zeroing = (op === 'xor' || op === 'sub') && operands[1]?.kind === 'reg'
            && regOf(operands[1]) === reg;
        if (!WRITE_ONLY.test(op) && !zeroing)
        {
            reads.add(reg);
        }
        if (!READ_ONLY.test(op))
        {
            writes.add(reg);
        }
    });
    if (/^(push|pop|call|ret|leave|enter)/.test(op))
    {
        reads.add(ESP);
        writes.add(ESP);
    }
    if ((op === 'mul' || op === 'imul' || op === 'div' || op === 'idiv') && operands.length === 1)
    {
        reads.add(0);
        writes.add(0);
        writes.add(2);
        if (op === 'div' || op === 'idiv')
        {
            reads.add(2);
        }
    }
    if (op === 'cdq' || op === 'cwd')
    {
        reads.add(0);
        writes.add(2);
    }
    if (/^(movs|stos|cmps|scas|lods)/.test(op))
    {
        for (const reg of [6, 7, ...instruction.prefixes?.rep || instruction.prefixes?.repne
            ? [1] : [], ...op.startsWith('stos') || op.startsWith('scas') ? [0] : []])
        {
            reads.add(reg);
            writes.add(reg);
        }
    }
    return { reads, writes };
}

const TRANSFER = /^(j|call|ret|loop|int|iret|hlt)/;

/**
 * Of the registers but esp, those the code from `at` reads before it writes
 * them, up to its first control transfer: [live, undecided].
 *
 * @param {number} at
 */
function liveFrom(at){
    const live = new Set();
    const written = new Set();
    for (let eip = at, steps = 0; steps < 64; steps++)
    {
        const instruction = decode(read, eip);
        if ('refused' in instruction)
        {
            break;
        }
        const { reads, writes } = accessOf(instruction);
        for (const reg of reads)
        {
            if (!written.has(reg))
            {
                live.add(reg);
            }
        }
        for (const reg of writes)
        {
            written.add(reg);
        }
        eip += instruction.length;
        if (TRANSFER.test(instruction.op))
        {
            break;
        }
    }
    live.delete(ESP);
    written.delete(ESP);
    const decided = new Set([...live, ...written]);
    return [live.size, 7 - decided.size];
}

const counted = new Set(profile.blocks.map((/** @type {number[]} */ [address])=>address));
let executed = 0;
let outside = 0;
let left = 0;
const calls = { direct: 0, indirect: 0, import: 0 };
/** @type {number[]} */
const liveAfter = new Array(8).fill(0);
/** @type {number[]} */
const undecidedAfter = new Array(8).fill(0);
/** @type {number[]} */
const liveIn = new Array(8).fill(0);
/** @type {Map<number, number>} */
const callees = new Map();
for (const [address, count] of profile.blocks)
{
    if (excluded.some(([from, to])=>address >= from && address < to))
    {
        left += count;
        continue;
    }
    if (!section(address))
    {
        outside += count;
        continue;
    }
    for (let eip = address; ;)
    {
        const instruction = decode(read, eip);
        if ('refused' in instruction)
        {
            break;
        }
        executed += count;
        eip += instruction.length;
        if (instruction.op === 'call')
        {
            const [target] = instruction.operands;
            const kind = target.kind === 'rel' ? 'direct'
                : target.kind === 'mem' && (target.base ?? -1) < 0 && (target.index ?? -1) < 0
                    ? 'import' : 'indirect';
            calls[kind] += count;
            if (kind !== 'import')
            {
                const [live, undecided] = liveFrom(eip);
                liveAfter[live] += count;
                undecidedAfter[undecided] += count;
            }
            if (kind === 'direct')
            {
                const callee = /** @type {number} */ (target.target);
                liveIn[liveFrom(callee)[0]] += count;
                callees.set(callee, (callees.get(callee) ?? 0) + count);
            }
        }
        if (TRANSFER.test(instruction.op) || counted.has(eip))
        {
            break;
        }
    }
}

/** A histogram's mean. @param {number[]} counts */
const mean = counts=>counts.reduce((sum, n, at)=>sum + n * at, 0)
    / Math.max(1, counts.reduce((sum, n)=>sum + n, 0));
/** How many of the most called direct callees take `share` of the direct calls. */
const covering = (/** @type {number} */ share)=>{
    let held = 0;
    let n = 0;
    for (const count of [...callees.values()].sort((a, b)=>b - a))
    {
        if (held >= calls.direct * share)
        {
            break;
        }
        held += count;
        n++;
    }
    return n;
};
const guest = calls.direct + calls.indirect;
const result = {
    source: args[0],
    executed,
    blockExecutionsOutside: outside,
    blockExecutionsExcluded: left,
    calls,
    indirectShare: guest > 0 ? calls.indirect / guest : 0,
    instructionsPerCall: guest > 0 ? executed / guest : null,
    liveAfter: { histogram: liveAfter, mean: mean(liveAfter),
        undecided: undecidedAfter, undecidedMean: mean(undecidedAfter) },
    liveIn: { histogram: liveIn, mean: mean(liveIn) },
    calleesFor90: covering(0.9),
    callees: callees.size,
    depth: 'not measured',
};
const text = JSON.stringify(result, null, 1);
const out = flag('--out');
if (out)
{
    writeFileSync(out, `${text}\n`);
}
console.log(text);
