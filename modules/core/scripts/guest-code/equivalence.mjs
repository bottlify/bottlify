/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs a `@guestCode` function both ways and holds the x86 to the JavaScript:
 * the input through the export's handler -- the JavaScript, its arguments
 * read off the stack as a call leaves them -- and through the compiled bytes
 * on cork's test machine, called from a return address that halts; the two
 * must leave the same result registers, x87 stack and memory. The x86 is also
 * held to what a callee owes its caller: EBX, ESI, EDI and EBP as they were,
 * ESP past the return address (and the arguments, for stdcall), the direction
 * flag clear, the control word as it was -- or as the JavaScript left it, for
 * a function that loads one -- and the x87 stack empty but for a double
 * result; a function that clears the exception flags leaves the ones the
 * JavaScript does.
 *
 * A function that hands a call to the host (`return host()`) jumps, on the
 * machine, to a halt where the host's trap would be; there it must have left
 * everything as the call found it -- ESP at the return address, the
 * arguments, EBX, ESI, EDI and EBP, the direction flag, the control word, the
 * x87 stack and its values, and every byte of memory -- and the case's
 * stand-in for the handler answers from there. The JavaScript must hand over
 * the same inputs.
 *
 * Under a single-precision control word the reference is the model of the
 * x87 (`model.mjs`): the same source with each double's `+ - * /` and square
 * root rounded to 24 bits, as the x87 rounds them and the translator does;
 * under any other, the source itself, which is the model there -- but for a
 * function that loads a control word, whose model rounds as the word it
 * loads says.
 *
 * Where the function has x86-64 code too -- the build's for a 64-bit process
 * (`longCodeOf`), or the table a test gives -- each input runs that as well,
 * on cork's long-mode machine (`long.mjs`), called as the x64 convention calls
 * with the same arguments and memory, and is held to the same JavaScript: the
 * result in RAX (an i32 or u32 extended by its sign, as the bridge's trap
 * answers one), the memory, RSP past the return address, the direction flag
 * clear, and RBX, RBP, RSI, RDI and R12 to R15 as they were; a hand-over
 * finds RSP at the return address, RCX, RDX, R8, R9 and the stack's
 * arguments whole as the call left them, the kept registers and every byte
 * of memory. A case that calls through a pointer runs there only with an
 * x86-64 callback of its own (`callback64`).
 *
 * For the tests: the machine is cork's own test machine, not the engine.
 */

import assert from 'node:assert/strict';
import { createTestMachine } from '../../../cork/src/testing/machine.js';
import { guestEntry, longCodeOf } from '../../src/layers/win32/msvcrt/guest-code.js';
import { CODE_64, KEPT_64, STACK_64, argumentOf, callLong, longMachine } from './long.mjs';

export const CODE = 0x1000;
export const HALT = 0x0f00;
export const CALLBACK = 0x0e00;
/** Where the host's trap is, for a function that hands a call to it: a halt. */
export const HOST = 0x0d00;
export const DATA = 0x10000;
export const DATA_END = 0x40000;
const STACK = 0x7fff0;
const SAVED = { ebx: 0x11111111, esi: 0x22222222, edi: 0x33333333, ebp: 0x44444444 };

/**
 * @typedef {Object} Case
 * @property {number[]} [stack]       The argument slots, the first at [esp+4].
 * @property {number[]} [x87]         Doubles pushed before the call, the last in ST0.
 * @property {[number, ArrayLike<number>][]} [memory]  Bytes at addresses in the data area.
 * @property {number} [control]       The x87 control word the call is made under.
 * @property {number} [status]        The x87 status word the call finds, its top aside.
 */

/**
 * @typedef {Object} Double
 * @property {number[]} [callback]    x86 at CALLBACK, which a call through a pointer reaches.
 * @property {number[]} [callback64]  The same callback in x86-64, for the x86-64 code's run.
 * @property {(memory: Uint8Array, fn: number, args: number[]) => number} [call]
 *     Its JavaScript stand-in.
 * @property {(memory: Uint8Array, args: number[], x87: number[])
 *     => number | { st0: number }} [host]
 *     The host's handler a function hands a call to, over the case's memory,
 *     with the x87 arguments (the last in ST0) as the call left them: EAX, or
 *     a double that replaces them in ST0.
 */

/** One machine per piece of code run by `runCode`, its translations kept. */
/** @type {WeakMap<Uint8Array, ReturnType<typeof createTestMachine>>} */
const codeMachines = new WeakMap();

/**
 * Runs code assembled by hand on cork's test machine, called from a return
 * address that halts, with the registers and the stack slots given: what a
 * test holds a routine the compiler cannot express to.
 *
 * @param {Uint8Array} code
 * @param {{ stack?: number[], registers?: Record<string, number> }} input
 * @returns {{ eax: number, ecx: number, edx: number, ebx: number, esp: number, ebp: number,
 *     esi: number, edi: number, halted: boolean, popped: number }}
 *     Each of the eight registers after, whether it returned to the halt,
 *     and the bytes of arguments its return popped.
 */
export function runCode(code, { stack = [], registers = {} }){
    let m = codeMachines.get(code);
    if (!m)
    {
        m = createTestMachine();
        m.write(CODE, Array.from(code));
        m.write(HALT, [0xf4]);
        codeMachines.set(code, m);
    }
    m.writeU32(STACK, HALT);
    stack.forEach((word, i)=>m.writeU32(STACK + 4 + i * 4, word >>> 0));
    m.setReg('esp', STACK);
    for (const [reg, value] of Object.entries({ eax: 0xa5a5a5a5, ecx: 0xc5c5c5c5,
        edx: 0xd5d5d5d5, ...SAVED, ...registers }))
    {
        m.setReg(reg, value >>> 0);
    }
    m.setEflags(2);
    const exit = m.runProgram(CODE);
    const after = (/** @type {string} */ name)=>m.reg(name) >>> 0;
    const esp = after('esp');
    return {
        eax: after('eax'), ecx: after('ecx'), edx: after('edx'), ebx: after('ebx'), esp,
        ebp: after('ebp'), esi: after('esi'), edi: after('edi'),
        halted: exit.kind === 3 && m.eip() === HALT + 1, popped: esp - (STACK + 4),
    };
}

/** The registers a callee keeps, as `runCode` sets them. */
export const KEPT = SAVED;

/** A small generator with a seed, so a failure is the same failure each run. @param {number} seed */
export function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = state + 0x6d2b79f5 >>> 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return (t ^ t >>> 14) >>> 0;
    };
}

/** The two stack slots of a double, low first. @param {number} value */
export function doubleWords(value){
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
}

/** @param {number} a @param {number} b */
const sameDouble = (a, b)=>Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b);

/**
 * The first byte two memories differ at, or -1; a float that is NaN in both,
 * at the same aligned place and width, is the same float whatever its sign and
 * payload -- the x87 stores its indefinite with the sign set, and the NaN the
 * model's typed array stores has whichever sign the host processor gives.
 *
 * @param {Uint8Array} a @param {Uint8Array} b
 */
const firstDifference = (a, b)=>{
    const view = (/** @type {Uint8Array} */ bytes)=>new DataView(bytes.buffer, bytes.byteOffset,
        bytes.byteLength);
    const left = view(a);
    const right = view(b);
    /** @param {number} at @param {number} width */
    const bothNaN = (at, width)=>at + width <= a.length && (width === 4
        ? Number.isNaN(left.getFloat32(at, true)) && Number.isNaN(right.getFloat32(at, true))
        : Number.isNaN(left.getFloat64(at, true)) && Number.isNaN(right.getFloat64(at, true)));
    for (let at = 0; at < a.length; at++)
    {
        if (a[at] === b[at])
        {
            continue;
        }
        const word = at & ~3;
        const quad = at & ~7;
        if (bothNaN(word, 4))
        {
            at = word + 3;
            continue;
        }
        if (bothNaN(quad, 8))
        {
            at = quad + 7;
            continue;
        }
        return at;
    }
    return a.length === b.length ? -1 : a.length;
};

/**
 * The data area a function is held to: all of it for one that takes a
 * helper of the guest's memory or calls the guest, none for one that takes
 * nothing but `host` -- it names no address, and a run of maths is spared
 * copying and comparing the area at every input.
 *
 * @param {{ uses: readonly string[] }} fn
 */
const spanOf = fn=>(fn.uses.some(use=>use !== 'host') ? DATA_END - DATA : 0);

/**
 * @param {Record<string, import('../../src/layers/win32/msvcrt/guest-code.js').CompiledGuestCode>}
 *     compiled
 * @param {Record<string, unknown>} sources  The module the functions are in.
 * @param {import('./model.mjs').Model} [model]  The x87's model of the same
 *     module, the reference under a single-precision control word; without
 *     one, the source is held to it there too.
 * @param {Record<string, import('../../src/layers/win32/msvcrt/guest-code.js').CompiledGuestCode>}
 *     [long]  The same functions' x86-64 code; without it, the build's
 *     (`longCodeOf`), where it made any.
 */
export function equivalence(compiled, sources, model, long){
    /** One machine per function: its translations kept from one input to the next. */
    /** @type {Map<string, ReturnType<typeof createTestMachine>>} */
    const machines = new Map();
    /** @type {Map<string, import('./long.mjs').LongMachine>} */
    const longMachines = new Map();

    /** @param {string} name */
    const compiledOf = name=>{
        const found = compiled[name];
        if (!found)
        {
            throw new Error(`no compiled ${name}`);
        }
        return found;
    };

    /** The function's x86-64 code, where there is any. @param {string} name */
    const longOf = name=>(long !== undefined ? long[name] : longCodeOf(compiledOf(name)));

    /**
     * Runs the x86-64 code on the long-mode machine, and answers what it left
     * -- or, at a hand-over, checks the call is as it came and answers what
     * the stand-in does from there.
     *
     * @param {string} name
     * @param {import('../../src/layers/win32/msvcrt/guest-code.js').CompiledGuestCode} fn
     * @param {Case} input @param {Double} double
     */
    const runLong = (name, fn, input, double)=>{
        let m = longMachines.get(name);
        if (!m)
        {
            m = longMachine();
            const code = fn.code.slice();
            if (fn.host !== undefined)
            {
                new DataView(code.buffer).setUint32(fn.host, (HOST - (CODE_64 + fn.host + 4)) >>> 0,
                    true);
            }
            m.write(CODE_64, code);
            m.write(HALT, [0xf4]);
            m.write(HOST, [0xf4]);
            if (double.callback64)
            {
                m.write(CALLBACK, double.callback64);
            }
            longMachines.set(name, m);
        }
        const span = spanOf(fn);
        m.write(DATA, new Uint8Array(span));
        for (const [address, bytes] of input.memory ?? [])
        {
            m.write(address, Array.from(bytes));
        }
        const words = input.stack ?? [];
        // The words as the 32-bit stack has them: a double's two, low first.
        let next = 0;
        const args = fn.params.map((type, i)=>(type === 'f64'
            ? BigInt(words[next++] >>> 0) | BigInt(words[next++] >>> 0) << 32n
            : argumentOf(words[next++] ?? 0, i)));
        const floats = fn.params.map(type=>type === 'f64' || type === 'f32');
        const before = m.read(DATA, span);
        const { entry, xmm, slots, halted } = callLong(m, CODE_64, { args, floats,
            returnTo: HALT });
        const what = `${name}(${JSON.stringify(words)}) at 64 bits`;
        assert.ok(halted, `${what} halts`);
        // XMM6 to XMM15 are the caller's, as RBX and the rest are.
        const kept = Object.fromEntries([...KEPT_64.map(reg=>[reg, m.reg(reg)]),
            ...xmm.slice(6).map((_, i)=>[`xmm${i + 6}`, Array.from(m.xmm(i + 6))])]);
        const given = Object.fromEntries([...KEPT_64.map(reg=>[reg, entry[reg]]),
            ...xmm.slice(6).map((bytes, i)=>[`xmm${i + 6}`, Array.from(bytes)])]);
        const df = (m.flags() & 0x400) !== 0;
        if (fn.host !== undefined && m.rip() === HOST + 1)
        {
            const handed = `${what} handed to the host`;
            assert.equal(m.reg('rsp'), BigInt(STACK_64), `${handed}: RSP at the return address`);
            assert.equal(m.quad(STACK_64), BigInt(HALT), `${handed}: the return address kept`);
            // The registers that carry arguments, and those a callee keeps.
            const owed = [...['rcx', 'rdx', 'r8', 'r9'].slice(0, fn.params.length), ...KEPT_64];
            assert.deepEqual(Object.fromEntries(owed.map(reg=>[reg, m.reg(reg)])),
                Object.fromEntries(owed.map(reg=>[reg, entry[reg]])),
                `${handed}: the argument registers and the kept ones as the call left them`);
            assert.deepEqual(slots.map((_, i)=>m.quad(STACK_64 + 40 + i * 8)), slots,
                `${handed}: the stack's arguments kept`);
            assert.equal(df, false, `${handed}: the direction flag clear`);
            const data = m.read(DATA, span);
            if (!Buffer.from(data).equals(Buffer.from(before)))
            {
                const at = data.findIndex((byte, i)=>byte !== before[i]);
                assert.fail(`${handed}: memory written before, first at 0x${(DATA + at)
                    .toString(16)}`);
            }
            if (!double.host)
            {
                throw new Error(`${name} hands a call to the host, and the case gives no stand-in`);
            }
            const memory = new Uint8Array(1 << 20);
            memory.set(data, DATA);
            // What the trap reads: the low half of each argument.
            const answer = double.host(memory, args.map(arg=>Number(BigInt.asUintN(32, arg))), []);
            // The trap answers as the bridge does: the dword extended by its sign.
            return {
                rax: BigInt.asUintN(64, BigInt(typeof answer === 'number' ? answer | 0 : 0)),
                rsp: BigInt(STACK_64 + 8), kept, given, df,
                data: memory.slice(DATA, DATA + data.length), handedOver: true,
            };
        }
        assert.equal(m.rip(), HALT + 1, `${what} returns to its caller's address`);
        const answer = new DataView(m.xmm(0).buffer);
        return { rax: m.reg('rax'), rsp: m.reg('rsp'), kept, given, df, data: m.read(DATA, span),
            handedOver: false,
            xmm0: fn.returns === 'f32' ? answer.getFloat32(0, true) : answer.getFloat64(0, true) };
    };

    /**
     * Holds the x86-64 code to what the JavaScript answered for an input.
     *
     * @param {string} name @param {Case} input @param {Double} double
     * @param {{ eax: number, st: number[], data: Uint8Array, handedOver: boolean }} js
     *     The JavaScript's answer in doubles: the source's, whatever the control
     *     word, which SSE2's arithmetic has nothing of.
     * @param {string} what
     */
    const sameLong = (name, input, double, js, what)=>{
        const fn = longOf(name);
        // An x87 argument has no x86-64 code to take it; a call through a
        // pointer reaches x86-64 only where the case gives some.
        if (fn === undefined || (input.x87 ?? []).length > 0
            || double.callback && !double.callback64)
        {
            return;
        }
        const x64 = runLong(name, fn, input, double);
        const at64 = `${what} at 64 bits`;
        assert.equal(x64.handedOver, js.handedOver, `${at64}: handed to the host by both or by `
            + 'neither');
        assert.deepEqual(x64.kept, x64.given, `${at64}: the registers a callee keeps kept`);
        assert.equal(x64.rsp, BigInt(STACK_64 + 8), `${at64}: RSP past the return address`);
        assert.equal(x64.df, false, `${at64}: the direction flag clear`);
        if (fn.returns === 'f64' || fn.returns === 'f32')
        {
            assert.ok(sameDouble(/** @type {number} */ (x64.xmm0), js.st[0]),
                `${at64}: XMM0 ${x64.xmm0} against ${js.st[0]}`);
        }
        else if (fn.returns !== 'void')
        {
            assert.equal(x64.rax, BigInt.asUintN(64, BigInt(js.eax | 0)),
                `${at64}: RAX, EAX extended by its sign`);
        }
        const at = firstDifference(x64.data, js.data);
        if (at >= 0)
        {
            assert.fail(`${at64}: memory differs first at 0x${(DATA + at).toString(16)}: `
                + `${x64.data[at]} against ${js.data[at]}`);
        }
    };

    /** @param {string} name @param {Case} input @param {Double} double */
    const runX86 = (name, input, double)=>{
        let m = machines.get(name);
        const fn = compiledOf(name);
        if (!m)
        {
            m = createTestMachine();
            const code = fn.code.slice();
            if (fn.host !== undefined)
            {
                // The trap's address for a `jmp eax`, a displacement to it for a `jmp rel32`.
                new DataView(code.buffer).setUint32(fn.host, code[fn.host - 1] === 0xb8 ? HOST
                    : (HOST - (CODE + fn.host + 4)) >>> 0, true);
            }
            m.write(CODE, code);
            m.write(HALT, [0xf4]);
            m.write(HOST, [0xf4]);
            if (double.callback)
            {
                m.write(CALLBACK, double.callback);
            }
            machines.set(name, m);
        }
        const view = new DataView(m.memory.buffer);
        const span = spanOf(fn);
        new Uint8Array(m.memory.buffer, m.layout.ramBase + DATA, span).fill(0);
        for (const [address, bytes] of input.memory ?? [])
        {
            m.write(address, Array.from(bytes));
        }
        // A thiscall case's first word is `this`, which the call passes in ECX.
        const thiscall = fn.convention === 'thiscall';
        const words = input.stack ?? [];
        m.writeU32(STACK, HALT);
        (thiscall ? words.slice(1) : words).forEach((word, i)=>m.writeU32(STACK + 4 + i * 4, word));
        m.setReg('esp', STACK);
        m.setReg('eax', 0xa5a5a5a5);
        m.setReg('ecx', thiscall ? (words[0] ?? 0) >>> 0 : 0xc5c5c5c5);
        m.setReg('edx', 0xd5d5d5d5);
        for (const [reg, value] of Object.entries(SAVED))
        {
            m.setReg(reg, value);
        }
        m.setEflags(2);
        view.setUint16(m.layout.x87Control, input.control ?? 0x37f, true);
        view.setUint16(m.layout.x87Status, (input.status ?? 0) & 0xc7ff, true);
        let top = 0;
        let empty = 0xff;
        for (const value of input.x87 ?? [])
        {
            top = top - 1 & 7;
            view.setFloat64(m.layout.x87 + top * 16, value, true);
            empty &= ~(1 << top);
        }
        view.setUint8(m.layout.x87Top, top);
        view.setUint8(m.layout.x87Empty, empty);
        const before = fn.host === undefined ? null : m.read(DATA, span);
        const slots = fn.params.reduce((sum, type)=>sum + (type === 'f64' ? 2
            : type === 'x87' ? 0 : 1), 0);
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3, `${name} halts at its return (${JSON.stringify(exit)})`);
        const handedOver = fn.host !== undefined && m.eip() === HOST + 1;
        if (handedOver)
        {
            return handOver(name, m, input, double, /** @type {Uint8Array} */ (before), slots,
                { top, empty });
        }
        assert.equal(m.eip(), HALT + 1, `${name} returns to its caller's address`);
        const after = view.getUint8(m.layout.x87Top);
        const left = view.getUint8(m.layout.x87Empty);
        /** @type {number[]} */
        const st = [];
        for (let i = 0; i < 8; i++)
        {
            const physical = after + i & 7;
            if ((left & 1 << physical) !== 0)
            {
                break;
            }
            st.push(view.getFloat64(m.layout.x87 + physical * 16, true));
        }
        // The x87's top where the stack left it: its arguments popped, a double pushed.
        const popped = fn.params.filter(type=>type === 'x87').length;
        const pushed = fn.returns === 'f64' || fn.returns === 'f32' ? 1 : 0;
        assert.equal(after, top + popped - pushed & 7,
            `${name}: the x87 stack's top where the call and its result leave it`);
        return {
            eax: m.reg('eax'), edx: m.reg('edx'), esp: m.reg('esp'), st,
            saved: { ebx: m.reg('ebx'), esi: m.reg('esi'), edi: m.reg('edi'), ebp: m.reg('ebp') },
            df: (m.eflags() & 0x400) !== 0,
            control: view.getUint16(m.layout.x87Control, true),
            status: view.getUint16(m.layout.x87Status, true),
            data: m.read(DATA, span),
            handedOver: false,
        };
    };

    /**
     * The machine stopped at the host's trap: everything as the call found
     * it, and the stand-in answering from there as the handler would.
     *
     * @param {string} name @param {ReturnType<typeof createTestMachine>} m @param {Case} input
     * @param {Double} double @param {Uint8Array} before  The data area when the call was made.
     * @param {number} slots  The argument slots.
     * @param {{ top: number, empty: number }} x87  The x87 stack as the call was made.
     */
    const handOver = (name, m, input, double, before, slots, x87)=>{
        const view = new DataView(m.memory.buffer);
        const what = `${name}(${JSON.stringify(input.stack ?? [])}) handed to the host`;
        // A thiscall function hands over with `this` pushed under the return address.
        const frame = compiledOf(name).convention === 'thiscall' ? STACK - 4 : STACK;
        assert.equal(m.reg('esp'), frame, `${what}: ESP at the return address`);
        assert.equal(m.readU32(frame), HALT, `${what}: the return address kept`);
        const args = Array.from({ length: slots }, (_, i)=>m.readU32(frame + 4 + i * 4));
        assert.deepEqual(args, (input.stack ?? []).slice(0, slots).map(word=>word >>> 0),
            `${what}: the arguments kept`);
        assert.deepEqual({ ebx: m.reg('ebx'), esi: m.reg('esi'), edi: m.reg('edi'),
            ebp: m.reg('ebp') }, SAVED, `${what}: EBX, ESI, EDI and EBP kept`);
        assert.equal((m.eflags() & 0x400) !== 0, false, `${what}: the direction flag clear`);
        assert.equal(view.getUint16(m.layout.x87Control, true), input.control ?? 0x37f,
            `${what}: the control word`);
        assert.deepEqual({ top: view.getUint8(m.layout.x87Top),
            empty: view.getUint8(m.layout.x87Empty) }, x87, `${what}: the x87 stack as it was`);
        /** @type {number[]} The x87 arguments as the trap finds them, the last in ST0. */
        const pushed = (input.x87 ?? []).map((_, i)=>view.getFloat64(m.layout.x87
            + ((x87.top + (input.x87 ?? []).length - 1 - i) & 7) * 16, true));
        pushed.forEach((value, i)=>assert.ok(sameDouble(value, (input.x87 ?? [])[i]),
            `${what}: x87 argument ${i} ${value} where the call left ${(input.x87 ?? [])[i]}`));
        const data = m.read(DATA, before.length);
        if (!Buffer.from(data).equals(Buffer.from(before)))
        {
            const at = data.findIndex((byte, i)=>byte !== before[i]);
            assert.fail(`${what}: memory written before, first at 0x${(DATA + at).toString(16)}`);
        }
        if (!double.host)
        {
            throw new Error(`${name} hands a call to the host, and the case gives no stand-in`);
        }
        const memory = new Uint8Array(1 << 20);
        memory.set(data, DATA);
        const answer = double.host(memory, args, pushed);
        // The trap returns as the export does: a stdcall one pops the arguments.
        const popped = compiledOf(name).convention !== 'cdecl' ? slots * 4 : 0;
        return {
            eax: typeof answer === 'number' ? answer >>> 0 : 0, edx: 0, esp: frame + 4 + popped,
            st: typeof answer === 'number' ? [] : [answer.st0], saved: SAVED, df: false,
            control: input.control ?? 0x37f, status: (input.status ?? 0) & 0xc7ff,
            data: memory.slice(DATA, DATA + data.length), handedOver: true,
        };
    };

    /**
     * @param {string} name @param {Case} input @param {Double} double
     * @param {Record<string, unknown>} module  The source, or the model's copy of it.
     * @param {[number, number]} [bounds]  The addresses the JavaScript may reach,
     *     [from, to): past them a RangeError, as past the test's memory.
     */
    const runJs = (name, input, double, module, bounds = [0, Infinity])=>{
        // The x87's words as the call finds them; a control word the source
        // loads is the one the model's arithmetic rounds to from there on.
        let control = input.control ?? 0x37f;
        let status = (input.status ?? 0) & 0xc7ff;
        const span = spanOf(compiledOf(name));
        const memory = new Uint8Array(span > 0 ? 1 << 20 : DATA);
        for (const [address, bytes] of input.memory ?? [])
        {
            memory.set(Array.from(bytes), address);
        }
        /** @type {number[]} ST0 first */
        const st = [...input.x87 ?? []].reverse();
        let edx = 0xd5d5d5d5;
        const source = module[name];
        if (typeof source !== 'function')
        {
            throw new Error(`no source function ${name}`);
        }
        const { call } = double;
        let handedOver = false;
        const { host } = double;
        /**
         * An access past the test's memory, or the bounds given, refused.
         *
         * @param {number} address @param {number} length @param {string} what
         */
        const reach = (address, length, what)=>{
            if (address + length > memory.length || address < bounds[0]
                || address + length > bounds[1])
            {
                throw new RangeError(`${what} past the test's memory at 0x${address.toString(16)}`);
            }
        };
        const entry = guestEntry(source, compiledOf(name), {
            readMemory: (address, length)=>{
                reach(address, length, 'read');
                return memory.subarray(address, address + length);
            },
            writeMemory: (address, bytes)=>{
                reach(address, bytes.length, 'write');
                memory.set(bytes, address);
            },
            // Bounded first: a count past the test's memory is refused before
            // a buffer of its length is made.
            fillMemory: (address, value, length)=>{
                reach(address, length, 'fill');
                memory.fill(value, address, address + length);
            },
            fpu: {
                setResult: value=>void st.unshift(value),
                get: index=>st[index],
                pop: ()=>void st.shift(),
                controlWord: ()=>control,
                setControlWord: word=>{
                    control = word & 0xffff;
                    if (model && module === model.module)
                    {
                        model.$.control = control;
                    }
                },
                statusWord: ()=>status,
                clearExceptions: ()=>{
                    status &= 0x7f00;
                },
            },
            setRegisters: values=>{
                edx = values.edx >>> 0;
            },
            ...call ? { call: (fn, args)=>call(memory, fn, args) } : {},
        }, host ? {
            argBytes: 0,
            handler: args=>{
                handedOver = true;
                const onStack = compiledOf(name).params.filter(type=>type === 'x87').length;
                const answer = host(memory, args, st.slice(0, onStack).reverse());
                if (typeof answer === 'number')
                {
                    return answer;
                }
                st.splice(0, onStack, answer.st0);
                return 0;
            },
        } : undefined);
        if (!entry.handler)
        {
            throw new Error(`${name} calls the guest, and the case gives no stand-in`);
        }
        const eax = entry.handler([...input.stack ?? []]) >>> 0;
        return { eax, edx, st, data: memory.slice(DATA, DATA + span), handedOver, control,
            status };
    };

    return {
        /**
         * Runs one input both ways; answers the JavaScript's result.
         *
         * @param {string} name @param {Case} input @param {Double} [double]
         */
        same(name, input, double = {}){
            const fn = compiledOf(name);
            const x86 = runX86(name, input, double);
            const single = ((input.control ?? 0x37f) & 0x300) === 0;
            if (model)
            {
                model.$.control = input.control ?? 0x37f;
            }
            // A function that loads a control word may round from there on: the
            // model follows the word it loads, whatever the call came under.
            const rounds = single || fn.uses.includes('setControlWord');
            const js = runJs(name, input, double, rounds && model ? model.module : sources);
            const what = `${name}(${JSON.stringify(input.stack ?? [])}${input.x87
                ? `, st ${JSON.stringify(input.x87)}` : ''}) under 0x${(input.control ?? 0x37f)
                .toString(16)}`;
            assert.equal(x86.handedOver, js.handedOver,
                `${what}: handed to the host by both or by neither`);
            assert.deepEqual(x86.saved, SAVED, `${what}: EBX, ESI, EDI and EBP kept`);
            // A thiscall function's `this` came in ECX, not in a slot of the caller's.
            const popped = fn.convention !== 'cdecl'
                ? fn.params.reduce((sum, type)=>sum + (type === 'f64' ? 8
                    : type === 'x87' ? 0 : 4), 0) - (fn.convention === 'thiscall' ? 4 : 0)
                : 0;
            assert.equal(x86.esp, STACK + 4 + popped, `${what}: ESP past the return address`);
            assert.equal(x86.df, false, `${what}: the direction flag clear`);
            assert.equal(x86.control, js.control, `${what}: the control word`);
            if (fn.uses.includes('clearExceptions'))
            {
                assert.equal(x86.status & 0xbf, js.status & 0xbf,
                    `${what}: the exception flags`);
            }
            if (fn.returns === 'f64' || fn.returns === 'f32')
            {
                assert.equal(x86.st.length, 1, `${what}: one double on the x87 stack`);
                assert.ok(sameDouble(x86.st[0], js.st[0]),
                    `${what}: ${x86.st[0]} against ${js.st[0]}`);
            }
            else
            {
                assert.equal(x86.st.length, 0, `${what}: the x87 stack empty`);
            }
            if (fn.returns !== 'f64' && fn.returns !== 'f32' && fn.returns !== 'void')
            {
                assert.equal(x86.eax, js.eax, `${what}: EAX`);
            }
            if (fn.returns === 'i64')
            {
                assert.equal(x86.edx, js.edx, `${what}: EDX`);
            }
            const at = firstDifference(x86.data, js.data);
            if (at >= 0)
            {
                assert.fail(`${what}: memory differs first at 0x${(DATA + at).toString(16)}: `
                    + `${x86.data[at]} against ${js.data[at]}`);
            }
            // The model's rounding is the x87's; x86-64 code's doubles are
            // SSE2's, the source's own.
            sameLong(name, input, double, rounds && model ? runJs(name, input, double, sources)
                : js, what);
            return js;
        },

        /**
         * Runs one input through the JavaScript and the x86-64 code alone:
         * what a function the build made x86-64 code for is held to where
         * its i386 is no part of the question.
         *
         * @param {string} name @param {Case} input @param {Double} [double]
         * @param {[number, number]} [bounds]  The addresses the input may reach,
         *     [from, to): one that reaches past them is refused with a
         *     RangeError before the x86-64 runs, as one past the test's memory is.
         */
        sameAt64(name, input, double = {}, bounds = undefined){
            if (longOf(name) === undefined)
            {
                throw new Error(`no x86-64 code for ${name}`);
            }
            const js = runJs(name, input, double, sources, bounds);
            sameLong(name, input, double, js, `${name}(${JSON.stringify(input.stack ?? [])})`);
            return js;
        },
    };
}
