/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeHooks, plain } from './serve.js';

test('a diagnostics table holding an object that refers back to itself is posted without it', ()=>{
    /** @type {any} */
    const texture = { width: 64, surfaces: [] };
    texture.surfaces.push({ level: 0, parent: texture });
    const shared = { n: 1 };
    const table = { frame: [{ texture }], again: shared, twice: shared, call: ()=>0 };

    assert.deepEqual(plain(table), {
        frame: [{ texture: { width: 64, surfaces: [{ level: 0 }] } }],
        again: { n: 1 },
        twice: { n: 1 },
    }, 'the cycle is cut, an object met twice side by side is copied both times');
});

test('a hook goes into its module wherever and whenever the module was mapped', ()=>{
    /** @type {Record<string, ((payload: any) => void)[]>} */
    const handlers = {};
    /** @type {number[]} */
    const hooked = [];
    /** @type {{ name: string, base: number }[]} */
    let modules = [
        { name: 'C:\\App\\Launcher.exe', base: 0x400000 },
        { name: 'mss32.dll', base: 0x10000000 },
    ];
    const app = {
        on: (/** @type {string} */ name, /** @type {(payload: any) => void} */ handler)=>{
            (handlers[name] ??= []).push(handler);
        },
        debug: {
            hook: (/** @type {number} */ address)=>{
                hooked.push(address);
            },
            modules: ()=>modules,
        },
    };
    const fire = (/** @type {string} */ name, /** @type {any} */ payload)=>{
        for (const handler of handlers[name] ?? [])
        {
            handler(payload);
        }
    };
    /** @type {any[]} */
    const emitted = [];
    const spec = (/** @type {string} */ module, /** @type {number} */ offset)=>({
        module, offset, label: module, argBytes: 0, lengths: [1],
    });
    placeHooks(app, [spec('mss32.dll', 0x10), spec('game.exe', 0x20), spec('late.dll', 0x30)],
        (type, payload)=>emitted.push({ type, ...payload }));

    assert.deepEqual(hooked, [0x10000010], 'a library the program imported, mapped before the run');

    fire('library-loaded', { name: 'mss32.dll', base: 0x10000000 });
    fire('library-loaded', { name: 'C:\\App\\LATE.DLL', base: 0x20000000 });
    assert.deepEqual(hooked, [0x10000010, 0x20000030],
        'one watch an address; a library asked for by path is named by its file');

    modules = [
        { name: 'C:\\App\\GAME.EXE', base: 0x400000 },
        { name: 'mss32.dll', base: 0x10000000 },
    ];
    fire('process-started', { image: 'C:\\App\\GAME.EXE' });
    assert.deepEqual(hooked, [0x10000010, 0x20000030, 0x400020, 0x10000010],
        'the image that replaces the process, and its libraries again in the new machine');
    assert.equal(emitted.length, 4);
    assert.ok(emitted.every(line=>line.type === 'hook' && !line.refused));
});
