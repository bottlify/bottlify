/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MEDIA_DIRECTORY, REGISTRY_PATH, chooseRoot, collect, guessEntry, prefixOptions,
} from './prefix.js';

/** @param {string} text */
const bytes = text=>new TextEncoder().encode(text);

/** @param {string[]} paths */
const tree = paths=>paths.map(path=>({ path, bytes: bytes(path) }));

test('the distribution is seeded where the guest can open it, and named as the image', async()=>{
    const options = prefixOptions({ name: 'Setup.exe', bytes: bytes('MZ') });

    assert.equal(options.imagePath, `${MEDIA_DIRECTORY}\\Setup.exe`);
    assert.deepEqual(options.seeded, [options.imagePath]);
    // A distribution reads its own file, so it has to be on the volume before
    // the first instruction rather than handed to the loader alone.
    assert.deepEqual((await options.storage.load()).map(file=>file.path), [options.imagePath]);
});

test('what was seeded is not part of what the installer produced', ()=>{
    const media = prefixOptions({ name: 'Setup.exe', bytes: bytes('MZ') });
    const prefix = collect({
        files: tree([media.imagePath, 'C:\\Games\\Title\\title.exe']),
        seeded: media.seeded,
    });

    assert.deepEqual(prefix.files.map(file=>file.path), ['title.exe']);
    assert.equal(prefix.root, 'C:\\Games\\Title');
});

test('the root is the shallowest directory holding an executable', ()=>{
    assert.equal(chooseRoot(tree([
        'C:\\Program Files\\Title\\title.exe',
        'C:\\Program Files\\Title\\tools\\editor.exe',
        'C:\\Program Files\\Title\\data\\art.mpq',
    ])), 'C:\\Program Files\\Title');
});

test('the system\'s own tree is never mistaken for the installation', ()=>{
    // An installer that drops a runtime in the system directory has still
    // installed the game somewhere else, and the shallowest rule alone would
    // pick the system directory every time.
    assert.equal(chooseRoot(tree([
        'C:\\Windows\\System32\\helper.exe',
        'C:\\Games\\Title\\title.exe',
    ])), 'C:\\Games\\Title');
});

test('among equally shallow candidates the one with more executables wins', ()=>{
    assert.equal(chooseRoot(tree([
        'C:\\Games\\Shortcut\\link.exe',
        'C:\\Games\\Title\\title.exe',
        'C:\\Games\\Title\\patch.exe',
    ])), 'C:\\Games\\Title');
});

test('files the root does not cover are reported rather than dropped silently', ()=>{
    const prefix = collect({
        files: tree(['C:\\Games\\Title\\title.exe', 'C:\\Windows\\System32\\runtime.dll']),
    });

    assert.deepEqual(prefix.files.map(file=>file.path), ['title.exe']);
    assert.deepEqual(prefix.outside, ['C:\\Windows\\System32\\runtime.dll']);
});

test('the registry travels as a file inside the tree', ()=>{
    const prefix = collect({
        files: tree(['C:\\Games\\Title\\title.exe']),
        registry: { roots: [{ id: 0x80000002, key: { name: 'HKEY_LOCAL_MACHINE' } }] },
    });

    const carried = prefix.files.find(file=>file.path === REGISTRY_PATH);
    assert.ok(carried, 'an unpacked prefix has to describe its own registry');
    assert.equal(JSON.parse(new TextDecoder().decode(carried.bytes)).roots[0].id, 0x80000002);
});

test('the guessed entry is the largest executable that is not a setup program', ()=>{
    assert.equal(guessEntry([
        { path: 'unins000.exe', bytes: new Uint8Array(9000) },
        { path: 'title.exe', bytes: new Uint8Array(400) },
        { path: 'config.exe', bytes: new Uint8Array(100) },
    ]), 'title.exe');
});

test('a tree with no executable keeps the volume root rather than inventing one', ()=>{
    assert.equal(chooseRoot(tree(['C:\\Data\\readme.txt'])), 'C:\\');
});
