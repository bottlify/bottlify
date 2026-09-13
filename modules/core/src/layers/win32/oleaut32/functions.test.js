/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationFunctions, OLEAUT32_ORDINALS } from './functions.js';

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
/** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */
let fx;

/** @param {string} name @param {number[]} args */
const call = (name, args)=>fx[name].handler(args) >>> 0;

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

test('a rounded conversion goes to nearest, with halves away from zero', ()=>{
    setUp();
    const value = new Uint8Array(8);
    new DataView(value.buffer).setFloat64(0, 2.5, true);
    host.putVariant(VARIANT_A, VT_R8, 0);
    host.bytes.set(value, VARIANT_A + 8);

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_I2]), S_OK);
    assert.equal(host.u16(VARIANT_B + 8), 3);
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

test('an interface a variant held is dropped, and the difference is reported', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_UNKNOWN, 0x4444);

    assert.equal(call('VariantClear', [VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_EMPTY);
    // Accepting a call and not doing all of it is the defect class that shows
    // up as behaviour rather than as an error, so it has to be said out loud.
    assert.ok(host.said.some(line=>line.includes('Release')),
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

test('the ordinals are the ones a real oleaut32 exports', ()=>{
    // Read off a real export directory. A wrong number here binds a call to a
    // different function and nothing anywhere would say so.
    assert.equal(OLEAUT32_ORDINALS[2], 'SysAllocString');
    assert.equal(OLEAUT32_ORDINALS[6], 'SysFreeString');
    assert.equal(OLEAUT32_ORDINALS[7], 'SysStringLen');
    assert.equal(OLEAUT32_ORDINALS[8], 'VariantInit');
    assert.equal(OLEAUT32_ORDINALS[9], 'VariantClear');
    assert.equal(OLEAUT32_ORDINALS[12], 'VariantChangeType');
    assert.equal(OLEAUT32_ORDINALS[147], 'VariantChangeTypeEx');
    assert.equal(OLEAUT32_ORDINALS[149], 'SysStringByteLen');
    assert.equal(OLEAUT32_ORDINALS[150], 'SysAllocStringByteLen');
    assert.equal(OLEAUT32_ORDINALS[161], 'LoadTypeLib');
    assert.equal(OLEAUT32_ORDINALS[163], 'RegisterTypeLib');
});

test('a type library cannot be loaded, and the pointer says so as well as the code', ()=>{
    setUp();
    host.putWide(SLOT, 'xx');
    assert.equal(call('LoadTypeLib', [TEXT, SLOT]) | 0, 0x80029c4a | 0);
    assert.equal(host.u32(SLOT), 0);
    host.putWide(SLOT, 'xx');
    assert.equal(call('LoadRegTypeLib', [TEXT, 1, 0, 0, SLOT]) | 0, 0x8002801d | 0);
    assert.equal(host.u32(SLOT), 0);
    assert.equal(fx.LoadTypeLib.argBytes, 8);
    assert.equal(fx.LoadTypeLibEx.argBytes, 12);
    assert.equal(fx.LoadRegTypeLib.argBytes, 20);
    assert.equal(fx.RegisterTypeLib.argBytes, 12);
});

test('the argument list of each entry is the one the guest pushed', ()=>{
    setUp();
    // stdcall: the callee pops, so a wrong count leaves the stack misaligned
    // and the caller returns into rubbish -- a crash with nothing to point at.
    const expected = {
        SysAllocString: 4, SysAllocStringLen: 8, SysAllocStringByteLen: 8,
        SysReAllocString: 8, SysReAllocStringLen: 12, SysFreeString: 4,
        SysStringLen: 4, SysStringByteLen: 4,
        VariantInit: 4, VariantClear: 4, VariantCopy: 8, VariantCopyInd: 8,
        VariantChangeType: 16, VariantChangeTypeEx: 20,
    };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(fx[name].argBytes, argBytes, name);
    }
});
