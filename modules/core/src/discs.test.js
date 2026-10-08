/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discReader, freeLetter, mountDiscs } from './discs.js';
import { filesystemModule } from './layers/filesystem/module.js';
import { buildIso } from './layers/filesystem/internal/iso/build.js';

const IMAGE = buildIso({ label: 'DEMO', files: {
    'SETUP.EXE': 'MZ', 'Data/a.cab': 'cab', 'Data/big.cab': new Uint8Array(1 << 20),
} });

/**
 * A worker's `FileReaderSync`, over what a Blob holds, counting the bytes it
 * was asked for: a disc read in a worker is read a slice at a time.
 */
function workerScope(){
    const asked = { bytes: 0 };
    class FileReaderSync
    {
        /** @param {any} slice */
        readAsArrayBuffer(slice){
            asked.bytes += slice.size;
            return slice.bytes.buffer.slice(slice.bytes.byteOffset,
                slice.bytes.byteOffset + slice.bytes.length);
        }
    }
    return { FileReaderSync, asked };
}

/** A Blob whose slices a fake FileReaderSync can read without a promise. */
function blobOf(/** @type {Uint8Array<ArrayBuffer>} */ bytes){
    const blob = new Blob([bytes]);
    return Object.assign(blob, {
        /** @param {number} start @param {number} end */
        slice: (start, end)=>({ size: Math.min(end, bytes.length) - start,
            bytes: bytes.subarray(start, end) }),
    });
}

test('a disc takes D:, or the first letter after it that nothing holds', ()=>{
    assert.equal(freeLetter(['C']), 'D');
    assert.equal(freeLetter(['C', 'd', 'E']), 'F');
    assert.equal(freeLetter([]), 'D');
    assert.throws(()=>freeLetter([...'DEFGHIJKLMNOPQRSTUVWXYZ']), /no drive letter/);
});

test('in a worker a Blob is read a range at a time, never whole', async()=>{
    const scope = workerScope();
    const reader = await discReader(/** @type {any} */ (blobOf(IMAGE)), scope);
    assert.equal(reader.whole, false);
    assert.equal(reader.size, IMAGE.length);
    assert.deepEqual(reader.read(16 * 2048, 6).subarray(1), IMAGE.subarray(16 * 2048 + 1,
        16 * 2048 + 6));
    assert.equal(scope.asked.bytes, 6);
});

test('without FileReaderSync a Blob is read into memory once, and says so', async()=>{
    const reader = await discReader(new Blob([IMAGE]), {});
    assert.equal(reader.whole, true);
    assert.deepEqual(reader.read(0x8001, 5), IMAGE.subarray(0x8001, 0x8006));
});

test('bytes and a synchronous reader are taken as they are', async()=>{
    assert.equal((await discReader(IMAGE)).read(0x8001, 5).length, 5);
    assert.equal((await discReader(IMAGE.buffer.slice(0))).size, IMAGE.length);
    const own = await discReader({ size: 10, read: (offset, length)=>new Uint8Array(length) });
    assert.equal(own.read(0, 3).length, 3);
    assert.equal(own.whole, false);
});

test('mounted discs are CD-ROM drives, and a letter asked for must be free', async()=>{
    const fs = await filesystemModule.create({});
    /** @type {any[]} */
    const emitted = [];
    const events = { emit: (/** @type {string} */ name, /** @type {any} */ payload)=>
        emitted.push({ name, payload }) };
    const scope = workerScope();
    const mounted = await mountDiscs({
        discs: [{ image: /** @type {any} */ (blobOf(IMAGE)) }, { image: IMAGE, letter: 'r' }],
        filesystem: fs, events, scope,
    });
    assert.deepEqual(mounted, [{ letter: 'D', label: 'DEMO' }, { letter: 'R', label: 'DEMO' }]);
    assert.equal(fs.volume('D').kind, 'cdrom');
    assert.equal(fs.volume('D').readOnly, true);
    assert.equal(fs.volume('D').size, IMAGE.length);
    assert.ok(fs.stat('R:\\Data\\a.cab'));
    assert.deepEqual(emitted.map(event=>event.payload.letter), ['D', 'R']);
    assert.equal(emitted[0].payload.whole, false);
    assert.ok(scope.asked.bytes < IMAGE.length, 'opening read less than the whole image');

    await assert.rejects(mountDiscs({ discs: [{ image: IMAGE, letter: 'C' }], filesystem: fs }),
        /letter is taken/);
    await filesystemModule.dispose();
});
