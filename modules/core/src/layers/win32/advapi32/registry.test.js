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

test('the hive announces a burst of changes once, and a restore not at all', async()=>{
    // Whoever keeps the hive between runs is told when it is worth keeping
    // again. A program writes its settings one value at a time; that is one
    // save, not one per value, and putting a saved hive back is not a change.
    const hive = createHive();
    let announced = 0;
    hive.onChanged(()=>announced++);
    const user = /** @type {any} */ (hive.root(HKEY_CURRENT_USER));
    const { key } = hive.create(user, 'Software\\Test');
    hive.setValue(key, 'Name', REG_SZ, Uint8Array.of(65, 0));
    hive.setValue(key, 'Width', REG_DWORD, Uint8Array.of(0, 4, 0, 0));
    assert.equal(announced, 0, 'not from inside the call that makes the change');
    await Promise.resolve();
    assert.equal(announced, 1, 'one burst, one announcement');

    hive.fromJSON(hive.toJSON());
    await Promise.resolve();
    assert.equal(announced, 1, 'a restore is not a change');

    hive.deleteValue(key, 'Missing');
    await Promise.resolve();
    assert.equal(announced, 1, 'and neither is deleting what was not there');
});

test('the predefined roots exist and nothing else does', ()=>{
    const hive = createHive();

    assert.ok(hive.root(HKEY_CLASSES_ROOT));
    assert.ok(hive.root(HKEY_CURRENT_USER));
    assert.ok(hive.root(HKEY_LOCAL_MACHINE));
    assert.equal(hive.root(0x80000004), null, 'HKEY_PERFORMANCE_DATA is not one of ours');
    assert.equal(hive.root(4), null, 'an ordinary handle value is not a root');
});

test('the keys every machine carries are there before any program writes', ()=>{
    // An installer opens SharedDLLs, Uninstall and the shell folders without
    // creating them, and takes a missing one for a broken machine: measured
    // as a program that installed the same file for ever after the open
    // failed.
    const hive = createHive();
    const local = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));
    const shared = hive.open(local, 'Software\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs');
    assert.ok(shared, 'found whatever the case');
    const version = hive.open(local, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion');
    const files = version && hive.getValue(version, 'ProgramFilesDir');
    assert.equal(files && String.fromCharCode(...files.data.subarray(0, files.data.length - 1)),
        'C:\\Program Files');
    // DirectX's own setup library reads the version here and tells an
    // installer whether to offer its redistributable.
    const directX = hive.open(local, 'software\\microsoft\\directx');
    const dxVersion = directX && hive.getValue(directX, 'Version');
    assert.equal(dxVersion && String.fromCharCode(...dxVersion.data.subarray(0, 12)),
        '4.09.00.0904');
    // A program reads the processor's speed here to scale its own clock
    // readings, and one that finds nothing calls this a 0 MHz machine.
    const processor = hive.open(local, 'HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0');
    const mhz = processor && hive.getValue(processor, '~MHz');
    assert.equal(mhz?.type, REG_DWORD, 'as a DWORD, which is how the kernel writes it');
    assert.deepEqual(mhz && [...mhz.data], [0xe8, 0x03, 0, 0],
        '1000 MHz, the rate rdtsc advances at');
    assert.ok(processor && hive.getValue(processor, 'VendorIdentifier'));

    // A restore keeps what a program wrote and puts back what it deleted.
    hive.remove(local, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs');
    const { key } = hive.create(local, 'SOFTWARE\\Vendor');
    hive.setValue(key, 'Path', REG_SZ, Uint8Array.of(67, 0));
    hive.fromJSON(hive.toJSON());
    const restored = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));
    assert.ok(hive.open(restored, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs'));
    assert.ok(hive.open(restored, 'SOFTWARE\\Vendor'));
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
    const key = machine(hive, 'Software\\Test');

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
    const key = machine(hive, 'Software\\Test');

    const dword = hive.setValue(key, 'Count', REG_DWORD, Uint8Array.from([7, 0, 0, 0]));
    assert.deepEqual([...dword.data], [7, 0, 0, 0], 'a trailing zero is data, not a terminator');

    const binary = hive.setValue(key, 'Blob', REG_BINARY, Uint8Array.from([1, 2, 3]));
    assert.deepEqual([...binary.data], [1, 2, 3]);
});

test('enumeration order is insertion order and survives an overwrite', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software\\Test');

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
    const key = machine(hive, 'Software\\Test');
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

    assert.ok(hive.root(HKEY_LOCAL_MACHINE), 'a root nobody saved is there, not absent');
    assert.deepEqual(hive.subkeys(/** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE))),
        ['SOFTWARE', 'SYSTEM', 'HARDWARE'], 'holding only what every machine holds');
    assert.equal(hive.root(HKEY_UNKNOWN_ROOT), null);
});

test('a restore discards what the hive was holding', ()=>{
    const hive = createHive();
    machine(hive, 'Software\\Stale');

    hive.fromJSON(createHive().toJSON());

    assert.equal(
        hive.open(/** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), 'Software\\Stale'), null);
});
