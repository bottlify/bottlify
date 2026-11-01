/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constantBlocks, keptBlocks, vertexLayoutOf } from './programmable.js';
import { vertexBuffersOf } from './pipeline.js';
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

test('an element past its stream\'s stride reads the vertex\'s last bytes', ()=>{
    // One declaration naming four coordinate sets and a lightmap's at 24, bound
    // over a mesh of two sets at a stride of 16: the sets past the vertex, and
    // the lightmap's, read its last set (at 12), not the next vertex's first.
    const elements = [
        { Stream: 0, Offset: 0, Type: 2, Usage: 0, UsageIndex: 0 },
        { Stream: 1, Offset: 8, Type: 15, Usage: 5, UsageIndex: 0 },
        { Stream: 1, Offset: 16, Type: 15, Usage: 5, UsageIndex: 2 },
        { Stream: 1, Offset: 24, Type: 15, Usage: 10, UsageIndex: 0 },
    ];
    const wanted = [
        { location: 0, usage: 0, usageIndex: 0, register: 0 },
        { location: 1, usage: 5, usageIndex: 0, register: 1 },
        { location: 2, usage: 5, usageIndex: 2, register: 2 },
        { location: 3, usage: 10, usageIndex: 0, register: 3 },
    ];
    const { layout, error } = vertexLayoutOf(elements, wanted, 12, ()=>16);
    assert.equal(error, null);
    assert.deepEqual(layout?.streams, [{ stream: 1, stride: 16 }]);
    const buffers = vertexBuffersOf(12, layout?.attributes ?? [], layout?.streams);
    assert.deepEqual(buffers.map(buffer=>
        buffer.attributes.map(one=>[one.shaderLocation, one.offset])),
    [[[0, 0]], [[1, 8], [2, 12], [3, 12]]]);
});

test('an element wider than its stream\'s stride is still refused', ()=>{
    const { error } = vertexLayoutOf([{ Stream: 1, Offset: 0, Type: 3, Usage: 5, UsageIndex: 0 }],
        [{ location: 0, usage: 5, usageIndex: 0, register: 0 }], 12, ()=>8);
    assert.equal(error, 'element past the stride of 8');
});
