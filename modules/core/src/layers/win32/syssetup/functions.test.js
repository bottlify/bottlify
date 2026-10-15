/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyssetupFunctions } from './functions.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_PARAMETER = 87;
const DATA = 0x100;
const EXCEPTION = 0x400;
const GUID = 0x80;
/** The sizes DirectX's setup gives the two structures. */
const DATA_SIZE = 0xdc;
const EXCEPTION_SIZE = 0x454;

function setup(){
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    /** @type {number[]} */
    const errors = [];
    const fns = /** @type {any} */ (createSyssetupFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        setLastError: code=>errors.push(code),
    }));
    return { memory, view, errors, fns };
}

test('an OS component a setup registers is answered with what it gave, and goes when '
    + 'unregistered', ()=>{
    // DirectX's setup queries its component, unregisters it, and registers
    // its exception package: without the library it put its files off to a
    // restart.
    const { memory, view, errors, fns } = setup();
    memory.set(Array.from({ length: 16 }, (_, i)=>0xa0 + i), GUID);
    view.setUint32(DATA, DATA_SIZE, true);
    view.setUint32(EXCEPTION, EXCEPTION_SIZE, true);

    assert.equal(fns.SetupQueryRegisteredOsComponent.handler([GUID, DATA, EXCEPTION]), 0);
    assert.equal(errors.at(-1), ERROR_FILE_NOT_FOUND, 'nothing registered yet');

    memory.set(memory.subarray(GUID, GUID + 16), DATA + 4);
    memory.fill(0x11, DATA + 20, DATA + DATA_SIZE);
    memory.fill(0x22, EXCEPTION + 4, EXCEPTION + EXCEPTION_SIZE);
    assert.equal(fns.SetupRegisterOsComponent.handler([DATA, EXCEPTION]), 1);

    memory.fill(0, DATA + 4, DATA + DATA_SIZE);
    memory.fill(0, EXCEPTION + 4, EXCEPTION + EXCEPTION_SIZE);
    assert.equal(fns.SetupQueryRegisteredOsComponent.handler([GUID, DATA, EXCEPTION]), 1);
    assert.deepEqual([...memory.subarray(DATA + 4, DATA + 20)],
        [...memory.subarray(GUID, GUID + 16)], 'its GUID');
    assert.ok(memory.subarray(DATA + 20, DATA + DATA_SIZE).every(byte=>byte === 0x11),
        'the rest of the component as it was given');
    assert.ok(memory.subarray(EXCEPTION + 4, EXCEPTION + EXCEPTION_SIZE)
        .every(byte=>byte === 0x22), 'and the package, names and all');

    assert.equal(fns.SetupUnRegisterOsComponent.handler([GUID]), 1);
    assert.equal(fns.SetupUnRegisterOsComponent.handler([GUID]), 0, 'gone');
    assert.equal(errors.at(-1), ERROR_FILE_NOT_FOUND);

    view.setUint32(DATA, 8, true);
    assert.equal(fns.SetupRegisterOsComponent.handler([DATA, EXCEPTION]), 0,
        'too small to hold a GUID');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.deepEqual([fns.SetupRegisterOsComponent, fns.SetupUnRegisterOsComponent,
        fns.SetupQueryRegisteredOsComponent].map(fn=>fn.argBytes), [8, 4, 12]);
});
