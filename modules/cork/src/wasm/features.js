/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What this engine's WebAssembly accepts, found out by offering it the
 * smallest module that needs each feature. The translator emits SIMD and
 * tail calls where it may; a machine without them gets the same program
 * through the other executor, never a validation error.
 */

import { Body, ModuleBuilder, SIMD_SCALAR, ValType } from './encoder.js';

/** @param {(m: ModuleBuilder) => void} build */
function validates(build){
    if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function')
    {
        return false;
    }
    try
    {
        const m = new ModuleBuilder();
        build(m);
        return WebAssembly.validate(m.toBytes());
    }
    catch (e){
        void e;
        return false;
    }
}

/**
 * The bits of `0 / 0` as this engine computes it in f32: the default NaN
 * the host's processor generates. An x86 host gives it with the sign bit
 * set (0xffc00000), which is what translated code must leave; on a host
 * whose default NaN is positive the emitter fixes the lanes up.
 */
function defaultNaNBits(){
    try
    {
        const m = new ModuleBuilder();
        const type = m.type({ params: [], results: [ValType.i32] });
        m.function(type, [], new Body().f32const(0).f32const(0).op(0x95).op(0xbc),
            { exportAs: 'f' });
        const { f } = /** @type {{ f: () => number }} */ (
            new WebAssembly.Instance(new WebAssembly.Module(m.toBytes()), {}).exports);
        return f() >>> 0;
    }
    catch (e){
        void e;
        return 0;
    }
}

/**
 * @typedef {Object} Features
 * @property {boolean} simd
 * @property {boolean} tailCalls
 * @property {boolean} sharedMemory
 * @property {boolean} defaultNaNNegative  the host's default NaN has its sign set, as x86's
 * @property {boolean} [armHost]  an arm64 host's code made with x86's NaN all the same (the
 *     runtime's `exactNaN` off): what else differs between the two hosts follows this
 * @property {boolean} [wideLanes]  a wide window's: the engine reads and writes the RAM's
 *     lane and zero-extending vector accesses past 4 GiB as they are (`wideLanes`)
 */

/** @returns {Features} */
export function features(){
    return {
        defaultNaNNegative: defaultNaNBits() === 0xffc00000,
        // A function that splats a constant into a v128 and drops it.
        simd: validates(m=>{
            const type = m.type({ params: [], results: [] });
            m.function(type, [], new Body().i32const(1).simd(15).drop());
        }),
        // A function that returns by calling itself.
        tailCalls: validates(m=>{
            const type = m.type({ params: [], results: [] });
            m.function(type, [], new Body().returnCall(0));
        }),
        sharedMemory: (()=>{
            try
            {
                return typeof SharedArrayBuffer === 'function'
                    && new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
                        .buffer instanceof SharedArrayBuffer;
            }
            catch (e){
                void e;
                return false;
            }
        })(),
    };
}

/** The bytes the lane probe leaves in the window's last page, the same from every probe. */
const LANE_PATTERN = Uint8Array.from({ length: 16 * 32 }, (_, at)=>(at * 37 + 11) & 255);

/**
 * Whether this engine reads and writes the lane and zero-extending vector
 * accesses (`v128.load32_zero`, `load64_zero`, the lane loads and stores) of a
 * wide window's RAM, a `memory64` memory second in the module, at computed
 * addresses past 4 GiB as it reads its scalar accesses there: V8 12 (node
 * 22.21) read the loads as zeros, so a wide window's code made each its scalar
 * access and a lane operation (`Body.simdScalar`), seven machine instructions
 * more a `movss` load. Each access is made as translated code makes it - the
 * address `whole` with the i32 for its low half (`Body.widenGuest`) - in a
 * function of its own, called with an address in the window's last page, which
 * is never RAM; every probe writes the same bytes there, so two runtimes
 * probing one window at once leave each other's answer as it is. A memory that
 * does not reach past 4 GiB, or any failure, answers false: the scalar forms,
 * right on every engine.
 *
 * @param {WebAssembly.Memory} ram  the window's RAM
 */
export function wideLanes(ram){
    try
    {
        const length = ram.buffer.byteLength;
        if (length <= 2 ** 32)
        {
            return false;
        }
        const shared = typeof SharedArrayBuffer === 'function'
            && ram.buffer instanceof SharedArrayBuffer;
        const at = length - 4096;
        const bytes = new Uint8Array(ram.buffer, at, LANE_PATTERN.length);
        const out = new WebAssembly.Memory({ initial: 1, maximum: 1 });
        const m = new ModuleBuilder();
        m.importMemory('env', 'out', { min: 1, max: 1 });
        m.importMemory('env', 'ram', { min: length / 65536, max: length / 65536, shared,
            index64: true });
        const type = m.type({ params: [ValType.i64], results: [] });
        const opcodes = [...SIMD_SCALAR.keys()];
        for (const [index, opcode] of opcodes.entries())
        {
            const scalar = /** @type {{ store: boolean, zero?: number }} */ (
                SIMD_SCALAR.get(opcode));
            const size = sizeOf(opcode);
            const lane = scalar.zero === undefined ? 0 : undefined;
            const b = new Body();
            b.guest = { memory: 1, whole: 0, scratch: ()=>1, lanes: true };
            if (!scalar.store)
            {
                b.i32const(index * 16);
            }
            b.localGet(0).op(0xa7);
            if (lane !== undefined)
            {
                b.v128const(scalar.store
                    ? LANE_PATTERN.subarray(index * 32, index * 32 + 16) : new Array(16).fill(0));
            }
            b.simdMem(opcode, { align: Math.log2(size), offset: 0, lane, guest: true });
            if (!scalar.store)
            {
                b.storeV128();
            }
            m.function(type, [ValType.v128], b, { exportAs: `f${index}` });
        }
        const exports = /** @type {Record<string, (address: bigint) => void>} */ (
            new WebAssembly.Instance(new WebAssembly.Module(m.toBytes()),
                { env: { out, ram } }).exports);
        bytes.set(LANE_PATTERN);
        const answers = new Uint8Array(out.buffer);
        return opcodes.every((opcode, index)=>{
            const size = sizeOf(opcode);
            const from = index * 32;
            const store = /** @type {{ store: boolean }} */ (SIMD_SCALAR.get(opcode)).store;
            if (store)
            {
                bytes.fill(0, from, from + size);
            }
            // Called a few times: an engine may make its code over again by then.
            for (let i = 0; i < 4; i++)
            {
                exports[`f${index}`](BigInt(at + from));
            }
            const got = store ? bytes.subarray(from, from + 16)
                : answers.subarray(index * 16, index * 16 + 16);
            const want = store ? LANE_PATTERN.subarray(from, from + 16)
                : [...LANE_PATTERN.subarray(from, from + size), ...new Array(16 - size).fill(0)];
            return got.every((byte, i)=>byte === want[i]);
        });
    }
    catch (e){
        void e;
        return false;
    }
}

/** The bytes a lane or zero-extending access reads or writes. @param {number} opcode */
function sizeOf(opcode){
    const scalar = /** @type {{ kind: string, zero?: number }} */ (SIMD_SCALAR.get(opcode));
    return scalar.zero ?? (scalar.kind.startsWith('i64') ? 8 : scalar.kind.endsWith('8u')
        || scalar.kind.endsWith('_8') ? 1 : scalar.kind.endsWith('16u')
        || scalar.kind.endsWith('_16') ? 2 : 4);
}

/**
 * A `memory64` memory of `bytes`, made whole (`initial` = `maximum`): a shared
 * one of 16 GiB is refused growing from a page and made at its size. The JS
 * API asks for it as `address: 'i64'` with BigInt sizes (the standard, as
 * Chrome takes it) or as `index: 'i64'` with numbers (node 22, whose V8 had it
 * behind `--experimental-wasm-memory64` before taking it by default:
 * `testing/memory64.js`); the first the engine takes is made.
 *
 * @param {number} bytes  a multiple of a wasm page
 * @param {boolean} [shared]
 * @returns {WebAssembly.Memory}
 */
export function memory64(bytes, shared = false){
    const pages = bytes / 65536;
    const asks = [
        { address: 'i64', shared, initial: BigInt(pages), maximum: BigInt(pages) },
        { address: 'i64', shared, initial: pages, maximum: pages },
        { index: 'i64', shared, initial: pages, maximum: pages },
    ];
    /** @type {string[]} */
    const refused = [];
    for (const ask of asks)
    {
        try
        {
            const memory = new WebAssembly.Memory(/** @type {any} */ (ask));
            // An engine that ignores the 64-bit key makes a 32-bit memory, or refuses its size.
            if (memory.buffer.byteLength === bytes)
            {
                return memory;
            }
            refused.push(`${Object.keys(ask)[0]}: ${memory.buffer.byteLength} bytes made`);
        }
        catch (e){
            const form = typeof ask.initial === 'bigint' ? ' (BigInt)' : '';
            refused.push(`${Object.keys(ask)[0]}${form}: `
                + String(/** @type {Error} */ (e)?.message ?? e));
        }
    }
    throw new RangeError(`memory64 of ${bytes} bytes${shared ? ', shared' : ''} not made: `
        + refused.join('; '));
}
