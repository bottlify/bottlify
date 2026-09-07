/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegerFunctions } from './integer.js';

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
    const operands = pushed(-1n, 2n);

    assert.equal(answered(host, fns._aulldiv.handler(operands)), 0x7fffffffffffffffn);
    assert.equal(answered(host, fns._alldiv.handler(operands)), 0n);
});

test('the unsigned remainder is not the signed one', ()=>{
    const host = fakeHost();
    const fns = createIntegerFunctions(host);

    assert.equal(answered(host, fns._aullrem.handler(pushed(-1n, 10n))), 5n);
});

test('dividing by zero is reported, not answered', ()=>{
    // The processor would have trapped. There is no divisor to substitute that
    // would not be an answer the program never computed.
    const fns = createIntegerFunctions(fakeHost());

    assert.throws(()=>fns._alldiv.handler(pushed(1n, 0n)), /_alldiv/);
    assert.throws(()=>fns._aullrem.handler(pushed(1n, 0n)), /_aullrem/);
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
