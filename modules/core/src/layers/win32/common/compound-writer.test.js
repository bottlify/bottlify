/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompoundFile } from '../ole32/cfb.js';
import { bytesSource, openCompound } from '../msi/compound.js';
import {
    COPY_CHUNK, CompoundWriteError, compareNames, compoundBytes, compoundBytesSync, memorySource,
    nameKey, planCompound, storageOf, streamOf, writeCompound,
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
            node = /** @type {import('../msi/compound.js').CompoundNode} */ (
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

test('each storage\'s siblings are a red-black search tree in the directory\'s order', async()=>{
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
    /**
     * The names under an entry in order, and its black height: every path to
     * a missing child passes as many black entries, and no red one has a red
     * child.
     *
     * @param {number} index @param {boolean} parentRed
     * @returns {{ names: string[], black: number }}
     */
    const walk = (index, parentRed)=>{
        if (index === 0xffffffff)
        {
            return { names: [], black: 1 };
        }
        assert.ok(!seen.has(index), 'each entry once');
        seen.add(index);
        const node = entry(index);
        const red = node.color === 0;
        assert.ok(!(red && parentRed), `${node.name}: a red entry under a red one`);
        if (node.type === 1)
        {
            check(node.child);
        }
        const left = walk(node.left, red);
        const right = walk(node.right, red);
        assert.equal(left.black, right.black, `black height under ${node.name}`);
        return { names: [...left.names, node.name, ...right.names],
            black: left.black + (red ? 0 : 1) };
    };
    /** @param {number} child */
    const check = child=>{
        if (child !== 0xffffffff)
        {
            assert.equal(entry(child).color, 1, 'the root of each tree is black');
        }
        const { names } = walk(child, false);
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
    const node = /** @type {import('../msi/compound.js').CompoundNode} */ (
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

/**
 * A seeded generator, so a failing tree can be made again from its seed.
 *
 * @param {number} seed
 */
const random = seed=>{
    let state = seed >>> 0;
    return (/** @type {number} */ limit)=>{
        state = (state * 1664525 + 1013904223) >>> 0;
        return state % limit;
    };
};

/**
 * A random tree: storages nested a few deep, streams of every size class
 * (empty, mini, at the cutoff, large), and the entry fields ole32 keeps.
 *
 * @param {number} seed
 */
const randomTree = seed=>{
    const next = random(seed);
    const sizes = [0, 1, 63, 64, 65, 4095, 4096, 4097, 9000];
    /** @param {number} depth @returns {import('./compound-writer.js').WriteNode[]} */
    const children = depth=>Array.from({ length: next(depth === 0 ? 12 : 6) }, (_, index)=>{
        const name = `${'n'.repeat(1 + next(3))}${index}`;
        const info = { stateBits: next(4), created: BigInt(next(1000)), modified: BigInt(next(9)) };
        if (depth < 3 && next(4) === 0)
        {
            return { ...storageOf(name, children(depth + 1),
                next(2) === 0 ? OTHER : undefined), ...info };
        }
        const size = next(3) === 0 ? sizes[next(sizes.length)] : next(6000);
        return streamOf(name, pattern(0, size, next(256)), info);
    });
    return storageOf('Root Entry', children(0), CLSID);
};

test('gate: the file written into memory is the file written through a sink', async()=>{
    for (let seed = 1; seed <= 60; seed++)
    {
        const tree = randomTree(seed);
        const now = compoundBytesSync(tree);
        const file = pieceFile();
        const size = await writeCompound(tree, file.sink);
        assert.equal(now.length, size, `seed ${seed}: size`);
        const later = await file.source().read(0, size);
        assert.deepEqual(now, later, `seed ${seed}`);
        assert.deepEqual(await compoundBytes(tree), now, `seed ${seed}: in memory, later`);
        assert.ok(parseCompoundFile(now), `seed ${seed}: ole32 reads it`);
    }
});

test('class, state bits and times are written on every entry, streams too', ()=>{
    const bytes = compoundBytesSync({
        ...storageOf('Root Entry', [
            streamOf('s', Uint8Array.of(1, 2), { clsid: OTHER, stateBits: 7, created: 11n,
                modified: 12n }),
            { ...storageOf('t', [], CLSID), stateBits: 3, created: 0x01dcb35d3cf4a800n },
        ], CLSID),
        stateBits: 5, modified: 99n,
    });
    const root = parseCompoundFile(bytes);
    assert.ok(root);
    assert.equal(root.clsid, CLSID);
    assert.equal(root.stateBits, 5);
    assert.equal(root.modified, 99n);
    const stream = root.children.get('S');
    assert.deepEqual([stream?.clsid, stream?.stateBits, stream?.created, stream?.modified],
        [OTHER, 7, 11n, 12n]);
    const storage = root.children.get('T');
    assert.deepEqual([storage?.clsid, storage?.stateBits, storage?.created],
        [CLSID, 3, 0x01dcb35d3cf4a800n]);
});

test('written now, a source has to answer now', ()=>{
    assert.throws(()=>compoundBytesSync(storageOf('Root Entry', [{ kind: 'stream', name: 'later',
        source: { size: 10, read: async()=>new Uint8Array(10) } }])), CompoundWriteError);
    assert.deepEqual(memorySource(Uint8Array.of(1, 2, 3)).read(1, 5), Uint8Array.of(2, 3));
});

test('names compare by length first and then without regard to case', ()=>{
    assert.ok(compareNames('b', 'AA') < 0);
    assert.ok(compareNames('AB', 'aa') > 0);
    assert.equal(compareNames('abc', 'ABC'), 0);
    assert.equal(nameKey('Root Entry'), 'ROOT ENTRY');
});
