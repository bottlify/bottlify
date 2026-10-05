/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS, processorName, readSettings } from './settings.js';

test('the file this build ships with names every setting it tunes', ()=>{
    assert.equal(processorName(SETTINGS), `Bottlify Cork x86 v${SETTINGS.processor.version}`);
    assert.equal(SETTINGS.qpc.frequency, 1_000_000_000);
    assert.equal(SETTINGS.frame.maxFps, 60);
    assert.ok(Number.isInteger(SETTINGS.cork.cacheVersion));
});

test('a setting the file leaves out is left to the layer that reads it', ()=>{
    const bare = readSettings({});
    assert.equal(bare.qpc.frequency, undefined);
    assert.equal(processorName(bare), undefined);
    assert.equal(processorName(readSettings({ processor: { name: 'X' } })), 'X');
});

test('a value of the wrong kind, or a section nobody reads, is refused by name', ()=>{
    for (const [source, text] of /** @type {[any, RegExp][]} */ ([
        [{ qpc: { frequency: 0 } }, /qpc\.frequency/],
        [{ qpc: { frequency: 2 ** 32 } }, /qpc\.frequency/],
        [{ qpc: { frequency: '1000' } }, /qpc\.frequency/],
        [{ frame: { maxFps: -1 } }, /frame\.maxFps/],
        [{ processor: { name: '' } }, /processor\.name/],
        [{ cork: { cacheVersion: 1.5 } }, /cork\.cacheVersion/],
        [{ cork: [] }, /"cork" is not an object/],
        [{ qpc_typo: {} }, /unknown section "qpc_typo"/],
    ]))
    {
        assert.throws(()=>readSettings(source), text);
    }
});
