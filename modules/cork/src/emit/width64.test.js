/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shared emitter at long mode's width (`width.js`) judged by the
 * long-mode interpreter, as the long translator is (`testing/long-machine.js`):
 * every case of the hardware corpus and seeded programs drawn from it, run as
 * the emitter's regions (`testing/shared-runner64.js`) and on the interpreter
 * alone, and everything a program can see compared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, compare, nested, pool, program } from '../testing/long-machine.js';
import { createSharedRunner64 } from '../testing/shared-runner64.js';

/** @param {WebAssembly.Memory} memory @param {any} layout */
const shared = (memory, layout)=>createSharedRunner64({ memory, layout });

test('long-mode regions of the shared emitter do what the interpreter does on the corpus', ()=>{
    for (const budget of [7, 100000])
    {
        const { failures, exits, stats } = compare(CORPUS.cases, budget, true, undefined,
            undefined, true, 0, false, shared);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
        assert.ok(stats.translated > 5000, JSON.stringify(stats));
    }
});

/**
 * Width edges the corpus meets by chance only: each operation over registers
 * whose high halves are set, every count that changes the answer (zero, the
 * width and past it), with its flags read at the exit and with them
 * overwritten after it.
 *
 * @param {string[]} codes  each operation's bytes, in hex
 * @param {number[]} counts  rcx's values
 */
function edges(codes, counts){
    const one = CORPUS.cases[0];
    const regs = [...one.regs];
    regs[0] = 'fedcba9876543210';
    regs[2] = '8000000180000001';
    regs[8] = '7fffffff80000000';
    regs[9] = 'ffffffffffffffff';
    return codes.flatMap(code=>counts.flatMap(count=>['', '31d2'].map(after=>({ ...one,
        text: `${code} rcx ${count} ${after}`, code: code + after,
        regs: regs.map((value, i)=>(i === 1 ? count.toString(16) : value)) }))));
}

test('width edges of shifts run in the shared emitter\'s regions as interpreted', ()=>{
    const cases = edges([
        'd3e0', 'd3e8', 'd3f8', 'c1e000', 'c1e81f', 'c1f801', // shl/shr/sar eax
        '48d3e0', '48d3e8', '48d3f8', '48c1e03f', '48c1f83f', '48d1e0', // rax
        '41d3e0', '49d3e8', '66d3e0', '66d3f8', // r8d, r8, ax
        'd2e0', 'd2fc', '41d2e1', // al, ah, r9b
        '40d2e6', // sil
    ], [0, 1, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65]);
    const { failures, stats } = compare(cases, 7, true, undefined, undefined, true, 0, false,
        shared);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(stats.translated >= cases.length, JSON.stringify(stats));
});

test('width edges of rotations run in the shared emitter\'s regions as interpreted', ()=>{
    const cases = edges([
        'd3c0', 'd3c8', 'd3d0', 'd3d8', 'c1c000', 'c1d000', 'c1d801', // rol/ror/rcl/rcr eax
        '48d3c0', '48d3c8', '48d3d0', '48d3d8', '48c1c03f', '48c1d03f', '48d1d8', // rax
        '49d3d0', '49d3d9', '66d3d0', '66d3c8', 'd2d0', 'd2dc', '41d2c1', // r8, r9, ax, al, ah, r9b
    ], [0, 1, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65]).flatMap(one=>[one,
        // The carry in set: rcl and rcr take it into the value.
        { ...one, text: `${one.text} stc`, code: `f9${one.code}` }]);
    const { failures, stats } = compare(cases, 7, true, undefined, undefined, true, 0, false,
        shared);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(stats.translated >= cases.length, JSON.stringify(stats));
});

test('seeded long programs run in the shared emitter\'s regions as interpreted', ()=>{
    const instructions = pool();
    const straight = Array.from({ length: 600 },
        (_, i)=>program(instructions, 0x5eed + i, 20 + i % 60));
    const loops = Array.from({ length: 400 }, (_, i)=>nested(instructions, 0x1005 + i));
    for (const [cases, budget] of /** @type {const} */ ([[straight, 7], [loops, 7],
        [loops, 1000]]))
    {
        const { failures, exits, stats } = compare(cases, budget, true, undefined, undefined,
            true, 0, false, shared);
        assert.ok(exits > cases.length * 0.6, `${exits} programs ran to their exit`);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > 0, JSON.stringify(stats));
    }
});
