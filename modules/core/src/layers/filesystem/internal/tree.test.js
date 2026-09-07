/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from './memory-store.js';
import { createOverlay } from './tree.js';

/** @param {string} text */
const bytes = text=>Uint8Array.from([...text].map(character=>character.charCodeAt(0)));

/** @param {Uint8Array} data */
const text = data=>[...data].map(byte=>String.fromCharCode(byte)).join('');

/**
 * A source holding an installation, and an empty writable layer over it -- the
 * shape every mounted drive has before the program has written anything.
 */
function mounted(){
    const source = createMemoryStore({
        'Game': null,
        'Game\\Data': null,
        'Game\\Data\\Config.WTF': 'source',
        'Game\\Setup.EXE': 'binary',
        'Readme.TXT': 'read me',
    });
    const writable = createMemoryStore();
    return { source, writable, tree: createOverlay({ source, writable }) };
}

test('both layers are one volume, and case is no obstacle to finding a file', ()=>{
    const { tree } = mounted();

    assert.equal(tree.stat(['Game', 'Data', 'Config.WTF'])?.size, 6);
    // The lookup a program actually makes: it wrote Config.WTF and now asks
    // for config.wtf.
    assert.equal(tree.stat(['game', 'data', 'config.wtf'])?.size, 6);
    assert.equal(tree.stat(['GAME', 'DATA'])?.directory, true);
    assert.equal(tree.stat(['Game', 'Missing']), null);
});

test('enumeration reports the case a name was created with', ()=>{
    const { tree } = mounted();

    const names = tree.list(['game', 'data']).map(entry=>entry.name);
    assert.deepEqual(names, ['Config.WTF'],
        'asking in lower case does not make the listing lower case');
    assert.deepEqual(tree.list([]).map(entry=>entry.name).sort(), ['Game', 'Readme.TXT']);
});

test('enumeration filters by the wildcard pattern it was given', ()=>{
    const { tree } = mounted();

    assert.deepEqual(tree.list(['Game'], '*.exe').map(entry=>entry.name), ['Setup.EXE']);
    assert.deepEqual(tree.list(['Game'], '*.').map(entry=>entry.name), ['Data']);
    assert.deepEqual(tree.list(['Game'], '*.*').map(entry=>entry.name).sort(),
        ['Data', 'Setup.EXE'], 'a directory with no dot in its name is still matched by *.*');
});

test('a read comes from the source until a write moves the file up', ()=>{
    const { source, writable, tree } = mounted();
    const at = ['Game', 'Data', 'Config.WTF'];

    assert.equal(text(tree.read(at, 0, 6)), 'source');
    assert.equal(writable.stat('Game\\Data\\Config.WTF'), null, 'nothing is copied up early');

    // The copy-on-write moment: one byte written, and the whole file is now
    // the writable layer's, with the bytes it had before still in place.
    tree.write(at, 6, bytes('+more'));

    assert.equal(text(tree.read(at, 0, 32)), 'source+more');
    assert.equal(writable.stat('Game\\Data\\Config.WTF')?.size, 11);
    assert.equal(text(source.read('Game\\Data\\Config.WTF', 0, 32)), 'source',
        'the source is never written to');
    // The directories above it had to be created in the writable layer first.
    assert.equal(writable.stat('Game\\Data')?.directory, true);
});

test('a write past the end extends the file and zero-fills the gap', ()=>{
    const { tree } = mounted();
    const at = ['Readme.TXT'];

    tree.write(at, 10, bytes('X'));

    assert.equal(tree.size(at), 11);
    assert.deepEqual([...tree.read(at, 6, 5)], [0x65, 0, 0, 0, 0x58],
        'the bytes between the old end and the new data are zero');
});

test('truncating a source file to nothing does not copy it up first', ()=>{
    const { writable, tree } = mounted();
    const at = ['Game', 'Setup.EXE'];

    tree.truncate(at, 0);

    assert.equal(tree.size(at), 0);
    assert.equal(writable.stat('Game\\Setup.EXE')?.size, 0);
    assert.equal(text(tree.read(at, 0, 32)), '');
});

test('a deleted source file stays deleted', ()=>{
    const { tree } = mounted();
    const at = ['Game', 'Setup.EXE'];

    tree.removeFile(at);

    assert.equal(tree.stat(at), null);
    assert.deepEqual(tree.list(['Game']).map(entry=>entry.name), ['Data'],
        'the source cannot forget the file, so enumeration has to');
    assert.throws(()=>tree.read(at, 0, 1), { code: 'NOT_FOUND' });
    assert.equal(tree.diagnostics().tombstones, 1);
});

test('a file copied up and then deleted does not fall back to the source', ()=>{
    const { tree } = mounted();
    const at = ['Game', 'Data', 'Config.WTF'];

    tree.write(at, 0, bytes('mine'));
    tree.removeFile(at);

    assert.equal(tree.stat(at), null);
    assert.deepEqual(tree.list(['Game', 'Data']), []);
});

test('recreating a deleted name does not resurrect what was under it', ()=>{
    const { tree } = mounted();

    tree.removeFile(['Game', 'Setup.EXE']);
    tree.createFile(['Game', 'setup.exe']);

    assert.equal(tree.stat(['Game', 'Setup.EXE'])?.size, 0);
    assert.equal(tree.stat(['Game', 'Setup.EXE'])?.name, 'setup.exe',
        'a recreated file carries the spelling it was recreated with');

    tree.removeFile(['Game', 'Data', 'Config.WTF']);
    tree.removeDirectory(['Game', 'Data']);
    assert.throws(()=>tree.removeDirectory(['Game', 'Data']), { code: 'NOT_FOUND' });
    tree.createDirectory(['Game', 'Data']);
    assert.deepEqual(tree.list(['Game', 'Data']), [],
        'the source file that used to be in here is gone with the directory');
});

test('a directory is refused while anything is still in it', ()=>{
    const { tree } = mounted();

    assert.throws(()=>tree.removeDirectory(['Game']), { code: 'DIRECTORY_NOT_EMPTY' });
    assert.throws(()=>tree.removeDirectory(['Game', 'Setup.EXE']), { code: 'NOT_A_DIRECTORY' });
    assert.throws(()=>tree.removeFile(['Game']), { code: 'IS_A_DIRECTORY' });
});

test('creating a directory over a source directory merges rather than hides', ()=>{
    const { writable, tree } = mounted();

    assert.equal(tree.createDirectory(['Game', 'Data']), false, 'it was already there');
    assert.equal(writable.stat('Game\\Data')?.directory, true, 'but it exists in both layers now');
    assert.deepEqual(tree.list(['Game', 'Data']).map(entry=>entry.name), ['Config.WTF'],
        'and what the source put in it is still visible');

    tree.createFile(['Game', 'Data', 'Save.DAT']);
    tree.write(['Game', 'Data', 'Save.DAT'], 0, bytes('save'));
    assert.deepEqual(tree.list(['Game', 'Data']).map(entry=>entry.name).sort(),
        ['Config.WTF', 'Save.DAT']);
});

test('a name in both layers is enumerated once', ()=>{
    const source = createMemoryStore({ 'Game\\Config.WTF': 'source' });
    const writable = createMemoryStore({ 'Game\\Config.WTF': 'mine' });
    const tree = createOverlay({ source, writable });

    assert.deepEqual(tree.list(['Game']).map(entry=>entry.name), ['Config.WTF']);
    assert.equal(text(tree.read(['Game', 'Config.WTF'], 0, 32)), 'mine',
        'and the writable layer is the one that answers');
});

test('a missing directory and a missing file are different failures', ()=>{
    const { tree } = mounted();

    assert.throws(()=>tree.size(['Game', 'Missing.DAT']), { code: 'NOT_FOUND' });
    assert.throws(()=>tree.size(['Nowhere', 'Missing.DAT']), { code: 'PATH_NOT_FOUND' });
    assert.throws(()=>tree.createFile(['Nowhere', 'New.DAT']), { code: 'PATH_NOT_FOUND' });
    assert.throws(()=>tree.createFile(['Readme.TXT']), { code: 'ALREADY_EXISTS' });
    assert.throws(()=>tree.list(['Readme.TXT']), { code: 'NOT_A_DIRECTORY' });
});

test('a drive with no source at all is just the writable layer', ()=>{
    const tree = createOverlay({ writable: createMemoryStore() });

    tree.createDirectory(['Save']);
    tree.createFile(['Save', 'slot1.sav']);
    tree.write(['Save', 'slot1.sav'], 0, bytes('data'));

    assert.deepEqual(tree.list(['Save']).map(entry=>entry.name), ['slot1.sav']);
    assert.equal(tree.diagnostics().layered, false);
    tree.removeFile(['Save', 'slot1.sav']);
    assert.equal(tree.diagnostics().tombstones, 0, 'nothing to tombstone without a source');
});

test('what was copied up is visible in diagnostics', ()=>{
    const { tree } = mounted();

    assert.deepEqual(tree.diagnostics(),
        { files: 3, directories: 2, tombstones: 0, copied: 0, layered: true });

    tree.write(['Readme.TXT'], 0, bytes('x'));
    assert.equal(tree.diagnostics().copied, 1);
});
