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

test('_ecvt and _fcvt round where the count says, keep the point of a value rounded to '
    + 'nothing, and give the sign of a negative zero', ()=>{
    const { memory, table } = build();
    const decimal = memory.allocate(4);
    const sign = memory.allocate(4);
    /** @param {string} name @param {number[]} value @param {number} count */
    const cvt = (name, value, count)=>{
        const text = memory.text(table[name].handler([...value, count, decimal, sign]));
        return [text, memory.i32(decimal), memory.i32(sign)];
    };
    assert.deepEqual(cvt('_ecvt', doubleSlots(999999999999.9), 3), ['100', 13, 0]);
    assert.deepEqual(cvt('_fcvt', doubleSlots(999999999999.9), 3), ['999999999999900', 12, 0]);
    assert.deepEqual(cvt('_ecvt', doubleSlots(0.6), 0), ['', 1, 0], 'no digits, one carried');
    assert.deepEqual(cvt('_fcvt', doubleSlots(0.6), 0), ['1', 1, 0]);
    assert.deepEqual(cvt('_fcvt', doubleSlots(0.4), 0), ['', 0, 0]);
    assert.deepEqual(cvt('_fcvt', doubleSlots(0.0001), 1), ['', -3, 0]);
    assert.deepEqual(cvt('_fcvt', doubleSlots(-123.0001), -1), ['12', 3, 1]);
    assert.deepEqual(cvt('_fcvt', doubleSlots(-0), 5), ['00000', 0, 1]);
    assert.deepEqual(cvt('_ecvt', doubleSlots(123456789012345680000), 30),
        ['123456789012345680000000000000', 21, 0], 'seventeen digits, then zeros');
    assert.deepEqual(cvt('_ecvt', doubleSlots(NaN), 5), ['1#QNB', 1, 0]);
    assert.deepEqual(cvt('_fcvt', doubleSlots(Infinity), 2), ['1#J', 1, 0]);
    assert.deepEqual(cvt('_fcvt', [0, 0xfff80000], 5), ['1#IND0', 1, 1]);
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

test('strtod and atof hand over a long number, which the handler reads through a window', ()=>{
    const fpu = fakeFpu();
    const memory = fakeMemory();
    let whole = 0;
    // A string that ends 40 bytes before the end of what is mapped: a
    // window of 64 from it would run past, as the memory layer refuses.
    const mapped = 0x20000;
    const table = /** @type {Record<string, any>} */ (createConversionFunctions({
        ...memory, fpu,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>{
            if (address + length > mapped)
            {
                throw new Error(`unmapped at 0x${mapped.toString(16)}`);
            }
            return memory.readMemory(address, length);
        },
        /** @param {number} address @param {number} max */
        readCString: (address, max)=>{
            whole++;
            return memory.readCString(address, max);
        },
    }));
    const seventeen = '0.12345678901234567';
    /** @type {[string, number, number, number][]} text, value, end, reads of the whole */
    const cases = [
        // Seventeen digits and a kilobyte of text after them: the window alone.
        [`${seventeen}e-3 ${'x'.repeat(1024)}`, Number(`${seventeen}e-3`), 22, 0],
        // Bytes no number is spelt with end it too, a NUL or not.
        [`-${seventeen}\xe9\xe9`, -Number(seventeen), 20, 0],
        // Longer than the window: read whole.
        [`1${'0'.repeat(80)}e-80`, 1, 85, 1],
    ];
    for (const [text, value, stop, reads] of cases)
    {
        whole = 0;
        const at = memory.put(text);
        table.atof.handler([at]);
        assert.ok(Object.is(fpu.result, value), `atof(${JSON.stringify(text)}) is ${fpu.result}`);
        const end = memory.allocate(4);
        table.strtod.handler([at, end]);
        assert.ok(Object.is(fpu.result, value), `strtod(${JSON.stringify(text)})`);
        assert.equal(memory.u32(end) - at, stop, 'strtod\'s end');
        assert.equal(whole, 2 * reads, `${JSON.stringify(text)}: read whole ${reads} times`);
    }
    // At the end of what is mapped, the window refused: read whole.
    const tail = `${seventeen}5`;
    const last = mapped - tail.length - 1 - 40;
    memory.writeMemory(last, new Uint8Array([...tail].map(c=>c.charCodeAt(0)).concat(0)));
    whole = 0;
    table.atof.handler([last]);
    assert.ok(Object.is(fpu.result, Number(tail)));
    assert.equal(whole, 1);
});

test('a float literal ending in a bare exponent gives back the exponent', ()=>{
    const scanned = scanFloat('1e');
    assert.equal(scanned?.value, 1);
    assert.equal(scanned?.end, 1);
});

test('_strtoi64 and _strtoui64 read 64 bits, clamping past them with ERANGE', ()=>{
    const memory = fakeMemory();
    /** @type {Record<string, number>} */
    const registers = {};
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (createConversionFunctions({ ...memory,
        setRegisters: values=>Object.assign(registers, values),
        errno: code=>void errno.push(code) }));
    const end = memory.allocate(4);
    /** @param {string} name @param {string} text @param {number} [base] */
    const convert = (name, text, base = 10)=>{
        const at = memory.put(text);
        const low = table[name].handler([at, end, base]) >>> 0;
        return [BigInt(registers.edx >>> 0) << 32n | BigInt(low),
            new DataView(memory.bytes.buffer).getUint32(end, true) - at];
    };
    assert.deepEqual(convert('_strtoi64', ' 4294967301x'), [4294967301n, 11]);
    assert.deepEqual(convert('_strtoi64', '-2'), [0xfffffffffffffffen, 2]);
    assert.deepEqual(convert('_strtoi64', '0x7fffffffffffffff', 0), [0x7fffffffffffffffn, 18]);
    assert.deepEqual(errno, []);
    assert.deepEqual(convert('_strtoi64', '9223372036854775808'), [0x7fffffffffffffffn, 19]);
    assert.deepEqual(convert('_strtoi64', '-9223372036854775809'), [0x8000000000000000n, 20]);
    assert.deepEqual(convert('_strtoui64', '18446744073709551615'), [0xffffffffffffffffn, 20]);
    assert.deepEqual(convert('_strtoui64', '-1'), [0xffffffffffffffffn, 2], 'negation wraps');
    assert.deepEqual(convert('_strtoui64', '18446744073709551616'), [0xffffffffffffffffn, 20]);
    assert.deepEqual(errno, [34, 34, 34], 'ERANGE for each past the range');
    assert.deepEqual(convert('_strtoi64', 'x'), [0n, 0], 'nothing read: the start, and zero');
});

test('a 64-bit caller\'s end pointer is written whole, its high half zero', ()=>{
    // `char *end` is a quadword there: four bytes written leave the high half
    // of whatever the variable held, and the caller's next read faults.
    const memory = fakeMemory();
    const table = /** @type {Record<string, any>} */ (
        createConversionFunctions({ ...memory, pointerSize: 8 }));
    const end = memory.allocate(8);
    const view = new DataView(memory.bytes.buffer);
    view.setBigUint64(end, 0xccccccccccccccccn, true);
    const at = memory.putWide('42x');
    assert.equal(table.wcstol.handler([at, end, 10]), 42);
    assert.equal(view.getBigUint64(end, true), BigInt(at + 4));
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

test('the _*tow family writes _*toa\'s text in UTF-16', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(80);
    assert.equal(table._itow.handler([-42, buffer, 10]), buffer);
    assert.equal(memory.wide(buffer), '-42');
    assert.equal(table._ltow.handler([-1, buffer, 16]), buffer);
    assert.equal(memory.wide(buffer), 'ffffffff', 'only base ten is signed');
    assert.equal(table._ultow.handler([-1, buffer, 10]), buffer);
    assert.equal(memory.wide(buffer), '4294967295');
    assert.equal(table._itow.handler([5, buffer, 2]), buffer);
    assert.equal(memory.wide(buffer), '101');
    assert.equal(table._itow.handler([5, buffer, 1]), 0, 'a radix with no digits is refused');
    assert.equal(table._itow.argBytes, 12);
});

test('_wtoi and _wtol read as atoi reads, wrapping in 32 bits', ()=>{
    const { memory, table } = build();
    assert.equal(table._wtoi.handler([memory.putWide('  -123abc')]), -123);
    assert.equal(table._wtol.handler([memory.putWide('+77')]), 77);
    assert.equal(table._wtoi.handler([memory.putWide('x1')]), 0);
    assert.equal(table._wtoi.handler([memory.putWide('4294967297')]), 1, 'wraps, as atoi does');
    assert.equal(table._wtoi.handler([memory.putWide('١')]), 0, 'only ASCII digits');
});

test('wcstod reads strtod\'s number from a wide string, its end two bytes a character', ()=>{
    const fpu = fakeFpu();
    const { memory, table } = build(fpu);
    const end = memory.allocate(4);
    const string = memory.putWide(' -1.25e1あ');
    table.wcstod.handler([string, end]);
    assert.equal(fpu.result, -12.5);
    assert.equal(memory.u32(end), string + 8 * 2);
    const none = memory.putWide('abc');
    table.wcstod.handler([none, end]);
    assert.equal(fpu.result, 0);
    assert.equal(memory.u32(end), none, 'nothing read leaves the end at the start');
    assert.equal(build().table.wcstod, undefined, 'no FPU, no export');
});
