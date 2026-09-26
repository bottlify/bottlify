/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMmioFunctions } from './mmio.js';
import { fakeVolume } from '../msvcrt/stdio.test.js';
import { fakeHandles, fakeMemory } from '../msvcrt/harness.test.js';

const MMIO_READ = 0;
const MMIO_WRITE = 1;
const MMIO_READWRITE = 2;
const MMIO_CREATE = 0x1000;
const MMIO_ALLOCBUF = 0x10000;
const MMIO_DIRTY = 0x10000000;
const MMIO_FINDCHUNK = 0x10;
const MMIO_FINDRIFF = 0x20;
const MMIO_FINDLIST = 0x40;
const MMIO_CREATERIFF = 0x20;
const MMIOERR_CHUNKNOTFOUND = 275;
const MMIOERR_UNBUFFERED = 266;
const MMIO_DEFAULTBUFFER = 8192;
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

/** MMIOINFO's fields, by offset. */
const INFO = Object.freeze({
    dwFlags: 0, fccIOProc: 4, pIOProc: 8, wErrorRet: 12, cchBuffer: 20, pchBuffer: 24,
    pchNext: 28, pchEndRead: 32, pchEndWrite: 36, lBufOffset: 40, lDiskOffset: 44,
    adwInfo: 48, hmmio: 68, size: 72,
});

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

/**
 * @param {{ late?: boolean, allocator?: boolean,
 *           call?: (entry: number, args: number[], thread?: unknown) => Promise<number> }}
 *        [options]  `call` runs the program's code, for its own I/O procedures.
 */
function build(options = {}){
    const memory = fakeMemory();
    const files = fakeVolume({ 'C:\\click.wav': waveFile() }, options);
    const handles = fakeHandles(files);
    /** @type {number[]} */
    const freed = [];
    /** @type {string[]} */
    const diverged = [];
    const fns = /** @type {any} */ (createMmioFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        files,
        handles,
        ...(options.call ? { call: options.call, callerThread: ()=>'the caller' } : {}),
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
        ...(options.allocator === false ? {} : {
            allocate: memory.allocate,
            free: (/** @type {number} */ address)=>{
                freed.push(address);
            },
        }),
    }));
    /** The fields of an MMIOINFO, read back. @param {number} at */
    const info = at=>Object.fromEntries(Object.entries(INFO)
        .filter(([name])=>name !== 'size')
        .map(([name, offset])=>[name, memory.u32(at + offset)]));
    return { memory, files, handles, fns, freed, diverged, info };
}

/**
 * The RIFF image mmio's own tests walk: an AVI whose header LIST holds an
 * avih chunk and a stream LIST, in 132 dwords.
 */
function riffImage(){
    /** @param {string} text */
    const code = text=>fourcc(text);
    const words = [
        code('RIFF'), 32 * 4, code('AVI '),
        code('LIST'), 29 * 4, code('hdrl'), code('avih'),
        56, ...new Array(14).fill(0xdeadbeef),
        code('LIST'), 10 * 4, code('strl'), code('strh'),
        7 * 4, code('vids'), ...new Array(6).fill(0xdeadbeef),
        ...new Array(96).fill(0),
    ];
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);
    words.forEach((word, index)=>view.setUint32(index * 4, word >>> 0, true));
    return bytes;
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

test('a file that is not there is refused in the caller\'s record', ()=>{
    const { memory, fns } = build();
    const info = memory.allocate(72);
    assert.equal(fns.mmioOpenA.handler([memory.put('C:\\none.wav'), info, MMIO_READ]), 0);
    assert.equal(memory.u32(info + 12), 257, 'MMIOERR_FILENOTFOUND');
    assert.equal(fns.mmioOpenA.handler([memory.put('C:\\click.wav'), 0, 0x4000]), 1,
        'MMIO_EXIST only asks');
});

test('a memory file is the caller\'s block, walked as a file is', ()=>{
    // mmio.c test_mmioDescend(NULL) and test_mmioOpen(NULL): FOURCC_MEM.
    const { memory, fns, info } = build();
    const image = riffImage();
    const block = memory.allocate(image.length);
    memory.writeMemory(block, image);
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.fccIOProc, fourcc('MEM '));
    memory.setU32(record + INFO.cchBuffer, image.length);
    memory.setU32(record + INFO.pchBuffer, block);
    const handle = fns.mmioOpenA.handler([0, record, MMIO_READ]);
    assert.notEqual(handle, 0);

    const got = memory.allocate(INFO.size);
    assert.equal(fns.mmioGetInfo.handler([handle, got, 0]), 0);
    assert.deepEqual(info(got), {
        dwFlags: MMIO_READ, fccIOProc: fourcc('MEM '), pIOProc: 0, wErrorRet: 0,
        cchBuffer: image.length, pchBuffer: block, pchNext: block,
        pchEndRead: block + image.length, pchEndWrite: block + image.length,
        lBufOffset: 0, lDiskOffset: 0, adwInfo: 0, hmmio: handle,
    }, 'the whole block is there to read');

    const riff = memory.allocate(20);
    assert.equal(fns.mmioDescend.handler([handle, riff, 0, 0]), 0);
    assert.deepEqual([memory.u32(riff), memory.u32(riff + 8), memory.u32(riff + 12)],
        [fourcc('RIFF'), fourcc('AVI '), 8]);
    assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_CUR]), 12);
    const list = memory.allocate(20);
    assert.equal(fns.mmioDescend.handler([handle, list, riff, 0]), 0);
    assert.deepEqual([memory.u32(list + 8), memory.u32(list + 12)], [fourcc('hdrl'), 20]);
    const chunk = memory.allocate(20);
    assert.equal(fns.mmioDescend.handler([handle, chunk, list, 0]), 0);
    assert.equal(memory.u32(chunk), fourcc('avih'));
    assert.equal(fns.mmioSeek.handler([handle, memory.u32(chunk + 4), SEEK_CUR]), 0x58);
    assert.equal(fns.mmioDescend.handler([handle, list, list, 0]), 0);
    assert.equal(memory.u32(list + 8), fourcc('strl'));
    assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_CUR]), 100);

    // A zero id or form type finds whatever comes first; a search that finds
    // nothing still leaves the last header it read in the record.
    fns.mmioSeek.handler([handle, 0, SEEK_SET]);
    memory.bytes.fill(0x66, chunk, chunk + 20);
    memory.setU32(chunk + 8, 0);
    assert.equal(fns.mmioDescend.handler([handle, chunk, 0, MMIO_FINDRIFF]), 0);
    assert.equal(memory.u32(chunk + 8), fourcc('AVI '));
    memory.bytes.fill(0x66, chunk, chunk + 20);
    fns.mmioSeek.handler([handle, 0, SEEK_SET]);
    assert.equal(fns.mmioDescend.handler([handle, chunk, 0, MMIO_FINDCHUNK]),
        MMIOERR_CHUNKNOTFOUND);
    assert.notEqual(memory.u32(chunk), 0x66666666);
    assert.notEqual(memory.u32(chunk + 12), 0x66666666);

    // The end of a memory file is the end of its block, and SEEK_END counts
    // its offset back from there.
    assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_END]), image.length);
    assert.equal(fns.mmioGetInfo.handler([handle, got, 0]), 0);
    assert.equal(memory.u32(got + INFO.pchNext), block + image.length);
    assert.equal(fns.mmioSeek.handler([handle, 16, SEEK_END]), image.length - 16);
    const into = memory.allocate(32);
    assert.equal(fns.mmioRead.handler([handle, into, 32]), 16, 'what is left of the block');
    assert.deepEqual([...memory.bytes.subarray(into, into + 16)],
        [...image.subarray(image.length - 16)]);
    assert.equal(fns.mmioClose.handler([handle, 0]), 0);
});

test('a buffer is the caller\'s, mmio\'s own, or none, and says which', ()=>{
    // mmio.c test_mmioOpen: the combinations of cchBuffer, pchBuffer and
    // MMIO_ALLOCBUF, for a file and for a memory file.
    for (const memoryFile of [false, true])
    {
        const { memory, fns, freed, info } = build();
        const theirs = memory.allocate(MMIO_DEFAULTBUFFER);
        const got = memory.allocate(INFO.size);
        /** @param {number} size @param {number} buffer @param {number} flags */
        const open = (size, buffer, flags)=>{
            const record = memory.allocate(INFO.size);
            memory.setU32(record + INFO.fccIOProc, fourcc(memoryFile ? 'MEM ' : 'DOS '));
            memory.setU32(record + INFO.cchBuffer, size);
            memory.setU32(record + INFO.pchBuffer, buffer);
            const handle = fns.mmioOpenA.handler(
                [memoryFile ? 0 : memory.put('C:\\click.wav'), record, flags]);
            assert.notEqual(handle, 0);
            assert.equal(fns.mmioGetInfo.handler([handle, got, 0]), 0);
            const answer = info(got);
            assert.equal(answer.pchNext, answer.pchBuffer);
            assert.equal(answer.pchEndRead,
                answer.pchBuffer + (memoryFile ? answer.cchBuffer : 0),
                'a file\'s buffer starts empty, a memory file\'s is the file');
            assert.equal(answer.pchEndWrite, answer.pchBuffer + answer.cchBuffer);
            assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_CUR]), 0);
            fns.mmioClose.handler([handle, 0]);
            return answer;
        };
        const label = memoryFile ? 'MEM' : 'DOS';

        let answer = open(256, theirs, MMIO_READ);
        assert.deepEqual([answer.dwFlags, answer.cchBuffer, answer.pchBuffer],
            [MMIO_READ, 256, theirs], `${label}: the caller's buffer`);
        answer = open(0, theirs, MMIO_READ);
        assert.deepEqual([answer.dwFlags, answer.cchBuffer, answer.pchBuffer],
            [MMIO_READ, 0, theirs], `${label}: no size is no buffer, the pointer kept`);
        answer = open(0, 0, MMIO_READ);
        assert.deepEqual([answer.dwFlags, answer.cchBuffer, answer.pchBuffer], [MMIO_READ, 0, 0]);
        answer = open(256, 0, MMIO_READ);
        assert.deepEqual([answer.dwFlags, answer.cchBuffer],
            [MMIO_READ | MMIO_ALLOCBUF, 256], `${label}: a size and no buffer is mmio's`);
        assert.notEqual(answer.pchBuffer, 0);
        assert.equal(freed.at(-1), answer.pchBuffer, 'and freed when the file closes');
        answer = open(256, theirs, MMIO_READ | MMIO_ALLOCBUF);
        assert.deepEqual([answer.dwFlags, answer.pchBuffer], [MMIO_READ, theirs],
            `${label}: asking for a buffer while giving one uses the one given`);
        answer = open(0, 0, MMIO_READ | MMIO_ALLOCBUF);
        assert.deepEqual([answer.dwFlags, answer.cchBuffer],
            [MMIO_READ | MMIO_ALLOCBUF, MMIO_DEFAULTBUFFER], `${label}: the default size`);
    }
});

test('a program reads a chunk straight out of the buffer, advancing at its end', async()=>{
    // The wave loader's loop: mmioGetInfo, take bytes at pchNext until it
    // meets pchEndRead, mmioAdvance for more, and mmioSetInfo when done. A
    // five-byte buffer makes it advance on almost every byte.
    for (const late of [false, true])
    {
        const { memory, fns, info } = build({ late });
        const record = memory.allocate(INFO.size);
        memory.setU32(record + INFO.cchBuffer, 5);
        const handle = fns.mmioOpenA.handler([memory.put('C:\\click.wav'), record, MMIO_READ]);
        const parent = memory.allocate(20);
        memory.setU32(parent + 8, fourcc('WAVE'));
        assert.equal(await fns.mmioDescend.handler([handle, parent, 0, MMIO_FINDRIFF]), 0);
        const chunk = memory.allocate(20);
        memory.setU32(chunk, fourcc('LIST'));
        assert.equal(await fns.mmioDescend.handler([handle, chunk, parent, MMIO_FINDCHUNK]), 0);
        assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_CUR]), 12 + 12 + 12,
            'past the LIST\'s form type, at its first chunk');

        const loop = memory.allocate(INFO.size);
        assert.equal(fns.mmioGetInfo.handler([handle, loop, 0]), 0);
        const taken = [];
        for (let count = 0; count < 10; count++)
        {
            if (memory.u32(loop + INFO.pchNext) === memory.u32(loop + INFO.pchEndRead))
            {
                assert.equal(await fns.mmioAdvance.handler([handle, loop, MMIO_READ]), 0);
                if (memory.u32(loop + INFO.pchNext) === memory.u32(loop + INFO.pchEndRead))
                {
                    break;
                }
            }
            const at = memory.u32(loop + INFO.pchNext);
            taken.push(memory.bytes[at]);
            memory.setU32(loop + INFO.pchNext, at + 1);
        }
        assert.equal(fns.mmioSetInfo.handler([handle, loop, 0]), 0);
        assert.deepEqual(taken,
            [...'ISFT'].map(c=>c.charCodeAt(0)).concat([2, 0, 0, 0, 0x41, 0x42]),
            `late: ${late}`);
        assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_CUR]), 36 + 10,
            'mmioSetInfo hands the position back');
        assert.equal(info(loop).lBufOffset, 41, 'the second bufferful');
        fns.mmioClose.handler([handle, 0]);
    }
});

test('a seek inside the buffer keeps it, one outside empties it', async()=>{
    // mmio.c test_mmio_buffer_pointer and test_mmio_end_of_file.
    const { memory, fns, files, info } = build();
    files.files['C:\\riff.avi'] = riffImage();
    const buffer = memory.allocate(5);
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.fccIOProc, fourcc('DOS '));
    memory.setU32(record + INFO.cchBuffer, 5);
    memory.setU32(record + INFO.pchBuffer, buffer);
    const handle = fns.mmioOpenA.handler([memory.put('C:\\riff.avi'), record, MMIO_READ]);
    const data = memory.allocate(16);
    const got = memory.allocate(INFO.size);

    assert.equal(fns.mmioRead.handler([handle, data, 0]), 0);
    assert.equal(fns.mmioGetInfo.handler([handle, got, 0]), 0);
    assert.equal(info(got).pchEndRead, buffer, 'nothing read yet');
    assert.equal(await fns.mmioAdvance.handler([handle, got, MMIO_READ]), 0);
    assert.equal(info(got).pchEndRead - buffer, 5, 'filled');

    assert.equal(fns.mmioSeek.handler([handle, 2, SEEK_SET]), 2);
    fns.mmioGetInfo.handler([handle, got, 0]);
    assert.deepEqual([info(got).lBufOffset, info(got).pchNext - buffer,
        info(got).pchEndRead - buffer], [0, 2, 5]);

    assert.equal(fns.mmioSeek.handler([handle, 17, SEEK_SET]), 17);
    fns.mmioGetInfo.handler([handle, got, 0]);
    assert.deepEqual([info(got).lBufOffset, info(got).pchNext, info(got).pchEndRead],
        [17, buffer, buffer]);

    assert.equal(await fns.mmioRead.handler([handle, data, 16]), 16, 'more than the buffer holds');
    fns.mmioGetInfo.handler([handle, got, 0]);
    assert.deepEqual([info(got).lBufOffset, info(got).pchNext, info(got).pchEndRead],
        [33, buffer, buffer], 'read around the buffer, which is left empty');

    const size = riffImage().length;
    assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_END]), size);
    fns.mmioGetInfo.handler([handle, got, 0]);
    assert.deepEqual([info(got).lBufOffset, info(got).lDiskOffset], [size, size]);
    assert.equal(fns.mmioRead.handler([handle, data, 16]), 0);
    assert.equal(await fns.mmioAdvance.handler([handle, got, MMIO_READ]), 0);
    assert.equal(info(got).pchNext, info(got).pchEndRead, 'at the end, an advance reads nothing');
    assert.equal(fns.mmioSeek.handler([handle, 16, SEEK_END]), size - 16);
    fns.mmioClose.handler([handle, 0]);

    // An unbuffered file has nothing to advance.
    const plain = fns.mmioOpenA.handler([memory.put('C:\\riff.avi'), 0, MMIO_READ]);
    fns.mmioGetInfo.handler([plain, got, 0]);
    assert.equal(fns.mmioAdvance.handler([plain, got, MMIO_READ]), MMIOERR_UNBUFFERED);
    assert.equal(fns.mmioSeek.handler([plain, 0, SEEK_END]), size);
    fns.mmioGetInfo.handler([plain, got, 0]);
    assert.deepEqual([info(got).lBufOffset, info(got).lDiskOffset], [size, size]);
});

test('a RIFF written through the buffer comes out with its sizes and its pad byte', ()=>{
    // mmio.c test_riff_write, byte for byte.
    const { memory, files, fns, info } = build();
    const handle = fns.mmioOpenA.handler([memory.put('C:\\test_write.wav'), 0,
        MMIO_ALLOCBUF | MMIO_CREATE | MMIO_READWRITE]);
    assert.notEqual(handle, 0);
    const riff = memory.allocate(20);
    memory.setU32(riff + 8, fourcc('WAVE'));
    assert.equal(fns.mmioCreateChunk.handler([handle, riff, MMIO_CREATERIFF]), 0);
    assert.deepEqual([memory.u32(riff), memory.u32(riff + 4), memory.u32(riff + 12),
        memory.u32(riff + 16)], [fourcc('RIFF'), 0, 8, MMIO_DIRTY]);
    const data = memory.allocate(20);
    memory.setU32(data, fourcc('data'));
    assert.equal(fns.mmioCreateChunk.handler([handle, data, 0]), 0);
    assert.deepEqual([memory.u32(data), memory.u32(data + 4), memory.u32(data + 12),
        memory.u32(data + 16)], [fourcc('data'), 0, 20, MMIO_DIRTY]);

    const source = memory.allocate(8);
    memory.bytes.fill(0xde, source, source + 8);
    assert.equal(fns.mmioWrite.handler([handle, source, 8]), 8);

    const loop = memory.allocate(INFO.size);
    assert.equal(fns.mmioGetInfo.handler([handle, loop, 0]), 0);
    /** @param {number} value @param {number} count */
    const fill = (value, count)=>{
        const at = memory.u32(loop + INFO.pchNext);
        memory.bytes.fill(value, at, at + count);
        memory.setU32(loop + INFO.pchNext, at + count);
    };
    fill(0xef, 8);
    assert.equal(fns.mmioAdvance.handler([handle, loop, MMIO_WRITE]), 0);
    assert.equal(info(loop).lBufOffset, 36);
    memory.setU32(loop + INFO.dwFlags, memory.u32(loop + INFO.dwFlags) | MMIO_DIRTY);
    fill(0xba, 8);
    assert.equal(fns.mmioAdvance.handler([handle, loop, MMIO_WRITE]), 0);
    assert.equal(info(loop).lBufOffset, 44);
    memory.setU32(loop + INFO.dwFlags, memory.u32(loop + INFO.dwFlags) | MMIO_DIRTY);
    fill(0xef, 3);
    assert.equal(fns.mmioSetInfo.handler([handle, loop, 0]), 0);

    assert.equal(fns.mmioAscend.handler([handle, data, 0]), 0);
    assert.equal(fns.mmioAscend.handler([handle, riff, 0]), 0);
    assert.equal(fns.mmioClose.handler([handle, 0]), 0);

    const expected = new Uint8Array(48);
    const view = new DataView(expected.buffer);
    [fourcc('RIFF'), 0x28, fourcc('WAVE'), fourcc('data'), 0x1b, 0xdededede, 0xdededede,
        0xefefefef, 0xefefefef, 0xbabababa, 0xbabababa, 0x00efefef]
        .forEach((word, index)=>view.setUint32(index * 4, word >>> 0, true));
    assert.deepEqual([...files.files['C:\\test_write.wav']], [...expected]);
});

test('a four-character code is spelled from up to four characters, padded with spaces', ()=>{
    const { memory, fns } = build();
    assert.equal(fns.mmioStringToFOURCCA.handler([memory.put('WAVE'), 0]), fourcc('WAVE'));
    assert.equal(fns.mmioStringToFOURCCA.handler([memory.put('xyz'), 0]), fourcc('xyz '));
    assert.equal(fns.mmioStringToFOURCCA.handler([memory.put('xyz'), 0x10]), fourcc('XYZ '),
        'MMIO_TOUPPER');
    assert.equal(fns.mmioStringToFOURCCA.handler([memory.put('abcdef'), 0]), fourcc('abcd'));
    assert.equal(fns.mmioStringToFOURCCA.handler([memory.put(''), 0]), fourcc('    '));
});

test('an installed I/O procedure is found by its code until it is removed', ()=>{
    const { fns, memory, diverged } = build();
    const MMIO_INSTALLPROC = 0x10000;
    const MMIO_REMOVEPROC = 0x20000;
    const MMIO_FINDPROC = 0x40000;
    const proc = 0x401000;
    assert.equal(fns.mmioInstallIOProcA.handler([fourcc('XYZ '), 0, MMIO_FINDPROC]), 0);
    assert.equal(fns.mmioInstallIOProcA.handler([fourcc('XYZ '), proc, MMIO_INSTALLPROC]), proc);
    assert.equal(fns.mmioInstallIOProcA.handler([fourcc('XYZ '), 0, MMIO_FINDPROC]), proc);

    // A file the procedure would read -- named by its code, or by the
    // extension of a compound name -- is refused rather than read as a plain
    // file: the program's own code would have to run for every read.
    const record = memory.allocate(INFO.size);
    const name = memory.put('file+name.xyz+one.two');
    assert.equal(fns.mmioOpenA.handler([name, record, MMIO_READ]), 0);
    assert.equal(memory.u32(record + INFO.wErrorRet), 260, 'MMIOERR_CANNOTOPEN');
    memory.setU32(record + INFO.fccIOProc, fourcc('XYZ '));
    assert.equal(fns.mmioOpenA.handler([memory.put('C:\\click.wav'), record, MMIO_READ]), 0);
    assert.equal(diverged.length, 2, 'and said so');

    assert.equal(fns.mmioInstallIOProcA.handler([fourcc('XYZ '), 0, MMIO_REMOVEPROC]), proc);
    memory.setU32(record + INFO.fccIOProc, 0);
    assert.equal(fns.mmioOpenA.handler([name, record, MMIO_READ]), 0);
    assert.equal(memory.u32(record + INFO.wErrorRet), 257,
        'removed, the name is a file name, and there is no such file');
    assert.equal(fns.mmioInstallIOProcA.handler([fourcc('XYZ '), 0, MMIO_FINDPROC]), 0);
    assert.equal(fns.mmioInstallIOProcA.handler([fourcc('XYZ '), 0, MMIO_REMOVEPROC]), 0,
        'nothing left to remove');
});

test('the wide open opens the same file by a UTF-16 name', ()=>{
    const { memory, fns } = build();
    const handle = fns.mmioOpenW.handler([memory.putWide('C:\\click.wav'), 0, MMIO_READ]);
    assert.notEqual(handle, 0);
    const into = memory.allocate(4);
    assert.equal(fns.mmioRead.handler([handle, into, 4]), 4);
    assert.equal(memory.u32(into), fourcc('RIFF'));
});

test('without memory to allocate, a buffer mmio would make is not made', ()=>{
    const { memory, fns, info } = build({ allocator: false });
    const handle = fns.mmioOpenA.handler([memory.put('C:\\click.wav'), 0,
        MMIO_READ | MMIO_ALLOCBUF]);
    assert.notEqual(handle, 0, 'the file still opens, unbuffered');
    const got = memory.allocate(INFO.size);
    fns.mmioGetInfo.handler([handle, got, 0]);
    assert.deepEqual([info(got).dwFlags, info(got).cchBuffer, info(got).pchBuffer],
        [MMIO_READ, 0, 0]);
    const into = memory.allocate(4);
    assert.equal(fns.mmioRead.handler([handle, into, 4]), 4);
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

test('mmioSetBuffer gives a file the caller\'s buffer, one of mmio\'s own, or none', ()=>{
    // mmio.c test_mmioSetBuffer, for a file and for a memory file: the new
    // buffer starts empty where the file stands, and only a size with no
    // pointer makes one.
    for (const memoryFile of [false, true])
    {
        const { memory, fns, freed, info } = build();
        const label = memoryFile ? 'MEM' : 'DOS';
        const theirs = memory.allocate(256);
        const record = memory.allocate(INFO.size);
        memory.setU32(record + INFO.fccIOProc, fourcc(memoryFile ? 'MEM ' : 'DOS '));
        memory.setU32(record + INFO.cchBuffer, 256);
        memory.setU32(record + INFO.pchBuffer, theirs);
        const handle = fns.mmioOpenA.handler(
            [memoryFile ? 0 : memory.put('C:\\click.wav'), record, MMIO_READ]);
        assert.notEqual(handle, 0);
        const got = memory.allocate(INFO.size);
        /** The buffer as mmioGetInfo reports it, its pointers relative to its start. */
        const state = ()=>{
            assert.equal(fns.mmioGetInfo.handler([handle, got, 0]), 0);
            assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_CUR]), 0);
            const answer = info(got);
            return {
                dwFlags: answer.dwFlags, cchBuffer: answer.cchBuffer,
                next: answer.pchNext - answer.pchBuffer,
                endRead: answer.pchEndRead - answer.pchBuffer,
                endWrite: answer.pchEndWrite - answer.pchBuffer,
                lBufOffset: answer.lBufOffset, lDiskOffset: answer.lDiskOffset,
            };
        };
        const empty = { next: 0, endRead: 0, lBufOffset: 0, lDiskOffset: 0 };
        assert.deepEqual(state(), { ...empty, dwFlags: MMIO_READ, cchBuffer: 256,
            endRead: memoryFile ? 256 : 0, endWrite: 256 }, `${label}: as opened`);

        assert.equal(fns.mmioSetBuffer.handler([handle, 0, 0, 0]), 0);
        assert.deepEqual(state(), { ...empty, dwFlags: MMIO_READ, cchBuffer: 0, endWrite: 0 },
            `${label}: unbuffered`);
        assert.equal(info(got).pchBuffer, 0);

        assert.equal(fns.mmioSetBuffer.handler([handle, 0, 0, MMIO_ALLOCBUF]), 0);
        assert.deepEqual(state(), { ...empty, dwFlags: MMIO_READ, cchBuffer: 0, endWrite: 0 },
            `${label}: no size is no buffer, whatever the flags say`);
        assert.equal(info(got).pchBuffer, 0);

        assert.equal(fns.mmioSetBuffer.handler([handle, theirs, 0, MMIO_ALLOCBUF]), 0);
        assert.deepEqual(state(), { ...empty, dwFlags: MMIO_READ, cchBuffer: 0, endWrite: 0 });
        assert.equal(info(got).pchBuffer, theirs, `${label}: a pointer with no size is kept`);

        assert.equal(fns.mmioSetBuffer.handler([handle, 0, 256, MMIO_WRITE | MMIO_ALLOCBUF]), 0);
        assert.deepEqual(state(), { ...empty, dwFlags: MMIO_READ | MMIO_ALLOCBUF, cchBuffer: 256,
            endWrite: 256 }, `${label}: a size and no pointer is mmio's own, and empty`);
        const own = info(got).pchBuffer;
        assert.ok(own !== 0 && own !== theirs);
        assert.equal(fns.mmioClose.handler([handle, 0]), 0);
        assert.equal(freed.at(-1), own, `${label}: and freed with the file`);
    }
});

test('a new buffer takes over where the file stands, and the old one is written first', ()=>{
    const { memory, files, fns, freed, info } = build();
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.cchBuffer, 16);
    const handle = fns.mmioOpenA.handler([memory.put('C:\\new.bin'), record,
        MMIO_CREATE | MMIO_READWRITE]);
    const got = memory.allocate(INFO.size);
    fns.mmioGetInfo.handler([handle, got, 0]);
    const old = info(got).pchBuffer;
    const source = memory.allocate(8);
    memory.writeMemory(source, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.equal(fns.mmioWrite.handler([handle, source, 6]), 6);
    assert.equal(files.files['C:\\new.bin'].length, 0, 'still in the buffer');

    const theirs = memory.allocate(4);
    assert.equal(fns.mmioSetBuffer.handler([handle, theirs, 4, 0]), 0);
    assert.deepEqual([...files.files['C:\\new.bin']], [1, 2, 3, 4, 5, 6]);
    assert.equal(freed.at(-1), old, 'the buffer mmio made is let go');
    fns.mmioGetInfo.handler([handle, got, 0]);
    assert.deepEqual([info(got).dwFlags, info(got).pchBuffer, info(got).lBufOffset],
        [MMIO_READWRITE, theirs, 6]);

    // Through the new buffer, from the start.
    assert.equal(fns.mmioSeek.handler([handle, 2, SEEK_SET]), 2);
    const into = memory.allocate(8);
    assert.equal(fns.mmioRead.handler([handle, into, 3]), 3);
    assert.deepEqual([...memory.bytes.subarray(into, into + 3)], [3, 4, 5]);
    assert.equal(fns.mmioSetBuffer.handler([0x1234, 0, 0, 0]), 5, 'MMSYSERR_INVALHANDLE');
    assert.equal(fns.mmioClose.handler([handle, 0]), 0);
});

test('mmioFlush writes what the buffer holds, and MMIO_EMPTYBUF starts it again', ()=>{
    const MMIO_EMPTYBUF = 0x10;
    const { memory, files, fns, info } = build();
    const handle = fns.mmioOpenA.handler([memory.put('C:\\new.bin'), 0,
        MMIO_CREATE | MMIO_READWRITE | MMIO_ALLOCBUF]);
    const source = memory.allocate(8);
    memory.writeMemory(source, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.equal(fns.mmioWrite.handler([handle, source, 4]), 4);
    assert.equal(files.files['C:\\new.bin'].length, 0);

    assert.equal(fns.mmioFlush.handler([handle, 0]), 0);
    assert.deepEqual([...files.files['C:\\new.bin']], [1, 2, 3, 4]);
    const got = memory.allocate(INFO.size);
    fns.mmioGetInfo.handler([handle, got, 0]);
    assert.deepEqual([info(got).dwFlags & MMIO_DIRTY, info(got).pchNext - info(got).pchBuffer,
        info(got).lBufOffset], [0, 4, 0], 'written, and still held');

    assert.equal(fns.mmioWrite.handler([handle, source + 4, 2]), 2);
    assert.equal(fns.mmioFlush.handler([handle, MMIO_EMPTYBUF]), 0);
    assert.deepEqual([...files.files['C:\\new.bin']], [1, 2, 3, 4, 5, 6]);
    fns.mmioGetInfo.handler([handle, got, 0]);
    assert.deepEqual([info(got).pchNext - info(got).pchBuffer,
        info(got).pchEndRead - info(got).pchBuffer, info(got).lBufOffset], [0, 0, 6],
    'emptied, where the file stands');
    assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_CUR]), 6);
    assert.equal(fns.mmioFlush.handler([0x1234, 0]), 5, 'MMSYSERR_INVALHANDLE');
    fns.mmioClose.handler([handle, 0]);

    // An unbuffered file and a memory file have nothing waiting.
    const plain = fns.mmioOpenA.handler([memory.put('C:\\click.wav'), 0, MMIO_READ]);
    assert.equal(fns.mmioFlush.handler([plain, 0]), 0);
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.fccIOProc, fourcc('MEM '));
    memory.setU32(record + INFO.cchBuffer, 16);
    memory.setU32(record + INFO.pchBuffer, memory.allocate(16));
    const block = fns.mmioOpenA.handler([0, record, MMIO_READWRITE]);
    assert.equal(fns.mmioFlush.handler([block, MMIO_EMPTYBUF]), 0);
    assert.equal(fns.mmioSeek.handler([block, 0, SEEK_END]), 16, 'the memory file is all there');
});

test('the wide four-character code and procedure calls are the ANSI ones', ()=>{
    const { memory, fns } = build();
    const MMIO_INSTALLPROC = 0x10000;
    const MMIO_REMOVEPROC = 0x20000;
    const MMIO_FINDPROC = 0x40000;
    assert.equal(fns.mmioStringToFOURCCW.handler([memory.putWide('wave'), 0]), fourcc('wave'));
    assert.equal(fns.mmioStringToFOURCCW.handler([memory.putWide('xyz'), 0x10]), fourcc('XYZ '),
        'MMIO_TOUPPER');
    assert.equal(fns.mmioStringToFOURCCW.handler([memory.putWide('abcdef'), 0]), fourcc('abcd'));

    const proc = 0x401000;
    assert.equal(fns.mmioInstallIOProcW.handler([fourcc('XYZ '), proc, MMIO_INSTALLPROC]), proc);
    assert.equal(fns.mmioInstallIOProcA.handler([fourcc('XYZ '), 0, MMIO_FINDPROC]), proc,
        'one table for both');
    assert.equal(fns.mmioInstallIOProcW.handler([fourcc('XYZ '), 0, MMIO_REMOVEPROC]), proc);
    assert.equal(fns.mmioInstallIOProcW.handler([fourcc('XYZ '), 0, MMIO_FINDPROC]), 0);
});

test('a file already open is read through its handle, from where the handle stands', async()=>{
    // mmio.c test_mmioSeek: OpenFile, _llseek to 16, and mmioOpen with no
    // name and the handle in adwInfo[0] stands at 16.
    const MMIO_DENYWRITE = 0x20;
    const MMIO_FHOPEN = 0x10;
    const { memory, files, handles, fns, info } = build();
    const image = riffImage();
    files.files['C:\\riff.avi'] = image;
    const hfile = handles.create('C:\\riff.avi', true, false);
    handles.file(hfile).position = 16;
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.fccIOProc, fourcc('DOS '));
    memory.setU32(record + INFO.adwInfo, hfile);
    const handle = fns.mmioOpenA.handler([0, record, MMIO_READ | MMIO_DENYWRITE | MMIO_ALLOCBUF]);
    assert.notEqual(handle, 0);
    assert.equal(memory.u32(record + INFO.wErrorRet), 0);
    assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_CUR]), 16);
    const into = memory.allocate(8);
    assert.equal(await fns.mmioRead.handler([handle, into, 8]), 8);
    assert.deepEqual([...memory.bytes.subarray(into, into + 8)], [...image.subarray(16, 24)]);
    assert.equal(fns.mmioSeek.handler([handle, 0, SEEK_END]), image.length);

    // MMIO_FHOPEN leaves the handle open, standing where mmio left the file.
    fns.mmioSeek.handler([handle, 40, SEEK_SET]);
    const got = memory.allocate(INFO.size);
    fns.mmioGetInfo.handler([handle, got, 0]);
    assert.equal(fns.mmioClose.handler([handle, MMIO_FHOPEN]), 0);
    assert.equal(handles.file(hfile)?.position, info(got).lDiskOffset);
    assert.deepEqual(files.closed, [], 'the file is still open');

    // With no procedure named at all the handle is still the file, and a
    // plain close closes the handle with it.
    memory.setU32(record + INFO.fccIOProc, 0);
    const again = fns.mmioOpenA.handler([0, record, MMIO_READ]);
    assert.notEqual(again, 0);
    assert.equal(fns.mmioSeek.handler([again, 0, SEEK_CUR]), info(got).lDiskOffset,
        'where the first left the handle');
    assert.equal(fns.mmioSeek.handler([again, 0, SEEK_SET]), 0);
    assert.equal(await fns.mmioRead.handler([again, into, 4]), 4);
    assert.equal(memory.u32(into), fourcc('RIFF'));
    assert.equal(fns.mmioClose.handler([again, 0]), 0);
    assert.equal(handles.file(hfile), null, 'the handle is closed');
    assert.deepEqual(files.closed, ['C:\\riff.avi']);

    assert.equal(fns.mmioOpenA.handler([0, record, MMIO_READ]), 0, 'a handle no longer open');
    assert.equal(memory.u32(record + INFO.wErrorRet), 257, 'MMIOERR_FILENOTFOUND');
});

const MMIOM_READ = 0;
const MMIOM_WRITE = 1;
const MMIOM_SEEK = 2;
const MMIOM_OPEN = 3;
const MMIOM_CLOSE = 4;
const MMIOM_WRITEFLUSH = 5;
const MMIOM_RENAME = 6;
const MMIOM_USER = 0x8000;
const MMIO_INSTALLPROC = 0x10000;
const MMIO_REMOVEPROC = 0x20000;
const PROCEDURE = 0x401000;

/**
 * A program's own I/O procedure over a byte array, run where the program's
 * code would run: it keeps its position in lDiskOffset of the MMIOINFO it is
 * handed, counts the seeks it is sent in adwInfo[1] as mmio's own test
 * procedure does, and answers each message as documented.
 *
 * @param {ReturnType<typeof fakeMemory>} memory @param {Uint8Array} image
 */
function procedureOver(memory, image){
    const state = {
        image,
        /** @type {{ message: number, first: number, second: number, thread: unknown }[]} */
        calls: [],
        /** What MMIOM_OPEN was handed. @type {any} */
        opened: null,
        /** What MMIOM_OPEN and MMIOM_RENAME answer. */
        refuse: 0,
        /** What MMIOM_RENAME was handed. @type {any} */
        renamed: null,
    };
    /**
     * @param {number} entry @param {number[]} args @param {unknown} [thread]
     * @returns {Promise<number>}
     */
    const call = async(entry, [record, message, first, second], thread)=>{
        assert.equal(entry, PROCEDURE);
        state.calls.push({ message, first, second, thread });
        const disk = memory.i32(record + INFO.lDiskOffset);
        switch (message)
        {
            case MMIOM_OPEN:
                state.opened = {
                    record, name: first, flags: memory.u32(record + INFO.dwFlags),
                    fcc: memory.u32(record + INFO.fccIOProc),
                    adwInfo: [0, 1, 2].map(index=>memory.u32(record + INFO.adwInfo + index * 4)),
                    lDiskOffset: disk,
                };
                return state.refuse;
            case MMIOM_READ: {
                const bytes = state.image.slice(disk, disk + second);
                memory.writeMemory(first, bytes);
                memory.setU32(record + INFO.lDiskOffset, disk + bytes.length);
                return bytes.length;
            }
            case MMIOM_WRITE:
            case MMIOM_WRITEFLUSH: {
                const grown = new Uint8Array(Math.max(state.image.length, disk + second));
                grown.set(state.image);
                grown.set(memory.bytes.subarray(first, first + second), disk);
                state.image = grown;
                memory.setU32(record + INFO.lDiskOffset, disk + second);
                return second;
            }
            case MMIOM_SEEK: {
                const to = second === SEEK_SET ? first | 0
                    : second === SEEK_CUR ? disk + (first | 0) : state.image.length + (first | 0);
                memory.setU32(record + INFO.adwInfo + 4, memory.u32(record + INFO.adwInfo + 4) + 1);
                if (to < 0)
                {
                    return -1;
                }
                memory.setU32(record + INFO.lDiskOffset, to);
                return to;
            }
            case MMIOM_RENAME:
                state.renamed = { record, from: first, to: second,
                    fcc: memory.u32(record + INFO.fccIOProc) };
                return state.refuse;
            case MMIOM_USER:
                return first + second;
            default:
                return 0;
        }
    };
    return { state, call };
}

/**
 * A build whose program has an I/O procedure over `image`.
 *
 * @param {Uint8Array} image
 */
function withProcedure(image){
    /** @type {(entry: number, args: number[], thread?: unknown) => Promise<number>} */
    let call = ()=>Promise.resolve(0);
    const built = build({ call: (entry, args, thread)=>call(entry, args, thread) });
    const procedure = procedureOver(built.memory, image);
    call = procedure.call;
    return { ...built, state: procedure.state };
}

test('a compound name opens through the procedure its extension names', async()=>{
    // mmio.c test_mmioOpen_fourcc: with XYZ installed, file+name.xyz+one.two
    // opens through it, whose MMIOM_OPEN sees a zero adwInfo, and no seek
    // is sent on the way; mmioGetInfo names the procedure. Removed, the name
    // is only a file name, and no such file is there.
    const { memory, fns, freed, info, state } = withProcedure(riffImage());
    assert.equal(fns.mmioInstallIOProcA.handler([fourcc('XYZ '), PROCEDURE, MMIO_INSTALLPROC]),
        PROCEDURE);
    const name = memory.put('file+name.xyz+one.two');
    const got = memory.allocate(INFO.size);
    for (const withRecord of [true, false])
    {
        state.calls.length = 0;
        const record = withRecord ? memory.allocate(INFO.size) : 0;
        const handle = await fns.mmioOpenA.handler([name, record, MMIO_READ]);
        assert.notEqual(handle, 0);
        assert.deepEqual(state.calls.map(call=>call.message), [MMIOM_OPEN], 'and nothing else');
        assert.equal(state.calls[0].thread, 'the caller');
        assert.equal(memory.text(state.opened.name), 'file+name.xyz+one.two');
        assert.deepEqual([state.opened.flags, state.opened.fcc, state.opened.adwInfo,
            state.opened.lDiskOffset], [MMIO_READ, fourcc('XYZ '), [0, 0, 0], 0]);

        assert.equal(fns.mmioGetInfo.handler([handle, got, 0]), 0);
        assert.deepEqual([info(got).fccIOProc, info(got).pIOProc,
            memory.u32(got + INFO.adwInfo + 4), info(got).lDiskOffset],
        [fourcc('XYZ '), PROCEDURE, 0, 0]);
        assert.equal(await fns.mmioClose.handler([handle, 0]), 0);
        assert.deepEqual(state.calls.map(call=>call.message), [MMIOM_OPEN, MMIOM_CLOSE]);
        assert.ok(freed.includes(state.opened.record), 'the procedure\'s MMIOINFO is let go');
    }

    fns.mmioInstallIOProcA.handler([fourcc('XYZ '), 0, MMIO_REMOVEPROC]);
    const record = memory.allocate(INFO.size);
    assert.equal(await fns.mmioOpenA.handler([name, record, MMIO_READ]), 0);
    assert.equal(memory.u32(record + INFO.wErrorRet), 257, 'MMIOERR_FILENOTFOUND');
});

test('a code and a procedure\'s name are the ANSI page\'s bytes', async()=>{
    // 0x80 is the euro sign in Windows-1252, 0x99 the trade mark and 0x97 an
    // em dash, as the ANSI calls read those bytes: a code spelled with them
    // is those bytes, a wide one is narrowed into the page, and an ANSI
    // procedure is handed a name in the bytes the program gave it.
    const { memory, fns, state } = withProcedure(riffImage());
    /** @param {number[]} bytes */
    const place = bytes=>{
        const at = memory.allocate(bytes.length + 1);
        memory.writeMemory(at, Uint8Array.from([...bytes, 0]));
        return at;
    };
    assert.equal(fns.mmioStringToFOURCCA.handler([place([0x80, 0x99, 0x97, 0xe9]), 0]),
        0xe9979980);
    assert.equal(fns.mmioStringToFOURCCW.handler(
        [memory.putWide('€™—Ж'), 0]), 0x3f979980);

    fns.mmioInstallIOProcA.handler([fourcc('XYZ '), PROCEDURE, MMIO_INSTALLPROC]);
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.fccIOProc, fourcc('XYZ '));
    assert.notEqual(await fns.mmioOpenA.handler([place([0x43, 0x3a, 0x5c, 0x80, 0x99]), record,
        MMIO_READ]), 0);
    assert.deepEqual([...memory.bytes.subarray(state.opened.name, state.opened.name + 6)],
        [0x43, 0x3a, 0x5c, 0x80, 0x99, 0]);
});

test('a file the program\'s procedure holds is walked and read as any file is', async()=>{
    // The memory-file walk of mmio.c's tests, through a procedure named in the
    // MMIOINFO by its code: every byte comes by MMIOM_READ, into the buffer
    // or around it, with a seek first wherever the procedure is not standing.
    for (const bufferSize of [16, 0])
    {
        const image = riffImage();
        const { memory, fns, state } = withProcedure(image);
        fns.mmioInstallIOProcA.handler([fourcc('XYZ '), PROCEDURE, MMIO_INSTALLPROC]);
        const record = memory.allocate(INFO.size);
        memory.setU32(record + INFO.fccIOProc, fourcc('XYZ '));
        memory.setU32(record + INFO.cchBuffer, bufferSize);
        const handle = await fns.mmioOpenA.handler(
            [memory.put('C:\\movie.xyz'), record, MMIO_READ]);
        assert.notEqual(handle, 0);

        const riff = memory.allocate(20);
        assert.equal(await fns.mmioDescend.handler([handle, riff, 0, 0]), 0);
        assert.deepEqual([memory.u32(riff), memory.u32(riff + 8)],
            [fourcc('RIFF'), fourcc('AVI ')]);
        const list = memory.allocate(20);
        assert.equal(await fns.mmioDescend.handler([handle, list, riff, 0]), 0);
        const chunk = memory.allocate(20);
        assert.equal(await fns.mmioDescend.handler([handle, chunk, list, 0]), 0);
        assert.equal(memory.u32(chunk), fourcc('avih'));
        const into = memory.allocate(64);
        assert.equal(await fns.mmioRead.handler([handle, into, 8]), 8);
        assert.deepEqual([...memory.bytes.subarray(into, into + 8)], [...image.subarray(32, 40)]);
        assert.equal(await fns.mmioAscend.handler([handle, chunk, 0]), 0);
        assert.equal(await fns.mmioDescend.handler([handle, list, list, 0]), 0);
        assert.equal(memory.u32(list + 8), fourcc('strl'));
        assert.equal(await fns.mmioSeek.handler([handle, 0, SEEK_CUR]), 100);

        assert.equal(await fns.mmioSeek.handler([handle, 16, SEEK_END]), image.length - 16);
        assert.equal(await fns.mmioRead.handler([handle, into, 64]), 16);
        assert.deepEqual([...memory.bytes.subarray(into, into + 16)],
            [...image.subarray(image.length - 16)]);
        assert.equal(await fns.mmioRead.handler([handle, into, 64]), 0, 'at the end');

        const messages = state.calls.map(call=>call.message);
        assert.ok(messages.includes(MMIOM_READ) && messages.includes(MMIOM_SEEK),
            `size ${bufferSize}: read and seek through the procedure`);
        assert.ok(state.calls.every(call=>call.thread === 'the caller'),
            'each on the thread whose call it answers');
        assert.equal(await fns.mmioClose.handler([handle, 0]), 0);
        assert.equal(messages.indexOf(MMIOM_CLOSE), -1);
        assert.equal(state.calls.at(-1)?.message, MMIOM_CLOSE);
    }
});

test('a RIFF written through the program\'s procedure reaches it with its sizes', async()=>{
    // mmio.c test_riff_write again, through a procedure handed in pIOProc
    // and installed nowhere: the buffer goes out by MMIOM_WRITE as it moves
    // on, and mmioAscend goes back to fix the sizes.
    const { memory, fns, info, state } = withProcedure(new Uint8Array(0));
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.pIOProc, PROCEDURE);
    const handle = await fns.mmioOpenA.handler([memory.put('test_write.wav'), record,
        MMIO_ALLOCBUF | MMIO_CREATE | MMIO_READWRITE]);
    assert.notEqual(handle, 0);
    assert.equal(state.opened.flags, MMIO_ALLOCBUF | MMIO_CREATE | MMIO_READWRITE,
        'the procedure sees the flags mmioOpen was given');
    const riff = memory.allocate(20);
    memory.setU32(riff + 8, fourcc('WAVE'));
    assert.equal(await fns.mmioCreateChunk.handler([handle, riff, MMIO_CREATERIFF]), 0);
    const data = memory.allocate(20);
    memory.setU32(data, fourcc('data'));
    assert.equal(await fns.mmioCreateChunk.handler([handle, data, 0]), 0);
    const source = memory.allocate(8);
    memory.bytes.fill(0xde, source, source + 8);
    assert.equal(await fns.mmioWrite.handler([handle, source, 8]), 8);

    const loop = memory.allocate(INFO.size);
    assert.equal(fns.mmioGetInfo.handler([handle, loop, 0]), 0);
    /** @param {number} value @param {number} count */
    const fill = (value, count)=>{
        const at = memory.u32(loop + INFO.pchNext);
        memory.bytes.fill(value, at, at + count);
        memory.setU32(loop + INFO.pchNext, at + count);
    };
    fill(0xef, 8);
    assert.equal(await fns.mmioAdvance.handler([handle, loop, MMIO_WRITE]), 0);
    assert.equal(info(loop).lBufOffset, 36);
    memory.setU32(loop + INFO.dwFlags, memory.u32(loop + INFO.dwFlags) | MMIO_DIRTY);
    fill(0xba, 8);
    assert.equal(await fns.mmioAdvance.handler([handle, loop, MMIO_WRITE]), 0);
    memory.setU32(loop + INFO.dwFlags, memory.u32(loop + INFO.dwFlags) | MMIO_DIRTY);
    fill(0xef, 3);
    assert.equal(fns.mmioSetInfo.handler([handle, loop, 0]), 0);
    assert.equal(await fns.mmioAscend.handler([handle, data, 0]), 0);
    assert.equal(await fns.mmioAscend.handler([handle, riff, 0]), 0);
    assert.equal(await fns.mmioClose.handler([handle, 0]), 0);

    const expected = new Uint8Array(48);
    const view = new DataView(expected.buffer);
    [fourcc('RIFF'), 0x28, fourcc('WAVE'), fourcc('data'), 0x1b, 0xdededede, 0xdededede,
        0xefefefef, 0xefefefef, 0xbabababa, 0xbabababa, 0x00efefef]
        .forEach((word, index)=>view.setUint32(index * 4, word >>> 0, true));
    assert.deepEqual([...state.image], [...expected]);
    const messages = state.calls.map(call=>call.message);
    assert.ok(messages.includes(MMIOM_WRITE) && messages.includes(MMIOM_SEEK));
    assert.equal(messages.at(-1), MMIOM_CLOSE);
});

test('mmioFlush, and a close with bytes still in the buffer, send MMIOM_WRITEFLUSH', async()=>{
    const { memory, fns, state } = withProcedure(new Uint8Array(0));
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.pIOProc, PROCEDURE);
    const handle = await fns.mmioOpenA.handler([memory.put('out.bin'), record,
        MMIO_ALLOCBUF | MMIO_CREATE | MMIO_WRITE]);
    const source = memory.allocate(8);
    memory.writeMemory(source, Uint8Array.from([1, 2, 3, 4, 5, 6]));
    assert.equal(await fns.mmioWrite.handler([handle, source, 4]), 4);
    assert.equal(state.image.length, 0, 'still in the buffer');
    assert.equal(await fns.mmioFlush.handler([handle, 0]), 0);
    assert.equal(state.calls.at(-1)?.message, MMIOM_WRITEFLUSH);
    assert.deepEqual([...state.image], [1, 2, 3, 4]);
    assert.equal(await fns.mmioWrite.handler([handle, source + 4, 2]), 2);
    assert.equal(await fns.mmioClose.handler([handle, 0x10]), 0);
    assert.deepEqual(state.calls.slice(-2).map(call=>call.message),
        [MMIOM_WRITEFLUSH, MMIOM_CLOSE]);
    assert.equal(state.calls.at(-1)?.first, 0x10, 'MMIOM_CLOSE carries mmioClose\'s flags');
    assert.deepEqual([...state.image], [1, 2, 3, 4, 5, 6]);
});

test('a procedure that refuses the open leaves nothing open, and a wide one gets UTF-16', async()=>{
    const { memory, fns, freed, state } = withProcedure(riffImage());
    const MMIOERR_CANNOTOPEN = 260;
    fns.mmioInstallIOProcW.handler([fourcc('XYZ '), PROCEDURE, MMIO_INSTALLPROC]);
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.fccIOProc, fourcc('XYZ '));
    state.refuse = MMIOERR_CANNOTOPEN;
    assert.equal(await fns.mmioOpenA.handler([memory.put('movie.xyz'), record, MMIO_READ]), 0);
    assert.equal(memory.u32(record + INFO.wErrorRet), MMIOERR_CANNOTOPEN, 'its answer, passed on');
    assert.equal(memory.wide(state.opened.name), 'movie.xyz',
        'installed by the wide call, it is handed a UTF-16 name');
    assert.ok(freed.includes(state.opened.record));

    state.refuse = 0;
    const handle = await fns.mmioOpenA.handler([memory.put('movie.xyz'), record, MMIO_READ]);
    assert.notEqual(handle, 0);
    assert.equal(memory.u32(record + INFO.wErrorRet), 0);
    assert.equal(await fns.mmioClose.handler([handle, 0]), 0);
});

test('mmioSendMessage reaches the program\'s procedure, and a built-in one knows none', async()=>{
    // A message of the program's own, MMIOM_USER and up, is answered by its
    // procedure; the built-in procedures recognise none, and answer zero.
    const { memory, fns, state, diverged } = withProcedure(riffImage());
    fns.mmioInstallIOProcA.handler([fourcc('XYZ '), PROCEDURE, MMIO_INSTALLPROC]);
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.fccIOProc, fourcc('XYZ '));
    const handle = await fns.mmioOpenA.handler([memory.put('movie.xyz'), record, MMIO_READ]);
    assert.equal(await fns.mmioSendMessage.handler([handle, MMIOM_USER, 2, 3]), 5);
    assert.deepEqual([state.calls.at(-1)?.message, state.calls.at(-1)?.thread],
        [MMIOM_USER, 'the caller']);

    const plain = fns.mmioOpenA.handler([memory.put('C:\\click.wav'), 0, MMIO_READ]);
    assert.equal(fns.mmioSendMessage.handler([plain, MMIOM_USER, 2, 3]), 0);
    assert.equal(diverged.length, 0);
    assert.equal(fns.mmioSendMessage.handler([plain, MMIOM_SEEK, 0, SEEK_END]), 0);
    assert.equal(diverged.length, 1, 'one of mmio\'s own messages, which is not to be sent so');
    assert.equal(fns.mmioSeek.handler([plain, 0, SEEK_CUR]), 0, 'and nothing moved');
    assert.equal(fns.mmioSendMessage.handler([0x1234, MMIOM_USER, 0, 0]), 5,
        'MMSYSERR_INVALHANDLE');
});

test('mmioRename renames a file on the volume, or asks the program\'s procedure to', async()=>{
    const MMIOERR_FILENOTFOUND = 257;
    const { memory, files, fns, state, freed } = withProcedure(riffImage());
    /** @type {any} */ (files).rename = (/** @type {string} */ from, /** @type {string} */ to)=>{
        if (!files.files[from] || files.files[to])
        {
            return false;
        }
        files.files[to] = files.files[from];
        delete files.files[from];
        return true;
    };
    const wave = files.files['C:\\click.wav'];
    assert.equal(fns.mmioRenameA.handler(
        [memory.put('C:\\click.wav'), memory.put('C:\\clack.wav'), 0, 0]), 0);
    assert.equal(files.files['C:\\clack.wav'], wave);
    assert.equal(files.files['C:\\click.wav'], undefined);
    assert.equal(fns.mmioRenameW.handler(
        [memory.putWide('C:\\clack.wav'), memory.putWide('C:\\click.wav'), 0, 0]), 0);
    assert.equal(files.files['C:\\click.wav'], wave, 'the wide call by UTF-16 names');
    assert.equal(fns.mmioRenameA.handler(
        [memory.put('C:\\none.wav'), memory.put('C:\\some.wav'), 0, 0]), MMIOERR_FILENOTFOUND);
    files.files['C:\\other.wav'] = new Uint8Array(4);
    assert.notEqual(fns.mmioRenameA.handler(
        [memory.put('C:\\click.wav'), memory.put('C:\\other.wav'), 0, 0]), 0,
    'a name already taken is refused');
    assert.equal(files.files['C:\\click.wav'], wave);

    // A compound name's procedure is sent MMIOM_RENAME with both names, in
    // an MMIOINFO of its own, and answers for the rename.
    fns.mmioInstallIOProcA.handler([fourcc('XYZ '), PROCEDURE, MMIO_INSTALLPROC]);
    assert.equal(await fns.mmioRenameA.handler(
        [memory.put('pack.xyz+one'), memory.put('pack.xyz+two'), 0, 0]), 0);
    assert.deepEqual([memory.text(state.renamed.from), memory.text(state.renamed.to),
        state.renamed.fcc], ['pack.xyz+one', 'pack.xyz+two', fourcc('XYZ ')]);
    assert.equal(state.calls.at(-1)?.thread, 'the caller');
    assert.ok(freed.includes(state.renamed.record), 'the MMIOINFO is let go');
    state.refuse = MMIOERR_FILENOTFOUND;
    const record = memory.allocate(INFO.size);
    memory.setU32(record + INFO.pIOProc, PROCEDURE);
    assert.equal(await fns.mmioRenameA.handler(
        [memory.put('a'), memory.put('b'), record, 0]), MMIOERR_FILENOTFOUND,
    'one handed in the MMIOINFO, whose answer is passed on');
});

test('every entry pops what the guest pushed', ()=>{
    const { fns } = build();
    assert.deepEqual(
        ['mmioOpenA', 'mmioOpenW', 'mmioClose', 'mmioRead', 'mmioWrite', 'mmioSeek',
            'mmioDescend', 'mmioAscend', 'mmioCreateChunk', 'mmioGetInfo', 'mmioSetInfo',
            'mmioAdvance', 'mmioStringToFOURCCA', 'mmioInstallIOProcA', 'mmioSetBuffer',
            'mmioFlush', 'mmioStringToFOURCCW', 'mmioInstallIOProcW', 'mmioSendMessage',
            'mmioRenameA', 'mmioRenameW']
            .map(name=>fns[name].argBytes),
        [12, 12, 8, 12, 12, 12, 16, 12, 12, 12, 12, 12, 8, 12, 16, 8, 8, 12, 16, 16, 16]);
});
