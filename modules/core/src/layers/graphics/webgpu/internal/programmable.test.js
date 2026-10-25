/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constantBlocks, keptBlocks } from './programmable.js';
import { createUniformArena } from '../../d3d8/render.js';
import { CONSTANT_FILE, createConstantFile } from '../../d3d9/shader.js';

/**
 * An arena whose array holds an earlier frame's floats, as one does once it
 * has been reset: what a block does not write reads those, unless cleared.
 */
const usedArena = ()=>{
    const arena = createUniformArena(4096);
    arena.take(4096).fill(9);
    arena.reset();
    return arena;
};

test('a float block the file covers is its leading registers as they are now', ()=>{
    const arena = usedArena();
    const file = createConstantFile(CONSTANT_FILE.vertex);
    file.setF(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 3);
    const kept = keptBlocks();
    const [first] = constantBlocks(file, 3, arena.take, kept, arena.serial);
    assert.deepEqual([...first], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // The same reach again reads the file's registers as set since, not as
    // the last block had them.
    file.setF(1, [-1, -2, -3, -4], 1);
    const [second] = constantBlocks(file, 3, arena.take, kept, arena.serial);
    assert.deepEqual([...second], [1, 2, 3, 4, -1, -2, -3, -4, 9, 10, 11, 12]);
    assert.deepEqual([...first], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        'a block taken before keeps what it was');
    const [fewer] = constantBlocks(file, 1, arena.take, kept, arena.serial);
    assert.deepEqual([...fewer], [1, 2, 3, 4]);
    const [none] = constantBlocks(file, 0, arena.take, kept, arena.serial);
    assert.deepEqual([...none], [1, 2, 3, 4], 'a block is never empty');
});

test('a float block reaching past the file reads zero past it', ()=>{
    for (const kept of [keptBlocks(), undefined])
    {
        const arena = usedArena();
        const file = createConstantFile(CONSTANT_FILE.vertex);
        file.floats.fill(1);
        const [block] = constantBlocks(file, CONSTANT_FILE.vertex.floats + 2, arena.take, kept,
            arena.serial);
        assert.equal(block.length, file.floats.length + 8);
        assert.ok(block.subarray(0, file.floats.length).every(value=>value === 1));
        assert.deepEqual([...block.subarray(file.floats.length)], [0, 0, 0, 0, 0, 0, 0, 0]);
    }
});

test('another file of the same stage is copied from, not the first one\'s views', ()=>{
    const arena = usedArena();
    const kept = keptBlocks();
    const one = createConstantFile(CONSTANT_FILE.pixel);
    const other = createConstantFile(CONSTANT_FILE.pixel);
    one.setF(0, [1, 1, 1, 1, 2, 2, 2, 2], 2);
    other.setF(0, [3, 3, 3, 3, 4, 4, 4, 4], 2);
    assert.deepEqual([...constantBlocks(one, 2, arena.take, kept, arena.serial)[0]],
        [1, 1, 1, 1, 2, 2, 2, 2]);
    assert.deepEqual([...constantBlocks(other, 2, arena.take, kept, arena.serial)[0]],
        [3, 3, 3, 3, 4, 4, 4, 4]);
});
