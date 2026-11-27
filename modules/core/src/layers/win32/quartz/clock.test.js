/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComObject } from '../ole32/objects.js';
import { createSystemClock } from './clock.js';
import { CLSID_SYSTEM_CLOCK, IID_IREFERENCE_CLOCK } from './interfaces.js';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;

function machine(){
    let now = 1000;
    /** @type {Map<number, number>} */
    const memory = new Map();
    /** @type {{ due: number, period: number, fired: () => void, cancelled: boolean }[]} */
    const timers = [];
    /** @type {string[]} */
    const signalled = [];
    const host = {
        now: ()=>now,
        /** @param {number} due @param {number} period @param {() => void} fired */
        at: (due, period, fired)=>{
            const timer = { due, period, fired, cancelled: false };
            timers.push(timer);
            return { cancel: ()=>{
                timer.cancelled = true;
            } };
        },
        /** @param {number} handle */
        setEvent: handle=>signalled.push(`event ${handle}`),
        /** @param {number} handle */
        releaseSemaphore: handle=>signalled.push(`semaphore ${handle}`),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>bytes.forEach((byte, i)=>memory.set(address + i, byte)),
    };
    const object = createComObject(CLSID_SYSTEM_CLOCK, createSystemClock(host)());
    const methods = /** @type {any} */ (object.interfaceFor(IID_IREFERENCE_CLOCK)).methods;
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>methods.find((/** @type {any} */ m)=>m.name === name)
        .invoke(object, args) >>> 0;
    /** @param {number} address */
    const quad = address=>{
        let value = 0n;
        for (let i = 7; i >= 0; i--)
        {
            value = value << 8n | BigInt(memory.get(address + i) ?? 0);
        }
        return Number(value);
    };
    return {
        call, quad, timers, signalled, object,
        /** @param {number} address */
        dword: address=>quad(address) % 0x1_0000_0000,
        /** @param {number} ms */
        advance: ms=>{
            now += ms;
        },
    };
}

test('GetTime is the machine\'s millisecond in REFERENCE_TIME, S_FALSE until it moves', ()=>{
    const m = machine();
    assert.equal(m.call('GetTime', [0]), E_POINTER);
    assert.equal(m.call('GetTime', [0x100]), S_OK);
    assert.equal(m.quad(0x100), 1000 * 10_000);
    assert.equal(m.call('GetTime', [0x100]), S_FALSE, 'no time has passed');
    m.advance(5);
    assert.equal(m.call('GetTime', [0x100]), S_OK);
    assert.equal(m.quad(0x100), 1005 * 10_000);
});

test('AdviseTime signals the event once at base plus offset, and is gone after', ()=>{
    const m = machine();
    // Base 1000 ms and offset 100 ms, as two REFERENCE_TIMEs by value.
    assert.equal(m.call('AdviseTime', [10_000_000, 0, 1_000_000, 0, 0x44, 0]), E_POINTER);
    assert.equal(m.call('AdviseTime', [(-10_000_000) >>> 0, 0xffffffff, 0, 0, 0x44, 0x200]),
        E_INVALIDARG, 'a time before zero');
    assert.equal(m.call('AdviseTime', [10_000_000, 0, 1_000_000, 0, 0x44, 0x200]), S_OK);
    assert.equal(m.timers[0].due, 1100);
    assert.equal(m.timers[0].period, 0);
    m.timers[0].fired();
    assert.deepEqual(m.signalled, ['event 68']);
    assert.equal(m.call('Unadvise', [m.dword(0x200)]), S_FALSE, 'a fired advise is gone');
});

test('AdvisePeriodic releases the semaphore each period; Unadvise and Release cancel', ()=>{
    const m = machine();
    assert.equal(m.call('AdvisePeriodic', [10_000_000, 0, 0, 0, 0x48, 0x200]), E_INVALIDARG,
        'no period');
    assert.equal(m.call('AdvisePeriodic', [10_000_000, 0, 1_000_000, 0, 0x48, 0x200]), S_OK);
    assert.deepEqual([m.timers[0].due, m.timers[0].period], [1000, 100]);
    m.timers[0].fired();
    m.timers[0].fired();
    assert.deepEqual(m.signalled, ['semaphore 72', 'semaphore 72']);
    assert.equal(m.call('Unadvise', [m.dword(0x200)]), S_OK);
    assert.equal(m.timers[0].cancelled, true);

    assert.equal(m.call('AdviseTime', [10_000_000, 0, 1_000_000, 0, 0x44, 0x200]), S_OK);
    m.object.release();
    assert.equal(m.timers[1].cancelled, true, 'nothing is signalled for a clock let go');
});
