/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The adapter is tested against the real filesystem layer rather than a fake of
 * it. A fake would agree with whatever the adapter assumed, which is exactly the
 * disagreement this file exists to catch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from './vfs.js';

async function volume(){
    const fs = await filesystemModule.create({});
    // No bundle is mounted in these tests, so a read always answers with bytes;
    // the cast says so once rather than at every call site.
    return { fs, volume: /** @type {any} */ (createVolume(fs)) };
}

test('a missing file is an answer, not an exception', async()=>{
    const { volume: vol } = await volume();

    // The surface above turns this into a return value and an error code; it
    // cannot do that if getting there throws.
    assert.equal(vol.stat('C:\\nothing.txt'), null);
    assert.equal(vol.open('C:\\nothing.txt', { read: true }), null);
    assert.equal(vol.remove('C:\\nothing.txt'), false);
    assert.deepEqual(vol.list('C:\\nothing\\*'), []);
});

test('a file is found however the caller spelled it', async()=>{
    // Win32 paths do not distinguish case; the names a bundle stores do. This
    // is what CreateProcess relies on to find `War3.exe` for a launcher that
    // names `war3.exe` -- without it the lookup falls through and the launcher
    // starts whatever the manifest names, which is itself.
    const { volume: vol } = await volume();
    const node = vol.open('C:\\War3.exe', { read: true, write: true, create: true });
    assert.ok(node);
    vol.close(node);

    assert.equal(vol.stat('C:\\war3.exe')?.exists, true);
    assert.equal(vol.stat('C:\\WAR3.EXE')?.exists, true);
});

test('a file written through the adapter reads back through it', async()=>{
    const { volume: vol } = await volume();

    const node = vol.open('C:\\save.dat', { read: true, write: true, create: true });
    assert.ok(node);
    assert.equal(vol.write(node, 0, new Uint8Array([1, 2, 3, 4])), 4);
    vol.close(node);

    assert.deepEqual(vol.stat('C:\\save.dat'), { exists: true, isDirectory: false, size: 4 });

    const reopened = vol.open('C:\\save.dat', { read: true });
    assert.deepEqual([...vol.read(reopened, 1, 2)], [2, 3],
        'the offset is the one named on the call, not wherever the handle was');
    vol.close(reopened);
});

test('an offset is honoured even when it goes backwards', async()=>{
    const { volume: vol } = await volume();
    const node = vol.open('C:\\a.bin', { read: true, write: true, create: true });

    vol.write(node, 0, new Uint8Array([9, 9, 9, 9]));
    vol.write(node, 2, new Uint8Array([1, 1]));
    assert.deepEqual([...vol.read(node, 0, 4)], [9, 9, 1, 1]);

    // Reading the same range twice must give the same answer: the surface owns
    // the position, so a read here may not move anything the caller can see.
    assert.deepEqual([...vol.read(node, 0, 4)], [9, 9, 1, 1]);
    vol.close(node);
});

test('the five dispositions map to the five behaviours', async()=>{
    const { volume: vol } = await volume();

    const created = vol.open('C:\\x.txt', { write: true, create: true, failIfExists: true });
    assert.ok(created, 'create-new on a missing file');
    vol.write(created, 0, new Uint8Array([7, 7, 7]));
    vol.close(created);

    assert.equal(vol.open('C:\\x.txt', { write: true, create: true, failIfExists: true }), null,
        'create-new on an existing file is a failure, not a truncation');

    const opened = vol.open('C:\\x.txt', { read: true });
    assert.equal(vol.read(opened, 0, 3).length, 3, 'open-existing kept the contents');
    vol.close(opened);

    const truncated = vol.open('C:\\x.txt', { write: true, create: true, truncate: true });
    assert.ok(truncated);
    vol.close(truncated);
    assert.equal(vol.stat('C:\\x.txt')?.size, 0, 'create-always emptied it');

    assert.equal(vol.open('C:\\gone.txt', { write: true, truncate: true }), null,
        'truncate-existing needs the file to exist');
});

test('directories: made, listed, removed, and refused when not empty', async()=>{
    const { volume: vol } = await volume();

    assert.equal(vol.mkdir('C:\\Saves'), true);
    assert.equal(vol.mkdir('C:\\Saves'), false, 'making one twice is not making one');

    const node = vol.open('C:\\Saves\\one.sav', { write: true, create: true });
    vol.close(node);

    assert.deepEqual(vol.list('C:\\Saves').map((/** @type {any} */ entry)=>entry.name), ['one.sav']);
    assert.equal(vol.stat('C:\\Saves')?.isDirectory, true);
    assert.equal(vol.remove('C:\\Saves'), false, 'a directory with something in it stays');

    assert.equal(vol.remove('C:\\Saves\\one.sav'), true);
    assert.equal(vol.remove('C:\\Saves'), true);
});

test('a wildcard filters an enumeration and never opens anything', async()=>{
    const { volume: vol } = await volume();
    for (const name of ['a.sav', 'b.sav', 'notes.txt'])
    {
        vol.close(vol.open(`C:\\${name}`, { write: true, create: true }));
    }

    assert.deepEqual(vol.list('C:\\*.sav').map((/** @type {any} */ entry)=>entry.name).sort(), ['a.sav', 'b.sav']);
    assert.equal(vol.open('C:\\*.sav', { read: true }), null, 'a pattern is not a file name');
});

test('renaming moves the bytes and leaves nothing behind', async()=>{
    const { volume: vol } = await volume();
    const node = vol.open('C:\\old.dat', { write: true, create: true });
    vol.write(node, 0, new Uint8Array([4, 5, 6]));
    vol.close(node);

    assert.equal(vol.rename('C:\\old.dat', 'C:\\new.dat'), true);
    assert.equal(vol.stat('C:\\old.dat'), null);

    const moved = vol.open('C:\\new.dat', { read: true });
    assert.deepEqual([...vol.read(moved, 0, 3)], [4, 5, 6]);
    vol.close(moved);

    assert.equal(vol.rename('C:\\missing.dat', 'C:\\anything.dat'), false);
});

test('a device is not a file, and saying so is not an exception', async()=>{
    const { volume: vol } = await volume();

    // A program that opens NUL expects a handle that swallows writes, not a
    // file called NUL in the current directory. The surface answers it; what
    // matters here is that asking does not blow up on the way.
    assert.equal(vol.open('NUL', { write: true }), null);
    assert.equal(vol.stat('CON'), null);
});
