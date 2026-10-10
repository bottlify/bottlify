/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHive, HKEY_CLASSES_ROOT } from '../advapi32/registry.js';
import { buildImage, buildResources } from '../../loader/internal/resources.test.js';
import { createAutomationFunctions, OLEAUT32_ORDINALS } from './functions.js';
import { IID_ITYPELIB } from './objects.js';
import * as types from './vartypes.js';

const S_OK = 0x00000000;
const E_INVALIDARG = 0x80070057;
const DISP_E_TYPEMISMATCH = 0x80020005;
const DISP_E_OVERFLOW = 0x8002000a;

const VT_EMPTY = 0;
const VT_I2 = 2;
const VT_I4 = 3;
const VT_R8 = 5;
const VT_BSTR = 8;
const VT_UNKNOWN = 13;
const VT_UI1 = 17;
const VT_BYREF = 0x4000;

const VARIANT_ALPHABOOL = 0x0002;
const VT_BOOL = 11;

/** Guest addresses the fixtures use; far enough apart that nothing overlaps. */
const TEXT = 0x1000;
const VARIANT_A = 0x2000;
const VARIANT_B = 0x2020;
const SLOT = 0x2100;

function fakeHost(){
    const bytes = new Uint8Array(0x10000);
    /** @type {Map<number, number>} */
    const live = new Map();
    /** @type {string[]} */
    const said = [];
    let next = 0x8000;

    const host = {
        bytes,
        live,
        said,
        exhausted: false,
        heap: {
            /** @param {number} size */
            allocate(size){
                if (host.exhausted)
                {
                    return 0;
                }
                const address = next;
                next += Math.max(8, size) + 8;
                live.set(address, size);
                return address;
            },
            /** @param {number} address */
            free: address=>live.delete(address),
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} value @param {number} length */
        fillMemory: (address, value, length)=>bytes.fill(value, address, address + length),
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
        /** @param {number} address */
        u16: address=>bytes[address] | (bytes[address + 1] << 8),
        /** @param {number} address */
        u32: address=>(bytes[address] | (bytes[address + 1] << 8)
            | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0,
        /** @param {number} address @param {number} value */
        putU16(address, value){
            bytes[address] = value & 0xff;
            bytes[address + 1] = (value >>> 8) & 0xff;
        },
        /** @param {number} address @param {number} value */
        putU32(address, value){
            for (let index = 0; index < 4; index++)
            {
                bytes[address + index] = (value >>> (index * 8)) & 0xff;
            }
        },
        /** Lays out an OLECHAR string with its terminator. @param {number} at @param {string} text */
        putWide(at, text){
            for (let index = 0; index < text.length; index++)
            {
                host.putU16(at + index * 2, text.charCodeAt(index));
            }
            host.putU16(at + text.length * 2, 0);
        },
        /** @param {number} at @param {number} type @param {number} value */
        putVariant(at, type, value){
            bytes.fill(0, at, at + 16);
            host.putU16(at, type);
            host.putU32(at + 8, value);
        },
    };
    return host;
}

/** @type {ReturnType<typeof fakeHost>} */
let host;
/** @type {Record<string, { argBytes: number, handler: (args: number[]) => number | Promise<number> }>} */
let fx;

/** @param {string} name @param {number[]} args */
const call = (name, args)=>(/** @type {number} */ (fx[name].handler(args))) >>> 0;

const setUp = ()=>{
    host = fakeHost();
    fx = createAutomationFunctions(host);
};

test('error information is held once, handed over once, and absent by default', ()=>{
    setUp();
    host.putU32(SLOT, 0xdeadbeef);
    assert.equal(call('GetErrorInfo', [0, SLOT]), 1, 'S_FALSE: nothing set');
    assert.equal(host.u32(SLOT), 0, 'and the out pointer is cleared');
    assert.equal(call('SetErrorInfo', [0, 0x12340]), 0);
    assert.equal(call('GetErrorInfo', [0, SLOT]), 0);
    assert.equal(host.u32(SLOT), 0x12340);
    assert.equal(call('GetErrorInfo', [0, SLOT]), 1, 'collected once, gone');
    assert.equal(fx.GetErrorInfo.argBytes, 8);
    assert.equal(fx.SetErrorInfo.argBytes, 8);
    // ole32's errorinfo tests: the reserved word is zero or E_INVALIDARG.
    assert.equal(call('GetErrorInfo', [0xdeadbeef, SLOT]) >>> 0, 0x80070057);
    assert.equal(call('SetErrorInfo', [0xdeadbeef, 0]) >>> 0, 0x80070057);
});

test('GetActiveObject finds no running object and clears the out pointer', ()=>{
    setUp();
    host.putU32(SLOT, 0xdeadbeef);
    assert.equal(call('GetActiveObject', [0x1000, 0, SLOT]), 0x800401e3, 'MK_E_UNAVAILABLE');
    assert.equal(host.u32(SLOT), 0);
    assert.equal(call('GetActiveObject', [0x1000, 0, 0]), 0x80070057);
    assert.equal(fx.GetActiveObject.argBytes, 12);
    assert.equal(OLEAUT32_ORDINALS[35], 'GetActiveObject');
});

test('a BSTR carries its byte count in front of the pointer it hands out', ()=>{
    setUp();
    host.putWide(TEXT, 'hi');
    const bstr = call('SysAllocString', [TEXT]);

    assert.notEqual(bstr, 0);
    // The four bytes before the string are its length in BYTES, and the caller
    // holds the address after them. A program reads that prefix directly, so
    // getting it wrong hands it whatever the allocator left in front.
    assert.equal(host.u32(bstr - 4), 4, 'two characters is four bytes');
    assert.equal(host.u16(bstr), 'h'.charCodeAt(0));
    assert.equal(host.u16(bstr + 2), 'i'.charCodeAt(0));
    assert.equal(host.u16(bstr + 4), 0, 'and it is terminated after the last character');
    assert.ok(host.live.has(bstr - 4), 'the block starts at the prefix, not the pointer');
});

test('length is asked in characters and in bytes, and the two differ', ()=>{
    setUp();
    host.putWide(TEXT, 'abcd');
    const bstr = call('SysAllocString', [TEXT]);

    assert.equal(call('SysStringLen', [bstr]), 4);
    assert.equal(call('SysStringByteLen', [bstr]), 8);
});

test('an embedded NUL is kept, because the length is the prefix and not a scan', ()=>{
    setUp();
    const bstr = call('SysAllocStringLen', [TEXT, 3]);
    host.putU16(bstr + 2, 0);

    assert.equal(call('SysStringLen', [bstr]), 3, 'still three characters long');
});

test('SysAllocStringLen(NULL, n) is a real string of n characters, zeroed', ()=>{
    setUp();
    host.bytes.fill(0xa5, 0x8000, 0x8100);
    const bstr = call('SysAllocStringLen', [0, 3]);

    assert.notEqual(bstr, 0, 'a NULL source allocates rather than refusing');
    assert.equal(call('SysStringLen', [bstr]), 3);
    assert.deepEqual([...host.bytes.subarray(bstr, bstr + 8)], [0, 0, 0, 0, 0, 0, 0, 0],
        'the characters and the terminator, with nothing left over from before');
});

test('SysAllocString(NULL) answers NULL rather than an empty string', ()=>{
    setUp();
    assert.equal(call('SysAllocString', [0]), 0);
    assert.equal(host.live.size, 0, 'and allocates nothing');
});

test('SysFreeString(NULL) does nothing at all', ()=>{
    setUp();
    host.putWide(TEXT, 'x');
    const bstr = call('SysAllocString', [TEXT]);

    call('SysFreeString', [0]);
    assert.equal(host.live.size, 1, 'the string that does exist is untouched');
    call('SysFreeString', [bstr]);
    assert.equal(host.live.size, 0);
});

test('SysAllocStringByteLen counts bytes, so an odd length is possible', ()=>{
    setUp();
    host.bytes.set([0x41, 0x42, 0x43], TEXT);
    const bstr = call('SysAllocStringByteLen', [TEXT, 3]);

    assert.equal(call('SysStringByteLen', [bstr]), 3);
    assert.deepEqual([...host.bytes.subarray(bstr, bstr + 3)], [0x41, 0x42, 0x43],
        'the bytes are copied as they are, not interpreted as characters');
});

test('a BSTR goes on the wire as a counted blob and comes back the same, odd and NULL too', ()=>{
    setUp();
    const FLAGS = 0x3000;
    const WIRE = 0x3101;
    const ALIGNED = 0x3104;
    const COPY = SLOT + 4;
    host.putU32(FLAGS, 0x00100002);
    host.putWide(TEXT, 'abc');
    host.putU32(SLOT, call('SysAllocString', [TEXT]));
    host.putU32(COPY, 0);

    assert.equal(call('BSTR_UserSize', [FLAGS, 1, SLOT]), 4 + 12 + 6, 'from a four-byte boundary');
    const end = call('BSTR_UserMarshal', [FLAGS, WIRE, SLOT]);
    assert.equal(end, ALIGNED + 12 + 6);
    assert.deepEqual([host.u32(ALIGNED), host.u32(ALIGNED + 4), host.u32(ALIGNED + 8)], [3, 6, 3],
        'the element count, the byte count, the element count');
    assert.equal(host.u16(ALIGNED + 12), 'a'.charCodeAt(0));
    assert.equal(call('BSTR_UserUnmarshal', [FLAGS, WIRE, COPY]), end);
    const copy = host.u32(COPY);
    assert.notEqual(copy, host.u32(SLOT), 'a string of its own');
    assert.equal(call('SysStringByteLen', [copy]), 6);
    assert.equal(host.u16(copy + 4), 'c'.charCodeAt(0));

    // An odd byte count is rounded up to whole characters on the wire and
    // kept on the way back; the string the slot held is freed.
    host.bytes.set([0x41, 0x42, 0x43], TEXT);
    host.putU32(SLOT, call('SysAllocStringByteLen', [TEXT, 3]));
    assert.equal(call('BSTR_UserSize', [FLAGS, 0, SLOT]), 12 + 4);
    call('BSTR_UserMarshal', [FLAGS, ALIGNED, SLOT]);
    assert.deepEqual([host.u32(ALIGNED), host.u32(ALIGNED + 4), host.u32(ALIGNED + 8)], [2, 3, 2]);
    call('BSTR_UserUnmarshal', [FLAGS, ALIGNED, COPY]);
    assert.ok(!host.live.has(copy - 4), 'the old copy is freed');
    assert.equal(call('SysStringByteLen', [host.u32(COPY)]), 3);

    // NULL: no elements and a byte count of all ones, and NULL again after.
    host.putU32(SLOT, 0);
    assert.equal(call('BSTR_UserSize', [FLAGS, 0, SLOT]), 12);
    assert.equal(call('BSTR_UserMarshal', [FLAGS, ALIGNED, SLOT]), ALIGNED + 12);
    assert.deepEqual([host.u32(ALIGNED), host.u32(ALIGNED + 4), host.u32(ALIGNED + 8)],
        [0, 0xffffffff, 0]);
    assert.equal(call('BSTR_UserUnmarshal', [FLAGS, ALIGNED, COPY]), ALIGNED + 12);
    assert.equal(host.u32(COPY), 0);

    host.putU32(COPY, call('SysAllocString', [TEXT]));
    const live = host.live.size;
    call('BSTR_UserFree', [FLAGS, COPY]);
    assert.equal(host.live.size, live - 1, 'freed');
    assert.equal(host.u32(COPY), 0);
});

test('a VARIANT or a SAFEARRAY is freed as the stubs ask, and marshaled as nothing out loud', ()=>{
    setUp();
    const FLAGS = 0x3000;
    const BOUNDS = 0x3010;
    host.putWide(TEXT, 'abc');
    host.putVariant(VARIANT_A, VT_BSTR, call('SysAllocString', [TEXT]));
    call('VARIANT_UserFree', [FLAGS, VARIANT_A]);
    assert.equal(host.u16(VARIANT_A), VT_EMPTY);
    assert.equal(host.live.size, 0, 'the string is freed');

    host.putU32(BOUNDS, 2);
    host.putU32(BOUNDS + 4, 0);
    host.putU32(SLOT, call('SafeArrayCreate', [VT_I4, 1, BOUNDS]));
    call('LPSAFEARRAY_UserFree', [FLAGS, SLOT]);
    assert.equal(host.live.size, 0, 'the array is destroyed');

    assert.equal(call('VARIANT_UserSize', [FLAGS, 8, VARIANT_A]), 8);
    assert.equal(call('LPSAFEARRAY_UserMarshal', [FLAGS, 0x3100, SLOT]), 0x3100);
    assert.ok(host.said.some(line=>line.includes('VARIANT_UserSize')), JSON.stringify(host.said));
    assert.ok(host.said.some(line=>line.includes('LPSAFEARRAY_UserMarshal')));
});

test('an integral type is read from a string, rounded, and refused outside its range', ()=>{
    setUp();
    const OUT = 0x3000;
    host.putWide(TEXT, '4000000000');
    assert.equal(call('VarUI4FromStr', [TEXT, 0x409, 0, OUT]), S_OK);
    assert.equal(host.u32(OUT), 4000000000);
    assert.equal(call('VarI4FromStr', [TEXT, 0x409, 0, OUT]), 0x8002000a, 'DISP_E_OVERFLOW');
    host.putWide(TEXT, ' 12.6 ');
    assert.equal(call('VarI2FromStr', [TEXT, 0x409, 0, OUT]), S_OK);
    assert.equal(host.u16(OUT), 13);
    host.putWide(TEXT, '-1');
    assert.equal(call('VarUI1FromStr', [TEXT, 0x409, 0, OUT]), 0x8002000a);
    host.putWide(TEXT, 'twelve');
    assert.equal(call('VarUI2FromStr', [TEXT, 0x409, 0, OUT]), 0x80020005, 'DISP_E_TYPEMISMATCH');
    assert.equal(fx.VarUI4FromStr.argBytes, 16);
    assert.equal(OLEAUT32_ORDINALS[277], 'VarUI4FromStr');
});

test('SysReAllocString replaces the string in the slot and frees the old one', ()=>{
    setUp();
    host.putWide(TEXT, 'old');
    const first = call('SysAllocString', [TEXT]);
    host.putU32(SLOT, first);

    host.putWide(TEXT, 'longer');
    assert.equal(call('SysReAllocString', [SLOT, TEXT]), 1);

    const second = host.u32(SLOT);
    assert.notEqual(second, first);
    assert.equal(call('SysStringLen', [second]), 6);
    assert.equal(host.live.has(first - 4), false, 'the old string is gone');
});

test('VarBstrFromBool spells the two booleans, and wants an out pointer', ()=>{
    setUp();
    host.putU32(SLOT, 0xdeadbeef);
    assert.equal(call('VarBstrFromBool', [0xffff, 0, 0, SLOT]) >>> 0, S_OK);
    const yes = host.u32(SLOT);
    assert.equal(host.u16(yes), 'T'.charCodeAt(0));
    assert.equal(host.u16(yes + 2), 'r'.charCodeAt(0));
    assert.equal(host.u16(yes + 8), 0, 'True is four characters, terminated');

    host.putU32(SLOT, 0xdeadbeef);
    assert.equal(call('VarBstrFromBool', [0, 0, 0, SLOT]) >>> 0, S_OK);
    const no = host.u32(SLOT);
    assert.equal(host.u16(no), 'F'.charCodeAt(0));
    assert.equal(host.u16(no + 10), 0, 'False is five characters, terminated');

    assert.equal(call('VarBstrFromBool', [0, 0, 0, 0]) >>> 0, 0x80004003, 'E_POINTER');
});

test('VarParseNumFromStr pulls a decimal string into NUMPARSE and its digits', ()=>{
    setUp();
    const NUMPARSE = 0x3000;
    const DIGITS = 0x3100;
    // LEADING_WHITE | TRAILING_WHITE | LEADING_MINUS | DECIMAL | EXPONENT
    const allowed = 0x0001 | 0x0002 | 0x0010 | 0x0100 | 0x0800;
    const parse = (/** @type {string} */ text, /** @type {number} */ flags = allowed, cDig = 30)=>{
        host.putWide(TEXT, text);
        host.putU32(NUMPARSE, cDig);
        host.putU32(NUMPARSE + 4, flags);
        const result = call('VarParseNumFromStr', [TEXT, 0x409, 0, NUMPARSE, DIGITS]);
        const count = host.u32(NUMPARSE);
        return {
            result,
            count,
            outFlags: host.u32(NUMPARSE + 8),
            used: host.u32(NUMPARSE + 12),
            pwr10: host.u32(NUMPARSE + 20) | 0,
            digits: [...host.bytes.subarray(DIGITS, DIGITS + count)],
        };
    };

    const plain = parse(' -12.50e2 ');
    assert.equal(plain.result, S_OK);
    assert.deepEqual(plain.digits, [1, 2, 5], 'the trailing zero moves into the power of ten');
    assert.equal(plain.pwr10, 1, '-12.50e2 is -125 x 10^1');
    assert.equal(plain.outFlags, 0x0001 | 0x0002 | 0x0010 | 0x0100 | 0x0800 | 0x10000);
    assert.equal(plain.used, 10);
    assert.equal(host.u32(NUMPARSE + 4), allowed, 'dwInFlags is only read');

    assert.deepEqual(parse('100').digits, [1]);
    assert.equal(parse('100').pwr10, 2);
    assert.deepEqual(parse('0').digits, [0], 'a zero is one digit');
    assert.equal(parse('0.05').pwr10, -2);

    const cut = parse('12345', allowed, 3);
    assert.deepEqual(cut.digits, [1, 2, 3]);
    assert.equal(cut.pwr10, 2);
    assert.equal(cut.outFlags & 0x20000, 0x20000, 'dropping non-zero digits is INEXACT');

    // A form the caller does not allow ends the number rather than joining it.
    const noWhite = parse(' 1', 0);
    assert.equal(noWhite.result, DISP_E_TYPEMISMATCH >>> 0);
    const stops = parse('1.5', 0);
    assert.equal(stops.result, S_OK);
    assert.equal(stops.used, 1);
    assert.equal(parse('1.5', 0x1000).result, DISP_E_TYPEMISMATCH >>> 0, 'USE_ALL wants it all');
    assert.equal(parse('abc').result, DISP_E_TYPEMISMATCH >>> 0);
    assert.equal(call('VarParseNumFromStr', [TEXT, 0x409, 0, 0, DIGITS]), E_INVALIDARG);

    host.said.length = 0;
    parse('&H10', 0x0040);
    assert.ok(host.said.some(line=>line.includes('hex')), 'an unparsed form is reported');
});

test('VarNumFromParseNum picks the smallest type the caller allows', ()=>{
    setUp();
    const NUMPARSE = 0x3000;
    const DIGITS = 0x3100;
    const VTBIT = (/** @type {number} */ vt)=>2 ** vt;
    /** @param {number[]} digits @param {number} pwr10 @param {boolean} negative @param {number} bits */
    const make = (digits, pwr10, negative, bits)=>{
        host.bytes.fill(0, NUMPARSE, NUMPARSE + 24);
        host.putU32(NUMPARSE, digits.length);
        host.putU32(NUMPARSE + 8, negative ? 0x10000 : 0);
        host.putU32(NUMPARSE + 20, pwr10 >>> 0);
        host.bytes.set(digits, DIGITS);
        host.bytes.fill(0xa5, VARIANT_A, VARIANT_A + 16);
        return call('VarNumFromParseNum', [NUMPARSE, DIGITS, bits, VARIANT_A]);
    };
    const view = ()=>new DataView(host.bytes.buffer, VARIANT_A, 16);

    const ints = VTBIT(VT_UI1) | VTBIT(VT_I2) | VTBIT(VT_I4);
    assert.equal(make([2, 5], 0, false, ints), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_UI1);
    assert.equal(host.bytes[VARIANT_A + 8], 25);

    assert.equal(make([3], 3, true, ints), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_I2);
    assert.equal(view().getInt16(8, true), -3000);

    assert.equal(make([1, 5], -1, false, VTBIT(VT_I4)), S_OK, 'a fraction rounds to an integer');
    assert.equal(view().getInt32(8, true), 2);

    assert.equal(make([1, 5], -1, false, ints | VTBIT(VT_R8)), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_R8);
    assert.equal(view().getFloat64(8, true), 1.5);

    assert.equal(make([1], 12, false, ints), DISP_E_OVERFLOW >>> 0);
    assert.equal(make([1], 0, false, 0), DISP_E_OVERFLOW >>> 0);
    assert.equal(call('VarNumFromParseNum', [0, DIGITS, ints, VARIANT_A]), E_INVALIDARG);
});

test('VariantInit empties the whole variant, not only its type', ()=>{
    setUp();
    host.bytes.fill(0xa5, VARIANT_A, VARIANT_A + 16);
    call('VariantInit', [VARIANT_A]);

    assert.deepEqual([...host.bytes.subarray(VARIANT_A, VARIANT_A + 16)], new Array(16).fill(0));
});

test('VariantClear frees the string a variant held and empties the type', ()=>{
    setUp();
    host.putWide(TEXT, 'held');
    const bstr = call('SysAllocString', [TEXT]);
    host.putVariant(VARIANT_A, VT_BSTR, bstr);

    assert.equal(call('VariantClear', [VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_EMPTY);
    assert.equal(host.u32(VARIANT_A + 8), 0);
    assert.equal(host.live.has(bstr - 4), false);
});

test('VariantCopy of a string makes a second string, not a second pointer', ()=>{
    setUp();
    host.putWide(TEXT, 'shared');
    const bstr = call('SysAllocString', [TEXT]);
    host.putVariant(VARIANT_A, VT_BSTR, bstr);

    assert.equal(call('VariantCopy', [VARIANT_B, VARIANT_A]), S_OK);
    const copy = host.u32(VARIANT_B + 8);
    assert.notEqual(copy, bstr, 'the copy owns its own storage');
    assert.equal(call('SysStringLen', [copy]), 6);

    // The two are independent, which is the whole point: clearing one must not
    // leave the other pointing at a freed block.
    call('VariantClear', [VARIANT_A]);
    assert.equal(call('SysStringLen', [copy]), 6);
});

test('VariantCopy keeps a reference a reference; only CopyInd follows it', ()=>{
    setUp();
    host.putU32(SLOT, 77);
    host.putVariant(VARIANT_A, VT_I4 | VT_BYREF, SLOT);

    assert.equal(call('VariantCopy', [VARIANT_B, VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_B), VT_I4 | VT_BYREF);
    assert.equal(host.u32(VARIANT_B + 8), SLOT);

    assert.equal(call('VariantCopyInd', [VARIANT_B, VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_B), VT_I4, 'the reference is gone');
    assert.equal(host.u32(VARIANT_B + 8), 77, 'and the value is here');
});

const VT_ARRAY = 0x2000;
const DISP_E_ARRAYISLOCKED = 0x8002000d;

/**
 * A one-dimensional array of two strings, 'alpha' and 'beta', and its
 * descriptor's address.
 *
 * @returns {number}
 */
const stringArray = ()=>{
    const BOUNDS = 0x3000;
    const INDEX = 0x3040;
    host.putU32(BOUNDS, 2);
    host.putU32(BOUNDS + 4, 0);
    const psa = call('SafeArrayCreate', [VT_BSTR, 1, BOUNDS]);
    for (const [at, text] of /** @type {[number, string][]} */ ([[0, 'alpha'], [1, 'beta']]))
    {
        host.putWide(TEXT, text);
        host.putU32(INDEX, at);
        const made = call('SysAllocString', [TEXT]);
        assert.equal(call('SafeArrayPutElement', [psa, INDEX, made]), S_OK);
        call('SysFreeString', [made]); // the array took a copy
    }
    return psa;
};

/**
 * The string at `at` of an array of strings, read through SafeArrayGetElement.
 *
 * @param {number} psa @param {number} at
 */
const stringAt = (psa, at)=>{
    host.putU32(0x3040, at);
    assert.equal(call('SafeArrayGetElement', [psa, 0x3040, SLOT]), S_OK);
    const bstr = host.u32(SLOT);
    let text = '';
    for (let index = 0; index < call('SysStringLen', [bstr]); index++)
    {
        text += String.fromCharCode(host.u16(bstr + index * 2));
    }
    call('SysFreeString', [bstr]);
    return text;
};

test('VariantCopy of an array makes an array of its own, as SafeArrayCopy does, and clearing the'
    + ' source leaves the copy whole', ()=>{
    setUp();
    const original = stringArray();
    host.putVariant(VARIANT_A, VT_ARRAY | VT_BSTR, original);

    assert.equal(call('VariantCopy', [VARIANT_B, VARIANT_A]), S_OK);
    const copy = host.u32(VARIANT_B + 8);
    assert.equal(host.u16(VARIANT_B), VT_ARRAY | VT_BSTR);
    assert.notEqual(copy, original, 'not the same descriptor');
    assert.notEqual(host.u32(copy + 12), host.u32(original + 12), 'nor the same data');
    assert.equal(stringAt(copy, 0), 'alpha');

    assert.equal(call('VariantClear', [VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_EMPTY);
    assert.equal(host.live.has(original), false, 'the array the variant held is destroyed');
    assert.equal(stringAt(copy, 1), 'beta', 'and what was copied out of it stands');
    assert.equal(call('VariantClear', [VARIANT_B]), S_OK);
    assert.equal(host.live.has(copy), false);
    assert.equal(host.live.size, 0, 'every string and descriptor is given back');
});

test('an element put into a copied array is not seen through the array it was copied from', ()=>{
    setUp();
    const original = stringArray();
    host.putVariant(VARIANT_A, VT_ARRAY | VT_BSTR, original);
    assert.equal(call('VariantCopy', [VARIANT_B, VARIANT_A]), S_OK);
    const copy = host.u32(VARIANT_B + 8);

    host.putWide(TEXT, 'gamma');
    host.putU32(0x3040, 0);
    const made = call('SysAllocString', [TEXT]);
    assert.equal(call('SafeArrayPutElement', [copy, 0x3040, made]), S_OK);
    call('SysFreeString', [made]);

    assert.equal(stringAt(copy, 0), 'gamma');
    assert.equal(stringAt(original, 0), 'alpha');
});

test('VariantCopy of an array reference is a reference, and clearing it destroys nothing', ()=>{
    setUp();
    const original = stringArray();
    host.putU32(SLOT, original);
    host.putVariant(VARIANT_A, VT_ARRAY | VT_BSTR | VT_BYREF, SLOT);

    assert.equal(call('VariantCopy', [VARIANT_B, VARIANT_A]), S_OK);
    assert.equal(host.u32(VARIANT_B + 8), SLOT, 'the copy points where the source did');
    assert.equal(call('VariantClear', [VARIANT_B]), S_OK);
    assert.equal(host.live.has(original), true, 'the array is the owner of the reference\'s');
});

test('VariantClear leaves a locked array in its variant and says so', ()=>{
    setUp();
    const original = stringArray();
    host.putVariant(VARIANT_A, VT_ARRAY | VT_BSTR, original);
    assert.equal(call('SafeArrayLock', [original]), S_OK);

    assert.equal(call('VariantClear', [VARIANT_A]), DISP_E_ARRAYISLOCKED);
    assert.equal(host.u16(VARIANT_A), VT_ARRAY | VT_BSTR);
    assert.equal(host.u32(VARIANT_A + 8), original);

    assert.equal(call('SafeArrayUnlock', [original]), S_OK);
    assert.equal(call('VariantClear', [VARIANT_A]), S_OK);
    assert.equal(host.live.size, 0);
});

test('an array of variants is copied and cleared down to the arrays inside it', ()=>{
    setUp();
    const BOUNDS = 0x3000;
    host.putU32(BOUNDS, 1);
    host.putU32(BOUNDS + 4, 0);
    const outer = call('SafeArrayCreate', [12, 1, BOUNDS]);
    const inner = stringArray();
    host.putVariant(VARIANT_A, VT_ARRAY | VT_BSTR, inner);
    host.putU32(0x3040, 0);
    assert.equal(call('SafeArrayPutElement', [outer, 0x3040, VARIANT_A]), S_OK);
    host.putVariant(VARIANT_B, VT_ARRAY | 12, outer);

    assert.equal(call('VariantCopy', [VARIANT_A, VARIANT_B]), S_OK);
    const copy = host.u32(VARIANT_A + 8);
    const element = host.u32(copy + 12);
    assert.equal(host.u16(element), VT_ARRAY | VT_BSTR);
    assert.notEqual(host.u32(element + 8), inner, 'the array inside is a copy too');

    assert.equal(call('VariantClear', [VARIANT_B]), S_OK);
    assert.equal(host.live.has(inner), false, 'clearing the outer one destroys what it held');
    assert.equal(call('VariantClear', [VARIANT_A]), S_OK);
    assert.equal(host.live.size, 0);
});

test('a number becomes a string and reads back as the same number', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_I4, 4294967295); // -1 as a signed long

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_BSTR]), S_OK);
    assert.equal(host.u16(VARIANT_B), VT_BSTR);
    const bstr = host.u32(VARIANT_B + 8);
    assert.equal(call('SysStringLen', [bstr]), 2, '"-1"');

    assert.equal(call('VariantChangeType', [VARIANT_A, VARIANT_B, 0, VT_I4]), S_OK);
    assert.equal(host.u32(VARIANT_A + 8), 0xffffffff);
});

test('a boolean is minus one, not one', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_I4, 5);

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_BOOL]), S_OK);
    // A program tests `== VARIANT_TRUE` as readily as it tests non-zero, so a
    // boolean stored as 1 is neither true nor false to the code that asked.
    assert.equal(host.u16(VARIANT_B + 8), 0xffff);
});

test('a boolean spells itself as a number unless words were asked for', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_BOOL, 0xffff);

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_BSTR]), S_OK);
    assert.equal(call('SysStringLen', [host.u32(VARIANT_B + 8)]), 2, '"-1"');

    assert.equal(
        call('VariantChangeType', [VARIANT_B, VARIANT_A, VARIANT_ALPHABOOL, VT_BSTR]), S_OK);
    assert.equal(call('SysStringLen', [host.u32(VARIANT_B + 8)]), 4, '"True"');
});

test('a value that will not fit the target overflows rather than wrapping', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_I4, 300);

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_UI1]), DISP_E_OVERFLOW);
    assert.equal(host.u16(VARIANT_B), VT_EMPTY, 'and nothing is left in the destination');
});

test('a rounded conversion goes to nearest, a half to the even neighbour', ()=>{
    // What VarI2FromR8 answers on Windows (vartype.c): 0.5 and -0.5 are 0, 1.5
    // is 2 and -1.5 is -2 -- banker's rounding, not halves away from zero.
    setUp();
    const view = new DataView(host.bytes.buffer);
    for (const [from, to] of [[2.5, 2], [3.5, 4], [0.5, 0], [-0.5, 0], [-1.5, -2], [0.6, 1]])
    {
        host.putVariant(VARIANT_A, VT_R8, 0);
        view.setFloat64(VARIANT_A + 8, from, true);
        assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_I2]), S_OK);
        assert.equal(view.getInt16(VARIANT_B + 8, true), to, String(from));
    }
    view.setFloat64(VARIANT_A + 8, 32767.5, true);
    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_I2]), DISP_E_OVERFLOW,
        'rounds to 32768, past the type');
});

test('a string that is not a number is a type mismatch, not a zero', ()=>{
    setUp();
    host.putWide(TEXT, 'banana');
    host.putVariant(VARIANT_A, VT_BSTR, call('SysAllocString', [TEXT]));

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_I4]),
        DISP_E_TYPEMISMATCH);
});

test('a conversion may write over its own source', ()=>{
    setUp();
    host.putWide(TEXT, '42');
    host.putVariant(VARIANT_A, VT_BSTR, call('SysAllocString', [TEXT]));

    assert.equal(call('VariantChangeType', [VARIANT_A, VARIANT_A, 0, VT_I4]), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_I4);
    assert.equal(host.u32(VARIANT_A + 8), 42, 'read before the destination was freed');
});

test('a NULL variant is rejected rather than written through', ()=>{
    setUp();
    assert.equal(call('VariantClear', [0]), E_INVALIDARG);
    assert.equal(call('VariantCopy', [0, VARIANT_A]), E_INVALIDARG);
    assert.equal(call('VariantChangeType', [VARIANT_B, 0, 0, VT_I4]), E_INVALIDARG);
});

/** Two objects in guest memory, `a` and `b`, and a vtable each. */
const OBJECT_A = 0x6000;
const OBJECT_B = 0x6010;

/**
 * Functions whose calls into the guest are written down: each object's
 * AddRef and Release is an entry of its own, so the log says which object
 * was counted which way, in the order it happened.
 *
 * @returns {string[]}
 */
const counting = ()=>{
    setUp();
    /** @type {Map<number, { name: string, object: number }>} */
    const entries = new Map();
    for (const [object, name] of /** @type {[number, string][]} */ ([[OBJECT_A, 'a'],
        [OBJECT_B, 'b']]))
    {
        const vtable = object + 0x100;
        host.putU32(object, vtable);
        host.putU32(vtable + 4, 0xa0000 + object);
        host.putU32(vtable + 8, 0xb0000 + object);
        entries.set(0xa0000 + object, { name: `AddRef ${name}`, object });
        entries.set(0xb0000 + object, { name: `Release ${name}`, object });
    }
    /** @type {string[]} */
    const calls = [];
    fx = createAutomationFunctions({
        ...host,
        /** @param {number} entry @param {number[]} args */
        call: (entry, args)=>{
            const called = entries.get(entry);
            assert.ok(called, `0x${entry.toString(16)} is no AddRef or Release`);
            assert.deepEqual(args, [called.object], 'this is the object called');
            calls.push(called.name);
            return Promise.resolve(0);
        },
    });
    return calls;
};

/** @param {string} name @param {number[]} args */
const settled = async(name, args)=>(await fx[name].handler(args)) >>> 0;

test('VariantClear gives back the reference a variant held, through the object\'s Release',
    async()=>{
        const calls = counting();
        host.putVariant(VARIANT_A, VT_UNKNOWN, OBJECT_A);
        assert.equal(await settled('VariantClear', [VARIANT_A]), S_OK);
        assert.equal(host.u16(VARIANT_A), VT_EMPTY);
        assert.deepEqual(calls, ['Release a']);

        host.putVariant(VARIANT_A, VT_UNKNOWN, 0);
        assert.equal(await settled('VariantClear', [VARIANT_A]), S_OK);
        host.putVariant(VARIANT_A, VT_UNKNOWN | VT_BYREF, SLOT);
        assert.equal(await settled('VariantClear', [VARIANT_A]), S_OK);
        assert.deepEqual(calls, ['Release a'], 'a null pointer or a reference owns nothing');
    });

test('a copy of a variant holds a reference of its own, and the one it replaced is given back',
    async()=>{
        const calls = counting();
        host.putVariant(VARIANT_A, VT_UNKNOWN, OBJECT_A);
        host.putVariant(VARIANT_B, VT_UNKNOWN, OBJECT_B);
        assert.equal(await settled('VariantCopy', [VARIANT_B, VARIANT_A]), S_OK);
        assert.equal(host.u32(VARIANT_B + 8), OBJECT_A);
        assert.deepEqual(calls, ['AddRef a', 'Release b']);

        calls.length = 0;
        host.putVariant(VARIANT_B, VT_EMPTY, 0);
        assert.equal(await settled('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_UNKNOWN]),
            S_OK);
        assert.equal(await settled('VariantCopyInd', [VARIANT_B, VARIANT_A]), S_OK);
        assert.deepEqual(calls, ['AddRef a', 'AddRef a', 'Release a'],
            'a conversion and VariantCopyInd copy as VariantCopy does');
    });

test('a variant copied or converted onto itself keeps the count it had', async()=>{
    const calls = counting();
    host.putVariant(VARIANT_A, VT_UNKNOWN, OBJECT_A);
    assert.equal(await settled('VariantCopy', [VARIANT_A, VARIANT_A]), S_OK);
    assert.equal(await settled('VariantCopyInd', [VARIANT_A, VARIANT_A]), S_OK);
    assert.deepEqual(calls, []);
    assert.equal(await settled('VariantChangeType', [VARIANT_A, VARIANT_A, 0, VT_UNKNOWN]), S_OK);
    assert.deepEqual(calls, ['AddRef a', 'Release a'], 'taken before it is given back');
    assert.equal(host.u32(VARIANT_A + 8), OBJECT_A);
});

test('a SAFEARRAY holds a reference to every interface in it, as its elements or in its variants',
    async()=>{
        const calls = counting();
        const BOUNDS = 0x3000;
        const INDEX = 0x3040;
        host.putU32(BOUNDS, 2);
        host.putU32(BOUNDS + 4, 0);
        const interfaces = call('SafeArrayCreate', [VT_UNKNOWN, 1, BOUNDS]);
        host.putU32(INDEX, 0);
        assert.equal(await settled('SafeArrayPutElement', [interfaces, INDEX, OBJECT_A]), S_OK);
        assert.equal(await settled('SafeArrayPutElement', [interfaces, INDEX, OBJECT_B]), S_OK);
        assert.deepEqual(calls, ['AddRef a', 'AddRef b', 'Release a'], 'put over another');
        calls.length = 0;
        assert.equal(await settled('SafeArrayGetElement', [interfaces, INDEX, SLOT]), S_OK);
        assert.equal(host.u32(SLOT), OBJECT_B);
        assert.equal(await settled('SafeArrayCopy', [interfaces, SLOT]), S_OK);
        const copy = host.u32(SLOT);
        assert.deepEqual(calls, ['AddRef b', 'AddRef b'], 'what is got and what is copied');
        calls.length = 0;
        assert.equal(await settled('SafeArrayDestroy', [interfaces]), S_OK);
        assert.equal(await settled('SafeArrayDestroy', [copy]), S_OK);
        assert.deepEqual(calls, ['Release b', 'Release b']);

        calls.length = 0;
        const variants = call('SafeArrayCreate', [12, 1, BOUNDS]);
        host.putVariant(VARIANT_A, VT_UNKNOWN, OBJECT_A);
        host.putU32(INDEX, 1);
        assert.equal(await settled('SafeArrayPutElement', [variants, INDEX, VARIANT_A]), S_OK);
        assert.equal(await settled('SafeArrayDestroy', [variants]), S_OK);
        assert.deepEqual(calls, ['AddRef a', 'Release a']);
    });

test('without a way into guest code a reference is left as it was, and that is reported', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_UNKNOWN, 0x4444);

    assert.equal(call('VariantClear', [VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_EMPTY);
    // Accepting a call and not doing all of it is the defect class that shows
    // up as behaviour rather than as an error, so it has to be said out loud.
    assert.ok(host.said.some(line=>line.includes('not counted')),
        `nothing reported the missing Release: ${JSON.stringify(host.said)}`);
});

test('an exhausted heap fails the allocation instead of answering a bad pointer', ()=>{
    setUp();
    host.putWide(TEXT, 'x');
    host.exhausted = true;

    assert.equal(call('SysAllocString', [TEXT]), 0);
    assert.equal(call('SysReAllocString', [SLOT, TEXT]), 0, 'and the slot is left alone');
    assert.equal(host.u32(SLOT), 0);
});

test('every ordinal names a function this library actually has', ()=>{
    setUp();
    // A program of this era imports oleaut32 by number alone -- there is no
    // name in its import table -- so an ordinal pointing at nothing is a call
    // that binds and then jumps into nowhere with nothing to name it.
    for (const [ordinal, name] of Object.entries(OLEAUT32_ORDINALS))
    {
        assert.ok(name in fx, `ordinal ${ordinal} names ${name}, which is not implemented`);
    }
});

test('the property frame is refused out loud, with the stack it was pushed', ()=>{
    setUp();
    // Imported by number and never by name, so nothing in a program's import
    // table would say which call this is. Declared all the same: the loader's
    // stub for an unclaimed ordinal pops nothing, and eleven arguments left on
    // the stack corrupt the caller from there on.
    assert.equal(fx.OleCreatePropertyFrame.argBytes, 44);
    assert.equal(call('OleCreatePropertyFrame', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        0x80004001, 'E_NOTIMPL, which a caller checks');
    assert.ok(host.said.some(line=>line.includes('OleCreatePropertyFrame')),
        `nothing reported the refusal: ${JSON.stringify(host.said)}`);
});

test('the ordinals are the ones a real oleaut32 exports', ()=>{
    // Read off a real export directory. A wrong number here binds a call to a
    // different function and nothing anywhere would say so.
    assert.equal(OLEAUT32_ORDINALS[2], 'SysAllocString');
    assert.equal(OLEAUT32_ORDINALS[6], 'SysFreeString');
    assert.equal(OLEAUT32_ORDINALS[7], 'SysStringLen');
    assert.equal(OLEAUT32_ORDINALS[8], 'VariantInit');
    assert.equal(OLEAUT32_ORDINALS[9], 'VariantClear');
    assert.equal(OLEAUT32_ORDINALS[12], 'VariantChangeType');
    // The SafeArray block: a program that imports 15 wants an array made,
    // and one bound to the dimension count instead corrupts its stack.
    assert.equal(OLEAUT32_ORDINALS[15], 'SafeArrayCreate');
    assert.equal(OLEAUT32_ORDINALS[16], 'SafeArrayDestroy');
    assert.equal(OLEAUT32_ORDINALS[17], 'SafeArrayGetDim');
    assert.equal(OLEAUT32_ORDINALS[18], 'SafeArrayGetElemsize');
    assert.equal(OLEAUT32_ORDINALS[19], 'SafeArrayGetUBound');
    assert.equal(OLEAUT32_ORDINALS[20], 'SafeArrayGetLBound');
    assert.equal(OLEAUT32_ORDINALS[21], 'SafeArrayLock');
    assert.equal(OLEAUT32_ORDINALS[22], 'SafeArrayUnlock');
    assert.equal(OLEAUT32_ORDINALS[23], 'SafeArrayAccessData');
    assert.equal(OLEAUT32_ORDINALS[24], 'SafeArrayUnaccessData');
    assert.equal(OLEAUT32_ORDINALS[25], 'SafeArrayGetElement');
    assert.equal(OLEAUT32_ORDINALS[26], 'SafeArrayPutElement');
    assert.equal(OLEAUT32_ORDINALS[27], 'SafeArrayCopy');
    assert.equal(OLEAUT32_ORDINALS[28], 'DispGetParam');
    assert.equal(OLEAUT32_ORDINALS[29], 'DispGetIDsOfNames');
    assert.equal(OLEAUT32_ORDINALS[40], 'SafeArrayRedim');
    assert.equal(OLEAUT32_ORDINALS[147], 'VariantChangeTypeEx');
    assert.equal(OLEAUT32_ORDINALS[149], 'SysStringByteLen');
    // The user marshal routines a MIDL-made proxy imports by number.
    assert.equal(OLEAUT32_ORDINALS[283], 'BSTR_UserSize');
    assert.equal(OLEAUT32_ORDINALS[286], 'BSTR_UserFree');
    assert.equal(OLEAUT32_ORDINALS[290], 'VARIANT_UserFree');
    assert.equal(OLEAUT32_ORDINALS[294], 'LPSAFEARRAY_UserFree');
    assert.equal(OLEAUT32_ORDINALS[184], 'SystemTimeToVariantTime');
    assert.equal(OLEAUT32_ORDINALS[318], 'VarCat');
    assert.equal(OLEAUT32_ORDINALS[150], 'SysAllocStringByteLen');
    assert.equal(OLEAUT32_ORDINALS[161], 'LoadTypeLib');
    assert.equal(OLEAUT32_ORDINALS[163], 'RegisterTypeLib');
    assert.equal(OLEAUT32_ORDINALS[417], 'OleCreatePropertyFrame');
});

test('without a volume or vtables no type library loads, and the pointer says so', ()=>{
    setUp();
    host.putWide(TEXT, 'C:\\lib.tlb');
    host.putU32(SLOT, 0xdeadbeef);
    assert.equal(call('LoadTypeLib', [TEXT, SLOT]) | 0, 0x80029c4a | 0);
    assert.equal(host.u32(SLOT), 0);
    host.putU32(SLOT, 0xdeadbeef);
    assert.equal(call('LoadRegTypeLib', [TEXT, 1, 0, 0, SLOT]) | 0, 0x8002801d | 0);
    assert.equal(host.u32(SLOT), 0);
    assert.equal(call('RegisterTypeLib', [0x1234, TEXT, 0]) | 0, 0x80070057 | 0);
    assert.equal(fx.LoadTypeLib.argBytes, 8);
    assert.equal(fx.LoadTypeLibEx.argBytes, 12);
    assert.equal(fx.LoadRegTypeLib.argBytes, 20);
    assert.equal(fx.RegisterTypeLib.argBytes, 12);
    assert.equal(fx.UnRegisterTypeLib.argBytes, 20);
});

/** An MSFT type library, as a .tlb file holds it. */
const FIXTURE_LIBRARY = new Uint8Array(
    readFileSync(new URL('./msft-typelib.bin', import.meta.url)));

/**
 * The fixture library, on a one-file volume, with a hive and a publisher.
 *
 * @param {string} [where]  The one file's path. @param {Uint8Array} [content]  Its bytes.
 */
function libraryHost(where = 'c:\\lib\\engine.tlb', content = undefined){
    const base = fakeHost();
    const bytes = content ?? FIXTURE_LIBRARY;
    /** @type {{ object: any, id: string }[]} */
    const published = [];
    /** @type {string[]} */
    const opened = [];
    const hive = createHive();
    return {
        ...base,
        hive,
        published,
        opened,
        files: {
            /** @param {string} path */
            stat: path=>(path.toLowerCase() === where
                ? { exists: true, isDirectory: false, size: bytes.length }
                : { exists: false, isDirectory: false, size: 0 }),
            /** @param {string} path */
            open: path=>{
                opened.push(path);
                return { path };
            },
            /** @param {any} node @param {number} offset @param {number} length */
            read: (node, offset, length)=>(opened.length % 2 === 0
                ? Promise.resolve(bytes.subarray(offset, offset + length))
                : bytes.subarray(offset, offset + length)),
            close: ()=>{},
        },
        vtables: {
            /** @param {any} object @param {string} id */
            publish: (object, id)=>{
                published.push({ object, id });
                return 0x7000 + published.length * 16;
            },
        },
        call: ()=>Promise.resolve(0),
    };
}

test('LoadTypeLib reads a library an executable carries as its TYPELIB resource', async()=>{
    // A COM server names its own image to register its library: the library
    // is resource TYPELIB 1 inside it, and \\N after the path names another.
    const rsrc = buildResources([{ type: 'TYPELIB',
        names: [{ name: 1, langs: [{ lang: 0, data: [...FIXTURE_LIBRARY] }] }] }]);
    const lib = libraryHost('c:\\lib\\kernel.exe', buildImage(rsrc).bytes);
    const fns = createAutomationFunctions(lib);
    lib.putWide(TEXT, 'C:\\lib\\kernel.exe');
    assert.equal(await fns.LoadTypeLib.handler([TEXT, SLOT]), 0);
    assert.equal(lib.published[0].id, IID_ITYPELIB);
    lib.putWide(TEXT, 'C:\\lib\\kernel.exe\\2');
    assert.equal(await fns.LoadTypeLib.handler([TEXT, SLOT]) | 0, 0x80029c4a | 0,
        'no second library in it: TYPE_E_CANTLOADLIBRARY');
});

test('LoadTypeLib reads the file off the volume, and the library registers and loads back',
    async()=>{
        const lib = libraryHost();
        const fns = createAutomationFunctions(lib);
        lib.putWide(TEXT, 'C:\\lib\\engine.tlb');
        assert.equal(fns.LoadTypeLib.handler([TEXT, SLOT]), 0);
        const pointer = lib.u32(SLOT);
        assert.equal(pointer, 0x7010);
        assert.equal(lib.published[0].id, IID_ITYPELIB);
        assert.equal(lib.opened.length, 1, 'read once, whole');

        assert.equal(fns.RegisterTypeLib.handler([pointer, TEXT, 0]), 0);
        const root = /** @type {any} */ (lib.hive.root(HKEY_CLASSES_ROOT));
        const version = lib.hive.open(root, 'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}\\1.0');
        assert.ok(version, 'the version key, in hex');
        const text = (/** @type {Uint8Array} */ data)=>String.fromCharCode(
            ...data.subarray(0, data.indexOf(0)));
        assert.equal(text(/** @type {any} */ (lib.hive.getValue(version, '')).data),
            'InstallShield Professional Setup Kernel 7.0');
        const win32 = /** @type {any} */ (lib.hive.open(version, '0\\win32'));
        assert.equal(text(/** @type {any} */ (lib.hive.getValue(win32, '')).data),
            'C:\\lib\\engine.tlb');
        assert.equal(text(/** @type {any} */ (lib.hive.getValue(
            /** @type {any} */ (lib.hive.open(version, 'HELPDIR')), '')).data), 'C:\\lib');
        assert.equal(text(/** @type {any} */ (lib.hive.getValue(
            /** @type {any} */ (lib.hive.open(version, 'FLAGS')), '')).data), '0');
        // An [oleautomation] interface goes to the universal marshaler, with
        // the library that describes it; one that is neither that nor dual
        // needs a proxy of its own, which a library cannot provide.
        const media = /** @type {any} */ (lib.hive.open(root,
            'Interface\\{91814EBF-B5F0-11D2-80B9-00104B1F6CEA}'));
        const valueOf = (/** @type {string} */ path, name = '')=>text(/** @type {any} */ (
            lib.hive.getValue(/** @type {any} */ (lib.hive.open(media, path)), name)).data);
        assert.equal(text(/** @type {any} */ (lib.hive.getValue(media, '')).data), 'ISetupMedia');
        assert.equal(valueOf('ProxyStubClsid32'), '{00020424-0000-0000-C000-000000000046}');
        assert.equal(valueOf('TypeLib'), '{94636247-BC39-4B8B-A728-2D1FBEBFA76A}');
        assert.equal(valueOf('TypeLib', 'Version'), '1.0');
        assert.equal(lib.hive.open(root, 'Interface\\{F4817E4B-04B6-11D3-8862-00C04F72F303}'),
            null, 'ISetupServiceProvider is not carried');

        // Loaded back by GUID and version, through a read that arrives later.
        lib.writeMemory(0x3000, Uint8Array.from([0x47, 0x62, 0x63, 0x94, 0x39, 0xbc, 0x8b, 0x4b,
            0xa7, 0x28, 0x2d, 0x1f, 0xbe, 0xbf, 0xa7, 0x6a]));
        const loading = fns.LoadRegTypeLib.handler([0x3000, 1, 0, 0, SLOT]);
        assert.ok(loading instanceof Promise, 'parked on the bytes');
        assert.equal(await loading, 0);
        assert.equal(lib.u32(SLOT), 0x7020, 'a second library object');
        assert.equal(lib.live.size, 0, 'the path string made for the load is freed');
        assert.equal(/** @type {number} */ (fns.LoadRegTypeLib.handler([0x3000, 2, 0, 0, SLOT])) | 0,
            0x8002801d | 0, 'only the registered version');

        assert.equal(fns.UnRegisterTypeLib.handler([0x3000, 1, 0, 0, 1]), 0);
        assert.equal(lib.hive.open(root, 'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}'), null);
        assert.equal(fns.UnRegisterTypeLib.handler([0x3000, 1, 0, 0, 1]) | 0, 0x8002801d | 0);
        assert.equal(/** @type {number} */ (fns.LoadRegTypeLib.handler([0x3000, 1, 0, 0, SLOT])) | 0,
            0x8002801d | 0);

        lib.putWide(TEXT, 'C:\\lib\\missing.tlb');
        assert.equal(/** @type {number} */ (fns.LoadTypeLib.handler([TEXT, SLOT])) | 0,
            0x80029c4a | 0);
        assert.equal(lib.u32(SLOT), 0);
        assert.ok(lib.said.some(line=>line.includes('missing.tlb')));
    });

test('a library registered from a path in the upper half of the ANSI page loads back from it',
    async()=>{
        // The registry keeps a string in the ANSI page, where 0x80 is the euro
        // sign: the path RegisterTypeLib keeps is in that page, and
        // LoadRegTypeLib reads it back in that page, so it names the same file.
        const lib = libraryHost();
        const original = lib.files;
        lib.files = { ...original,
            stat: (/** @type {string} */ path)=>original.stat(path.replace('\u20ac', '')) };
        const fns = createAutomationFunctions(lib);
        lib.putWide(TEXT, 'C:\\lib\u20ac\\engine.tlb');
        assert.equal(fns.LoadTypeLib.handler([TEXT, SLOT]), 0);
        assert.equal(fns.RegisterTypeLib.handler([lib.u32(SLOT), TEXT, 0]), 0);
        const root = /** @type {any} */ (lib.hive.root(HKEY_CLASSES_ROOT));
        const win32 = /** @type {any} */ (lib.hive.open(root,
            'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}\\1.0\\0\\win32'));
        assert.deepEqual([.../** @type {any} */ (lib.hive.getValue(win32, '')).data
            .subarray(6, 8)], [0x80, 0x5c]);

        lib.writeMemory(0x3000, Uint8Array.from([0x47, 0x62, 0x63, 0x94, 0x39, 0xbc, 0x8b, 0x4b,
            0xa7, 0x28, 0x2d, 0x1f, 0xbe, 0xbf, 0xa7, 0x6a]));
        assert.equal(await fns.LoadRegTypeLib.handler([0x3000, 1, 0, 0, SLOT]), 0);
        assert.ok(lib.opened.at(-1)?.includes('\u20ac'), 'the file it was registered from');
    });

test('LoadTypeLibEx registers when asked to, and DispGetIDsOfNames reaches a type', async()=>{
    const lib = libraryHost();
    const fns = createAutomationFunctions(lib);
    lib.putWide(TEXT, 'C:\\lib\\engine.tlb');
    assert.equal(fns.LoadTypeLibEx.handler([TEXT, 2, SLOT]), 0, 'REGKIND_NONE');
    const root = /** @type {any} */ (lib.hive.root(HKEY_CLASSES_ROOT));
    assert.equal(lib.hive.open(root, 'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}'), null,
        'the library is not registered yet');
    // The fake volume's second read arrives later, so the registration waits.
    assert.equal(await fns.LoadTypeLibEx.handler([TEXT, 1, SLOT]), 0, 'REGKIND_REGISTER');
    assert.ok(lib.hive.open(root, 'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}\\1.0'));

    // A type of the library, then a name looked up through the flat entry.
    const library = lib.u32(SLOT);
    const record = lib.published.find(entry=>entry.id === IID_ITYPELIB && entry.object);
    assert.ok(record);
    const getTypeInfo = record.object.interfaceFor(IID_ITYPELIB).methods
        .find((/** @type {any} */ m)=>m.name === 'GetTypeInfo');
    assert.equal(getTypeInfo.invoke(record.object, [33, SLOT]), 0);
    const typeInfo = lib.u32(SLOT);
    assert.notEqual(typeInfo, library);
    lib.putWide(0x3000, 'Count');
    lib.putU32(0x3100, 0x3000);
    assert.equal(fns.DispGetIDsOfNames.handler([typeInfo, 0x3100, 1, 0x3200]), 0);
    assert.equal(lib.u32(0x3200), 1);
    assert.equal(fns.DispGetIDsOfNames.handler([0x4444, 0x3100, 1, 0x3200]) | 0, 0x80070057 | 0,
        'not a type information this library gave out');
});

test('a SAFEARRAY is read off its descriptor, locked, and copied whole', ()=>{
    setUp();
    // Two dimensions: [1..3] outer, [0..1] inner, of 4-byte elements.
    const psa = 0x3000;
    host.putU16(psa, 2);
    host.putU16(psa + 2, 0x80); // FADF_HAVEVARTYPE
    host.putU32(psa + 4, 4);
    host.putU32(psa + 8, 0);
    host.putU32(psa + 12, 0x3100);
    host.putU32(psa + 16, 2);
    host.putU32(psa + 20, 0);
    host.putU32(psa + 24, 3);
    host.putU32(psa + 28, 1);
    for (let index = 0; index < 6; index++)
    {
        host.putU32(0x3100 + index * 4, 100 + index);
    }
    assert.equal(call('SafeArrayGetDim', [psa]), 2);
    assert.equal(call('SafeArrayGetElemsize', [psa]), 4);
    assert.equal(call('SafeArrayGetUBound', [psa, 1, SLOT]), 0);
    assert.equal(host.u32(SLOT), 3, 'dimension 1 is the outer one, bound last');
    assert.equal(call('SafeArrayGetLBound', [psa, 1, SLOT]), 0);
    assert.equal(host.u32(SLOT), 1);
    assert.equal(call('SafeArrayGetUBound', [psa, 2, SLOT]), 0);
    assert.equal(host.u32(SLOT), 1);
    assert.equal(call('SafeArrayGetUBound', [psa, 3, SLOT]) | 0, 0x8002000b | 0, 'DISP_E_BADINDEX');
    assert.equal(call('SafeArrayGetDim', [0]), 0);

    assert.equal(call('SafeArrayLock', [psa]), 0);
    assert.equal(call('SafeArrayLock', [psa]), 0);
    assert.equal(host.u32(psa + 8), 2);
    assert.equal(call('SafeArrayUnlock', [psa]), 0);
    assert.equal(call('SafeArrayUnlock', [psa]), 0);
    assert.equal(call('SafeArrayUnlock', [psa]) | 0, 0x8000ffff | 0, 'E_UNEXPECTED below zero');
    assert.equal(call('SafeArrayLock', [0]) | 0, 0x80070057 | 0);

    host.putU32(psa + 8, 1);
    assert.equal(call('SafeArrayCopy', [psa, SLOT]), 0);
    const copy = host.u32(SLOT);
    assert.notEqual(copy, 0);
    assert.equal(host.u16(copy), 2);
    assert.equal(host.u32(copy + 8), 0, 'the copy is unlocked');
    const data = host.u32(copy + 12);
    assert.notEqual(data, 0x3100, 'its own data');
    assert.deepEqual([...Array(6)].map((_, i)=>host.u32(data + i * 4)),
        [100, 101, 102, 103, 104, 105]);
    assert.deepEqual([host.u32(copy + 16), host.u32(copy + 24)], [2, 3]);
    assert.equal(call('SafeArrayCopy', [0, SLOT]) | 0, 0x80070057 | 0);
    assert.equal(host.u32(SLOT), 0);
});

test('an array of strings is copied string by string', ()=>{
    setUp();
    const psa = 0x3000;
    host.putU16(psa, 1);
    host.putU16(psa + 2, 0x100); // FADF_BSTR
    host.putU32(psa + 4, 4);
    host.putU32(psa + 12, 0x3100);
    host.putU32(psa + 16, 2);
    host.putU32(psa + 20, 0);
    host.putWide(TEXT, 'one');
    const one = call('SysAllocString', [TEXT]);
    host.putU32(0x3100, one);
    host.putU32(0x3104, 0);
    assert.equal(call('SafeArrayCopy', [psa, SLOT]), 0);
    const data = host.u32(host.u32(SLOT) + 12);
    const copied = host.u32(data);
    assert.notEqual(copied, one, 'a new string');
    assert.equal(call('SysStringLen', [copied]), 3);
    assert.equal(host.u32(data + 4), 0, 'NULL stays NULL');
});

test('DispGetParam picks the positional argument and converts it', ()=>{
    setUp();
    // Two positional arguments after one named one: [named, second, first].
    const params = 0x3000;
    host.putU32(params, 0x3100);
    host.putU32(params + 4, 0x3200);
    host.putU32(params + 8, 3);
    host.putU32(params + 12, 1);
    host.putVariant(0x3100, VT_I4, 9);
    host.putVariant(0x3110, VT_I4, 200);
    host.putVariant(0x3120, VT_I4, 100);
    host.putVariant(VARIANT_A, 0, 0);
    assert.equal(call('DispGetParam', [params, 0, VT_BSTR, VARIANT_A, SLOT]), 0);
    assert.equal(host.u16(VARIANT_A), VT_BSTR);
    assert.equal(call('SysStringLen', [host.u32(VARIANT_A + 8)]), 3, '"100"');
    assert.equal(call('DispGetParam', [params, 1, VT_I4, VARIANT_A, SLOT]), 0);
    assert.equal(host.u32(VARIANT_A + 8), 200);
    host.putU32(SLOT, 0);
    assert.equal(call('DispGetParam', [params, 2, VT_I4, VARIANT_A, SLOT]) | 0, 0x80020004 | 0,
        'DISP_E_PARAMNOTFOUND: the named one does not count');
    host.putVariant(0x3110, VT_UNKNOWN, 0x5555);
    assert.equal(call('DispGetParam', [params, 1, VT_I4, VARIANT_A, SLOT]) | 0, 0x80020005 | 0);
    assert.equal(host.u32(SLOT), 1, 'which argument was wrong');
});

test('CreateErrorInfo hands out an object with one reference', ()=>{
    const lib = libraryHost();
    const fns = createAutomationFunctions(lib);
    assert.equal(fns.CreateErrorInfo.handler([SLOT]), 0);
    assert.notEqual(lib.u32(SLOT), 0);
    assert.equal(lib.published[0].id, '{22F03340-547D-101B-8E65-08002B2BD119}');
    assert.equal(fns.CreateErrorInfo.handler([0]) | 0, 0x80070057 | 0);
    setUp();
    assert.equal(call('CreateErrorInfo', [SLOT]) | 0, 0x8007000e | 0, 'nowhere to put one');
    assert.equal(host.u32(SLOT), 0);
});

test('a SAFEARRAY is made, filled, read back and destroyed', ()=>{
    setUp();
    const BOUNDS = 0x3000;
    const INDICES = 0x3040;
    const VALUE = 0x3080;
    // Two dimensions, the leftmost first as the caller names them: [2..3] x [0..2].
    host.putU32(BOUNDS, 2);
    host.putU32(BOUNDS + 4, 2);
    host.putU32(BOUNDS + 8, 3);
    host.putU32(BOUNDS + 12, 0);
    const psa = call('SafeArrayCreate', [3, 2, BOUNDS]);
    assert.notEqual(psa, 0);
    assert.equal(call('SafeArrayGetDim', [psa]), 2);
    assert.equal(call('SafeArrayGetElemsize', [psa]), 4);
    assert.equal(call('SafeArrayGetLBound', [psa, 1, SLOT]), 0);
    assert.equal(host.u32(SLOT), 2, 'dimension 1 is the leftmost');
    assert.equal(call('SafeArrayGetUBound', [psa, 2, SLOT]), 0);
    assert.equal(host.u32(SLOT), 2);

    for (let outer = 2; outer <= 3; outer++)
    {
        for (let inner = 0; inner <= 2; inner++)
        {
            host.putU32(INDICES, outer);
            host.putU32(INDICES + 4, inner);
            host.putU32(VALUE, outer * 10 + inner);
            assert.equal(call('SafeArrayPutElement', [psa, INDICES, VALUE]), 0);
        }
    }
    // The leftmost index varies fastest in memory.
    assert.equal(call('SafeArrayAccessData', [psa, SLOT]), 0);
    const data = host.u32(SLOT);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(index=>host.u32(data + index * 4)),
        [20, 30, 21, 31, 22, 32]);
    assert.equal(call('SafeArrayDestroy', [psa]) | 0, 0x8002000d | 0, 'locked by the access');
    assert.equal(call('SafeArrayUnaccessData', [psa]), 0);
    host.putU32(INDICES, 3);
    host.putU32(INDICES + 4, 1);
    assert.equal(call('SafeArrayGetElement', [psa, INDICES, VALUE]), 0);
    assert.equal(host.u32(VALUE), 31);
    host.putU32(INDICES + 4, 3);
    assert.equal(call('SafeArrayGetElement', [psa, INDICES, VALUE]) | 0, 0x8002000b | 0,
        'DISP_E_BADINDEX');
    assert.equal(call('SafeArrayDestroy', [psa]), 0);
    assert.equal(host.live.has(psa), false);
    assert.equal(host.live.has(data), false);

    // Strings: the array owns copies, and a caller gets a copy of its own.
    host.putU32(BOUNDS, 2);
    host.putU32(BOUNDS + 4, 0);
    const strings = call('SafeArrayCreate', [8, 1, BOUNDS]);
    host.putWide(TEXT, 'hello');
    const bstr = call('SysAllocString', [TEXT]);
    host.putU32(INDICES, 1);
    assert.equal(call('SafeArrayPutElement', [strings, INDICES, bstr]), 0);
    assert.equal(call('SafeArrayGetElement', [strings, INDICES, VALUE]), 0);
    const got = host.u32(VALUE);
    assert.notEqual(got, bstr, 'a copy');
    assert.equal(host.u32(got - 4), 10, 'five characters, in bytes');
    assert.equal(host.u16(got), 'h'.charCodeAt(0));
    host.putU32(INDICES, 0);
    assert.equal(call('SafeArrayGetElement', [strings, INDICES, VALUE]), 0);
    assert.equal(host.u32(VALUE), 0, 'an element never put is NULL');
    assert.equal(call('SafeArrayDestroy', [strings]), 0);
    assert.ok(host.live.has(got - 4), 'what the caller got is its own');
    assert.ok(host.live.has(bstr - 4), 'and so is what it put');

    // Redimensioned: the last elements go, then room is made for more.
    host.putU32(BOUNDS, 3);
    host.putU32(BOUNDS + 4, 0);
    const grown = call('SafeArrayCreate', [8, 1, BOUNDS]);
    host.putWide(TEXT, 'kept');
    host.putU32(INDICES, 1);
    assert.equal(call('SafeArrayPutElement', [grown, INDICES, call('SysAllocString', [TEXT])]), 0);
    host.putU32(INDICES, 2);
    assert.equal(call('SafeArrayPutElement', [grown, INDICES, call('SysAllocString', [TEXT])]), 0);
    const blocks = host.live.size;
    host.putU32(BOUNDS, 2);
    assert.equal(call('SafeArrayRedim', [grown, BOUNDS]), 0);
    assert.equal(host.live.size, blocks - 1, 'the dropped string was freed');
    host.putU32(BOUNDS, 5);
    assert.equal(call('SafeArrayRedim', [grown, BOUNDS]), 0);
    assert.equal(call('SafeArrayGetUBound', [grown, 1, SLOT]), 0);
    assert.equal(host.u32(SLOT), 4);
    host.putU32(INDICES, 1);
    assert.equal(call('SafeArrayGetElement', [grown, INDICES, VALUE]), 0);
    assert.equal(host.u16(host.u32(VALUE)), 'k'.charCodeAt(0), 'the kept one is still there');
    host.putU32(INDICES, 4);
    assert.equal(call('SafeArrayGetElement', [grown, INDICES, VALUE]), 0);
    assert.equal(host.u32(VALUE), 0, 'the new ones are empty');
    assert.equal(call('SafeArrayDestroy', [grown]), 0);

    assert.equal(call('SafeArrayCreate', [0x1234, 1, BOUNDS]), 0, 'no such element type');
    assert.equal(call('SafeArrayDestroy', [0]), 0, 'NULL is nothing to destroy');
});

test('the argument list of each entry is the one the guest pushed', ()=>{
    setUp();
    // stdcall: the callee pops, so a wrong count leaves the stack misaligned
    // and the caller returns into rubbish -- a crash with nothing to point at.
    const expected = {
        SysAllocString: 4, SysAllocStringLen: 8, SysAllocStringByteLen: 8,
        SysReAllocString: 8, SysReAllocStringLen: 12, SysFreeString: 4,
        SysStringLen: 4, SysStringByteLen: 4,
        BSTR_UserSize: 12, BSTR_UserMarshal: 12, BSTR_UserUnmarshal: 12, BSTR_UserFree: 8,
        VARIANT_UserSize: 12, VARIANT_UserMarshal: 12, VARIANT_UserUnmarshal: 12,
        VARIANT_UserFree: 8,
        LPSAFEARRAY_UserSize: 12, LPSAFEARRAY_UserMarshal: 12, LPSAFEARRAY_UserUnmarshal: 12,
        LPSAFEARRAY_UserFree: 8,
        VariantInit: 4, VariantClear: 4, VariantCopy: 8, VariantCopyInd: 8,
        VariantChangeType: 16, VariantChangeTypeEx: 20,
        SafeArrayGetDim: 4, SafeArrayGetElemsize: 4, SafeArrayGetUBound: 12,
        SafeArrayGetLBound: 12, SafeArrayLock: 4, SafeArrayUnlock: 4, SafeArrayCopy: 8,
        SafeArrayCreate: 12, SafeArrayDestroy: 4, SafeArrayGetElement: 12,
        SafeArrayPutElement: 12, SafeArrayAccessData: 8, SafeArrayUnaccessData: 4,
        SafeArrayRedim: 8,
        DispGetParam: 20, DispGetIDsOfNames: 16, CreateErrorInfo: 4,
    };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(fx[name].argBytes, argBytes, name);
    }
});

test('VarRound keeps an integer type, rounds a real one and takes a string as a double', ()=>{
    setUp();
    const IN = 0x3000;
    const OUT = 0x3020;
    const view = new DataView(host.bytes.buffer);
    host.putVariant(IN, 11, 0xffff);
    assert.equal(call('VarRound', [IN, 0, OUT]), S_OK);
    assert.deepEqual([host.u16(OUT), view.getInt16(OUT + 8, true)], [2, -1], 'BOOL to I2');
    host.putVariant(IN, 5, 0);
    view.setFloat64(IN + 8, -1.23456, true);
    assert.equal(call('VarRound', [IN, 3, OUT]), S_OK);
    assert.deepEqual([host.u16(OUT), view.getFloat64(OUT + 8, true)], [5, -1.235]);
    host.putVariant(IN, 1, 0);
    assert.equal(call('VarRound', [IN, 0, OUT]), S_OK);
    assert.equal(host.u16(OUT), 1, 'NULL stays NULL');
    assert.equal(call('VarRound', [IN, -1, OUT]), 0x80070057);
    host.putVariant(IN, 9, 0);
    assert.equal(call('VarRound', [IN, 0, OUT]), 0x80020008, 'an interface is no number');
});

test('VarCmp orders numbers, text and null; VarCat joins what it can spell', ()=>{
    setUp();
    const L = 0x3000;
    const R = 0x3020;
    const OUT = 0x3040;
    host.putVariant(L, 3, 2);
    host.putVariant(R, 2, 3);
    assert.equal(call('VarCmp', [L, R, 0, 0]), 0, 'LT');
    host.putVariant(R, 1, 0);
    assert.equal(call('VarCmp', [L, R, 0, 0]), 3, 'NULL');
    host.putVariant(R, 6, 20000);
    assert.equal(call('VarCmp', [L, R, 0, 0]), 1, 'two and two currency units are equal');

    host.putVariant(L, 11, 0xffff);
    host.putVariant(R, 3, 7);
    assert.equal(call('VarCat', [L, R, OUT]), S_OK);
    const bstr = host.u32(OUT + 8);
    assert.equal(host.u16(OUT), 8);
    assert.deepEqual([0, 1, 2, 3, 4].map(i=>String.fromCharCode(host.u16(bstr + i * 2))),
        ['T', 'r', 'u', 'e', '7']);
    host.putVariant(L, 1, 0);
    host.putVariant(R, 1, 0);
    assert.equal(call('VarCat', [L, R, OUT]), S_OK);
    assert.equal(host.u16(OUT), 1, 'null only when both are');
});

test('the currency and decimal conversions carry exact values', ()=>{
    setUp();
    const view = new DataView(host.bytes.buffer);
    assert.equal(call('VarCyFromI4', [-3, 0x3000]), S_OK);
    assert.equal(view.getBigInt64(0x3000, true), -30000n);
    assert.equal(call('VarR8FromCy', [view.getUint32(0x3000, true),
        view.getUint32(0x3004, true), 0x3010]), S_OK);
    assert.equal(view.getFloat64(0x3010, true), -3);
    view.setFloat64(0x3020, 1.5, true);
    assert.equal(call('VarDecFromR8', [view.getUint32(0x3020, true),
        view.getUint32(0x3024, true), 0x3030]), S_OK);
    assert.deepEqual([host.bytes[0x3032], view.getUint32(0x3038, true)], [1, 15]);
    assert.equal(call('VarR8FromDec', [0x3030, 0x3040]), S_OK);
    assert.equal(view.getFloat64(0x3040, true), 1.5);
    host.putWide(0x3050, ' -2.5 ');
    assert.equal(call('VarR8FromStr', [0x3050, 0, 0, 0x3060]), S_OK);
    assert.equal(view.getFloat64(0x3060, true), -2.5);
    host.putWide(0x3050, 'x');
    assert.equal(call('VarR8FromStr', [0x3050, 0, 0, 0x3060]), 0x80020005);
});

/** A BSTR's characters, by the length in its prefix. @param {number} bstr */
const bstrText = bstr=>{
    const units = host.u32(bstr - 4) / 2;
    return String.fromCharCode(...Array.from({ length: units }, (_, i)=>host.u16(bstr + i * 2)));
};

test('the operators read their variants out of guest memory and write the answer whole', ()=>{
    setUp();
    const L = 0x3000;
    const R = 0x3020;
    const OUT = 0x3040;
    const view = new DataView(host.bytes.buffer);
    host.putVariant(L, VT_I4, 4);
    host.putVariant(R, VT_I2, 2);
    host.bytes.fill(0xcc, OUT, OUT + 16);
    assert.equal(call('VarAdd', [L, R, OUT]), S_OK);
    assert.deepEqual([host.u16(OUT), host.u32(OUT + 8), host.u32(OUT + 12)], [VT_I4, 6, 0]);

    host.putVariant(L, VT_I2, -2);
    assert.equal(call('VarMul', [L, R, L]), S_OK, 'the result may be an operand');
    assert.deepEqual([host.u16(L), view.getInt16(L + 8, true), host.u16(L + 10)],
        [VT_I2, -4, 0], 'a short takes its two bytes and no more');

    // VarDiv follows a reference, to a value or to a variant; VarAdd, VarSub
    // and VarMul take none, as Windows does not.
    host.putU32(0x3100, 40);
    host.putVariant(L, VT_BYREF | VT_I4, 0x3100);
    host.putVariant(0x3110, VT_R8, 0);
    view.setFloat64(0x3118, 0.5, true);
    host.putVariant(R, VT_BYREF | types.VT_VARIANT, 0x3110);
    assert.equal(call('VarDiv', [L, R, OUT]), S_OK);
    assert.deepEqual([host.u16(OUT), view.getFloat64(OUT + 8, true)], [VT_R8, 80]);
    assert.equal(call('VarNot', [L, OUT]), S_OK);
    assert.deepEqual([host.u16(OUT), host.u32(OUT + 8) | 0], [VT_I4, -41]);
    assert.equal(call('VarSub', [L, R, OUT]), types.DISP_E_BADVARTYPE);
    host.putVariant(L, VT_BYREF | VT_I4, 0xfff00);
    assert.equal(call('VarNot', [L, OUT]), DISP_E_TYPEMISMATCH,
        'a reference into nothing is refused, not followed into a fault');

    // Two strings are joined into a string of the result's own.
    host.putWide(TEXT, '12');
    host.putVariant(L, VT_BSTR, call('SysAllocString', [TEXT]));
    host.putVariant(R, VT_BSTR, call('SysAllocString', [TEXT]));
    assert.equal(call('VarAdd', [L, R, OUT]), S_OK);
    assert.equal(host.u16(OUT), VT_BSTR);
    assert.equal(bstrText(host.u32(OUT + 8)), '1212');
    assert.equal(call('VarDiv', [L, R, OUT]), S_OK);
    assert.deepEqual([host.u16(OUT), view.getFloat64(OUT + 8, true)], [VT_R8, 1]);

    // A string a program never allocated -- characters with no length before
    // them -- reads to its terminator, as Windows converts it.
    host.putU32(TEXT - 4, 0xfffffff0);
    host.putWide(TEXT, '-1');
    host.putVariant(L, VT_BSTR, TEXT);
    assert.equal(call('VarNeg', [L, OUT]), S_OK);
    assert.deepEqual([host.u16(OUT), view.getFloat64(OUT + 8, true)], [VT_R8, 1]);

    assert.equal(fx.VarAdd.argBytes, 12);
    assert.equal(fx.VarXor.argBytes, 12);
    assert.equal(fx.VarNeg.argBytes, 8);
    assert.equal(fx.VarNot.argBytes, 8);
    assert.equal(call('VarAdd', [0, R, OUT]), E_INVALIDARG);
    assert.equal(call('VarNot', [L, 0]), E_INVALIDARG);
});

test('a CY or a DECIMAL answer is written as the variant holds it', ()=>{
    setUp();
    const L = 0x3000;
    const R = 0x3020;
    const OUT = 0x3040;
    const view = new DataView(host.bytes.buffer);
    host.putVariant(L, types.VT_CY, 0);
    view.setBigInt64(L + 8, 47110000n, true);
    host.putVariant(R, VT_UI1, 9);
    assert.equal(call('VarMul', [L, R, OUT]), S_OK);
    assert.deepEqual([host.u16(OUT), view.getBigInt64(OUT + 8, true)], [types.VT_CY, 423990000n]);

    // -4.2 as a DECIMAL: its scale and sign share the variant's reserved word.
    host.bytes.fill(0, R, R + 16);
    host.putU16(R, types.VT_DECIMAL);
    host.bytes[R + 2] = 1;
    host.bytes[R + 3] = 0x80;
    host.putU32(R + 8, 42);
    host.putVariant(L, VT_I4, -11);
    assert.equal(call('VarAdd', [L, R, OUT]), S_OK);
    assert.equal(host.u16(OUT), types.VT_DECIMAL);
    assert.equal(call('VarR8FromDec', [OUT, 0x3080]), S_OK);
    assert.equal(view.getFloat64(0x3080, true), -15.2);

    assert.equal(call('VarNeg', [R, OUT]), S_OK);
    assert.deepEqual([host.u16(OUT), host.bytes[OUT + 2], host.bytes[OUT + 3],
        host.u32(OUT + 8)], [types.VT_DECIMAL, 1, 0, 42], 'the sign turned, the digits kept');
});

test('a failure sets only the result\'s type, and each refusal is the one Windows gives', ()=>{
    setUp();
    const L = 0x3000;
    const R = 0x3020;
    const OUT = 0x3040;
    host.putVariant(L, VT_UNKNOWN, 100);
    host.putVariant(R, VT_EMPTY, 0);
    host.putVariant(OUT, VT_I4, 1231);
    assert.equal(call('VarMod', [L, R, OUT]), DISP_E_TYPEMISMATCH);
    assert.deepEqual([host.u16(OUT), host.u32(OUT + 8)], [VT_EMPTY, 1231]);

    host.putVariant(L, VT_I4, 1);
    host.putVariant(R, VT_BYREF | VT_I4, 0);
    assert.equal(call('VarAdd', [L, R, OUT]), types.DISP_E_BADVARTYPE, 'a reference to nothing');
    assert.equal(call('VarNot', [R, OUT]), DISP_E_TYPEMISMATCH, 'VarNot answers it otherwise');
    for (const [declared, hr] of [[VT_ARRAY | VT_I4, DISP_E_TYPEMISMATCH],
        [types.VT_RESERVED | VT_I4, types.DISP_E_BADVARTYPE],
        [types.VT_VECTOR | VT_I4, types.DISP_E_BADVARTYPE], [24, types.DISP_E_BADVARTYPE],
        [types.VT_I1, types.DISP_E_BADVARTYPE]])
    {
        host.putVariant(R, declared, 1);
        assert.equal(call('VarSub', [L, R, OUT]), hr, `VARTYPE 0x${declared.toString(16)}`);
    }
    host.putVariant(R, VT_I4, 0);
    assert.equal(call('VarDiv', [L, R, OUT]), types.DISP_E_DIVBYZERO);
    assert.equal(call('VarIdiv', [L, R, OUT]), types.DISP_E_DIVBYZERO);
});

test('SafeArrayPtrOfIndex answers where an element lives, with or without a lock', ()=>{
    setUp();
    const BOUNDS = 0x3000;
    const INDICES = 0x3020;
    const OUT = 0x3030;
    // Five shorts from 1 by two from 23: the leftmost index varies fastest.
    host.putU32(BOUNDS, 5);
    host.putU32(BOUNDS + 4, 1);
    host.putU32(BOUNDS + 8, 2);
    host.putU32(BOUNDS + 12, 23);
    const psa = call('SafeArrayCreate', [VT_I2, 2, BOUNDS]);
    const data = host.u32(psa + 12);
    host.putU32(INDICES, 3);
    host.putU32(INDICES + 4, 24);
    assert.equal(call('SafeArrayPtrOfIndex', [psa, INDICES, OUT]), S_OK);
    assert.equal(host.u32(OUT), data + (2 + 5) * 2);
    assert.equal(host.u32(psa + 8), 0, 'no lock taken');

    host.putU32(INDICES, 6);
    host.putU32(OUT, 0x1234);
    assert.equal(call('SafeArrayPtrOfIndex', [psa, INDICES, OUT]), 0x8002000b, 'BADINDEX');
    assert.equal(host.u32(OUT), 0x1234, 'and nothing written');
    host.putU32(INDICES, 1);
    host.putU32(INDICES + 4, 22);
    assert.equal(call('SafeArrayPtrOfIndex', [psa, INDICES, OUT]), 0x8002000b);
    assert.equal(call('SafeArrayPtrOfIndex', [0, INDICES, OUT]), E_INVALIDARG);
    assert.equal(call('SafeArrayPtrOfIndex', [psa, 0, OUT]), E_INVALIDARG);
    assert.equal(call('SafeArrayPtrOfIndex', [psa, INDICES, 0]), E_INVALIDARG);
    assert.equal(fx.SafeArrayPtrOfIndex.argBytes, 12);
});

test('the string conversions read English, and refuse what holds no value', ()=>{
    setUp();
    const OUT = 0x3000;
    const view = new DataView(host.bytes.buffer);
    host.putWide(TEXT, '1.5');
    assert.equal(call('VarR4FromStr', [TEXT, 0x409, 0, OUT]), S_OK);
    assert.equal(view.getFloat32(OUT, true), 1.5);
    host.putWide(TEXT, '1e39');
    assert.equal(call('VarR4FromStr', [TEXT, 0x409, 0, OUT]), DISP_E_OVERFLOW);

    host.putWide(TEXT, '$1,234.00005');
    assert.equal(call('VarCyFromStr', [TEXT, 0x409, 0, OUT]), S_OK);
    assert.equal(view.getBigInt64(OUT, true), 12340000n, 'a half to the even place');
    host.putWide(TEXT, '922337203685478');
    assert.equal(call('VarCyFromStr', [TEXT, 0x409, 0, OUT]), DISP_E_OVERFLOW);

    host.putWide(TEXT, '#TRUE#');
    assert.equal(call('VarBoolFromStr', [TEXT, 0x409, 0, OUT]), S_OK);
    assert.equal(view.getInt16(OUT, true), -1);
    host.putWide(TEXT, 'Yes');
    assert.equal(call('VarBoolFromStr', [TEXT, 0x409, 0, OUT]), DISP_E_TYPEMISMATCH);

    host.putWide(TEXT, '2 January, 1970 6:00 PM');
    assert.equal(call('VarDateFromStr', [TEXT, 0x409, 0, OUT]), S_OK);
    assert.equal(view.getFloat64(OUT, true), 25570.75);

    // A missing string is no number, as Windows answers, for every one of them.
    for (const name of ['VarR8FromStr', 'VarR4FromStr', 'VarI4FromStr', 'VarCyFromStr',
        'VarBoolFromStr', 'VarDateFromStr'])
    {
        assert.equal(call(name, [0, 0x409, 0, OUT]), DISP_E_TYPEMISMATCH, name);
        assert.equal(call(name, [TEXT, 0x409, 0, 0]), E_INVALIDARG, name);
        assert.equal(fx[name].argBytes, 16, name);
    }
    host.putWide(TEXT, '');
    assert.equal(call('VarI4FromStr', [TEXT, 0x409, 0, OUT]), DISP_E_TYPEMISMATCH,
        'an empty string is no zero');
    host.putWide(TEXT, '1,5');
    host.said.length = 0;
    assert.equal(call('VarR8FromStr', [TEXT, 0x40c, 0, OUT]), S_OK);
    assert.equal(view.getFloat64(OUT, true), 15, 'read as English');
    assert.ok(host.said.some(line=>line.includes('1036')), JSON.stringify(host.said));
});

test('a date with no year is this year by the guest\'s clock, and refused without one', ()=>{
    host = fakeHost();
    fx = createAutomationFunctions({ ...host, systemTimeMs: ()=>Date.UTC(2009, 5, 1) });
    host.putWide(TEXT, 'Jan 2');
    assert.equal(call('VarDateFromStr', [TEXT, 0x409, 0, 0x3000]), S_OK);
    assert.equal(new DataView(host.bytes.buffer).getFloat64(0x3000, true), 39815);

    setUp();
    host.putWide(TEXT, 'Jan 2');
    assert.equal(call('VarDateFromStr', [TEXT, 0x409, 0, 0x3000]), DISP_E_TYPEMISMATCH);
    assert.ok(host.said.some(line=>line.includes('clock')), JSON.stringify(host.said));
});

test('a currency and a date are spelled in English, into a BSTR of the caller\'s', ()=>{
    setUp();
    const view = new DataView(host.bytes.buffer);
    assert.equal(call('VarBstrFromCy', [15000, 0, 0x409, 0, SLOT]), S_OK);
    assert.equal(bstrText(host.u32(SLOT)), '1.5');
    assert.equal(call('VarBstrFromCy', [-15000, -1, 0x409, 0, SLOT]), S_OK);
    assert.equal(bstrText(host.u32(SLOT)), '-1.5');

    view.setFloat64(0x3000, 3.34, true);
    const [low, high] = [view.getUint32(0x3000, true), view.getUint32(0x3004, true)];
    assert.equal(call('VarBstrFromDate', [low, high, 0x409, 0, SLOT]), S_OK);
    assert.equal(bstrText(host.u32(SLOT)), '1/2/1900 8:09:36 AM');
    assert.equal(call('VarBstrFromDate', [low, high, 0x409, 2, SLOT]), S_OK);
    assert.equal(bstrText(host.u32(SLOT)), '1/2/1900', 'VAR_DATEVALUEONLY');
    view.setFloat64(0x3000, 2958466, true);
    assert.equal(call('VarBstrFromDate', [view.getUint32(0x3000, true),
        view.getUint32(0x3004, true), 0x409, 0, SLOT]), E_INVALIDARG, 'no such day');
    assert.equal(call('VarBstrFromDate', [low, high, 0x409, 0, 0]), 0x80004003, 'E_POINTER');
    assert.equal(fx.VarBstrFromCy.argBytes, 20);
    assert.equal(fx.VarBstrFromDate.argBytes, 20);
});

test('a string becomes a boolean as VarBoolFromStr reads one', ()=>{
    setUp();
    host.putWide(TEXT, 'True');
    host.putVariant(VARIANT_A, VT_BSTR, call('SysAllocString', [TEXT]));
    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_BOOL]), S_OK);
    assert.equal(host.u16(VARIANT_B + 8), 0xffff);
});

test('the operators and conversions are bound to the ordinals Windows gives them', ()=>{
    const expected = {
        74: 'VarR4FromStr', 94: 'VarDateFromStr', 104: 'VarCyFromStr', 113: 'VarBstrFromCy',
        114: 'VarBstrFromDate', 125: 'VarBoolFromStr', 141: 'VarAdd', 142: 'VarAnd',
        143: 'VarDiv', 148: 'SafeArrayPtrOfIndex', 153: 'VarIdiv', 155: 'VarMod', 156: 'VarMul',
        157: 'VarOr', 159: 'VarSub', 167: 'VarXor', 173: 'VarNeg', 174: 'VarNot',
    };
    for (const [ordinal, name] of Object.entries(expected))
    {
        assert.equal(OLEAUT32_ORDINALS[Number(ordinal)], name, ordinal);
    }
});

test('DispCallFunc pushes each argument as its type occupies the stack', async()=>{
    setUp();
    /** @type {{ entry: number, args: number[] }[]} */
    const seen = [];
    fx = createAutomationFunctions({
        ...host,
        /** @param {number} entry @param {number[]} args */
        call: (entry, args)=>{
            seen.push({ entry, args });
            return Promise.resolve(0x1234);
        },
    });
    const object = 0x2000;
    host.putU32(object, 0x2100);
    host.putU32(0x2100 + 12, 0x77000);
    const TYPES = 0x2200;
    const POINTERS = 0x2300;
    const I4 = 0x2400;
    const R8 = 0x2410;
    const RESULT = 0x2500;
    host.bytes.set([3, 0, 5, 0], TYPES);
    host.putU32(POINTERS, I4);
    host.putU32(POINTERS + 4, R8);
    host.putU32(I4 + 8, 42);
    host.putU32(R8 + 8, 0x11111111);
    host.putU32(R8 + 12, 0x22222222);
    assert.equal(fx.DispCallFunc.argBytes, 32);
    assert.equal(await settled('DispCallFunc', [object, 12, 4, 3, 2, TYPES, POINTERS, RESULT]), 0);
    assert.deepEqual(seen, [{ entry: 0x77000, args: [object, 42, 0x11111111, 0x22222222] }]);
    assert.equal(host.bytes[RESULT], 3, 'VT_I4');
    assert.equal(new DataView(host.bytes.buffer).getUint32(RESULT + 8, true), 0x1234);

    assert.equal(await settled('DispCallFunc', [0, 0x55000, 4, 0, 0, 0, 0, 0]), 0,
        'no instance: oVft is the function');
    assert.deepEqual(seen[1], { entry: 0x55000, args: [] });
    assert.equal(call('DispCallFunc', [0, 0x55000, 4, 5, 0, 0, 0, RESULT]), 0x80020008,
        'a double comes back in ST0, which the call does not hand over: DISP_E_BADVARTYPE');
    assert.equal(OLEAUT32_ORDINALS[146], 'DispCallFunc');
    assert.equal(OLEAUT32_ORDINALS[420], 'OleCreateFontIndirect');
    assert.equal(fx.OleCreateFontIndirect.argBytes, 12);
});
