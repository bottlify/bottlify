/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * srand and rand as the guest runs them (`RAND_CODE`, `SRAND_CODE`), as a
 * gate: the code on the real processor against the handlers that are its
 * reference, over seeded programs of seeds -- the edges of 32 bits among
 * them -- and draws: every number drawn, the variable the generator is kept
 * in after each call, and the stack each call leaves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { RAND_CODE, SRAND_CODE, createMsvcrtFunctions } from './functions.js';

const PROGRAM = 0x8000;
const RAND = 0x9000;
const SRAND = 0x9100;
const SEED = 0xa000;
const STACK = 0x300000;
const EDGE_SEEDS = [0, 1, 2, 0x7fff, 0x8000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {{ code: Uint8Array, seedAt: readonly number[] }} made */
const placed = made=>{
    const bytes = made.code.slice();
    for (const at of made.seedAt)
    {
        new DataView(bytes.buffer).setUint32(at, SEED, true);
    }
    return bytes;
};

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    const next = ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    return {
        u32: next,
        /** @param {number} n */
        int: n=>next() % n,
    };
}

test('srand and rand in the guest draw what their handlers draw, from any seed', ()=>{
    const host = createCorkHost({
        memorySize: 16 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(RAND, placed(RAND_CODE));
    host.writePhysical(SRAND, placed(SRAND_CODE));
    host.writePhysical(SEED, new Uint8Array(u32(1)));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /**
     * Runs `call target` with the argument pushed, if any, and the caller's
     * cleanup -- cdecl -- then a halt: what EAX holds after.
     *
     * @param {number} target @param {number[]} args
     */
    const call = (target, args)=>{
        /** @type {number[]} */
        const code = [];
        for (const value of [...args].reverse())
        {
            code.push(0x68, ...u32(value));
        }
        const from = PROGRAM + code.length;
        code.push(0xe8, ...u32((target - (from + 5)) | 0));
        if (args.length > 0)
        {
            code.push(0x83, 0xc4, args.length * 4);
        }
        code.push(0xf4);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        runToHalt(host, 1000);
        assert.equal(host.readReg32('eip'), PROGRAM + code.length, 'halted after the call');
        assert.equal(host.readReg32('esp'), STACK, 'the stack as the caller left it');
        return host.readReg32('eax') >>> 0;
    };
    const fns = createMsvcrtFunctions(/** @type {any} */ ({
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            host.readPhysical(address, length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            host.writePhysical(address, bytes),
        fillMemory: ()=>{},
        readCString: ()=>'',
        scanCString: ()=>({ index: 0, byte: 0 }),
        write: ()=>{},
        callGuest: ()=>Promise.resolve(0),
    }));

    // Before any srand, both start where the runtime starts.
    const first = [0, 0, 0].map(()=>call(RAND, []));
    assert.deepEqual(first, [0, 0, 0].map(()=>fns.rand.handler()));
    let draws = 0;
    for (let program = 1; program <= 40; program++)
    {
        const rng = random(program);
        for (let step = 0; step < 50; step++)
        {
            if (rng.int(8) === 0)
            {
                const seed = rng.int(3) === 0 ? EDGE_SEEDS[rng.int(EDGE_SEEDS.length)] : rng.u32();
                call(SRAND, [seed]);
                fns.srand.handler([seed]);
                assert.equal(read(SEED), seed, `srand(${seed}) kept the seed`);
                continue;
            }
            const drawn = call(RAND, []);
            assert.equal(drawn, fns.rand.handler(), `program ${program}, step ${step}`);
            assert.ok(drawn <= 0x7fff, 'inside RAND_MAX');
            draws++;
        }
    }
    assert.ok(draws > 1000, `${draws} numbers drawn`);
});
