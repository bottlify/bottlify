/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    compareNames, createEntry, createRoot, isCompoundFile, nameKey, parseCompoundFile,
    serializeCompoundFile,
} from './cfb.js';
import { windowsFixture } from './cfb.fixture.js';

const CLSID_A = '{12345678-9ABC-DEF0-1234-56789ABCDEF0}';
const CLSID_B = '{0000000B-0000-0000-C000-000000000046}';
const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';

/**
 * @param {import('./cfb.js').CfbEntry} parent
 * @param {string} name @param {Uint8Array} data
 */
function addStream(parent, name, data){
    const entry = createEntry(name, 'stream');
    entry.data = data;
    parent.children.set(nameKey(name), entry);
    return entry;
}

/** @param {import('./cfb.js').CfbEntry} parent @param {string} name */
function addStorage(parent, name){
    const entry = createEntry(name, 'storage');
    parent.children.set(nameKey(name), entry);
    return entry;
}

/**
 * The tree as a comparable list, children in name order.
 *
 * @param {import('./cfb.js').CfbEntry} entry
 * @param {string[]} [into]
 * @param {string} [prefix]
 */
function flatten(entry, into = [], prefix = ''){
    into.push(`${prefix}${entry.name} ${entry.kind} ${entry.clsid} ${entry.stateBits} `
        + `${entry.created} ${entry.modified} ${Buffer.from(entry.data).toString('hex')}`);
    for (const child of [...entry.children.values()].sort((a, b)=>compareNames(a.name, b.name)))
    {
        flatten(child, into, `${prefix}${entry.name}/`);
    }
    return into;
}

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);

/**
 * The directory as the file holds it, for checking the tree the writer built.
 *
 * @param {Uint8Array} bytes
 */
function directoryOf(bytes){
    const fatSector = u32(bytes, 0x4c);
    const fat = new Uint32Array(128);
    for (let index = 0; index < 128; index++)
    {
        fat[index] = u32(bytes, 512 + fatSector * 512 + index * 4);
    }
    /** @type {{ name: string, red: boolean, left: number, right: number, child: number }[]} */
    const entries = [];
    for (let sector = u32(bytes, 0x30); sector !== 0xfffffffe; sector = fat[sector])
    {
        for (let slot = 0; slot < 4; slot++)
        {
            const at = 512 + sector * 512 + slot * 128;
            const units = Math.max(0, (bytes[at + 0x40] | (bytes[at + 0x41] << 8)) / 2 - 1);
            let name = '';
            for (let index = 0; index < units; index++)
            {
                const unit = bytes[at + index * 2] | (bytes[at + index * 2 + 1] << 8);
                name += String.fromCharCode(unit);
            }
            entries.push({
                name, red: bytes[at + 0x43] === 0,
                left: u32(bytes, at + 0x44), right: u32(bytes, at + 0x48),
                child: u32(bytes, at + 0x4c),
            });
        }
    }
    return entries;
}

test('a tree of storages and streams survives a write and a read', ()=>{
    const root = createRoot();
    root.clsid = CLSID_A;
    root.stateBits = 0x11;
    addStream(root, 'Small', new Uint8Array(100).map((_, index)=>index));
    addStream(root, 'AtCutoff', new Uint8Array(4096).fill(0x42));
    addStream(root, 'Big', new Uint8Array(5000).map((_, index)=>(index * 7) & 0xff));
    addStream(root, 'Empty', new Uint8Array(0));
    const sub = addStorage(root, 'Sub');
    sub.clsid = CLSID_B;
    sub.created = 0x01dcb35d3cf4a800n;
    sub.modified = 0x01dcb35d3cf4a801n;
    addStream(sub, 'inner', Uint8Array.of(1, 2, 3));
    const deeper = addStorage(sub, 'Deeper');
    addStream(deeper, 'x', new Uint8Array(65).fill(9));
    for (let index = 0; index < 40; index++)
    {
        addStream(root, `n${index}`, new Uint8Array(index));
    }

    const bytes = serializeCompoundFile(root);
    assert.equal(bytes.length % 512, 0, 'whole sectors');
    assert.ok(isCompoundFile(bytes));
    const back = parseCompoundFile(bytes);
    assert.ok(back);
    assert.deepEqual(flatten(back), flatten(root));
    // A stream of exactly the cutoff is not a mini stream: the FAT chain
    // for it starts at a regular sector.
    assert.equal(back.children.get('ATCUTOFF')?.data.length, 4096);
});

test('a file written by the Windows implementation reads as what was put in it', ()=>{
    const root = parseCompoundFile(windowsFixture());
    assert.ok(root);
    assert.equal(root.clsid, CLSID_A);
    assert.equal(root.stateBits, 5);
    assert.deepEqual([...root.children.keys()].sort(),
        ['BIG', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'SMALL', 'SUB']);
    const small = root.children.get('SMALL');
    assert.deepEqual(small?.data, new Uint8Array(100).map((_, index)=>index));
    const big = root.children.get('BIG');
    assert.deepEqual(big?.data, new Uint8Array(5000).map((_, index)=>(index * 7) & 0xff));
    for (let index = 1; index <= 9; index++)
    {
        assert.equal(root.children.get(`N${index}`)?.data.length, index);
    }
    const sub = root.children.get('SUB');
    assert.equal(sub?.kind, 'storage');
    assert.equal(sub?.clsid, CLSID_B);
    assert.deepEqual(sub?.children.get('INNER')?.data, Uint8Array.of(1, 2, 3));
    const deeper = sub?.children.get('DEEPER');
    assert.equal(deeper?.kind, 'storage');
    assert.equal(deeper?.clsid, GUID_NULL);
    assert.equal(deeper?.children.get('EMPTY')?.data.length, 0);
    // Windows stamps its storages; the times are FILETIMEs of this century.
    assert.ok(root.modified > 0x01c0000000000000n);
});

test('the Windows fixture rewritten by us reads back the same', ()=>{
    const root = /** @type {import('./cfb.js').CfbEntry} */ (parseCompoundFile(windowsFixture()));
    const again = parseCompoundFile(serializeCompoundFile(root));
    assert.ok(again);
    assert.deepEqual(flatten(again), flatten(root));
});

test('the directory the writer builds is an ordered red-black tree', ()=>{
    const root = createRoot();
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 17, 33])
    {
        root.children.clear();
        for (let index = 0; index < count; index++)
        {
            addStream(root, `s${index.toString(36)}`, new Uint8Array(1));
        }
        const entries = directoryOf(serializeCompoundFile(root));
        assert.equal(entries[0].name, 'Root Entry');
        assert.equal(entries[0].child !== 0xffffffff, true);

        /**
         * Every path from a node to a missing child passes the same number
         * of black nodes, no red node has a red child, and every left name
         * sorts before its parent and every right one after.
         *
         * @param {number} index @param {boolean} parentRed
         * @returns {number} the black height
         */
        const check = (index, parentRed)=>{
            if (index === 0xffffffff)
            {
                return 1;
            }
            const entry = entries[index];
            assert.ok(!(entry.red && parentRed), 'a red node has a red child');
            for (const side of ['left', 'right'])
            {
                const other = entry[/** @type {'left' | 'right'} */ (side)];
                if (other !== 0xffffffff)
                {
                    const order = compareNames(entries[other].name, entry.name);
                    assert.ok(side === 'left' ? order < 0 : order > 0, `${side} of ${entry.name}`);
                }
            }
            const left = check(entry.left, entry.red);
            const right = check(entry.right, entry.red);
            assert.equal(left, right, `black height under ${entry.name}`);
            return left + (entry.red ? 0 : 1);
        };
        assert.ok(!entries[entries[0].child].red, 'the root of the tree is black');
        check(entries[0].child, false);
    }
});

test('damage reads as no file rather than as a partial one', ()=>{
    const root = createRoot();
    addStream(root, 'a', new Uint8Array(5000).fill(1));
    const good = serializeCompoundFile(root);
    assert.ok(parseCompoundFile(good));

    assert.equal(parseCompoundFile(new Uint8Array(100)), null, 'too short');
    const wrongSignature = good.slice();
    wrongSignature[0] = 0;
    assert.equal(parseCompoundFile(wrongSignature), null);
    assert.equal(parseCompoundFile(good.subarray(0, 1024)), null, 'truncated');

    // The stream's chain made to point back at its own first sector.
    const looping = good.slice();
    const view = new DataView(looping.buffer);
    const fatSector = view.getUint32(0x4c, true);
    const directorySector = view.getUint32(0x30, true);
    const streamStart = view.getUint32(512 + directorySector * 512 + 128 + 0x74, true);
    view.setUint32(512 + fatSector * 512 + (streamStart + 1) * 4, streamStart, true);
    assert.equal(parseCompoundFile(looping), null, 'a looping chain');

    // A directory whose child index points outside the directory.
    const dangling = good.slice();
    new DataView(dangling.buffer).setUint32(512 + directorySector * 512 + 0x4c, 500, true);
    assert.equal(parseCompoundFile(dangling), null, 'a child that is not there');
});

test('a file too large for the header alone chains its FAT through DIFAT sectors', ()=>{
    const root = createRoot();
    // 109 FAT sectors cover 109 * 128 sectors; one byte more needs a 110th.
    const size = 109 * 128 * 512 + 1;
    addStream(root, 'huge', new Uint8Array(size).map((_, index)=>index & 0xff));
    const bytes = serializeCompoundFile(root);
    assert.ok(u32(bytes, 0x2c) > 109, 'more FAT sectors than the header holds');
    assert.equal(u32(bytes, 0x48), 1, 'one DIFAT sector');
    const back = parseCompoundFile(bytes);
    const data = back?.children.get('HUGE')?.data;
    assert.equal(data?.length, size);
    assert.equal(data?.[size - 1], (size - 1) & 0xff);
    assert.equal(data?.[123456], 123456 & 0xff);
});

test('a file that ends partway into its last sector reads, the rest of it as zeros', ()=>{
    // A package that shipped ended 352 bytes into the sector its last stream
    // ends in, and Windows opens it.
    const root = createRoot();
    const data = new Uint8Array(25440).fill(7);
    addStream(root, 'Large', data);
    const bytes = serializeCompoundFile(root);
    let end = bytes.length;
    while (bytes[end - 1] === 0)
    {
        end--;
    }
    assert.notEqual(end % 512, 0, 'the file ends inside a sector');
    const back = parseCompoundFile(bytes.slice(0, end));
    assert.ok(back);
    assert.deepEqual(back.children.get('LARGE')?.data, data);
});
