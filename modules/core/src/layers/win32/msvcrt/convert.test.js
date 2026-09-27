/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversionFunctions, scanInteger, scanFloat } from './convert.js';
import { fakeMemory, doubleSlots, fakeFpu } from './harness.test.js';

const build = (/** @type {any} */ fpu = undefined)=>{
    const memory = fakeMemory();
    return {
        memory,
        table: /** @type {Record<string, any>} */ (
            createConversionFunctions({ ...memory, fpu })),
    };
};

test('base zero reads the prefix: 0x is hex, a leading zero is octal', ()=>{
    assert.equal(scanInteger('0x1f', 0)?.magnitude, 31n);
    assert.equal(scanInteger('017', 0)?.magnitude, 15n);
    assert.equal(scanInteger('17', 0)?.magnitude, 17n);
});

test('0x with no hex digit after it is a prefix with nothing after it', ()=>{
    assert.equal(scanInteger('0xzz', 16), null);
    assert.equal(scanInteger('-0x', 0), null);
});

test('scanf\'s reading of a bare 0x converts the zero and stops at the x', ()=>{
    const scanned = scanInteger('0xzz', 16, true);
    assert.equal(scanned?.magnitude, 0n);
    assert.equal(scanned?.end, 1, 'the x is where the caller resumes');
});

test('a digit outside the base ends the number rather than failing it', ()=>{
    const scanned = scanInteger('129', 8);
    assert.equal(scanned?.magnitude, 0o12n);
    assert.equal(scanned?.end, 2);
});

test('nothing convertible is null, which is not the same as zero', ()=>{
    assert.equal(scanInteger('  +zz', 10), null);
    assert.equal(scanInteger('  +0zz', 10)?.magnitude, 0n);
});

test('strtol reports where it stopped, and where it started when it failed', ()=>{
    const { memory, table } = build();
    const string = memory.put('  42rest');
    const end = memory.allocate(4);
    assert.equal(table.strtol.handler([string, end, 10]), 42);
    assert.equal(memory.text(memory.u32(end)), 'rest');

    const bad = memory.put('rest');
    assert.equal(table.strtol.handler([bad, end, 10]), 0);
    assert.equal(memory.u32(end), bad, 'no progress, so the caller can stop');
});

test('strtol clamps rather than wrapping, in both directions', ()=>{
    const { memory, table } = build();
    const end = memory.allocate(4);
    assert.equal(table.strtol.handler([memory.put('99999999999'), end, 10]), 0x7fffffff);
    assert.equal(table.strtol.handler([memory.put('-99999999999'), end, 10]), -0x80000000);
});

test('strtoul negates within 32 bits: "-1" is ULONG_MAX, not a failure', ()=>{
    const { memory, table } = build();
    const end = memory.allocate(4);
    assert.equal(table.strtoul.handler([memory.put('-1'), end, 10]) >>> 0, 0xffffffff);
});

test('strtol and strtoul set ERANGE when they clamp, and leave errno alone in range', ()=>{
    // The cases of Wine's msvcrt string tests: the limits themselves are in
    // range, and so is "-4294967295" for strtoul, which negates to 1.
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (createConversionFunctions({
        ...memory, errno: code=>errno.push(code),
    }));
    const end = memory.allocate(4);
    const ERANGE = 34;

    assert.equal(table.strtol.handler([memory.put('2147483647L'), end, 0]), 0x7fffffff);
    assert.equal(table.strtol.handler([memory.put('-2147483648L'), end, 0]), -0x80000000);
    assert.equal(table.strtoul.handler([memory.put('4294967295UL'), end, 0]) >>> 0, 0xffffffff);
    assert.equal(table.strtoul.handler([memory.put('-4294967295'), end, 0]) >>> 0, 1);
    assert.deepEqual(errno, []);

    assert.equal(table.strtol.handler([memory.put('9223372036854775807L'), end, 0]),
        0x7fffffff);
    assert.equal(table.strtol.handler([memory.put('-99999999999'), end, 10]), -0x80000000);
    assert.equal(table.strtoul.handler([memory.put('9223372036854775807L'), end, 0]) >>> 0,
        0xffffffff);
    assert.deepEqual(errno, [ERANGE, ERANGE, ERANGE]);
});

test('strtoul clamps a negative magnitude to ULONG_MAX before negating it', ()=>{
    // Wine's msvcrt test_strtol: "-4294967296" is out of range and answers 1,
    // the clamped ULONG_MAX negated, with ERANGE.
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (createConversionFunctions({
        ...memory, errno: code=>errno.push(code),
    }));
    assert.equal(table.strtoul.handler([memory.put('-4294967296'), 0, 0]) >>> 0, 1);
    assert.equal(table.strtoul.handler([memory.put('-99999999999'), 0, 10]) >>> 0, 1);
    assert.deepEqual(errno, [34, 34]);
});

test('strtol reads "0x" as a prefix, so with no digit after it nothing converts', ()=>{
    // Wine's msvcrt test_strtol: strtol("-0x", &e, 0) is 0 with errno left
    // alone and e at the start of the string.
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (createConversionFunctions({
        ...memory, errno: code=>errno.push(code),
    }));
    const end = memory.allocate(4);
    const negative = memory.put('-0x');
    assert.equal(table.strtol.handler([negative, end, 0]), 0);
    assert.equal(memory.u32(end), negative);
    const bare = memory.put('0xzz');
    assert.equal(table.strtoul.handler([bare, end, 16]), 0);
    assert.equal(memory.u32(end), bare);
    assert.deepEqual(errno, []);
});

test('_ltoa signs base ten and prints the bit pattern in every other base', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(64);
    table._ltoa.handler([-1, buffer, 10]);
    assert.equal(memory.text(buffer), '-1');
    table._ltoa.handler([-1, buffer, 16]);
    assert.equal(memory.text(buffer), 'ffffffff');
});

test('_ultoa is unsigned in base ten, which is its whole difference from _ltoa', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(64);
    table._ultoa.handler([-1, buffer, 10]);
    assert.equal(memory.text(buffer), '4294967295');
});

test('_i64toa reads both halves, low slot first', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(64);
    table._i64toa.handler([0, 1, buffer, 10]);
    assert.equal(memory.text(buffer), '4294967296');
    table._i64toa.handler([-1, -1, buffer, 10]);
    assert.equal(memory.text(buffer), '-1');
});

test('a radix outside 2..36 writes nothing and answers null', ()=>{
    const { memory, table } = build();
    const buffer = memory.put('untouched');
    assert.equal(table._ltoa.handler([5, buffer, 1]), 0);
    assert.equal(memory.text(buffer), 'untouched');
});

test('_ecvt returns digits alone, with the point and sign through the pointers', ()=>{
    const { memory, table } = build();
    const decimal = memory.allocate(4);
    const sign = memory.allocate(4);
    const result = table._ecvt.handler([...doubleSlots(-123.456), 5, decimal, sign]);
    assert.equal(memory.text(result), '12346', 'five significant digits, rounded');
    assert.equal(memory.i32(decimal), 3);
    assert.equal(memory.i32(sign), 1);
});

test('_fcvt counts digits after the point, and a small value loses leading zeros', ()=>{
    const { memory, table } = build();
    const decimal = memory.allocate(4);
    const sign = memory.allocate(4);
    const result = table._fcvt.handler([...doubleSlots(0.0012), 5, decimal, sign]);
    assert.equal(memory.text(result), '120');
    assert.equal(memory.i32(decimal), -2, 'two zeros were dropped from the front');
    assert.equal(memory.i32(sign), 0);
});

test('_ecvt and _fcvt hand back the same buffer every time', ()=>{
    const { memory, table } = build();
    const decimal = memory.allocate(4);
    const sign = memory.allocate(4);
    const first = table._ecvt.handler([...doubleSlots(1), 3, decimal, sign]);
    const second = table._fcvt.handler([...doubleSlots(2), 3, decimal, sign]);
    assert.equal(first, second, 'documented to be overwritten by the next call');
});

test('_gcvt writes a whole number into the caller\'s buffer', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(64);
    table._gcvt.handler([...doubleSlots(-3.25), 6, buffer]);
    assert.equal(memory.text(buffer), '-3.25000');
});

test('the double-returning conversions appear only with an FPU seam', ()=>{
    assert.equal(build().table.atof, undefined);
    assert.notEqual(build(fakeFpu()).table.atof, undefined);
});

test('atof and strtod leave their result on the FPU stack', ()=>{
    const fpu = fakeFpu();
    const { memory, table } = build(fpu);
    table.atof.handler([memory.put('  -2.5e2xyz')]);
    assert.equal(fpu.result, -250);

    const end = memory.allocate(4);
    const string = memory.put('1.5rest');
    table.strtod.handler([string, end]);
    assert.equal(fpu.result, 1.5);
    assert.equal(memory.text(memory.u32(end)), 'rest');
});

test('a float literal ending in a bare exponent gives back the exponent', ()=>{
    const scanned = scanFloat('1e');
    assert.equal(scanned?.value, 1);
    assert.equal(scanned?.end, 1);
});

test('wcstol and wcstoul read any script\'s decimal digits, and Unicode\'s separators as space',
    ()=>{
        const memory = fakeMemory();
        /** @type {number[]} */
        const errno = [];
        const table = /** @type {Record<string, any>} */ (createConversionFunctions({
            ...memory, errno: code=>void errno.push(code),
        }));
        const end = memory.allocate(4);
        /** @param {string} name @param {number[]} units @param {number} [base] */
        const convert = (name, units, base = 0)=>{
            const at = memory.putWide(String.fromCharCode(...units));
            const value = table[name].handler([at, end, base]);
            return [value, (new DataView(memory.bytes.buffer).getUint32(end, true) - at) / 2];
        };
        assert.deepEqual(convert('wcstol', [0x39], 10), [9, 1]);
        assert.deepEqual(convert('wcstol', [0x09, 0xa0, 0x2002, 0x2028, 0x3000, 0x2b, 0x34, 0x34]),
            [44, 8]);
        assert.deepEqual(convert('wcstol', [0x0e59]), [9, 1], 'a Thai digit');
        assert.deepEqual(convert('wcstol', [0xff19]), [9, 1], 'a fullwidth digit');
        assert.deepEqual(convert('wcstol', [0x0bef]), [0, 0], 'no Tamil digit, and no progress');
        assert.deepEqual(convert('wcstol', [0x00b9]), [0, 0], 'a superscript is no digit');
        assert.deepEqual(convert('wcstol', [0x2d, 0x0e50, 0x78, 0xff19, 0x31]), [-0x91, 5],
            'a zero of any script begins the hex prefix');
        assert.deepEqual(convert('wcstol', [0x2b, 0x0e50, 0xff17, 0x31]), [0o71, 4],
            'and an octal number');
        assert.deepEqual(convert('wcstol', [0xff19, 0x66, 0x0e59, 0xff46], 16), [0x9f9, 3],
            'a fullwidth letter is no hex digit');
        for (const zero of [0x660, 0x966, 0x17e0, 0xff10])
        {
            assert.equal(convert('wcstol', [zero + 4, zero, zero + 5])[0], 405);
        }
        assert.deepEqual(errno, []);
        assert.equal(convert('wcstol', [...'2147483648'].map(c=>c.charCodeAt(0)))[0], 0x7fffffff);
        assert.equal(convert('wcstoul', [...'-4294967296'].map(c=>c.charCodeAt(0)))[0], 1);
        assert.deepEqual(errno, [34, 34]);
        assert.equal(convert('wcstoul', [...'-1234'].map(c=>c.charCodeAt(0)))[0] | 0, -1234);
    });
