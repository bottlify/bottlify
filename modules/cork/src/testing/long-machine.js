/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The long-mode translator's test harness: a machine over the hardware
 * corpus's areas (`x64-corpus.json.gz`), its cases and seeded programs run as
 * translated regions and on the interpreter alone, and what a program can see
 * compared (`compare`). The suites in `runtime/runtime64*.itest.js` and
 * `emit/width64.itest.js` share it.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ownLayout, pageFlagsAt, pagesFor, tablesSize } from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { blockState64, interpret64 } from '../interp64.js';
import { MODE_64, decode } from '../decode/decoder.js';
import { createRuntimeRunner64 } from './runtime-runner64.js';
import {
    WASM_INTERPRETER_AREA, WASM_INTERPRETER_STATICS_AT, createWasmInterpreter,
} from '../interp-wasm.js';
import { translatesLong } from '../emit/long-ops.js';

export const CORPUS = JSON.parse(gunzipSync(readFileSync(new URL('../x64-corpus.json.gz',
    import.meta.url))).toString('utf8'));
/** CF, PF, AF, ZF, SF and OF. */
export const STATUS = 0x8d5;
/** The flags a case is compared on: the status flags and DF. */
export const COMPARED = STATUS | 0x400;
/** Where the runner's exit jump goes: a closed page, whose fetch ends the case. */
export const EXIT = 0x1f000000;

/** @param {number} seed @param {number} size */
export function fill(seed, size){
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
 * @typedef {(memory: WebAssembly.Memory, layout: any, tier: any) => any} MakeRunner  the
 *     translator a machine runs: the shared runtime's (`runtime-runner64.js`) unless
 *     another is named (`shared-runner64.js`, the emitter alone)
 */

/**
 * A machine with the corpus's data and code areas open and every other page closed.
 *
 * @param {{ config?: Record<string, unknown>, trapPort?: number, tiered?: boolean,
 *     makeRunner?: MakeRunner | null, ramSize?: number }} [options]  `config`: the runtime's
 *     settings over the runner's; `tiered`: what no region holds runs on the interpreter tier
 *     in wasm (`createWasmInterpreter`), `interp64.js` taking what it hands back; `ramSize`:
 *     the RAM past the code area, 1 GiB for one a power of two (the translator's reads
 *     wrapped with one `and`, a struct's field reads off one wrapped sum)
 */
export function machine({ config = {}, trapPort = undefined, tiered = false,
    makeRunner = null, ramSize = CORPUS.codeAt + 0x100000 } = {})
{
    const layout = ownLayout({ ramSize, ramBase: 0, bits: 64 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout,
        tablesSize(layout) + (tiered ? WASM_INTERPRETER_AREA : 0)) });
    const flags = new Uint8Array(memory.buffer, pageFlagsAt(layout), 1 << 20);
    flags.fill(PageFlag.INACCESSIBLE);
    for (const [at, size] of [[CORPUS.dataAt, CORPUS.dataSize], [CORPUS.codeAt, CORPUS.codeSize]])
    {
        flags.fill(0, at >>> 12, (at + size) >>> 12);
    }
    const tier = tiered ? createWasmInterpreter({ memory, layout,
        area: layout.tables + tablesSize(layout),
        statics: layout.regs + WASM_INTERPRETER_STATICS_AT, hotThreshold: 1, trapPort,
        parkBase: 0 }) : null;
    const runner = makeRunner !== null ? makeRunner(memory, layout, tier)
        : createRuntimeRunner64({ memory, layout, tier,
            config: { ...config, ...(trapPort === undefined ? {} : { trapPort }) } });
    /** The writes to ports other than the trap port, each port and value. @type {number[][]} */
    const writes = [];
    const ports = trapPort === undefined ? undefined : {
        trapPort,
        read: ()=>0xffffffff,
        /** @param {number} port @param {number} size @param {number} value */
        write: (port, size, value)=>writes.push([port, size, value]),
    };
    const state = blockState64({ memory, layout, ports,
        onCodeWrite: (at, size)=>runner.invalidate(at, size) });
    return { layout, memory, state, runner, writes, view: new DataView(memory.buffer) };
}

/**
 * Every instruction of the corpus the translator takes that leaves the
 * stack, the pointer and index registers and r15 alone, as its bytes: the
 * pool the seeded programs are drawn from.
 */
export function pool(){
    const kept = new Set([3, 4, 5, 6, 7, 12, 13, 15]);
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
            // Both operands of an exchange are written, and leave writes rsp and rbp.
            const writesKept = op === 'leave' || operands.some(operand=>operand.kind === 'reg'
                && kept.has(/** @type {number} */ (operand.reg))
                && (operand === operands[0] || op === 'xchg' || op === 'xadd'))
                && op !== 'cmp' && op !== 'test' && op !== 'bt';
            if (translatesLong(instruction) && !endsBlock(op) && op !== 'push' && op !== 'pop'
                && !writesKept && !operands.some(operand=>operand.kind === 'mem' && operand.rip))
            {
                out.add(code.subarray(at, at + instruction.length).toString('hex'));
            }
            at += instruction.length;
        }
    }
    return [...out].map(hex=>Buffer.from(hex, 'hex'));
}

/**
 * A seeded program from the pool: `count` instructions run three times by a
 * loop on r15 (`dec r15d; jnz` back to the start), set up on a corpus case's
 * registers and data.
 *
 * @param {Buffer[]} instructions @param {number} seed @param {number} count
 */
export function program(instructions, seed, count){
    let x = seed >>> 0 || 1;
    const next = ()=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x;
    };
    /** @type {Buffer[]} */
    const parts = [];
    for (let i = 0; i < count; i++)
    {
        parts.push(instructions[next() % instructions.length]);
    }
    const body = Buffer.concat(parts);
    const back = -(body.length + 3 + 6);
    const loop = Buffer.from([0x41, 0xff, 0xcf, 0x0f, 0x85, back & 0xff, back >>> 8 & 0xff,
        back >>> 16 & 0xff, back >>> 24 & 0xff]);
    const one = CORPUS.cases[next() % CORPUS.cases.length];
    const regs = [...one.regs];
    if ((seed & 1) !== 0)
    {
        // Small values in the registers no address uses: equal operands, zero
        // results and borrows of one, which random quadwords almost never give.
        for (const index of [0, 1, 2, 8, 9, 10, 11, 14])
        {
            regs[index] = (next() & 3).toString(16);
        }
    }
    regs[15] = '3';
    const code = Buffer.concat([body, loop]).toString('hex');
    return { ...one, text: `program ${seed}`, code, regs };
}

/**
 * A seeded program of nested control flow over the pool's instructions:
 * runs of them, a run jumped over when a condition holds, and loops on r12
 * and r13 (which the pool leaves alone) of one to three turns, a loop now
 * and then left from its middle past its jump back, and entered past its
 * head from before it -- a way into its middle, which makes it no natural
 * loop. Every jump is a rel32.
 *
 * @param {Buffer[]} instructions @param {number} seed
 */
export function nested(instructions, seed){
    let x = seed >>> 0 || 1;
    const next = ()=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x;
    };
    /** @param {number} value */
    const rel = value=>{
        const bytes = Buffer.alloc(4);
        bytes.writeInt32LE(value);
        return bytes;
    };
    /** A conditional jump over `length` bytes. @param {number} length */
    const jcc = length=>Buffer.concat([Buffer.from([0x0f, 0x80 + next() % 16]), rel(length)]);
    /** @param {number} depth @returns {Buffer} */
    const body = depth=>{
        /** @type {Buffer[]} */
        const parts = [];
        for (let item = 1 + next() % 4; item > 0; item--)
        {
            const kind = next() % 4;
            if (kind === 1)
            {
                const over = body(depth + 1);
                parts.push(jcc(over.length), over);
            }
            else if (kind === 2 && depth < 2)
            {
                // mov r12d/r13d, turns; [jcc into the middle]; head: first; middle: second;
                // dec r12d/r13d; jnz head
                const counter = depth === 0 ? 0xc : 0xd;
                const first = body(depth + 1);
                let second = body(depth + 1);
                if (next() % 3 === 0)
                {
                    // A way out of the loop past its jump back.
                    second = Buffer.concat([jcc(second.length + 3 + 6), second]);
                }
                const turns = 1 + next() % 3;
                parts.push(Buffer.from([0x41, 0xb8 + counter - 8]), rel(turns));
                if (next() % 3 === 0)
                {
                    parts.push(jcc(first.length));
                }
                parts.push(first, second, Buffer.from([0x41, 0xff, 0xc0 + counter]));
                parts.push(Buffer.from([0x0f, 0x85]),
                    rel(-(first.length + second.length + 3 + 6)));
            }
            else
            {
                for (let n = 1 + next() % 3; n > 0; n--)
                {
                    parts.push(instructions[next() % instructions.length]);
                }
            }
        }
        return Buffer.concat(parts);
    };
    const code = body(0).subarray(0, CORPUS.codeSize - 64);
    const one = CORPUS.cases[next() % CORPUS.cases.length];
    return { ...one, text: `nested ${seed}`, code: code.toString('hex'), regs: [...one.regs] };
}

/**
 * A seeded program of the stack's traffic among the pool's instructions:
 * pushes of registers, immediates and memory, pops into the registers no
 * address uses, reads through the pointer registers (rbx, rbp, rsi, rdi, with
 * r12 or r13 scaled as the index, and rsp into what is pushed and above it) at
 * every width and displacement size, and calls of a subroutine laid out after
 * the call that pushes, reads and pops in turn -- the stack balanced at the
 * end, the whole run three times by a loop on r15 as `program`'s.
 *
 * @param {Buffer[]} instructions @param {number} seed @param {number} count
 */
export function stacked(instructions, seed, count){
    let x = seed >>> 0 || 1;
    const next = ()=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x;
    };
    /** The registers no address uses, which a pop may write. */
    const free = [0, 1, 2, 8, 9, 10, 11, 14];
    /** @param {number} op @param {number} r */
    const oneByte = (op, r)=>Buffer.from(r < 8 ? [op + r] : [0x41, op + r - 8]);
    /**
     * A read of `[base + index * scale + disp]` into `reg` by `opcode`, a REX.W one when `wide`.
     * @param {number[]} opcode @param {boolean} wide @param {number} reg @param {number} base
     * @param {number} index  -1 for none @param {number} scale @param {number} disp
     */
    const read = (opcode, wide, reg, base, index, scale, disp)=>{
        const rex = 0x40 | (wide ? 8 : 0) | (reg >> 3) << 2 | (index >= 0 ? index >> 3 : 0) << 1
            | base >> 3;
        const near = disp >= -128 && disp < 128;
        const at = Buffer.alloc(near ? 1 : 4);
        if (near)
        {
            at.writeInt8(disp);
        }
        else
        {
            at.writeInt32LE(disp);
        }
        return Buffer.concat([Buffer.from([...(rex === 0x40 ? [] : [rex]), ...opcode,
            (near ? 0x40 : 0x80) | (reg & 7) << 3 | 4,
            Math.log2(scale) << 6 | (index >= 0 ? index & 7 : 4) << 3 | base & 7]), at]);
    };
    /** A read off a pointer register or rsp. @param {number} depth  quadwords pushed */
    const access = depth=>{
        // Each form's opcode, whether REX.W, and the immediate after the operand:
        // mov, movzx, add, cmp, movsxd, movsx and imul in its two- and three-operand forms.
        const forms = [[[0x8b], true, 0], [[0x8b], false, 0], [[0x0f, 0xb6], false, 0],
            [[0x0f, 0xb7], true, 0], [[0x03], true, 0], [[0x3b], false, 0], [[0x63], true, 0],
            [[0x0f, 0xbe], false, 0], [[0x0f, 0xaf], false, 0], [[0x0f, 0xaf], true, 0],
            [[0x6b], false, 1], [[0x69], false, 4], [[0x69], true, 4]];
        const [opcode, wide, imm] = /** @type {[number[], boolean, number]} */
            (forms[next() % forms.length]);
        const reg = free[next() % free.length];
        let one;
        if (next() % 3 === 0)
        {
            // rsp 0x10001f00 less the pushes, the data ending 0x100 past it.
            one = read(opcode, wide, reg, 4, -1, 1, next() % (depth * 8 + 0xf0));
        }
        else
        {
            const index = [-1, 12, 13][next() % 3];
            const disp = next() % 4 === 0 ? -0x300 + next() % 0x1300 : next() % 0x80;
            one = read(opcode, wide, reg, [3, 5, 6, 7][next() % 4], index, 1 << next() % 4, disp);
        }
        const suffix = Buffer.from(Uint32Array.of(next()).buffer).subarray(0, imm);
        // The word form of an imul: its operand-size prefix before the REX.
        const word = opcode[0] !== 0x63 && opcode[0] !== 0x8b && !wide && next() % 4 === 0
            && (opcode[0] === 0x6b || opcode[0] === 0x69 || opcode[1] === 0xaf);
        return Buffer.concat([Buffer.from(word ? [0x66] : []), one,
            word && imm === 4 ? suffix.subarray(0, 2) : suffix]);
    };
    /** @param {number} turns @param {boolean} nest @returns {Buffer} */
    const body = (turns, nest)=>{
        /** @type {Buffer[]} */
        const parts = [];
        let depth = 0;
        for (let i = 0; i < turns; i++)
        {
            const kind = next() % 8;
            if (kind === 0 || kind === 1)
            {
                parts.push(oneByte(0x50, next() % 16));
                depth++;
            }
            else if (kind === 2)
            {
                parts.push(next() % 2 === 0 ? Buffer.from([0x6a, next() & 0xff])
                    : Buffer.concat([Buffer.from([0x68]),
                        Buffer.from(Uint32Array.of(next()).buffer)]));
                depth++;
            }
            else if (kind === 3 && depth > 0)
            {
                parts.push(oneByte(0x58, free[next() % free.length]));
                depth--;
            }
            else if (kind === 4)
            {
                // push qword [m]: ff /6 in place of the read's opcode and register.
                const one = read([0xff], false, 6, [3, 5, 6, 7][next() % 4], -1, 1, next() % 0x100);
                parts.push(one);
                depth++;
            }
            else if (kind === 5 && nest)
            {
                // call sub; jmp over; sub: ...; ret; over:
                const callee = Buffer.concat([body(1 + next() % 5, false), Buffer.from([0xc3])]);
                parts.push(Buffer.from([0xe8, 2, 0, 0, 0, 0xeb, callee.length]), callee);
            }
            else if (kind === 6)
            {
                parts.push(access(depth));
            }
            else
            {
                parts.push(instructions[next() % instructions.length]);
            }
        }
        for (; depth > 0; depth--)
        {
            parts.push(oneByte(0x58, free[next() % free.length]));
        }
        return Buffer.concat(parts);
    };
    const code = body(count, true);
    const back = -(code.length + 3 + 6);
    const loop = Buffer.from([0x41, 0xff, 0xcf, 0x0f, 0x85, back & 0xff, back >>> 8 & 0xff,
        back >>> 16 & 0xff, back >>> 24 & 0xff]);
    const one = CORPUS.cases[next() % CORPUS.cases.length];
    const regs = [...one.regs];
    regs[12] = (next() & 0x1f).toString(16);
    regs[13] = (next() & 0x1f).toString(16);
    regs[15] = '3';
    return { ...one, text: `stacked ${seed}`, code: Buffer.concat([code, loop]).toString('hex'),
        regs };
}

/**
 * Sets a case up on a machine: its code area (with the exit jump and EXIT in
 * the area's last eight bytes), data, registers, flags and XMM registers.
 *
 * @param {ReturnType<typeof machine>} m @param {any} one
 */
export function load(m, one){
    const { layout, memory, view } = m;
    const bytes = new Uint8Array(memory.buffer);
    const code = Buffer.from(one.code, 'hex');
    bytes.fill(0, CORPUS.codeAt, CORPUS.codeAt + CORPUS.codeSize);
    bytes.set(code, CORPUS.codeAt);
    const disp = CORPUS.codeSize - 8 - (code.length + 6);
    bytes.set([0xff, 0x25, disp & 0xff, disp >>> 8 & 0xff, disp >>> 16 & 0xff, disp >>> 24],
        CORPUS.codeAt + code.length);
    view.setBigUint64(CORPUS.codeAt + CORPUS.codeSize - 8, BigInt(EXIT), true);
    bytes.set(fill(one.seed, CORPUS.dataSize), CORPUS.dataAt);
    one.regs.forEach((/** @type {string} */ value, /** @type {number} */ i)=>{
        view.setBigUint64(layout.regs + i * 8, BigInt(`0x${value}`), true);
    });
    view.setBigUint64(layout.eip, BigInt(CORPUS.codeAt), true);
    view.setUint32(layout.eflags, one.flags | 0x202, true);
    view.setUint32(layout.mxcsr, one.mxcsr ?? 0x1f80, true);
    bytes.set(one.xmm ?? fill(one.seed ^ CORPUS.xmmSeed, 256), layout.xmm);
    // The x87 unit as `fninit` leaves it, its registers (the MMX ones) seeded,
    // and some marked as holding a `fild`'s quadword, which an MMX write ends;
    // `fresh`, as a processor's first: its registers zeros and none marked (what
    // an empty register held before is the interpreter's to keep, not
    // translated code's, which writes an indefinite into one and reads no sign
    // from one -- as at 32 bits, whose judge starts from this unit).
    bytes.set(one.fresh === true ? new Uint8Array(128) : fill(one.seed ^ 0x87, 128), layout.x87);
    bytes[layout.x87Top] = 0;
    bytes[layout.x87Empty] = 0xff;
    view.setUint16(layout.x87Control, 0x37f, true);
    view.setUint16(layout.x87Status, 0, true);
    bytes[/** @type {number} */ (layout.x87Exact)] = one.fresh === true ? 0 : one.seed & 0xff;
    m.state.syncIn();
    m.state.halted = false;
    m.state.trapped.length = 0;
    m.state.retired = 0;
}

/**
 * Runs the loaded case to its exit or a fault, translated or interpreted,
 * and answers what the program can see.
 *
 * @param {ReturnType<typeof machine>} m @param {boolean} translated
 * @param {number} [budget]
 */
export function run(m, translated, budget = 7){
    const { layout, memory, state, runner, view } = m;
    let fault;
    try
    {
        for (let round = 0; round < 100000; round++)
        {
            if (translated)
            {
                // A small budget by default, so runs end between blocks as well as at faults.
                runner.run(state, budget);
                // The host writes the state back after a run (cork-host's
                // `settle`): RIP and the flags must be the blocks' own.
                state.syncOut();
            }
            else
            {
                state.syncIn();
                interpret64(state, 10000);
                state.syncOut();
            }
        }
        fault = 'ran on';
    }
    catch (e){
        const error = /** @type {{ vector?: number, eip?: number }} */ (e);
        if (typeof error.vector !== 'number')
        {
            throw e;
        }
        state.syncOut();
        fault = error.eip === EXIT ? 'exit' : `${error.vector}@${(error.eip ?? 0) - CORPUS.codeAt}`;
    }
    const bytes = new Uint8Array(memory.buffer);
    return {
        fault,
        regs: [...new BigUint64Array(memory.buffer, layout.regs, 16)]
            .map(value=>value.toString(16)),
        rip: view.getBigUint64(layout.eip, true).toString(16),
        retired: String(state.retired),
        flags: view.getUint32(layout.eflags, true).toString(16),
        xmm: Buffer.from(bytes.subarray(layout.xmm, layout.xmm + 256)).toString('hex'),
        // The held registers' doubles: an empty register is never read. Not
        // the quadwords past them nor the marks of which hold a quadword
        // `fild`'s integer exactly (`x87Exact`): the interpreter marks every
        // such load, translated code only in a region that also stores a
        // quadword, as at 32 bits (`tracksExact` in `x87.js`). What a store
        // makes of them is the data's.
        x87: Buffer.from(bytes.subarray(layout.x87, layout.x87 + 128)
            .map((byte, at)=>((at & 8) === 0 && (bytes[layout.x87Empty] >>> (at >>> 4) & 1) === 0
                ? byte : 0))).toString('hex')
            + [layout.x87Top, layout.x87Empty, layout.x87Control, layout.x87Control + 1,
                layout.x87Status, layout.x87Status + 1]
                .map(at=>bytes[at].toString(16)).join(','),
        data: Buffer.from(bytes.subarray(CORPUS.dataAt, CORPUS.dataAt + CORPUS.dataSize))
            .toString('base64'),
    };
}

/**
 * Runs every case on both machines and answers the differences.
 *
 * @param {any[]} cases
 * @param {{ budget?: number, config?: Record<string, unknown>, tiered?: boolean,
 *     makeRunner?: MakeRunner | null, ramSize?: number }} [options]  `budget`: each
 *     translated run's; the rest the translated machine's (`machine`)
 */
export function compare(cases, { budget = 7, ...options } = {}){
    const translatedMachine = machine(options);
    const interpretedMachine = machine();
    /** @type {string[]} */
    const failures = [];
    let exits = 0;
    for (const one of cases)
    {
        // A fresh translation per case: the code area is rewritten in place.
        translatedMachine.runner.invalidate(CORPUS.codeAt, CORPUS.codeSize);
        load(translatedMachine, one);
        load(interpretedMachine, one);
        const translated = run(translatedMachine, true, budget);
        const interpreted = run(interpretedMachine, false);
        exits += translated.fault === 'exit' ? 1 : 0;
        if (translated.fault === interpreted.fault && /^[1-9]\d*@/.test(translated.fault))
        {
            // At a fault other than a division's, the status flags a write the
            // code after it overwrites left are the translator's to drop, as
            // the 32-bit translator drops them: the handler resumes the same
            // code, which writes them again before it reads them.
            for (const seen of [translated, interpreted])
            {
                seen.flags = (Number.parseInt(seen.flags, 16) & ~STATUS).toString(16);
            }
        }
        if (one.undefinedFlags)
        {
            // Flags the case leaves undefined, which a translation outside
            // `precise` may leave otherwise (`flagsLeftUndefined`).
            for (const seen of [translated, interpreted])
            {
                seen.flags = (Number.parseInt(seen.flags, 16) & ~one.undefinedFlags).toString(16);
            }
        }
        for (const key of /** @type {const} */ (['fault', 'rip', 'retired', 'flags', 'xmm',
            'x87', 'data']))
        {
            if (translated[key] !== interpreted[key])
            {
                failures.push(`${one.text}: ${key} ${translated[key].slice(0, 80)}`
                    + ` vs ${interpreted[key].slice(0, 80)}`);
            }
        }
        translated.regs.forEach((value, i)=>{
            if (value !== interpreted.regs[i])
            {
                failures.push(`${one.text}: r${i} ${value} vs ${interpreted.regs[i]}`);
            }
        });
    }
    return { failures, exits, stats: translatedMachine.runner.stats };
}

/**
 * Four switches run eight rounds, then eight more after a table is rewritten, each
 * case changing a word of [rbx] its own way, a default the indices past the bound
 * (GNU as, `ld -Ttext=0x20000000 --oformat binary`):
 *
 *     jmp [tableA + rax*8]                 GCC's absolute quadwords, bound by cmp esi, 5; ja
 *     lea rdx, [rip + base]; mov ecx, [rdx + rax*4 + tableB - base]; add rcx, rdx; jmp rcx
 *                                          MSVC's RVAs from a base below the code (the
 *                                          image's), the index widened by movsxd
 *     lea rdx, [rip + tableC]; movsxd rax, [rdx + rax*4]; add rax, rdx; jmp rax
 *                                          MinGW's offsets, the bound tested in memory
 *     jmp [0x10000040 + rax*8]             a table in the data area, filled by the program
 *                                          (read at forming before or after the fill), and
 *                                          an entry rewritten once its region has run
 */
export const SWITCHES = ''
    + '488d05d40000004889042540000010488d05cc0000004889042548000010488d05c4000000488904'
    + '25500000104531c931f683fe05772889f0ff24c52001002048830301eb204883030aeb1a48830364'
    + '48830303eb10486b0b0348890beb07488103e803000083fe0477294863c6488d158bffffff8b8c82'
    + '500100004801d1ffe14883430807eb1148836b0805eb0a48837308554883430802897318837b1803'
    + '77268b4318488d15b8000000486304824801d0ffe0488343100beb1148d16310eb0b48f75310eb05'
    + '488343100d83fe02771d89f0ff24c5400000104883432011eb1248c1432003eb0b48f75b20eb0548'
    + '83432013ffc683fe080f8233ffffff4585c9757041ffc1488d05dbffffff488904254800001031f6'
    + 'e915ffffff0f1f00400000200000000046000020000000004c000020000000005000002000000000'
    + '56000020000000005f0000200000000081000000880000008f0000008f0000008100000051ffffff'
    + '58ffffff5effffff51ffffff';

/**
 * Clang's tables, the base's `lea` hoisted out of each loop:
 *
 *             lea r13, [rip + table]; xor esi, esi; lea rax, [rip + loop]; jmp rax
 *     loop:   mov eax, esi; and eax, 3; cmp rax, 3; ja next     entered through a register:
 *             movsxd rcx, [r13 + rax*4]; add rcx, r13; jmp rcx  the base only in r13
 *     c0..c3: add [rbx], 1 / add [rbx], 10 / [rbx] *= 3 / sub [rbx], 7; jmp next
 *     next:   inc esi; cmp esi, 200; jb loop
 *             lea r12, [rip + table2]; xor esi, esi; jmp loop2
 *     loop2:  as loop through r12 and table2                   the lea in the region
 *     d0..d3: xor [rbx + 8], rsi / add 5 / rol 3 / not; next2: as next
 *             xor esi, esi; lea rax, [rip + loop3]; jmp rax
 *     loop3:  mov ecx, esi; and ecx, 3; cmp rcx, 3; ja next3   the index written over
 *             movsxd rcx, [r13 + rcx*4 - 16]; add rcx, r13; jmp rcx   by the table's read
 *     e0..e3: add [rbx + 16], 3 / [rbx + 16] *= 5 / xor rsi / ror 7; next3: as next; jmp done
 *     table3, table, table2: the cases' offsets from table (table3's) or their own table
 */
export const HOISTED_SWITCHES = ''
    + '4c8d2ddd00000031f6488d0502000000ffe089f083e0034883f803772349634c85004c01e9ffe148'
    + '830301eb134883030aeb0d486b1303488913eb0448832b07ffc681fec800000072c84c8d25a30000'
    + '0031f6eb0089f083e0034883f803772149630c844c01e1ffe148317308eb124883430805eb0b48c1'
    + '430803eb0448f75308ffc681fec800000072ca31f6488d0502000000ffe089f183e1034883f90377'
    + '2749634c8df04c01e9ffe14883431003eb16486b53100548895310eb0b48317310eb0548c14b1007'
    + 'ffc681fec800000072c4eb30c7ffffffceffffffd9ffffffdfffffff43ffffff49ffffff4fffffff'
    + '58ffffff75ffffff7bffffff82ffffff89ffffff';

/**
 * Two switches whose index the block masks itself, no bound test before it,
 * forty rounds, each case changing a word of [rbx] its own way:
 *
 *     1: mov eax, esi; and eax, 3; jmp [rax*8 + tableA]          absolute quadwords
 *        a0..a3: add [rbx], 1 / 10; [rbx] *= 3; sub [rbx], 7
 *     2: lea rdx, [rip + tableB]; mov ecx, esi; and rcx, 7       offsets from the table,
 *        movsxd rcx, [rdx + rcx*4]; add rcx, rdx; jmp rcx         a quadword mask
 *        b0..b3: add [rbx + 8], 3; xor [rbx + 8], rsi; rol [rbx + 8], 5; not [rbx + 8]
 *     3: inc esi; cmp esi, 40; jb 1b
 */
export const MASKED_SWITCHES = ''
    + '31f689f083e003ff24c56000002048830301eb134883030aeb0d486b0b0348890beb0448832b07488d'
    + '155200000089f14883e10748630c8a4801d1ffe14883430803eb1148317308eb0b48c1430805eb0448'
    + 'f75308ffc683fe2872a6eb4266900e0000200000000014000020000000001a00002000000000230000'
    + '2000000000bdffffffc4ffffffcaffffffd1ffffffd1ffffffcaffffffc4ffffffbdffffff';

/**
 * A masked switch whose second entry is rewritten, after thirty rounds, to its case's
 * address past the 4 GiB window: the next jump through it faults, as the interpreter's
 * does, rather than taking the case the low half names.
 *
 *         lea rax, [rip + c0]; mov [0x10000040], rax; lea rax, [rip + c1]; mov [0x10000048], rax
 *     1:  mov eax, esi; and eax, 1; jmp [rax*8 + 0x10000040]
 *     c0: add qword [rbx], 1; jmp 2f
 *     c1: add qword [rbx], 10
 *     2:  inc esi; cmp esi, 30; jne 3f
 *         lea rax, [rip + c1]; bts rax, 32; mov [0x10000048], rax
 *     3:  cmp esi, 40; jb 1b
 */
export const FAR_SWITCH = ''
    + '31f6488d05230000004889042540000010488d051a000000488904254800001089f083e001ff24c5400000'
    + '1048830301eb044883030affc683fe1e7514488d05eeffffff480fbae820488904254800001083fe2872ca';

/**
 * Programs of calls and returns: recursion past the wasm call depth, a callee that
 * returns elsewhere, calls whose callees are formed in, indirect calls predicted and
 * not, a callee that jumps out past its caller and a region left by a jump while a
 * call waits. Their sources:
 *
 * calls:   mov ecx, 12; call fib; mov [rbx], rax; mov ecx, 80; call depth
 *          mov [rbx + 8], rax; call skip; mov qword [rbx + 16], 1  (skip returns past it)
 *          mov qword [rbx + 24], 2; call cold; mov [rbx + 32], rax; jmp done
 *          fib: cmp ecx, 2; jb small; push rcx; dec ecx; call fib; pop rcx; push rax
 *               sub ecx, 2; call fib; pop rdx; add rax, rdx; ret
 *          small: mov eax, ecx; ret
 *          depth: test ecx, ecx; jz zero; dec ecx; call depth; inc rax; ret
 *          zero: xor eax, eax; ret; skip: add qword [rsp], 8; ret
 *          cold: pxor xmm0, xmm0; mov eax, 7; ret
 * fresh:   jmp start; f1: add ebx, 7; movd xmm3, ebx; ret
 *          f2: lea rax, [rbx + 100]; movd edx, xmm3; add ebx, 3; paddd xmm3, xmm3; ret
 *          body: test r10, r10; jz b; mov ebx, 1; movd xmm3, ebx; jmp q
 *          b: call f1; q: call f2; add r13, rax; add r13, rdx; ret
 *          start: mov r12d, 4; again: call body; dec r12d; jnz again
 * formedAfter: mov ecx, 3; loop: call g; call leaf; dec ecx; jnz loop; jmp done
 *          g: add eax, 0x1234; call h; ret; h: ret; leaf: mov [rbx], rax; add rbx, 8; ret
 * predicted: mov ecx, 20000; loop: mov eax, ecx; xor edx, edx; mov r9d, 3; div r9d
 *          lea rax, [rip + f0]; shl edx, 3; add rax, rdx; lea r10, [rcx + 7]; call rax
 *          call g; dec ecx; jnz loop; jmp done
 *          f0..f2: add rbx, 1 / 2 / 4; ret (eight bytes apart)
 *          g: add rbx, r10; call h; ret; h: ret
 * indirect: mov esi, 3; again: lea rdx, [rip + fib]; mov ecx, 10; call rdx; add [rbx], rax
 *          lea rax, [rip + small]; mov [rbx + 64], rax; mov ecx, 7; call qword [rbx + 64]
 *          add [rbx + 8], rax; dec esi; jnz again; jmp done
 *          fib: as calls', its first call through rdx; small: mov eax, ecx; ret
 * jumpedOut: mov esi, 2; again: xor eax, eax; call f
 *          after: add [rbx], rax; dec esi; jnz again; jmp done
 *          f: lea rdx, [rip + g]; call rdx; mov eax, 1000; ret
 *          g: mov eax, 7; add rsp, 16; lea rdx, [rip + after]; jmp rdx
 * expect:  mov esi, 2; again: mov ecx, 3; xor eax, eax; call f; add [rbx], rax; dec esi
 *          jnz again; jmp done
 *          f: call g; L: inc eax; dec ecx; jz fret; lea rdx, [rip + far]; jmp rdx
 *          fret: ret; g: ret; far: add eax, 100; lea rdx, [rip + L]; jmp rdx
 */
export const CALLS = Object.freeze({
    calls: ''
    + 'b90c000000e831000000488903b950000000e84300000048894308e84c00000048c7431001'
        + '00000048c7431802000000e83d00000048894320eb4183f902721751ffc9e8f3ffffff595083e902e8'
        + 'e9ffffff5a4801d0c389c8c385c9740bffc9e8f5ffffff48ffc0c331c0c34883042408c3660fefc0b8'
        + '07000000c3',
    fresh: ''
    + 'eb3983c307660f6edbc3488d4364660f7eda83c303660ffedbc34d85d2740bbb01000000660f6edb'
        + 'eb05e8d3ffffffe8d6ffffff4901c54901d5c341bc04000000e8d4ffffff41ffcc75f6',
    formedAfter: ''
    + 'b903000000e80b000000e812000000ffc975f2eb140534120000e801000000c3c3'
        + '4889034883c308c3',
    predicted: ''
    + 'b9204e000089c831d241b90300000041f7f1488d0517000000c1e2034801d04c8d5107ffd0'
        + 'e81e000000ffc975d7eb224883c301c39090904883c302c39090904883c304c3909090'
        + '4c01d3e801000000c3c3',
    indirect: ''
    + 'be03000000488d1527000000b90a000000ffd2480103488d053600000048894340b9070000'
        + '00ff534048014308ffce75d4eb2383f902721b51ffc9488d15f1ffffffffd2595083e902e8e5ff'
        + 'ffff5a4801d0c389c8c3',
    jumpedOut: ''
    + 'be0200000031c0e809000000480103ffce75f2eb21488d1508000000ffd2b8e8030000c3b8'
        + '070000004883c410488d15d8ffffffffe2',
    expect: ''
    + 'be02000000b90300000031c0e809000000480103ffce75edeb22e810000000ffc0ffc97409'
        + '488d1504000000ffe2c3c383c064488d15e5ffffffffe2',
});

/** Whether the instruction ends a block: control leaves the straight line. @param {string} op */
const endsBlock = op=>op === 'jmp' || op === 'call' || op === 'ret' || op.startsWith('j')
    || op === 'loop' || op === 'loope' || op === 'loopne';

/** The shift and rotate operations, which write no flag for a count of zero. */
const SHIFTS = new Set(['shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr', 'shld', 'shrd']);

/**
 * The flags a loaded case leaves undefined at its end, by the interpreter's run of
 * it from the state's RIP (`ir64-corpus.test.js`'s rule): each instruction's
 * undefined flags, less those a later one defines -- an instruction that writes
 * none (a repeated string instruction run no times, a shift by zero) changing
 * nothing -- or null where a later instruction reads one.
 *
 * @param {any} state  a `blockState64` over the case's machine, the case loaded
 * @param {(address: number) => number} read  its memory, by guest address
 * @returns {number | null}
 */
export function flagsLeftUndefined(state, read){
    state.syncIn();
    state.retired = 0;
    let undefinedFlags = 0;
    for (let step = 0; step < 10000; step++)
    {
        const instruction = decode(read, Number(state.rip), MODE_64);
        if ('refused' in instruction || Number(state.rip) === EXIT)
        {
            break;
        }
        if ((instruction.flagsRead & undefinedFlags) !== 0)
        {
            return null;
        }
        const { op, operands, prefixes } = instruction;
        let writes = !(['movs', 'stos', 'lods', 'cmps', 'scas'].includes(op)
            && (prefixes.rep || prefixes.repne) && state.r[1] === 0n);
        if (SHIFTS.has(op))
        {
            const last = operands[operands.length - 1];
            const count = last.kind === 'imm' ? /** @type {number} */ (last.value)
                : Number(state.r[1] & 0xffn);
            writes = (count & (instruction.size === 8 ? 63 : 31)) !== 0;
        }
        try
        {
            interpret64(state, 1);
        }
        catch {
            break;
        }
        if (writes)
        {
            const defined = instruction.flagsWritten & ~instruction.flagsUndefined;
            undefinedFlags = (undefinedFlags & ~defined | instruction.flagsUndefined) & COMPARED;
        }
    }
    return undefinedFlags;
}

/**
 * Loops onto themselves whose accesses move by a fixed stride a turn, each from
 * rdx (`loopCases`): a fill of a quadword and a dword at 12 bytes a turn, a copy,
 * a fill downward by words, pushes of a register and an immediate -- more turns
 * than one window takes, so a closed page lies past the first -- and an indexed
 * store and add. Source:
 *
 *     fill:   mov rdi, rdx; mov ecx, 300; 1: mov [rdi], rcx; mov [rdi + 8], eax
 *             add rdi, 12; dec ecx; jnz 1b
 *     copy:   mov rsi, rdx; lea rdi, [rdx + 0x800]; mov ecx, 200
 *             1: mov rax, [rsi]; add rax, rcx; mov [rdi], rax; add rsi, 8; add rdi, 8
 *             dec ecx; jnz 1b
 *     down:   mov rdi, rdx; mov ecx, 300; 1: mov [rdi], cx; sub rdi, 6; dec ecx; jnz 1b
 *     pushes: mov r8, rsp; mov rsp, rdx; mov ecx, 600; 1: push rcx; push 7; dec ecx; jnz 1b
 *             mov rsp, r8
 *     index:  xor ecx, ecx; 1: mov [rdx + rcx*4 + 16], ecx; add [rdx + rcx*4 + 0x400], ecx
 *             inc rcx; cmp rcx, 250; jne 1b
 *     groups: mov rdi, rdx; mov ecx, 50; 1: mov [rdi], rcx; mov [rdi + 8], rax
 *             test ecx, 1; jz 2f; mov [rdi + 16], ecx; 2: mov [rdi + 20], cx
 *             add [rdi + 4], ecx; lea rdi, [rdi + 32]; dec ecx; jnz 1b
 *             -- a loop of three blocks, each turn's stores one window the block
 *             after the first takes from it, rather than streams
 *     dwords: mov r8, rdx; xor eax, eax; mov r10d, 200
 *             1: mov esi, eax; movzx edi, byte [r8 + rsi]; lea esi, [r8 + rax]; add eax, 1
 *             mov [rsi + 0x400], dil; cmp eax, r10d; jne 1b
 *             -- dword registers a stream goes off, one a sum of two cut to 32 bits
 *     cuts:   mov r8, rdx; mov r9, 1 << 32; sub r8, r9; mov eax, -100; mov ecx, 300
 *             1: mov esi, eax; mov [r8 + rsi], cl; add eax, 1; dec ecx; jnz 1b
 *             -- the store lands below rdx until eax wraps, then past the window: a
 *             model that took esi past 2^32 would store at rdx on
 *     sxd:    mov r8, rdx; xor ecx, ecx; xor eax, eax
 *             1: movsxd rax, [r8 + rcx*4]; mov [r8 + rcx*4 + 0x400], eax; movsxd rax, ecx
 *             mov [r8 + rax*8 + 0x1400], rcx; inc ecx; cmp ecx, 400; jne 1b
 *             -- movsxd writes rax: no stream goes off it
 */
export const LOOPS = Object.freeze({
    fill: '4889d7b92c01000048890f8947084883c70cffc975f2',
    copy: '4889d6488dba00080000b9c8000000488b064801c84889074883c6084883c708ffc975eb',
    down: '4889d7b92c01000066890f4883ef06ffc975f5',
    pushes: '4989e04889d4b958020000516a07ffc975f94c89c4',
    index: '31c9894c8a10018c8a0004000048ffc14881f9fa00000075e9',
    groups: '4889d7b93200000048890f48894708f7c1010000007403894f1066894f14014f04488d7f20ffc975df',
    dwords: '4989d031c041bac800000089c6410fb63c30418d340083c0014088be000400004439d075e6',
    cuts: '4989d049b900000000010000004d29c8b89cffffffb92c01000089c641880c3083c001ffc975f3',
    sxd: '4989d031c931c04963048841898488000400004863c149898cc000140000ffc181f99001000075df',
});

/**
 * Every loop of `LOOPS` from starts that keep its turns in the data area, run off
 * its end or below its start into a closed page, start past the 4 GiB window
 * (whose low half is the data area: wrapped, the stores would land there) or just
 * below its end (a turn's dword then straddles it), and
 * -- with `code` -- store into the code area's page, down over the loop itself.
 *
 * @param {boolean} [intoCode]  for a runner that notes stores into code
 */
export function loopCases(intoCode = true){
    const starts = [CORPUS.dataAt + 0x100, CORPUS.dataAt + 0x1800, CORPUS.dataAt + 0x1f00,
        CORPUS.dataAt + 0x200, 2 ** 32 + CORPUS.dataAt + 0x100, 2 ** 32 - 6, 2 ** 63,
        ...intoCode ? [CORPUS.codeAt + 0x300] : []];
    return Object.entries(LOOPS).flatMap(([name, code])=>starts.map(start=>{
        const one = CORPUS.cases[0];
        const regs = [...one.regs];
        regs[2] = BigInt(start).toString(16);
        return { ...one, text: `${name} from ${regs[2]}`, code, regs };
    }));
}
