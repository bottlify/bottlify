/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimeFunctions } from './time.js';
import { STATUS } from './status.js';

const TIME = 0x100;
const FIELDS = 0x120;
const OUT = 0x140;
const MORE = 0x150;

/** Guest memory, a bump heap and the kernel32 clocks and zone the family reads. */
function machine({ bias = 0 } = {}){
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    let next = 0x2000;
    const kernel32 = {
        QueryPerformanceCounter: { handler: (/** @type {number[]} */ [at])=>{
            view.setBigInt64(at, 1234n, true);
            return 1;
        } },
        QueryPerformanceFrequency: { handler: (/** @type {number[]} */ [at])=>{
            view.setBigInt64(at, 10_000_000n, true);
            return 1;
        } },
        GetTimeZoneInformation: { handler: (/** @type {number[]} */ [at])=>{
            view.setInt32(at, bias, true);
            return 0;
        } },
        GetSystemTimeAsFileTime: { handler: (/** @type {number[]} */ [at])=>{
            view.setBigInt64(at, 133_000_000_000_000_000n, true);
            return 0;
        } },
        GetTickCount: { handler: ()=>60_000 },
    };
    const { table, systemClasses } = createTimeFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        kernel32,
        allocate: size=>{
            const at = next;
            next += size;
            return at;
        },
        free: ()=>true,
    });
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>table[name].handler(args);
    return { view, table, systemClasses, call };
}

/** @param {DataView} view */
const fieldsOf = view=>[0, 1, 2, 3, 4, 5, 6, 7].map(index=>view.getInt16(FIELDS + index * 2, true));

test('a system time comes apart into its calendar fields and back', ()=>{
    const { view, call } = machine();
    // 2000-02-29 13:14:15.678, a Tuesday.
    const time = 125_963_036_556_780_000n;
    view.setBigInt64(TIME, time, true);
    call('RtlTimeToTimeFields', TIME, FIELDS);
    assert.deepEqual(fieldsOf(view), [2000, 2, 29, 13, 14, 15, 678, 2]);
    assert.equal(call('RtlTimeFieldsToTime', FIELDS, OUT), 1);
    assert.equal(view.getBigInt64(OUT, true), time);
});

test('1601-01-01 was a Monday, and a field out of range makes no time', ()=>{
    const { view, call } = machine();
    view.setBigInt64(TIME, 0n, true);
    call('RtlTimeToTimeFields', TIME, FIELDS);
    assert.deepEqual(fieldsOf(view), [1601, 1, 1, 0, 0, 0, 0, 1]);
    // 1900-02-29: 1900 is no leap year.
    [1900, 2, 29, 0, 0, 0, 0, 0].forEach((field, index)=>view.setInt16(FIELDS + index * 2, field, true));
    view.setBigInt64(OUT, -1n, true);
    assert.equal(call('RtlTimeFieldsToTime', FIELDS, OUT), 0);
    assert.equal(view.getBigInt64(OUT, true), -1n, 'nothing written');
});

test('seconds since 1970 and 1980, and a time before the epoch refused', ()=>{
    const { view, call } = machine();
    call('RtlSecondsSince1970ToTime', 86_400, TIME);
    assert.equal(view.getBigInt64(TIME, true), 116_444_736_000_000_000n + 864_000_000_000n);
    assert.equal(call('RtlTimeToSecondsSince1980', TIME, OUT), 0, '1970-01-02 is before 1980');
    assert.equal(call('RtlTimeToSecondsSince1970', TIME, OUT), 1);
    assert.equal(view.getUint32(OUT, true), 86_400);
});

test('local time is system time less the zone\'s bias', ()=>{
    const { view, call } = machine({ bias: -60 });
    view.setBigInt64(TIME, 0n, true);
    assert.equal(call('RtlSystemTimeToLocalTime', TIME, OUT), STATUS.SUCCESS);
    assert.equal(view.getBigInt64(OUT, true), 36_000_000_000n);
});

test('the timer resolution: coarsest until asked, and a release never asked for refused', ()=>{
    const { view, call } = machine();
    assert.equal(call('NtQueryTimerResolution', 0, OUT, MORE), STATUS.ACCESS_VIOLATION);
    assert.equal(call('NtQueryTimerResolution', OUT, OUT + 4, MORE), STATUS.SUCCESS);
    assert.deepEqual([view.getUint32(OUT, true), view.getUint32(OUT + 4, true),
        view.getUint32(MORE, true)], [156_250, 5_000, 156_250]);
    assert.equal(call('NtSetTimerResolution', 10_000, 0, MORE), 0xc0000245);
    assert.equal(call('NtSetTimerResolution', 1, 1, MORE), STATUS.SUCCESS);
    assert.equal(view.getUint32(MORE, true), 5_000, 'clamped to the finest');
});

test('the performance counter, with its frequency where asked, and no counter refused', ()=>{
    const { view, call } = machine();
    assert.equal(call('NtQueryPerformanceCounter', 0, MORE), STATUS.ACCESS_VIOLATION);
    assert.equal(call('NtQueryPerformanceCounter', OUT, MORE), STATUS.SUCCESS);
    assert.equal(view.getBigInt64(OUT, true), 1234n);
    assert.equal(view.getBigInt64(MORE, true), 10_000_000n);
});

test('the time of day: boot time is now less the uptime, a prefix to a short buffer', ()=>{
    const { systemClasses } = machine();
    const bytes = systemClasses[3].read();
    const view = new DataView(bytes.buffer);
    assert.equal(view.getBigInt64(8, true), 133_000_000_000_000_000n);
    assert.equal(view.getBigInt64(0, true), 133_000_000_000_000_000n - 600_000_000n);
    assert.equal(systemClasses[3].partial, true);
    assert.equal(systemClasses[44].read().length, 172);
});
