/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Access, RegionKind, createRegionMap } from './regions.js';
import { DwordReader } from './reader.js';

/**
 * A region map over three regions -- a stack, a thread block, a program's
 * data -- counting what it is asked, and a machine whose RAM is `bytes`.
 *
 * @param {{ lends?: boolean }} [options]
 */
function setup({ lends = true } = {}){
    let bytes = new Uint8Array(0x4000);
    const regions = createRegionMap();
    for (const [name, base] of /** @type {[string, number][]} */ ([
        ['stack', 0x1000], ['teb', 0x2000], ['data', 0x3000]]))
    {
        regions.register({ name, base, size: 0x100, kind: RegionKind.THUNK_DATA,
            access: Access.READ_WRITE });
    }
    let asked = 0;
    const assertSpan = regions.assert;
    regions.assert = (...args)=>{
        asked++;
        return assertSpan.apply(regions, args);
    };
    /** @type {string[]} */
    const machineCalls = [];
    let lent = 0;
    const machine = {
        ...lends ? {
            ramView: ()=>{
                lent++;
                return bytes;
            },
        } : {},
        /** @param {number} address */
        readU32: address=>{
            machineCalls.push(`readU32 ${address.toString(16)}`);
            return new DataView(bytes.buffer).getUint32(address, true);
        },
        /**
         * @param {number} address @param {number} count
         * @param {number[]} into @param {number} at
         */
        readU32sInto: (address, count, into, at)=>{
            machineCalls.push(`readU32sInto ${address.toString(16)} ${count}`);
            for (let word = 0; word < count; word++)
            {
                into[at + word] = new DataView(bytes.buffer).getInt32(address + word * 4, true);
            }
        },
    };
    const put = (/** @type {number} */ address, /** @type {number} */ value)=>
        new DataView(bytes.buffer).setUint32(address, value, true);
    return {
        regions, machine, machineCalls, put,
        reader: new DwordReader(regions, machine),
        asked: ()=>asked,
        lent: ()=>lent,
        /** The machine's memory moves, as an emulator's does when it grows. */
        move: ()=>{
            const moved = new Uint8Array(bytes.length);
            moved.set(bytes);
            /** @type {any} */ (bytes.buffer).transfer();
            bytes = moved;
        },
    };
}

test('dwords are read out of the RAM the machine lends, signed into an array or unsigned alone',
    ()=>{
        const m = setup();
        m.put(0x1010, 0x401234);
        m.put(0x1014, 0xfffffffe);
        m.put(0x2034, 0x80000057);
        /** @type {number[]} */
        const into = [7, 0, 0];
        m.reader.readU32sInto(0x1010, 2, into, 1);
        assert.deepEqual(into, [7, 0x401234, -2]);
        assert.equal(m.reader.readU32(0x2034), 0x80000057);
        assert.deepEqual(m.machineCalls, [], 'nothing asked of the machine but its RAM');
        assert.equal(m.lent(), 1);
    });

test('a span is checked against the region map, which refuses as it always has', ()=>{
    const m = setup();
    assert.throws(()=>m.reader.readU32(0x1800), /0x1800/);
    assert.throws(()=>m.reader.readU32sInto(0x10fc, 2, [], 0), /stack|0x10fc/,
        'a span running out of its region');
});

test('the stack, the thread block and the data are each validated once, until the map changes',
    ()=>{
        const m = setup();
        for (let turn = 0; turn < 4; turn++)
        {
            m.reader.readU32sInto(0x1010, 3, [], 0);
            m.reader.readU32(0x2010);
            m.reader.readU32(0x3010);
        }
        assert.equal(m.asked(), 3, 'each of the three validated once');
        m.regions.protect('data', Access.NONE);
        assert.throws(()=>m.reader.readU32(0x3010), /data|0x3010/,
            'a region that stopped permitting reads refuses them at once');
        m.reader.readU32(0x1010);
        assert.equal(m.asked(), 5, 'a changed map is asked again');
    });

test('RAM that moved is asked for again and read where it is now', ()=>{
    const m = setup();
    m.put(0x1010, 5);
    assert.equal(m.reader.readU32(0x1010), 5);
    m.move();
    m.put(0x1010, 6);
    assert.equal(m.reader.readU32(0x1010), 6, 'the dword where the memory went');
    assert.equal(m.lent(), 2, 'the view asked for again');
    m.put(0x1014, 7);
    /** @type {number[]} */
    const into = [];
    m.move();
    m.reader.readU32sInto(0x1010, 2, into, 0);
    assert.deepEqual(into, [6, 7]);
    assert.equal(m.lent(), 3);
});

test('a machine that lends no RAM is read through its own calls, checked the same', ()=>{
    const m = setup({ lends: false });
    m.put(0x1010, 9);
    /** @type {number[]} */
    const into = [];
    m.reader.readU32sInto(0x1010, 2, into, 0);
    assert.equal(m.reader.readU32(0x1010), 9);
    assert.deepEqual(into, [9, 0]);
    assert.deepEqual(m.machineCalls, ['readU32sInto 1010 2', 'readU32 1010']);
    assert.throws(()=>m.reader.readU32(0x1800), /0x1800/);
});
