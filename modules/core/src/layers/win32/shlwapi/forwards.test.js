/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHLWAPI_FORWARDS, SHLWAPI_ORDINALS, createForwards } from './forwards.js';

test('every forwarded export has its own ordinal and its own name, and takes whole words', ()=>{
    const ordinals = new Set(SHLWAPI_FORWARDS.map(([ordinal])=>ordinal));
    const names = new Set(SHLWAPI_FORWARDS.map(([, name])=>name));
    assert.equal(ordinals.size, SHLWAPI_FORWARDS.length);
    assert.equal(names.size, SHLWAPI_FORWARDS.length);
    for (const [ordinal, name, home, target, words] of SHLWAPI_FORWARDS)
    {
        assert.match(name, /^[A-Za-z0-9]+Wrap[AW]?$|^[A-Za-z0-9]+$/, `#${ordinal}`);
        assert.match(home, /^[A-Z0-9]+\.dll$/, name);
        assert.match(target, /^[A-Za-z0-9]+$/, name);
        assert.ok(Number.isInteger(words) && words >= 0 && words <= 16, name);
    }
    assert.equal(SHLWAPI_ORDINALS[66], 'FindResourceWrapW');
    assert.equal(SHLWAPI_ORDINALS[25], 'IsCharAlphaWrapW');
});

test('a forwarded export answers what its target does, called with what it was given, and takes'
    + ' the stack of the wrapper', ()=>{
    /** @type {number[][]} */
    const seen = [];
    const functions = createForwards(home=>(home === 'KERNEL32.dll' ? {
        FindResourceW: { handler: args=>{
            seen.push(args);
            return 0x1234;
        } },
    } : undefined));
    const find = functions.FindResourceWrapW;
    assert.equal(find.argBytes, 12, 'three words: the module, the name and the type');
    assert.equal(find.handler([0x400000, 7, 24]), 0x1234);
    assert.deepEqual(seen, [[0x400000, 7, 24]]);
    assert.equal(functions.MLGetUILanguage.argBytes, 0);
});

test('a forwarded export whose target is not implemented says so and answers nothing', ()=>{
    /** @type {string[]} */
    const said = [];
    const functions = createForwards(()=>undefined, (api, detail)=>{
        said.push(`${api}: ${detail}`);
    });
    assert.equal(functions.FindResourceWrapW.handler([0, 0, 0]), 0);
    assert.equal(said.length, 1);
    assert.match(said[0], /#66 FindResourceWrapW is KERNEL32\.dll!FindResourceW/);
});
