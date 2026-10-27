/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The machine code a region of x86 becomes: the region formed and emitted as
 * the translator does (`regionModule`), compiled by this node's own V8 with
 * its optimising compiler, and its instructions counted. Bytes of wasm are a
 * poor measure of what a form costs -- the optimiser drops most of the local
 * moves cork writes -- while the machine instructions an x86 instruction
 * becomes are what the processor runs, the same on every run.
 *
 *     node tools/cork-asm.mjs --hex '8b 46 08 4b 75 fa c3' [--at 0x1000] [--listing]
 *     node tools/cork-asm.mjs --pe Cry3DEngine.dll --base 0x444d000 --entry 0x44e1460,0x4587299
 *
 *   --hex BYTES       the code, as hex bytes, lying at --at (default 0x1000)
 *   --pe PATH         a PE image, its sections mapped at --base (default its own image base)
 *   --image PATH@BASE an image at the base a process mapped it at; repeated, the images
 *                     lie in one span, so a region's calls into another DLL are formed
 *                     as the game forms them
 *   --entry LIST      where regions start, comma separated (default --at)
 *   --hash            entry hash and calls as wasm calls, as a game runs (on with --pe
 *                     and --image)
 *   --atomic          the variant several executors run
 *   --ordered         with --atomic, the variant several executors run on a host that
 *                     reorders plain accesses (an arm64 one)
 *   --ram MB          the guest RAM the layout is made for (default 2048, the launcher's)
 *   --form-depth N    how many levels of callees a region forms in (the runtime's
 *                     `formDepth`, default 1)
 *   --ram-base N      where guest RAM lies in the memory: 0 (the default, a Windows
 *                     process's first executor) or 65536 (a page in, cork's own default)
 *   --listing         every region's machine code, after its row
 *   --runner COMMAND  the node that compiles, with what runs it: another
 *                     architecture's node under an emulator, e.g.
 *                     'qemu-aarch64-static -L /usr/aarch64-linux-gnu node-arm64/bin/node';
 *                     one that names arm64 (aarch64) gets the module an arm64 host emits,
 *                     whose default NaN is positive: its float arithmetic carries the
 *                     fix-ups for x86's negative one, which an x86 host emits no code for
 *   --count REGEX     a column of the machine instructions the pattern matches
 *   --blocks FILE     a game's block profile (`game-<stamp>-blocks.json`): each block's
 *                     code found by the mark a diagnostic build stores at its start
 *                     (`markBlocks`), and its machine instructions weighted by how often
 *                     it ran -- what an executed guest instruction costs, the cold
 *                     paths, exits and prologue left out
 *   --heaviest N      with --blocks, the N blocks whose machine instructions ran most,
 *                     each with its code
 *   --processors N    the executors the layout is the first of (default 3, as a game's
 *                     process: its back edges read the interrupt word)
 *   --classes         with --blocks, what the executed machine instructions are, by kind
 *                     (`classOf`), and the --count pattern weighed the same way: where a
 *                     translation's instructions go besides the guest's own work
 *   --calls           with --blocks, the blocks that make a guest call as a wasm call
 *                     (`callReturn`) taken apart (`callPartOf`): the return stack, the
 *                     registers written into the state block, the target's lookup and the
 *                     call itself, V8's spills, and after the call the registers read back,
 *                     V8's reloads and the rest. A block's code is weighed whole, the
 *                     lookup's probe of the entry hash included, which a call that finds
 *                     its target at once does not run
 *
 * The compiler is this node's V8, which is older than a current browser's: the
 * counts compare two emitters on one V8, not cork with a browser.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regionModule } from '../modules/cork/src/region-module.js';
import { BLOCK_MARK_END, CallStack } from '../modules/cork/src/emit/region.js';
import { ownLayout } from '../modules/cork/src/runtime/layout.js';

const args = process.argv.slice(2);
/** @param {string} name */
const value = name=>(args.includes(name) ? args[args.indexOf(name) + 1] : null);

/**
 * A PE image's sections at their addresses, as one array from the base.
 *
 * @param {Uint8Array} file
 * @param {number | null} base
 */
function mapImage(file, base){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const pe = view.getUint32(0x3c, true);
    const sections = view.getUint16(pe + 6, true);
    const optional = pe + 24;
    const imageBase = view.getUint32(optional + 28, true);
    const size = view.getUint32(optional + 56, true);
    const table = optional + view.getUint16(pe + 20, true);
    const image = new Uint8Array(size);
    image.set(file.subarray(0, Math.min(file.length, 0x1000)));
    for (let i = 0; i < sections; i++)
    {
        const at = table + i * 40;
        const virtualSize = view.getUint32(at + 8, true);
        const address = view.getUint32(at + 12, true);
        const rawSize = view.getUint32(at + 16, true);
        const raw = view.getUint32(at + 20, true);
        const length = Math.min(rawSize, virtualSize || rawSize, size - address);
        image.set(file.subarray(raw, raw + length), address);
    }
    return { image, base: base ?? imageBase };
}

/**
 * The absolute index of the function a module exports by this name.
 *
 * @param {Uint8Array} wasm @param {string} wanted
 */
function exportedIndex(wasm, wanted){
    let at = 8;
    const leb = ()=>{
        let result = 0;
        let shift = 0;
        for (;;)
        {
            const byte = wasm[at++];
            result |= (byte & 0x7f) << shift;
            shift += 7;
            if ((byte & 0x80) === 0)
            {
                return result >>> 0;
            }
        }
    };
    while (at < wasm.length)
    {
        const id = wasm[at++];
        const size = leb();
        const end = at + size;
        if (id === 7)
        {
            for (let count = leb(); count > 0; count--)
            {
                const length = leb();
                const name = new TextDecoder().decode(wasm.subarray(at, at + length));
                at += length;
                const kind = wasm[at++];
                const index = leb();
                if (kind === 0 && name === wanted)
                {
                    return index;
                }
            }
        }
        at = end;
    }
    throw new Error(`no export ${wanted}`);
}

/**
 * The optimised machine code of one function of a module, from V8's own
 * printer in a node of its own (the flags compile every function eagerly).
 *
 * @param {Uint8Array} wasm @param {number} index
 */
function machineCode(wasm, index){
    const dir = mkdtempSync(join(tmpdir(), 'cork-asm-'));
    try
    {
        writeFileSync(join(dir, 'm.wasm'), wasm);
        // Compiled at once, in this thread: an asynchronous compile may still be
        // running on a background thread when a newer node's script ends.
        const script = 'new WebAssembly.Module(require("node:fs").readFileSync(process.argv[1]));';
        // This node's own path is one word even when it has spaces in it (Program Files).
        const runner = value('--runner');
        const [command, ...prefix] = runner ? runner.split(/\s+/) : [process.execPath];
        const out = execFileSync(command, [...prefix, '--print-wasm-code', '--no-liftoff',
            '--no-wasm-lazy-compilation', '--input-type=commonjs', '-e', script,
            join(dir, 'm.wasm')],
        { encoding: 'utf8', maxBuffer: 1 << 30 });
        const parts = out.split('--- WebAssembly code ---');
        const part = parts.find(text=>new RegExp(`^index: ${index}$`, 'm').test(text));
        if (part === undefined)
        {
            throw new Error(`V8 printed no code for function ${index}`);
        }
        const body = part.slice(part.indexOf('Instructions'));
        // A Windows node prints CRLF and its addresses bare and upper case
        // (`000001EE52DC17E0`); the rest of this file reads the Linux form (`0x...`).
        const lines = body.split(/\r?\n/).slice(1)
            .map(line=>line.replace(/^(?:0x)?([0-9A-Fa-f]{8,})(?=\s)/, (all, at)=>`0x${at.toLowerCase()}`));
        const end = lines.findIndex(line=>line.trim() === '');
        return lines.slice(0, end < 0 ? undefined : end).filter(line=>/^0x[0-9a-f]+\s/.test(line));
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
}

const pePath = value('--pe');
const hex = value('--hex');
if (pePath === null && hex === null && !args.includes('--image'))
{
    console.error('usage: node tools/cork-asm.mjs --hex BYTES [--at ADDRESS] | --pe PATH'
        + ' [--base ADDRESS] | --image PATH@BASE... [--entry LIST] [--hash] [--atomic]'
        + ' [--ram MB] [--listing] [--blocks FILE]');
    process.exit(2);
}
let code;
let at;
const images = args.flatMap((arg, i)=>(arg === '--image' ? [args[i + 1]] : []));
if (images.length > 0)
{
    // Several images as a process maps them: one span from the lowest base
    // to the highest image's end, each at its own base.
    const mapped = images.map(spec=>{
        const [path, base] = spec.split('@');
        return mapImage(readFileSync(path), Number(base));
    });
    at = Math.min(...mapped.map(one=>one.base));
    const end = Math.max(...mapped.map(one=>one.base + one.image.length));
    code = new Uint8Array(end - at);
    for (const one of mapped)
    {
        code.set(one.image, one.base - at);
    }
}
else if (pePath !== null)
{
    const base = value('--base');
    const mapped = mapImage(readFileSync(pePath), base === null ? null : Number(base));
    code = mapped.image;
    at = mapped.base;
}
else
{
    code = /** @type {string} */ (hex).trim().split(/[\s,]+/).map(byte=>Number.parseInt(byte, 16));
    at = Number(value('--at') ?? 0x1000);
}
const entries = (value('--entry') ?? String(at)).split(',').map(Number);
const hash = pePath !== null || args.includes('--image') || args.includes('--hash');
const ramSize = Number(value('--ram') ?? 2048) * (1 << 20);
const formDepth = value('--form-depth') === null ? null : Number(value('--form-depth'));
// Guest RAM from the memory's start, as a Windows process's first executor has it
// (`ownLayout`'s `ramBase` 0), unless `--ram-base` says one page in.
const ramBase = Number(value('--ram-base') ?? 0);
/** Where a block's mark is stored: in the state page, short of `nanFirst`. */
const markOffset = ownLayout({ ramSize, ramBase }).regs + 1020;

/**
 * The machine code of each block, by the marks a diagnostic build stores at
 * their starts (`blockMark`): x86-64 holds the mark as an immediate, arm64 builds
 * it in a register with `mov`/`movk` before the store. A block emitted twice (a
 * hoisted loop's two copies), or whose code the compiler made twice (a loop it
 * unrolled), keeps its cheapest copy, the one its turns mostly run; the code
 * before the first mark (the prologue and the dispatch) and past the end mark
 * (the epilogue, the cold paths moved there) belongs to no block.
 *
 * @param {string[]} lines  the function's instructions, without the padding
 * @returns {{ code: Map<number, string[]>, marks: Set<string> }}
 */
function blockCode(lines){
    /** @type {Map<string, string[][]>} by block and copy, each time its mark comes */
    const segments = new Map();
    /** @type {string[] | null} */
    let into = null;
    const marks = new Set();
    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        let mark = -1;
        const arm = /(movk|movz)\s+[wx](\d+), #0x6b5a(0000)?(, lsl #16)?$/.exec(line);
        const x64 = arm === null ? /0x6b5a([0-9a-f]{4})\b/.exec(line) : null;
        if (x64)
        {
            mark = Number.parseInt(x64[1], 16);
            marks.add(line);
        }
        else if (arm)
        {
            // movz of the low half then movk of the high one, or one movz
            // of the whole when the low half is zero.
            mark = 0;
            marks.add(line);
            const low = new RegExp(`movz?\\s+[wx]${arm[2]}, #(0x[0-9a-f]+|\\d+)$`)
                .exec(lines[i - 1] ?? '');
            if (arm[1] === 'movk' && low)
            {
                mark = Number(low[1]);
                marks.add(lines[i - 1]);
            }
            // The store of the value made, where it follows close.
            const stored = new RegExp(`str\\s+w${arm[2]}, \\[x\\d+, #${markOffset}\\]`);
            const store = lines.slice(i + 1, i + 4).find(next=>stored.test(next));
            if (store)
            {
                marks.add(store);
            }
        }
        if (mark >= 0)
        {
            const index = mark & 0xfff;
            into = null;
            if (index !== BLOCK_MARK_END)
            {
                const key = `${index}:${mark >> 12}`;
                into = [];
                segments.set(key, [...segments.get(key) ?? [], into]);
            }
            continue;
        }
        if (into !== null)
        {
            into.push(line);
        }
    }
    /** @type {Map<number, string[]>} */
    const byIndex = new Map();
    for (const [key, instances] of segments)
    {
        const index = Number(key.split(':')[0]);
        for (const segment of instances)
        {
            const real = segment.filter(line=>!marks.has(line));
            const known = byIndex.get(index);
            if (known === undefined || real.length < known.length)
            {
                byIndex.set(index, real);
            }
        }
    }
    return { code: byIndex, marks };
}

/**
 * By block start and the region that ran it (`start@entry`), how often it ran:
 * a block several regions hold ran in each as often as that region's copy did.
 *
 * @type {Map<string, number> | null}
 */
let profile = null;
if (value('--blocks') !== null)
{
    profile = new Map();
    const { blocks } = JSON.parse(readFileSync(/** @type {string} */ (value('--blocks')), 'utf8'));
    for (const [start, count, , region] of blocks)
    {
        const key = `${start}@${region}`;
        profile.set(key, (profile.get(key) ?? 0) + count);
    }
}
/**
 * What a machine instruction is for, by its text in V8's printer, x86-64 or
 * arm64 alike: a stack slot's load or store (`frame`, the register allocator's
 * spills), a register copied (`move`, mostly the merges of a loop's values), a
 * constant made, a guest address wrapped into RAM (`wrap`), another load or
 * store (`memory`: guest RAM, the state block, the page flags), a branch, a
 * comparison or a select, and the rest of the arithmetic.
 *
 * @param {string} line
 * @returns {string}
 */
function classOf(line){
    const text = line.replace(/^0x[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+/, '')
        .replace(/^REX\.W\s+/, '');
    const [mnemonic = '', ...rest] = text.split(/\s+/);
    const operands = rest.join(' ');
    if (/\[(rbp|rsp|sp|fp)\b/.test(operands))
    {
        return 'frame';
    }
    if (/,\s*(#)?0x7fffffff\b/.test(operands) && /^and/.test(mnemonic))
    {
        return 'wrap';
    }
    if (/^mov[lqwb]?$/.test(mnemonic) && /^[a-z][a-z0-9]*,\s*[a-z][a-z0-9]*$/.test(operands))
    {
        return 'move';
    }
    if (/^(movz|movk|movn)$/.test(mnemonic) || /^mov[lqwb]?$/.test(mnemonic)
        && /^[a-z][a-z0-9]*,\s*#?(0x[0-9a-f]+|-?\d+)\b/.test(operands)
        || /^xor[lq]?$/.test(mnemonic) && /^([a-z0-9]+),\s*\1$/.test(operands))
    {
        return 'constant';
    }
    // An address computed is arithmetic, though it is written as one.
    if (/^lea/.test(mnemonic))
    {
        return 'other';
    }
    if (operands.includes('[') || /^(ld|st)/.test(mnemonic))
    {
        return 'memory';
    }
    if (/^(j|b$|b\.|bl|br|cbz|cbnz|tbz|tbnz|ret|call)/.test(mnemonic))
    {
        return 'branch';
    }
    if (/^(cmp|cmn|test|tst|set|cset|csel|csinc|csinv|csneg|ccmp|cmov)/.test(mnemonic))
    {
        return 'compare';
    }
    return 'other';
}

/** The state page as the modules' layout has it: the registers from `regs`, the return stack past them. */
const statePage = ownLayout({ ramSize, ramBase });

/**
 * A block's machine instructions by what they do for the guest call it ends with, made as a
 * wasm call (`--calls`); null for a block that makes none, whose code never reaches the
 * return stack. The site runs from the block's first access to the return stack to its last
 * call (`blr` on arm64, `call` on x86-64, the transfer's): the push, the registers the
 * callee reads written into the state block, the target looked up in the entry hash and the
 * call. After it the caller reads back what the callee may have changed.
 *
 * @param {string[]} lines  the block's, nops and tables left out
 * @returns {Map<string, number> | null}
 */
function callPartsOf(lines){
    const depth = statePage.regs + CallStack.DEPTH;
    const stackEnd = statePage.regs + CallStack.STACK + 4 * CallStack.LIMIT;
    const texts = lines.map(line=>line.replace(/^0x[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+/, '')
        .replace(/^REX\.W\s+/, ''));
    /** The displacement a memory operand names, -1 for none. @param {string} text */
    const offsetOf = text=>{
        const found = /\[[^\]]*?(?:#|\+\s*)(0x[0-9a-f]+|\d+)\]/.exec(text);
        return found === null ? -1 : Number(found[1]);
    };
    const first = texts.findIndex(text=>{
        const offset = offsetOf(text);
        return offset >= depth && offset < stackEnd;
    });
    const calls = texts.flatMap((text, i)=>(/^(blr|bl|call)\s/.test(text) ? [i] : []));
    const last = calls[calls.length - 1] ?? -1;
    if (first < 0 || last < first)
    {
        return null;
    }
    /** @type {Map<string, number>} */
    const parts = new Map();
    texts.forEach((text, i)=>{
        const [mnemonic = '', ...rest] = text.split(/\s+/);
        const operands = rest.join(' ');
        const offset = offsetOf(text);
        const state = offset >= statePage.regs && offset < depth;
        const frame = /\[(rbp|rsp|sp|fp)\b/.test(operands);
        // A store names memory first on x86-64 (`movl [r14+0x1000],rax`).
        const store = /^st/.test(mnemonic) || /^mov/.test(mnemonic) && operands.startsWith('[');
        const part = i < first ? 'before the call'
            : i <= last ? (offset >= depth && offset < stackEnd ? 'return stack'
                : frame ? 'V8 spills' : state && store ? 'registers written back'
                    : 'lookup and call')
                : frame ? 'V8 reloads' : state && !store ? 'registers read back'
                    : 'after the call';
        parts.set(part, (parts.get(part) ?? 0) + 1);
    });
    return parts;
}

const processors = Number(value('--processors') ?? 3);
/** The module as the runner's own host emits it: an arm64 one's default NaN is positive. */
const hostFeatures = /aarch64|arm64/.test(value('--runner') ?? process.arch)
    ? { defaultNaNNegative: false } : { defaultNaNNegative: true };
console.log(`emitted for a host whose default NaN is ${hostFeatures.defaultNaNNegative
    ? 'negative (x86)' : 'positive (arm64)'}`);
const counted = value('--count') === null ? null : new RegExp(/** @type {string} */ (value('--count')));
console.log(`     entry  blocks  x86  wasm B  machine  bytes  per x86${counted ? '  matched' : ''}`
    + (profile ? '  ran x86  weighted' : ''));
let sumX86 = 0;
let sumMachine = 0;
let sumMatched = 0;
let ranX86 = 0;
let ranMachine = 0;
/** Executed machine instructions by kind (`classOf`), and the --count pattern's. */
const classes = new Map();
let ranMatched = 0;
/** With --calls, executed machine instructions by their part in a call (`callPartsOf`). */
const callParts = new Map();
let callsRan = 0;
/** @type {{ start: number, runs: number, x86: number, code: string[] }[]} */
const heavy = [];
for (const entry of entries)
{
    const made = regionModule({ code, at, entry, hash, callReturn: hash, ramSize, ramBase,
        atomic: args.includes('--atomic'), ordered: args.includes('--ordered'), checked: false,
        wide: true, looseStacks: true, hostFeatures,
        processors, markBlocks: profile !== null,
        form: formDepth === null ? {} : { formDepth } });
    const x86 = made.blocks.reduce((sum, block)=>sum + block.instructions, 0);
    const lines = machineCode(made.wasm, exportedIndex(made.wasm, 'region'));
    const { code: byBlock, marks } = profile === null ? { code: new Map(), marks: new Set() }
        : blockCode(lines);
    const real = lines.filter(line=>!/\s(nop|int3)\b|jump table entry|constant pool/.test(line)
        && !marks.has(line));
    let regionX86 = 0;
    let regionMachine = 0;
    if (profile !== null)
    {
        made.blocks.forEach((block, index)=>{
            const runs = profile.get(`${block.start}@${made.entry}`) ?? 0;
            const machine = byBlock.get(index)
                ?.filter(line=>!/\s(nop|int3)\b|jump table entry|constant pool/.test(line)).length;
            if (runs > 0 && machine !== undefined)
            {
                regionX86 += runs * block.instructions;
                regionMachine += runs * machine;
                for (const line of /** @type {string[]} */ (byBlock.get(index)))
                {
                    if (/\s(nop|int3)\b|jump table entry|constant pool/.test(line))
                    {
                        continue;
                    }
                    const kind = classOf(line);
                    classes.set(kind, (classes.get(kind) ?? 0) + runs);
                    ranMatched += counted !== null && counted.test(line) ? runs : 0;
                }
                if (args.includes('--calls'))
                {
                    const parts = callPartsOf(/** @type {string[]} */ (byBlock.get(index))
                        .filter(line=>!/\s(nop|int3)\b|jump table entry|constant pool/.test(line)))
                        ?? new Map([['blocks without a guest call', machine]]);
                    callsRan += parts.has('blocks without a guest call') ? 0 : runs;
                    for (const [part, count] of parts)
                    {
                        callParts.set(part, (callParts.get(part) ?? 0) + runs * count);
                    }
                }
                heavy.push({ start: block.start, runs, x86: block.instructions,
                    code: /** @type {string[]} */ (byBlock.get(index)) });
            }
        });
        ranX86 += regionX86;
        ranMachine += regionMachine;
    }
    const bytes = lines.reduce((sum, line)=>sum + (line.split(/\s+/)[2]?.length ?? 0) / 2, 0);
    const matched = counted === null ? 0 : real.filter(line=>counted.test(line)).length;
    sumX86 += x86;
    sumMachine += real.length;
    sumMatched += matched;
    const weighted = regionX86 > 0 ? (regionMachine / regionX86).toFixed(2) : '-';
    console.log(`0x${made.entry.toString(16).padStart(8, '0')}`
        + ` ${String(made.blocks.length).padStart(7)}`
        + ` ${String(x86).padStart(4)} ${String(made.wasm.length).padStart(7)}`
        + ` ${String(real.length).padStart(8)} ${String(bytes).padStart(6)}`
        + ` ${(real.length / x86).toFixed(2).padStart(8)}`
        + (counted === null ? '' : ` ${String(matched).padStart(8)}`)
        + (profile === null ? ''
            : ` ${(regionX86 / 1e6).toFixed(0).padStart(7)}M ${weighted.padStart(9)}`)
        + (Object.keys(made.refused).length > 0
            ? `  refused ${JSON.stringify(made.refused)}` : ''));
    if (args.includes('--listing'))
    {
        console.log(lines.join('\n'));
    }
}
if (entries.length > 1)
{
    console.log(`all: ${sumX86} x86 instructions, ${sumMachine} machine instructions,`
        + ` ${(sumMachine / sumX86).toFixed(2)} a guest instruction`
        + (counted === null ? ''
            : `; matched ${sumMatched} (${(sumMatched / sumMachine * 100).toFixed(1)}%)`));
}
if (profile !== null && value('--heaviest') !== null)
{
    const weight = (/** @type {{ runs: number, code: string[] }} */ one)=>one.runs * one.code.length;
    heavy.sort((a, b)=>weight(b) - weight(a));
    for (const one of heavy.slice(0, Number(value('--heaviest'))))
    {
        const share = (weight(one) / ranMachine * 100).toFixed(1);
        console.log(`\nblock 0x${one.start.toString(16)}: ran ${one.runs}, ${one.x86} x86,`
            + ` ${one.code.length} machine (${share}% of all ran)`);
        console.log(one.code.map(line=>line.replace(/^0x[0-9a-f]+\s+/, '  ')).join('\n'));
    }
}
if (profile !== null && ranX86 > 0)
{
    console.log(`ran: ${(ranX86 / 1e9).toFixed(2)} G guest instructions in these blocks,`
        + ` ${(ranMachine / ranX86).toFixed(3)} machine instructions an executed one`);
    if (args.includes('--classes'))
    {
        const kinds = [...classes].sort((a, b)=>b[1] - a[1]);
        console.log('by kind, an executed guest instruction: ' + kinds.map(([kind, runs])=>
            `${kind} ${(runs / ranX86).toFixed(3)} (${(runs / ranMachine * 100).toFixed(1)}%)`)
            .join(', ')
            + (counted === null ? ''
                : `; --count ${(ranMatched / ranX86).toFixed(3)}`
                    + ` (${(ranMatched / ranMachine * 100).toFixed(1)}%)`));
    }
    if (args.includes('--calls'))
    {
        console.log(callsRan === 0 ? 'calls: none of these blocks makes a guest call'
            : `calls: ${(callsRan / 1e6).toFixed(1)} M guest calls, one every`
                + ` ${(ranX86 / callsRan).toFixed(1)} guest instructions; the executed machine`
                + ' instructions by part (each block weighed whole):');
        for (const [part, runs] of [...callParts].sort((a, b)=>b[1] - a[1]))
        {
            console.log(`  ${part.padEnd(28)} ${(runs / ranMachine * 100).toFixed(1).padStart(5)}%`
                + (part === 'blocks without a guest call' || callsRan === 0 ? ''
                    : `  ${(runs / callsRan).toFixed(1).padStart(6)} a call`));
        }
    }
}
