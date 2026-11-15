/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComObject } from '../ole32/objects.js';
import { CLSID_SEEKING_PASS_THRU, IID_ISEEKING_PASS_THRU, createPassThru } from './passthru.js';
import { IID_IMEDIA_POSITION, IID_IMEDIA_SEEKING } from './interfaces.js';

const E_NOTIMPL = 0x80004001 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const UPSTREAM = 0x5000;
const SEEKING = 0x6000;
const INPUT = 0x7000;

/**
 * A base whose guest objects are records: an upstream output pin answering
 * IMediaSeeking, and an input pin connected to it.
 */
function machine(){
    const memory = new DataView(new ArrayBuffer(0x10000));
    let next = 0x8000;
    /** @type {[number, number, number[]][]} */
    const calls = [];
    const base = /** @type {any} */ ({
        queryInterface: async(/** @type {number} */ self, /** @type {string} */ iid)=>
            (self === UPSTREAM && iid === IID_IMEDIA_SEEKING ? SEEKING : 0),
        /** @param {number} self @param {number} slot @param {number[]} [args] */
        call: async(self, slot, args = [])=>{
            calls.push([self, slot, args]);
            if (self === INPUT && slot === 6)
            {
                // IPin::ConnectedTo
                memory.setUint32(args[0], UPSTREAM, true);
                return 0;
            }
            return self === SEEKING ? 0x1234 : 0;
        },
        addRef: async()=>2,
        release: async()=>1,
    });
    const host = /** @type {any} */ ({
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes + 8;
            return at;
        },
        free: ()=>{},
        readU32: (/** @type {number} */ at)=>memory.getUint32(at, true),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            bytes.forEach((b, i)=>memory.setUint8(at + i, b)),
    });
    return { base, host, calls, memory };
}

/** @param {any} object @param {string} iid @param {string} name @param {number[]} args */
const invoke = (object, iid, name, args)=>object.interfaceFor(iid).methods
    .find((/** @type {any} */ m)=>m.name === name).invoke(object, args);

test('seeking asked downstream is asked of the upstream pin, slot for slot', async()=>{
    const m = machine();
    const passThru = createPassThru(m.base, m.host);
    let upstream = 0;
    const object = createComObject('{00000000-0000-0000-0000-0000000000AA}', {
        state: null, interfaces: passThru.seekingFaces(()=>upstream),
    });
    assert.equal(await invoke(object, IID_IMEDIA_SEEKING, 'GetDuration', [0x100]), E_NOTIMPL,
        'unconnected: nobody to ask');
    upstream = UPSTREAM;
    assert.equal(await invoke(object, IID_IMEDIA_SEEKING, 'GetDuration', [0x100]), 0x1234);
    assert.deepEqual(m.calls.at(-1), [SEEKING, 3 + 7, [0x100]], 'GetDuration is its eighth method');
    assert.equal(await invoke(object, IID_IMEDIA_POSITION, 'GetTypeInfoCount', [0x200]), 0);
    assert.equal(m.memory.getUint32(0x200, true), 0, 'no type information');
});

test('CLSID_SeekingPassThru seeks through the pin its input is connected to', async()=>{
    const m = machine();
    const passThru = createPassThru(m.base, m.host);
    const object = createComObject(CLSID_SEEKING_PASS_THRU, passThru.seekingPassThru());
    assert.equal(await invoke(object, IID_IMEDIA_SEEKING, 'GetDuration', [0x100]), E_NOTIMPL,
        'not initialised');
    assert.equal(await invoke(object, IID_ISEEKING_PASS_THRU, 'Init', [0, INPUT]), 0);
    assert.equal(await invoke(object, IID_ISEEKING_PASS_THRU, 'Init', [0, INPUT]), E_UNEXPECTED,
        'once only');
    assert.equal(await invoke(object, IID_IMEDIA_SEEKING, 'GetDuration', [0x100]), 0x1234);
});
