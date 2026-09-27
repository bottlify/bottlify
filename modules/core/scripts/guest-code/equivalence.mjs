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
 * flag clear, the control word as it was, and the x87 stack empty but for a
 * double result.
 *
 * A function that hands a call to the host (`return host()`) jumps, on the
 * machine, to a halt where the host's trap would be; there it must have left
 * everything as the call found it -- ESP at the return address, the
 * arguments, EBX, ESI, EDI and EBP, the direction flag, the control word, the
 * x87 stack and every byte of memory -- and the case's stand-in for the
 * handler answers from there. The JavaScript must hand over the same inputs.
 *
 * For the tests: the machine is cork's own test machine, not the engine.
 */

import assert from 'node:assert/strict';
import { createTestMachine } from '../../../cork/src/testing/machine.js';
import { guestEntry } from '../../src/layers/win32/msvcrt/guest-code.js';

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
 */

/**
 * @typedef {Object} Double
 * @property {number[]} [callback]    x86 at CALLBACK, which a call through a pointer reaches.
 * @property {(memory: Uint8Array, fn: number, args: number[]) => number} [call]
 *     Its JavaScript stand-in.
 * @property {(memory: Uint8Array, args: number[]) => number} [host]
 *     The host's handler a function hands a call to, over the case's memory.
 */

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
 * @param {Record<string, import('../../src/layers/win32/msvcrt/guest-code.js').CompiledGuestCode>}
 *     compiled
 * @param {Record<string, unknown>} sources  The module the functions are in.
 */
export function equivalence(compiled, sources){
    /** One machine per function: its translations kept from one input to the next. */
    /** @type {Map<string, ReturnType<typeof createTestMachine>>} */
    const machines = new Map();

    /** @param {string} name */
    const compiledOf = name=>{
        const found = compiled[name];
        if (!found)
        {
            throw new Error(`no compiled ${name}`);
        }
        return found;
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
                new DataView(code.buffer).setUint32(fn.host,
                    (HOST - (CODE + fn.host + 4)) >>> 0, true);
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
        new Uint8Array(m.memory.buffer, m.layout.ramBase + DATA, DATA_END - DATA).fill(0);
        for (const [address, bytes] of input.memory ?? [])
        {
            m.write(address, Array.from(bytes));
        }
        m.writeU32(STACK, HALT);
        (input.stack ?? []).forEach((word, i)=>m.writeU32(STACK + 4 + i * 4, word));
        m.setReg('esp', STACK);
        m.setReg('eax', 0xa5a5a5a5);
        m.setReg('ecx', 0xc5c5c5c5);
        m.setReg('edx', 0xd5d5d5d5);
        for (const [reg, value] of Object.entries(SAVED))
        {
            m.setReg(reg, value);
        }
        m.setEflags(2);
        view.setUint16(m.layout.x87Control, input.control ?? 0x37f, true);
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
        const before = m.read(DATA, DATA_END - DATA);
        const slots = fn.params.reduce((sum, type)=>sum + (type === 'f64' ? 2
            : type === 'x87' ? 0 : 1), 0);
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3, `${name} halts at its return (${JSON.stringify(exit)})`);
        const handedOver = fn.host !== undefined && m.eip() === HOST + 1;
        if (handedOver)
        {
            return handOver(name, m, input, double, before, slots, { top, empty });
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
        return {
            eax: m.reg('eax'), edx: m.reg('edx'), esp: m.reg('esp'), st,
            saved: { ebx: m.reg('ebx'), esi: m.reg('esi'), edi: m.reg('edi'), ebp: m.reg('ebp') },
            df: (m.eflags() & 0x400) !== 0,
            control: view.getUint16(m.layout.x87Control, true),
            data: m.read(DATA, DATA_END - DATA),
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
        assert.equal(m.reg('esp'), STACK, `${what}: ESP at the return address`);
        assert.equal(m.readU32(STACK), HALT, `${what}: the return address kept`);
        const args = Array.from({ length: slots }, (_, i)=>m.readU32(STACK + 4 + i * 4));
        assert.deepEqual(args, (input.stack ?? []).slice(0, slots).map(word=>word >>> 0),
            `${what}: the arguments kept`);
        assert.deepEqual({ ebx: m.reg('ebx'), esi: m.reg('esi'), edi: m.reg('edi'),
            ebp: m.reg('ebp') }, SAVED, `${what}: EBX, ESI, EDI and EBP kept`);
        assert.equal((m.eflags() & 0x400) !== 0, false, `${what}: the direction flag clear`);
        assert.equal(view.getUint16(m.layout.x87Control, true), input.control ?? 0x37f,
            `${what}: the control word`);
        assert.deepEqual({ top: view.getUint8(m.layout.x87Top),
            empty: view.getUint8(m.layout.x87Empty) }, x87, `${what}: the x87 stack as it was`);
        const data = m.read(DATA, DATA_END - DATA);
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
        const eax = double.host(memory, args) >>> 0;
        // The trap returns as the export does: a stdcall one pops the arguments.
        const popped = compiledOf(name).convention === 'stdcall' ? slots * 4 : 0;
        return {
            eax, edx: 0, esp: STACK + 4 + popped, st: [], saved: SAVED, df: false,
            control: input.control ?? 0x37f, data: memory.slice(DATA, DATA_END), handedOver: true,
        };
    };

    /** @param {string} name @param {Case} input @param {Double} double */
    const runJs = (name, input, double)=>{
        const memory = new Uint8Array(1 << 20);
        for (const [address, bytes] of input.memory ?? [])
        {
            memory.set(Array.from(bytes), address);
        }
        /** @type {number[]} ST0 first */
        const st = [...input.x87 ?? []].reverse();
        let edx = 0xd5d5d5d5;
        const source = sources[name];
        if (typeof source !== 'function')
        {
            throw new Error(`no source function ${name}`);
        }
        const { call } = double;
        let handedOver = false;
        const { host } = double;
        const entry = guestEntry(source, compiledOf(name), {
            readMemory: (address, length)=>{
                if (address + length > memory.length)
                {
                    throw new RangeError('read past the test\'s memory at '
                        + `0x${address.toString(16)}`);
                }
                return memory.subarray(address, address + length);
            },
            writeMemory: (address, bytes)=>memory.set(bytes, address),
            fpu: {
                setResult: value=>void st.unshift(value),
                get: index=>st[index],
                pop: ()=>void st.shift(),
            },
            setRegisters: values=>{
                edx = values.edx >>> 0;
            },
            ...call ? { call: (fn, args)=>call(memory, fn, args) } : {},
        }, host ? {
            argBytes: 0,
            handler: args=>{
                handedOver = true;
                return host(memory, args);
            },
        } : undefined);
        if (!entry.handler)
        {
            throw new Error(`${name} calls the guest, and the case gives no stand-in`);
        }
        const eax = entry.handler([...input.stack ?? []]) >>> 0;
        return { eax, edx, st, data: memory.slice(DATA, DATA_END), handedOver };
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
            const js = runJs(name, input, double);
            const what = `${name}(${JSON.stringify(input.stack ?? [])}${input.x87
                ? `, st ${JSON.stringify(input.x87)}` : ''}) under 0x${(input.control ?? 0x37f)
                .toString(16)}`;
            assert.equal(x86.handedOver, js.handedOver,
                `${what}: handed to the host by both or by neither`);
            assert.deepEqual(x86.saved, SAVED, `${what}: EBX, ESI, EDI and EBP kept`);
            const popped = fn.convention === 'stdcall'
                ? fn.params.reduce((sum, type)=>sum + (type === 'f64' ? 8
                    : type === 'x87' ? 0 : 4), 0)
                : 0;
            assert.equal(x86.esp, STACK + 4 + popped, `${what}: ESP past the return address`);
            assert.equal(x86.df, false, `${what}: the direction flag clear`);
            assert.equal(x86.control, input.control ?? 0x37f, `${what}: the control word`);
            if (fn.returns === 'f64')
            {
                assert.equal(x86.st.length, 1, `${what}: one double on the x87 stack`);
                assert.ok(sameDouble(x86.st[0], js.st[0]),
                    `${what}: ${x86.st[0]} against ${js.st[0]}`);
            }
            else
            {
                assert.equal(x86.st.length, 0, `${what}: the x87 stack empty`);
            }
            if (fn.returns !== 'f64' && fn.returns !== 'void')
            {
                assert.equal(x86.eax, js.eax, `${what}: EAX`);
            }
            if (fn.returns === 'i64')
            {
                assert.equal(x86.edx, js.edx, `${what}: EDX`);
            }
            if (!Buffer.from(x86.data).equals(Buffer.from(js.data)))
            {
                const at = x86.data.findIndex((byte, i)=>byte !== js.data[i]);
                assert.fail(`${what}: memory differs first at 0x${(DATA + at).toString(16)}: `
                    + `${x86.data[at]} against ${js.data[at]}`);
            }
            return js;
        },
    };
}
