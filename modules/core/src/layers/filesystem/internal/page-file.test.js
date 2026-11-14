/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PIECE_SIZE, bytesOf, createMemoryStore } from './memory-store.js';
import { createPageFile, createPageFileStore, openPageFile } from './page-file.js';

/**
 * A synchronous access handle over memory, as a worker's
 * FileSystemSyncAccessHandle answers: what was written, read back at the
 * same place, zeroes where nothing was.
 *
 * @param {{ failWritesAfter?: number }} [options]
 */
function fakeAccess({ failWritesAfter = Infinity } = {}){
    let bytes = new Uint8Array(0);
    let size = 0;
    let writes = 0;
    const access = {
        closed: false,
        getSize: ()=>size,
        /** @param {Uint8Array} into @param {{ at: number }} where */
        read(into, { at }){
            const length = Math.max(0, Math.min(into.length, size - at));
            into.set(bytes.subarray(at, at + length));
            into.fill(0, length);
            return into.length;
        },
        /** @param {Uint8Array} from @param {{ at: number }} where */
        write(from, { at }){
            if (++writes > failWritesAfter)
            {
                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            }
            if (at + from.length > bytes.length)
            {
                const grown = new Uint8Array(Math.max(at + from.length, bytes.length * 2));
                grown.set(bytes.subarray(0, size));
                bytes = grown;
            }
            bytes.set(from, at);
            size = Math.max(size, at + from.length);
            return from.length;
        },
        flush(){},
        close(){
            access.closed = true;
        },
    };
    return access;
}

/** A seeded generator (mulberry32): the same programs every run. @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Bytes compared by their digest: a deep comparison of a mebibyte is seconds. @param {Uint8Array} bytes */
const digest = bytes=>`${bytes.length}:${createHash('sha1').update(bytes).digest('hex')}`;

/** @param {() => any} action */
const answer = action=>{
    try
    {
        const result = action();
        return result instanceof Uint8Array ? { bytes: digest(result) } : { result };
    }
    catch (e){
        return { error: /** @type {any} */ (e).code ?? /** @type {any} */ (e).message };
    }
};

/**
 * Runs one seeded program of creates, writes, reads, truncations, deletions,
 * renames and contents handed between two stores against both arms, and
 * holds every answer, every listing and every file's bytes equal.
 *
 * @param {number} seed @param {number} residentBytes @param {number} steps
 */
function differential(seed, residentBytes, steps){
    const next = random(seed);
    const pick = (/** @type {number} */ n)=>Math.floor(next() * n);
    const memory = [createMemoryStore(), createMemoryStore()];
    const pageFile = createPageFile(fakeAccess(), { residentBytes });
    const paged = [createPageFileStore(pageFile), createPageFileStore(pageFile)];
    const names = ['a', 'b', 'c', 'd\\x', 'd\\y', 'e\\f\\g'];
    const directories = ['d', 'e', 'e\\f'];
    /** @type {{ memory: any, paged: any, bytes: string }[]} */
    const handed = [];
    /** A length: mostly a guest's small writes, now and then a piece or more. */
    const lengthOf = ()=>{
        const kind = pick(10);
        return kind < 6 ? pick(5000) : kind < 9 ? pick(70000) : pick(PIECE_SIZE + 300000);
    };
    /** Where: inside the first piece, across a boundary, or well past it. */
    const offsetOf = ()=>{
        const kind = pick(4);
        return kind === 0 ? pick(9000) : kind === 1 ? PIECE_SIZE - pick(3000)
            : kind === 2 ? pick(3 * PIECE_SIZE) : 2 * PIECE_SIZE + pick(5000);
    };
    for (let step = 0; step < steps; step++)
    {
        const side = pick(2);
        const name = names[pick(names.length)];
        const operation = pick(14);
        /** @type {(store: any, arm: number) => any} */
        let action;
        /** @type {string} */
        let label;
        if (operation < 4)
        {
            const offset = offsetOf();
            const bytes = new Uint8Array(lengthOf());
            let word = (next() * 4294967296) >>> 0;
            for (let at = 0; at < bytes.length; at++)
            {
                word ^= word << 13;
                word ^= word >>> 17;
                word ^= word << 5;
                bytes[at] = word;
            }
            label = `write ${name} ${offset} ${bytes.length}`;
            action = store=>store.write(name, offset, bytes);
        }
        else if (operation < 7)
        {
            const offset = offsetOf();
            const length = lengthOf();
            label = `read ${name} ${offset} ${length}`;
            action = store=>store.read(name, offset, length);
        }
        else if (operation === 7)
        {
            const size = pick(3) === 0 ? 0 : offsetOf();
            label = `truncate ${name} ${size}`;
            action = store=>store.truncate(name, size);
        }
        else if (operation === 8)
        {
            label = `remove ${name}`;
            action = store=>store.remove(name);
        }
        else if (operation === 9)
        {
            const directory = directories[pick(directories.length)];
            label = `mkdir ${directory}`;
            action = store=>store.mkdir(directory);
        }
        else if (operation === 10)
        {
            const to = names[pick(names.length)];
            label = `move ${name} ${to}`;
            action = store=>store.move(name, to);
        }
        else if (operation === 11)
        {
            label = `stat ${name}`;
            action = store=>store.stat(name);
        }
        else if (operation === 12)
        {
            // Handed out, and kept to be taken in elsewhere later: what one
            // store answers must not move with the other's writes.
            label = `contents ${name}`;
            const taken = { memory: /** @type {any} */ (null), paged: /** @type {any} */ (null),
                bytes: '' };
            action = (store, arm)=>{
                const contents = store.contents(name);
                taken[arm === 0 ? 'memory' : 'paged'] = contents;
                taken.bytes = digest(bytesOf(contents));
                return contents.size;
            };
            const before = handed.length;
            queueCheck(()=>{
                if (taken.memory && taken.paged)
                {
                    handed.push(taken);
                }
                return handed.length - before;
            });
        }
        else
        {
            const which = handed[pick(handed.length)];
            if (!which)
            {
                continue;
            }
            label = `adopt ${name}`;
            action = (store, arm)=>{
                const contents = arm === 0 ? which.memory : which.paged;
                assert.equal(digest(bytesOf(contents)), which.bytes,
                    `seed ${seed} step ${step}: contents handed out changed after`);
                store.adoptContents(name, contents);
            };
            if (pick(3) === 0)
            {
                // Released once taken in: the copy stays the store's.
                queueCheck(()=>{
                    which.paged.paged.release();
                    handed.splice(handed.indexOf(which), 1);
                    return 0;
                });
            }
        }
        const expected = answer(()=>action(memory[side], 0));
        const actual = answer(()=>action(paged[side], 1));
        runChecks();
        assert.deepEqual(actual, expected, `seed ${seed} step ${step}: ${label}`);
        for (const arm of [0, 1])
        {
            assert.deepEqual(paged[arm].list(), memory[arm].list(),
                `seed ${seed} step ${step}: listing after ${label}`);
        }
        assert.ok(pageFile.residentBytes() <= Math.max(residentBytes, PIECE_SIZE),
            `seed ${seed} step ${step}: ${pageFile.residentBytes()} held past the pool`);
    }
    for (const arm of [0, 1])
    {
        for (const entry of memory[arm].list().filter(listed=>!listed.directory))
        {
            assert.equal(digest(paged[arm].read(entry.path, 0, entry.size)),
                digest(memory[arm].read(entry.path, 0, entry.size)), `seed ${seed}: ${entry.path}`);
        }
    }
    return pageFile.diagnostics();
}

/** @type {(() => unknown)[]} */
const checks = [];
/** @param {() => unknown} check */
const queueCheck = check=>checks.push(check);
const runChecks = ()=>{
    for (const check of checks.splice(0))
    {
        check();
    }
};

test('seeded programs answer alike on the store in memory and on the page file', ()=>{
    for (let seed = 1; seed <= 12; seed++)
    {
        differential(seed, 64 * 1024 * 1024, 220);
    }
});

test('they answer alike when the pool holds next to nothing and every piece goes to the disk', ()=>{
    let evicted = 0;
    let readBytes = 0;
    for (let seed = 101; seed <= 112; seed++)
    {
        const counts = differential(seed, 8192, 220);
        evicted += counts.evicted;
        readBytes += counts.readBytes;
    }
    assert.ok(evicted > 1000, `${evicted} pieces let go of`);
    assert.ok(readBytes > 0, 'pieces read back');
});

test('what is held stays within the pool however much is written', ()=>{
    const access = fakeAccess();
    const pool = 4 * PIECE_SIZE;
    const pageFile = createPageFile(access, { residentBytes: pool });
    const store = createPageFileStore(pageFile);
    const chunk = new Uint8Array(32 * 1024);
    for (let at = 0; at < 64 * PIECE_SIZE; at += chunk.length)
    {
        chunk.fill((at / chunk.length) & 0xff);
        store.write('setup.cab', at, chunk);
        assert.ok(pageFile.residentBytes() <= pool);
    }
    assert.equal(store.heldBytes?.(), pageFile.residentBytes());
    assert.equal(access.getSize(), 64 * PIECE_SIZE - pool, 'what is not held is on the disk');
    assert.deepEqual([...store.read('setup.cab', 5 * PIECE_SIZE + 32 * 1024 - 1, 2)],
        [(5 * 32 + 0) & 0xff, (5 * 32 + 1) & 0xff]);
});

test('a file removed gives its extents to the next one, and the file does not grow', ()=>{
    const access = fakeAccess();
    const pageFile = createPageFile(access, { residentBytes: 2 * PIECE_SIZE });
    const store = createPageFileStore(pageFile);
    const piece = new Uint8Array(PIECE_SIZE).fill(7);
    for (let round = 0; round < 5; round++)
    {
        for (let index = 0; index < 8; index++)
        {
            store.write(`temp${round}.tmp`, index * PIECE_SIZE, piece);
        }
        store.remove(`temp${round}.tmp`);
    }
    assert.ok(access.getSize() <= 8 * PIECE_SIZE, `${access.getSize()} bytes of page file`);
    assert.equal(pageFile.residentBytes(), 0, 'a file removed holds nothing');
});

test('a small file costs a small extent, not a whole piece', ()=>{
    const access = fakeAccess();
    const pageFile = createPageFile(access, { residentBytes: 0 });
    const store = createPageFileStore(pageFile);
    for (let index = 0; index < 100; index++)
    {
        store.write(`small${index}.ini`, 0, new Uint8Array(300).fill(index));
    }
    assert.equal(access.getSize(), 100 * 4096);
    assert.deepEqual([...store.read('small42.ini', 299, 2)], [42]);
});

test('contents handed out keep their bytes, and are copied a piece at a time, not whole', ()=>{
    const pageFile = createPageFile(fakeAccess(), { residentBytes: 0 });
    const store = createPageFileStore(pageFile);
    store.write('save.dat', 0, new Uint8Array(3 * PIECE_SIZE).fill(1));
    const contents = /** @type {any} */ (store.contents)?.('save.dat');
    store.write('save.dat', PIECE_SIZE + 5, Uint8Array.of(2));
    assert.equal(pageFile.diagnostics().copied, 1, 'only the piece written was copied');
    assert.equal(contents.paged.piece(1)[5], 1, 'the contents are what they were');
    assert.equal(store.read('save.dat', PIECE_SIZE + 5, 1)[0], 2);
    contents.paged.release();
    store.write('save.dat', PIECE_SIZE + 6, Uint8Array.of(3));
    assert.equal(pageFile.diagnostics().copied, 1, 'released, nothing more is copied');
    assert.throws(()=>contents.paged.read(0, 1), /released/);
});

test('a write the disk refuses is said once, and what was written stays readable', ()=>{
    /** @type {Error[]} */
    const said = [];
    const pageFile = createPageFile(fakeAccess({ failWritesAfter: 2 }),
        { residentBytes: PIECE_SIZE, onFailure: error=>said.push(error) });
    const store = createPageFileStore(pageFile);
    for (let index = 0; index < 6; index++)
    {
        store.write('big.bin', index * PIECE_SIZE, new Uint8Array(PIECE_SIZE).fill(index + 1));
    }
    assert.equal(said.length, 1);
    assert.match(pageFile.diagnostics().failed ?? '', /quota/);
    for (let index = 0; index < 6; index++)
    {
        assert.equal(store.read('big.bin', index * PIECE_SIZE + 9, 1)[0], index + 1);
    }
});

test('the file closes once the contents a save still reads are released', ()=>{
    const access = fakeAccess();
    let closed = 0;
    const pageFile = createPageFile(access, { residentBytes: 0, onClosed: ()=>closed++ });
    const store = createPageFileStore(pageFile);
    store.write('a', 0, new Uint8Array(10000).fill(9));
    const contents = /** @type {any} */ (store.contents)?.('a');
    pageFile.close();
    assert.equal(closed, 0, 'a save under way reads to the end');
    assert.equal(contents.paged.read(9999, 1)[0], 9);
    contents.paged.release();
    assert.equal(closed, 1);
    assert.ok(access.closed);
});

test('a page file is opened in a folder of its own, and one left behind is taken away', async()=>{
    /** @type {Map<string, any>} */
    const files = new Map();
    const folder = {
        /** @param {string} name */
        getFileHandle: async name=>{
            const access = fakeAccess();
            files.set(name, access);
            return { createSyncAccessHandle: async()=>access };
        },
        async* entries(){
            yield* files;
        },
        /** @param {string} name */
        removeEntry: async name=>{
            files.delete(name);
        },
    };
    files.set('old.pages', fakeAccess());
    const root = { getDirectoryHandle: async()=>folder };
    const pageFile = await openPageFile({ root, residentBytes: 0 });
    assert.ok(pageFile);
    assert.ok(!files.has('old.pages'), 'a run that is gone left it');
    assert.equal(files.size, 1);
    pageFile.close();
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.equal(files.size, 0, 'the run\'s own file goes with it');
});

test('there is no page file where nothing answers synchronously', async()=>{
    const folder = {
        getFileHandle: async()=>({}),
        async* entries(){},
        removeEntry: async()=>{},
    };
    assert.equal(await openPageFile({ root: { getDirectoryHandle: async()=>folder } }), null);
});
