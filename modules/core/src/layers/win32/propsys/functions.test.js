/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * propsys's PROPVARIANT helpers, as Wine's propsys test (test_intconversions,
 * test_PropVariantToBoolean, test_PropVariantCompareEx,
 * test_InitPropVariantFromGUIDAsString and the other constructors) says
 * Windows answers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARITHMETIC_OVERFLOW, createPropsysFunctions, parseInteger } from './functions.js';

const S_OK = 0;
const DISP_E_TYPEMISMATCH = 0x80020005 | 0;
const E_FAIL = 0x80004005 | 0;
const VT = { EMPTY: 0, NULL: 1, I2: 2, I4: 3, R8: 5, BSTR: 8, BOOL: 11, UI2: 18, UI4: 19,
    I8: 20, UI8: 21, LPSTR: 30, LPWSTR: 31, CLSID: 72 };

function machine(){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let next = 0x8000;
    const fns = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        createPropsysFunctions({
            readMemory: (at, length)=>memory.subarray(at, at + length),
            writeMemory: (at, bytes)=>memory.set(bytes, at),
            heap: { allocate: bytes=>{
                const at = next;
                next += (bytes + 15) & ~15;
                return at;
            }, free: ()=>undefined },
        }));
    let scratch = 0x100;
    /** A PROPVARIANT of a type and a 64-bit value. @param {number} vt @param {bigint} [value] */
    const pv = (vt, value = 0n)=>{
        const at = scratch;
        scratch += 16;
        view.setUint16(at, vt, true);
        view.setBigUint64(at + 8, BigInt.asUintN(64, value), true);
        return at;
    };
    /** @param {string} text @param {boolean} [narrow] */
    const string = (text, narrow = false)=>{
        const at = scratch + 0x1000;
        scratch += 0x40;
        [...text].forEach((c, i)=>(narrow ? view.setUint8(at + i, c.charCodeAt(0))
            : view.setUint16(at + i * 2, c.charCodeAt(0), true)));
        if (narrow)
        {
            view.setUint8(at + text.length, 0);
        }
        else
        {
            view.setUint16(at + text.length * 2, 0, true);
        }
        return at;
    };
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let i = at; view.getUint16(i, true) !== 0; i += 2)
        {
            text += String.fromCharCode(view.getUint16(i, true));
        }
        return text;
    };
    const OUT = 0x4000;
    /** @param {string} name @param {number} at */
    const to = (name, at)=>fns[name].handler([at, OUT]);
    return { memory, view, fns, pv, string, wideAt, to, OUT };
}

test('integers: what does not fit the type asked for overflows', ()=>{
    const { fns, pv, to, view, OUT } = machine();
    const big = pv(VT.I8, 1n << 63n);
    assert.equal(to('PropVariantToInt64', big), S_OK);
    assert.equal(view.getBigInt64(OUT, true), -(1n << 63n));
    for (const name of ['PropVariantToUInt64', 'PropVariantToInt32', 'PropVariantToUInt32',
        'PropVariantToInt16', 'PropVariantToUInt16'])
    {
        assert.equal(to(name, big), ARITHMETIC_OVERFLOW, name);
    }
    const minus = pv(VT.I8, -5n);
    assert.equal(to('PropVariantToInt32', minus), S_OK);
    assert.equal(view.getInt32(OUT, true), -5);
    assert.equal(to('PropVariantToUInt32', minus), ARITHMETIC_OVERFLOW);
    assert.equal(to('PropVariantToInt16', minus), S_OK);
    assert.equal(view.getInt16(OUT, true), -5);
    assert.equal(fns.PropVariantToUInt32WithDefault.handler([big, 77]), 77);
    for (const [vt, value] of /** @type {[number, bigint][]} */ ([[VT.UI4, 6n], [VT.I4, -6n],
        [VT.UI2, 7n], [VT.I2, -7n]]))
    {
        assert.equal(to('PropVariantToInt64', pv(vt, value)), S_OK);
        assert.equal(view.getBigInt64(OUT, true), value);
    }
    assert.equal(to('PropVariantToInt64', pv(VT.EMPTY)), S_OK);
    assert.equal(view.getBigInt64(OUT, true), 0n);
});

test('a string is a number when all of it is one, by C\'s base-0 rules', ()=>{
    assert.equal(parseInteger('-7'), -7n);
    assert.equal(parseInteger('0x1f'), 31n);
    assert.equal(parseInteger('010'), 8n);
    assert.equal(parseInteger('7 '), null);
    assert.equal(parseInteger('yes'), null);
    const { pv, string, to, view, OUT } = machine();
    assert.equal(to('PropVariantToInt32', pv(VT.LPWSTR, BigInt(string('-7')))), S_OK);
    assert.equal(view.getInt32(OUT, true), -7);
    assert.equal(to('PropVariantToInt32', pv(VT.LPWSTR, BigInt(string('x')))), DISP_E_TYPEMISMATCH);
});

test('booleans: VARIANT_TRUE only, numbers by zero, "true"/"#TRUE#" strings', ()=>{
    const { pv, string, to, view, OUT } = machine();
    /** @param {number} at */
    const bool = at=>[to('PropVariantToBoolean', at), view.getUint32(OUT, true)];
    assert.deepEqual(bool(pv(VT.BOOL, 0n)), [S_OK, 0]);
    assert.deepEqual(bool(pv(VT.BOOL, 1n)), [S_OK, 0]);
    assert.deepEqual(bool(pv(VT.BOOL, 0xffffn)), [S_OK, 1]);
    assert.deepEqual(bool(pv(VT.EMPTY)), [S_OK, 0]);
    assert.deepEqual(bool(pv(VT.I4, BigInt.asUintN(32, -67n))), [S_OK, 1]);
    for (const [text, value] of /** @type {[string, number][]} */ ([['0', 0], ['-7', 1],
        ['tRUe', 1], ['#TRUE#', 1], ['false', 0], ['#FALSE#', 0]]))
    {
        assert.deepEqual(bool(pv(VT.LPWSTR, BigInt(string(text)))), [S_OK, value], text);
    }
    for (const text of ['true ', 'yes'])
    {
        assert.deepEqual(bool(pv(VT.LPWSTR, BigInt(string(text)))), [DISP_E_TYPEMISMATCH, 0]);
    }
    assert.deepEqual(bool(pv(VT.LPWSTR)), [DISP_E_TYPEMISMATCH, 0]);
    assert.deepEqual(bool(pv(VT.LPSTR, BigInt(string('#TruE#', true)))), [DISP_E_TYPEMISMATCH, 0]);
    assert.deepEqual(bool(pv(VT.LPSTR, BigInt(string('fALSe', true)))), [S_OK, 0]);
});

test('PropVariantCompareEx: empties first (or last), the second taken as the first\'s type', ()=>{
    const { fns, pv, string, memory } = machine();
    /** @param {number} a @param {number} b @param {number} [flags] */
    const cmp = (a, b, flags = 0)=>fns.PropVariantCompareEx.handler([a, b, 0, flags]);
    const empty = pv(VT.EMPTY);
    const nil = pv(VT.NULL);
    const i2zero = pv(VT.I2, 0n);
    const i2two = pv(VT.I2, 2n);
    const large = pv(VT.I4, 65536n);
    const str2 = pv(VT.BSTR, BigInt(string('2')));
    const str02 = pv(VT.BSTR, BigInt(string('02')));
    assert.equal(cmp(empty, nil), 0);
    assert.equal(cmp(nil, i2zero), -1);
    assert.equal(cmp(nil, i2zero, 1), 1);
    assert.equal(cmp(i2two, i2zero), 1);
    assert.equal(cmp(i2zero, large), -1, 'not convertible to the first\'s type');
    assert.equal(cmp(large, i2zero), 1);
    assert.equal(cmp(i2two, str02), 0);
    assert.equal(cmp(str02, i2two), -1);
    assert.equal(cmp(str2, str02), 1);
    const guid = 0x9000;
    memory.fill(0xde, guid, guid + 16);
    const zero = 0x9100;
    memory.fill(0, zero, zero + 16);
    assert.equal(cmp(pv(VT.CLSID, BigInt(guid)), pv(VT.CLSID, BigInt(zero))), 1);
    assert.equal(cmp(pv(VT.CLSID), pv(VT.CLSID, BigInt(guid))), -1);
    assert.equal(cmp(pv(VT.CLSID), pv(VT.CLSID, BigInt(guid)), 1), 1);
});

test('the constructors: a GUID as its braced string, a buffer, a CLSID, a string vector', ()=>{
    const { fns, view, memory, wideAt, OUT } = machine();
    assert.equal(fns.InitPropVariantFromGUIDAsString.handler([0, OUT]), E_FAIL);
    const guid = 0x9000;
    memory.fill(0, guid, guid + 16);
    assert.equal(fns.InitPropVariantFromGUIDAsString.handler([guid, OUT]), S_OK);
    assert.equal(view.getUint16(OUT, true), VT.LPWSTR);
    assert.equal(wideAt(view.getUint32(OUT + 8, true)), '{00000000-0000-0000-0000-000000000000}');
    memory.set([116, 101, 115, 116], 0x9100);
    assert.equal(fns.InitPropVariantFromBuffer.handler([0x9100, 4, OUT]), S_OK);
    assert.equal(view.getUint16(OUT, true), 0x1011);
    assert.equal(view.getUint32(OUT + 8, true), 4);
    assert.deepEqual([...memory.subarray(view.getUint32(OUT + 12, true),
        view.getUint32(OUT + 12, true) + 4)], [116, 101, 115, 116]);
    assert.equal(fns.InitPropVariantFromCLSID.handler([guid, OUT]), S_OK);
    assert.equal(view.getUint16(OUT, true), VT.CLSID);
    assert.notEqual(view.getUint32(OUT + 8, true), guid, 'a copy');
    assert.equal(fns.InitPropVariantFromStringVector.handler([0, 0, OUT]), S_OK);
    assert.equal(view.getUint16(OUT, true), 0x101f);
    assert.equal(view.getUint32(OUT + 8, true), 0);
    assert.notEqual(view.getUint32(OUT + 12, true), 0, 'a vector pointer all the same');
});

test('a FILETIME with no date leaves the VARIANT empty, E_INVALIDARG', async()=>{
    const memory = new Uint8Array(0x100);
    const fns = /** @type {any} */ (createPropsysFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        heap: { allocate: ()=>0x80, free: ()=>undefined },
        fileTimeToDate: at=>Promise.resolve(at === 0x10 ? null : 45000.5),
    }));
    memory.fill(0xaa, 0x40, 0x50);
    assert.equal(await fns.InitVariantFromFileTime.handler([0x10, 0x40]), 0x80070057 | 0);
    assert.deepEqual([...memory.subarray(0x40, 0x50)], new Array(16).fill(0));
    assert.equal(await fns.InitVariantFromFileTime.handler([0x20, 0x40]), S_OK);
    const view = new DataView(memory.buffer);
    assert.equal(view.getUint16(0x40, true), 7);
    assert.equal(view.getFloat64(0x48, true), 45000.5);
});
