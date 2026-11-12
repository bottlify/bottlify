/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FTOL2, QUICK_BYTES, RUNTIME_HELPERS, fingerprint, helperAt, helperInstructions,
    maskedFingerprint } from './helpers.js';
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

/**
 * The helper lookup as it was written first, every helper's quick key taken
 * for every target: what the grouped lookup must answer exactly as.
 *
 * @param {(address: number) => number} read @param {number} target
 * @param {readonly import('./helpers.js').RuntimeHelper[]} helpers @param {32 | 64} bits
 */
const helperAtEach = (read, target, helpers, bits)=>helpers.find(helper=>
    (helper.bits ?? 32) === bits && isAtEach(read, target, helper)) ?? null;

/**
 * @param {(address: number) => number} read @param {number} target
 * @param {import('./helpers.js').RuntimeHelper} helper
 * @returns {boolean}
 */
const isAtEach = (read, target, helper)=>{
    const { spans, masks = [], quick, via } = helper;
    if (spans === undefined)
    {
        return fingerprint(read, target, helper.length) === helper.hash;
    }
    return (quick === undefined
        || maskedFingerprint(read, target, [[0, Math.min(QUICK_BYTES, spans[0][1])]], masks)
            === quick)
        && maskedFingerprint(read, target, spans, masks) === helper.hash
        && (via === undefined || isAtEach(read, target + via.at + 4
            + ([0, 1, 2, 3].reduce((word, k)=>word + read(target + via.at + k) * 2 ** (8 * k), 0)
                | 0) + (via.offset ?? 0), via));
};

test('the helper lookup answers as every helper looked at in turn does: seeded memory with helpers'
    + ' of masked and unmasked heads planted, the dictionary\'s and others alike', ()=>{
    let seed = 0x2545f491;
    const random = ()=>{
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return seed >>> 0;
    };
    const memory = Uint8Array.from({ length: 1 << 16 }, ()=>random() & 0xff);
    const read = (/** @type {number} */ address)=>memory[address & 0xffff];
    /** @type {import('./helpers.js').RuntimeHelper[]} */
    const planted = [];
    for (let n = 0; n < 24; n++)
    {
        const at = 0x100 + n * 0x400;
        const length = 8 + random() % 60;
        const spans = n % 3 === 0 ? [[0, length]] : [[0, Math.min(length, 12)], [20, length]];
        const masks = n % 2 === 0 ? [] : [1 + random() % 6, 9, 21].filter((m, i, all)=>
            all.indexOf(m) === i).sort((a, b)=>a - b);
        const helper = { name: `planted${n}`, length: 0, spans, masks,
            hash: maskedFingerprint(read, at, spans, masks),
            quick: n % 4 === 3 ? undefined
                : maskedFingerprint(read, at, [[0, Math.min(QUICK_BYTES, spans[0][1])]], masks) };
        planted.push(helper);
        // Its twin elsewhere differs only in a masked byte: still the helper.
        if (masks.length > 0)
        {
            memory.copyWithin(at + 0x200, at, at + 0x60);
            memory[at + 0x200 + masks[0]] ^= 0x5a;
        }
    }
    const all = [...RUNTIME_HELPERS, ...planted, FTOL2];
    for (let target = 0; target < 0x6200; target++)
    {
        for (const bits of /** @type {const} */ ([32, 64]))
        {
            assert.equal(helperAt(read, target, all, bits), helperAtEach(read, target, all, bits),
                `at 0x${target.toString(16)}, ${bits}-bit`);
        }
    }
    const found = planted.filter((helper, n)=>helperAt(read, 0x100 + n * 0x400, all) === helper);
    assert.equal(found.length, planted.length, 'every planted helper is found where it lies');
});
