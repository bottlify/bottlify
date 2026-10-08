/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passedSamples, reachableArea } from './occlusion.js';

test('a draw reaches its viewport, cut to the scissor', ()=>{
    assert.equal(reachableArea({ x: 1, y: 1, width: 6, height: 5 }), 30);
    assert.equal(reachableArea({ x: 1, y: 1, width: 6, height: 5 },
        { x: 2, y: 2, width: 2, height: 3 }), 6);
    assert.equal(reachableArea({ x: 0, y: 0, width: 4, height: 4 },
        { x: 3, y: 3, width: 10, height: 10 }), 1, 'only the overlap');
    assert.equal(reachableArea({ x: 0, y: 0, width: 4, height: 4 },
        { x: 8, y: 8, width: 2, height: 2 }), 0, 'none outside');
    assert.equal(reachableArea({ width: 8, height: 8 }), 64, 'a target, from its corner');
});

test('a 1 from the GPU is every pixel the draw could reach; a count above one stands', ()=>{
    assert.deepEqual(passedSamples(1, 30), { samples: 30, assumed: true });
    assert.deepEqual(passedSamples(0, 30), { samples: 0, assumed: false });
    assert.deepEqual(passedSamples(17, 30), { samples: 17, assumed: false });
    assert.deepEqual(passedSamples(1, 1), { samples: 1, assumed: false }, 'a one-pixel draw');
});
