/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMmioFunctions } from './mmio.js';
import { fakeVolume } from '../msvcrt/stdio.test.js';
import { fakeMemory } from '../msvcrt/harness.test.js';

const MMIO_READ = 0;
const MMIO_FINDCHUNK = 0x10;
const MMIO_FINDRIFF = 0x20;
const MMIO_FINDLIST = 0x40;
const MMIOERR_CHUNKNOTFOUND = 275;

/** @param {string} text */
const fourcc = text=>text.charCodeAt(0) | text.charCodeAt(1) << 8
    | text.charCodeAt(2) << 16 | text.charCodeAt(3) << 24;

/** @param {number} value */
const le32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * A wave file with an odd-sized chunk before the data, so the pad byte
 * matters: RIFF(WAVE){ fmt (3 bytes + pad), LIST(INFO){ ISFT(2) }, data(4) }.
 */
function waveFile(){
    const fmt = [...'fmt '].map(c=>c.charCodeAt(0)).concat(le32(3), [1, 2, 3, 0]);
    const isft = [...'ISFT'].map(c=>c.charCodeAt(0)).concat(le32(2), [0x41, 0x42]);
    const list = [...'LIST'].map(c=>c.charCodeAt(0)).concat(le32(4 + isft.length),
        [...'INFO'].map(c=>c.charCodeAt(0)), isft);
    const data = [...'data'].map(c=>c.charCodeAt(0)).concat(le32(4), [9, 8, 7, 6]);
    const body = [...'WAVE'].map(c=>c.charCodeAt(0)).concat(fmt, list, data);
    return new Uint8Array([...'RIFF'].map(c=>c.charCodeAt(0)).concat(le32(body.length), body));
}

/** @param {{ late?: boolean }} [options] */
function build(options = {}){
    const memory = fakeMemory();
    const files = fakeVolume({ 'C:\\click.wav': waveFile() }, options);
    const fns = /** @type {any} */ (createMmioFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        files,
    }));
    return { memory, files, fns };
}

test('a wave file is walked as RIFF chunks, pad byte and parent bound included', ()=>{
    const { memory, files, fns } = build();
    const handle = fns.mmioOpenA.handler([memory.put('C:\\click.wav'), 0, MMIO_READ]);
    assert.notEqual(handle, 0);

    // Descend into the RIFF form by type, then find chunks within it.
    const parent = memory.allocate(20);
    memory.setU32(parent + 8, fourcc('WAVE'));
    assert.equal(fns.mmioDescend.handler([handle, parent, 0, MMIO_FINDRIFF]), 0);
    assert.equal(memory.u32(parent), fourcc('RIFF'));
    assert.equal(memory.u32(parent + 12), 8, 'the data offset of a form is its form type');
    assert.equal(fns.mmioSeek.handler([handle, 0, 1]), 12, 'and the file stands past it');

    const chunk = memory.allocate(20);
    memory.setU32(chunk, fourcc('fmt '));
    assert.equal(fns.mmioDescend.handler([handle, chunk, parent, MMIO_FINDCHUNK]), 0);
    assert.equal(memory.u32(chunk + 4), 3);
    const buffer = memory.allocate(16);
    assert.equal(fns.mmioRead.handler([handle, buffer, 3]), 3);
    assert.deepEqual([...memory.bytes.subarray(buffer, buffer + 3)], [1, 2, 3]);
    assert.equal(fns.mmioAscend.handler([handle, chunk, 0]), 0);
    assert.equal(fns.mmioSeek.handler([handle, 0, 1]), 12 + 8 + 3 + 1,
        'ascending past an odd chunk skips its pad byte');

    // A LIST by form type, a chunk inside it, and the search bounded by it.
    const list = memory.allocate(20);
    memory.setU32(list + 8, fourcc('INFO'));
    assert.equal(fns.mmioDescend.handler([handle, list, parent, MMIO_FINDLIST]), 0);
    memory.setU32(chunk, fourcc('data'));
    assert.equal(fns.mmioDescend.handler([handle, chunk, list, MMIO_FINDCHUNK]),
        MMIOERR_CHUNKNOTFOUND, 'data is not inside the LIST');
    memory.setU32(chunk, fourcc('ISFT'));
    assert.equal(fns.mmioDescend.handler([handle, chunk, list, MMIO_FINDCHUNK]), 0);
    assert.equal(fns.mmioAscend.handler([handle, list, 0]), 0);

    // The next chunk where the file stands, with no search at all.
    assert.equal(fns.mmioDescend.handler([handle, chunk, parent, 0]), 0);
    assert.equal(memory.u32(chunk), fourcc('data'));
    assert.equal(fns.mmioRead.handler([handle, buffer, 8]), 4, 'short at the end of the file');
    assert.equal(fns.mmioRead.handler([handle, buffer, 8]), 0);

    assert.equal(fns.mmioClose.handler([handle, 0]), 0);
    assert.deepEqual(files.closed, ['C:\\click.wav']);
    assert.equal(fns.mmioClose.handler([handle, 0]), 5, 'MMSYSERR_INVALHANDLE');
});

test('a file that is not there, or a memory file, is refused in the caller\'s record', ()=>{
    const { memory, fns } = build();
    const info = memory.allocate(72);
    assert.equal(fns.mmioOpenA.handler([memory.put('C:\\none.wav'), info, MMIO_READ]), 0);
    assert.equal(memory.u32(info + 12), 257, 'MMIOERR_FILENOTFOUND');
    memory.setU32(info + 4, fourcc('MEM '));
    assert.equal(fns.mmioOpenA.handler([0, info, MMIO_READ]), 0);
    assert.equal(memory.u32(info + 12), 260, 'MMIOERR_CANNOTOPEN');
    assert.equal(fns.mmioOpenA.handler([memory.put('C:\\click.wav'), 0, 0x4000]), 1,
        'MMIO_EXIST only asks');
});

test('a chunk walk over bytes still on their way answers once they arrive', async()=>{
    const { memory, fns } = build({ late: true });
    const handle = fns.mmioOpenA.handler([memory.put('C:\\click.wav'), 0, MMIO_READ]);
    const parent = memory.allocate(20);
    memory.setU32(parent + 8, fourcc('WAVE'));
    assert.equal(await fns.mmioDescend.handler([handle, parent, 0, MMIO_FINDRIFF]), 0);
    const chunk = memory.allocate(20);
    memory.setU32(chunk, fourcc('data'));
    const search = fns.mmioDescend.handler([handle, chunk, parent, MMIO_FINDCHUNK]);
    assert.equal(typeof search.then, 'function');
    assert.equal(await search, 0);
    assert.equal(memory.u32(chunk + 12), 12 + 12 + (8 + 14) + 8,
        'past the padded fmt and the LIST, whose size counts its form type');
    assert.equal(fns.mmioSeek.handler([handle, 0, 1]), memory.u32(chunk + 12));
});

test('every entry pops what the guest pushed', ()=>{
    const { fns } = build();
    assert.deepEqual(
        ['mmioOpenA', 'mmioClose', 'mmioRead', 'mmioSeek', 'mmioDescend', 'mmioAscend']
            .map(name=>fns[name].argBytes),
        [12, 8, 12, 12, 16, 12]);
});
