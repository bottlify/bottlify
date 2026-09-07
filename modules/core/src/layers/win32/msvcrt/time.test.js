/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimeFunctions, strftime, asctime, TM } from './time.js';
import { fakeMemory, fakeFpu } from './harness.test.js';

/** 2003-07-03T12:34:56Z, a Thursday. */
const WALL = Date.UTC(2003, 6, 3, 12, 34, 56);

const build = (/** @type {any} */ fpu = undefined)=>{
    const memory = fakeMemory();
    let running = 1500;
    const table = /** @type {Record<string, any>} */ (createTimeFunctions({
        ...memory,
        systemTimeMs: ()=>WALL,
        now: ()=>running,
        fpu,
    }));
    return { memory, table, advance: (/** @type {number} */ ms)=>{
        running += ms;
    } };
};

test('time answers seconds and writes them through the pointer as well', ()=>{
    const { memory, table } = build();
    const out = memory.allocate(4);
    const seconds = table.time.handler([out]);
    assert.equal(seconds, Math.floor(WALL / 1000));
    assert.equal(memory.u32(out), Math.floor(WALL / 1000));
    assert.doesNotThrow(()=>table.time.handler([0]), 'a null pointer is allowed');
});

test('clock is the running time, so a difference of two calls is an interval', ()=>{
    const { table, advance } = build();
    const start = table.clock.handler([]);
    advance(250);
    assert.equal(table.clock.handler([]) - start, 250);
});

test('localtime fills a struct tm whose fields are where the compiler put them', ()=>{
    const { memory, table } = build();
    const seconds = memory.allocate(4);
    memory.setU32(seconds, Math.floor(WALL / 1000));
    const block = table.localtime.handler([seconds]);

    assert.equal(memory.i32(block + TM.SEC), 56);
    assert.equal(memory.i32(block + TM.MIN), 34);
    assert.equal(memory.i32(block + TM.HOUR), 12);
    assert.equal(memory.i32(block + TM.MDAY), 3);
    assert.equal(memory.i32(block + TM.MON), 6, 'July is month six, not seven');
    assert.equal(memory.i32(block + TM.YEAR), 103, 'years since 1900');
    assert.equal(memory.i32(block + TM.WDAY), 4);
    assert.equal(memory.i32(block + TM.YDAY), 183);
});

test('mktime normalises the fields it was given and writes them back', ()=>{
    const { memory, table } = build();
    const block = memory.allocate(TM.SIZE);
    memory.writeMemory(block, new Uint8Array(TM.SIZE));
    // The 32nd of January, which a caller produces by adding to tm_mday.
    new DataView(memory.bytes.buffer).setInt32(block + TM.MDAY, 32, true);
    new DataView(memory.bytes.buffer).setInt32(block + TM.YEAR, 103, true);

    const seconds = table.mktime.handler([block]);
    assert.equal(seconds, Date.UTC(2003, 1, 1) / 1000);
    assert.equal(memory.i32(block + TM.MON), 1, 'rolled into February');
    assert.equal(memory.i32(block + TM.MDAY), 1);
});

test('asctime is the fixed 25-character form, newline included', ()=>{
    const text = asctime(new Date(WALL));
    assert.equal(text, 'Thu Jul  3 12:34:56 2003\n');
    assert.equal(text.length, 25, 'callers index into this');
});

test('ctime and asctime share one buffer, as documented', ()=>{
    const { memory, table } = build();
    const seconds = memory.allocate(4);
    memory.setU32(seconds, Math.floor(WALL / 1000));
    const first = table.ctime.handler([seconds]);
    assert.equal(memory.text(first), 'Thu Jul  3 12:34:56 2003\n');
    assert.equal(table.asctime.handler([table.localtime.handler([seconds])]), first);
});

test('strftime renders the fields a program actually asks for', ()=>{
    const when = new Date(WALL);
    assert.equal(strftime('%Y-%m-%d %H:%M:%S', when), '2003-07-03 12:34:56');
    assert.equal(strftime('%a %b %j %p %I', when), 'Thu Jul 184 PM 12');
    assert.equal(strftime('100%%', when), '100%');
    assert.equal(strftime('%q!', when), '!', 'an unknown specifier is dropped');
});

test('strftime writes nothing at all when the result would not fit', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(32);
    memory.writeMemory(buffer, new Uint8Array(32).fill(0x2e));
    const block = table.localtime.handler([memory.allocate(4)]);
    assert.equal(table.strftime.handler([buffer, 4, memory.put('%Y-%m-%d'), block]), 0);
    assert.equal(memory.text(buffer)[0], '.', 'the buffer is untouched');
});

test('_strdate and _strtime are the two fixed nine-byte forms', ()=>{
    const { memory, table } = build();
    const date = memory.allocate(16);
    const time = memory.allocate(16);
    table._strdate.handler([date]);
    table._strtime.handler([time]);
    assert.equal(memory.text(date), '07/03/03');
    assert.equal(memory.text(time), '12:34:56');
});

test('_ftime lays out seconds then milliseconds, as the struct does', ()=>{
    const { memory, table } = build();
    const block = memory.allocate(12);
    table._ftime.handler([block]);
    assert.equal(memory.u32(block), Math.floor(WALL / 1000));
    assert.equal(new DataView(memory.bytes.buffer).getUint16(block + 4, true), WALL % 1000);
});

test('difftime needs the FPU seam, and is signed when it has one', ()=>{
    assert.equal(build().table.difftime, undefined);
    const fpu = fakeFpu();
    build(fpu).table.difftime.handler([10, 25]);
    assert.equal(fpu.result, -15);
});
