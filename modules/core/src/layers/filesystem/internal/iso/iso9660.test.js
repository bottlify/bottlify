/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIso } from './build.js';
import { discSerial, isIsoImage, openIso, rangesOf, recordingTime, SECTOR_SIZE }
    from './iso9660.js';
import { chunkedReads, createIsoSource } from './source.js';

/** @param {number} length @param {number} [seed] */
const pattern = (length, seed = 1)=>Uint8Array.from({ length }, (_, at)=>(at * 31 + seed) & 0xff);

/**
 * A reader over bytes that counts what it was asked for, synchronous or not.
 * Typed as the synchronous one; the tests that ask for the other await it.
 *
 * @param {Uint8Array} image @param {boolean} [later]
 * @returns {{ read: (offset: number, length: number) => Uint8Array,
 *     asked: { offset: number, length: number }[] }}
 */
const counted = (image, later = false)=>{
    /** @type {{ offset: number, length: number }[]} */
    const asked = [];
    /** @param {number} offset @param {number} length */
    const read = (offset, length)=>{
        asked.push({ offset, length });
        const bytes = image.slice(offset, offset + length);
        return later ? /** @type {any} */ (Promise.resolve(bytes)) : bytes;
    };
    return { read, asked };
};

const DISC = {
    'AUTORUN.INF': '[autorun]\r\nopen=Setup.exe\r\n',
    'Setup.exe': pattern(5000),
    'Data/A Long Name For A Cabinet.cab': pattern(3 * SECTOR_SIZE + 7, 3),
    'Data/readme.': 'hello',
    'Empty': null,
};

test('the Joliet tree is the one read, with its names as the files carry them', async()=>{
    const iso = await openIso(counted(buildIso({ files: DISC, label: 'NFSDEMO' })).read);
    assert.equal(iso.volume.joliet, true);
    assert.equal(iso.volume.label, 'NFSDEMO');
    assert.equal(iso.volume.blockSize, SECTOR_SIZE);
    assert.deepEqual(iso.entries.map(entry=>entry.path).sort(), [
        'AUTORUN.INF', 'Data', 'Data\\A Long Name For A Cabinet.cab', 'Data\\readme', 'Empty',
        'Setup.exe',
    ]);
    const cabinet = iso.find('data/a long name for a cabinet.CAB');
    assert.ok(cabinet);
    assert.equal(cabinet.size, 3 * SECTOR_SIZE + 7);
    assert.equal(iso.find('Empty')?.directory, true);
    assert.equal(iso.find('nothing'), null);
});

test('without Joliet the primary tree names the files, version and bare dot dropped', async()=>{
    const iso = await openIso(counted(buildIso({ files: DISC, joliet: false })).read);
    assert.equal(iso.volume.joliet, false);
    const names = iso.entries.map(entry=>entry.path).sort();
    assert.ok(names.includes('SETUP.EXE'), names.join(', '));
    assert.ok(names.includes('DATA\\README'), names.join(', '));
    assert.ok(names.every(name=>!name.includes(';')));
    assert.deepEqual(iso.read(/** @type {any} */ (iso.find('setup.exe')), 0, 5000),
        DISC['Setup.exe']);
});

test('a file reads back byte for byte, whole and in pieces, from both kinds of reader', async()=>{
    const image = buildIso({ files: DISC });
    const expected = /** @type {Uint8Array} */ (DISC['Data/A Long Name For A Cabinet.cab']);
    for (const later of [false, true])
    {
        const iso = await openIso(counted(image, later).read);
        const entry = /** @type {any} */ (iso.find('Data\\A Long Name For A Cabinet.cab'));
        const whole = iso.read(entry, 0, entry.size);
        assert.equal(whole instanceof Promise, later);
        assert.deepEqual(await whole, expected);
        assert.deepEqual(await iso.read(entry, 2040, 20), expected.subarray(2040, 2060));
        // Past the end is a short read, not a failure.
        assert.deepEqual(await iso.read(entry, entry.size - 3, 100), expected.subarray(-3));
        assert.equal((await iso.read(entry, entry.size + 5, 10)).length, 0);
    }
});

test('opening reads the descriptors and the directories, and no file', async()=>{
    const big = pattern(40 * SECTOR_SIZE);
    const reader = counted(buildIso({ files: { 'big.bin': big, 'Sub/x.txt': 'x' } }));
    const iso = await openIso(reader.read);
    const touched = reader.asked.reduce((sum, range)=>sum + range.length, 0);
    assert.ok(touched < 10 * SECTOR_SIZE, `${touched} bytes read to open`);
    reader.asked.length = 0;
    const entry = /** @type {any} */ (iso.find('big.bin'));
    iso.read(entry, 10 * SECTOR_SIZE, 100);
    assert.deepEqual(reader.asked,
        [{ offset: entry.extents[0].at + 10 * SECTOR_SIZE, length: 100 }]);
});

test('a file recorded as several extents reads as one', async()=>{
    const bytes = pattern(5 * SECTOR_SIZE + 100, 9);
    const iso = await openIso(counted(buildIso({
        files: { 'huge.dat': bytes, 'after.txt': 'after' },
        split: { 'huge.dat': 2 * SECTOR_SIZE },
    })).read);
    const entry = /** @type {any} */ (iso.find('huge.dat'));
    assert.equal(entry.extents.length, 3);
    assert.equal(entry.size, bytes.length);
    assert.deepEqual(iso.read(entry, 0, bytes.length), bytes);
    // Across the boundary between two extents, which are not adjacent.
    assert.deepEqual(iso.read(entry, 2 * SECTOR_SIZE - 10, 20),
        bytes.subarray(2 * SECTOR_SIZE - 10, 2 * SECTOR_SIZE + 10));
    assert.equal(iso.entries.filter(item=>item.name === 'huge.dat').length, 1);
    assert.deepEqual(iso.read(/** @type {any} */ (iso.find('after.txt')), 0, 5),
        Uint8Array.from('after', character=>character.charCodeAt(0)));
});

test('an interleaved file is read unit by unit, the gaps skipped', async()=>{
    const bytes = pattern(7 * SECTOR_SIZE + 5, 17);
    const iso = await openIso(counted(buildIso({
        files: { 'woven.bin': bytes },
        interleave: { 'woven.bin': { unit: 2, gap: 1 } },
    })).read);
    const entry = /** @type {any} */ (iso.find('woven.bin'));
    assert.deepEqual(iso.read(entry, 0, bytes.length), bytes);
    assert.deepEqual(iso.read(entry, 2 * SECTOR_SIZE - 1, 3),
        bytes.subarray(2 * SECTOR_SIZE - 1, 2 * SECTOR_SIZE + 2));
});

test('ranges of a plain extent merge; an interleaved one splits at its units', ()=>{
    const plain = { path: 'a', name: 'a', directory: false, size: 10000, modified: null,
        hidden: false, extents: [{ at: 8192, length: 10000, unit: 0, gap: 0 }] };
    assert.deepEqual(rangesOf(plain, 100, 5000, 2048), [{ at: 8292, length: 5000 }]);
    const woven = { ...plain, extents: [{ at: 0, length: 10000, unit: 1, gap: 2 }] };
    assert.deepEqual(rangesOf(woven, 2000, 100, 2048), [
        { at: 2000, length: 48 },
        { at: 3 * 2048, length: 52 },
    ]);
});

test('the existence bit is the hidden attribute, and the recording time is kept in UTC', async()=>{
    const iso = await openIso(counted(buildIso({
        files: { 'secret.dat': 's', 'plain.dat': 'p' },
        hidden: ['secret.dat'],
        // 2001-02-03 04:05:06 at UTC+1 (four quarter hours east).
        time: [101, 2, 3, 4, 5, 6, 4],
    })).read);
    assert.equal(iso.find('secret.dat')?.hidden, true);
    assert.equal(iso.find('plain.dat')?.hidden, false);
    assert.equal(iso.find('plain.dat')?.modified, Date.UTC(2001, 1, 3, 3, 5, 6));
    assert.equal(recordingTime(new Uint8Array(7), 0), null);
});

test('the serial number sums the descriptor four ways, the first byte highest', ()=>{
    const descriptor = new Uint8Array(SECTOR_SIZE);
    descriptor[0] = 0x01;
    descriptor[1] = 0x02;
    descriptor[2] = 0x03;
    descriptor[3] = 0x04;
    descriptor[4] = 0x10;
    assert.equal(discSerial(descriptor), 0x11020304);
    descriptor.fill(0xff);
    // 512 bytes of 0xff in each lane wrap to zero.
    assert.equal(discSerial(descriptor), 0);
});

test('something that is not a disc is refused, and told apart before opening', async()=>{
    const notIso = new Uint8Array(20 * SECTOR_SIZE);
    assert.equal(await isIsoImage(counted(notIso).read), false);
    assert.equal(await isIsoImage(counted(buildIso({ files: DISC })).read), true);
    assert.equal(await isIsoImage(counted(new Uint8Array(10)).read), false);
    await assert.rejects(openIso(counted(notIso).read), /not an ISO 9660 image/);
});

test('a directory that contains itself is a damaged image, not a loop', async()=>{
    const image = buildIso({ files: { 'Sub/file.txt': 'x' } });
    const iso = await openIso(counted(image).read);
    const sub = /** @type {any} */ (iso.find('Sub'));
    const root = new DataView(image.buffer).getUint32(17 * SECTOR_SIZE + 156 + 2, true);
    // Point the subdirectory's record at the root: walking it would never end.
    for (let at = root * SECTOR_SIZE; at < (root + 1) * SECTOR_SIZE; at++)
    {
        if (new DataView(image.buffer).getUint32(at + 2, true) === sub.extents[0].at / SECTOR_SIZE
            && image[at + 25] === 2 && image[at + 32] > 1)
        {
            new DataView(image.buffer).setUint32(at + 2, root, true);
            break;
        }
    }
    await assert.rejects(openIso(counted(image).read), /damaged ISO 9660 image/);
});

test('the source serves the disc to the overlay, synchronously', async()=>{
    const image = buildIso({ files: DISC });
    const read = chunkedReads(counted(image).read, { size: image.length });
    const source = createIsoSource(await openIso(read));
    const listed = source.list();
    assert.ok(listed.some(entry=>entry.path === 'Data' && entry.directory));
    assert.ok(listed.every(entry=>typeof entry.modified === 'number'));
    assert.deepEqual(source.stat('setup.EXE'), { directory: false, size: 5000 });
    assert.deepEqual(source.read('Setup.exe', 4990, 100), DISC['Setup.exe'].subarray(4990));
    assert.throws(()=>source.read('missing', 0, 1), { code: 'NOT_FOUND' });
});

test('a source over an asynchronous reader refuses rather than hand back a promise', async()=>{
    const source = createIsoSource(await openIso(counted(buildIso({ files: DISC }), true).read));
    assert.throws(()=>source.read('Setup.exe', 0, 10), /synchronous reader/);
});

test('chunked reads turn small reads into lookups and pass long ones through', ()=>{
    const image = pattern(1 << 20);
    const reader = counted(image);
    const read = chunkedReads(reader.read, { size: image.length, chunkBytes: 4096, chunks: 4,
        directBytes: 16384 });
    for (let at = 0; at < 4096; at += 16)
    {
        assert.deepEqual(read(at, 16), image.subarray(at, at + 16));
    }
    assert.equal(reader.asked.length, 1);
    // A read across a chunk boundary joins the two.
    assert.deepEqual(read(4090, 12), image.subarray(4090, 4102));
    assert.equal(reader.asked.length, 2);
    assert.deepEqual(read(100000, 20000), image.subarray(100000, 120000));
    assert.deepEqual(reader.asked.at(-1), { offset: 100000, length: 20000 });
    // Past the end is short, as the image is.
    assert.equal(read(image.length - 4, 100).length, 4);
    // Only four chunks are kept: the first is read again once five others were.
    for (let chunk = 10; chunk < 15; chunk++)
    {
        read(chunk * 4096, 1);
    }
    const before = reader.asked.length;
    read(0, 1);
    assert.equal(reader.asked.length, before + 1);
    assert.equal(read.reads(), reader.asked.length);
});
