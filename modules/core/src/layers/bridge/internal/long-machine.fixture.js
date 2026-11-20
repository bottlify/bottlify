/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit machine for a test of a host function's call: its registers
 * quadwords, its calls the x64 convention's (RCX, RDX -- which the stub keeps
 * in R11 -- R8, R9, then the stack past the return address and the home
 * space), its XMM registers four lanes each, its memory a map of dwords.
 */

import { Convention } from './conventions.js';
import { createParking } from './parking.js';
import { createDispatcher } from './dispatch.js';

/** Where the stack is: the return address at RSP, the fifth slot at RSP + 0x28. */
export const LONG_RSP = 0x8000;

/**
 * @param {Object} [options]
 * @param {Record<string, bigint>} [options.registers]
 * @param {Map<number, number[]>} [options.xmm]  Each register's four lanes.
 * @param {Map<number, number>} [options.words]  Guest memory, by dword address.
 * @param {(answer: any, frame: any) => void} [options.suspend]  Told of a call whose handler
 *     has not finished, as the bridge is.
 */
export function longMachine({ registers = {}, xmm = new Map(), words = new Map(),
    suspend = ()=>{} } = {})
{
    /** @type {Map<string, bigint>} */
    const r = new Map(Object.entries({ rsp: BigInt(LONG_RSP), rax: 0n, ...registers }));
    if (!words.has(LONG_RSP))
    {
        words.set(LONG_RSP, 0x401234);
    }
    const cpu = {
        bits: ()=>64,
        /** @param {string} name */
        readReg64: name=>r.get(name) ?? 0n,
        /** @param {string} name @param {bigint} value */
        writeReg64: (name, value)=>r.set(name, value),
        /** @param {string} name */
        readReg32: name=>Number((r.get(name === 'esp' ? 'rsp' : name) ?? 0n) & 0xffffffffn),
        writeReg32: ()=>{},
        /** @param {number} index */
        readXmm: index=>Uint32Array.from(xmm.get(index) ?? [0, 0, 0, 0]),
    };
    const memory = {
        /** @param {number} address */
        readU32: address=>words.get(address) ?? 0,
        writeU32: ()=>{},
    };
    const kernel = { currentThread: ()=>({ name: 'main' }), parkThread: ()=>{} };
    const dispatcher = createDispatcher({ cpu, memory, parking: createParking({ kernel }),
        suspend });
    return { dispatcher, r };
}

/**
 * A COM method called through the x64 path as its vtable slot registers it:
 * its spec's argBytes and marshalling, `this` first, the method handed the
 * arguments after it. What the method answers is RAX's low dword.
 *
 * @param {{ argBytes: number, quadwords?: number[], floats?: Record<number, 'f32' | 'f64'>,
 *     structs?: Record<number, number>, invoke?: (object: any, args: number[]) => any }} method
 * @param {any} object
 * @param {Parameters<typeof longMachine>[0]} machine
 * @returns {number}
 */
export function callLong(method, object, machine){
    const { dispatcher, r } = longMachine(machine);
    dispatcher.register(1, { name: 'X!Method', convention: Convention.STDCALL,
        argBytes: method.argBytes,
        ...method.quadwords ? { quadwords: method.quadwords } : {},
        ...method.floats ? { floats: method.floats } : {},
        ...method.structs ? { structs: method.structs } : {},
        /** @param {number[]} args */
        handler: args=>method.invoke?.(object, args.slice(1)) ?? 0 });
    dispatcher.dispatch(1);
    return Number(BigInt.asIntN(32, /** @type {bigint} */ (r.get('rax'))));
}
