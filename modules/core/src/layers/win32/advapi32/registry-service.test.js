/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHive, HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_DWORD }
    from './registry.js';
import { createRegistryService } from './registry-service.js';

/** What would cross a thread: the value as structured clone carries it. */
const crossed = (/** @type {any} */ value)=>structuredClone(value);

test('everything the service answers is a value: it survives a structured clone unchanged', ()=>{
    const registry = createRegistryService(createHive());
    const machine = /** @type {number} */ (registry.root(HKEY_LOCAL_MACHINE));
    const made = registry.create(machine, 'SOFTWARE\\Vendor\\Game');
    registry.setValue(made.key, 'Ready', REG_DWORD, Uint8Array.of(1, 0, 0, 0));
    const answers = [
        machine, made, registry.open(machine, 'SOFTWARE\\Vendor'), registry.subkeys(made.key),
        registry.getValue(made.key, 'ready'), registry.values(made.key),
        registry.placeOf(made.key), registry.remove(machine, 'SOFTWARE\\Missing'),
        registry.rename(machine, 'nothing', 'else'), registry.deleteValue(made.key, 'Ready'),
        registry.throughClasses(made.key),
    ];
    for (const answer of answers)
    {
        assert.deepEqual(crossed(answer), answer);
    }
    assert.equal(typeof machine, 'number');
    assert.equal(typeof made.key, 'number');
});

test('a key is one number for the run: opened twice, by its parent or through its path', ()=>{
    const registry = createRegistryService(createHive());
    const user = /** @type {number} */ (registry.root(HKEY_CURRENT_USER));
    const made = registry.create(user, 'Software\\A\\B').key;
    const parent = /** @type {number} */ (registry.open(user, 'Software\\A'));
    assert.equal(registry.open(user, 'Software\\A\\B'), made);
    assert.equal(registry.open(parent, 'b'), made, 'names fold as Windows folds them');
    assert.deepEqual(registry.placeOf(made), { parent, name: 'B' });
    assert.equal(registry.placeOf(user), null, 'a root hangs nowhere');
});

test('a key through the classes root is numbered by its path, and is the classes root\'s', ()=>{
    const registry = createRegistryService(createHive());
    const classes = /** @type {number} */ (registry.root(HKEY_CLASSES_ROOT));
    const made = registry.create(classes, '.foo').key;
    assert.equal(registry.open(classes, '.FOO'), made, 'the same path is the same number');
    assert.equal(registry.throughClasses(made), true);
    assert.deepEqual(registry.placeOf(made), { parent: classes, name: '.foo' });
});

test('a key outside every root is let go of when asked; one in the tree never is', ()=>{
    const registry = createRegistryService(createHive());
    const detached = registry.detached();
    registry.setValue(detached, 'v', REG_DWORD, Uint8Array.of(7, 0, 0, 0));
    assert.equal(registry.getValue(detached, 'v')?.data[0], 7);
    registry.forget(detached);
    assert.equal(registry.getValue(detached, 'v'), null, 'its number names nothing now');
    const machine = /** @type {number} */ (registry.root(HKEY_LOCAL_MACHINE));
    registry.forget(machine);
    assert.notEqual(registry.open(machine, 'SOFTWARE'), null);
    assert.throws(()=>registry.create(detached, 'x'), /no key numbered/,
        'creating under a number never given out is the caller\'s mistake');
});
