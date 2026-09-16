/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isWanted, verifyExtracted } from './fetch-directx-runtime.mjs';

/** @param {string} text @returns {string} */
const digest = text=>`sha256:${createHash('sha256')
    .update(new TextEncoder().encode(text)).digest('hex')}`;

test('the wanted set is the 32-bit side-by-side runtime and nothing else', ()=>{
    for (const name of ['d3dx9_24.dll', 'd3dx9_26.dll', 'd3dx9_43.dll',
        'd3dx10_33.dll', 'd3dx10_43.dll', 'd3dx11_42.dll', 'd3dx11_43.dll',
        'd3dcompiler_33.dll', 'd3dcompiler_43.dll',
        'xinput1_1.dll', 'xinput1_2.dll', 'xinput1_3.dll',
        'x3daudio1_0.dll', 'x3daudio1_7.dll',
        'xactengine2_0.dll', 'xactengine2_10.dll', 'xactengine3_7.dll',
        'xapofx1_0.dll', 'xapofx1_5.dll',
        'xaudio2_0.dll', 'xaudio2_7.dll'])
    {
        assert.equal(isWanted(name), true, name);
    }
    for (const name of ['xinput9_1_0.dll', 'd3dx10.dll', 'd3dx9_23.dll',
        'd3dx9_44.dll', 'd3dcompiler_32.dll', 'kernel32.dll', 'd3dx9_26.dl'])
    {
        assert.equal(isWanted(name), false, name);
    }
});

test('a matching set verifies and its files are counted', ()=>{
    const files = { 'd3dx9_26.dll': new TextEncoder().encode('a') };
    const artifacts = { 'd3dx9_26.dll': digest('a') };
    assert.equal(verifyExtracted(files, artifacts), 1);
});

test('a wrong hash refuses, and names both digests', ()=>{
    const files = { 'd3dx9_26.dll': new TextEncoder().encode('not the dll') };
    const artifacts = { 'd3dx9_26.dll': digest('the dll') };
    assert.throws(()=>verifyExtracted(files, artifacts), e=>{
        assert.match(/** @type {Error} */ (e).message, /d3dx9_26\.dll: checksum mismatch/);
        assert.match(/** @type {Error} */ (e).message, /expected sha256:/);
        assert.match(/** @type {Error} */ (e).message, /got\s+sha256:/);
        return true;
    });
});

test('a locked file that is missing refuses rather than skipping it', ()=>{
    assert.throws(()=>verifyExtracted({}, { 'd3dx9_26.dll': digest('x') }),
        /d3dx9_26\.dll is in the lock but not in the redistributable/);
});
