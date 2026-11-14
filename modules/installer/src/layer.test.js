/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLayer, hiveAdded } from './layer.js';
import { chunkedFile } from './chunks.js';

/** @param {string} text */
const bytes = text=>new TextEncoder().encode(text);

test('a layer is what the runs wrote on C:, under its drive folder, less their scratch', ()=>{
    const pieces = [bytes('MZ'), bytes('..')];
    const files = collectLayer({
        files: [
            { path: 'C:\\WINDOWS\\Microsoft.NET\\Framework\\v4.0.30319\\clr.dll',
                bytes: bytes('clr') },
            chunkedFile('C:\\WINDOWS\\assembly\\big.ni.dll', 4, pieces),
            { path: 'C:\\WINDOWS\\Temp\\dd_setup.txt', bytes: bytes('log') },
            { path: 'C:\\Documents and Settings\\User\\Local Settings\\Temp\\x.tmp',
                bytes: bytes('') },
            { path: 'C:\\97476d1986e5182a495ef1e5aa1d8c20\\netfx_core.msi', bytes: bytes('msi') },
            { path: 'C:\\Install\\ndp48-x86-x64-allos-enu.exe', bytes: bytes('setup') },
            { path: 'D:\\setup.exe', bytes: bytes('disc') },
        ],
        registry: { roots: [] }, before: { roots: [] }, leave: ['C:\\Install'],
    });
    assert.deepEqual(files.map(file=>file.path), [
        '.bottlify\\drive_c\\WINDOWS\\Microsoft.NET\\Framework\\v4.0.30319\\clr.dll',
        '.bottlify\\drive_c\\WINDOWS\\assembly\\big.ni.dll',
        '.bottlify\\registry.json',
    ]);
    assert.equal(files[1].pieces?.[0], pieces[0], 'a file in pieces keeps them, not copied');
});

test('a layer\'s registry is what the runs added or changed, never what the machine had', ()=>{
    /** @param {string} name @param {number[]} data */
    const value = (name, data)=>({ name, type: 1, data });
    const before = { roots: [{ id: 'HKLM', key: { name: '', values: [], keys: [
        { name: 'SOFTWARE', values: [value('Kept', [1])], keys: [
            { name: 'Microsoft', values: [value('Same', [2]), value('Changed', [3])], keys: [] }] },
    ] } }] };
    const after = { roots: [{ id: 'HKLM', key: { name: '', values: [], keys: [
        { name: 'SOFTWARE', values: [value('Kept', [1])], keys: [
            { name: 'Microsoft', values: [value('Same', [2]), value('Changed', [4])], keys: [
                { name: 'NET Framework Setup', values: [value('Install', [1])], keys: [] }] }] },
    ] } }] };
    const files = collectLayer({ files: [], registry: after, before });
    const hive = JSON.parse(new TextDecoder().decode(files[0].bytes));
    assert.deepEqual(hive, { roots: [{ id: 'HKLM', key: { name: '', values: [], keys: [
        { name: 'SOFTWARE', values: [], keys: [
            { name: 'Microsoft', values: [value('Changed', [4])], keys: [
                { name: 'NET Framework Setup', values: [value('Install', [1])], keys: [] }] }] },
    ] } }] });
    assert.equal(hiveAdded(before.roots[0].key, before.roots[0].key), null, 'nothing differs');
});
