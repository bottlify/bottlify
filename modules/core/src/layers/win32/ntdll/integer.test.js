/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegerFunctions, INTEGER_CODE } from './integer.js';
import { KEPT, random, runCode } from '../../../../scripts/guest-code/equivalence.mjs';

function fakeHost(){
    /** @type {Record<string, number>} */
    const registers = {};
    return {
        registers,
        /** @param {Record<string, number>} values */
        setRegisters: values=>Object.assign(registers, values),
    };
}

/**
 * The argument list as the compiler pushes it: each operand two words, low half
 * first, and the bridge hands them over as signed integers.
 *
 * @param {bigint} a @param {bigint} b
 */
function pushed(a, b){
    const halves = (/** @type {bigint} */ value)=>{
        const bits = BigInt.asUintN(64, value);
        return [Number(BigInt.asIntN(32, bits & 0xffffffffn)),
            Number(BigInt.asIntN(32, bits >> 32n))];
    };
    return [...halves(a), ...halves(b)];
}

/** @param {ReturnType<typeof fakeHost>} host @param {number} low */
function answered(host, low){
    return BigInt(host.registers.edx >>> 0) << 32n | BigInt(low >>> 0);
}

test('a 64-bit answer comes back in two registers, not one', ()=>{
    // The dispatcher places a handler's return value in EAX and touches nothing
    // else. Left at that, every one of these would hand back the low half of the
    // answer and whatever the stub left in EDX as the high half.
    const host = fakeHost();
    const fns = createIntegerFunctions(host);

    const low = fns._allmul.handler(pushed(0x100000000n, 3n));

    assert.equal(answered(host, low), 0x300000000n);
});

test('multiplication keeps the low 64 bits and discards the rest', ()=>{
    // Which is why the compiler emits one routine for signed and unsigned alike:
    // the bits that survive are the same either way.
    const host = fakeHost();
    const fns = createIntegerFunctions(host);

    const low = fns._allmul.handler(pushed(0x123456789abcdefn, 0x1000n));

    assert.equal(answered(host, low), BigInt.asUintN(64, 0x123456789abcdefn * 0x1000n));
});

test('signed division truncates towards zero and the remainder follows the dividend', ()=>{
    // C's rule, and the compiler emits these calls where it would have emitted a
    // divide. Rounding the other way changes the answer of every negative
    // division in the program by one.
    const host = fakeHost();
    const fns = createIntegerFunctions(host);

    assert.equal(answered(host, fns._alldiv.handler(pushed(-7n, 2n))),
        BigInt.asUintN(64, -3n));
    assert.equal(answered(host, fns._allrem.handler(pushed(-7n, 2n))),
        BigInt.asUintN(64, -1n));
});

test('the unsigned pair reads the same bits as a positive number', ()=>{
    // The same argument list means one thing to _alldiv and another to _aulldiv,
    // and the compiler picks by the declared type. Treating one as the other
    // turns a large unsigned value into a small negative one.
    const host = fakeHost();
    const fns = createIntegerFunctions(host);
    const args = pushed(-1n, 2n);

    assert.equal(answered(host, fns._aulldiv.handler(args)), 0x7fffffffffffffffn);
    assert.equal(answered(host, fns._alldiv.handler(args)), 0n);
});

test('the unsigned remainder is not the signed one', ()=>{
    const host = fakeHost();
    const fns = createIntegerFunctions(host);

    assert.equal(answered(host, fns._aullrem.handler(pushed(-1n, 10n))), 5n);
});

test('dividing by zero raises STATUS_INTEGER_DIVIDE_BY_ZERO in the guest, not an answer', ()=>{
    // The processor would have trapped in the routine. There is no divisor to
    // substitute that would not be an answer the program never computed.
    const fns = createIntegerFunctions(fakeHost());
    for (const name of /** @type {const} */ (
        ['_alldiv', '_allrem', '_aulldiv', '_aullrem', '_alldvrm', '_aulldvrm']))
    {
        assert.throws(()=>fns[name].handler(pushed(1n, 0n)),
            (/** @type {any} */ e)=>e.code === 'GUEST_EXCEPTION' && e.status === 0xc0000094, name);
    }
});

test('each helper pops both operands, sixteen bytes of them', ()=>{
    // The call site pushes two 64-bit values and does not adjust the stack
    // afterwards, so the callee pops all of it. A smaller number here leaves the
    // caller's stack pointer high by the difference, and it never finds out.
    const fns = createIntegerFunctions(fakeHost());

    for (const name of ['_allmul', '_alldiv', '_allrem', '_aulldiv', '_aullrem'])
    {
        assert.equal(fns[/** @type {keyof typeof fns} */ (name)].argBytes, 16, name);
    }
});

/** The operands a test divides, multiplies and shifts: edges, and random ones of every size. */
function operands(){
    const next = random(51);
    const word = ()=>BigInt(next());
    /** @type {bigint[]} */
    const values = [0n, 1n, 2n, 3n, 7n, 10n, 0xffffffffn, 0x100000000n, 0x100000001n,
        0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn, 0xfffffffeffffffffn,
        0x80000000n, 0x7fffffffn, 0xffffffff00000000n, 0x123456789abcdefn];
    for (let i = 0; i < 32; i++)
    {
        const bits = BigInt(next() % 64 + 1);
        values.push((word() << 32n | word()) & (1n << bits) - 1n);
    }
    return values;
}

/** @param {bigint} value */
const halves = value=>[Number(BigInt.asUintN(64, value) & 0xffffffffn),
    Number(BigInt.asUintN(64, value) >> 32n)];

/** @param {number} low @param {number} high */
const joined = (low, high)=>BigInt(high >>> 0) << 32n | BigInt(low >>> 0);

test('the helpers\' code answers what the BigInts do, on cork\'s test machine', ()=>{
    const values = operands();
    /** @type {Record<string, (a: bigint, b: bigint) => bigint>} */
    const expected = {
        _allmul: (a, b)=>a * b,
        _alldiv: (a, b)=>BigInt.asIntN(64, a) / BigInt.asIntN(64, b),
        _allrem: (a, b)=>BigInt.asIntN(64, a) % BigInt.asIntN(64, b),
        _aulldiv: (a, b)=>a / b,
        _aullrem: (a, b)=>a % b,
    };
    for (const a of values)
    {
        for (const b of values.filter((_, i)=>i % 4 === 0 || i < 17))
        {
            for (const [name, answer] of Object.entries(expected))
            {
                if (b === 0n && name !== '_allmul')
                {
                    continue;
                }
                const run = runCode(INTEGER_CODE[name], { stack: [...halves(a), ...halves(b)] });
                const what = `${name}(0x${a.toString(16)}, 0x${b.toString(16)})`;
                assert.ok(run.halted, `${what} returns`);
                assert.equal(run.popped, 16, `${what} pops its operands`);
                assert.deepEqual([run.ebx, run.esi, run.edi, run.ebp], Object.values(KEPT),
                    `${what} keeps EBX, ESI, EDI and EBP`);
                assert.equal(joined(run.eax, run.edx), BigInt.asUintN(64, answer(a, b)), what);
            }
            if (b === 0n)
            {
                continue;
            }
            for (const [name, signed] of /** @type {const} */ ([['_alldvrm', true],
                ['_aulldvrm', false]]))
            {
                const x = signed ? BigInt.asIntN(64, a) : a;
                const y = signed ? BigInt.asIntN(64, b) : b;
                const run = runCode(INTEGER_CODE[name], { stack: [...halves(a), ...halves(b)] });
                const what = `${name}(0x${a.toString(16)}, 0x${b.toString(16)})`;
                assert.equal(run.popped, 16, what);
                assert.deepEqual([run.esi, run.edi, run.ebp], [KEPT.esi, KEPT.edi, KEPT.ebp], what);
                assert.equal(joined(run.eax, run.edx), BigInt.asUintN(64, x / y),
                    `${what}'s quotient`);
                assert.equal(joined(run.ecx, run.ebx), BigInt.asUintN(64, x % y),
                    `${what}'s remainder`);
            }
        }
    }
});

test('the shifts take EDX:EAX and CL, and a count of 64 or more leaves the sign', ()=>{
    const values = operands();
    const every = Array.from({ length: 70 }, (_, i)=>i).concat(100, 255);
    for (const [i, value] of values.entries())
    {
        // Every count for the edges, the ones either side of a word for the rest.
        for (const count of i < 17 ? every : [0, 1, 13, 31, 32, 33, 47, 63, 64, 200])
        {
            const [low, high] = halves(value);
            const registers = { eax: low, edx: high, ecx: 0xabcd0000 | count };
            const shifted = {
                _allshl: count >= 64 ? 0n : value << BigInt(count),
                _allshr: BigInt.asIntN(64, value) >> BigInt(Math.min(count, 63)),
                _aullshr: count >= 64 ? 0n : value >> BigInt(count),
            };
            for (const [name, answer] of Object.entries(shifted))
            {
                const run = runCode(INTEGER_CODE[name], { registers });
                const what = `${name}(0x${value.toString(16)}, ${count})`;
                assert.equal(run.popped, 0, `${what} pops nothing`);
                assert.equal(joined(run.eax, run.edx), BigInt.asUintN(64, answer), what);
            }
        }
    }
});

test('a division by zero faults in the guest, as the processor\'s div does', ()=>{
    for (const name of /** @type {const} */ (
        ['_alldiv', '_allrem', '_aulldiv', '_aullrem', '_alldvrm', '_aulldvrm']))
    {
        const run = runCode(INTEGER_CODE[name], { stack: [...halves(12345n), ...halves(0n)] });
        assert.equal(run.halted, false, `${name} of 0 does not return`);
    }
});

test('each export is its code; the shifts pop nothing, the rest their sixteen bytes', ()=>{
    const fns = /** @type {Record<string, any>} */ (createIntegerFunctions(fakeHost()));
    for (const [name, code] of Object.entries(INTEGER_CODE))
    {
        assert.equal(fns[name].code(), code, name);
        assert.equal(fns[name].argBytes, name.includes('sh') ? 0 : 16, name);
    }
    for (const name of ['_allshl', '_allshr', '_aullshr'])
    {
        assert.throws(()=>fns[name].handler([]), /CL/, `${name}'s handler has no registers`);
    }
});
