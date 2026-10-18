/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DLL_THREAD_ATTACH, DLL_THREAD_DETACH, WALK_OFFSET, createThreadCalls, threadCallsCode,
} from './thread-calls.js';

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/** @param {Uint8Array} haystack @param {number[]} needle */
const find = (haystack, needle)=>{
    for (let at = 0; at + needle.length <= haystack.length; at++)
    {
        if (needle.every((byte, index)=>haystack[at + index] === byte))
        {
            return at;
        }
    }
    return -1;
};

const LOCK = { address: 0x7000, enter: 0x7100, leave: 0x7200 };

test('a thread begins by walking the attach list, then jumps to the word above its parameter', ()=>{
    const code = threadCallsCode({ at: 0x20000, trap: 0x105000, lock: LOCK });
    assert.deepEqual([...code.slice(0, 2)], [0x6a, DLL_THREAD_ATTACH], 'push DLL_THREAD_ATTACH');
    assert.equal(code[2], 0xe8);
    assert.equal((0x20000 + 7 + (u32(code, 3) | 0)) >>> 0, 0x20000 + WALK_OFFSET, 'call walk');
    assert.deepEqual([...code.slice(7, 11)], [0xff, 0x64, 0x24, 0x08], 'jmp dword [esp+8]');
});

test('the walk takes the loader lock around the trap and the calls, and returns its argument', ()=>{
    const code = threadCallsCode({ at: 0x20000, trap: 0x105000, lock: LOCK });
    const walk = code.subarray(WALK_OFFSET);
    assert.deepEqual([...walk.slice(0, 7)], [0x53, 0x56, 0x57, 0x8b, 0x5c, 0x24, 0x10],
        'the registers it uses saved, the reason in EBX');
    const enter = find(walk, [0x68, 0x00, 0x70, 0x00, 0x00, 0xb8, 0x00, 0x71, 0x00, 0x00]);
    const trap = find(walk, [0x53, 0xb8, 0x00, 0x50, 0x10, 0x00, 0xff, 0xd0]);
    const leave = find(walk, [0x68, 0x00, 0x70, 0x00, 0x00, 0xb8, 0x00, 0x72, 0x00, 0x00]);
    assert.ok(enter >= 0 && enter < trap && trap < leave,
        `lock ${enter}, trap ${trap}, unlock ${leave}`);
    assert.deepEqual([...walk.slice(-6)], [0x5f, 0x5e, 0x5b, 0xc2, 0x04, 0x00]);
});

test('the walk calls each routine with (base, reason, NULL), its jumps landing right', ()=>{
    const code = threadCallsCode({ at: 0x20000, trap: 0x105000, lock: null });
    const walk = code.subarray(WALK_OFFSET);
    assert.equal(find(walk, [0x68]), -1, 'no lock without one to take');
    const next = find(walk, [0x8b, 0x06, 0x85, 0xc0, 0x74]);
    assert.ok(next > 0);
    // jz done lands past the loop's jmp; the jmp lands back on `mov eax, [esi]`.
    const done = next + 6 + walk[next + 5];
    assert.deepEqual([...walk.slice(done, done + 3)], [0x5f, 0x5e, 0x5b], 'jz lands on done');
    assert.equal(walk[done - 2], 0xeb);
    assert.equal(done + (walk[done - 1] << 24 >> 24), next, 'jmp lands on next');
    assert.deepEqual([...walk.slice(next + 6, done - 2)], [
        0x89, 0xe7, 0x6a, 0x00, 0x53, 0xff, 0x76, 0x04, 0xff, 0xd0, 0x89, 0xfc, 0x83, 0xc6, 0x08,
    ]);
});

/**
 * @param {import('./thread-calls.js').ThreadCallImage[]} images
 * @param {{ room?: number }} [options]
 */
function machine(images, { room = Infinity } = {}){
    const memory = new Uint8Array(0x10000);
    let free = 0x1000;
    let left = room;
    /** @type {Record<string, { argBytes: number, handler: Function }>} */
    const traps = {};
    const calls = createThreadCalls({
        register: (name, fn)=>{
            traps[name] = fn;
            return 0x9000;
        },
        allocate: bytes=>{
            if (left-- <= 0)
            {
                return 0;
            }
            const at = free;
            free += (bytes + 7) & ~7;
            return at;
        },
        allocateCode: bytes=>{
            const at = free;
            free += (bytes + 15) & ~15;
            return at;
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        images: ()=>images,
        loaderLock: ()=>LOCK,
    });
    /** The list the trap answers, as [routine, base] pairs. @param {number} reason */
    const list = reason=>{
        const at = traps['<thread-calls>'].handler([reason]);
        /** @type {number[][]} */
        const pairs = [];
        for (let cursor = at; u32(memory, cursor) !== 0; cursor += 8)
        {
            pairs.push([u32(memory, cursor), u32(memory, cursor + 4)]);
        }
        return { at, pairs };
    };
    return { calls, list, memory, traps };
}

test('the attach list is each image in load order, its TLS callbacks before its entry point', ()=>{
    const m = machine([
        { base: 0x400000, routines: [0x401100] },
        { base: 0x10000000, routines: [0x10001200, 0x10001300, 0x10001000] },
        { base: 0x20000000, routines: [0x20001000] },
    ]);
    assert.notEqual(m.calls.start(), 0);
    assert.deepEqual(m.list(DLL_THREAD_ATTACH).pairs, [
        [0x401100, 0x400000],
        [0x10001200, 0x10000000], [0x10001300, 0x10000000], [0x10001000, 0x10000000],
        [0x20001000, 0x20000000],
    ]);
});

test('the detach list takes the images the other way round, each still callbacks first', ()=>{
    const m = machine([
        { base: 0x400000, routines: [0x401100] },
        { base: 0x10000000, routines: [0x10001200, 0x10001000] },
    ]);
    m.calls.start();
    assert.deepEqual(m.list(DLL_THREAD_DETACH).pairs, [
        [0x10001200, 0x10000000], [0x10001000, 0x10000000],
        [0x401100, 0x400000],
    ]);
    assert.deepEqual(m.calls.diagnostics(), { tables: 2, attaches: 0, detaches: 1 },
        'the empty list, made with the routine, and this one');
});

test('a list asked for again is the one already written, and a changed one is new', ()=>{
    /** @type {import('./thread-calls.js').ThreadCallImage[]} */
    const images = [{ base: 0x10000000, routines: [0x10001000] }];
    const m = machine(images);
    m.calls.start();
    const first = m.list(DLL_THREAD_ATTACH).at;
    assert.equal(m.list(DLL_THREAD_ATTACH).at, first);
    images.push({ base: 0x20000000, routines: [0x20001000] });
    const second = m.list(DLL_THREAD_ATTACH);
    assert.notEqual(second.at, first);
    assert.equal(second.pairs.length, 2);
    images.pop();
    assert.equal(m.list(DLL_THREAD_ATTACH).at, first, 'the first list again');
});

test('with no room for a list a thread is told of nobody; with none for the routine, of none', ()=>{
    const roomy = machine([{ base: 0x10000000, routines: [0x10001000] }], { room: 1 });
    assert.notEqual(roomy.calls.start(), 0, 'the empty list took the room');
    assert.deepEqual(roomy.list(DLL_THREAD_ATTACH).pairs, []);

    const cramped = machine([{ base: 0x10000000, routines: [0x10001000] }], { room: 0 });
    assert.equal(cramped.calls.start(), 0);
    assert.equal(cramped.calls.walk(), 0);
});

test('a thread ending has somebody to tell only while some image has a routine', ()=>{
    /** @type {import('./thread-calls.js').ThreadCallImage[]} */
    const images = [];
    const m = machine(images);
    assert.equal(m.calls.pending(), false);
    images.push({ base: 0x10000000, routines: [] });
    assert.equal(m.calls.pending(), false);
    images.push({ base: 0x20000000, routines: [0x20001000] });
    assert.equal(m.calls.pending(), true);
    assert.equal(m.calls.walk(), m.calls.start() + WALK_OFFSET);
});
