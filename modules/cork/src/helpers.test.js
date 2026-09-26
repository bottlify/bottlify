/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FTOL2, fingerprint, helperAt, helperInstructions } from './helpers.js';
import { formRegion } from './region.js';
import { createTestMachine } from './testing/machine.js';

const CODE = 0x1000;
const HELPER = 0x1800;
const DATA = 0x2000;
const OUT = 0x2100;

// A helper of this test's own, standing in for a compiler's: what it computes
// is what _ftol2's body computes, so the program answers the same whether its
// call runs the helper or is formed as the body.
const OWN = [
    0xdd, 0x4c, 0x24, 0xf8,                   // fisttp qword [esp-8]
    0x8b, 0x44, 0x24, 0xf8,                   // mov eax, [esp-8]
    0x8b, 0x54, 0x24, 0xfc,                   // mov edx, [esp-4]
    0xc3,                                     // ret
];
const PROGRAM = [
    0xdd, 0x05, 0x00, 0x20, 0, 0,             // fld qword [DATA]
    0xe8, ...rel(CODE + 6, HELPER),           // call HELPER
    0xa3, 0x00, 0x21, 0, 0,                   // mov [OUT], eax
    0x89, 0x15, 0x04, 0x21, 0, 0,             // mov [OUT+4], edx
    0xf4,                                     // hlt
];

/** @param {number} at @param {number} target */
function rel(at, target){
    const value = (target - (at + 5)) >>> 0;
    return [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
}

/** @param {number[]} helper */
function machineWith(helper){
    const m = createTestMachine();
    m.write(CODE, PROGRAM);
    m.write(HELPER, helper);
    m.setReg('esp', 0x80000);
    return m;
}

/** @param {ReturnType<typeof createTestMachine>} m */
const readOf = m=>(/** @type {number} */ address)=>new Uint8Array(m.memory.buffer)[m.layout.ramBase + address];

/** @param {number[]} helper */
const own = helper=>Object.freeze({
    name: 'own',
    length: helper.length,
    hash: fingerprint(address=>helper[address - HELPER] ?? 0, HELPER, helper.length),
    body: FTOL2.body,
});

test('_ftol2 is formed as fisttp into edx:eax, with the call\'s address and length', ()=>{
    const call = { eip: 0x401000, length: 5 };
    const formed = helperInstructions(FTOL2, /** @type {any} */ (call), 0x6787a4);
    assert.deepEqual(formed.map(({ op })=>op), ['fisttp', 'mov', 'mov']);
    assert.deepEqual(formed.map(({ eip })=>eip), [0x401000, 0x401000, 0x401000]);
    assert.deepEqual(formed.map(({ length })=>length), [0, 0, 5],
        'the last one ends where the call did');
    assert.equal(formed[0].operands[0].size, 8);
    assert.deepEqual(formed[0].helper, { name: '_ftol2', address: 0x6787a4, length: 117 });
});

test('a call to a recognised helper runs as its body; the region takes its bytes', ()=>{
    const helper = own(OWN);
    const m = machineWith(OWN);
    const region = formRegion(readOf(m), CODE, { helpers: [helper] });
    assert.equal(region.blocks.length, 1, 'the call does not end the block');
    assert.equal(region.blocks[0].exit.kind, 'hlt');
    assert.ok(region.pages.has(HELPER >>> 12), 'a write to the helper drops the region');

    const view = new DataView(m.memory.buffer);
    for (const [value, expected] of /** @type {[number, bigint][]} */ ([
        [123.75, 123n], [-123.75, -123n], [2.5, 2n], [-0.5, 0n], [4294967296.7, 4294967296n],
        [Number.NaN, -0x8000000000000000n], [2 ** 64, -0x8000000000000000n],
    ]))
    {
        m.write(CODE, PROGRAM);
        m.setReg('esp', 0x80000);
        view.setUint8(m.layout.x87Empty, 0xff);
        view.setUint8(m.layout.x87Top, 0);
        view.setFloat64(m.layout.ramBase + DATA, value, true);
        const exit = m.runProgram(CODE, { helpers: [helper] });
        assert.equal(exit.kind, 3, `left out ${[...exit.unsupported]}`);
        assert.equal(view.getBigInt64(m.layout.ramBase + OUT, true), expected, `${value}`);
        assert.equal(m.reg('esp'), 0x80000);
        assert.equal(view.getUint8(m.layout.x87Top), 0, 'ST0 popped');
    }
});

test('a helper whose bytes differ by one is called, and its bytes are in the region\'s hash', ()=>{
    const helper = own(OWN);
    const changed = [...OWN.slice(0, -1), 0x90, 0xc3];      // a nop before the ret
    const m = machineWith(changed);
    const region = formRegion(readOf(m), CODE, { helpers: [helper] });
    assert.equal(region.blocks[0].exit.kind, 'call', 'not recognised: the call leaves');
    assert.equal(helperAt(readOf(m), HELPER, [helper]), null);

    const a = formRegion(readOf(machineWith(OWN)), CODE, { helpers: [helper] });
    const b = formRegion(readOf(machineWith(OWN)), CODE, { helpers: false });
    assert.notEqual(a.hash, b.hash, 'a region formed with the helper is keyed apart');
});
