/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Long mode's interpreter tier in wasm (`interp-wasm.c` built with LONG)
 * judged twice. By the processor: every case of the hardware corpus
 * (`x64-corpus.json.gz`) run on the tier, `interp64.js` taking each
 * instruction the tier leaves as a host takes it, and compared with what the
 * processor did -- the sixteen registers, the status flags and DF but those
 * the case leaves undefined, the XMM registers, the data written, and a
 * fault's signal and instruction. And by `interp64.js`, its reference
 * interpreter: seeded programs -- the corpus's instructions in loops and
 * nested control flow, and programs of the forms long mode changes (REX,
 * RIP-relative operands with an immediate after them, quadword stack
 * operations and calls, dword writes zero-extending, 128-bit products and
 * quotients, the window's end at 4 GiB, repeated strings either way) -- run
 * on both from the same machine, and everything a program can see compared:
 * the registers, RIP, the instructions retired, the whole flags word, the
 * XMM registers, the x87 unit, the data and code areas, the trap port's
 * values and how the program ended. And directed cases for the ways a run
 * ends.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ZF } from './decode/table.js';
import { MODE_64, decode } from './decode/decoder.js';
import { Fault } from './ir.js';
import { blockState64, interpret64 } from './interp64.js';
import {
    HOT_SLOTS, WASM_INTERPRETER_AREA, WASM_INTERPRETER_STATICS_AT, WasmExit, createWasmInterpreter,
} from './interp-wasm.js';
import { SOURCE_SHA256 } from './interp-wasm64.bytes.js';
import { COMPARED, flagsLeftUndefined } from './testing/long-machine.js';
import { Tables, ownLayout, pageFlagsAt, pagesFor, tablesSize } from './runtime/layout.js';
import { PageFlag, createPageTable } from './runtime/pages.js';

const CORPUS = JSON.parse(gunzipSync(readFileSync(new URL('./x64-corpus.json.gz', import.meta.url)))
    .toString('utf8'));
/** Where the runner's exit jump goes: a closed page, whose fetch ends the case. */
const EXIT = 0x1f000000;
const TRAP_PORT = 0xb077;
const DATA = CORPUS.dataAt;
const CODE = CORPUS.codeAt;
/** Slots in the code area past any program, which RIP-relative operands reach. */
const SLOTS = CODE + 0xc000;
/** FS's and GS's bases: FS's the data's, so `fs:[d32]` reaches it; GS's a page below
 * zero, so an address through it wraps. */
const FS_BASE = BigInt(DATA);
const GS_BASE = -0x1000n & 0xffffffffffffffffn;
/** The signal each fault vector raises on Linux, as the corpus records it. */
const SIGNAL = /** @type {Record<number, number>} */ ({ 0: 8, 6: 4, 13: 11, 14: 11, 3: 5 });
/** Seeded programs of each kind: more with LONG_TIER_SEEDS. */
const SEEDS = Number(process.env.LONG_TIER_SEEDS ?? 1000);

/** The corpus runner's fill: xorshift32 from the seed, the low byte of each step. */
function fill(/** @type {number} */ seed, /** @type {number} */ size){
    const data = new Uint8Array(size);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < data.length; i++)
    {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        data[i] = x & 0xff;
    }
    return data;
}

/**
 * A machine with the corpus's data and code areas open and every other page
 * closed, the tier over it and `interp64.js`'s state over the same block.
 */
function machine(){
    const ramSize = CODE + 0x100000;
    const layout = ownLayout({ ramSize, ramBase: 0, bits: 64 });
    const area = layout.tables + tablesSize(layout);
    const memory = new WebAssembly.Memory({
        initial: pagesFor(layout, tablesSize(layout) + WASM_INTERPRETER_AREA) });
    const flags = new Uint8Array(memory.buffer, pageFlagsAt(layout), 1 << 20);
    flags.fill(PageFlag.INACCESSIBLE);
    for (const [at, size] of [[DATA, CORPUS.dataSize], [CODE, CORPUS.codeSize]])
    {
        flags.fill(0, at >>> 12, (at + size) >>> 12);
    }
    const table = createPageTable(memory, layout);
    const tier = createWasmInterpreter({ memory, layout, area, hotThreshold: 2,
        statics: layout.regs + WASM_INTERPRETER_STATICS_AT, trapPort: TRAP_PORT,
        parkBase: 0x100000, precise: true });
    assert.ok(tier, 'the tier runs over the 64-bit layout');
    /** The writes to ports other than the trap port. @type {number[][]} */
    const writes = [];
    const state = blockState64({ memory, layout, ports: { trapPort: TRAP_PORT,
        read: ()=>0xffffffff, write: (port, size, value)=>writes.push([port, size, value]) } });
    return { layout, memory, area, table, tier, state, writes, view: new DataView(memory.buffer),
        bytes: new Uint8Array(memory.buffer) };
}

/** @typedef {ReturnType<typeof machine>} Machine */

/**
 * Sets a case up: its code with the exit jump past it and EXIT in the area's
 * last eight bytes, the data, the slots, the registers, flags, XMM registers
 * and the x87 unit (as `fninit` leaves it, or its registers seeded and some
 * marked exact).
 *
 * @param {Machine} m @param {{ code: string, regs: string[], flags: number, seed: number }} one
 * @param {boolean} [seeded]  the x87 unit's registers seeded
 */
function load(m, one, seeded = false){
    const { layout, view, bytes } = m;
    const code = Buffer.from(one.code, 'hex');
    bytes.fill(0, CODE, CODE + CORPUS.codeSize);
    bytes.set(code, CODE);
    const disp = CORPUS.codeSize - 8 - (code.length + 6);
    bytes.set([0xff, 0x25, ...le32(disp)], CODE + code.length);
    view.setBigUint64(CODE + CORPUS.codeSize - 8, BigInt(EXIT), true);
    bytes.set(fill(one.seed ^ 0x5107, 0x1000), SLOTS);
    bytes.set(fill(one.seed, CORPUS.dataSize), DATA);
    bytes.fill(0, layout.regs, layout.regs + 1024);
    one.regs.forEach((value, i)=>{
        view.setBigUint64(layout.regs + i * 8, BigInt(`0x${value}`), true);
    });
    view.setBigUint64(layout.eip, BigInt(CODE), true);
    view.setUint32(layout.eflags, one.flags | 0x202, true);
    view.setUint32(layout.mxcsr, 0x1f80, true);
    view.setBigUint64(layout.fsBase, FS_BASE, true);
    view.setBigUint64(layout.gsBase, GS_BASE, true);
    bytes.set(fill(one.seed ^ CORPUS.xmmSeed, 256), layout.xmm);
    if (seeded)
    {
        bytes.set(fill(one.seed ^ 0x87, 128), layout.x87);
        bytes[/** @type {number} */ (layout.x87Exact)] = one.seed & 0xff;
    }
    bytes[layout.x87Top] = 0;
    bytes[layout.x87Empty] = 0xff;
    view.setUint16(layout.x87Control, 0x37f, true);
    m.writes.length = 0;
    m.tier.hotCounts.fill(0);
}

/** @param {number} value */
function le32(value){
    return [value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
}

/** @param {bigint} value */
function le64(value){
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt.asUintN(64, value));
    return [...bytes];
}

/**
 * Runs the loaded program on the tier, `interp64.js` taking each instruction
 * it leaves, to its exit, a fault or a halt.
 *
 * @param {Machine} m @param {(round: number) => number} budget  each run's
 */
function runTier(m, budget){
    const { tier, state, view, layout } = m;
    /** @type {number[]} */
    const trapped = [];
    let retired = 0;
    let handed = 0;
    let end = 'ran on';
    for (let round = 0; round < 200000; round++)
    {
        const code = tier.run(budget(round));
        retired += tier.retired();
        const rip = Number(view.getBigUint64(layout.eip, true));
        if (code === WasmExit.BUDGET || code === WasmExit.HOT || code === WasmExit.ENTRY
            || code === WasmExit.CODE_WRITE)
        {
            continue;
        }
        if (code === WasmExit.TRAP)
        {
            trapped.push(tier.exitValue());
            continue;
        }
        if (code === WasmExit.HALT)
        {
            end = 'halt';
            break;
        }
        if (code === WasmExit.FAULT)
        {
            // interp64 counts the instruction that faults.
            retired++;
            end = `${tier.exitValue()}@${rip - CODE}`;
            break;
        }
        assert.equal(code, WasmExit.UNSUPPORTED, `run ended ${code}`);
        if (rip === EXIT)
        {
            end = 'exit';
            break;
        }
        state.syncIn();
        state.halted = false;
        state.retired = 0;
        try
        {
            interpret64(state, 1);
        }
        catch (e){
            if (!(e instanceof Fault))
            {
                throw e;
            }
            // What a repeat did before its fault stands, its flags among it.
            state.syncOut();
            retired += state.retired;
            end = `${e.vector}@${e.eip - CODE}`;
            break;
        }
        state.syncOut();
        retired += state.retired;
        handed += state.retired;
        trapped.push(...state.trapped);
        state.trapped.length = 0;
        if (state.halted)
        {
            end = 'halt';
            break;
        }
    }
    return { end, retired, trapped, handed };
}

/** Runs the loaded program on `interp64.js` alone. @param {Machine} m */
function runReference(m){
    const { state } = m;
    /** @type {number[]} */
    const trapped = [];
    let end;
    state.syncIn();
    state.halted = false;
    state.retired = 0;
    state.trapped.length = 0;
    try
    {
        for (let round = 0; round < 100000 && !state.halted; round++)
        {
            interpret64(state, 100000);
            trapped.push(...state.trapped);
            state.trapped.length = 0;
        }
        end = state.halted ? 'halt' : 'ran on';
    }
    catch (e){
        if (!(e instanceof Fault))
        {
            throw e;
        }
        end = e.eip === EXIT ? 'exit' : `${e.vector}@${e.eip - CODE}`;
    }
    state.syncOut();
    return { end, retired: state.retired, trapped, handed: 0 };
}

/**
 * What a program can see at its end.
 *
 * @param {Machine} m @param {{ end: string, retired: number, trapped: number[] }} run
 */
function seen(m, run){
    const { layout, view, bytes } = m;
    return {
        end: run.end,
        retired: String(run.retired),
        trapped: run.trapped.join(','),
        ports: JSON.stringify(m.writes),
        regs: Array.from({ length: 16 }, (_, i)=>view.getBigUint64(layout.regs + i * 8, true)
            .toString(16)).join(' '),
        rip: run.end === 'exit' ? 'exit' : view.getBigUint64(layout.eip, true).toString(16),
        flags: view.getUint32(layout.eflags, true).toString(16),
        mxcsr: view.getUint32(layout.mxcsr, true).toString(16),
        xmm: Buffer.from(bytes.subarray(layout.xmm, layout.xmm + 256)).toString('hex'),
        // Each register's double, and the quadword beside it only where it is marked
        // exact: an unmarked one is read by nothing, and the tier writes the marked
        // ones back at a run's end where the model writes them at every instruction.
        x87: Array.from({ length: 8 }, (_, i)=>Buffer.from(bytes.subarray(layout.x87 + i * 16,
            layout.x87 + i * 16
                + ((bytes[/** @type {number} */ (layout.x87Exact)] >>> i & 1) !== 0 ? 16 : 8)))
            .toString('hex')).join(' ')
            + [layout.x87Top, layout.x87Empty, layout.x87Control, layout.x87Control + 1,
                layout.x87Status, layout.x87Status + 1, /** @type {number} */ (layout.x87Exact)]
                .map(at=>bytes[at].toString(16)).join(','),
        data: createHash('sha256').update(bytes.subarray(DATA, DATA + CORPUS.dataSize))
            .digest('hex'),
        code: createHash('sha256').update(bytes.subarray(CODE, CODE + CORPUS.codeSize))
            .digest('hex'),
    };
}

/** A small deterministic generator. @param {number} seed */
function random(seed){
    let x = seed >>> 0 || 1;
    return (/** @type {number} */ n)=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x % n;
    };
}

/**
 * Runs each program on two machines -- the tier with `interp64.js` taking
 * what it leaves, and `interp64.js` alone -- and answers the differences,
 * with what the tier ran itself and what it handed back.
 *
 * @param {{ text: string, code: string, regs: string[], flags: number, seed: number }[]} programs
 */
function compare(programs){
    const tierMachine = machine();
    const reference = machine();
    /** @type {string[]} */
    const failures = [];
    /** @type {Record<string, number>} */
    const ends = {};
    let byTier = 0;
    let handed = 0;
    for (const one of programs)
    {
        load(tierMachine, one, true);
        load(reference, one, true);
        const next = random(one.seed ^ 0xb0d9);
        // Budgets small and large, so runs end between instructions as well as at exits.
        const onTier = runTier(tierMachine, ()=>(next(3) === 0 ? 1 + next(5) : 1 + next(500)));
        const expected = seen(reference, runReference(reference));
        const got = seen(tierMachine, onTier);
        byTier += onTier.retired - onTier.handed;
        handed += onTier.handed;
        ends[got.end.replace(/@.*/, '@')] = (ends[got.end.replace(/@.*/, '@')] ?? 0) + 1;
        for (const key of /** @type {(keyof typeof got)[]} */ (Object.keys(got)))
        {
            if (got[key] !== expected[key])
            {
                // From the first character that differs, where a long value does.
                let from = 0;
                while (got[key][from] === expected[key][from])
                {
                    from++;
                }
                from = Math.max(0, from - 8);
                failures.push(`${one.text}: ${key} ${from ? `[${from}] ` : ''}`
                    + `${got[key].slice(from, from + 80)}`
                    + ` vs ${expected[key].slice(from, from + 80)}`);
            }
        }
    }
    return { failures, ends, byTier, handed };
}

/**
 * Every instruction of the corpus that leaves the stack, the pointer
 * registers, rbx, r12, r13 and r15 alone and neither jumps nor names RIP, as
 * its bytes: the pool the seeded programs draw from, as the long-mode
 * translator's gate draws its own.
 */
function pool(){
    const kept = new Set([3, 4, 5, 6, 7, 12, 13, 15]);
    const jumps = new Set(['jmp', 'call', 'ret', 'loop', 'loope', 'loopne', 'jecxz', 'push', 'pop',
        'leave', 'enter', 'pushf', 'popf', 'hlt', 'int', 'int3', 'ud2', 'cmpxchg8b', 'cmpxchg16b',
        'lods', 'stos', 'movs', 'cmps', 'scas']);
    /** @type {Set<string>} */
    const out = new Set();
    for (const one of CORPUS.cases)
    {
        const code = Buffer.from(one.code, 'hex');
        for (let at = 0; at < code.length;)
        {
            const instruction = decode(address=>code[address] ?? 0, at, MODE_64);
            if ('refused' in instruction)
            {
                break;
            }
            const { op, operands } = instruction;
            const writesKept = operands.some(operand=>operand.kind === 'reg'
                && kept.has(/** @type {number} */ (operand.reg))
                && (operand === operands[0] || op === 'xchg' || op === 'xadd'))
                && op !== 'cmp' && op !== 'test' && op !== 'bt';
            if (!jumps.has(op) && !op.startsWith('j') && !writesKept
                && !operands.some(operand=>operand.kind === 'mem' && operand.rip))
            {
                out.add(code.subarray(at, at + instruction.length).toString('hex'));
            }
            at += instruction.length;
        }
    }
    return [...out].sort().map(hex=>[...Buffer.from(hex, 'hex')]);
}

const POOL = pool();

/**
 * A seeded program from the pool: `count` instructions run three times by a
 * loop on r15, on a corpus case's registers and data.
 *
 * @param {number} seed @param {number} count
 */
function looped(seed, count){
    const next = random(seed);
    /** @type {number[]} */
    const body = [];
    for (let i = 0; i < count; i++)
    {
        body.push(...POOL[next(POOL.length)]);
    }
    const back = -(body.length + 3 + 6);
    const one = CORPUS.cases[next(CORPUS.cases.length)];
    const regs = [...one.regs];
    if ((seed & 1) !== 0)
    {
        for (const index of [0, 1, 2, 8, 9, 10, 11, 14])
        {
            regs[index] = next(4).toString(16);
        }
    }
    regs[15] = '3';
    const code = Buffer.from([...body, 0x41, 0xff, 0xcf, 0x0f, 0x85, ...le32(back)]);
    return { ...one, text: `looped ${seed}`, code: code.toString('hex'), regs };
}

/**
 * A seeded program of nested control flow over the pool: runs of it, a run
 * jumped over when a condition holds, loops on r12 and r13 of one to three
 * turns, a loop left from its middle and one entered past its head.
 *
 * @param {number} seed
 */
function nested(seed){
    const next = random(seed);
    /** @param {number} length */
    const jcc = length=>[0x0f, 0x80 + next(16), ...le32(length)];
    /** @param {number} depth @returns {number[]} */
    const body = depth=>{
        /** @type {number[]} */
        const parts = [];
        for (let item = 1 + next(4); item > 0; item--)
        {
            const kind = next(4);
            if (kind === 1)
            {
                const over = body(depth + 1);
                parts.push(...jcc(over.length), ...over);
            }
            else if (kind === 2 && depth < 2)
            {
                const counter = depth === 0 ? 0xc : 0xd;
                const first = body(depth + 1);
                let second = body(depth + 1);
                if (next(3) === 0)
                {
                    second = [...jcc(second.length + 3 + 6), ...second];
                }
                parts.push(0x41, 0xb8 + counter - 8, ...le32(1 + next(3)));
                if (next(3) === 0)
                {
                    parts.push(...jcc(first.length));
                }
                parts.push(...first, ...second, 0x41, 0xff, 0xc0 + counter, 0x0f, 0x85,
                    ...le32(-(first.length + second.length + 3 + 6)));
            }
            else
            {
                for (let n = 1 + next(3); n > 0; n--)
                {
                    parts.push(...POOL[next(POOL.length)]);
                }
            }
        }
        return parts;
    };
    const code = body(0).slice(0, 0xb000);
    const one = CORPUS.cases[next(CORPUS.cases.length)];
    return { ...one, text: `nested ${seed}`, code: Buffer.from(code).toString('hex'),
        regs: [...one.regs] };
}

/** Quadwords on the edges a product, a quotient or a conversion turns on. */
const EDGES64 = [0n, 1n, 2n, 3n, 0x7fn, 0x80n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn,
    0x8000000000000000n, 0xffffffffffffffffn, 0xfffffffffffffffen, 0x123456789abcdef0n,
    0xfedcba9876543210n, 0x0000000080000000n, 0xffffffff80000000n, 1n << 53n, (1n << 53n) + 1n,
    (1n << 54n) + 3n, (1n << 24n) + 1n, 0x4330000000000000n, 0x43e0000000000000n,
    0xc3e0000000000000n, 0x7ff8000000000000n, 0x3fe0000000000000n, 0xbff8000000000000n];

/**
 * A program of the forms long mode changes, in a code area of its own making:
 * a jump to its main part past the subroutines it calls, every form below
 * drawn at random among the pool's instructions, and the runner's exit.
 *
 * @param {number} seed
 */
function forms(seed){
    const next = random(seed);
    const one = CORPUS.cases[next(CORPUS.cases.length)];
    /** @type {number[]} */
    const code = [];
    const at = ()=>CODE + code.length;
    /** An instruction whose RIP-relative operand names `target`, `tail` bytes after it. */
    const rip = (/** @type {number[]} */ head, /** @type {number} */ target,
        /** @type {number[]} */ tail = [])=>
    {
        const end = at() + head.length + 4 + tail.length;
        code.push(...head, ...le32(target - end), ...tail);
    };
    const pick = (/** @type {any[]} */ list)=>list[next(list.length)];
    const edge = ()=>(next(3) === 0 ? BigInt(next(0x10000)) << BigInt(next(48))
        : pick(EDGES64) ^ (next(4) === 0 ? BigInt(next(256)) : 0n));
    const imm8 = ()=>next(256);
    const d8 = ()=>(next(0x100) - 0x80) & 0xff;
    /** A slot, now and then not aligned to sixteen. */
    const slot = ()=>SLOTS + (next(16) === 0 ? next(0xf00) : next(0xf0) * 16);
    /** A displacement from rbx, now and then not aligned to sixteen. */
    const d16 = ()=>(next(16) === 0 ? d8() : (next(16) - 8) * 16 & 0xff);
    const poolRun = (/** @type {number} */ count)=>{
        for (let i = 0; i < count; i++)
        {
            code.push(...POOL[next(POOL.length)]);
        }
    };
    // jmp main, patched once the subroutines are laid down.
    code.push(0xe9, 0, 0, 0, 0);
    /** @type {{ at: number, release: number }[]} */
    const subs = [];
    for (let i = 1 + next(3); i > 0; i--)
    {
        const release = next(2) * 8;
        subs.push({ at: at(), release });
        poolRun(next(4));
        code.push(...(release ? [0xc2, release, 0] : [0xc3]));
    }
    code.splice(1, 4, ...le32(at() - (CODE + 5)));
    // The case's registers: rbx, rbp, rsi and rdi into the data, sixteen-byte aligned,
    // r12 and r13 small indexes, rsp near the data's top; the pool's operands use them.
    const [rsi, rdi] = [6, 7].map(index=>BigInt(`0x${one.regs[index]}`));
    if (next(2) === 0)
    {
        code.push(0xdb, 0xe3);
    }
    /** Each a form, emitted where the program stands. @type {(() => void)[]} */
    const steps = [
        // Dword writes zero-extend a pointer register's high half away; a byte or a word's
        // do not.
        ()=>{
            const reg = pick([6, 7]);
            code.push(0x48, 0xb8 + reg, ...le64(BigInt(DATA + next(0x1000))
                | BigInt(next(4) === 0 ? 0 : 1 + next(255)) << 40n));
            code.push(...pick([[0x89, 0xc0 | reg << 3 | reg], [0x8d, 0x40 | reg << 3 | reg, 0],
                [0x87, 0xc0 | reg << 3 | reg], [0x83, 0xc0 | reg, 0],
                [0x0f, 0x44, 0xc0 | reg << 3 | reg],
                [0x0f, 0x45, 0xc0 | reg << 3 | reg], [0xc1, 0xe0 | reg, 0],
                [0x0f, 0xa4, 0xc0 | reg << 3 | reg, 0],
                ...next(8) === 0 ? [[0x66, 0x89, 0xc0 | reg << 3 | reg],
                    [0x40, 0x88, 0xc0 | reg << 3 | reg]]
                    : []]));
            code.push(0x48, 0x8b, reg);
        },
        // The window: an access at or past 4 GiB faults however its low half reads.
        ()=>{
            if (next(24) !== 0)
            {
                return;
            }
            const address = pick([(1n << 32n) + BigInt(DATA + next(0x1000)), 0xfffffffcn,
                0xffffffffn, -8n & 0xffffffffffffffffn, (1n << 32n) + BigInt(CODE)]);
            code.push(0x48, 0xb8, ...le64(address));
            code.push(...pick([[0x48, 0x8b, 0x00], [0x89, 0x08], [0xff, 0xe0], [0x0f, 0x10, 0x00],
                [0xdd, 0x00], [0x48, 0x87, 0x08], [0xff, 0x30]]));
        },
        ()=>{
            // moffs: an eight-byte address, in the data or past the window.
            const address = next(40) === 0 ? (1n << 32n) + BigInt(DATA)
                : BigInt(DATA + next(0x1ff0));
            code.push(...pick([[0x48, 0xa1], [0xa1], [0xa0], [0x48, 0xa3], [0xa2], [0x66, 0xa3]]),
                ...le64(address));
            code.push(0x64, 0x48, 0xa1, ...le64(BigInt(next(0x1ff8))));
        },
        // RIP-relative operands, an immediate after some.
        ()=>{
            const [head, tail] = pick([
                [[0x80, 0x3d], [imm8()]], [[0x48, 0x83, 0x05], [imm8()]],
                [[0xc7, 0x05], le32(next(0x7fffffff))],
                [[0x48, 0xc7, 0x05], le32(next(0x7fffffff))],
                [[0x66, 0xc7, 0x05], [imm8(), imm8()]],
                [[0x48, 0x69, 0x05], le32(next(0x7fffffff))],
                [[0x0f, 0xba, 0x2d], [imm8()]], [[0xc1, 0x25], [imm8()]], [[0xf6, 0x05], [imm8()]],
                [[0x48, 0xf7, 0x05], le32(next(0x7fffffff))], [[0x0f, 0xa4, 0x05], [imm8()]],
                [[0x48, 0x8b, 0x05], []], [[0x4c, 0x03, 0x05], []], [[0x48, 0x89, 0x05], []],
                [[0x66, 0x0f, 0x70, 0x05], [imm8()]], [[0x0f, 0xc2, 0x05], [next(8)]],
                [[0x66, 0x0f, 0xc4, 0x05], [imm8()]], [[0x0f, 0xc6, 0x05], [imm8()]],
                [[0x66, 0x44, 0x0f, 0x6f, 0x05], []], [[0xf3, 0x0f, 0x6f, 0x05], []],
                [[0xdd, 0x05], []], [[0xd9, 0x1d], []], [[0xdf, 0x2d], []],
                [[0x48, 0x63, 0x05], []], [[0x65, 0x48, 0x8b, 0x05], []],
            ]);
            rip(head, slot(), tail);
        },
        // Segments: FS and GS have bases; lea leaves them out.
        ()=>code.push(...pick([[0x64, 0x48, 0x8b, 0x04, 0x25, ...le32(next(0x1ff8))],
            [0x65, 0x48, 0x89, 0x8b, ...le32(0x1000 + next(0x100) - 0x80)],
            [0x64, 0x48, 0x8d, 0x43, d8()],
            [0x65, 0x8b, 0x83, ...le32(0x1000 + next(0x100) - 0x80)], [0x26, 0x64, 0x8b, 0x04, 0x25,
                ...le32(next(0x1ff8))]])),
        // Stack operations of a quadword and of a word, pop to memory, enter (left).
        ()=>code.push(...pick([[0x41, 0x51, 0x58], [0x68, ...le32(next(0x100000000) | 0), 0x59],
            [0x6a, imm8(), 0x41, 0x58], [0xff, 0x73, d8(), 0x5a], [0x9c, 0x58], [0x50, 0x9d],
            [0x41, 0x51, 0x8f, 0xc0], [0x66, 0x50, 0x66, 0x58], [0x55, 0x48, 0x89, 0xe5, 0x6a, 7,
                0xc9], [0xc8, 16, 0, 0, 0xc9], [0x48, 0x83, 0xec, 8, 0x8f, 0x04, 0x24],
            [0x9c, 0x48, 0x81, 0x34, 0x24, ...le32(0x8d5), 0x9d], [0x66, 0x9c, 0x66, 0x9d],
            [0x66, 0x6a, imm8(), 0x66, 0x41, 0x5a], [0x66, 0x68, imm8(), imm8(), 0x66, 0x8f, 0xc1],
            [0x66, 0xff, 0x73, d8(), 0x66, 0x41, 0x5b],
            [0x41, 0x51, 0x8f, 0x43, d8()], [0x6a, imm8(), 0x8f, 0x44, 0x24, 0xf8],
            [0x66, 0x41, 0x51, 0x66, 0x8f, 0x43, d8()],
            [0x50, 0x65, 0x8f, 0x83, ...le32(0x1000)]])),
        // Immediates and sign extension.
        ()=>{
            const reg = pick([0, 1, 2, 8, 9, 10, 11, 14]);
            code.push(...pick([[0x48 | reg >> 3, 0xb8 + (reg & 7), ...le64(edge())],
                [...reg >= 8 ? [0x41] : [], 0xb8 + (reg & 7), ...le32(next(0x100000000))],
                [0x66, ...reg >= 8 ? [0x41] : [], 0xb8 + (reg & 7), imm8(), imm8()],
                [0x48, 0x98], [0x98], [0x66, 0x98], [0x48, 0x99], [0x99], [0x66, 0x99],
                [0x48, 0x63, 0xc1], [0x63, 0xc1], [0x66, 0x63, 0xc1], [0x48, 0x0f, 0xbe, 0xc1],
                [0x48, 0x0f, 0xbf, 0xc1], [0x0f, 0xb7, 0xc1], [0x48, 0x63, 0x43, d8()],
                [0x40, 0x88, 0xf0], [0x40, 0x00, 0xf8], [0x88, 0xe0], [0x40, 0x88, 0xe0],
                [0x45, 0x30, 0xc1], [0x40, 0x86, 0xc6], [0x41, 0xb0, imm8()], [0xb4, imm8()],
                [0x40, 0xb6, imm8()], [0x40, 0x80, 0xc6, imm8()], [0x86, 0xc4], [0x9e], [0x9f]]));
        },
        // Carry chains through an operand of all ones, where the carry in decides the carry out.
        ()=>{
            code.push(pick([0xf8, 0xf9]), 0x48, 0xc7, 0xc1, 0xff, 0xff, 0xff, 0xff);
            code.push(...pick([[0x48, 0x83, 0xd0, 0xff], [0x48, 0x83, 0xd8, 0xff],
                [0x83, 0xd0, 0xff],
                [0x66, 0x83, 0xd8, 0xff], [0x14, 0xff], [0x1c, 0xff], [0x48, 0x11, 0xc8],
                [0x48, 0x19, 0xc8],
                [0x48, 0x11, 0x4b, d8()], [0x4c, 0x1b, 0xc1]]));
            code.push(...pick([[0x0f, 0x92, 0xc1], [0x0f, 0x90, 0xc1], [0x9c, 0x59],
                [0x73, 0x00]]));
        },
        // Products and quotients of quadwords, on the edges.
        ()=>{
            // A divisor of zero, and a high half past it, now and then.
            const divisor = next(16) === 0 ? 0n : edge() | 1n;
            code.push(0x48, 0xb8, ...le64(edge()), 0x48, 0xba, ...le64(next(16) === 0 ? edge()
                : BigInt(next(8) === 0 ? 1 : 0)), 0x48, 0xb9, ...le64(divisor));
            code.push(...pick([[0x48, 0xf7, 0xe1], [0x48, 0xf7, 0xe9], [0x48, 0xf7, 0xf1],
                [0x48, 0xf7, 0xf9], [0x48, 0x0f, 0xaf, 0xc1],
                [0x48, 0x69, 0xc1, ...le32(next(0x100000000))],
                [0x48, 0x6b, 0xc1, imm8()], [0xf7, 0xf1], [0xf7, 0xf9], [0xf7, 0xe1], [0xf7, 0xe9],
                [0x66, 0xf7, 0xf1], [0xf6, 0xf9], [0x48, 0xf7, 0x63, d8()],
                [0x48, 0xf7, 0x7b, d8()]]));
        },
        // Shifts and rotates by every count, a zero one among them.
        ()=>{
            code.push(0xb1, pick([0, 1, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, imm8()]));
            const ext = next(8);
            code.push(...pick([[0x48, 0xd3, 0xc0 | ext << 3], [0xd3, 0xc0 | ext << 3],
                [0x66, 0xd3, 0xc0 | ext << 3], [0x41, 0xd2, 0xc0 | ext << 3 | 1],
                [0x48, 0xc1, 0xc0 | ext << 3, imm8()], [0x48, 0xd1, 0xc0 | ext << 3],
                [0x48, 0xd3, 0x43 | ext << 3, d8()], [0x48, 0x0f, 0xa5, 0xd0],
                [0x48, 0x0f, 0xad, 0xd0],
                [0x0f, 0xa5, 0xd0], [0x66, 0x0f, 0xa5, 0xd0], [0x66, 0x0f, 0xad, 0xd0],
                [0x48, 0x0f, 0xa4, 0xd0, imm8()], [0x66, 0x0f, 0xac, 0xd0, imm8()],
                [0x48, 0x0f, 0xa5, 0x53, d8()]]));
        },
        // Bit tests at a quadword, a register's signed offset reaching past the operand.
        ()=>{
            code.push(0x48, 0xc7, 0xc0, ...le32(next(1200) - 600));
            code.push(...pick([[0x48, 0x0f, 0xa3, 0x43, d8()], [0x48, 0x0f, 0xab, 0x43, d8()],
                [0x0f, 0xb3, 0x43, d8()], [0x66, 0x0f, 0xbb, 0x43, d8()],
                [0x48, 0x0f, 0xba, 0xe9, imm8()],
                [0x48, 0x0f, 0xba, 0x6b, d8(), imm8()], [0x48, 0x0f, 0xa3, 0xc1],
                [0xf0, 0x48, 0x0f, 0xab, 0x43, d8()]]));
        },
        // bsf, bsr and popcnt, a zero source among them; cmov, setcc, cmpxchg, xadd, xchg.
        ()=>{
            if (next(2) === 0)
            {
                code.push(0x31, 0xc9);
            }
            code.push(0x48, 0xb8 + 2, ...le64(edge()));
            code.push(...pick([[0x48, 0x0f, 0xbc, 0xc1], [0x0f, 0xbd, 0xc1],
                [0x48, 0x0f, 0xbd, 0xd1],
                [0x66, 0x0f, 0xbc, 0xd1], [0xf3, 0x48, 0x0f, 0xb8, 0xc1],
                [0x66, 0xf3, 0x0f, 0xb8, 0xd1],
                [0xf3, 0x0f, 0xb8, 0x43, d8()], [0xf3, 0x48, 0x0f, 0xbc, 0xc1],
                [0x39, 0xc0, 0x0f, 0x45, 0xc2], [0x48, 0x0f, 0x40 + next(16), 0xc2],
                [0x0f, 0x40 + next(16), 0x43, d8()], [0x0f, 0x90 + next(16), 0xc0],
                [0x40, 0x0f, 0x90 + next(16), 0xc6], [0x41, 0x0f, 0x90 + next(16), 0xc1],
                [0x48, 0x0f, 0xb1, 0xd1], [0x0f, 0xb1, 0xd1], [0xf0, 0x48, 0x0f, 0xb1, 0x53, d8()],
                [0x0f, 0xb1, 0x53, d8()], [0x48, 0x0f, 0xc1, 0xd1],
                [0xf0, 0x48, 0x0f, 0xc1, 0x53, d8()],
                [0x87, 0xc0], [0x48, 0x87, 0xc1], [0x41, 0x90], [0x48, 0x90], [0xf3, 0x90],
                [0x87, 0x4b, d8()], [0x0f, 0xc7, 0x4b, d8()], [0x48, 0x0f, 0xc7, 0x4b, d8() & 0xf0],
                [0x48, 0x0f, 0xc8], [0x0f, 0xc9], [0x49, 0x0f, 0xca], [0xf5], [0xf8], [0xf9]]));
        },
        // Repeated strings either way, a fault partway now and then.
        ()=>{
            const source = 0x80 + next(0x1e00);
            const target = 0x80 + next(0x1e00);
            code.push(0x48, 0x8d, 0xb3, ...le32(source - 0x400), 0x48, 0x8d, 0xbb,
                ...le32(target - 0x400));
            code.push(0xb9, ...le32(next(5) === 0 ? 0 : 1 + next(next(4) === 0 ? 600 : 40)));
            code.push(next(3) === 0 ? 0xfd : 0xfc);
            const width = pick([[], [0x66], [0x48]]);
            const repeat = pick([[], [0xf3], [0xf3], [0xf2]]);
            code.push(...pick([[], [], [], [0x67], [0x64]]), ...repeat, ...width,
                pick([0xa4, 0xa5, 0xa6, 0xa7, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf]), 0xfc);
            code.push(0x48, 0xbe, ...le64(rsi), 0x48, 0xbf, ...le64(rdi));
        },
        // Calls: relative, through a register, through memory; returns releasing bytes.
        ()=>{
            const sub = pick(subs);
            if (sub.release)
            {
                code.push(0x6a, imm8());
            }
            switch (next(3))
            {
                case 0:
                {
                    const end = at() + 5;
                    code.push(0xe8, ...le32(sub.at - end));
                    break;
                }
                case 1:
                    rip([0x4c, 0x8d, 0x1d], sub.at);
                    code.push(0x41, 0xff, 0xd3);
                    break;
                default:
                    rip([0x4c, 0x8d, 0x1d], sub.at);
                    code.push(0x4c, 0x89, 0x5b, 0x40, 0xff, 0x53, 0x40);
            }
        },
        // Jumps: over a run, through a register, through memory, and loops on rcx.
        ()=>{
            switch (next(4))
            {
                case 0:
                {
                    const length = next(6);
                    code.push(0x70 + next(16), length);
                    poolRun(0);
                    code.push(...Array.from({ length }, ()=>0x90));
                    break;
                }
                case 1:
                    rip([0x48, 0x8d, 0x05], at() + 7 + 2 + 3);
                    code.push(0xff, 0xe0, 0x0f, 0x0b, 0x90);
                    break;
                case 2:
                    // lea r11, [rip+L]; mov [rip+slot], r11; jmp [rip+slot]; ud2; L:
                    rip([0x4c, 0x8d, 0x1d], at() + 7 + 7 + 6 + 2);
                    rip([0x4c, 0x89, 0x1d], SLOTS + 0xff8);
                    rip([0xff, 0x25], SLOTS + 0xff8);
                    code.push(0x0f, 0x0b);
                    break;
                default:
                {
                    code.push(0xb9, ...le32(1 + next(3)));
                    const head = at();
                    code.push(0x48, 0x01, 0xd0);
                    const kind = pick([0xe2, 0xe1, 0xe0]);
                    code.push(kind, (head - (at() + 2)) & 0xff, 0xe3, 0x01, 0x90);
                }
            }
        },
        // x87 through REX and RIP-relative operands.
        ()=>{
            code.push(0x4c, 0x8d, 0x4b, d8() & 0xf8);
            code.push(...pick([[0x41, 0xdd, 0x01], [0x41, 0xd9, 0x41, 8], [0x41, 0xdf, 0x69, 8],
                [0x43, 0xdb, 0x04, 0x29]]));
            rip([0xdd, 0x05], slot());
            code.push(...pick([[0xde, 0xc1], [0xdb, 0xf1, 0xda, 0xc1, 0xdd, 0xd8], [0xdf, 0xf1],
                [0xd9, 0xc9, 0xde, 0xf9], [0xd8, 0xd1, 0xdf, 0xe0, 0xdd, 0xd8]]));
            code.push(0x41, 0xdd, 0x59, 0x10);
        },
        // SSE: XMM8-15, REX.W's quadword forms, MXCSR's rounding, alignment.
        ()=>{
            const mode = next(4);
            rip([0xc7, 0x05], SLOTS + 0xff0, le32(0x1f80 | mode << 13));
            rip([0x0f, 0xae, 0x15], SLOTS + 0xff0);
            code.push(0x48, 0xb9, ...le64(edge()));
            code.push(...pick([[0x66, 0x48, 0x0f, 0x6e, 0xc1], [0x66, 0x4c, 0x0f, 0x6e, 0xc1],
                [0x66, 0x49, 0x0f, 0x7e, 0xc0], [0x66, 0x48, 0x0f, 0x7e, 0xc8],
                [0xf2, 0x48, 0x0f, 0x2a, 0xc1],
                [0xf3, 0x48, 0x0f, 0x2a, 0xc1], [0xf2, 0x4c, 0x0f, 0x2a, 0xc1],
                [0xf3, 0x0f, 0x2a, 0xc1],
                [0xf2, 0x48, 0x0f, 0x2c, 0xc0], [0xf3, 0x48, 0x0f, 0x2d, 0xc0],
                [0xf2, 0x49, 0x0f, 0x2d, 0xc0],
                [0xf2, 0x48, 0x0f, 0x2d, 0x43, d8()], [0xf3, 0x48, 0x0f, 0x2c, 0x43, d8()],
                [0x66, 0x48, 0x0f, 0x7e, 0x43, d8()], [0x66, 0x48, 0x0f, 0x6e, 0x43, d8()],
                [0x0f, 0x28, 0x43, d16()], [0x0f, 0x10, 0x43, d8()],
                [0x66, 0x0f, 0xd1, 0x43, d16()],
                [0x66, 0x45, 0x0f, 0xfe, 0xc1], [0x45, 0x0f, 0x58, 0xc8],
                [0x66, 0x41, 0x0f, 0xd7, 0xc0],
                [0x66, 0x44, 0x0f, 0xc5, 0xc0, imm8()], [0x66, 0x4c, 0x0f, 0xc4, 0xc1, imm8()],
                [0x48, 0x0f, 0x6e, 0xc1], [0x0f, 0x6e, 0xc1], [0x41, 0x0f, 0x7e, 0xc0],
                [0x66, 0x0f, 0x7e, 0xc1], [0xf3, 0x44, 0x0f, 0x7e, 0x43, d8()]]));
        },
        // The address-size prefix: addresses cut to 32 bits, ecx counting.
        ()=>{
            code.push(...pick([[0x67, 0x48, 0x8b, 0x03], [0x67, 0x8d, 0x04, 0x19],
                [0x67, 0x41, 0x8d, 0x04, 0x00],
                [0x67, 0xa1, ...le32(DATA + next(0x1ff8))],
                [0x67, 0x48, 0xa3, ...le32(DATA + next(0x1ff8))],
                [0x67, 0xdd, 0x03], [0x67, 0x66, 0x0f, 0x6f, 0x03], [0x67, 0x0f, 0xb6, 0x43, d8()],
                [0x48, 0xb8, ...le64(BigInt(DATA) | 0xab00000000n), 0x67, 0x8b, 0x08]]));
            if (next(3) === 0)
            {
                rip([0x67, 0x48, 0x8b, 0x05], slot());
            }
            if (next(3) === 0)
            {
                code.push(0x48, 0xb9, ...le64(pick([0n, 1n, 0x100000000n, 0x100000002n])));
                code.push(...pick([[0x67, 0xe3, 1, 0x90], [0x67, 0xe2, 0], [0x67, 0xe1, 0],
                    [0x67, 0xe0, 0]]));
            }
        },
        // What the tier leaves: cpuid, xlat, a port not the trap's; and the trap port.
        ()=>code.push(...pick([[0xd7],
            [0x0f, 0xa2], [0xe6, 0x80], [0xba, ...le32(TRAP_PORT), 0xef], [0xba, ...le32(TRAP_PORT),
                0x48, 0xef], [0xba, ...le32(TRAP_PORT), 0xee]])),
        ()=>poolRun(1 + next(4)),
        ()=>poolRun(1 + next(4)),
    ];
    for (let i = 16 + next(64); i > 0; i--)
    {
        pick(steps)();
    }
    if (next(16) === 0)
    {
        code.push(0xf4);
    }
    return { ...one, text: `forms ${seed}`, code: Buffer.from(code).toString('hex'),
        regs: [...one.regs] };
}

test('the module is built from the source beside it', ()=>{
    const source = readFileSync(new URL('./interp-wasm.c', import.meta.url), 'utf8')
        .replaceAll('\r\n', '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), SOURCE_SHA256,
        'interp-wasm.c changed: run scripts/build-interp-wasm.mjs');
});

test('the tier does what the processor did on every corpus case', t=>{
    const m = machine();
    const model = machine();
    /** @type {string[]} */
    const failures = [];
    let compared = 0;
    let skipped = 0;
    let byTier = 0;
    let handed = 0;
    for (const one of CORPUS.cases)
    {
        load(model, one);
        const undefinedMask = flagsLeftUndefined(model.state, address=>model.bytes[address]);
        if (undefinedMask === null)
        {
            skipped++;
            continue;
        }
        load(m, one);
        const run = runTier(m, ()=>1000);
        byTier += run.retired - run.handed;
        handed += run.handed;
        compared++;
        const { view, layout, bytes } = m;
        const out = one.out;
        /** @type {string[]} */
        const differences = [];
        const [, vector, at] = /^(\d+)@(-?\d+)$/.exec(run.end) ?? [];
        const signal = vector === undefined ? 0 : SIGNAL[Number(vector)];
        if (signal !== out.signal || (vector === undefined ? undefined : Number(at)) !== out.at)
        {
            differences.push(`end ${run.end} vs signal ${out.signal}@${out.at}`);
        }
        for (let i = 0; i < 16; i++)
        {
            const value = view.getBigUint64(layout.regs + i * 8, true).toString(16);
            if (value !== out.regs[i])
            {
                differences.push(`r${i} ${value} vs ${out.regs[i]}`);
            }
        }
        const mask = COMPARED & ~undefinedMask;
        const flags = view.getUint32(layout.eflags, true);
        if ((flags & mask) !== (out.flags & mask))
        {
            differences.push(`flags 0x${(flags & mask).toString(16)}`
                + ` vs 0x${(out.flags & mask).toString(16)}`);
        }
        const start = fill(one.seed ^ CORPUS.xmmSeed, 256);
        /** @type {Record<number, string>} */
        const xmm = {};
        for (let i = 0; i < 16; i++)
        {
            const register = bytes.subarray(layout.xmm + i * 16, layout.xmm + i * 16 + 16);
            if (register.some((value, j)=>value !== start[i * 16 + j]))
            {
                xmm[i] = Buffer.from(register).toString('hex');
            }
        }
        if (JSON.stringify(xmm) !== JSON.stringify(out.xmm))
        {
            differences.push(`xmm ${JSON.stringify(xmm)} vs ${JSON.stringify(out.xmm)}`);
        }
        const before = fill(one.seed, CORPUS.dataSize);
        /** @type {number[][]} */
        const writes = [];
        bytes.subarray(DATA, DATA + CORPUS.dataSize).forEach((value, i)=>{
            if (value !== before[i])
            {
                writes.push([i, value]);
            }
        });
        if (JSON.stringify(writes) !== JSON.stringify(out.writes))
        {
            differences.push(`memory ${JSON.stringify(writes)} vs ${JSON.stringify(out.writes)}`);
        }
        if (differences.length > 0)
        {
            failures.push(`${one.text}: ${differences.join(', ')}`);
        }
    }
    t.diagnostic(`${compared} cases compared, ${skipped} read a flag left undefined;`
        + ` ${byTier} instructions on the tier, ${handed} handed to interp64.js`);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${compared} cases differ`);
    assert.ok(compared >= CORPUS.cases.length * 0.9,
        `only ${compared} compared, ${skipped} skipped`);
    // A tier that left everything to interp64.js would pass and judge nothing.
    assert.ok(byTier > handed * 10, `${byTier} instructions on the tier, ${handed} handed back`);
});

test('seeded programs of the corpus\'s instructions run on the tier as on interp64.js', t=>{
    const programs = [];
    for (let seed = 1; seed <= SEEDS; seed++)
    {
        programs.push(looped(seed, 4 + seed % 24), nested(seed));
    }
    const { failures, ends, byTier, handed } = compare(programs);
    t.diagnostic(`${programs.length} programs, ended ${JSON.stringify(ends)};`
        + ` ${byTier} instructions on the tier, ${handed} handed to interp64.js`);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(byTier > handed * 10, `${byTier} instructions on the tier, ${handed} handed back`);
});

test('seeded programs of the forms long mode changes run on the tier as on interp64.js', t=>{
    const programs = [];
    for (let seed = 1; seed <= SEEDS * 2; seed++)
    {
        programs.push(forms(seed));
    }
    const { failures, ends, byTier, handed } = compare(programs);
    t.diagnostic(`${programs.length} programs, ended ${JSON.stringify(ends)};`
        + ` ${byTier} instructions on the tier, ${handed} handed to interp64.js`);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    // The programs mean something only if many run to their end and some fault.
    assert.ok((ends.exit ?? 0) + (ends.halt ?? 0) > programs.length / 4, JSON.stringify(ends));
    assert.ok((ends['13@'] ?? 0) > 0 && (ends['0@'] ?? 0) > 0, JSON.stringify(ends));
    assert.ok(byTier > handed * 5, `${byTier} instructions on the tier, ${handed} handed back`);
});

/**
 * A machine with `code` at CODE and the registers given (the others zero),
 * rsp at the data's top.
 *
 * @param {number[]} code @param {Record<number, bigint>} [regs]
 */
function directed(code, regs = {}){
    const m = machine();
    const registers = Array.from({ length: 16 }, (_, i)=>(regs[i] ?? 0n).toString(16));
    registers[4] = (DATA + 0x1f00).toString(16);
    load(m, { code: Buffer.from(code).toString('hex'), regs: registers, flags: 0, seed: 1 });
    const rip = ()=>Number(m.view.getBigUint64(m.layout.eip, true));
    /** @param {number} i */
    const reg = i=>m.view.getBigUint64(m.layout.regs + i * 8, true);
    return { ...m, rip, reg };
}

test('a 64-bit layout gets long mode\'s build and a 32-bit one the 32-bit build', ()=>{
    // mov rax, imm64; hlt -- REX.W B8 is a 32-bit dec eax and mov eax.
    const m = directed([0x48, 0xb8, ...le64(0x1122334455667788n), 0xf4]);
    assert.equal(m.tier.run(10), WasmExit.HALT);
    assert.equal(m.reg(0), 0x1122334455667788n);
    assert.equal(m.tier.retired(), 2);
    assert.equal(m.rip(), CODE + 11);
});

test('an instruction the tier does not run is left at RIP, unexecuted', ()=>{
    // inc rax; cpuid; hlt
    const m = directed([0x48, 0xff, 0xc0, 0x0f, 0xa2, 0xf4], { 0: 5n });
    assert.equal(m.tier.run(100), WasmExit.UNSUPPORTED);
    assert.equal(m.tier.retired(), 1);
    assert.equal(m.rip(), CODE + 3);
    assert.equal(m.reg(0), 6n);
    // A string's address-size prefix, enter, a lock on a register, five prefixes.
    for (const code of [[0x67, 0xf3, 0xa4], [0xc8, 8, 0, 0], [0xf0, 0x48, 0x01, 0xc8],
        [0x66, 0x66, 0x66, 0x66, 0x66, 0x90]])
    {
        const left = directed([...code, 0xf4], { 3: BigInt(DATA) });
        assert.equal(left.tier.run(100), WasmExit.UNSUPPORTED, Buffer.from(code).toString('hex'));
        assert.equal(left.rip(), CODE);
    }
});

test('an access reaching 4 GiB faults before its effect, RIP at the instruction', ()=>{
    // push rax; mov rcx, [rax] with rax 4 GiB past readable data: its low half reads.
    const m = directed([0x50, 0x48, 0x8b, 0x08, 0xf4], { 0: (1n << 32n) + BigInt(DATA) });
    assert.equal(m.tier.run(100), WasmExit.FAULT);
    assert.equal(m.tier.exitValue(), 13);
    assert.equal(m.tier.retired(), 1);
    assert.equal(m.rip(), CODE + 1);
    assert.equal(m.reg(1), 0n);
    assert.equal(m.reg(4), BigInt(DATA + 0x1f00 - 8));
    // A quadword at 2^32 - 4 crosses the window's end.
    const crossing = directed([0x48, 0x8b, 0x08, 0xf4], { 0: 0xfffffffcn });
    assert.equal(crossing.tier.run(100), WasmExit.FAULT);
    // Code past the window is the host's to fetch.
    const jump = directed([0xff, 0xe0], { 0: (1n << 32n) + BigInt(CODE) });
    assert.equal(jump.tier.run(100), WasmExit.UNSUPPORTED);
    assert.equal(jump.rip(), 2 ** 32 + CODE);
    assert.equal(jump.tier.retired(), 1);
    // A quotient past a quadword: #DE at the div.
    const divide = directed([0x48, 0xf7, 0xf1, 0xf4], { 0: 1n, 1: 2n, 2: 2n });
    assert.equal(divide.tier.run(100), WasmExit.FAULT);
    assert.equal(divide.tier.exitValue(), 0);
    assert.equal(divide.rip(), CODE);
});

test('a RIP-relative operand counts from the end of the immediate after it', ()=>{
    // cmp byte [rip + 1], 0x5a; hlt; then the byte compared (0x5a): equal, so ZF.
    const m = directed([0x80, 0x3d, ...le32(1), 0x5a, 0xf4, 0x5a]);
    assert.equal(m.tier.run(100), WasmExit.HALT);
    assert.equal(m.view.getUint32(m.layout.eflags, true) & ZF, ZF);
    // add qword [rip + 1], 1; hlt; then the quadword.
    const add = directed([0x48, 0x83, 0x05, ...le32(1), 0x01, 0xf4, ...le64(41n)]);
    assert.equal(add.tier.run(100), WasmExit.HALT);
    assert.equal(add.view.getBigUint64(CODE + 9, true), 42n);
});

test('a store into translated code leaves after it, naming where it landed', ()=>{
    // mov [rbx+8], rax; mov [rbx+0x40], rax; hlt -- the page's code is at 0x40..0x5f.
    const m = directed([0x48, 0x89, 0x43, 0x08, 0x48, 0x89, 0x43, 0x40, 0xf4], { 3: BigInt(DATA) });
    m.table.markCode(DATA + 0x40, 0x20);
    assert.equal(m.tier.run(100), WasmExit.CODE_WRITE);
    assert.equal(m.tier.retired(), 2);
    assert.equal(m.tier.exitValue(), DATA + 0x40);
    assert.equal(m.tier.exitSize(), 8);
    assert.equal(m.rip(), CODE + 8);
});

test('a jump\'s target is counted, noted hot, and one the entry hash holds leaves', ()=>{
    // mov ecx, 40; L: dec rcx; jnz L; hlt
    const m = directed([0xb9, 40, 0, 0, 0, 0x48, 0xff, 0xc9, 0x75, 0xfb, 0xf4]);
    /** @type {number[]} */
    const noted = [];
    for (;;)
    {
        const code = m.tier.run(1000);
        if (code === WasmExit.HOT)
        {
            assert.equal(m.rip(), CODE + 5);
            noted.push(m.tier.exitValue());
            continue;
        }
        assert.equal(code, WasmExit.HALT);
        break;
    }
    assert.deepEqual(noted, [2, 4, 8, 16, 32]);
    assert.equal(m.tier.hotCounts[((CODE + 5) >>> 2) & (HOT_SLOTS - 1)], 39);
    assert.equal(m.tier.starts[(m.tier.startIndex() - 1) & 255], CODE + 5);
    // jmp +2; nop; nop; hlt -- the target has an entry.
    const entry = directed([0xeb, 0x02, 0x90, 0x90, 0xf4]);
    const target = CODE + 4;
    const slot = Math.imul(target, 0x9e3779b1) >>> (entry.layout.hashShift ?? 16);
    entry.view.setUint32(entry.layout.tables + Tables.HASH + slot * Tables.HASH_SLOT, target, true);
    assert.equal(entry.tier.run(100), WasmExit.ENTRY);
    assert.equal(entry.rip(), target);
});

test('the trap port leaves after the write with the value, another port is left', ()=>{
    // mov eax, 42; mov edx, 0xb077; out dx, eax; out 0x80, al; hlt
    const m = directed([0xb8, 42, 0, 0, 0, 0xba, ...le32(TRAP_PORT), 0xef, 0xe6, 0x80, 0xf4]);
    assert.equal(m.tier.run(100), WasmExit.TRAP);
    assert.equal(m.tier.exitValue(), 42);
    assert.equal(m.rip(), CODE + 11);
    assert.equal(m.tier.run(100), WasmExit.UNSUPPORTED);
    assert.equal(m.rip(), CODE + 11);
});

test('the flag record translated long-mode code leaves is folded by the host first', ()=>{
    // setc al; hlt
    const m = machine();
    load(m, { code: '0f92c0f4', regs: Array(16).fill('0'), flags: 0, seed: 1 });
    let folded = 0;
    const tier = createWasmInterpreter({ memory: m.memory, layout: m.layout, area: m.area,
        hotThreshold: 2, statics: m.layout.regs + WASM_INTERPRETER_STATICS_AT, parkBase: 0,
        fold: ()=>{
            folded++;
            m.view.setUint32(m.layout.eflags, 0x203, true);
        } });
    assert.ok(tier);
    assert.equal(tier.run(100), WasmExit.HALT);
    assert.equal(folded, 1);
    assert.equal(m.view.getUint8(m.layout.regs), 1, 'the folded CF');
});

test('the entry translated code calls counts its target, runs and adds to the counter', ()=>{
    // jmp +2; nop; nop; mov eax, 3; hlt -- the target has an entry, so a run from the
    // start stops there, the jump retired.
    const m = directed([0xeb, 0x02, 0x90, 0x90, 0xb8, 3, 0, 0, 0, 0xf4]);
    const target = CODE + 4;
    const slot = Math.imul(target, 0x9e3779b1) >>> (m.layout.hashShift ?? 16);
    m.view.setUint32(m.layout.tables + Tables.HASH + slot * Tables.HASH_SLOT, target, true);
    const enter = m.tier.entry();
    m.view.setUint32(m.layout.counter, 100, true);
    assert.equal(enter(1000), WasmExit.ENTRY | 1 << 8);
    assert.equal(m.rip(), target);
    assert.equal(m.view.getUint32(m.layout.counter, true), 101);
    // Counted again, the start is hot: back at once, nothing run.
    m.view.setBigUint64(m.layout.eip, BigInt(CODE), true);
    assert.equal(enter(1000), WasmExit.HOT);
    assert.equal(m.rip(), CODE);
    // A start past the window is no tier's.
    m.view.setBigUint64(m.layout.eip, (1n << 32n) + BigInt(CODE), true);
    assert.equal(enter(1000), 0);
    m.view.setBigUint64(m.layout.eip, BigInt(target), true);
    assert.equal(enter(1000), WasmExit.HOT);
    assert.equal(enter(1000), WasmExit.HALT | 2 << 8);
    assert.equal(m.reg(0), 3n);
    assert.equal(m.view.getUint32(m.layout.counter, true), 103);
});
