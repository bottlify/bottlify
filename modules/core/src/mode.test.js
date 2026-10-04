/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runModeOf, withRunMode } from './mode.js';

test('auto takes full where memory can be shared and safe where it cannot', ()=>{
    assert.equal(runModeOf(undefined, true), 'full');
    assert.equal(runModeOf('auto', true), 'full');
    assert.equal(runModeOf(undefined, false), 'safe');
    assert.equal(runModeOf('auto', false), 'safe');
});

test('a mode asked for is the mode run, and full without shared memory is refused', ()=>{
    assert.equal(runModeOf('safe', true), 'safe');
    assert.equal(runModeOf('safe', false), 'safe');
    assert.equal(runModeOf('full', true), 'full');
    assert.throws(()=>runModeOf('full', false), /cross-origin isolated/);
    assert.throws(()=>runModeOf(/** @type {any} */ ('fast'), true), /unknown mode/);
});

test('safe turns shared guest memory and lending off over whatever the caller set', ()=>{
    const options = { mode: /** @type {const} */ ('safe'),
        cork: { config: { sharedMemory: true, hotThreshold: 9 }, moduleUrl: 'x' },
        graphics: { lendMemory: true, compressedTextures: true } };
    const settled = withRunMode(options, true);
    assert.equal(settled.mode, 'safe');
    assert.deepEqual(settled.cork, { config: { sharedMemory: false, hotThreshold: 9 },
        moduleUrl: 'x' });
    assert.deepEqual(settled.graphics, { lendMemory: false, compressedTextures: true });
    assert.equal(options.cork.config.sharedMemory, true, 'the caller\'s options are not changed');
});

test('full leaves the caller\'s settings as they are', ()=>{
    const settled = withRunMode({ graphics: { lendMemory: false } }, true);
    assert.equal(settled.mode, 'full');
    assert.deepEqual(settled.graphics, { lendMemory: false });
});
