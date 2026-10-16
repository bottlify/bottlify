/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTX_VERSION } from '../advapi32/registry.js';
import { DIRECTX_VERSION_WORDS, DSETUPERR_SUCCESS, createDsetupFunctions } from './functions.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { rewriteResources } from '../kernel32/resource-update.js';
import { synthesiseProgram } from '../../loader/internal/synth.js';

function machine(){
    const bytes = new Uint8Array(0x100).fill(0xcc);
    const view = new DataView(bytes.buffer);
    const fns = /** @type {any} */
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

test('what a program finds in its own copy is here too, answered as done', ()=>{
    // This table is loaded in place of the copy a disc carries, and a lookup
    // the copy answered must not fail.
    /** @type {string[]} */
    const said = [];
    const fns = /** @type {any} */
        (createDsetupFunctions({ writeMemory: ()=>{}, divergence: api=>said.push(api) }));
    const sizes = Object.fromEntries(Object.entries(fns).map(([name, fn])=>[name, fn.argBytes]));
    assert.deepEqual(sizes, {
        DirectXSetupGetVersion: 8, DirectXSetupA: 12, DirectXSetupW: 12,
        DirectXSetupGetEULAA: 12, DirectXSetupGetEULAW: 12,
        DirectXSetupSetCallback: 4, DirectXSetupIsJapan: 0, DirectXSetupIsJapanNec: 0,
        DirectXDeviceDriverSetupA: 16, DirectXDeviceDriverSetupW: 16,
        DirectXRegisterApplicationA: 8, DirectXRegisterApplicationW: 8,
        DirectXUnRegisterApplication: 8,
    });
    assert.equal(fns.DirectXSetupSetCallback.handler([0x400000]), 0);
    assert.equal(fns.DirectXSetupIsJapan.handler([]), 0);
    assert.equal(fns.DirectXDeviceDriverSetupA.handler([0, 0, 0, 0]), DSETUPERR_SUCCESS);
    assert.equal(fns.DirectXRegisterApplicationA.handler([0, 0x100]), 1);
    assert.equal(fns.DirectXUnRegisterApplication.handler([0, 0x100]), 1);
    assert.equal(said.length, 2, 'the lobby list it did not change is said');
});

test('the licence is the one the brought copy carries, in dsetup32\'s answers', async()=>{
    // A game's autorun fills its licence window from DirectXSetupGetEULAA; with
    // this table in place of the disc's dsetup.dll the window came up empty.
    const text = 'MICROSOFT DirectX 9.0c\r\nSUPPLEMENTAL END USER LICENSE AGREEMENT \xa9';
    const german = 'ERG\xc4NZENDER ENDBENUTZER-LIZENZVERTRAG';
    const image = synthesiseProgram({ library: 'X.dll', routine: 'r' }).bytes;
    const library = rewriteResources(image, [
        { type: 'DATA', name: 'SETUP_AGREEMENT_ENG', language: 0x409, data: encodeAnsi(text) },
        { type: 'DATA', name: 'SETUP_AGREEMENT_GER', language: 0x407, data: encodeAnsi(german) },
    ]);
    assert.ok(library instanceof Uint8Array);
    const memory = new Uint8Array(0x1000).fill(0xcc);
    /** @type {string[]} */
    const read = [];
    /** @type {number[]} */
    const errors = [];
    const fns = /** @type {any} */ (createDsetupFunctions({
        writeMemory: (address, data)=>memory.set(data, address),
        setLastError: code=>errors.push(code),
        brought: ()=>'D:\\DirectX\\dsetup.dll',
        readFile: async path=>{
            read.push(path);
            return path === 'D:\\DirectX\\dsetup32.dll' ? library : null;
        },
    }));

    const needed = await fns.DirectXSetupGetEULAA.handler([0, 0, 0]);
    assert.equal(needed, text.length + 1, 'with no room, the characters and the terminator');
    assert.deepEqual(read, ['D:\\DirectX\\dsetup32.dll'], 'read beside the copy');
    assert.equal(await fns.DirectXSetupGetEULAA.handler([0x100, needed - 1, 0]), 0);
    assert.equal(errors.at(-1), 87, 'too little room');
    assert.equal(memory[0x100], 0, 'the buffer emptied first');
    assert.equal(await fns.DirectXSetupGetEULAA.handler([0x100, needed, 0]), needed);
    assert.equal(decodeAnsi(memory.subarray(0x100, 0x100 + needed - 1)), text);
    assert.equal(memory[0x100 + needed - 1], 0, 'terminated');

    assert.equal(await fns.DirectXSetupGetEULAW.handler([0x400, 0x200, 0x07]), german.length + 1,
        'in German, by its primary language');
    const wide = String.fromCharCode(...new Uint16Array(memory.slice(0x400,
        0x400 + german.length * 2).buffer));
    assert.equal(wide, german);
    assert.equal(await fns.DirectXSetupGetEULAA.handler([0, 0, 0x419]), 0, 'none in Russian');
    assert.equal(errors.at(-1), 1814);

    const none = /** @type {any} */ (createDsetupFunctions({ writeMemory: ()=>{},
        setLastError: code=>errors.push(code), brought: ()=>null, readFile: async()=>null }));
    assert.equal(await none.DirectXSetupGetEULAA.handler([0, 0, 0]), 0,
        'a program that brought no copy has no licence to read');
});

test('a bottle that names its DirectX hears that release from DirectXSetupGetVersion', ()=>{
    const bytes = new Uint8Array(0x40);
    const view = new DataView(bytes.buffer);
    const fns = /** @type {any} */
        (createDsetupFunctions({ writeMemory: (address, data)=>bytes.set(data, address),
            directx: '4.07.00.0700' }));
    assert.equal(fns.DirectXSetupGetVersion.handler([0x10, 0x20]), 1);
    assert.equal(view.getUint32(0x10, true), 0x00040007);
    assert.equal(view.getUint32(0x20, true), 700);
});
