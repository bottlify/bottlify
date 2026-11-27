/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    POINT, RECT, bytesView, fieldOf, fieldsOf, highOf, read, struct, union, widthOf, write,
} from './layout.js';

test('a field sits on its natural alignment and the end is padded to the most aligned', ()=>{
    // { char; short; char; int; char } is 1+1pad+2+1+3pad+4+1+3pad = 16 by
    // the compiler's rule at either width.
    const mixed = struct([['a', 'u8'], ['b', 'u16'], ['c', 'u8'], ['d', 'u32'], ['e', 'u8']]);
    assert.deepEqual({ ...mixed.at(4) }, { a: 0, b: 2, c: 4, d: 8, e: 12, SIZE: 16 });
    assert.deepEqual({ ...mixed.at(8) }, { ...mixed.at(4) });
    // A pointer is the width's own size and alignment; a 64-bit integer is
    // aligned to 8 at either width, as MSVC aligns a double or an __int64.
    const pointed = struct([['n', 'u32'], ['p', 'ptr'], ['q', 'u64']]);
    assert.deepEqual({ ...pointed.at(4) }, { n: 0, p: 4, q: 8, SIZE: 16 });
    assert.deepEqual({ ...pointed.at(8) }, { n: 0, p: 8, q: 16, SIZE: 24 });
    assert.equal(pointed.alignOf(4), 8);
});

test('pack caps every alignment, as #pragma pack does', ()=>{
    const packed = struct([['a', 'u8'], ['b', 'u32'], ['p', 'ptr']], { pack: 1 });
    assert.deepEqual({ ...packed.at(8) }, { a: 0, b: 1, p: 5, SIZE: 13 });
    const two = struct([['a', 'u8'], ['b', 'u32']], { pack: 2 });
    assert.deepEqual({ ...two.at(4) }, { a: 0, b: 2, SIZE: 6 });
});

test('an embedded structure, an array and a union take their room; a nameless one flattens', ()=>{
    const outer = struct([['tag', 'u16'], ['where', POINT], ['bounds', RECT, 2],
        [null, union([['whole', 'u64'], [['low', 'u32'], ['high', 'u32']]])], [null, 'u8', 3],
        ['last', 'u8']]);
    assert.deepEqual({ ...outer.at(4) }, { tag: 0, where: 4, bounds: 12, whole: 48, low: 48,
        high: 52, last: 59, SIZE: 64 });
    assert.equal(fieldOf(outer.at(4), 'bounds')?.count, 2);
    assert.equal(fieldOf(outer.at(4), 'bounds')?.size, 16);
    assert.deepEqual(fieldsOf(outer.at(4)).map(f=>f.name),
        ['tag', 'where', 'bounds', 'whole', 'low', 'high', 'last']);
    assert.equal(widthOf(outer.at(8)), 8);
});

test('a name given twice, or SIZE, is refused when the layout is laid out', ()=>{
    assert.throws(()=>struct([['a', 'u32'], ['a', 'u32']]).at(4), /twice/);
    assert.throws(()=>struct([['SIZE', 'u32']]).at(4), /twice/);
    assert.throws(()=>struct([['a', 'u32'], [null, struct([['a', 'u8']])]]).at(4), /twice/);
});

test('offsetOf answers a named field and refuses any other', ()=>{
    assert.equal(RECT.offsetOf('bottom', 8), 12);
    assert.throws(()=>RECT.offsetOf('width'), RangeError);
    assert.throws(()=>RECT.offsetOf('SIZE'), RangeError);
    assert.throws(()=>fieldsOf(/** @type {any} */ ({ SIZE: 4 })), TypeError);
});

test('every scalar kind is read back as it was written, in place', ()=>{
    const all = struct([['u8', 'u8'], ['i8', 'i8'], ['u16', 'u16'], ['i16', 'i16'],
        ['u32', 'u32'], ['i32', 'i32'], ['f32', 'f32'], ['f64', 'f64'], ['u64', 'u64'],
        ['i64', 'i64'], ['ptr', 'ptr'], ['handle', 'handle']]);
    for (const width of [4, 8])
    {
        const table = all.at(width);
        const bytes = new Uint8Array(0x10 + table.SIZE);
        const view = bytesView(bytes);
        const values = { u8: 0xfe, i8: -2, u16: 0xfffe, i16: -2, u32: 0xfffffffe, i32: -2,
            f32: 1.5, f64: Math.PI, u64: 0xfedcba9876543210n, i64: -2n,
            ptr: width === 8 ? 0x1234_5678_9abc : 0x89abcdef, handle: 0x88 };
        for (const [name, value] of Object.entries(values))
        {
            write(view, 0x10, table, name, value);
        }
        for (const [name, value] of Object.entries(values))
        {
            assert.equal(read(view, 0x10, table, name), value, `${name} at ${width}`);
        }
        assert.deepEqual([...bytes.subarray(0, 0x10)], new Array(0x10).fill(0),
            'nothing is written before the structure');
    }
});

test('a 64-bit handle is sign-extended, an address zero-extended and kept whole', ()=>{
    const pair = struct([['h', 'handle'], ['p', 'ptr']]);
    const table = pair.at(8);
    const bytes = new Uint8Array(16);
    const view = bytesView(bytes);
    const words = new DataView(bytes.buffer);
    write(view, 0, table, 'h', -1);
    write(view, 0, table, 'p', -1);
    assert.equal(words.getBigInt64(0, true), -1n, 'HWND_TOPMOST is -1 whole');
    assert.equal(words.getBigUint64(8, true), 0xffffffffn,
        'a dword some bitwise operator made signed names the same address');
    write(view, 0, table, 'h', 2 ** 33 + 5);
    assert.equal(words.getBigUint64(0, true), 2n ** 33n + 5n, 'past 4 GiB it is held whole');
    assert.equal(highOf(0x80000000, 'handle'), 0xffffffff);
    assert.equal(highOf(0x80000000, 'ptr'), 0);
    // At 32 bits each is one dword, and nothing after it is touched.
    const narrow = pair.at(4);
    bytes.fill(0xaa);
    write(view, 0, narrow, 'h', -1);
    assert.equal(words.getUint32(0, true), 0xffffffff);
    assert.equal(words.getUint32(8, true), 0xaaaaaaaa);
});

test('a field that is no scalar is not read or written as one', ()=>{
    const table = struct([['where', POINT], ['name', 'u16', 4]]).at(4);
    const view = bytesView(new Uint8Array(16));
    assert.throws(()=>read(view, 0, table, 'where'), RangeError);
    assert.throws(()=>write(view, 0, table, 'name', 1), RangeError);
    assert.throws(()=>read(view, 0, table, 'missing'), RangeError);
});

test('windef.h: POINT is 8 and RECT 16 at both widths', ()=>{
    for (const width of [4, 8])
    {
        assert.deepEqual({ ...POINT.at(width) }, { x: 0, y: 4, SIZE: 8 });
        assert.deepEqual({ ...RECT.at(width) },
            { left: 0, top: 4, right: 8, bottom: 12, SIZE: 16 });
    }
});
