/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBufferReads } from './buffer-reads.js';

/** A read set over frames whose flush the test decides. */
function rig(){
    const unflushed = new Set([1]);
    const reads = createBufferReads(frame=>unflushed.has(frame));
    return { unflushed, reads };
}

test('a write over a byte an unflushed frame read overlaps; one beside it does not', ()=>{
    const { reads } = rig();
    reads.note(1, 100, 200);
    reads.note(1, 400, 500);
    assert.equal(reads.overlaps(150, 160), true);
    assert.equal(reads.overlaps(450, 600), true);
    assert.equal(reads.overlaps(200, 400), false, 'the gap between two ranges');
    assert.equal(reads.overlaps(0, 100), false, 'ending where a range starts');
    assert.equal(reads.overlaps(500, 510), false, 'starting where one ends');
});

test('a flushed frame\'s reads overlap nothing, and are dropped at the next frame\'s first read',
    ()=>{
        const { unflushed, reads } = rig();
        for (let draw = 0; draw < 50; draw++)
        {
            reads.note(1, draw * 64, draw * 64 + 32);
        }
        assert.equal(reads.stats().ranges, 50);
        unflushed.delete(1);
        unflushed.add(2);
        reads.note(2, 0, 32);
        assert.equal(reads.stats().ranges, 1,
            'a buffer drawn every frame and never written keeps one frame of ranges');
        assert.equal(reads.overlaps(64, 96), false, 'frame 1 read that, and is flushed');
        assert.equal(reads.overlaps(0, 4), true);
    });

test('a draw reading on from where the last one stopped extends its range', ()=>{
    const { reads } = rig();
    reads.note(1, 0, 96);
    reads.note(1, 96, 192);
    reads.note(1, 64, 128);
    assert.equal(reads.stats().ranges, 1);
    assert.equal(reads.overlaps(180, 190), true);
});

test('writes at rising offsets past everything a frame read compare against no range', ()=>{
    // A vertex cache: each draw's vertices written just past the last draw's,
    // then drawn. Every write lies past the frame's hull.
    const { reads } = rig();
    let offset = 0;
    for (let draw = 0; draw < 1000; draw++)
    {
        assert.equal(reads.overlaps(offset, offset + 48), false);
        reads.note(1, offset, offset + 48);
        offset += 64;
    }
    assert.equal(reads.stats().examined, 0);
});

test('a rename clears every frame\'s ranges', ()=>{
    const { unflushed, reads } = rig();
    unflushed.add(2);
    reads.note(1, 0, 10);
    reads.note(2, 20, 30);
    reads.clear();
    assert.equal(reads.overlaps(0, 100), false);
    assert.equal(reads.stats().ranges, 0);
});
