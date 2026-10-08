/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGuest } from './guest.fixture.js';
import { createVariantCodec } from './variant.js';
import { ForeignValue, arrayValue, dateValue, errorValue, variantArray } from './values.js';

/** A codec over a fake guest whose interfaces are tagged plain objects. */
function setup(){
    const guest = createFakeGuest();
    /** @type {{ pointer: number, kind: string, owned: boolean }[]} */
    const imported = [];
    const codec = createVariantCodec(guest.com, {
        import: (pointer, kind, owned)=>{
            imported.push({ pointer, kind, owned });
            return { imported: pointer };
        },
        export: value=>value.exportAs,
    });
    const variant = guest.allocate(16);
    return { guest, codec, imported, variant };
}

test('values are written as the VARIANTs JScript passes', async()=>{
    const { guest, codec, variant } = setup();
    /** @type {[any, number, any][]} value, vt, what the guest reads */
    const cases = [
        [undefined, 0, undefined], [null, 1, null], [true, 11, true], [false, 11, false],
        [7, 3, 7], [-2147483648, 3, -2147483648], [1.5, 5, 1.5], [2 ** 31, 5, 2 ** 31],
        [-0, 5, -0], ['text', 8, 'text'], ['', 8, ''],
        [dateValue(36526.5), 7, { date: 36526.5 }],
    ];
    for (const [value, vt, read] of cases)
    {
        await codec.write(variant, value);
        assert.equal(guest.memory.u16(variant), vt, String(value));
        assert.deepEqual(guest.readVariant(variant), read, String(value));
        await guest.com.oleaut32('VariantClear', [variant]);
    }
    await codec.write(variant, errorValue(0x80020004 | 0));
    assert.equal(guest.memory.u16(variant), 10);
    assert.equal(guest.memory.i32(variant + 8), 0x80020004 | 0);
    await codec.write(variant, { exportAs: 0x1234 });
    assert.deepEqual(guest.readVariant(variant), { pointer: 0x1234 });
});

test('a VARIANT the guest hands over is read and what it held is freed', async()=>{
    const { guest, codec, variant, imported } = setup();
    const before = guest.live.size;
    await guest.writeVariant(variant, 'owned text');
    assert.equal(guest.live.size, before + 1);
    assert.equal(await codec.read(variant, true), 'owned text');
    assert.equal(guest.live.size, before, 'the BSTR was freed');
    await guest.writeVariant(variant, 'lent text');
    assert.equal(await codec.read(variant, false), 'lent text');
    assert.equal(guest.live.size, before + 1, 'a lent BSTR is left to its owner');

    guest.memory.setU16(variant, 9);
    guest.memory.setU32(variant + 8, 0x4444);
    assert.deepEqual(await codec.read(variant, true), { imported: 0x4444 });
    assert.deepEqual(imported.at(-1), { pointer: 0x4444, kind: 'dispatch', owned: true });
    guest.memory.setU32(variant + 8, 0);
    assert.equal(await codec.read(variant, true), null);
});

test('the numeric VARTYPEs, BYREF and DECIMAL', async()=>{
    const { guest, codec, variant } = setup();
    const { memory, view } = guest;
    /** @param {number} vt @param {(at: number) => void} fill */
    const read = (vt, fill)=>{
        guest.bytes.fill(0, variant, variant + 16);
        memory.setU16(variant, vt);
        fill(variant + 8);
        return codec.read(variant, false);
    };
    assert.equal(await read(2, at=>view.setInt16(at, -5, true)), -5);
    assert.equal(await read(17, at=>view.setUint8(at, 200)), 200);
    assert.equal(await read(16, at=>view.setInt8(at, -3)), -3);
    assert.equal(await read(19, at=>memory.setU32(at, 0xffffffff)), 4294967295);
    assert.equal(await read(4, at=>view.setFloat32(at, 0.5, true)), 0.5);
    assert.equal(await read(6, at=>view.setBigInt64(at, 123456n, true)), 12.3456);
    const long = await read(20, at=>view.setBigInt64(at, 5n, true));
    assert.ok(long instanceof ForeignValue && long.value === 5);
    // DECIMAL fills the VARIANT: scale 2, negative, 12345.
    guest.bytes.fill(0, variant, variant + 16);
    memory.setU16(variant, 14);
    view.setUint8(variant + 2, 2);
    view.setUint8(variant + 3, 0x80);
    view.setBigUint64(variant + 8, 12345n, true);
    assert.equal(await codec.read(variant, false), -123.45);
    // VT_BYREF | VT_I4, and VT_BYREF | VT_VARIANT.
    const target = guest.allocate(16);
    view.setInt32(target, 99, true);
    guest.bytes.fill(0, variant, variant + 16);
    memory.setU16(variant, 0x4003);
    memory.setU32(variant + 8, target);
    assert.equal(await codec.read(variant, true), 99);
    await guest.writeVariant(target, 'inner');
    memory.setU16(variant, 0x400c);
    assert.equal(await codec.read(variant, true), 'inner');
    assert.equal(guest.readVariant(target), 'inner', 'a reference owns nothing');
});

test('a SAFEARRAY of VARIANTs goes out and comes back the same', async()=>{
    const { guest, codec, variant } = setup();
    const before = guest.live.size;
    await codec.write(variant, variantArray([1, 'two', 3.5, null]));
    assert.equal(guest.memory.u16(variant), 0x200c);
    const array = guest.memory.u32(variant + 8);
    assert.equal(guest.memory.u16(array), 1);
    assert.equal(guest.memory.u32(array + 16), 4, 'one bound of four elements');
    const back = await codec.read(variant, true);
    assert.ok(back instanceof ForeignValue && back.isArray);
    assert.deepEqual(back.value.items, [1, 'two', 3.5, null]);
    assert.deepEqual(back.value.bounds, [{ lower: 0, count: 4 }]);
    assert.equal(guest.live.size, before, 'the array and its strings were destroyed');

    const grid = arrayValue({ elementType: 12, bounds: [{ lower: 0, count: 2 },
        { lower: 1, count: 3 }], items: [1, 2, 3, 4, 5, 6] });
    await codec.write(variant, grid);
    const copy = await codec.read(variant, true);
    assert.deepEqual(copy.value.bounds, grid.value.bounds);
    assert.deepEqual(copy.value.items, grid.value.items);

    const strings = arrayValue({ elementType: 8, bounds: [{ lower: 0, count: 2 }],
        items: ['a', 'b'] });
    await codec.write(variant, strings);
    assert.equal(guest.memory.u16(variant), 0x2008);
    assert.deepEqual((await codec.read(variant, true)).value.items, ['a', 'b']);
    assert.equal(guest.live.size, before);
});

test('a language\'s wrapper is unwrapped before it is written', async()=>{
    const guest = createFakeGuest();
    const codec = createVariantCodec(guest.com, {
        import: ()=>null,
        export: ()=>0,
        prepare: value=>(value?.wrapped !== undefined ? value.wrapped : value),
    });
    const variant = guest.allocate(16);
    await codec.write(variant, { wrapped: 'inside' });
    assert.equal(guest.readVariant(variant), 'inside');
});
