/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The file versioning rules, letter by letter of REINSTALLMODE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, replaces, versionParts } from './versioning.js';

/** @param {string | null} version @param {Uint8Array | null} [md5] */
const there = (version, md5 = null)=>({ version, md5: async()=>md5 });

test('a versioned file: never older over newer, the same with e, any other with d', async()=>{
    const incoming = { version: '1.2.0.0', hash: null };
    assert.equal(await replaces(incoming, null, 'omus'), true, 'nothing there');
    assert.equal(await replaces(incoming, there('1.1.9.9'), 'omus'), true, 'newer over older');
    assert.equal(await replaces(incoming, there('1.2'), 'omus'), false, 'not the same with o');
    assert.equal(await replaces(incoming, there('1.2'), 'emus'), true, 'the same with e');
    assert.equal(await replaces(incoming, there('2.0'), 'emus'), false, 'never over newer');
    assert.equal(await replaces(incoming, there('2.0'), 'dmus'), true, 'any other with d');
    assert.equal(await replaces(incoming, there('2.0'), 'amus'), true, 'everything with a');
    assert.equal(await replaces(incoming, there(null), 'pmus'), true,
        'a versioned file over one without a version');
    assert.equal(await replaces(incoming, there('1.0'), 'pmus'), false, 'p: only what is missing');
});

test('a file with no version: kept when its hash matches, replaced otherwise', async()=>{
    const hash = Uint8Array.of(1, 2, 3, 4);
    assert.equal(await replaces({ version: null, hash }, there(null, Uint8Array.of(1, 2, 3, 4)),
        'omus'), false);
    assert.equal(await replaces({ version: null, hash }, there(null, Uint8Array.of(9, 2, 3, 4)),
        'omus'), true);
    assert.equal(await replaces({ version: null, hash: null }, there(null), 'omus'), true);
    assert.equal(await replaces({ version: null, hash: null }, there(null), 'pmus'), false);
});

test('versions compare part by part, missing parts as zero', ()=>{
    assert.deepEqual(versionParts('5.1'), [5, 1, 0, 0]);
    assert.equal(versionParts('Companion'), null);
    assert.equal(compareVersions([1, 10, 0, 0], [1, 9, 0, 0]), 1);
    assert.equal(compareVersions([1, 0, 0, 0], [1, 0, 0, 0]), 0);
});
