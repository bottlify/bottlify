/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameSpread } from './frame-window.mjs';

/** @param {number} index @param {number} ms */
const frame = (index, ms)=>({ index, ms });

test('only the frames that finished inside the window are counted', ()=>{
    // The profiler keeps a ring of the latest frames, and the ring is not the
    // window: frames 3 and 4 were drawn before it opened.
    const before = { frames: 5 };
    const after = { frames: 8, recentFrames: [3, 4, 5, 6, 7].map(at=>frame(at, at * 10)) };
    const spread = frameSpread(before, after);
    assert.deepEqual(spread.ms, [50, 60, 70]);
    assert.equal(spread.lines.join('\n').includes('median 60.00ms'), true);
});

test('a window with no frame in it says so instead of printing zeros', ()=>{
    const spread = frameSpread({ frames: 9 }, { frames: 9, recentFrames: [frame(8, 16)] });
    assert.deepEqual(spread.ms, []);
    assert.equal(spread.lines.some(line=>/0\.00ms/.test(line)), false, 'no invented median');
    assert.match(spread.lines.join('\n'), /no frame finished/);
});

test('a window longer than the ring says how much of it the figures cover', ()=>{
    const after = { frames: 400, recentFrames: [397, 398, 399].map(at=>frame(at, 20)) };
    const spread = frameSpread({ frames: 0 }, after);
    assert.equal(spread.ms.length, 3);
    assert.match(spread.lines.join('\n'), /last 3 of 400/);
});
