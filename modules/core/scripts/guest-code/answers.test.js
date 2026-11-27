/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * RAX of a 64-bit call, the two ways one function answers it: its x86-64
 * code on cork's long-mode machine, and its handler through the bridge's
 * 64-bit trap, bound as an export binds it (`guestEntry`). A caller that
 * reads RAX whole - a `size_t`, a pointer - must find the same quadword
 * whichever answered, and the two part only from 2^31 up, where a dword is
 * extended by its sign or by zeros: the declared type says which, to both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileModule } from './compile.mjs';
import { CODE_64, callLong, longMachine } from './long.mjs';
import { longMachine as bridgeMachine } from '../../src/layers/bridge/internal/long-machine.fixture.js';
import { guestEntry, withLongCode } from '../../src/layers/win32/msvcrt/guest-code.js';

const SOURCE = `
/**
 * @guestCode cdecl
 * @param {i32} a
 * @returns {i32}
 */
export function signed(a){
    return (a ^ 0) | 0;
}

/**
 * @guestCode cdecl
 * @param {u32} a
 * @returns {u32}
 */
export function unsigned(a){
    return (a ^ 0) >>> 0;
}

/**
 * @guestCode cdecl
 * @param {ptr} a
 * @returns {ptr}
 */
export function pointer(a){
    return a + 0;
}

/**
 * @guestCode cdecl
 * @param {u32} a
 * @returns {ptr}
 */
export function made(a){
    return (a ^ 0) >>> 0;
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {i32} a
 * @returns {i32}
 */
export function signedOver({ host }, a){
    return host();
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} a
 * @returns {u32}
 */
export function unsignedOver({ host }, a){
    return host();
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} a
 * @returns {ptr}
 */
export function pointerOver({ host }, a){
    return host();
}
`;

/** Dwords either side of 2^31, where a sign and zeros part. */
const DWORDS = [0, 1, 0x7fffffff, 0x80000000, 0x80000005, 0x90000000, 0xfffffffe, 0xffffffff];
const HALT = 0x0f00;
const HOST = 0x0e00;

/** The source's functions, its two compilations paired as a build pairs them. */
async function load(){
    const url = `data:text/javascript;base64,${Buffer.from(SOURCE).toString('base64')}`;
    const values = await import(url);
    /** @param {32 | 64} bits */
    const compiled = bits=>Object.fromEntries(compileModule(SOURCE, { file: 'answers.js', bits })
        .map(fn=>[fn.name, fn]));
    const i386 = compiled(32);
    const long = compiled(64);
    withLongCode(i386, long);
    return { values, i386, long };
}

/**
 * RAX as the bridge's 64-bit trap leaves it for a spec whose handler is given
 * `value` in RCX.
 *
 * @param {Record<string, any>} spec @param {number} value
 */
function trapped(spec, value){
    const { dispatcher, r } = bridgeMachine({ registers: { rcx: BigInt(value) } });
    dispatcher.register(1, { name: 'X!Answer', ...spec });
    dispatcher.dispatch(1);
    return r.get('rax');
}

test('RAX from 2^31 up: the x86-64 code and the handler through the trap answer one quadword',
    async()=>{
        const { values, i386, long } = await load();
        for (const name of ['signed', 'unsigned', 'pointer', 'made'])
        {
            const m = longMachine();
            m.write(CODE_64, long[name].code);
            m.write(HALT, [0xf4]);
            const spec = guestEntry(values[name], i386[name], {});
            for (const value of DWORDS)
            {
                callLong(m, CODE_64, { args: [BigInt(value)], returnTo: HALT });
                assert.equal(trapped(spec, value), m.reg('rax'),
                    `${name}(0x${value.toString(16)}): the handler's RAX is the code's`);
            }
        }
        const signed = longMachine();
        signed.write(CODE_64, long.signed.code);
        signed.write(HALT, [0xf4]);
        callLong(signed, CODE_64, { args: [0x80000000n], returnTo: HALT });
        assert.equal(signed.reg('rax'), 0xffffffff80000000n, 'an i32 by its sign');
        assert.equal(trapped(guestEntry(values.unsigned, i386.unsigned, {}), 0x80000000),
            0x80000000n, 'a u32 by zeros');
    });

test('a call handed over is answered by the trap as the code would have: the declared type\'s',
    async()=>{
        const { values, i386, long } = await load();
        const expected = /** @type {Record<string, (value: number) => bigint>} */ ({
            signedOver: value=>BigInt.asUintN(64, BigInt(value | 0)),
            unsignedOver: value=>BigInt(value >>> 0),
            pointerOver: value=>BigInt(value >>> 0),
        });
        for (const [name, whole] of Object.entries(expected))
        {
            // The trap the x86-64 jumps to, as the binding registers it.
            /** @type {Record<string, any>[]} */
            const traps = [];
            const builder = { register: (/** @type {Record<string, any>} */ spec)=>{
                traps.push(spec);
                return HOST;
            }, jump: ()=>{} };
            /** @type {{ handler: (args: number[]) => number }} */
            const fallback = { handler: args=>args[0] };
            const entry = guestEntry(values[name], i386[name], {}, fallback);
            /** @type {(builder: any) => Uint8Array} */ (entry.long)(builder);
            assert.equal(traps.length, 1, `${name} registers its trap`);
            const m = longMachine();
            const code = long[name].code.slice();
            new DataView(code.buffer).setUint32(long[name].host,
                (HOST - (CODE_64 + long[name].host + 4)) >>> 0, true);
            m.write(CODE_64, code);
            m.write(HOST, [0xf4]);
            for (const value of DWORDS)
            {
                callLong(m, CODE_64, { args: [BigInt(value)], returnTo: HALT });
                assert.equal(m.rip(), HOST + 1, `${name} hands the call over`);
                assert.equal(trapped(traps[0], Number(m.reg('rcx'))), whole(value),
                    `${name}(0x${value.toString(16)}) through its trap`);
                assert.equal(trapped(entry, value), whole(value),
                    `${name}(0x${value.toString(16)}) through its export`);
            }
        }
    });

test('a pointer past 4 GiB reaches the handler whole and is answered whole', async()=>{
    const { values, i386 } = await load();
    const spec = guestEntry(values.pointer, i386.pointer, {});
    assert.deepEqual(spec.addresses, [0], 'the pointer\'s slot is declared an address');
    assert.equal(spec.returns, 'pointer');
    assert.equal(trapped(spec, 0x1_4000_0010), 0x1_4000_0010n);
    assert.equal(guestEntry(values.unsigned, i386.unsigned, {}).returns, 'u32');
    assert.equal(guestEntry(values.signed, i386.signed, {}).returns, undefined);
});
