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
import {
    CORPUS, HOISTED_SWITCHES, SWITCHES, compare, loopCases, nested, pool, program,
} from '../testing/long-machine.js';
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
 * @param {(number | bigint)[]} counts  rcx's values
 * @param {string[]} [before]  code put before each operation, in hex
 */
function edges(codes, counts, before = ['']){
    const one = CORPUS.cases[0];
    const regs = [...one.regs];
    regs[0] = 'fedcba9876543210';
    regs[2] = '8000000180000001';
    regs[8] = '7fffffff80000000';
    regs[9] = 'ffffffffffffffff';
    return before.flatMap(first=>codes.flatMap(code=>counts.flatMap(count=>['', '31d2'].map(
        after=>({ ...one, text: `${first} ${code} rcx ${count} ${after}`,
            code: first + code + after, regs: regs.map((value, i)=>(i === 1
                ? BigInt.asUintN(64, BigInt(count)).toString(16) : value)) })))));
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

test('width edges of multiplies and divides run in the shared emitter\'s regions as interpreted',
    ()=>{
        const counts = [0, 1, 2, 3, 7, -1, -3, 0x80000000, 0x100000000, 0x7fffffffffffffffn,
            -0x8000000000000000n];
        const multiplies = edges([
            '48f7e1', '48f7e9', '49f7e0', '49f7e9', '48f7e2', '48f7ea', // mul/imul rcx, r8, r9, rdx
            'f7e1', 'f7e9', '66f7e1', '66f7e9', 'f6e1', 'f6e9', // ecx, cx, cl
            '480fafc1', '4c0fafc1', '0fafc1', '660fafc1', '480fafc0', // imul r, r
            '486bc103', '4869c1ffffff7f', '486bc1ff', '6bc1fd', // imul r, r, imm
        ], counts, ['', 'b864000000', '48c7c09cffffff']);
        const divides = edges([
            '48f7f1', '48f7f9', 'f7f1', 'f7f9', '66f7f1', '66f7f9', 'f6f1', 'f6f9', // rcx..cl
            '49f7f0', '49f7f9', // r8, r9
        ], counts, ['', '31d2', '4899', 'b86400000031d2', '48c7c09cffffff4899', '99']);
        for (const cases of [multiplies, divides])
        {
            const { failures, stats } = compare(cases, 7, true, undefined, undefined, true, 0,
                false, shared);
            assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
            assert.ok(stats.translated >= cases.length, JSON.stringify(stats));
        }
    });

test('width edges of moves, scans, swaps and widenings run in the shared emitter\'s regions as'
    + ' interpreted', ()=>{
    const cases = edges([
        '4891', '87c8', '87c0', '4987c8', '6687c8', '86e1', // xchg rax/eax/r8/cx/ah
        'f3480fb8c1', 'f30fb8c1', 'f3660fb8c1', // popcnt rax/eax/ax, rcx
        '4898', '98', '6698', '4899', '99', '6699', // cdqe cwde cbw cqo cdq cwd
        '480fbcc1', '0fbcc1', '480fbdc1', '0fbdc1', '660fbcc1', // bsf/bsr from rcx
        '480fc8', '0fc8', '490fc8', // bswap rax eax r8
        '480f44c1', '0f44c1', '0f45c1', '660f44c1', '4c0f42c1', '0f47c1', // cmov from rcx
        '0f94c0', '410f95c0', '400f9cc6', '0f97c4', // sete al, setne r8b, setl sil, seta ah
    ], [0, 1, 0x80, 0x8000, 0x80000000, 0x100000000, -1, -0x8000000000000000n],
    ['', '4885c9', '31c0', 'b8feffffff', '66b8fe80']);
    const { failures, stats } = compare(cases, 7, true, undefined, undefined, true, 0, false,
        shared);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(stats.translated >= cases.length, JSON.stringify(stats));
});

test('leave and indirect jumps and calls run in the shared emitter\'s regions as interpreted', ()=>{
    const cases = edges([
        'c9', '66c9', // leave, its word form
        '488d0502000000ffe0', '488d0502000000ffd0', // jmp rax, call rax to the next instruction
        '4c8d050300000041ffe0', // jmp r8
        '48b80000000001000000ffe0', '48b80000000001000000ffd0', // past the window
    ], [0], ['', '4885c9']);
    const { failures, stats } = compare(cases, 7, true, undefined, undefined, true, 0, false,
        shared);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(stats.translated >= cases.length, JSON.stringify(stats));
});

test('SIMD moves and conversions of quadword general operands run in the shared emitter\'s'
    + ' regions as interpreted', ()=>{
    const cases = edges([
        '66480f6ec1', '66490f6ec1', '480f6ec1', // movq xmm0/xmm0/mm0 <- rcx/r9/rcx
        '66480f7ec8', '66490f7ec0', '480f7ec8', // movq rax/r8/rax <- xmm1/xmm0/mm1
        '66480f6e0424', '66480f7e0424', // movq xmm0 <- [rsp], [rsp] <- xmm0
        'f2480f2ac1', 'f3480f2ac1', 'f2480f2a0424', // cvtsi2sd/ss xmm0, rcx; cvtsi2sd [rsp]
        'f2480f2cc0', 'f2480f2dc0', 'f3480f2cc0', 'f3480f2dc0', // cvt(t)sd/ss2si rax, xmm0
        'f20f2cc0', 'f30f2dc0', // the dword forms
    ], [0, 1, -1, 0x7fffffff, 0x80000000, 0x7fffffffffffffffn, -0x8000000000000000n, 12345678901n],
    ['', 'f2480f2ac1', 'f3480f2ac1', '66480f6ec1', '48b800000000000000c3', '48b80000000000f04743']);
    const { failures, stats } = compare(cases, 7, true, undefined, undefined, true, 0, false,
        shared);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(stats.translated >= cases.length, JSON.stringify(stats));
});

test('bit tests run in the shared emitter\'s regions as interpreted', ()=>{
    const cases = edges([
        '480fa3c8', '0fa3c8', '660fa3c8', '480fabc8', '480fb3c8', '480fbbc8', // bt/s/r/c rax, rcx
        '0fabc8', '0fb3c8', '0fbbc8', '490fa3c8', // eax forms, r8
        '480fbae03f', '0fbae81f', '480fbaf001', // bt rax, 63; bts eax, 31; btr rax, 1
        '480fa30c24', '0fab0c24', '660fb30c24', '480fbb0c24', // bit strings from [rsp]
        '480fba242405', '0fba2c241f', // bt [rsp], imm
    ], [0, 1, 31, 32, 63, 64, 100, -1, -64, -65, -0x1000]);
    const { failures, stats } = compare(cases, 7, true, undefined, undefined, true, 0, false,
        shared);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(stats.translated >= cases.length, JSON.stringify(stats));
    // Every bit string lies in the data around rsp: none leaves for the interpreter.
    assert.equal(stats.exits, 0, JSON.stringify(stats));
});

test('switches run in the shared emitter\'s regions as interpreted, their index a quadword', ()=>{
    const cases = [SWITCHES, HOISTED_SWITCHES].flatMap(code=>CORPUS.cases.slice(0, 4)
        .map((/** @type {any} */ one, /** @type {number} */ i)=>({ ...one, text: `switch ${i}`,
            code })));
    for (const budget of [7, 100000])
    {
        const { failures, exits, stats } = compare(cases, budget, true, undefined, undefined,
            true, 0, false, shared);
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.equal(exits, cases.length);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
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

test('loops whose accesses move by a stride run as interpreted, to the turn a page or the'
    + ' 4 GiB window stops them', ()=>{
    // The emitter alone notes no store into code: the runtime's gate has those.
    const cases = loopCases(false);
    for (const budget of [7, 100000])
    {
        const { failures, stats } = compare(cases, budget, true, undefined, undefined, true, 0,
            false, shared);
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
});
