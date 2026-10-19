/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The fixtures are written by the bundler itself rather than assembled here, so
 * what these tests prove is that the reader agrees with the writer -- not that
 * it agrees with somebody's reading of the writer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { writeBundle } from '../../../../bundle-node.js';
import { openBundle, withManifest, Codec, HEADER_SIZE, MAGIC } from './format.js';
import { createBundleSource, BLOCK_MISS } from './source.js';
import { blockCacheName, cachedBundle, storedLength } from './cache.js';

const BLOCK_SIZE = 1024;

/** Deterministic bytes that no compressor can do anything with. @param {number} length */
function noise(length){
    const out = Buffer.alloc(length);
    let state = 12345;
    for (let at = 0; at < length; at++)
    {
        state = (state * 1103515245 + 12345) >>> 0;
        out[at] = (state >>> 16) & 0xff;
    }
    return out;
}

const CONTENT = {
    'Game\\Data\\Notes.txt': Buffer.from(
        'the quick brown fox jumps over the lazy dog. '.repeat(60)),
    'Game\\Ramp.dat': Buffer.from(Array.from({ length: 3000 }, (_, at)=>at & 0xff)),
    'Game\\Random.bin': noise(2048),
};

/**
 * @param {number} [blockSize]
 * @returns {Promise<Uint8Array>} the bundle, as bytes
 */
async function buildBundle(blockSize = BLOCK_SIZE){
    const directory = await mkdtemp(join(tmpdir(), 'bottlify-btl-'));
    const root = join(directory, 'tree');
    try
    {
        await mkdir(join(root, 'Game', 'Data'), { recursive: true });
        await mkdir(join(root, 'Game', 'Save'), { recursive: true });
        await mkdir(join(root, 'Logs'), { recursive: true });
        for (const [path, bytes] of Object.entries(CONTENT))
        {
            await writeFile(join(root, path.replace(/\\/g, '/')), bytes);
        }
        const output = join(directory, 'bundle.btl');
        await writeBundle({ root, output, blockSize });
        return new Uint8Array(await readFile(output));
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
}

const bundleBytes = await buildBundle();

/** @param {number} codec @param {Uint8Array} bytes */
function decodeBlock(codec, bytes){
    switch (codec){
        case Codec.STORED:
            return bytes;
        case Codec.DEFLATE_RAW:
            return new Uint8Array(zlib.inflateRawSync(bytes));
        case Codec.ZSTD:
            return new Uint8Array(zlib.zstdDecompressSync(bytes));
        default:
            throw new Error(`unknown codec ${codec}`);
    }
}

/** Counts what it decodes, which is how the cache is observed. */
function countingDecoder(){
    /** @type {{ codec: number, expectedLength: number | null }[]} */
    const calls = [];
    /** @type {import('./format.js').Decode} */
    const decode = (codec, bytes, expectedLength)=>{
        calls.push({ codec, expectedLength });
        return decodeBlock(codec, bytes);
    };
    return { decode, calls };
}

/**
 * @param {number[] | null} [resident] block indices that are here; null for all
 */
function blockReader(resident = null){
    /** @type {number[]} */
    const asked = [];
    /** @type {import('./source.js').ReadBlock} */
    const readBlock = (index, offset, packed)=>{
        asked.push(index);
        if (resident && !resident.includes(index))
        {
            return null;
        }
        return bundleBytes.subarray(offset, offset + packed);
    };
    return { readBlock, asked };
}

const open = ()=>openBundle(
    async(at, count)=>bundleBytes.subarray(at, at + count),
    decodeBlock);

/**
 * @param {Object} [options]
 * @param {number[] | null} [options.resident]
 * @param {number} [options.cacheBlocks]
 * @param {number} [options.hotBlocks]
 */
async function mount(options = {}){
    const bundle = await open();
    const { decode, calls } = countingDecoder();
    const { readBlock, asked } = blockReader(options.resident ?? null);
    const source = createBundleSource({
        bundle, readBlock, decode, cacheBlocks: options.cacheBlocks,
        hotBlocks: options.hotBlocks,
    });
    return { bundle, source, calls, asked };
}

/** @param {Uint8Array} actual @param {Uint8Array} expected @param {string} [message] */
function same(actual, expected, message){
    assert.deepEqual(Uint8Array.from(actual), Uint8Array.from(expected), message);
}

test('every file comes back byte for byte', async()=>{
    const { source } = await mount();

    for (const [path, bytes] of Object.entries(CONTENT))
    {
        same(source.read(path, 0, bytes.length), bytes, path);
        assert.deepEqual(source.stat(path), { directory: false, size: bytes.length });
    }
});

test('the fixture exercises all three codecs', async()=>{
    const { bundle, source } = await mount();

    const codecs = new Set();
    for (const file of bundle.files)
    {
        for (let at = 0; at < file.blocks; at++)
        {
            codecs.add(bundle.block(file.firstBlock + at).codec);
        }
    }
    assert.deepEqual([...codecs].sort(), [Codec.STORED, Codec.DEFLATE_RAW, Codec.ZSTD]);

    // And every codec's blocks read back as themselves, not merely decode.
    for (const [path, bytes] of Object.entries(CONTENT))
    {
        same(source.read(path, 0, bytes.length), bytes, path);
    }
});

test('a range starting and ending in different blocks', async()=>{
    const { source } = await mount();
    const expected = CONTENT['Game\\Ramp.dat'];

    same(source.read('Game\\Ramp.dat', 1000, 100), expected.subarray(1000, 1100),
        'across one boundary');
    same(source.read('Game\\Ramp.dat', 1000, 1100), expected.subarray(1000, 2100),
        'across two');
    same(source.read('Game\\Ramp.dat', 1024, 1024), expected.subarray(1024, 2048),
        'exactly one whole block');
});

test('a read past the end returns what is there', async()=>{
    const { source } = await mount();
    const expected = CONTENT['Game\\Random.bin'];

    same(source.read('Game\\Random.bin', 2000, 4096), expected.subarray(2000),
        'a length that runs off the end is clamped');
    same(source.read('Game\\Random.bin', 2048, 16), new Uint8Array(0),
        'starting at the end is empty, not an error');
    same(source.read('Game\\Random.bin', 9999, 16), new Uint8Array(0));
    same(source.read('Game\\Random.bin', 0, 0), new Uint8Array(0));
});

test('lookup folds case, listing keeps the case it was created with', async()=>{
    const { source } = await mount();

    assert.deepEqual(source.stat('game\\data\\NOTES.TXT'),
        { directory: false, size: CONTENT['Game\\Data\\Notes.txt'].length });
    same(source.read('GAME\\ramp.DAT', 0, 8), CONTENT['Game\\Ramp.dat'].subarray(0, 8));
    assert.equal(source.stat('Game\\Missing.dat'), null);

    const paths = source.list().map(entry=>entry.path);
    assert.ok(paths.includes('Game\\Data\\Notes.txt'), paths.join(', '));
    assert.ok(!paths.includes('game\\data\\notes.txt'));
});

test('empty directories are listed, because a program writes into them', async()=>{
    const { source } = await mount();
    const entries = source.list();

    assert.deepEqual(entries.find(entry=>entry.path === 'Game\\Save'),
        { path: 'Game\\Save', directory: true, size: 0 });
    assert.deepEqual(entries.find(entry=>entry.path === 'Logs'),
        { path: 'Logs', directory: true, size: 0 });
    assert.deepEqual(source.stat('game\\save'), { directory: true, size: 0 });

    // A directory that holds something is not recorded and does not need to be:
    // the overlay infers it from the paths under it.
    assert.equal(entries.filter(entry=>entry.directory).length, 2);
    assert.equal(entries.filter(entry=>!entry.directory).length, Object.keys(CONTENT).length);
});

test('a read that cannot be served names exactly the blocks it needs', async()=>{
    const ramp = await mount();
    const file = ramp.bundle.find('Game\\Ramp.dat');
    assert.ok(file);

    const partial = await mount({ resident: [file.firstBlock] });
    const absent = ramp.bundle.block(file.firstBlock + 1);

    assert.throws(()=>partial.source.read('Game\\Ramp.dat', 512, 1536),
        (/** @type {any} */ e)=>{
            assert.equal(e.code, BLOCK_MISS);
            assert.deepEqual(e.blocks, [{
                index: absent.index, offset: absent.offset, packed: absent.packed,
            }], 'the resident block is not asked for again');
            return true;
        });

    // What the caller above does with it: fetch, then ask again.
    const retry = await mount({ resident: [file.firstBlock, file.firstBlock + 1] });
    same(retry.source.read('Game\\Ramp.dat', 512, 1536),
        CONTENT['Game\\Ramp.dat'].subarray(512, 2048));
});

test('a miss reports every absent block, not just the first', async()=>{
    const { bundle } = await mount();
    const file = bundle.find('Game\\Ramp.dat');
    assert.ok(file);
    const { source } = await mount({ resident: [] });

    assert.throws(()=>source.read('Game\\Ramp.dat', 0, 3000), (/** @type {any} */ e)=>{
        assert.equal(e.code, BLOCK_MISS);
        assert.deepEqual(e.blocks.map((/** @type {any} */ block)=>block.index),
            [file.firstBlock, file.firstBlock + 1, file.firstBlock + 2]);
        return true;
    });
});

test('the cache evicts the oldest block and loses nothing doing it', async()=>{
    // The scan tier on its own: no block is kept because it was read twice.
    const { source, calls } = await mount({ cacheBlocks: 1, hotBlocks: 0 });
    const ramp = CONTENT['Game\\Ramp.dat'];

    same(source.read('Game\\Ramp.dat', 0, 16), ramp.subarray(0, 16));
    assert.equal(calls.length, 1);
    same(source.read('Game\\Ramp.dat', 32, 16), ramp.subarray(32, 48));
    assert.equal(calls.length, 1, 'a resident block is not decoded twice');

    same(source.read('Game\\Ramp.dat', 1024, 16), ramp.subarray(1024, 1040));
    assert.equal(calls.length, 2);
    same(source.read('Game\\Ramp.dat', 0, 16), ramp.subarray(0, 16),
        'evicted, decoded again, and still the right bytes');
    assert.equal(calls.length, 3);

    // A read wider than the whole cache still assembles correctly, which is the
    // case where eviction happens in the middle of serving it.
    same(source.read('Game\\Ramp.dat', 0, 3000), ramp);
});

test('a block read twice is not decoded again when a scan passes over it', async()=>{
    // The shape a movie reader makes: a header consulted between every chunk of
    // the file it streams. One cache for both roles evicts the header on the
    // first pass of the scan, and every later look at it decodes the whole
    // block again -- for a packed block, the decompression of all it holds.
    const { source, calls } = await mount({ cacheBlocks: 1 });
    const ramp = CONTENT['Game\\Ramp.dat'];

    same(source.read('Game\\Ramp.dat', 0, 16), ramp.subarray(0, 16));
    assert.equal(calls.length, 1);
    same(source.read('Game\\Ramp.dat', 0, 16), ramp.subarray(0, 16));
    assert.equal(calls.length, 1, 'the second look is a hit, and it is kept apart');

    source.read('Game\\Ramp.dat', 1024, 16);
    source.read('Game\\Ramp.dat', 2048, 16);
    assert.equal(calls.length, 3, 'the scan decoded its own blocks, evicting the scan tier');

    same(source.read('Game\\Ramp.dat', 0, 16), ramp.subarray(0, 16),
        'the header outlived the scan');
    assert.equal(calls.length, 3, 'and looking at it again decoded nothing');
});

test('a cache big enough for the file decodes each block once', async()=>{
    const { source, calls } = await mount({ cacheBlocks: 4 });

    source.read('Game\\Ramp.dat', 0, 3000);
    source.read('Game\\Ramp.dat', 0, 3000);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call=>call.expectedLength), [1024, 1024, 952],
        'a short final block is decoded to its own length, not the block size');
});

test('reading something that is not in the bundle fails as a missing file', async()=>{
    const { source } = await mount();

    assert.throws(()=>source.read('Game\\Nothing.dat', 0, 1), { code: 'NOT_FOUND' });
    assert.throws(()=>source.read('Game\\Save', 0, 1), { code: 'NOT_FOUND' },
        'a directory holds no bytes');
});

test('the header is checked before anything is trusted', async()=>{
    const foreign = bundleBytes.slice();
    foreign[0] = 'Z'.charCodeAt(0);
    await assert.rejects(
        openBundle(async(at, count)=>foreign.subarray(at, at + count), decodeBlock),
        /not a \.btl/i);

    const future = bundleBytes.slice();
    new DataView(future.buffer, future.byteOffset).setUint32(4, 99, true);
    await assert.rejects(
        openBundle(async(at, count)=>future.subarray(at, at + count), decodeBlock),
        /version/i);

    const short = bundleBytes.slice(0, HEADER_SIZE - 1);
    await assert.rejects(
        openBundle(async(at, count)=>short.subarray(at, at + count), decodeBlock),
        /header/i);

    assert.equal(MAGIC, 'BTL1');
});

test('a range covers only the blocks it touches', async()=>{
    const { bundle } = await mount();
    const file = bundle.find('game\\ramp.dat');
    assert.ok(file);

    assert.deepEqual(
        bundle.rangesFor(file, 1000, 100).map(range=>[range.block.index, range.from, range.to]),
        [[file.firstBlock, 1000, 1024], [file.firstBlock + 1, 0, 76]]);
    assert.deepEqual(
        bundle.rangesFor(file, 0, 99999).map(range=>[range.block.index, range.from, range.to]),
        [
            [file.firstBlock, 0, 1024],
            [file.firstBlock + 1, 0, 1024],
            [file.firstBlock + 2, 0, 952],
        ],
        'clamped to the file, and the last block is the short one');
    assert.deepEqual(bundle.rangesFor(file, 3000, 10), []);
    assert.deepEqual(bundle.rangesFor(file, 10, 0), []);
    assert.equal(bundle.blockSize, BLOCK_SIZE);
});

test('a relocated directory appears where it is mapped, outside the prefix', async()=>{
    const bundle = await open();
    const source = createBundleSource({
        bundle, readBlock: blockReader().readBlock, decode: decodeBlock, prefix: 'App',
        relocate: { 'game\\DATA': 'WINDOWS\\system32' },
    });
    const notes = CONTENT['Game\\Data\\Notes.txt'];

    same(source.read('WINDOWS\\system32\\Notes.txt', 0, notes.length), notes,
        'found by the case it is mapped to, whatever case named it');
    assert.equal(source.stat('App\\Game\\Data\\Notes.txt'), null, 'and not where it lay');
    assert.deepEqual(source.stat('App\\Game\\Ramp.dat'),
        { directory: false, size: CONTENT['Game\\Ramp.dat'].length }, 'the rest under the prefix');
    assert.deepEqual(source.stat('WINDOWS\\system32'), { directory: true, size: 0 });
    const paths = source.list().map(entry=>entry.path);
    assert.ok(paths.includes('WINDOWS') && paths.includes('WINDOWS\\system32'),
        'the directories it is mapped into are listed');
    assert.ok(!paths.some(path=>/data/i.test(path)), 'nothing is left at the old place');
});

test('a directory relocated to the root lands there, with no leading separator', async()=>{
    // What an installation wrote elsewhere on C: comes back where it was.
    const bundle = await open();
    const source = createBundleSource({
        bundle, readBlock: blockReader().readBlock, decode: decodeBlock, prefix: 'App',
        relocate: { 'game': '' },
    });
    const notes = CONTENT['Game\\Data\\Notes.txt'];
    same(source.read('Data\\Notes.txt', 0, notes.length), notes);
    assert.ok(source.list().every(entry=>!entry.path.startsWith('\\') && entry.path !== ''),
        'every path relative to the root');
});

test('a bundle packed again under the same name has another fingerprint', async()=>{
    // A block cache named by the bundle alone answered a repacked bundle's
    // reads with the old one's blocks, and the guest read garbage.
    const again = await openBundle(async(at, count)=>bundleBytes.subarray(at, at + count),
        decodeBlock);
    assert.equal((await open()).fingerprint, again.fingerprint, 'the same bytes, the same name');
    const other = await buildBundle(BLOCK_SIZE * 2);
    const repacked = await openBundle(async(at, count)=>other.subarray(at, at + count),
        decodeBlock);
    assert.match(repacked.fingerprint, /^[0-9a-f]{8}$/);
    assert.notEqual(repacked.fingerprint, again.fingerprint);
});

test('a description written into a bundle opens with it, its files as they were', async()=>{
    // A bottle exported carries its title and program, and imported elsewhere
    // opens as itself; its blocks are the same bytes.
    const read = async(/** @type {number} */ at, /** @type {number} */ count)=>
        bundleBytes.subarray(at, at + count);
    const manifest = { title: 'A Game', entry: 'Game\\Game.exe', root: 'C:\\Games\\A' };
    const { header, blocks, index } = await withManifest(read, decodeBlock, manifest);
    const joined = new Uint8Array(header.length + blocks[1] - blocks[0] + index.length);
    joined.set(header, 0);
    joined.set(bundleBytes.subarray(blocks[0], blocks[1]), header.length);
    joined.set(index, header.length + blocks[1] - blocks[0]);
    const described = await openBundle(async(at, count)=>joined.subarray(at, at + count),
        decodeBlock);
    assert.deepEqual(described.manifest, manifest);
    const before = await open();
    assert.equal(before.manifest, null, 'a bundle packed without one has none');
    assert.deepEqual(described.files, before.files);
    const source = createBundleSource({ bundle: described, decode: decodeBlock,
        readBlock: (_index, offset, packed)=>joined.subarray(offset, offset + packed) });
    const notes = CONTENT['Game\\Data\\Notes.txt'];
    same(source.read('Game\\Data\\Notes.txt', 0, notes.length), notes);
    const taken = await withManifest(async(at, count)=>joined.subarray(at, at + count),
        decodeBlock, null);
    assert.equal(JSON.parse(new TextDecoder().decode(taken.index)).manifest, undefined,
        'null takes the description out');
});

test('a bundle held whole in the block cache is written out from it alone', async()=>{
    // A game played or downloaded here is saved without fetching it again:
    // the slots the engine filled, laid back to back under a new index.
    const bundle = await open();
    const name = blockCacheName('game', bundle.fingerprint);
    const blocks = new Uint8Array(bundle.blockCount * bundle.blockSize);
    for (let at = 0; at < bundle.blockCount; at++)
    {
        const block = bundle.block(at);
        const packed = bundleBytes.subarray(block.offset, block.offset + block.packed);
        // As the engine puts it: a deflate block inflated, any other as it came.
        const kept = block.codec === Codec.DEFLATE_RAW ? decodeBlock(block.codec, packed) : packed;
        assert.equal(kept.length, storedLength(block));
        blocks.set(kept, at * bundle.blockSize);
    }
    const codecs = new Set(Array.from({ length: bundle.blockCount },
        (_, at)=>bundle.block(at).codec));
    assert.ok(codecs.has(Codec.STORED) && codecs.size > 1, 'the fixture has blocks kept both ways');
    /** @param {Uint8Array} present */
    const root = present=>({
        getFileHandle: async(/** @type {string} */ file)=>({
            getFile: async()=>new Blob(/** @type {BlobPart[]} */ ([file === `${name}.present` ? present
                : file === `${name}.blocks` ? blocks : assert.fail(file)])),
        }),
    });
    const whole = new Uint8Array(Math.ceil(bundle.blockCount / 8));
    for (let at = 0; at < bundle.blockCount; at++)
    {
        whole[at >> 3] |= 1 << (at & 7);
    }
    const fetchRange = async(/** @type {number} */ at, /** @type {number} */ count)=>
        at === 0 || at >= bundle.block(bundle.blockCount - 1).offset
            ? bundleBytes.subarray(at, at + count)
            : assert.fail(`a block was fetched at ${at}`);
    const manifest = { title: 'A Game' };
    const written = await cachedBundle({ root: root(whole), id: 'game', fetchRange,
        decode: decodeBlock, manifest });
    assert.ok(written);
    const bytes = new Uint8Array(await written.arrayBuffer());
    const read = async(/** @type {number} */ at, /** @type {number} */ count)=>
        bytes.subarray(at, at + count);
    const opened = await openBundle(read, decodeBlock);
    assert.deepEqual(opened.manifest, manifest);
    assert.deepEqual(opened.files, bundle.files);
    const source = createBundleSource({ bundle: opened, decode: decodeBlock,
        readBlock: (_index, offset, packed)=>bytes.subarray(offset, offset + packed) });
    for (const [path, content] of Object.entries(CONTENT))
    {
        same(source.read(path, 0, content.length), content, path);
    }

    const short = whole.slice();
    short[0] &= ~1;
    assert.equal(await cachedBundle({ root: root(short), id: 'game', fetchRange,
        decode: decodeBlock, manifest }), null, 'a block missing from the cache: nothing to write');
});
