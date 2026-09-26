/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runtime functions that are code in the guest's own msvcrt rather than
 * handlers on the host: an export whose data is these bytes is called as any
 * function is, and the translator runs it with the program's own code. A
 * function that calls back into the program -- qsort's comparator -- then
 * makes an ordinary `call`, where a handler had to run the guest from the host
 * once a comparison.
 *
 * Such a function is written once, in JavaScript, marked `@guestCode`
 * (`inguest.js`); the build compiles it to i386 (`scripts/guest-code/`) into
 * a module beside it (`inguest.x86.js`), and `guestEntry` makes the export of
 * the two: the x86 in its slot, the JavaScript as its handler -- the
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
 * @property {import('./float.js').FloatHost} [fpu]
 *     Where an f64 result goes and an x87 argument comes from.
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *     Where an i64 result's high half goes.
 * @property {(fn: number, args: number[]) => number} [call]
 *     A guest function run to its return, synchronously; without it a
 *     function that calls one has no handler.
 */

/**
 * An export whose slot holds the compiled x86, with no handler: what a
 * function that calls a guest function is, since the engine cannot run the
 * guest from a handler and wait for it.
 *
 * @param {CompiledGuestCode} compiled
 */
export function guestExport(compiled){
    const argBytes = compiled.params.reduce((sum, type)=>
        sum + (type === 'f64' ? 8 : type === 'x87' ? 0 : 4), 0);
    return { convention: compiled.convention, argBytes, data: ()=>compiled.code };
}

/**
 * An export whose slot holds the compiled x86 and whose handler is the
 * same function in JavaScript, its arguments read off the stack as the x86
 * reads them and its result answered where the x86 leaves it.
 *
 * @param {Function} source  The `@guestCode` function.
 * @param {CompiledGuestCode} compiled
 * @param {EntryHost} host
 * @returns {{ convention: string, argBytes: number, data: () => Uint8Array,
 *     handler: (args: number[]) => number }}
 */
export function guestEntry(source, compiled, host){
    const { params, returns, uses } = compiled;
    if (uses.includes('call') && !host.call)
    {
        throw new Error('guest code: a function that calls the guest has no handler here '
            + '(guestExport)');
    }
    const { readMemory, writeMemory, call } = host;
    if (uses.length > 0 && (!readMemory || !writeMemory))
    {
        throw new Error('guest code: a function that reads the guest wants its memory');
    }
    const guest = uses.length > 0 && readMemory && writeMemory
        ? guestMemory({ readMemory, writeMemory, ...call ? { call } : {} }) : null;
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

const JE = [0x0f, 0x84];
const JAE = [0x0f, 0x83];
const JB = [0x0f, 0x82];
const JLE = [0x0f, 0x8e];
const JMP = [0xe9];
const JNZ = [0x75];

/**
 * void qsort(void *base, size_t num, size_t width, int (*compare)(const void *, const void *))
 *
 * Shell's sort with the gaps halved, in place: the elements are swapped in
 * the program's memory as they move, so the comparator is always handed the
 * real addresses of the array as it stands. The order of equal elements is
 * not kept -- the standard promises none, and msvcrt's own sort keeps none.
 * cdecl, the arguments at [ebp+8..20]; the gap at [ebp-16] and the outer
 * index at [ebp-20]; esi the inner index, edi and ebx the two elements.
 */
export const QSORT_CODE = assemble([
    [0x55, 0x89, 0xe5, 0x53, 0x56, 0x57],       // push ebp; mov ebp, esp; push ebx, esi, edi
    [0x83, 0xec, 0x08],                         // sub esp, 8
    [0x83, 0x7d, 0x10, 0x00],                   // cmp dword [width], 0
    { jump: JE, to: 'done' },
    [0x8b, 0x45, 0x0c, 0xd1, 0xe8],             // mov eax, [num]; shr eax, 1
    [0x89, 0x45, 0xf0],                         // mov [gap], eax
    'outer',
    [0x83, 0x7d, 0xf0, 0x00],                   // cmp dword [gap], 0
    { jump: JE, to: 'done' },
    [0x8b, 0x45, 0xf0, 0x89, 0x45, 0xec],       // mov eax, [gap]; mov [i], eax
    'nextElement',
    [0x8b, 0x45, 0xec, 0x3b, 0x45, 0x0c],       // mov eax, [i]; cmp eax, [num]
    { jump: JAE, to: 'halve' },
    [0x89, 0xc6],                               // mov esi, eax
    'shift',
    [0x3b, 0x75, 0xf0],                         // cmp esi, [gap]
    { jump: JB, to: 'advance' },
    [0x89, 0xf0, 0x2b, 0x45, 0xf0],             // mov eax, esi; sub eax, [gap]
    [0x0f, 0xaf, 0x45, 0x10, 0x03, 0x45, 0x08], // imul eax, [width]; add eax, [base]
    [0x89, 0xc7],                               // mov edi, eax      ; element j - gap
    [0x89, 0xf0],                               // mov eax, esi
    [0x0f, 0xaf, 0x45, 0x10, 0x03, 0x45, 0x08], // imul eax, [width]; add eax, [base]
    [0x89, 0xc3],                               // mov ebx, eax      ; element j
    [0x53, 0x57, 0xff, 0x55, 0x14],             // push ebx; push edi; call [compare]
    [0x83, 0xc4, 0x08, 0x85, 0xc0],             // add esp, 8; test eax, eax
    { jump: JLE, to: 'advance' },
    [0x8b, 0x4d, 0x10],                         // mov ecx, [width]
    'swap',
    [0x8a, 0x07, 0x8a, 0x13, 0x88, 0x17, 0x88, 0x03], // mov al, [edi]; mov dl, [ebx]; swap them
    [0x47, 0x43, 0x49],                         // inc edi; inc ebx; dec ecx
    { jump: JNZ, to: 'swap', short: true },
    [0x2b, 0x75, 0xf0],                         // sub esi, [gap]
    { jump: JMP, to: 'shift' },
    'advance',
    [0xff, 0x45, 0xec],                         // inc dword [i]
    { jump: JMP, to: 'nextElement' },
    'halve',
    [0xd1, 0x6d, 0xf0],                         // shr dword [gap], 1
    { jump: JMP, to: 'outer' },
    'done',
    [0x83, 0xc4, 0x08, 0x5f, 0x5e, 0x5b, 0x5d, 0xc3], // add esp, 8; pop edi, esi, ebx, ebp; ret
]);
