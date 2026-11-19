/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemModules } from './system-modules.js';

const ALIGN = 0x10000;

/**
 * System modules over a loader that lays every export out 16 bytes apart and
 * a bridge that numbers its traps.
 *
 * @param {{ long?: boolean, ordinalsOf?: Record<string, Record<number, string>> }} [given]
 */
function setup({ long = false, ordinalsOf = {} } = {}){
    /** @type {any[]} */
    const synthesised = [];
    /** @type {string[]} */
    const registered = [];
    /** @type {[number, number][]} */
    const atomic = [];
    const modules = createSystemModules({
        loader: {
            synthesise: (/** @type {any} */ request)=>{
                synthesised.push(request);
                const at = new Map(request.exports.map((/** @type {any} */ entry,
                    /** @type {number} */ index)=>[entry.name, request.base + 0x1000 + index * 16]));
                return {
                    size: 0x1000 + request.exports.length * 16
                        + (request.name === 'big.dll' ? 0x20000 : 0),
                    addressOf: (/** @type {string} */ name)=>at.get(name),
                    ordinalOf: (/** @type {string} */ name)=>request.exports
                        .find((/** @type {any} */ entry)=>entry.name === name)?.ordinal
                        ?? [...at.keys()].indexOf(name) + 1,
                    entryPoint: request.entryPoint ? request.base + 0x800 : 0,
                    place: ()=>{},
                };
            },
        },
        bridge: {
            register: (/** @type {string} */ label)=>{
                registered.push(label);
                return 0x100000 + registered.length * 16;
            },
            label: ()=>{},
        },
        cpu: { stubAt: ()=>null },
        atomicCode: (address, length)=>void atomic.push([address, length]),
        long,
        ordinalsOf,
        start: 0x02000000,
        end: 0x08000000,
        align: ALIGN,
        librarySpace: {},
        placeLibrary: ()=>({ error: 'unused' }),
        reportDivergence: ()=>{},
        release: ()=>0,
    });
    return { modules, synthesised, registered, atomic };
}

const handler = { handler: ()=>0 };

test('each module goes where the one before it ends, at the image granularity', ()=>{
    const { modules } = setup();
    const a = modules.build('a.dll', { One: handler });
    const big = modules.build('big.dll', { Two: handler });
    const c = modules.build('c.dll', { Three: handler });
    assert.equal(a.base, 0x02000000);
    assert.equal(big.base, 0x02010000);
    assert.equal(c.base, 0x02010000 + 0x30000, 'past a module larger than one granule');
    assert.equal(modules.end(), c.base + ALIGN);
    assert.equal(a.addressOf('One'), 0x02001000);
    assert.equal(a.addressOf('Missing'), null);
    assert.equal(a.loaded, false, 'not loaded until something imports or loads it');
});

test('an export keeps the number its library is imported by, and a trap is named for it', ()=>{
    const { modules, synthesised, registered } = setup({
        ordinalsOf: { 'oledlg.dll': { 3: 'OleUIInsertObjectA' } } });
    const record = modules.build('oledlg.dll', { OleUIInsertObjectA: handler, DllMain: handler });
    assert.equal(synthesised[0].exports.find((/** @type {any} */ entry)=>entry.name
        === 'OleUIInsertObjectA').ordinal, 3);
    assert.equal(record.addressOfOrdinal(3), record.addressOf('OleUIInsertObjectA'));
    assert.deepEqual(registered, ['oledlg.dll!OleUIInsertObjectA', 'oledlg.dll!DllMain']);
    assert.equal(synthesised[0].entryPoint, 'DllMain', 'a table with DllMain has an entry point');
});

test('a 64-bit process leaves out what is i386 alone, and says which', ()=>{
    const i386 = { code: ()=>new Uint8Array([0xc3]) };
    const both = { code: ()=>new Uint8Array([0xc3]), long: ()=>new Uint8Array([0xc3]) };
    const narrow = setup();
    narrow.modules.build('msvcrt.dll', { _chkesp: i386, memcpy: both, exit: handler });
    assert.equal(narrow.synthesised[0].exports.length, 3);
    assert.deepEqual(narrow.modules.leftOutAt64, []);
    const wide = setup({ long: true });
    wide.modules.build('msvcrt.dll', { _chkesp: i386, memcpy: both, exit: handler });
    assert.deepEqual(wide.synthesised[0].exports.map((/** @type {any} */ entry)=>entry.name),
        ['memcpy', 'exit']);
    assert.deepEqual(wide.modules.leftOutAt64, ['msvcrt.dll!_chkesp']);
});

test('an export that runs unbroken is told to the kernel at its address and length', ()=>{
    const { modules, atomic } = setup();
    const record = modules.build('d3d9.dll', {
        Plain: { code: ()=>new Uint8Array(4) },
        Held: { code: ()=>new Uint8Array(12), unbroken: true },
    });
    assert.deepEqual(atomic, [[record.addressOf('Held'), 12]]);
});
