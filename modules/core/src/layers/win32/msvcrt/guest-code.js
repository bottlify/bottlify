/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runtime functions that are code in the guest's own msvcrt rather than
 * handlers on the host: an export whose `code` is these bytes is placed in
 * the module's code section, on pages apart from its variables, is called as
 * any function is, and the translator runs it with the program's own code. A
 * function that calls back into the program -- qsort's comparator -- then
 * makes an ordinary `call`, where a handler had to run the guest from the host
 * once a comparison.
 *
 * Such a function is written once, in JavaScript, marked `@guestCode`
 * (`inguest.js`); the build compiles it to i386 (`scripts/guest-code/`) into
 * a module beside it (`inguest.x86.js`), and `guestEntry` makes the export of
 * the two: the x86 as its code, the JavaScript as its handler -- the
 * reference the x86 is tested against, and the answer wherever a handler is
 * asked for directly.
 */

/** @typedef {number} i32  A signed 32-bit stack slot, or EAX. */
/** @typedef {number} u32  An unsigned 32-bit stack slot, or EAX. */
/** @typedef {number} f64  A double: two stack slots, or ST0 as a result. */
/** @typedef {number} x87  A double the caller left on the x87 stack, which the callee pops. */
/** @typedef {number} i64  A result in EDX:EAX. */

/**
 * What the build made of a `@guestCode` function.
 *
 * @typedef {Object} CompiledGuestCode
 * @property {'cdecl' | 'stdcall'} convention
 * @property {readonly ('i32' | 'u32' | 'f64' | 'x87')[]} params
 * @property {'i32' | 'u32' | 'f64' | 'i64' | 'void'} returns
 * @property {readonly string[]} uses   The guest's helpers the source takes.
 * @property {Uint8Array} code
 */

/**
 * The guest as a `@guestCode` function sees it: its memory by address, and
 * a cdecl function pointer to call. Addresses wrap at 2^32 and a store keeps
 * the low bits of its value, as the x86 does.
 *
 * @typedef {Object} Guest
 * @property {(address: number) => number} u8
 * @property {(address: number) => number} i8
 * @property {(address: number) => number} u16
 * @property {(address: number) => number} i16
 * @property {(address: number) => number} u32
 * @property {(address: number) => number} i32
 * @property {(address: number) => number} f32
 * @property {(address: number) => number} f64
 * @property {(address: number, value: number) => void} setU8
 * @property {(address: number, value: number) => void} setU16
 * @property {(address: number, value: number) => void} setU32
 * @property {(address: number, value: number) => void} setF64
 * @property {(destination: number, source: number, count: number) => void} copyUp
 *     Byte by byte from the first, as `rep movsb` copies: a destination just
 *     past the source repeats the source's first bytes.
 * @property {(destination: number, source: number, count: number) => void} copyDown
 *     Byte by byte from the last, as `std; rep movsb` copies.
 * @property {(destination: number, value: number, count: number) => void} fill
 * @property {(fn: number, ...args: number[]) => number} call
 */

/**
 * @typedef {Object} GuestHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, value: number, length: number) => void} [fillMemory]
 *     A range set to one byte in place, with no buffer of the length made.
 * @property {(fn: number, args: number[]) => number} [call]
 *     A guest function run to its return, synchronously: a test's stand-in.
 *     The engine has none -- running the guest from the host is a wait --
 *     so a function that calls one has no handler, only its x86.
 */

/**
 * The guest's memory as the helpers read and write it.
 *
 * @param {GuestHost} host
 * @returns {Guest}
 */
export function guestMemory(host){
    /** @param {number} address @param {number} length */
    const view = (address, length)=>{
        const bytes = host.readMemory(address >>> 0, length);
        return new DataView(bytes.buffer, bytes.byteOffset, length);
    };
    /** @param {number} address @param {number} length @param {(v: DataView) => void} fill */
    const write = (address, length, fill)=>{
        const bytes = new Uint8Array(length);
        fill(new DataView(bytes.buffer));
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} address */
    const u8 = address=>host.readMemory(address >>> 0, 1)[0];
    /** @param {number} address @param {number} value */
    const setU8 = (address, value)=>host.writeMemory(address >>> 0, Uint8Array.of(value));
    return {
        u8,
        i8: address=>view(address, 1).getInt8(0),
        u16: address=>view(address, 2).getUint16(0, true),
        i16: address=>view(address, 2).getInt16(0, true),
        u32: address=>view(address, 4).getUint32(0, true),
        i32: address=>view(address, 4).getInt32(0, true),
        f32: address=>view(address, 4).getFloat32(0, true),
        f64: address=>view(address, 8).getFloat64(0, true),
        setU8,
        setU16: (address, value)=>write(address, 2, v=>v.setUint16(0, value, true)),
        setU32: (address, value)=>write(address, 4, v=>v.setUint32(0, value, true)),
        setF64: (address, value)=>write(address, 8, v=>v.setFloat64(0, value, true)),
        copyUp: (destination, source, count)=>{
            const length = count >>> 0;
            // Apart, or the destination below: a copy of the whole reads the
            // same bytes the ascending one does.
            if ((destination - source >>> 0) >= length)
            {
                host.writeMemory(destination >>> 0, host.readMemory(source >>> 0, length).slice());
                return;
            }
            for (let i = 0; i < length; i++)
            {
                setU8(destination + i, u8(source + i));
            }
        },
        copyDown: (destination, source, count)=>{
            const length = count >>> 0;
            if ((source - destination >>> 0) >= length)
            {
                host.writeMemory(destination >>> 0, host.readMemory(source >>> 0, length).slice());
                return;
            }
            for (let i = length - 1; i >= 0; i--)
            {
                setU8(destination + i, u8(source + i));
            }
        },
        fill: (destination, value, count)=>{
            if (host.fillMemory)
            {
                host.fillMemory(destination >>> 0, value & 0xff, count >>> 0);
                return;
            }
            host.writeMemory(destination >>> 0, new Uint8Array(count >>> 0).fill(value & 0xff));
        },
        call: (fn, ...args)=>{
            if (!host.call)
            {
                throw new Error('guest code: no guest function can be run from here');
            }
            return host.call(fn >>> 0, args.map(arg=>arg >>> 0)) | 0;
        },
    };
}

/**
 * @typedef {Object} EntryHost
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *     With writeMemory, wanted by a function that takes the guest's helpers.
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 * @property {(address: number, value: number, length: number) => void} [fillMemory]
 * @property {import('./float.js').FloatHost} [fpu]
 *     Where an f64 result goes and an x87 argument comes from.
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *     Where an i64 result's high half goes.
 * @property {(fn: number, args: number[]) => number} [call]
 *     A guest function run to its return, synchronously; without it a
 *     function that calls one has no handler.
 */

/**
 * An export that is the compiled x86, with no handler: what a
 * function that calls a guest function is, since the engine cannot run the
 * guest from a handler and wait for it.
 *
 * @param {CompiledGuestCode} compiled
 */
export function guestExport(compiled){
    const argBytes = compiled.params.reduce((sum, type)=>
        sum + (type === 'f64' ? 8 : type === 'x87' ? 0 : 4), 0);
    return { convention: compiled.convention, argBytes, code: ()=>compiled.code };
}

/**
 * An export that is the compiled x86 and whose handler is the
 * same function in JavaScript, its arguments read off the stack as the x86
 * reads them and its result answered where the x86 leaves it.
 *
 * @param {Function} source  The `@guestCode` function.
 * @param {CompiledGuestCode} compiled
 * @param {EntryHost} host
 * @returns {{ convention: string, argBytes: number, code: () => Uint8Array,
 *     handler: (args: number[]) => number }}
 */
export function guestEntry(source, compiled, host){
    const { params, returns, uses } = compiled;
    if (uses.includes('call') && !host.call)
    {
        throw new Error('guest code: a function that calls the guest has no handler here '
            + '(guestExport)');
    }
    const { readMemory, writeMemory, fillMemory, call } = host;
    if (uses.length > 0 && (!readMemory || !writeMemory))
    {
        throw new Error('guest code: a function that reads the guest wants its memory');
    }
    const guest = uses.length > 0 && readMemory && writeMemory
        ? guestMemory({ readMemory, writeMemory, ...fillMemory ? { fillMemory } : {},
            ...call ? { call } : {} }) : null;
    const onStack = params.filter(type=>type === 'x87').length;
    /** @param {number[]} args */
    const handler = args=>{
        /** @type {number[]} */
        const values = [];
        let slot = 0;
        let x87 = onStack;
        for (const type of params)
        {
            if (type === 'x87')
            {
                values.push(/** @type {import('./float.js').FloatHost} */ (host.fpu).get(--x87));
            }
            else if (type === 'f64')
            {
                const bits = new DataView(new ArrayBuffer(8));
                bits.setUint32(0, args[slot] >>> 0, true);
                bits.setUint32(4, args[slot + 1] >>> 0, true);
                values.push(bits.getFloat64(0, true));
                slot += 2;
            }
            else
            {
                values.push(type === 'i32' ? args[slot] | 0 : args[slot] >>> 0);
                slot++;
            }
        }
        for (let i = 0; i < onStack; i++)
        {
            /** @type {import('./float.js').FloatHost} */ (host.fpu).pop();
        }
        const result = guest === null ? source(...values) : source(guest, ...values);
        switch (returns)
        {
            case 'f64':
                /** @type {import('./float.js').FloatHost} */ (host.fpu).setResult(result);
                return 0;
            case 'i64':
            {
                const wide = toInt64(result);
                /** @type {(values: Record<string, number>) => void} */ (host.setRegisters)(
                    { edx: Number(BigInt.asUintN(32, wide >> 32n)) });
                return Number(BigInt.asUintN(32, wide));
            }
            case 'void':
                return 0;
            default:
                return result;
        }
    };
    return { ...guestExport(compiled), handler };
}

/**
 * An i64 result as the x86 makes it: an integer as it is, a double truncated
 * toward zero, and NaN or a double out of range the integer indefinite, which
 * `fisttp` stores.
 *
 * @param {number} value
 */
export function toInt64(value){
    const truncated = Math.trunc(value);
    if (!Number.isFinite(truncated) || truncated >= 2 ** 63 || truncated < -(2 ** 63))
    {
        return -(2n ** 63n);
    }
    return BigInt(truncated);
}

/**
 * A few instructions and the labels between them, assembled with every jump's
 * displacement filled in: each piece is bytes, a label, or a jump to one.
 *
 * @param {(number[] | string | { jump: number[], to: string, short?: boolean })[]} pieces
 * @returns {Uint8Array}
 */
export function assemble(pieces){
    /** @type {Map<string, number>} */
    const labels = new Map();
    let at = 0;
    for (const piece of pieces)
    {
        if (typeof piece === 'string')
        {
            labels.set(piece, at);
        }
        else if (Array.isArray(piece))
        {
            at += piece.length;
        }
        else
        {
            at += piece.jump.length + (piece.short ? 1 : 4);
        }
    }
    /** @type {number[]} */
    const out = [];
    for (const piece of pieces)
    {
        if (typeof piece === 'string')
        {
            continue;
        }
        if (Array.isArray(piece))
        {
            out.push(...piece);
            continue;
        }
        const target = labels.get(piece.to);
        if (target === undefined)
        {
            throw new Error(`assemble: no label ${piece.to}`);
        }
        out.push(...piece.jump);
        const rel = target - (out.length + (piece.short ? 1 : 4));
        if (piece.short)
        {
            if (rel < -128 || rel > 127)
            {
                throw new Error(`assemble: ${piece.to} is out of a short jump's reach`);
            }
            out.push(rel & 0xff);
        }
        else
        {
            out.push(rel & 0xff, rel >>> 8 & 0xff, rel >>> 16 & 0xff, rel >>> 24 & 0xff);
        }
    }
    return Uint8Array.from(out);
}
