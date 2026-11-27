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
import { packBlock, writeBundle } from '../../../../bundle-node.js';
import { openBundle, withManifest, Codec, HEADER_SIZE, MAGIC } from './format.js';
import { createBundleSource, BLOCK_MISS } from './source.js';
import { createBlockCache } from './cache.js';
import { cachedBundle } from './saved.js';
import { fakeOpfs } from '../opfs.fixture.js';
import { INDEX_FILES, grainsOf, readSaved } from '@bottlify/cellar';

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
/**
 * The packer bundles were written with before deflate became the only codec:
 * the smaller of deflate and zstd. Published bundles carry zstd blocks, so the
 * fixture does too, and every codec a reader meets is read here.
 *
 * @param {Buffer} block @param {number} level
 */
function packAsPublished(block, level){
    const packed = packBlock(block, level);
    if (packed.codec !== Codec.DEFLATE_RAW)
    {
        return packed;
    }
    const zstd = zlib.zstdCompressSync(block,
        { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
    return zstd.length < packed.bytes.length ? { codec: Codec.ZSTD, bytes: zstd } : packed;
}

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
        await writeBundle({ root, output, blockSize, pack: packAsPublished });
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

const open = ()=>openBundle(
    async(at, count)=>bundleBytes.subarray(at, at + count),
    decodeBlock);

/**
 * Block `index` of `bundle` decoded, as the engine puts it in the cache.
 *
 * @param {import('./format.js').Bundle} bundle @param {Uint8Array} bytes  the container
 * @param {number} index
 */
const decodedBlock = (bundle, bytes, index)=>{
    const block = bundle.block(index);
    return decodeBlock(block.codec, bytes.subarray(block.offset, block.offset + block.packed));
};

/**
 * A cache of a bundle's blocks, those of `resident` put (every one for null).
 *
 * @param {import('./format.js').Bundle} bundle
 * @param {{ resident?: number[] | null, budget?: number, store?: any,
 *     bytes?: Uint8Array }} [options]  `bytes`: the container, the fixture's by default
 */
async function cacheOf(bundle, { resident = null, budget, store = null,
    bytes = bundleBytes } = {})
{
    const cache = await createBlockCache({ store, name: `game-${bundle.fingerprint}`,
        blockSize: bundle.blockSize, blockCount: bundle.blockCount, budget });
    for (let index = 0; index < bundle.blockCount; index++)
    {
        if (resident === null || resident.includes(index))
        {
            assert.equal(cache.put(index, decodedBlock(bundle, bytes, index)), true);
        }
    }
    return cache;
}

/**
 * @param {Object} [options]
 * @param {number[] | null} [options.resident] block indices that are here; null for all
 * @param {number} [options.budget]  the cache's
 */
async function mount(options = {}){
    const bundle = await open();
    const cache = await cacheOf(bundle, options);
    const source = createBundleSource({ bundle, blocks: cache });
    return { bundle, source, cache };
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

test('a block is read where the cache holds it by every mount of it', async()=>{
    // Each process of a run mounts the bundle and reads the same blocks:
    // decoded once as they were fetched, kept once, read where they lie.
    const bundle = await open();
    const cache = await cacheOf(bundle);
    const first = createBundleSource({ bundle, blocks: cache });
    const second = createBundleSource({ bundle, blocks: cache });
    const ramp = CONTENT['Game\\Ramp.dat'];

    same(first.read('Game\\Ramp.dat', 0, 3000), ramp);
    same(first.read('Game\\Ramp.dat', 100, 2000), ramp.subarray(100, 2100));
    same(second.read('Game\\Ramp.dat', 0, 3000), ramp, 'the other mount, the same bytes');
    assert.equal(cache.diagnostics().cellar.hot, bundle.blockCount, 'each block kept once');

    const read = second.read('Game\\Ramp.dat', 0, 16);
    read[0] ^= 0xff;
    same(first.read('Game\\Ramp.dat', 0, 16), ramp.subarray(0, 16),
        'a reader writing into what it read changes nothing kept');
});

test('a block the cache let go of is a miss, fetched again, every read whole', async()=>{
    // A cache of four blocks' room for a bundle of more: what it lets go of
    // to keep another is missed by its next read, which names it. A read
    // within a block each: the keeper ranks bodies put within one of its
    // sweeps by their records, not by their reads, and a read of several
    // blocks in a room of few may push its own blocks out.
    const bundle = await open();
    // Room for four blocks, each all the cache places for its length.
    const budget = 4 * grainsOf(BLOCK_SIZE);
    const cache = await cacheOf(bundle, { resident: [], budget });
    const source = createBundleSource({ bundle, blocks: cache });
    let fetched = 0;
    /** @param {string} path @param {number} at @param {number} length */
    const read = (path, at, length)=>{
        for (let tries = 0; ; tries++)
        {
            assert.ok(tries < 4, 'a fetch that does not deliver');
            try
            {
                return source.read(path, at, length);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                assert.equal(miss.code, BLOCK_MISS);
                for (const block of miss.blocks)
                {
                    fetched++;
                    cache.put(block.index, decodedBlock(bundle, bundleBytes, block.index));
                }
            }
        }
    };
    const ramp = CONTENT['Game\\Ramp.dat'];
    let seed = 3;
    for (let at = 0; at < 300; at++)
    {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const from = seed % ramp.length;
        const length = 1 + (seed >>> 8) % (BLOCK_SIZE - from % BLOCK_SIZE);
        same(read('Game\\Ramp.dat', from, length), ramp.subarray(from, from + length));
        if (at % 37 === 0)
        {
            for (const [path, bytes] of Object.entries(CONTENT))
            {
                for (let part = 0; part < bytes.length; part += BLOCK_SIZE)
                {
                    same(read(path, part, BLOCK_SIZE), bytes.subarray(part, part + BLOCK_SIZE),
                        path);
                }
            }
        }
        assert.ok(cache.diagnostics().cellar.segmentBytes <= budget, 'under the cache\'s budget');
    }
    assert.ok(fetched > bundle.blockCount, `${fetched} fetches for ${bundle.blockCount} blocks`);
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
        bundle, blocks: await cacheOf(bundle), prefix: 'App',
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
        bundle, blocks: await cacheOf(bundle), prefix: 'App',
        relocate: { 'game': '' },
    });
    const notes = CONTENT['Game\\Data\\Notes.txt'];
    same(source.read('Data\\Notes.txt', 0, notes.length), notes);
    assert.ok(source.list().every(entry=>!entry.path.startsWith('\\') && entry.path !== ''),
        'every path relative to the root');
});

test('with no prefix only what is relocated appears, and the rest is counted', async()=>{
    // A layer has no program directory: its system files are all it gives.
    const bundle = await open();
    const source = createBundleSource({
        bundle, blocks: await cacheOf(bundle), prefix: null,
        relocate: { 'game\\DATA': 'WINDOWS\\system32' },
    });
    const notes = CONTENT['Game\\Data\\Notes.txt'];
    same(source.read('WINDOWS\\system32\\Notes.txt', 0, notes.length), notes);
    assert.deepEqual(source.list().map(entry=>entry.path).sort(),
        ['WINDOWS', 'WINDOWS\\system32', 'WINDOWS\\system32\\Notes.txt']);
    assert.equal(source.stat('Game\\Ramp.dat'), null);
    assert.throws(()=>source.read('Game\\Ramp.dat', 0, 1), { code: 'NOT_FOUND' });
    assert.equal(source.unplaced, 2, 'the two files outside it');
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
    const source = createBundleSource({ bundle: described,
        blocks: await cacheOf(described, { bytes: joined }) });
    const notes = CONTENT['Game\\Data\\Notes.txt'];
    same(source.read('Game\\Data\\Notes.txt', 0, notes.length), notes);
    const taken = await withManifest(async(at, count)=>joined.subarray(at, at + count),
        decodeBlock, null);
    assert.equal(JSON.parse(new TextDecoder().decode(taken.index)).manifest, undefined,
        'null takes the description out');
});

test('a bundle held whole in the block cache is written out from it alone', async()=>{
    // A game played or downloaded here is saved without fetching it again:
    // the blocks the engine put, laid back to back under a new index.
    const bundle = await open();
    const codecs = new Set(Array.from({ length: bundle.blockCount },
        (_, at)=>bundle.block(at).codec));
    assert.ok(codecs.has(Codec.STORED) && codecs.size > 1, 'the fixture has blocks of each kind');
    const origin = fakeOpfs();
    (await cacheOf(bundle, { store: origin.root })).close();
    const fetchRange = async(/** @type {number} */ at, /** @type {number} */ count)=>
        at === 0 || at >= bundle.block(bundle.blockCount - 1).offset
            ? bundleBytes.subarray(at, at + count)
            : assert.fail(`a block was fetched at ${at}`);
    const manifest = { title: 'A Game' };
    /** @param {any} root */
    const written = root=>cachedBundle({ root, id: 'game', fetchRange, decode: decodeBlock,
        manifest });
    const whole = await written(origin.root);
    assert.ok(whole);
    const bytes = new Uint8Array(await whole.arrayBuffer());
    const opened = await openBundle(async(at, count)=>bytes.subarray(at, at + count),
        decodeBlock);
    assert.deepEqual(opened.manifest, manifest);
    assert.deepEqual(opened.files, bundle.files);
    assert.ok(Array.from({ length: opened.blockCount }, (_, at)=>opened.block(at).codec)
        .every(codec=>codec === Codec.STORED), 'every block stored, as the cache keeps it');
    const source = createBundleSource({ bundle: opened,
        blocks: await cacheOf(opened, { bytes }) });
    for (const [path, content] of Object.entries(CONTENT))
    {
        same(source.read(path, 0, content.length), content, path);
    }

    const short = fakeOpfs();
    (await cacheOf(bundle, { store: short.root,
        resident: Array.from({ length: bundle.blockCount - 1 }, (_, at)=>at + 1) })).close();
    assert.equal(await written(short.root), null, 'a block missing from the cache: nothing');

    const home = `blocks/game-${bundle.fingerprint}`;
    const cut = fakeOpfs();
    (await cacheOf(bundle, { store: cut.root })).close();
    const pack = /** @type {any} */ (cut.node(`${home}/pack-0`));
    pack.data = pack.data.slice(0, pack.data.length - 1);
    assert.equal(await written(cut.root), null, 'a pack short of its last block: nothing');

    // An index naming another block's body under this one's: the short last
    // block of Ramp.dat and a whole one, their names swapped.
    const swapped = fakeOpfs();
    (await cacheOf(bundle, { store: swapped.root })).close();
    const ramp = /** @type {any} */ (bundle.find('Game\\Ramp.dat'));
    // Written as an index of Cellar 0.9.0 (JSON), which Cellar still reads.
    const files = INDEX_FILES.map(file=>swapped.node(`${home}/${file}`)?.data ?? null);
    const saved = /** @type {NonNullable<ReturnType<typeof readSaved>>} */ (readSaved(files));
    const rename = (/** @type {string} */ name)=>(name === String(ramp.firstBlock)
        ? String(ramp.firstBlock + 2) : name === String(ramp.firstBlock + 2)
            ? String(ramp.firstBlock) : name);
    const records = [...saved.bodies].map(([name, body])=>[rename(name), body.pack, body.offset,
        body.length, 0]);
    /** @type {any} */ (swapped.node(`${home}/index-a`)).data = new TextEncoder().encode(
        JSON.stringify({ version: 1, generation: 1, packs: Math.max(...saved.packs) + 1,
            records }));
    /** @type {any} */ (swapped.node(`${home}/index-b`)).data = new Uint8Array(0);
    assert.equal(await written(swapped.root), null, 'a body of another length: nothing');
});

test('readInto hands each block\'s part where it lies, the run\'s cache read in place', async()=>{
    // ReadFile copies what it reads into guest memory: a read into bytes of
    // its own first was a second copy of every block, made and let go.
    const { source } = await mount();
    const ramp = CONTENT['Game\\Ramp.dat'];
    source.read('Game\\Ramp.dat', 0, 3000);
    /** @type {{ at: number, length: number, shared: boolean }[]} */
    const parts = [];
    const out = new Uint8Array(2000);
    const count = source.readInto('Game\\Ramp.dat', 100, 2000, (bytes, at)=>{
        parts.push({ at, length: bytes.length, shared: bytes.buffer instanceof SharedArrayBuffer });
        out.set(bytes, at);
    });
    assert.equal(count, 2000);
    same(out, ramp.subarray(100, 2100));
    assert.deepEqual(parts, [
        { at: 0, length: 924, shared: true },
        { at: 924, length: 1024, shared: true },
        { at: 1948, length: 52, shared: true },
    ], 'a part a block, each in the cache\'s memory');
});

test('a readInto that misses names the blocks it needs, after handing what was here', async()=>{
    const { bundle } = await mount();
    const file = bundle.find('Game\\Ramp.dat');
    assert.ok(file);
    const partial = await mount({ resident: [file.firstBlock] });
    /** @type {number[]} */
    const handed = [];
    assert.throws(()=>partial.source.readInto('Game\\Ramp.dat', 512, 1536,
        (_, at)=>handed.push(at)), (/** @type {any} */ e)=>{
        assert.equal(e.code, BLOCK_MISS);
        assert.deepEqual(e.blocks.map((/** @type {any} */ block)=>block.index), [file.firstBlock + 1]);
        return true;
    });
    assert.deepEqual(handed, [0], 'the resident block, handed again after the fetch');
});
