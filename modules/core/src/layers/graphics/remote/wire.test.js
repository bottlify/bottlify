/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OP, SECTION, SERVICE_REF, WAIT, createReader, createSite, createWriter } from './wire.js';

/**
 * Each value written as the one argument of a call, read back.
 *
 * @param {any[]} values @param {(value: object) => number | undefined} [refOf]
 */
function roundTrip(values, refOf = ()=>undefined){
    const writer = createWriter();
    /** @type {boolean[]} */
    const services = [];
    for (const value of values)
    {
        writer.u8(OP.CALL);
        writer.u32(0);
        writer.string('Method');
        writer.u8(1);
        services.push(writer.value(value, refOf));
        writer.u8(0);
        writer.u8(WAIT.NONE);
    }
    /** @type {any[]} */
    const read = [];
    const { buffer, length } = writer.give();
    createReader({ ref: number=>({ ref: number }), service: ()=>'service' })
        .read(buffer, call=>{
            read.push(/** @type {any[]} */ (call.a)[0]);
        }, length);
    return { read, services };
}

test('numbers, strings and structures come back as they went', ()=>{
    const values = [0, -1, 0x7fffffff, 0xffffffff, 0.5, -0, NaN, true, false, null, undefined,
        'a string', 'a string', { x: 1, y: { z: 'deep' } }, [1, [2, 3], 'four']];
    const { read } = roundTrip(values);
    assert.equal(read.length, values.length);
    assert.ok(Object.is(read[5], -0), 'negative zero keeps its sign');
    assert.ok(Number.isNaN(read[6]));
    assert.deepEqual(read.slice(7), values.slice(7));
    assert.deepEqual(read.slice(0, 5), values.slice(0, 5));
});

test('bytes of every kind come back as views of their kind, whatever they followed', ()=>{
    const values = [1, new Uint8Array([1, 2, 3]), new Float32Array([1.5, -2]),
        new Int16Array([-3, 4]), 'x', new Float64Array([Math.PI]),
        new Uint32Array([0xdeadbeef]).subarray(0, 1)];
    const { read } = roundTrip(values);
    for (const [index, value] of values.entries())
    {
        if (ArrayBuffer.isView(value))
        {
            assert.equal(read[index].constructor, value.constructor);
            assert.deepEqual([...read[index]], [.../** @type {any} */ (value)]);
        }
    }
});

test('a device object goes by its number, and one with methods it does not know as nothing', ()=>{
    const known = { method(){} };
    const stranger = { field: 'text not yet sent', method(){} };
    const { read, services } = roundTrip(
        [known, { inner: stranger, after: 'later' }, stranger, 'text not yet sent'],
        value=>(value === known ? 7 : undefined));
    assert.deepEqual(read[0], { ref: 7 });
    assert.deepEqual(read[1], { inner: null, after: 'later' },
        'an object of another device inside a structure is null');
    assert.equal(read[2], 'service', 'an argument with methods is a service of the caller');
    assert.deepEqual(services, [false, false, true, false]);
    assert.equal(read[3], 'text not yet sent',
        'a string first written inside what was taken back is sent again');
});

test('a service the caller marked is one, and a symbol is nothing', ()=>{
    const service = {};
    const { read } = roundTrip([service, Symbol('mark')],
        value=>(value === service ? SERVICE_REF : undefined));
    assert.deepEqual(read, ['service', undefined]);
});

test('a call\'s sections and its wait come back with it', ()=>{
    const writer = createWriter();
    writer.u8(OP.CALL);
    writer.u32(3);
    writer.string('UnlockRect');
    writer.u8(0);
    writer.u8(SECTION.ALLOCS | SECTION.SHIP);
    writer.u32(1);
    writer.u32(0x1000);
    writer.u32(1);
    writer.memory(0x2000, new Uint8Array([9, 8, 7]));
    writer.u8(WAIT.ANSWER);
    writer.u32(42);
    /** @type {any[]} */
    const calls = [];
    const { buffer, length } = writer.give();
    createReader({ ref: number=>number, service: ()=>null }).read(buffer, call=>{
        calls.push(call);
    }, length);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].t, 3);
    assert.equal(calls[0].m, 'UnlockRect');
    assert.deepEqual(calls[0].allocs, [0x1000]);
    assert.equal(calls[0].ship[0].address, 0x2000);
    assert.deepEqual([...calls[0].ship[0].bytes], [9, 8, 7]);
    assert.equal(calls[0].wait, WAIT.ANSWER);
    assert.equal(calls[0].serial, 42);
});

test('a structure from one place goes by its shape, flat while it holds numbers only', ()=>{
    const writer = createWriter();
    const site = createSite();
    const light = ()=>({ Type: 1, Diffuse: { r: 0.5, g: -0, b: NaN, a: 1 }, Range: 2 ** 40 });
    const values = [
        light(),
        light(),
        { ...light(), Range: 'far' },
        { ...light(), Extra: 3 },
        { Type: 1, Diffuse: { r: 1, g: 2, b: 3, a: 4 } },
        light(),
        { Type: 2, Diffuse: null, Range: 1 },
        light(),
    ];
    /** @type {number[]} */
    const sizes = [];
    for (const value of values)
    {
        const before = writer.size();
        writer.u8(OP.CALL);
        writer.u32(0);
        writer.string('SetLight');
        writer.u8(1);
        writer.value(value, ()=>undefined, 0, site);
        writer.u8(0);
        writer.u8(WAIT.NONE);
        sizes.push(writer.size() - before);
    }
    /** @type {any[]} */
    const read = [];
    const { buffer, length } = writer.give();
    createReader({ ref: number=>number, service: ()=>null }).read(buffer, call=>{
        read.push(/** @type {any[]} */ (call.a)[0]);
    }, length);
    assert.equal(read.length, values.length);
    for (const [index, value] of values.entries())
    {
        assert.deepEqual(read[index], value, `value ${index}`);
    }
    assert.ok(Object.is(read[1].Diffuse.g, -0));
    assert.ok(sizes[1] < sizes[0], 'the second goes flat, without its keys');
    assert.ok(sizes[7] <= sizes[1] + 8, 'and flat again once the place is given its shape back');
});

/** A seeded generator. @param {number} seed */
function seeded(seed){
    let s = seed >>> 0;
    return (/** @type {number} */ n)=>{
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 8) % n;
    };
}

/**
 * Seeded batches of every kind of record, written through the writer as the
 * recording writes them, each with the calls the reader must give for it.
 *
 * @param {number} seed
 * @returns {{ batches: { buffer: ArrayBuffer, length: number }[], expected: any[][] }}
 */
function seededBatches(seed){
    const pick = seeded(seed);
    const writer = createWriter();
    const objects = [{ device: 1 }, { device: 2 }, { device: 3 }];
    /** @param {object} value */
    const refOf = value=>{
        const index = objects.indexOf(/** @type {any} */ (value));
        return index < 0 ? undefined : index + 10;
    };
    /** @param {any} value @returns {any} */
    const asRead = value=>{
        if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value))
        {
            return value;
        }
        const ref = refOf(value);
        if (ref !== undefined)
        {
            return { ref };
        }
        return Array.isArray(value) ? value.map(asRead)
            : Object.fromEntries(Object.entries(value).map(([key, one])=>[key, asRead(one)]));
    };
    const names = ['DrawPrimitive', 'SetRenderState', 'Lock', 'Unlock', 'SetLight', 'commands',
        'Present', 'SetViewport'];
    const sites = names.map(()=>[createSite(), createSite(), createSite(), createSite()]);
    const number = ()=>[pick(256), -pick(1 << 30), 0x7fffffff, 0xffffffff, pick(1000) / 8, -0,
        NaN, 2 ** 40][pick(8)];
    const typed = ()=>{
        const types = [Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
            Float32Array, Float64Array, Uint8ClampedArray];
        const Type = types[pick(types.length)];
        const array = new Type(pick(40));
        for (let index = 0; index < array.length; index++)
        {
            array[index] = pick(200) - 50;
        }
        return array;
    };
    /** @param {number} depth @returns {any} */
    const anyValue = depth=>{
        switch (pick(depth > 2 ? 9 : 13))
        {
            case 0: return number();
            case 1: return pick(1 << 20);
            case 2: return [undefined, null, true, false][pick(4)];
            case 3: return `text ${pick(12)}`;
            case 4: return typed();
            case 5: return objects[pick(3)];
            case 6: return pick(100) - 50;
            case 7: return number();
            case 8: return names[pick(names.length)];
            case 9: return Array.from({ length: pick(5) }, ()=>anyValue(depth + 1));
            case 10: return { x: number(), y: number(), w: pick(64), h: pick(64) };
            case 11: return { Diffuse: { r: number(), g: number(), b: number(), a: 1 },
                Range: number(), Type: pick(3) };
            default: return { name: `text ${pick(12)}`, inner: anyValue(depth + 1),
                count: pick(9) };
        }
    };
    /** @param {number} length */
    const memory = length=>({ address: pick(1 << 24) * 4,
        bytes: new Uint8Array(length).fill(pick(256)) });
    /** @type {{ buffer: ArrayBuffer, length: number }[]} */
    const batches = [];
    /** @type {any[][]} */
    const expected = [];
    for (let batch = 0; batch < 12; batch++)
    {
        /** @type {any[]} */
        const calls = [];
        const records = 1 + pick(60);
        for (let index = 0; index < records; index++)
        {
            const kind = pick(10);
            if (kind === 0)
            {
                const wrote = Array.from({ length: pick(3) }, ()=>memory(pick(30)));
                writer.u8(OP.WROTE);
                writer.u32(wrote.length);
                for (const one of wrote)
                {
                    writer.memory(one.address, one.bytes);
                }
                calls.push({ op: OP.WROTE, t: 0, wrote });
                continue;
            }
            if (kind === 1)
            {
                const lent = Array.from({ length: pick(4) },
                    ()=>({ address: pick(1 << 24), length: pick(1 << 16), slot: pick(8) }));
                writer.u8(OP.LENT);
                writer.u32(lent.length);
                for (const one of lent)
                {
                    writer.u32(one.address);
                    writer.u32(one.length);
                    writer.u32(one.slot);
                }
                calls.push({ op: OP.LENT, t: 0, lent });
                continue;
            }
            const t = pick(40);
            const which = pick(names.length);
            if (kind === 2 || kind === 3)
            {
                const m = `Property${pick(4)}`;
                writer.u8(kind === 2 ? OP.SET : OP.GET);
                writer.u32(t);
                writer.string(m);
                if (kind === 3)
                {
                    calls.push({ op: OP.GET, t, m });
                    continue;
                }
                const v = anyValue(1);
                writer.value(v, refOf);
                calls.push({ op: OP.SET, t, m, v: asRead(v) });
                continue;
            }
            const m = names[which];
            const a = Array.from({ length: pick(5) }, ()=>anyValue(0));
            writer.u8(OP.CALL);
            writer.u32(t);
            writer.string(m);
            writer.u8(a.length);
            a.forEach((one, place)=>writer.value(one, refOf, 0, sites[which][place]));
            /** @type {any} */
            const call = { op: OP.CALL, t, m, a: a.map(asRead) };
            const sections = pick(16);
            writer.u8(sections);
            if (sections & SECTION.ALLOCS)
            {
                call.allocs = Array.from({ length: pick(3) }, ()=>pick(1 << 24));
                writer.u32(call.allocs.length);
                for (const one of call.allocs)
                {
                    writer.u32(one);
                }
            }
            if (sections & SECTION.REPLIES)
            {
                const replies = Array.from({ length: pick(3) }, ()=>anyValue(1));
                writer.u32(replies.length);
                for (const one of replies)
                {
                    writer.value(one, refOf);
                }
                call.replies = replies.map(asRead);
            }
            for (const [section, key] of /** @type {const} */ (
                [[SECTION.SHIP, 'ship'], [SECTION.WROTE, 'wrote']]))
            {
                if (sections & section)
                {
                    call[key] = Array.from({ length: pick(3) }, ()=>memory(pick(20)));
                    writer.u32(call[key].length);
                    for (const one of call[key])
                    {
                        writer.memory(one.address, one.bytes);
                    }
                }
            }
            call.wait = pick(3);
            writer.u8(call.wait);
            if (call.wait === WAIT.ANSWER)
            {
                call.serial = pick(1 << 30);
                writer.u32(call.serial);
            }
            calls.push(call);
        }
        batches.push(writer.give());
        expected.push(calls);
    }
    return { batches, expected };
}

/**
 * A call as plain values, to compare: the fields it holds, a typed array as
 * its kind and elements, NaN and negative zero by name.
 *
 * @param {any} value @returns {any}
 */
function plain(value){
    if (ArrayBuffer.isView(value))
    {
        return { kind: value.constructor.name, elements: [.../** @type {any} */ (value)] };
    }
    if (Array.isArray(value))
    {
        return value.map(plain);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.entries(value)
            .filter(([, one])=>one !== undefined).map(([key, one])=>[key, plain(one)]));
    }
    return Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : value;
}

test('seeded batches of every record and value read back as they were written', ()=>{
    for (let seed = 1; seed <= 40; seed++)
    {
        const { batches, expected } = seededBatches(seed);
        const reader = createReader({ ref: number=>({ ref: number }), service: ()=>'service' });
        batches.forEach(({ buffer, length }, index)=>{
            /** @type {any[]} */
            const calls = [];
            reader.read(buffer, call=>{
                calls.push(plain(call));
            }, length);
            assert.deepEqual(calls, plain(expected[index]), `seed ${seed}, batch ${index}`);
        });
    }
});

test('a batch read while another is being read leaves the outer one where it was', ()=>{
    const { batches, expected } = seededBatches(7);
    const reader = createReader({ ref: number=>({ ref: number }), service: ()=>'service' });
    reader.read(batches[0].buffer, ()=>{}, batches[0].length);
    // What the inner batch holds names no string or shape, which the outer
    // one's table would then not match.
    const writer = createWriter();
    writer.u8(OP.WROTE);
    writer.u32(1);
    writer.memory(0x4000, new Uint8Array([1, 2, 3, 4, 5]));
    writer.u8(OP.LENT);
    writer.u32(1);
    writer.u32(0x8000);
    writer.u32(64);
    writer.u32(2);
    const nested = writer.give();
    /** @type {any[]} */
    const outer = [];
    /** @type {any[]} */
    const inner = [];
    reader.read(batches[1].buffer, call=>{
        outer.push(plain(call));
        if (inner.length === 0)
        {
            reader.read(nested.buffer, one=>{
                inner.push(plain(one));
            }, nested.length);
        }
    }, batches[1].length);
    assert.deepEqual(outer, plain(expected[1]));
    assert.deepEqual(inner, [
        { op: OP.WROTE, t: 0, wrote: [{ address: 0x4000,
            bytes: { kind: 'Uint8Array', elements: [1, 2, 3, 4, 5] } }] },
        { op: OP.LENT, t: 0, lent: [{ address: 0x8000, length: 64, slot: 2 }] },
    ]);
});

test('the writer counts the buffers it made and the batches that outgrew theirs', ()=>{
    const writer = createWriter();
    const bytes = new Uint8Array(40 << 10);
    assert.deepEqual(writer.figures(), { made: 1, grown: 0, copied: 0, spilled: 0 });
    writer.value(bytes, ()=>undefined);
    const before = writer.size();
    writer.value(bytes, ()=>undefined);
    assert.deepEqual(writer.figures(), { made: 2, grown: 1, copied: before, spilled: 0 },
        'a batch past its 64 KiB buffer grows it, copying what was written');
    const first = writer.give();
    assert.equal(first.buffer.byteLength, 128 << 10);
    assert.equal(writer.figures().made, 3, 'with none given back, the next batch has a new buffer');
    writer.reuse(first.buffer);
    writer.give();
    writer.value(bytes, ()=>undefined);
    writer.value(bytes, ()=>undefined);
    assert.deepEqual(writer.figures(), { made: 3, grown: 1, copied: before, spilled: 0 },
        'the grown buffer given back is written on again, as large as it grew');
});
