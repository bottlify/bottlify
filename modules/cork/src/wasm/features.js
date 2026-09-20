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
 * @returns {{ simd: boolean, tailCalls: boolean, sharedMemory: boolean }}
 */
export function features(){
    return {
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
