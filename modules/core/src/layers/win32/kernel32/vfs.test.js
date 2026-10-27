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

    const written = vol.stat('C:\\save.dat');
    assert.ok(written && written.modified > 0, 'a write stamps the file with a time');
    assert.deepEqual({ ...written, modified: 0 },
        { exists: true, isDirectory: false, size: 4, modified: 0 });

    const reopened = vol.open('C:\\save.dat', { read: true });
    assert.deepEqual([...vol.read(reopened, 1, 2)], [2, 3],
        'the offset is the one named on the call, not wherever the handle was');
    vol.close(reopened);
});

test('a write into a file whose blocks are not resident waits for them, as a read does', async()=>{
    // A bundled file is copied up on its first write, and the copy reads the
    // blocks under it: when they are absent the layer throws a miss naming
    // them. A launcher that writes into its game's executable must be parked
    // until they arrive, not stopped.
    const fs = await filesystemModule.create({});
    const absent = [{ index: 7 }];
    let resident = false;
    /** @type {any[]} */
    const fetched = [];
    const bundled = Object.create(fs);
    bundled.write = (/** @type {any} */ node, /** @type {Uint8Array} */ bytes)=>{
        if (!resident)
        {
            throw Object.assign(new Error('not resident'), { code: 'BLOCK_MISS', blocks: absent });
        }
        return fs.write(node, bytes);
    };
    const vol = /** @type {any} */ (createVolume(bundled, async blocks=>{
        fetched.push(...blocks);
        resident = true;
    }));
    const node = vol.open('C:\\game.exe', { read: true, write: true, create: true });
    const bytes = new Uint8Array([1, 2, 3]);

    assert.throws(()=>vol.write(node, 0, bytes), /not resident/,
        'the synchronous write still reports the miss to a caller that cannot wait');
    const pending = vol.writeOrFetch(node, 0, bytes);
    assert.equal(typeof pending?.then, 'function');
    bytes[0] = 9;
    assert.equal(await pending, 3);
    assert.deepEqual(fetched, absent, 'the blocks the miss named are the ones fetched');
    assert.deepEqual([...vol.read(node, 0, 3)], [1, 2, 3],
        'the bytes written are the ones passed at the call');
    vol.close(node);
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

test('a second writer gets in when the first agreed to share writing, and not otherwise', async()=>{
    const { fs, volume: vol } = await volume();
    const first = vol.open('C:\\pkg.dat',
        { read: true, write: true, create: true, shareWrite: true });
    assert.notEqual(first, null);
    assert.notEqual(vol.open('C:\\pkg.dat', { read: true, write: true, shareWrite: true }), null,
        'both agreed to share writing');

    const lone = vol.open('C:\\lone.dat', { read: true, write: true, create: true });
    assert.notEqual(lone, null);
    assert.equal(vol.open('C:\\lone.dat', { read: true, write: true, shareWrite: true }), null,
        'the first open shared no writing');
    await filesystemModule.dispose();
    void fs;
});

test('attributes a program set follow the name through a rename and go with a delete', async()=>{
    // The filesystem keeps no attribute bits; kernel32's file tests set
    // read-only, rename the file and expect it read-only still, and a file
    // made again under a deleted name to be an ordinary one.
    const { volume: vol } = await volume();
    vol.mkdir('C:\\dir');
    vol.close(vol.open('C:\\dir\\a.txt', { read: true, write: true, create: true }));

    assert.equal(vol.setAttributes('C:\\DIR\\A.TXT', 0x21), true);
    assert.equal(vol.stat('c:\\dir\\a.txt')?.attributes, 0x21, 'whatever the spelling');
    assert.equal(vol.list('C:\\dir', '*')[0].attributes, 0x21, 'a listing says so too');

    assert.equal(vol.rename('C:\\dir', 'C:\\moved'), true);
    assert.equal(vol.stat('C:\\moved\\a.txt')?.attributes, 0x21, 'carried with its directory');

    assert.equal(vol.remove('C:\\moved\\a.txt'), true);
    vol.close(vol.open('C:\\moved\\a.txt', { read: true, write: true, create: true }));
    assert.equal(vol.stat('C:\\moved\\a.txt')?.attributes, undefined);
    assert.equal(vol.setAttributes('C:\\nothing', 1), false, 'no name, nothing to carry them');
});

test('a watch is told what happened to which name, below the directory it watches', async()=>{
    const { volume: vol } = await volume();
    assert.ok(vol.mkdir('C:\\Watched'));
    /** @type {{ action: number, name: string }[][]} */
    const told = [];
    const all = 0x1f;
    const watch = vol.watch('C:\\watched', true, all, (/** @type {any} */ records)=>{
        told.push(records);
    }, ()=>true);

    assert.ok(vol.mkdir('C:\\Watched\\Sub'));
    const node = vol.open('C:\\Watched\\Sub\\Save.dat', { read: true, write: true, create: true });
    vol.write(node, 0, new Uint8Array([1]));
    vol.close(node);
    assert.ok(vol.rename('C:\\Watched\\Sub\\Save.dat', 'C:\\Watched\\Save.dat'));
    assert.ok(vol.rename('C:\\Watched\\Save.dat', 'C:\\Elsewhere.dat'));
    assert.equal(vol.remove('C:\\Watched\\Sub'), true);
    assert.deepEqual(told, [
        [{ action: 1, name: 'Sub' }],
        [{ action: 1, name: 'Sub\\Save.dat' }],
        [{ action: 3, name: 'Sub\\Save.dat' }],
        [{ action: 4, name: 'Sub\\Save.dat' }, { action: 5, name: 'Save.dat' }],
        [{ action: 2, name: 'Save.dat' }],
        [{ action: 2, name: 'Sub' }],
    ], 'added, modified, a rename by both names, a rename out of the watch as a removal');
    watch.close();

    const own = /** @type {any[]} */ ([]);
    vol.watch('C:\\Watched', false, 0x2, (/** @type {any} */ records)=>own.push(records),
        ()=>true);
    assert.ok(vol.rename('C:\\Watched', 'C:\\Moved'));
    assert.deepEqual(own, [], 'the watched directory moved is not told');
});

test('a hard link is one file: bytes, attributes, count and identity shared', async()=>{
    const { volume: vol } = await volume();
    const node = vol.open('C:\\A.DAT', { read: true, write: true, create: true });
    vol.write(node, 0, Uint8Array.of(1, 2, 3));
    vol.close(node);
    assert.equal(vol.link('C:\\B.DAT', 'C:\\A.DAT'), null);
    const a = vol.stat('C:\\A.DAT');
    const b = vol.stat('C:\\b.dat');
    assert.deepEqual([a?.links, b?.links, a?.identity === b?.identity], [2, 2, true]);
    vol.setAttributes('C:\\B.DAT', 0x21);
    assert.equal(vol.stat('C:\\A.DAT')?.attributes, 0x21, 'the attributes are the file\'s');

    const other = vol.open('C:\\B.DAT', { read: true, write: true });
    vol.write(other, 0, Uint8Array.of(9));
    vol.close(other);
    const reader = vol.open('C:\\A.DAT', { read: true });
    assert.deepEqual([...(/** @type {Uint8Array} */ (vol.read(reader, 0, 3)))], [9, 2, 3]);
    vol.close(reader);

    assert.equal(vol.link('C:\\A.DAT', 'C:\\B.DAT'), 'ALREADY_EXISTS');
    assert.equal(vol.link('C:\\C.DAT', 'C:\\NONE.DAT'), 'NOT_FOUND');
    vol.mkdir('C:\\DIR');
    assert.equal(vol.link('C:\\D.DAT', 'C:\\DIR'), 'ACCESS_DENIED');
    assert.equal(vol.remove('C:\\A.DAT'), true);
    assert.deepEqual([vol.stat('C:\\B.DAT')?.links, vol.stat('C:\\B.DAT')?.size], [undefined, 3],
        'one name left: an ordinary file');
});

test('a file is renamed or deleted only while every open with access shares deletion', async()=>{
    const { volume: vol, fs } = await volume();
    const made = vol.open('C:\\F.DAT', { read: true, write: true, create: true });
    vol.close(made);

    const holding = vol.open('C:\\F.DAT', { read: true, delete: true });
    assert.equal(vol.removalRefused('C:\\F.DAT'), 'SHARING_VIOLATION');
    assert.throws(()=>fs.rename('C:\\F.DAT', 'C:\\G.DAT'), { code: 'SHARING_VIOLATION' });
    assert.throws(()=>fs.deleteFile('C:\\F.DAT'), { code: 'SHARING_VIOLATION' });
    assert.equal(vol.isOpen('C:\\F.DAT'), true);
    vol.close(holding);

    // Sharing deletion, or holding no access at all, keeps nobody out.
    const sharing = vol.open('C:\\F.DAT', { read: true, shareDelete: true });
    assert.equal(vol.removalRefused('C:\\F.DAT'), null);
    vol.close(sharing);
    const attributesOnly = fs.open('C:\\F.DAT', { read: false, shareRead: false });
    assert.equal(vol.removalRefused('C:\\F.DAT'), null);
    const second = fs.open('C:\\F.DAT', { read: true, write: true });
    assert.notEqual(second, null, 'an open with no access refuses nothing, nor is refused');
    fs.close(second);
    fs.close(attributesOnly);
    assert.equal(vol.rename('C:\\F.DAT', 'C:\\G.DAT'), true);
    assert.equal(vol.isOpen('C:\\G.DAT'), false);
});
