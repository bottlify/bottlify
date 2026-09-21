/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The sequence corpus's own data, checked without an emulator: every form in
 * the pool is what its name says (decoded by this package's decoder, so a
 * hand-encoding mistake is named here rather than surfacing as a divergence
 * blamed on the translator), the generator repeats from its seed, and the
 * minimiser keeps a subsequence that still reproduces and nothing shorter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '../decode/decoder.js';
import {
    BY_NAME, CODE, DATA, DATA_BYTES, DATA_SIZE, EXCHANGE, HALT, POOL, PUSHES, SETUP, SPANS, XMM,
    at, bodyOf, minimise, namesOf, preambleOf, programBytes, random,
} from './sequences.js';

/** Decodes one pool form on its own. @param {number[]} bytes */
function decoded(bytes){
    const memory = Uint8Array.from(bytes);
    const instruction = decode(address=>memory[address] ?? 0, 0);
    if ('refused' in instruction)
    {
        assert.fail(`refused (${instruction.opcode}: ${instruction.reason})`);
    }
    return instruction;
}

test('every pool form is the instruction its name says, and no longer', ()=>{
    for (const form of POOL)
    {
        const instruction = decoded(form.bytes);
        assert.equal(instruction.op, form.name.split(' ')[0], form.name);
        assert.equal(instruction.length, form.bytes.length,
            `${form.name} decodes to ${instruction.length} bytes, not ${form.bytes.length}`);
    }
    assert.equal(BY_NAME.size, POOL.length, 'no two forms share a name');
});

test('the pool holds every class the defect needs, with the operands named', ()=>{
    /** @param {string} name */
    const kinds = name=>decoded(POOL[at(name)].bytes)
        .operands.map(operand=>operand.kind);
    assert.deepEqual(kinds('movq mm0, [m]'), ['mm', 'mem']);
    assert.deepEqual(kinds('movq [m], mm1'), ['mem', 'mm']);
    assert.deepEqual(kinds('movd mm2, eax'), ['mm', 'reg']);
    assert.deepEqual(kinds('pshufw mm0, mm1, 0x1b'), ['mm', 'mm', 'imm']);
    assert.deepEqual(kinds('cvtps2pi mm0, xmm0'), ['mm', 'xmm']);
    assert.deepEqual(kinds('cvttps2pi mm1, xmm1'), ['mm', 'xmm']);
    assert.deepEqual(kinds('cvtpi2ps xmm0, mm0'), ['xmm', 'mm']);
    assert.deepEqual(kinds('movq2dq xmm1, mm1'), ['xmm', 'mm']);
    assert.deepEqual(kinds('movdq2q mm2, xmm2'), ['mm', 'xmm']);
    assert.deepEqual(kinds('fld qword [m]'), ['x87', 'mem']);
    assert.deepEqual(kinds('fstp st0'), ['x87', 'x87']);
    assert.deepEqual(kinds('fcomp'), ['x87', 'x87']);
    assert.deepEqual(kinds('fnstsw ax'), ['reg']);
    assert.equal(POOL.length, 30, 'the pool the itest draws from');
    for (const name of ['fld1', 'fldz', 'fstp qword [m]', 'faddp', 'fmul st0, st1', 'fxch st1',
        'fnstenv [m]', 'fldenv [m]', 'fninit', 'fnclex', 'ffree st0', 'paddw mm0, mm1',
        'pxor mm1, mm1', 'emms', 'mov eax, 0x0f3a9c11', 'add eax, ebx', 'xor ecx, ecx'])
    {
        assert.ok(BY_NAME.has(name), `the pool holds ${name}`);
    }
});

test('the generator repeats from its seed and differs from another', ()=>{
    /** @param {number} seed */
    const twenty = seed=>{
        const next = random(seed);
        return Array.from({ length: 20 }, ()=>next());
    };
    assert.deepEqual(twenty(12345), twenty(12345), 'the same seed, the same run');
    assert.notDeepEqual(twenty(12345), twenty(12346));
    for (const value of twenty(1))
    {
        assert.ok(value >= 0 && value < 1);
    }
    const next = random(7);
    for (let i = 0; i < 300; i++)
    {
        const body = bodyOf(next);
        assert.ok(body.length >= 2 && body.length <= 8, `a body of ${body.length}`);
        for (const index of body)
        {
            assert.ok(index >= 0 && index < POOL.length);
        }
        for (const index of preambleOf(next))
        {
            assert.ok(PUSHES.includes(index) || index === EXCHANGE);
        }
    }
    assert.deepEqual(bodyOf(random(3), { shortest: 4, longest: 4 }).length, 4);
});

test('a program is its forms and a halt; a report names them', ()=>{
    const indices = [at('fld1'), at('emms')];
    assert.deepEqual([...programBytes(indices)], [0xd9, 0xe8, 0x0f, 0x77, HALT]);
    assert.equal(namesOf(indices), 'fld1; emms');
});

test('the data area is what the compared spans cover', ()=>{
    assert.equal(DATA_BYTES.length, DATA_SIZE);
    assert.deepEqual(SPANS, [{ address: DATA, length: DATA_SIZE }]);
    // A qword the loads read, a qword the MMX store writes, and the
    // environment `fldenv` reads: three places, none of them overlapping.
    const view = new DataView(DATA_BYTES.buffer);
    assert.equal(view.getFloat64(0, true), 3.25);
    assert.equal(view.getBigUint64(8, true), 0x0123456789abcdefn);
    assert.equal(view.getUint16(0x20, true), 0x037f, 'the default control word');
    assert.equal(view.getUint16(0x28, true), 0xaaaa, 'an empty stack');
    assert.equal(XMM.length, 3);
    assert.equal(new Set([CODE, SETUP, DATA]).size, 3, 'three addresses, three pages');
});

test('the minimiser keeps what still reproduces and drops the rest', async()=>{
    /** Only a subsequence still headed by the same two items reproduces. */
    const head = async(/** @type {number[]} */ items)=>items[0] === 1 && items[1] === 2;
    assert.deepEqual(await minimise([1, 2, 3, 4, 5], head), [1, 2]);
    // Only the pair 2 and 4 reproduces: the search has to find them together.
    const pair = async(/** @type {number[]} */ items)=>items.includes(2) && items.includes(4);
    assert.deepEqual(await minimise([1, 2, 3, 4, 5], pair), [2, 4]);
    // Nothing reproduces: the search gives up and answers what it was given.
    assert.deepEqual(await minimise([9, 8, 7], async()=>false), [9, 8, 7]);
    // A floor of one shortens a single culprit to itself.
    assert.deepEqual(await minimise([6, 1, 2],
        async(/** @type {number[]} */ items)=>items.includes(6), 1), [6]);
    /** @type {number[][]} */
    const asked = [];
    await minimise([1, 2, 3], async(/** @type {number[]} */ items)=>{
        asked.push(items);
        return items.length <= 2;
    });
    assert.deepEqual(asked[0], [2, 3], 'it tries the leftmost drop first');
});
