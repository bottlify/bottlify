/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OP, SECTION, SERVICE_REF, WAIT, createReader, createWriter } from './wire.js';

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
    createReader({ ref: number=>({ ref: number }), service: ()=>'service' })
        .read(writer.take(), call=>{
            read.push(/** @type {any[]} */ (call.a)[0]);
        });
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
    createReader({ ref: number=>number, service: ()=>null }).read(writer.take(), call=>{
        calls.push(call);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].t, 3);
    assert.equal(calls[0].m, 'UnlockRect');
    assert.deepEqual(calls[0].allocs, [0x1000]);
    assert.equal(calls[0].ship[0].address, 0x2000);
    assert.deepEqual([...calls[0].ship[0].bytes], [9, 8, 7]);
    assert.equal(calls[0].wait, WAIT.ANSWER);
    assert.equal(calls[0].serial, 42);
});
