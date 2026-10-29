/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNcryptFunctions, createSecur32Functions } from './functions.js';
import { COMPUTER_NAME } from '../kernel32/drives.js';

const SEC_E_INVALID_HANDLE = 0x80090301 | 0;
const SEC_E_SECPKG_NOT_FOUND = 0x80090305 | 0;

function machine(){
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    /** @type {number[]} */
    const errors = [];
    const host = {
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.subarray(address, address + length),
        /** @param {number} code */
        setLastError: code=>errors.push(code),
    };
    return { memory, view, errors, sspi: createSecur32Functions(host),
        ncrypt: createNcryptFunctions(host) };
}

test('no security package: no credentials, so every context call is an invalid handle', ()=>{
    // What a machine whose packages are all disabled answers; a program that
    // offers a system TLS or a proxy sign-in falls back on these codes.
    const { view, sspi } = machine();
    view.setUint32(0x200, 0xdead, true);
    assert.equal(sspi.AcquireCredentialsHandleW.argBytes, 36);
    assert.equal(sspi.AcquireCredentialsHandleW.handler([]), SEC_E_SECPKG_NOT_FOUND);
    assert.equal(sspi.InitializeSecurityContextA.argBytes, 48);
    assert.equal(sspi.InitializeSecurityContextA.handler([]), SEC_E_INVALID_HANDLE);
    assert.equal(sspi.DecryptMessage.handler([]), SEC_E_INVALID_HANDLE);
    assert.equal(sspi.QuerySecurityPackageInfoW.handler([0x100, 0x200]), SEC_E_SECPKG_NOT_FOUND);
    assert.equal(view.getUint32(0x200, true), 0, 'NULL where the record would go');
    view.setUint32(0x300, 7, true);
    assert.equal(sspi.EnumerateSecurityPackagesW.handler([0x300, 0x304]), 0);
    assert.deepEqual([view.getUint32(0x300, true), view.getUint32(0x304, true)], [0, 0]);
    assert.equal(sspi.FreeContextBuffer.handler([0]), 0);
});

test('GetUserNameEx gives a local account\'s two names and maps no other', ()=>{
    const { memory, view, errors, sspi } = machine();
    const wanted = `${COMPUTER_NAME}\\User`;
    view.setUint32(0x100, 4, true);
    assert.equal(sspi.GetUserNameExW.handler([2, 0x200, 0x100]), 0);
    assert.equal(errors.at(-1), 234, 'ERROR_MORE_DATA');
    assert.equal(view.getUint32(0x100, true), wanted.length + 1, 'with its terminator');
    assert.equal(sspi.GetUserNameExW.handler([2, 0x200, 0x100]), 1);
    assert.equal(view.getUint32(0x100, true), wanted.length, 'without it');
    assert.equal(new TextDecoder('utf-16le').decode(memory.subarray(0x200, 0x200 + wanted.length * 2)),
        wanted);
    view.setUint32(0x100, 64, true);
    assert.equal(sspi.GetUserNameExA.handler([3, 0x300, 0x100]), 1);
    assert.equal(String.fromCharCode(...memory.subarray(0x300, 0x304)), 'User');
    // NameUserPrincipal: an account in no domain has none.
    assert.equal(sspi.GetUserNameExA.handler([8, 0x300, 0x100]), 0);
    assert.equal(errors.at(-1), 1332, 'ERROR_NONE_MAPPED');
});

test('the local authority connects and knows no package to log on through', ()=>{
    const { view, sspi } = machine();
    assert.equal(sspi.LsaConnectUntrusted.handler([0x100]), 0);
    const handle = view.getUint32(0x100, true);
    assert.notEqual(handle, 0);
    assert.equal(sspi.LsaLogonUser.argBytes, 56);
    assert.equal(sspi.LsaLogonUser.handler([]), 0xc00000fe | 0, 'STATUS_NO_SUCH_PACKAGE');
    assert.equal(sspi.LsaDeregisterLogonProcess.handler([handle]), 0);
    assert.equal(sspi.LsaDeregisterLogonProcess.handler([handle]), 0xc0000008 | 0, 'once');
});

test('ncrypt has no storage provider to open and no key behind any handle', ()=>{
    const { view, ncrypt } = machine();
    view.setUint32(0x100, 0xdead, true);
    assert.equal(ncrypt.NCryptOpenStorageProvider.handler([0x100, 0x200, 0]), 0x80090029 | 0,
        'NTE_NOT_SUPPORTED');
    assert.equal(view.getUint32(0x100, true), 0);
    assert.equal(ncrypt.NCryptOpenStorageProvider.handler([0, 0x200, 0]), 0x80090027 | 0);
    assert.equal(ncrypt.NCryptCreatePersistedKey.argBytes, 24);
    assert.equal(ncrypt.NCryptImportKey.handler([]), 0x80090026 | 0, 'NTE_INVALID_HANDLE');
});
