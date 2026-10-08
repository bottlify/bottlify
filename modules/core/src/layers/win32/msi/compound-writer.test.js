/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareNames, nameKey, parseCompoundFile } from '../ole32/cfb.js';
import { bytesSource, openCompound } from './compound.js';
import {
    COPY_CHUNK, CompoundWriteError, compoundBytes, planCompound, storageOf, streamOf,
    writeCompound,
} from './compound-writer.js';
import { isPattern, pattern, patternSource, pieceFile } from './compound-writer.fixture.js';

const CLSID = '{000C1084-0000-0000-C000-000000000046}';
const OTHER = '{12345678-9ABC-DEF0-1234-56789ABCDEF0}';

/**
 * Streams either side of the mini stream's cutoff, an empty one, many
 * siblings (more than a directory sector holds) and a storage of its own class.
 */
const sample = ()=>storageOf('Root Entry', [
    streamOf('small', pattern(0, 100, 1)),
    streamOf('under', pattern(0, 4095, 2)),
    streamOf('edge', pattern(0, 4096, 3)),
    streamOf('large', pattern(0, 300001, 4)),
    streamOf('empty', new Uint8Array(0)),
    storageOf('inner', [streamOf('deep', pattern(0, 700, 5)), storageOf('leaf', [])], OTHER),
    ...Array.from({ length: 40 }, (_, index)=>streamOf(`s${index}`, pattern(0, index * 37, index))),
], CLSID);

test('a tree written reads back through both readers, byte for byte', async()=>{
    const bytes = await compoundBytes(sample());
    assert.equal(bytes.length % 512, 0, 'whole sectors');
    const file = await openCompound(bytesSource(bytes));
    assert.equal(file.root.clsid, CLSID);
    const read = async(/** @type {string[]} */ ...path)=>{
        let node = file.root;
        for (const name of path)
        {
            node = /** @type {import('./compound.js').CompoundNode} */ (
                node.children.get(nameKey(name)));
        }
        return file.readAll(node);
    };
    assert.deepEqual(await read('small'), pattern(0, 100, 1));
    assert.deepEqual(await read('under'), pattern(0, 4095, 2));
    assert.deepEqual(await read('edge'), pattern(0, 4096, 3));
    assert.deepEqual(await read('large'), pattern(0, 300001, 4));
    assert.deepEqual(await read('empty'), new Uint8Array(0));
    assert.deepEqual(await read('inner', 'deep'), pattern(0, 700, 5));
    assert.equal(file.root.children.get('INNER')?.clsid, OTHER);
    assert.equal(file.root.children.get('INNER')?.children.get('LEAF')?.kind, 'storage');
    for (let index = 0; index < 40; index++)
    {
        assert.deepEqual(await read(`s${index}`), pattern(0, index * 37, index));
    }

    // ole32's reader, which reads the whole file its own way.
    const root = parseCompoundFile(bytes);
    assert.ok(root);
    assert.equal(root.clsid, CLSID);
    assert.deepEqual(root.children.get('LARGE')?.data, pattern(0, 300001, 4));
    assert.deepEqual(root.children.get('INNER')?.children.get('DEEP')?.data,
        pattern(0, 700, 5));
});

test('each storage\'s siblings are a search tree in the directory\'s order, all black', async()=>{
    const bytes = await compoundBytes(sample());
    const view = new DataView(bytes.buffer);
    const directory = 512 + view.getUint32(0x30, true) * 512;
    // The directory is one run here: the writer lays it out consecutively.
    const entry = (/** @type {number} */ index)=>{
        const at = directory + index * 128;
        const length = view.getUint16(at + 0x40, true) / 2 - 1;
        return {
            name: String.fromCharCode(...Array.from({ length },
                (_, unit)=>view.getUint16(at + unit * 2, true))),
            type: bytes[at + 0x42], color: bytes[at + 0x43],
            left: view.getUint32(at + 0x44, true), right: view.getUint32(at + 0x48, true),
            child: view.getUint32(at + 0x4c, true),
        };
    };
    const seen = new Set([0]);
    /** @param {number} index @returns {string[]} the names in order */
    const walk = index=>{
        if (index === 0xffffffff)
        {
            return [];
        }
        assert.ok(!seen.has(index), 'each entry once');
        seen.add(index);
        const node = entry(index);
        assert.equal(node.color, 1);
        if (node.type === 1)
        {
            check(node.child);
        }
        return [...walk(node.left), node.name, ...walk(node.right)];
    };
    /** @param {number} child */
    const check = child=>{
        const names = walk(child);
        assert.deepEqual(names, [...names].sort(compareNames));
    };
    assert.equal(entry(0).type, 5);
    assert.equal(entry(0).name, 'Root Entry');
    check(entry(0).child);
    assert.equal(seen.size, 1 + 46 + 2, 'every stream and storage reached');
});

test('a large stream goes out a chunk at a time, with FAT sectors past the header\'s', async()=>{
    // 109 FAT sectors cover about 7 MB; this needs DIFAT sectors.
    const size = 9 * 1024 * 1024 + 123;
    const big = patternSource(size, 9);
    const file = pieceFile();
    const written = await writeCompound(storageOf('Root Entry', [
        { kind: 'stream', name: 'big', source: big },
        streamOf('small', pattern(0, 10, 8)),
    ]), file.sink);
    assert.ok(big.reads.every(length=>length <= COPY_CHUNK), 'never asked for it whole');
    let end = 0;
    for (const { offset, length } of file.writes)
    {
        assert.equal(offset, end, 'in file order, each byte once');
        end += length;
    }
    assert.equal(end, written);
    const source = file.source();
    const header = await source.read(0, 512);
    const difatSectors = new DataView(header.buffer).getUint32(0x48, true);
    assert.ok(difatSectors > 0, 'the DIFAT is used');

    const read = await openCompound(source);
    const node = /** @type {import('./compound.js').CompoundNode} */ (
        read.root.children.get('BIG'));
    assert.equal(node.size, size);
    assert.ok(isPattern(await read.readAll(node), 0, 9));
    assert.ok(isPattern(await read.read(node, 5_000_000, 70_000), 5_000_000, 9));
    assert.deepEqual(await read.readAll(/** @type {any} */ (read.root.children.get('SMALL'))),
        pattern(0, 10, 8));
});

test('what cannot be written is refused before anything is', async()=>{
    assert.throws(()=>planCompound(storageOf('Root Entry', [streamOf('x'.repeat(32),
        new Uint8Array(1))])), CompoundWriteError);
    assert.throws(()=>planCompound(storageOf('Root Entry', [streamOf('Same', new Uint8Array(1)),
        streamOf('SAME', new Uint8Array(1))])), CompoundWriteError, 'names compare upper-cased');
    assert.throws(()=>planCompound(storageOf('Root Entry', [{ kind: 'stream', name: 'huge',
        source: { size: 0x80000001, read: ()=>new Uint8Array(0) } }])), CompoundWriteError);
    await assert.rejects(compoundBytes(storageOf('Root Entry', [{ kind: 'stream', name: 'liar',
        source: { size: 5000, read: ()=>new Uint8Array(10) } }])), CompoundWriteError,
    'a source shorter than its size');
});
