/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Body, EMPTY, ModuleBuilder, ValType, leb128u } from './encoder.js';
import { features } from './features.js';
import { SIMD } from './simd.js';

const skip = !features().simd && 'no simd';

/**
 * The immediates an opcode takes after its number, by name: a memarg for
 * the loads and stores (plus a lane for the lane forms), sixteen bytes for
 * the shuffle and the constant, one lane byte for the lane accessors.
 *
 * @param {string} name
 */
function immediates(name){
    if (/^(load|store)/.test(name))
    {
        return /Lane$/.test(name) ? [0, 0, 0] : [0, 0];
    }
    if (name === 'shuffle' || name === 'const')
    {
        return new Array(16).fill(0);
    }
    if (/(Extract|Replace)Lane/.test(name))
    {
        return [0];
    }
    return [];
}

test('every SIMD opcode number is one the engine knows', { skip }, ()=>{
    // After `unreachable` the stack is polymorphic, so the module validates
    // whatever operands the instruction takes -- but only when the opcode
    // number itself exists in the 0xfd space.
    for (const [name, opcode] of Object.entries(SIMD))
    {
        const m = new ModuleBuilder();
        m.importMemory('env', 'memory', { min: 1 });
        const type = m.type({ params: [], results: [] });
        const body = new Body().unreachable()
            .op(0xfd, [...leb128u(opcode), ...immediates(name)]).drop();
        m.function(type, [ValType.v128], body.toBytes(), { exportAs: 'f' });
        assert.doesNotThrow(()=>new WebAssembly.Module(m.toBytes()), `${name} = ${opcode}`);
    }
});

test('a few of them run and mean what their names say', { skip }, ()=>{
    const m = new ModuleBuilder();
    m.importMemory('env', 'memory', { min: 1 });
    const type = m.type({ params: [], results: [] });
    const b = new Body();
    // [1,2,3,4] + [10,20,30,40] as i32x4, stored at 32; f32x4 sqrt of [4,9,16,25] at 48;
    // i8x16 bitmask of the bytes at 96 into 64.
    b.i32const(32).i32const(0).loadV128().i32const(16).loadV128().simd(SIMD.i32x4Add).storeV128();
    b.i32const(48).i32const(16).loadV128().simd(SIMD.f32x4Sqrt).storeV128();
    b.i32const(64).i32const(96).loadV128().simd(SIMD.i8x16Bitmask).store('i32');
    b.i32const(80).i32const(0).loadV128().i32const(16).loadV128();
    b.op(0xfd, [SIMD.shuffle, 3, 2, 1, 0, 19, 18, 17, 16, 4, 5, 6, 7, 20, 21, 22, 23]).storeV128();
    m.function(type, [], b.toBytes(), { exportAs: 'f' });
    const mem = new WebAssembly.Memory({ initial: 1 });
    const view = new DataView(mem.buffer);
    [1, 2, 3, 4].forEach((v, i)=>view.setInt32(i * 4, v, true));
    [4, 9, 16, 25].forEach((v, i)=>view.setFloat32(16 + i * 4, v, true));
    view.setUint8(96, 0x80);
    view.setUint8(98, 0x80);
    const { f } = /** @type {{ f: () => void }} */ (new WebAssembly.Instance(
        new WebAssembly.Module(m.toBytes()), { env: { memory: mem } }).exports);
    f();
    // the f32 bit patterns of 4, 9, 16, 25 added as integers
    /** @param {number} i */
    const asInt = i=>view.getInt32(16 + i * 4, true);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getInt32(32 + i * 4, true)),
        [1, 2, 3, 4].map((v, i)=>(v + asInt(i)) | 0));
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(48 + i * 4, true)), [2, 3, 4, 5]);
    assert.equal(view.getInt32(64, true), 0b101);
    const bytes = new Uint8Array(mem.buffer);
    assert.deepEqual([...bytes.slice(80, 96)], [
        bytes[3], bytes[2], bytes[1], bytes[0], bytes[19], bytes[18], bytes[17], bytes[16],
        bytes[4], bytes[5], bytes[6], bytes[7], bytes[20], bytes[21], bytes[22], bytes[23],
    ]);
    assert.equal(EMPTY, 0x40);
});
