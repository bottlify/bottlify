/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runModeOf, withRunMode } from './mode.js';

test('auto takes full where memory can be shared and safe where it cannot', ()=>{
    assert.equal(runModeOf(undefined, true), 'isolated');
    assert.equal(runModeOf('auto', true), 'isolated');
    assert.equal(runModeOf(undefined, false), 'compatible');
    assert.equal(runModeOf('auto', false), 'compatible');
});

test('a mode asked for is the mode run, and full without shared memory is refused', ()=>{
    assert.equal(runModeOf('compatible', true), 'compatible');
    assert.equal(runModeOf('compatible', false), 'compatible');
    assert.equal(runModeOf('isolated', true), 'isolated');
    assert.throws(()=>runModeOf('isolated', false), /cross-origin isolated/);
    assert.throws(()=>runModeOf(/** @type {any} */ ('fast'), true), /unknown mode/);
});

test('safe turns shared guest memory and lending off over whatever the caller set', ()=>{
    const options = { mode: /** @type {const} */ ('compatible'),
        cork: { config: { sharedMemory: true, hotThreshold: 9 }, moduleUrl: 'x' },
        graphics: { lendMemory: true, compressedTextures: true } };
    const settled = withRunMode(options, true);
    assert.equal(settled.mode, 'compatible');
    assert.deepEqual(settled.cork, { config: { sharedMemory: false, hotThreshold: 9 },
        moduleUrl: 'x' });
    assert.deepEqual(settled.graphics, { lendMemory: false, compressedTextures: true });
    assert.equal(options.cork.config.sharedMemory, true, 'the caller\'s options are not changed');
});

test('full leaves the caller\'s settings as they are', ()=>{
    const settled = withRunMode({ graphics: { lendMemory: false } }, true);
    assert.equal(settled.mode, 'isolated');
    assert.deepEqual(settled.graphics, { lendMemory: false });
});

test('concurrency is 1, 2 or 4 processes at once: 1 unless asked, and more than one where'
    + ' memory cannot be shared falls back to compatible, one at a time, and says so', ()=>{
    const one = withRunMode({}, true);
    assert.deepEqual([one.concurrency, one.fallback], [1, null]);
    assert.equal(withRunMode({}, false).concurrency, 1);
    const two = withRunMode({ concurrency: 2, graphics: { lendMemory: true } }, true);
    assert.deepEqual([two.mode, two.concurrency, two.fallback], ['isolated', 2, null],
        'auto takes isolated');
    assert.deepEqual(two.graphics, { lendMemory: true }, 'the caller\'s settings stand');
    assert.equal(withRunMode({ mode: 'isolated', concurrency: 4 }, true).concurrency, 4);
    for (const [options, shareable, why] of /** @type {[any, boolean, RegExp][]} */ ([
        [{ concurrency: 2 }, false, /not cross-origin isolated/],
        [{ mode: 'compatible', concurrency: 4 }, true, /asked for "compatible"/]]))
    {
        const settled = withRunMode({ ...options, cork: { config: { sharedMemory: true } } },
            shareable);
        assert.deepEqual([settled.mode, settled.concurrency], ['compatible', 1]);
        assert.equal(settled.cork.config.sharedMemory, false, 'compatible as if asked for');
        assert.deepEqual(settled.fallback?.asked,
            { mode: options.mode, concurrency: options.concurrency });
        assert.match(settled.fallback?.detail ?? '',
            new RegExp(`concurrency ${options.concurrency} is not allowed here`));
        assert.match(settled.fallback?.detail ?? '', why);
    }
    for (const asked of [0, 3, 8, '2'])
    {
        assert.throws(()=>withRunMode({ concurrency: /** @type {any} */ (asked) }, true),
            /concurrency is 1, 2 or 4/);
    }
    assert.throws(()=>runModeOf(/** @type {any} */ ('workers'), true), /unknown mode/,
        'the old mode is gone: concurrency says it');
});
