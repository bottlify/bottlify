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

test('workers is isolated fed through shared memory: asked for, never taken by auto, and refused'
    + ' without shared memory', ()=>{
    assert.equal(runModeOf('workers', true), 'workers');
    assert.throws(()=>runModeOf('workers', false), /"workers" needs shared memory/);
    const options = { mode: /** @type {const} */ ('workers'), graphics: { lendMemory: true } };
    const settled = withRunMode(options, true);
    assert.equal(settled.mode, 'workers');
    assert.deepEqual(settled.graphics, { lendMemory: true }, 'the caller\'s settings stand');
});
