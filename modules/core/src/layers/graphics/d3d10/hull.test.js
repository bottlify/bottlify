/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDxbc } from './dxbc.js';
import { forkPhaseHullShader } from './shader-fixtures.js';
import { linkHull } from './wgsl.js';

test('a hull shader links as one compute program: each phase a function, the stage read from'
    + ' its declarations', ()=>{
    const linked = linkHull(/** @type {any} */ (parseDxbc(forkPhaseHullShader())));
    assert.deepEqual(linked.unsupported, []);
    assert.deepEqual(linked.stage, { domain: 'quad', partitioning: 0, output: 2, inputPoints: 1,
        outputPoints: 4, inputRegisters: 1, outputRegisters: 1, constantRegisters: 7 });
    for (const phase of [0, 1, 2, 3])
    {
        assert.match(linked.code, new RegExp(`fn hsPhase${phase}\\(\\)`));
    }
    assert.match(linked.code, /const icb_p0 = array/, 'the control point phase\'s constants');
    assert.match(linked.code, /pc\[r0\.xxxx\.x\]\.x = /, 'a fork instance writes through r0');
    assert.match(linked.code, /pc\[\(4u \+ r0\.xxxx\.x\)\]\.x = /, 'past the edges');
    assert.match(linked.code, /for \(var i = 0u; i < 4u; i\+\+\) \{\n\s+hsInstance = i;/);
    assert.match(linked.code, /vec4<f32>\(bitcast<f32>\(pc\[0\]\.x\), bitcast<f32>\(pc\[1\]\.x\)/,
        'the edge factors from the patch constants the signature names');
});
