/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Disposition, SeekFrom, createFileTable } from './handles.js';
import { createMemoryStore } from './memory-store.js';
import { createOverlay } from './tree.js';

/** @param {string} text */
const bytes = text=>Uint8Array.from([...text].map(character=>character.charCodeAt(0)));

/** @param {Uint8Array} data */
const text = data=>[...data].map(byte=>String.fromCharCode(byte)).join('');

const READ = { read: true, write: false };
const WRITE = { read: false, write: true };
const BOTH = { read: true, write: true };
/** Everything below shares unless a test is specifically about not sharing. */
const SHARED = { read: true, write: true };

function mounted(){
    const tree = createOverlay({
        source: createMemoryStore({ 'Game\\Data.BIN': 'abcdef' }),
        writable: createMemoryStore(),
    });
    return { tree, files: createFileTable() };
}

/**
 * @param {any} files @param {any} tree @param {string[]} components
 * @param {any} [extra]
 */
const openFile = (files, tree, components, extra = {})=>files.open({
    tree,
    key: `c:${components.join('\\').toLowerCase()}`,
    components,
    access: BOTH,
    share: SHARED,
    ...extra,
});

test('a handle carries a position of its own', ()=>{
    const { tree, files } = mounted();
    const handle = openFile(files, tree, ['Game', 'Data.BIN'], { access: READ });

    assert.equal(text(files.read(handle, 3)), 'abc');
    assert.equal(files.position(handle), 3);
    assert.equal(text(files.read(handle, 3)), 'def');
    assert.equal(files.position(handle), 6);
    assert.equal(files.size(handle), 6);
});

test('a read past the end returns what is there rather than failing', ()=>{
    const { tree, files } = mounted();
    const handle = openFile(files, tree, ['Game', 'Data.BIN'], { access: READ });

    assert.equal(text(files.read(handle, 100)), 'abcdef', 'a short read, not an error');
    assert.equal(files.position(handle), 6);
    assert.deepEqual([...files.read(handle, 100)], [], 'and nothing at all once at the end');
    assert.equal(files.position(handle), 6, 'a read of nothing does not move the position');
});

test('a seek moves the position and may land past the end', ()=>{
    const { tree, files } = mounted();
    const handle = openFile(files, tree, ['Game', 'Data.BIN']);

    assert.equal(files.seek(handle, 2, SeekFrom.BEGIN), 2);
    assert.equal(text(files.read(handle, 2)), 'cd');
    assert.equal(files.seek(handle, -1, SeekFrom.CURRENT), 3);
    assert.equal(files.seek(handle, 0, SeekFrom.END), 6);
    assert.equal(files.seek(handle, -2, SeekFrom.END), 4);

    // Seeking past the end is legal; only a write there grows the file.
    assert.equal(files.seek(handle, 100, SeekFrom.BEGIN), 100);
    assert.equal(files.size(handle), 6);
    assert.throws(()=>files.seek(handle, -1, SeekFrom.BEGIN), { code: 'INVALID_PARAMETER' });
});

test('a write past the end extends the file and zero-fills the gap', ()=>{
    const { tree, files } = mounted();
    const handle = openFile(files, tree, ['Game', 'Data.BIN']);

    files.seek(handle, 8, SeekFrom.BEGIN);
    assert.equal(files.write(handle, bytes('Z')), 1);

    assert.equal(files.size(handle), 9);
    files.seek(handle, 0, SeekFrom.BEGIN);
    assert.deepEqual([...files.read(handle, 9)],
        [...bytes('abcdef'), 0, 0, 0x5a]);
});

test('two handles on one file see each other and keep their own positions', ()=>{
    const { tree, files } = mounted();
    const writer = openFile(files, tree, ['Game', 'Data.BIN']);
    const reader = openFile(files, tree, ['game', 'data.bin'], { access: READ });

    files.seek(writer, 3, SeekFrom.BEGIN);
    files.write(writer, bytes('XYZ'));

    // The bytes live in the overlay, not in the handle, so the reader that was
    // opened first sees the write without reopening anything.
    assert.equal(text(files.read(reader, 6)), 'abcXYZ');
    assert.equal(files.position(writer), 6);
    assert.equal(files.position(reader), 6);

    files.seek(reader, 0, SeekFrom.BEGIN);
    files.write(writer, bytes('!'));
    assert.equal(files.size(reader), 7, 'and sees the file grow');
    assert.equal(text(files.read(reader, 100)), 'abcXYZ!',
        'including through a read that was already in progress');
});

test('each disposition does what its name says', ()=>{
    const { tree, files } = mounted();
    const existing = ['Game', 'Data.BIN'];
    const fresh = ['Game', 'New.DAT'];

    assert.throws(()=>openFile(files, tree, existing, { disposition: Disposition.CREATE_NEW }),
        { code: 'ALREADY_EXISTS' });
    assert.throws(()=>openFile(files, tree, fresh, { disposition: Disposition.OPEN_EXISTING }),
        { code: 'NOT_FOUND' });
    assert.throws(()=>openFile(files, tree, fresh, { disposition: Disposition.TRUNCATE_EXISTING }),
        { code: 'NOT_FOUND' });

    const created = openFile(files, tree, fresh, { disposition: Disposition.CREATE_NEW });
    assert.equal(files.size(created), 0);
    files.close(created);

    const opened = openFile(files, tree, fresh, { disposition: Disposition.OPEN_ALWAYS });
    assert.equal(files.size(opened), 0);
    files.write(opened, bytes('data'));
    files.close(opened);

    const again = openFile(files, tree, fresh, { disposition: Disposition.OPEN_ALWAYS });
    assert.equal(files.size(again), 4, 'OPEN_ALWAYS keeps what is there');
    files.close(again);

    const emptied = openFile(files, tree, fresh, { disposition: Disposition.CREATE_ALWAYS });
    assert.equal(files.size(emptied), 0, 'CREATE_ALWAYS does not');
});

test('creating a file through a handle leaves it in the writable layer', ()=>{
    const writable = createMemoryStore();
    const tree = createOverlay({
        source: createMemoryStore({ 'Game\\Data.BIN': 'abcdef' }),
        writable,
    });
    const files = createFileTable();

    const handle = openFile(files, tree, ['Game', 'Save.DAT'],
        { disposition: Disposition.CREATE_ALWAYS });
    files.write(handle, bytes('slot'));

    assert.equal(writable.stat('Game\\Save.DAT')?.size, 4);
    assert.equal(writable.stat('Game')?.directory, true, 'with the directory above it created too');
});

test('SetEndOfFile cuts the file at the position, and extends from it', ()=>{
    const { tree, files } = mounted();
    const handle = openFile(files, tree, ['Game', 'Data.BIN']);

    files.seek(handle, 3, SeekFrom.BEGIN);
    files.setEnd(handle);
    assert.equal(files.size(handle), 3);

    files.seek(handle, 5, SeekFrom.BEGIN);
    files.setEnd(handle);
    assert.equal(files.size(handle), 5);
    files.seek(handle, 0, SeekFrom.BEGIN);
    assert.deepEqual([...files.read(handle, 5)], [...bytes('abc'), 0, 0]);
});

test('an intent a handle was not opened with is refused', ()=>{
    const { tree, files } = mounted();
    const reader = openFile(files, tree, ['Game', 'Data.BIN'], { access: READ });
    const writer = openFile(files, tree, ['Game', 'Data.BIN'], { access: WRITE });

    assert.throws(()=>files.write(reader, bytes('x')), { code: 'ACCESS_DENIED' });
    assert.throws(()=>files.read(writer, 1), { code: 'ACCESS_DENIED' });
    assert.throws(()=>files.setEnd(reader), { code: 'ACCESS_DENIED' });
});

test('a second open is refused when the first did not share that access', ()=>{
    const { tree, files } = mounted();
    const at = ['Game', 'Data.BIN'];
    const exclusive = openFile(files, tree, at, { share: { read: false, write: false } });

    assert.throws(()=>openFile(files, tree, at, { access: READ }), { code: 'SHARING_VIOLATION' });
    // The other direction: the file is already open for writing, so an open
    // that refuses to share writing cannot be granted either.
    files.close(exclusive);

    const writer = openFile(files, tree, at, { access: WRITE, share: SHARED });
    assert.throws(()=>openFile(files, tree, at, { access: READ, share: READ }),
        { code: 'SHARING_VIOLATION' });
    assert.ok(openFile(files, tree, at, { access: READ, share: SHARED }));
    files.close(writer);
});

test('sharing is judged before anything is created', ()=>{
    const { tree, files } = mounted();
    const at = ['Game', 'Data.BIN'];
    openFile(files, tree, at, { share: { read: false, write: false } });

    assert.throws(
        ()=>openFile(files, tree, at, { access: READ, disposition: Disposition.CREATE_ALWAYS }),
        { code: 'SHARING_VIOLATION' });
    assert.equal(tree.size(at), 6, 'the refused open did not empty the file on its way out');
});

test('a directory is not a file to open', ()=>{
    const { tree, files } = mounted();

    assert.throws(()=>openFile(files, tree, ['Game']), { code: 'IS_A_DIRECTORY' });
});

test('a closed handle is not a handle', ()=>{
    const { tree, files } = mounted();
    const handle = openFile(files, tree, ['Game', 'Data.BIN']);

    assert.equal(files.diagnostics().open, 1);
    assert.equal(files.diagnostics().opened, 1);
    files.close(handle);
    assert.equal(files.diagnostics().open, 0);
    assert.equal(files.diagnostics().closed, 1);

    assert.throws(()=>files.read(handle, 1), { code: 'INVALID_HANDLE' });
    assert.throws(()=>files.close(handle), { code: 'INVALID_HANDLE' });
    // And what it was holding no longer blocks anyone.
    assert.ok(openFile(files, tree, ['Game', 'Data.BIN'],
        { share: { read: false, write: false } }));
});

test('the report says which files a run read, and how much of each', ()=>{
    const { tree, files } = mounted();
    const handle = openFile(files, tree, ['Game', 'Data.BIN']);
    files.read(handle, 3);
    files.read(handle, 2);
    files.close(handle);
    // Opened twice so that a repeated open is visible as one entry, not two.
    files.close(openFile(files, tree, ['Game', 'Data.BIN']));

    const byPath = files.diagnostics().byPath;
    const entry = Object.entries(byPath).find(([path])=>path.endsWith('Data.BIN'));
    assert.ok(entry, 'the file that was read is named in the report');
    assert.equal(entry[1], '2 opens, 5 bytes');
});
