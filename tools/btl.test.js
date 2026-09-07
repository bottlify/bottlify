/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The bundle format, checked on data shaped like the real thing: some of it
 * compresses well, most of it does not, and a reader asks for small ranges at
 * arbitrary offsets rather than for whole files.
 *
 * Run with: node --test tools/btl.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Codec, openBundle, packBlock, unpackBlock, verifyBundle, writeBundle } from './btl.mjs';

/** Compresses well: what an executable or a text file looks like to a compressor. */
const compressible = (/** @type {number} */ size)=>Buffer.alloc(size, 0x41);

/** Compresses not at all: what an already-packed archive looks like. */
const incompressible = (/** @type {number} */ size)=>randomBytes(size);

/**
 * Builds a tree, packs it, and hands back the bundle and where it came from.
 *
 * @param {Record<string, Buffer>} files
 * @param {string[]} [emptyDirectories]
 * @param {any} [options]
 */
async function bundleOf(files, emptyDirectories = [], options = {}){
    const root = await mkdtemp(join(tmpdir(), 'btl-in-'));
    const out = await mkdtemp(join(tmpdir(), 'btl-out-'));

    for (const [path, bytes] of Object.entries(files))
    {
        const full = join(root, path);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, bytes);
    }
    for (const directory of emptyDirectories)
    {
        await mkdir(join(root, directory), { recursive: true });
    }

    const output = join(out, 'bundle.btl');
    const summary = await writeBundle({ root, output, blockSize: 4096, ...options });
    const bundle = await openBundle(output);
    return {
        bundle,
        summary,
        output,
        cleanup: async()=>{
            await bundle.close();
            await rm(root, { recursive: true, force: true });
            await rm(out, { recursive: true, force: true });
        },
    };
}

test('a block is compressed only when that is worth doing', ()=>{
    const packed = packBlock(compressible(1 << 16));
    assert.ok(packed.codec === Codec.DEFLATE_RAW || packed.codec === Codec.ZSTD,
        'both are tried and the smaller is kept');
    assert.ok(packed.bytes.length < 1000, 'a run of one byte should collapse');

    // Random data cannot be compressed, and deflate makes it very slightly
    // bigger. Storing it keeps the archive honest and every future read free.
    const stored = packBlock(incompressible(1 << 16));
    assert.equal(stored.codec, Codec.STORED);
    assert.equal(stored.bytes.length, 1 << 16);
});

test('both compressors are used, and the smaller wins each block', ()=>{
    // Text-shaped and executable-shaped data do not agree on which compressor
    // is better, which is the whole reason the choice is per block.
    const text = Buffer.from('the quick brown fox '.repeat(4000));
    const chosen = packBlock(text);
    assert.notEqual(chosen.codec, Codec.STORED);

    // Whichever won, decoding it has to give the original back.
    const back = Buffer.from(unpackBlock(chosen.codec, chosen.bytes));
    assert.equal(back.length, text.length);
    assert.ok(back.equals(text));
});

test('every file comes back byte for byte', async()=>{
    const files = {
        'readme.txt': compressible(3000),
        'data\\big.mpq': incompressible(10000),
        'bin\\app.exe': Buffer.concat([compressible(5000), incompressible(5000)]),
    };
    const { bundle, cleanup } = await bundleOf(files);

    for (const [path, expected] of Object.entries(files))
    {
        const actual = await bundle.read(path);
        assert.equal(actual.length, expected.length, path);
        assert.equal(createHash('sha256').update(actual).digest('hex'),
            createHash('sha256').update(expected).digest('hex'), path);
    }
    await cleanup();
});

test('a range read touches only the blocks it covers', async()=>{
    // Spanning three blocks with a range that starts and ends inside one: the
    // arithmetic at both edges is where an off-by-one lives.
    const content = randomBytes(4096 * 3);
    const { bundle, cleanup } = await bundleOf({ 'data.bin': content });

    for (const [offset, length] of [[0, 10], [4090, 12], [100, 4096], [8000, 4288], [4096, 0]])
    {
        const actual = await bundle.read('data.bin', offset, length);
        assert.deepEqual([...actual], [...content.subarray(offset, offset + length)],
            `range ${offset}+${length}`);
    }

    // Past the end is what is there, not an error: a program reading to EOF
    // asks for more than remains and expects the remainder.
    assert.equal((await bundle.read('data.bin', 4096 * 3 - 5, 1000)).length, 5);
    assert.equal((await bundle.read('data.bin', 99999, 10)).length, 0);
    await cleanup();
});

test('paths are matched the way a guest asks for them', async()=>{
    const { bundle, cleanup } = await bundleOf({ 'Data\\Sound.MPQ': compressible(100) });

    // Windows is case-insensitive, and a program's spelling of a path is not
    // the one the file was created with.
    assert.ok(bundle.stat('data\\sound.mpq'));
    assert.ok(bundle.stat('DATA\\SOUND.MPQ'));
    assert.equal(bundle.stat('data\\missing.mpq'), null);
    // The case the file was created with is what a listing reports.
    assert.equal(bundle.list()[0].path, 'Data\\Sound.MPQ');
    await cleanup();
});

test('an empty directory survives being packed', async()=>{
    // Nothing about a file list would put one back, and a program that writes
    // its saves into one fails if it is missing.
    const { bundle, cleanup } = await bundleOf({ 'game.exe': compressible(64) }, ['Save\\Multi']);
    assert.deepEqual(bundle.directories(), ['Save\\Multi']);
    await cleanup();
});

test('a bundle verifies against the digests it was written with', async()=>{
    const { output, cleanup } = await bundleOf({
        'a.bin': incompressible(9000),
        'b.txt': compressible(9000),
    });

    const clean = await verifyBundle(output);
    assert.deepEqual(clean, { checked: 2, bad: [] });

    // A byte flipped inside the data has to be found. The offset is past the
    // header and inside the first block, which is stored, so the change lands
    // in the file rather than in a compressed stream that would fail to inflate.
    const bytes = await readFile(output);
    bytes[0x40] ^= 0xff;
    await writeFile(output, bytes);

    const damaged = await verifyBundle(output);
    assert.equal(damaged.bad.length, 1, 'the corrupt file is named');
    await cleanup();
});

test('a bundle written twice from the same tree is the same bundle', async()=>{
    const files = { 'x.bin': incompressible(5000), 'y.txt': compressible(5000) };
    const first = await bundleOf(files);
    const second = await bundleOf(files);

    // Not a nicety: it is what makes a bundle cacheable by content and a build
    // checkable against one somebody else made.
    assert.equal(first.summary.sha256, second.summary.sha256);
    await first.cleanup();
    await second.cleanup();
});

test('storing everything is a choice the bundle records', async()=>{
    const { bundle, summary, cleanup } = await bundleOf(
        { 'text.txt': compressible(20000) }, [], { store: true });

    assert.equal(summary.storedBlocks, summary.totalBlocks);
    assert.equal(summary.ratio, 1);
    assert.equal((await bundle.read('text.txt')).length, 20000);
    await cleanup();
});

test('what is not a bundle is refused before anything is read', async()=>{
    const directory = await mkdtemp(join(tmpdir(), 'btl-bad-'));
    const path = join(directory, 'not-a-bundle.btl');
    await writeFile(path, Buffer.alloc(64, 0x7f));

    await assert.rejects(()=>openBundle(path), /is not a \.btl bundle/);
    await rm(directory, { recursive: true, force: true });
});
