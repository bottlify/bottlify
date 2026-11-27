/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The entry points Microsoft's setup engine (the Visual C++ 2010
 * redistributable's SetupEngine.dll) links beyond what other programs had
 * asked for, each answered as Windows answers on a machine in no domain and
 * with no network: an import that is missing stops the whole engine at its
 * first call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUserenvFunctions } from './kernel32/environment.js';
import { createWinhttpFunctions } from './winhttp/functions.js';
import { createSecur32Functions } from './secur32/functions.js';
import { createEventLogFunctions } from './advapi32/eventlog.js';

function memory(){
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    return {
        bytes, view, errors,
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    };
}

test('ExpandEnvironmentStringsForUserW expands as the process\'s variables do', ()=>{
    const m = memory();
    let needed = 12;
    const fns = createUserenvFunctions({ block: ()=>0, free: ()=>1, expand: ()=>needed,
        writeMemory: m.writeMemory, setLastError: m.setLastError });
    assert.equal(fns.ExpandEnvironmentStringsForUserW.handler([0, 0x100, 0x200, 64]), 1);
    needed = 80;
    assert.equal(fns.ExpandEnvironmentStringsForUserW.handler([0, 0x100, 0x200, 64]), 0);
    assert.equal(m.errors.at(-1), 122, 'ERROR_INSUFFICIENT_BUFFER');
    assert.equal(fns.ExpandEnvironmentStringsForUserW.handler([0, 0, 0x200, 64]), 0);
    assert.equal(m.errors.at(-1), 87);
    assert.equal(fns.UnloadUserProfile.handler(), 1);
});

test('WinHTTP: a date as HTTP writes it, no proxy detected, options taken', ()=>{
    const m = memory();
    const fns = createWinhttpFunctions(/** @type {any} */ (m));
    // SYSTEMTIME of Sunday 6 November 1994, 08:49:37.
    [1994, 11, 0, 6, 8, 49, 37, 0].forEach((value, i)=>m.view.setUint16(0x100 + i * 2, value,
        true));
    assert.equal(fns.WinHttpTimeFromSystemTime.handler([0x100, 0x200]), 1);
    const text = String.fromCharCode(...new Uint16Array(m.bytes.buffer, 0x200, 29));
    assert.equal(text, 'Sun, 06 Nov 1994 08:49:37 GMT');
    assert.equal(m.view.getUint16(0x200 + 58, true), 0, 'terminated');

    m.view.setUint32(0x300, 0xdead, true);
    assert.equal(fns.WinHttpDetectAutoProxyConfigUrl.handler([1, 0x300]), 0);
    assert.equal(m.errors.at(-1), 12180, 'ERROR_WINHTTP_AUTODETECTION_FAILED');
    assert.equal(m.view.getUint32(0x300, true), 0);
    assert.equal(fns.WinHttpSetOption.handler([0, 31, 0x300, 4]), 1, 'a process option');
    assert.equal(fns.WinHttpSetOption.handler([0x1234, 31, 0x300, 4]), 0, 'a handle not open');
});

test('GetComputerObjectName: a machine in no domain has no directory name', ()=>{
    const m = memory();
    const fns = /** @type {any} */ (createSecur32Functions(/** @type {any} */ (m)));
    assert.equal(fns.GetComputerObjectNameW.handler([2, 0x100, 0x200]), 0);
    assert.equal(m.errors.at(-1), 1332, 'ERROR_NONE_MAPPED');
});

test('EnumerateTraceGuids counts no provider', ()=>{
    const m = memory();
    const fns = /** @type {any} */ (createEventLogFunctions(/** @type {any} */ (m)));
    m.view.setUint32(0x100, 7, true);
    assert.equal(fns.EnumerateTraceGuids.handler([0, 0, 0x100]), 0);
    assert.equal(m.view.getUint32(0x100, true), 0);
    assert.equal(fns.EnumerateTraceGuids.handler([0, 0, 0]), 87);
});
