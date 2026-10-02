/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTX_VERSION } from '../advapi32/registry.js';
import { DIRECTX_VERSION_WORDS, DSETUPERR_SUCCESS, createDsetupFunctions } from './functions.js';

function machine(){
    const bytes = new Uint8Array(0x100).fill(0xcc);
    const view = new DataView(bytes.buffer);
    const fns = /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */
        (createDsetupFunctions({ writeMemory: (address, data)=>bytes.set(data, address) }));
    return { fns, u32: (/** @type {number} */ at)=>view.getUint32(at, true) };
}

test('DirectXSetupGetVersion answers 9.0c in the two words the registry spells 4.09.00.0904', ()=>{
    const { fns, u32 } = machine();
    assert.equal(DIRECTX_VERSION, '4.09.00.0904', 'the version the registry names');
    assert.equal(fns.DirectXSetupGetVersion.handler([0x10, 0x20]), 1);
    assert.equal(u32(0x10), 0x00040009, 'major 4 in the high word, minor 9 in the low');
    assert.equal(u32(0x20), 904, 'release 0 and build 904, the decimal number the registry spells');
    assert.deepEqual(DIRECTX_VERSION_WORDS, { version: 0x00040009, revision: 904 });
});

test('DirectXSetupGetVersion writes only the halves it was given somewhere to put', ()=>{
    const { fns, u32 } = machine();
    assert.equal(fns.DirectXSetupGetVersion.handler([0, 0x20]), 1);
    assert.equal(u32(0x20), 904);
    assert.equal(u32(0x10), 0xcccccccc, 'the version untouched');
    assert.equal(fns.DirectXSetupGetVersion.handler([0x10, 0]), 1);
    assert.equal(u32(0x10), 0x00040009);
    assert.equal(u32(0x14), 0xcccccccc, 'nothing past it');
    assert.equal(fns.DirectXSetupGetVersion.handler([0, 0]), 1, 'neither wanted is still TRUE');
});

test('DirectXSetup installs nothing over a runtime as new as its own and asks for no restart', ()=>{
    const { fns } = machine();
    assert.equal(fns.DirectXSetupA.handler([0, 0x40, 0]), DSETUPERR_SUCCESS);
    assert.equal(fns.DirectXSetupW.handler([0, 0x40, 0]), DSETUPERR_SUCCESS);
    assert.equal(fns.DirectXSetupA.argBytes, 12, 'hWnd, the root path and the flags');
    assert.equal(fns.DirectXSetupGetVersion.argBytes, 8);
});

test('a bottle that names its DirectX hears that release from DirectXSetupGetVersion', ()=>{
    const bytes = new Uint8Array(0x40);
    const view = new DataView(bytes.buffer);
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */
        (createDsetupFunctions({ writeMemory: (address, data)=>bytes.set(data, address),
            directx: '4.07.00.0700' }));
    assert.equal(fns.DirectXSetupGetVersion.handler([0x10, 0x20]), 1);
    assert.equal(view.getUint32(0x10, true), 0x00040007);
    assert.equal(view.getUint32(0x20, true), 700);
});
