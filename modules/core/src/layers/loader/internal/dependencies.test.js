/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDependencies } from './dependencies.js';
import { buildExe } from '../../../../../../tools/make-pe.mjs';

/**
 * An image that imports one function from each named library. What it does when
 * it runs is beside the point -- nothing here runs it, only reads its imports.
 */
const importing = (/** @type {string[]} */ dlls)=>new Uint8Array(buildExe({
    imports: Object.fromEntries(dlls.map(dll=>[dll, ['Anything']])),
    code: ()=>[0xc3], // ret
}));

/** Everything is ours unless a test says otherwise. */
const systemOnly = (/** @type {string[]} */ names)=>{
    const set = new Set(names.map(name=>name.toLowerCase()));
    return (/** @type {string} */ name)=>set.has(name.toLowerCase());
};

test('a system library is not something to go and find', async()=>{
    const entry = importing(['KERNEL32.dll', 'USER32.dll']);
    let asked = 0;

    const { order, missing } = await planDependencies({
        entry,
        isSystem: systemOnly(['kernel32.dll', 'user32.dll']),
        readLibrary: async()=>{
            asked++;
            return null;
        },
    });

    assert.equal(asked, 0, 'nothing was looked for on the volume');
    assert.deepEqual(order, []);
    assert.deepEqual(missing, []);
});

test('a library the program ships is found, and its own dependencies come first', async()=>{
    // The order is what makes binding possible: fmod imports msacm, so msacm has
    // to be mapped before fmod is, and fmod before the program that wants it.
    const library = {
        'fmod.dll': importing(['msacm32.dll', 'KERNEL32.dll']),
        'msacm32.dll': importing(['KERNEL32.dll']),
    };

    const { order, missing } = await planDependencies({
        entry: importing(['fmod.dll', 'KERNEL32.dll']),
        isSystem: systemOnly(['kernel32.dll']),
        readLibrary: async name=>library[/** @type {keyof typeof library} */ (name)] ?? null,
    });

    assert.deepEqual(order.map(entry=>entry.name), ['msacm32.dll', 'fmod.dll']);
    assert.deepEqual(missing, []);
});

test('two libraries that import each other terminate, and are each loaded once', async()=>{
    // Mutual imports are ordinary, not a defect. What resolves them is the
    // binding pass after every image is mapped, so all this walk has to do is
    // finish and name each library once.
    /** @type {Record<string, Uint8Array>} */
    const library = {
        'a.dll': importing(['b.dll']),
        'b.dll': importing(['a.dll']),
    };

    const { order } = await planDependencies({
        entry: importing(['a.dll']),
        isSystem: systemOnly([]),
        readLibrary: async name=>library[name] ?? null,
    });

    assert.deepEqual(order.map(entry=>entry.name), ['b.dll', 'a.dll']);
});

test('a library that is neither ours nor present is recorded, not thrown', async()=>{
    // A program that never calls into it runs. One that does fails where it
    // called, which is a far better place to find out than here.
    const { order, missing } = await planDependencies({
        entry: importing(['absent.dll', 'KERNEL32.dll']),
        isSystem: systemOnly(['kernel32.dll']),
        readLibrary: async()=>null,
    });

    assert.deepEqual(order, []);
    assert.deepEqual(missing, ['absent.dll']);
});

test('a library reached by two paths is loaded once', async()=>{
    /** @type {Record<string, Uint8Array>} */
    const library = {
        'left.dll': importing(['shared.dll']),
        'right.dll': importing(['shared.dll']),
        'shared.dll': importing([]),
    };

    const { order } = await planDependencies({
        entry: importing(['left.dll', 'right.dll']),
        isSystem: systemOnly([]),
        readLibrary: async name=>library[name] ?? null,
    });

    assert.deepEqual(order.map(entry=>entry.name), ['shared.dll', 'left.dll', 'right.dll']);
});

test('the spelling of an import descriptor is not depended on', async()=>{
    // Descriptors disagree about case between linkers, and the same library
    // named two ways must not be mapped twice at two bases.
    /** @type {Record<string, Uint8Array>} */
    const library = { 'Thing.dll': importing([]) };

    const { order } = await planDependencies({
        entry: importing(['Thing.dll', 'THING.DLL']),
        isSystem: systemOnly([]),
        readLibrary: async()=>library['Thing.dll'],
    });

    assert.equal(order.length, 1);
});
