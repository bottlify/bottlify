/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PIECE_SIZE, bytesOf, createMemoryStore } from './memory-store.js';
import { createPageFile, createPageFileStore } from './page-file.js';
import { assembled } from './read-into.fixture.js';
import { pieceSpace } from './page-space.fixture.js';
import { cacheSpace } from '../../cache/module.js';

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
 * @param {number} seed @param {number} workingBytes @param {number} steps
 * @param {{ budget?: number }} [cache]
 */
async function differential(seed, workingBytes, steps, cache){
    const next = random(seed);
    const pick = (/** @type {number} */ n)=>Math.floor(next() * n);
    const memory = [createMemoryStore(), createMemoryStore()];
    const { keeper, space } = await pieceSpace(cacheSpace, cache);
    const pageFile = createPageFile(space, { workingBytes });
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
        assert.ok(pageFile.workingBytes() <= Math.max(workingBytes, PIECE_SIZE),
            `seed ${seed} step ${step}: ${pageFile.workingBytes()} held past the bound`);
    }
    for (const arm of [0, 1])
    {
        for (const entry of memory[arm].list().filter(listed=>!listed.directory))
        {
            assert.equal(digest(paged[arm].read(entry.path, 0, entry.size)),
                digest(memory[arm].read(entry.path, 0, entry.size)), `seed ${seed}: ${entry.path}`);
            for (const store of [paged[arm], memory[arm]])
            {
                const from = Math.floor(entry.size / 3);
                assert.equal(digest(assembled(store, entry.path, from, entry.size).bytes),
                    digest(memory[arm].read(entry.path, from, entry.size)),
                    `seed ${seed}: ${entry.path} by readInto`);
            }
        }
    }
    return { ...pageFile.diagnostics(), keeper: keeper.figures() };
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

test('seeded programs answer alike on the store in memory and on the page file', async()=>{
    for (let seed = 1; seed <= 12; seed++)
    {
        await differential(seed, 8 << 20, 220);
    }
});

test('they answer alike when nothing is held being written and the cache sends pieces to its disk',
    async()=>{
        let put = 0;
        let cooled = 0;
        let raised = 0;
        for (let seed = 101; seed <= 112; seed++)
        {
            const counts = await differential(seed, 0, 220, { budget: 4 << 20 });
            put += counts.put;
            cooled += counts.keeper.cooled;
            raised += counts.keeper.raised;
        }
        assert.ok(put > 500, `${put} pieces put in the cache`);
        assert.ok(cooled > 100, `${cooled} bodies went cold to the disk`);
        assert.ok(raised > 0, `${raised} brought back from it`);
    });

test('what is held in memory stays within the bound being written; the rest are the cache\'s '
    + 'bodies, read in place', async()=>{
    const { keeper, space } = await pieceSpace(cacheSpace, { budget: 16 << 20 });
    const bound = 4 * PIECE_SIZE;
    const pageFile = createPageFile(space, { workingBytes: bound });
    const store = createPageFileStore(pageFile);
    const chunk = new Uint8Array(32 * 1024);
    for (let at = 0; at < 64 * PIECE_SIZE; at += chunk.length)
    {
        chunk.fill((at / chunk.length) & 0xff);
        store.write('setup.cab', at, chunk);
        assert.ok(pageFile.workingBytes() <= bound);
    }
    assert.equal(store.heldBytes?.(), pageFile.workingBytes());
    const kept = keeper.under('pages/');
    assert.equal(kept.bodies, 64 - 4, 'each piece written out a body of the cache');
    assert.equal(kept.bytes, 60 * PIECE_SIZE);
    assert.equal(pageFile.diagnostics().put, 60, 'each put once, not once a write');
    assert.ok(keeper.figures().cooled > 40, 'past the budget the cache sent them to its disk');
    assert.deepEqual([...store.read('setup.cab', 5 * PIECE_SIZE + 32 * 1024 - 1, 2)],
        [(5 * 32 + 0) & 0xff, (5 * 32 + 1) & 0xff]);
    // Written again, pieces the cache holds come back into memory: each piece
    // is in one place, never both, so every byte of the file is held once.
    for (let index = 0; index < 64; index += 3)
    {
        store.write('setup.cab', index * PIECE_SIZE + 7, Uint8Array.of(1));
        assert.equal(keeper.under('pages/').bytes + pageFile.workingBytes(), 64 * PIECE_SIZE,
            `piece ${index} written again: held once`);
    }
});

test('a piece one write fills whole is put in the cache from where its bytes lie, nothing of it '
    + 'held in memory; one filled a write at a time is held until put', async()=>{
    const { keeper, space } = await pieceSpace(cacheSpace, { budget: 16 << 20 });
    const pageFile = createPageFile(space, { workingBytes: 8 * PIECE_SIZE });
    const store = createPageFileStore(pageFile);
    // A file laid down whole - a session's file restored, a copy - in one write.
    const whole = Uint8Array.from({ length: 4 * PIECE_SIZE + 100 }, (_, at)=>(at * 7) & 0xff);
    store.write('lib.dll', 0, whole);
    assert.equal(pageFile.diagnostics().workingPieces, 1,
        'only the piece the write did not fill is held');
    assert.equal(keeper.under('pages/').bodies, 4, 'the four whole pieces are bodies at once');
    assert.deepEqual(store.read('lib.dll', 0, whole.length), whole, 'read back as written');
    // Written into again, a whole piece comes back into memory as before.
    store.write('lib.dll', PIECE_SIZE + 3, Uint8Array.of(9));
    assert.equal(store.read('lib.dll', PIECE_SIZE + 3, 1)[0], 9);
    assert.deepEqual([keeper.under('pages/').bodies, pageFile.diagnostics().workingPieces], [3, 2],
        'every piece in one place');
});

test('once the cache has no room, a piece written again is held once, and pieces go back to the '
    + 'cache once it has room again', async()=>{
    // No disk: the cache's memory is all it has, as a run with no folder.
    const { keeper, space } = await pieceSpace(cacheSpace, { budget: 2 * PIECE_SIZE, disk: false });
    const pageFile = createPageFile(space, { workingBytes: PIECE_SIZE });
    const store = createPageFileStore(pageFile);
    const held = ()=>keeper.under('pages/').bytes + pageFile.workingBytes();
    // Each piece a half at a time: filled a write at a time, held until put.
    const half = PIECE_SIZE / 2;
    for (let index = 0; index < 6; index++)
    {
        store.write('big.bin', index * PIECE_SIZE, new Uint8Array(half).fill(index + 1));
        store.write('big.bin', index * PIECE_SIZE + half, new Uint8Array(half).fill(index + 1));
    }
    assert.ok(pageFile.diagnostics().refused);
    assert.equal(pageFile.diagnostics().stalled, true);
    for (let index = 0; index < 6; index++)
    {
        store.write('big.bin', index * PIECE_SIZE + 1, Uint8Array.of(9));
        assert.equal(held(), 6 * PIECE_SIZE, `piece ${index} written again: held once`);
    }
    // The file goes: its bodies with it, and the next file's pieces are put.
    store.remove('big.bin');
    for (let at = 0; at < 3 * PIECE_SIZE; at += half)
    {
        store.write('next.bin', at, new Uint8Array(half).fill(5));
    }
    assert.equal(pageFile.workingBytes(), PIECE_SIZE, 'within the bound again');
    assert.equal(keeper.under('pages/').bytes, 2 * PIECE_SIZE, 'the rest put in the cache');
    assert.equal(pageFile.diagnostics().stalled, false);
    assert.equal(store.read('next.bin', 2 * PIECE_SIZE + 3, 1)[0], 5);
});

test('a file removed lets its bodies go, and the cache holds nothing of it', async()=>{
    const { keeper, space } = await pieceSpace(cacheSpace);
    const pageFile = createPageFile(space, { workingBytes: 2 * PIECE_SIZE });
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
    assert.equal(keeper.under('pages/').bodies, 0);
    assert.equal(pageFile.workingBytes(), 0, 'a file removed holds nothing');
});

test('a small file costs a small body, not a whole piece', async()=>{
    const { keeper, space } = await pieceSpace(cacheSpace);
    const pageFile = createPageFile(space, { workingBytes: 0 });
    const store = createPageFileStore(pageFile);
    for (let index = 0; index < 100; index++)
    {
        store.write(`small${index}.ini`, 0, new Uint8Array(300).fill(index));
    }
    assert.equal(keeper.under('pages/').bytes, 100 * 4096);
    assert.deepEqual([...store.read('small42.ini', 299, 2)], [42]);
});

test('contents handed out keep their bytes, and are copied a piece at a time, not whole', async()=>{
    const { space } = await pieceSpace(cacheSpace);
    const pageFile = createPageFile(space, { workingBytes: 0 });
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

test('a put the cache has no room for is said once, and what was written stays readable', async()=>{
    // A budget of two pieces and a disk of one: the cache holds three pieces' bodies at most.
    const { space } = await pieceSpace(cacheSpace,
        { budget: 2 * PIECE_SIZE, quota: PIECE_SIZE + 65536 });
    /** @type {Error[]} */
    const said = [];
    const pageFile = createPageFile(space, { workingBytes: PIECE_SIZE,
        onFailure: error=>said.push(error) });
    const store = createPageFileStore(pageFile);
    for (let index = 0; index < 6; index++)
    {
        store.write('big.bin', index * PIECE_SIZE, new Uint8Array(PIECE_SIZE).fill(index + 1));
    }
    assert.equal(said.length, 1);
    assert.match(pageFile.diagnostics().refused ?? '', /no room/);
    const before = pageFile.diagnostics().takenOut;
    for (let index = 0; index < 6; index++)
    {
        assert.equal(store.read('big.bin', index * PIECE_SIZE + 9, 1)[0], index + 1);
    }
    // The piece its disk took is brought back for room this file's own hot
    // pieces made, taken into memory: the cache's memory was all only copies.
    assert.ok(pageFile.diagnostics().takenOut > before, 'pieces taken out of the cache for room');
});

test('the page file is done once the contents a save still reads are released', async()=>{
    const { space } = await pieceSpace(cacheSpace);
    let closed = 0;
    const pageFile = createPageFile(space, { workingBytes: 0, onClosed: ()=>closed++ });
    const store = createPageFileStore(pageFile);
    store.write('a', 0, new Uint8Array(10000).fill(9));
    const contents = /** @type {any} */ (store.contents)?.('a');
    pageFile.close();
    assert.equal(closed, 0, 'a save under way reads to the end');
    assert.equal(contents.paged.read(9999, 1)[0], 9);
    contents.paged.release();
    assert.equal(closed, 1);
});
