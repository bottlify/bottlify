/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createHive,
    HKEY_CLASSES_ROOT,
    HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE,
    REG_BINARY,
    REG_DWORD,
    REG_MULTI_SZ,
    REG_SZ,
} from './registry.js';

/** A root id no hive hosts, used to prove a save cannot invent one. */
const HKEY_UNKNOWN_ROOT = 0x80000050;

/** @param {string} text */
const latin1 = text=>Uint8Array.from([...text].map(character=>character.charCodeAt(0)));

/** @param {ReturnType<typeof createHive>} hive @param {string} path */
const machine = (hive, path)=>hive.create(
    /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), path).key;

test('the predefined roots exist and nothing else does', ()=>{
    const hive = createHive();

    assert.ok(hive.root(HKEY_CLASSES_ROOT));
    assert.ok(hive.root(HKEY_CURRENT_USER));
    assert.ok(hive.root(HKEY_LOCAL_MACHINE));
    assert.equal(hive.root(0x80000004), null, 'HKEY_PERFORMANCE_DATA is not one of ours');
    assert.equal(hive.root(4), null, 'an ordinary handle value is not a root');
});

test('a key path is created once and found again whatever its case', ()=>{
    const hive = createHive();
    const root = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));

    const first = hive.create(root, 'Software\\Vendor\\Product');
    assert.equal(first.created, true);

    const again = hive.create(root, 'SOFTWARE\\vendor\\PRODUCT');
    assert.equal(again.created, false, 'case does not make a second key');
    assert.equal(again.key, first.key);

    assert.equal(hive.open(root, 'software\\VENDOR'), hive.open(root, 'Software\\Vendor'));
    assert.equal(hive.open(root, 'Software\\Missing'), null);
});

test('an empty path names the key itself', ()=>{
    const hive = createHive();
    const root = /** @type {any} */ (hive.root(HKEY_CURRENT_USER));

    assert.equal(hive.open(root, ''), root);
    assert.equal(hive.open(root, null), root);
    assert.equal(hive.create(root, '').key, root);
    // Guest code concatenates these paths and leaves separators behind.
    assert.equal(hive.open(root, '\\'), root);
});

test('values are found without regard to case, and a missing one is null', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software\\Vendor');

    hive.setValue(key, 'InstallPath', REG_SZ, latin1('C:\\Games'));

    // Both directions: folding only on the way in would still answer a
    // lower-case question and nothing else.
    assert.equal(
        /** @type {any} */ (hive.getValue(key, 'installpath')).name,
        'InstallPath',
        'the name comes back as it was written, not as it was asked for');
    assert.ok(hive.getValue(key, 'INSTALLPATH'));
    assert.ok(hive.getValue(key, 'InstallPath'));
    assert.equal(hive.getValue(key, 'Missing'), null);
});

test('string data is stored with its terminator counted', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software');

    // A guest that passes strlen as the byte count is the common case, and the
    // reader on the other side expects to find the NUL anyway.
    const sz = hive.setValue(key, 'Path', REG_SZ, latin1('ab'));
    assert.deepEqual([...sz.data], [0x61, 0x62, 0]);

    const already = hive.setValue(key, 'Done', REG_SZ, latin1('ab\0'));
    assert.deepEqual([...already.data], [0x61, 0x62, 0], 'a terminator is not doubled');

    const empty = hive.setValue(key, 'Empty', REG_SZ, new Uint8Array(0));
    assert.deepEqual([...empty.data], [0]);

    // REG_MULTI_SZ ends the list with a second NUL, not a first.
    const multi = hive.setValue(key, 'List', REG_MULTI_SZ, latin1('a\0b\0'));
    assert.deepEqual([...multi.data], [0x61, 0, 0x62, 0, 0]);
});

test('binary and dword data are stored byte for byte', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software');

    const dword = hive.setValue(key, 'Count', REG_DWORD, Uint8Array.from([7, 0, 0, 0]));
    assert.deepEqual([...dword.data], [7, 0, 0, 0], 'a trailing zero is data, not a terminator');

    const binary = hive.setValue(key, 'Blob', REG_BINARY, Uint8Array.from([1, 2, 3]));
    assert.deepEqual([...binary.data], [1, 2, 3]);
});

test('enumeration order is insertion order and survives an overwrite', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software');

    hive.create(key, 'Beta');
    hive.create(key, 'Alpha');
    hive.setValue(key, 'second', REG_DWORD, Uint8Array.from([0, 0, 0, 0]));
    hive.setValue(key, 'first', REG_DWORD, Uint8Array.from([0, 0, 0, 0]));

    assert.deepEqual(hive.subkeys(key), ['Beta', 'Alpha']);
    assert.deepEqual(hive.values(key).map(value=>value.name), ['second', 'first']);

    hive.setValue(key, 'SECOND', REG_DWORD, Uint8Array.from([1, 0, 0, 0]));
    assert.deepEqual(hive.values(key).map(value=>value.name), ['SECOND', 'first'],
        'rewriting a value leaves it where an enumeration already found it');
});

test('a key with subkeys is refused rather than deleted', ()=>{
    const hive = createHive();
    const root = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));
    hive.create(root, 'Software\\Vendor\\Product');

    assert.equal(hive.remove(root, 'Software\\Vendor'), 'has-subkeys');
    assert.equal(hive.remove(root, 'Software\\Vendor\\Product'), 'deleted');
    assert.equal(hive.remove(root, 'SOFTWARE\\VENDOR'), 'deleted', 'case is no obstacle');
    assert.equal(hive.remove(root, 'Software\\Vendor'), 'missing');
    assert.equal(hive.remove(root, ''), 'missing', 'a key cannot delete itself');
});

test('deleting a value reports whether there was one', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software');
    hive.setValue(key, 'Gone', REG_SZ, latin1('x'));

    assert.equal(hive.deleteValue(key, 'GONE'), true);
    assert.equal(hive.deleteValue(key, 'Gone'), false);
    assert.equal(hive.getValue(key, 'Gone'), null);
});

test('a hive survives a round trip through JSON', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software\\Vendor\\Product');
    hive.setValue(key, 'InstallPath', REG_SZ, latin1('C:\\Games'));
    hive.setValue(key, 'Blob', REG_BINARY, Uint8Array.from([0, 1, 2, 0xff]));
    hive.setValue(key, '', REG_SZ, latin1('default'));
    hive.create(key, 'Second');
    hive.create(key, 'First');
    hive.setValue(
        /** @type {any} */ (hive.root(HKEY_CURRENT_USER)), 'Top', REG_DWORD,
        Uint8Array.from([9, 0, 0, 0]));

    // Through an actual serialisation, since that is what a saved session is.
    const restored = createHive();
    restored.fromJSON(JSON.parse(JSON.stringify(hive.toJSON())));

    const back = /** @type {any} */ (restored.open(
        /** @type {any} */ (restored.root(HKEY_LOCAL_MACHINE)), 'software\\vendor\\product'));
    assert.ok(back, 'the tree comes back, and still ignores case');
    assert.deepEqual(restored.subkeys(back), ['Second', 'First'], 'order is part of the contract');
    assert.deepEqual(restored.values(back).map(value=>value.name), ['InstallPath', 'Blob', '']);
    assert.deepEqual(
        [...(/** @type {any} */ (restored.getValue(back, 'blob')).data)], [0, 1, 2, 0xff]);
    assert.equal(/** @type {any} */ (restored.getValue(back, 'InstallPath')).type, REG_SZ);
    assert.deepEqual(restored.toJSON(), hive.toJSON());
});

test('restoring a partial save leaves the other roots usable', ()=>{
    const hive = createHive();
    hive.fromJSON({ roots: [{ id: HKEY_UNKNOWN_ROOT, key: { name: 'x', values: [], keys: [] } }] });

    assert.ok(hive.root(HKEY_LOCAL_MACHINE), 'a root nobody saved is empty, not absent');
    assert.equal(hive.subkeys(/** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE))).length, 0);
    assert.equal(hive.root(HKEY_UNKNOWN_ROOT), null);
});

test('a restore discards what the hive was holding', ()=>{
    const hive = createHive();
    machine(hive, 'Software\\Stale');

    hive.fromJSON(createHive().toJSON());

    assert.equal(
        hive.open(/** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), 'Software'), null);
});
