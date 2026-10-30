/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findWallBounds } from './check-wall-bounds.mjs';

test('a wall time kept under a figure is found, read straight off the clock or worked out', ()=>{
    const source = [
        'const before = performance.now();',
        'await wait();',
        'assert.ok(performance.now() - before < 100, \'short\');',
        'const took = Date.now() - before;',
        'const seconds = took / 1000;',
        `assert.ok(code === 0 && seconds < 30, \`${'$'}{seconds}\`);`,
        'assert(5000 > took);',
        'const run = { code, ms: took };',
        'const rate = run.instructions / run.ms;',
        'const otherRate = other.instructions / other.ms;',
        'assert.ok(rate > otherRate);',
    ].join('\n');
    assert.deepEqual(findWallBounds(source), ['performance.now() - before < 100', 'seconds < 30',
        '5000 > took', 'rate > otherRate']);
});

test('what load cannot break passes: a wait kept above a figure, an instant below a later'
    + ' stamp, a count under a bound that grows with the wall time, processor time', ()=>{
    const source = [
        'const before = Date.now();',
        'const stamp = now();',
        'assert.ok(stamp >= before && stamp < Date.now() + 1);',
        'const ms = performance.now() - before;',
        'assert.ok(ms >= 15, \'waited\');',
        'assert.ok(slices < ms * 3);',
        'const cpu = threadCpuMs() - began;',
        'assert.ok(cpu < 100);',
        '// assert.ok(performance.now() - before < 100);',
        `assert.ok(count < 10, \`${'$'}{performance.now() - before} ms\`);`,
    ].join('\n');
    assert.deepEqual(findWallBounds(source), []);
});
