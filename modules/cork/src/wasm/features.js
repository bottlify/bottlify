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

import { Body, ModuleBuilder, ValType } from './encoder.js';

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
        m.function(type, [], new Body().f32const(0).f32const(0).op(0x95).op(0xbc).toBytes(),
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
 */

/** @returns {Features} */
export function features(){
    return {
        defaultNaNNegative: defaultNaNBits() === 0xffc00000,
        // A function that splats a constant into a v128 and drops it.
        simd: validates(m=>{
            const type = m.type({ params: [], results: [] });
            m.function(type, [], new Body().i32const(1).simd(15).drop().toBytes());
        }),
        // A function that returns by calling itself.
        tailCalls: validates(m=>{
            const type = m.type({ params: [], results: [] });
            m.function(type, [], new Body().returnCall(0).toBytes());
        }),
        sharedMemory: (()=>{
            try
            {
                return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
                    .buffer instanceof SharedArrayBuffer;
            }
            catch (e){
                void e;
                return false;
            }
        })(),
    };
}

export { ValType };
