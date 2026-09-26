/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceFunctions } from './services.js';
import { createHive, HKEY_LOCAL_MACHINE, REG_DWORD, REG_EXPAND_SZ, REG_SZ } from './registry.js';

const NAME = 0x100;
const DISPLAY = 0x200;
const PATH = 0x300;

const ERROR_INVALID_HANDLE = 6;
const ERROR_SERVICE_REQUEST_TIMEOUT = 1053;
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
const ERROR_SERVICE_NOT_ACTIVE = 1062;
const ERROR_SERVICE_EXISTS = 1073;

const SERVICE_WIN32_OWN_PROCESS = 0x10;
const SERVICE_AUTO_START = 2;
const SERVICE_ERROR_NORMAL = 1;
const SERVICE_NO_CHANGE = 0xffffffff;

function setup(){
    const bytes = new Uint8Array(0x1000);
    const hive = createHive();
    let lastError = 0;
    /** @type {string[]} */
    const diverged = [];
    const built = createServiceFunctions({
        // As the memory layer reads an ANSI string: in Windows-1252, which is
        // what the Encoding standard calls latin1.
        readCString: (address, maxLength)=>{
            let end = address;
            while (end < bytes.length && end - address < maxLength && bytes[end] !== 0)
            {
                end++;
            }
            return new TextDecoder('latin1').decode(bytes.subarray(address, end));
        },
        hive,
        setLastError: code=>{
            lastError = code;
        },
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
    });
    // Cast once: a handler declares only the arguments it reads, and a guest
    // call always arrives with the whole argument array.
    const fns = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (built));
    /** @param {number} address @param {string} text */
    const put = (address, text)=>{
        for (let at = 0; at < text.length; at++)
        {
            bytes[address + at] = text.charCodeAt(at);
        }
        bytes[address + text.length] = 0;
        return address;
    };
    /** @param {string} name */
    const serviceKey = name=>hive.open(
        /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)),
        `SYSTEM\\CurrentControlSet\\Services\\${name}`);
    return { fns, hive, put, serviceKey, lastError: ()=>lastError, diverged };
}

/** @param {Uint8Array} data */
const dwordOf = data=>new DataView(data.buffer, data.byteOffset).getUint32(0, true);
/** @param {Uint8Array} data */
const textOf = data=>String.fromCharCode(...data.subarray(0, data.length - 1));

test('the manager opens for the one user, and a service that was never made is not there', ()=>{
    const { fns, put, lastError } = setup();
    const manager = fns.OpenSCManagerA.handler([0, 0, 0xf003f]);
    assert.notEqual(manager, 0, 'SC_MANAGER_ALL_ACCESS: the user is the administrator');

    assert.equal(fns.OpenServiceA.handler([manager, put(NAME, 'Nothing'), 0x10]), 0);
    assert.equal(lastError(), ERROR_SERVICE_DOES_NOT_EXIST);
    assert.equal(fns.OpenServiceA.handler([0x1234, put(NAME, 'Nothing'), 0x10]), 0);
    assert.equal(lastError(), ERROR_INVALID_HANDLE);
    assert.equal(fns.CloseServiceHandle.handler([manager]), 1);
    assert.equal(fns.CloseServiceHandle.handler([manager]), 0, 'and closed is closed');
});

test('a created service is the registry key the real manager writes', ()=>{
    const { fns, put, serviceKey, lastError } = setup();
    const manager = fns.OpenSCManagerA.handler([0, 0, 2]);
    const service = fns.CreateServiceA.handler([
        manager, put(NAME, 'Example'), put(DISPLAY, 'Example Service'), 0xf01ff,
        SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
        put(PATH, 'C:\\Program Files\\Example\\service.exe'), 0, 0, 0, 0, 0,
    ]);
    assert.notEqual(service, 0);

    const key = serviceKey('Example');
    assert.ok(key, 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Example exists');
    const held = /** @type {any} */ (key);
    /** @param {string} name */
    const value = name=>held.values.get(name.toLowerCase());
    assert.equal(value('Type').type, REG_DWORD);
    assert.equal(dwordOf(value('Type').data), SERVICE_WIN32_OWN_PROCESS);
    assert.equal(dwordOf(value('Start').data), SERVICE_AUTO_START);
    assert.equal(dwordOf(value('ErrorControl').data), SERVICE_ERROR_NORMAL);
    assert.equal(value('ImagePath').type, REG_EXPAND_SZ);
    assert.equal(textOf(value('ImagePath').data), 'C:\\Program Files\\Example\\service.exe');
    assert.equal(value('DisplayName').type, REG_SZ);
    assert.equal(textOf(value('DisplayName').data), 'Example Service');
    assert.equal(textOf(value('ObjectName').data), 'LocalSystem',
        'no account named runs as the system');

    assert.equal(fns.CreateServiceA.handler([
        manager, put(NAME, 'example'), DISPLAY, 0, 0, 0, 0, PATH, 0, 0, 0, 0, 0,
    ]), 0, 'a second one under the same name, in any case');
    assert.equal(lastError(), ERROR_SERVICE_EXISTS);
    assert.notEqual(fns.OpenServiceA.handler([manager, put(NAME, 'Example'), 0x10]), 0,
        'and the one that exists opens');
});

test('changing the configuration rewrites only what was given', ()=>{
    const { fns, put, serviceKey } = setup();
    const manager = fns.OpenSCManagerA.handler([0, 0, 2]);
    const service = fns.CreateServiceA.handler([
        manager, put(NAME, 'Example'), put(DISPLAY, 'Example Service'), 0,
        SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
        put(PATH, 'C:\\old.exe'), 0, 0, 0, 0, 0,
    ]);

    assert.equal(fns.ChangeServiceConfigA.handler([
        service, SERVICE_NO_CHANGE, 3, SERVICE_NO_CHANGE, put(PATH, 'C:\\new.exe'),
        0, 0, 0, 0, 0, 0,
    ]), 1);
    const key = /** @type {any} */ (serviceKey('Example'));
    assert.equal(dwordOf(key.values.get('type').data), SERVICE_WIN32_OWN_PROCESS, 'left alone');
    assert.equal(dwordOf(key.values.get('start').data), 3);
    assert.equal(textOf(key.values.get('imagepath').data), 'C:\\new.exe');
    assert.equal(textOf(key.values.get('displayname').data), 'Example Service', 'left alone');
    assert.equal(fns.ChangeServiceConfigA.handler([manager, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0,
        'the manager is not a service');
});

test('nothing runs a service here: a start times out and says so, a control finds it stopped', ()=>{
    const { fns, put, lastError, diverged } = setup();
    const manager = fns.OpenSCManagerA.handler([0, 0, 2]);
    const service = fns.CreateServiceA.handler([
        manager, put(NAME, 'Example'), 0, 0, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START,
        SERVICE_ERROR_NORMAL, put(PATH, 'C:\\service.exe'), 0, 0, 0, 0, 0,
    ]);

    assert.equal(fns.StartServiceA.handler([service, 0, 0]), 0);
    assert.equal(lastError(), ERROR_SERVICE_REQUEST_TIMEOUT);
    assert.equal(diverged.length, 1);
    assert.match(diverged[0], /StartServiceA: Example/);
    assert.equal(fns.ControlService.handler([service, 1, 0]), 0);
    assert.equal(lastError(), ERROR_SERVICE_NOT_ACTIVE);

    const lock = fns.LockServiceDatabase.handler([manager]);
    assert.notEqual(lock, 0);
    assert.equal(fns.UnlockServiceDatabase.handler([lock]), 1);
    assert.equal(fns.UnlockServiceDatabase.handler([lock]), 0, 'once');
});

test('a service\'s names are kept in the bytes the program gave them', ()=>{
    // The memory layer reads them as Windows-1252, where 0x80 is the euro
    // sign, 0x99 the trade mark and 0x97 an em dash, and the registry keeps a
    // string in that page, so RegQueryValueExA hands the same bytes back.
    const { fns, put, serviceKey } = setup();
    const manager = fns.OpenSCManagerA.handler([0, 0, 2]);
    assert.notEqual(fns.CreateServiceA.handler([
        manager, put(NAME, 'Example'), put(DISPLAY, '\x80\x99\x97\xe9'), 0,
        SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
        put(PATH, 'C:\\\x80\\s.exe'), 0, 0, 0, 0, 0,
    ]), 0);
    const held = /** @type {any} */ (serviceKey('Example'));
    assert.deepEqual([...held.values.get('displayname').data], [0x80, 0x99, 0x97, 0xe9, 0]);
    assert.deepEqual([...held.values.get('imagepath').data.subarray(3, 5)], [0x80, 0x5c]);
});
