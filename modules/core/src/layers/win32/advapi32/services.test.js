/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createRegistryService } from './registry-service.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceFunctions } from './services.js';
import { createHive, HKEY_LOCAL_MACHINE, REG_DWORD, REG_EXPAND_SZ, REG_SZ } from './registry.js';
import { decodeAnsi } from '../kernel32/locale.js';

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
    const hive = createRegistryService(createHive());
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
            return decodeAnsi(bytes.subarray(address, end));
        },
        writeMemory: (address, data)=>bytes.set(data, address),
        readMemory: (address, length)=>bytes.subarray(address, address + length),
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
    return { fns, hive: /** @type {any} */ (hive), put, serviceKey, lastError: ()=>lastError, diverged, bytes };
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
    const { fns, hive, put, serviceKey, lastError } = setup();
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
    const value = name=>hive.getValue(held, name.toLowerCase());
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
    const { fns, hive, put, serviceKey } = setup();
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
    assert.equal(dwordOf(hive.getValue(key, 'type').data), SERVICE_WIN32_OWN_PROCESS, 'left alone');
    assert.equal(dwordOf(hive.getValue(key, 'start').data), 3);
    assert.equal(textOf(hive.getValue(key, 'imagepath').data), 'C:\\new.exe');
    assert.equal(textOf(hive.getValue(key, 'displayname').data), 'Example Service', 'left alone');
    assert.equal(fns.ChangeServiceConfigA.handler([manager, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0,
        'the manager is not a service');
});

test('nothing runs a service here: a start times out and says so, a control finds it stopped', ()=>{
    const { fns, put, lastError, diverged, bytes } = setup();
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
    const STATUS = 0x900;
    assert.equal(fns.QueryServiceStatus.handler([service, STATUS]), 1);
    const status = new DataView(bytes.buffer, STATUS, 28);
    assert.deepEqual([status.getUint32(0, true), status.getUint32(4, true),
        status.getUint32(12, true)], [SERVICE_WIN32_OWN_PROCESS, 1, 1077],
    'its type, SERVICE_STOPPED, ERROR_SERVICE_NEVER_STARTED');
    assert.equal(fns.QueryServiceStatus.handler([manager, STATUS]), 0, 'not a service');

    const lock = fns.LockServiceDatabase.handler([manager]);
    assert.notEqual(lock, 0);
    assert.equal(fns.UnlockServiceDatabase.handler([lock]), 1);
    assert.equal(fns.UnlockServiceDatabase.handler([lock]), 0, 'once');
});

test('a service\'s names are kept in the bytes the program gave them', ()=>{
    // The memory layer reads them as Windows-1252, where 0x80 is the euro
    // sign, 0x99 the trade mark and 0x97 an em dash, and the registry keeps a
    // string in that page, so RegQueryValueExA hands the same bytes back.
    const { fns, hive, put, serviceKey } = setup();
    const manager = fns.OpenSCManagerA.handler([0, 0, 2]);
    assert.notEqual(fns.CreateServiceA.handler([
        manager, put(NAME, 'Example'), put(DISPLAY, '\x80\x99\x97\xe9'), 0,
        SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
        put(PATH, 'C:\\\x80\\s.exe'), 0, 0, 0, 0, 0,
    ]), 0);
    const held = /** @type {any} */ (serviceKey('Example'));
    assert.deepEqual([...hive.getValue(held, 'displayname').data], [0x80, 0x99, 0x97, 0xe9, 0]);
    assert.deepEqual([...hive.getValue(held, 'imagepath').data.subarray(3, 5)], [0x80, 0x5c]);
});

test('DeleteService marks a service, whose key goes with the last handle open on it', ()=>{
    const ERROR_SERVICE_MARKED_FOR_DELETE = 1072;
    const { fns, hive, put, serviceKey, lastError } = setup();
    const manager = fns.OpenSCManagerA.handler([0, 0, 0xf003f]);
    // A driver a program installs to read the hardware, and gives up on when it
    // will not start: create, start (fails), stop (fails), delete, close.
    const service = fns.CreateServiceA.handler([manager, put(NAME, 'PciBus'),
        put(DISPLAY, 'PciBus'), 0xf01ff, 1, 3, 1, put(PATH, 'pcibus.sys'), 0, 0, 0, 0, 0]);
    const again = fns.OpenServiceA.handler([manager, NAME, 0xf01ff]);
    hive.create(/** @type {any} */ (serviceKey('PciBus')), 'Parameters');
    assert.equal(fns.DeleteService.handler([service]), 1);
    assert.equal(fns.DeleteService.handler([again]), 0, 'marked once');
    assert.equal(lastError(), ERROR_SERVICE_MARKED_FOR_DELETE);
    assert.equal(fns.CloseServiceHandle.handler([service]), 1);
    assert.ok(serviceKey('PciBus'), 'still there while a handle is open on it');
    assert.equal(fns.CloseServiceHandle.handler([again]), 1);
    assert.equal(serviceKey('PciBus'), null, 'gone with the last one, its subkeys too');
    assert.equal(fns.OpenServiceA.handler([manager, NAME, 0xf01ff]), 0);
    assert.equal(fns.DeleteService.handler([manager]), 0, 'the manager is no service');
    assert.equal(lastError(), ERROR_INVALID_HANDLE);
});

test('a process the manager did not start has no manager to connect to', ()=>{
    const { fns, lastError } = setup();
    const ERROR_FAILED_SERVICE_CONTROLLER_CONNECT = 1063;
    const ERROR_SERVICE_NOT_IN_EXE = 1083;

    assert.equal(fns.StartServiceCtrlDispatcherA.argBytes, 4);
    assert.equal(fns.StartServiceCtrlDispatcherA.handler([0x400]), 0);
    assert.equal(lastError(), ERROR_FAILED_SERVICE_CONTROLLER_CONNECT);

    assert.equal(fns.RegisterServiceCtrlHandlerA.argBytes, 8);
    assert.equal(fns.RegisterServiceCtrlHandlerA.handler([NAME, 0x401000]), 0,
        'no handle, as the process runs none of its services');
    assert.equal(lastError(), ERROR_SERVICE_NOT_IN_EXE);

    assert.equal(fns.SetServiceStatus.argBytes, 8);
    assert.equal(fns.SetServiceStatus.handler([0x1234, 0x500]), 0);
    assert.equal(lastError(), ERROR_INVALID_HANDLE);
});

const ERROR_MORE_DATA = 234;
const ERROR_INVALID_LEVEL = 124;
const ERROR_INVALID_PARAMETER = 87;
const SERVICE_WIN32 = 0x30;
const SERVICE_DRIVER = 0x0b;
const SERVICE_ACTIVE = 1;
const SERVICE_INACTIVE = 2;
const SERVICE_STATE_ALL = 3;
const ENUM_BUFFER = 0x600;
const NEEDED = 0x500;
const RETURNED = 0x504;
const RESUME = 0x508;

/** @param {ReturnType<typeof setup>} env @param {string} name @param {number} [type] */
function makeService(env, name, type = SERVICE_WIN32_OWN_PROCESS){
    const manager = env.fns.OpenSCManagerA.handler([0, 0, 0xf003f]);
    const made = env.fns.CreateServiceA.handler([manager, env.put(NAME, name),
        env.put(DISPLAY, `${name} display`), 0, type, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
        env.put(PATH, 'C:\\svc.exe'), 0, 0, 0, 0, 0]);
    assert.notEqual(made, 0);
    env.fns.CloseServiceHandle.handler([made]);
    env.fns.CloseServiceHandle.handler([manager]);
}

/** @param {Uint8Array} bytes @param {number} at */
const dwordAt = (bytes, at)=>new DataView(bytes.buffer).getUint32(at, true);

test('OpenSCManagerW opens the same manager the A form does', ()=>{
    const env = setup();
    const manager = env.fns.OpenSCManagerW.handler([0, 0, 0xf003f]);
    assert.notEqual(manager, 0);
    assert.equal(env.fns.OpenServiceA.handler([manager, env.put(NAME, 'Nothing'), 0x10]), 0);
    assert.equal(env.lastError(), ERROR_SERVICE_DOES_NOT_EXIST, 'a manager, not a bad handle');
    assert.equal(env.fns.CloseServiceHandle.handler([manager]), 1);
    assert.equal(env.fns.OpenSCManagerW.argBytes, 12);
});

test('EnumServicesStatusEx lists the database, every service stopped, and no running one', ()=>{
    const env = setup();
    makeService(env, 'Beta');
    makeService(env, 'alpha');
    makeService(env, 'Driver', 1);
    const manager = env.fns.OpenSCManagerA.handler([0, 0, 0xf003f]);
    const enumerate = (/** @type {number} */ state, /** @type {number} */ size)=>
        env.fns.EnumServicesStatusExA.handler([manager, 0, SERVICE_WIN32, state, ENUM_BUFFER, size,
            NEEDED, RETURNED, 0, 0]);

    assert.equal(enumerate(SERVICE_ACTIVE, 0x400), 1, 'nothing runs, so nothing is active');
    assert.equal(dwordAt(env.bytes, RETURNED), 0);
    assert.equal(dwordAt(env.bytes, NEEDED), 0);

    assert.equal(enumerate(SERVICE_INACTIVE, 0x400), 1);
    assert.equal(dwordAt(env.bytes, RETURNED), 2, 'the two programs, not the driver');
    const names = [0, 1].map(at=>env.bytes.subarray(dwordAt(env.bytes, ENUM_BUFFER + at * 44)))
        .map(from=>decodeAnsi(from.subarray(0, from.indexOf(0))));
    assert.deepEqual(names, ['alpha', 'Beta'], 'in name order, case folded');
    const display = env.bytes.subarray(dwordAt(env.bytes, ENUM_BUFFER + 4));
    assert.equal(decodeAnsi(display.subarray(0, display.indexOf(0))), 'alpha display');
    assert.equal(dwordAt(env.bytes, ENUM_BUFFER + 8), SERVICE_WIN32_OWN_PROCESS);
    assert.equal(dwordAt(env.bytes, ENUM_BUFFER + 12), 1, 'SERVICE_STOPPED');
    assert.equal(dwordAt(env.bytes, ENUM_BUFFER + 36), 0, 'no process');

    assert.equal(env.fns.EnumServicesStatusExA.handler([manager, 0, SERVICE_DRIVER,
        SERVICE_STATE_ALL, ENUM_BUFFER, 0x400, NEEDED, RETURNED, 0, 0]), 1);
    assert.equal(dwordAt(env.bytes, RETURNED), 1, 'the driver alone');
});

test('EnumServicesStatusEx with too little room says how much, and resumes', ()=>{
    const env = setup();
    makeService(env, 'One');
    makeService(env, 'Two');
    const manager = env.fns.OpenSCManagerA.handler([0, 0, 0xf003f]);
    env.bytes.set([0, 0, 0, 0], RESUME);
    const call = (/** @type {number} */ size)=>env.fns.EnumServicesStatusExA.handler([manager, 0,
        SERVICE_WIN32, SERVICE_STATE_ALL, ENUM_BUFFER, size, NEEDED, RETURNED, RESUME, 0]);
    const one = 44 + 'One'.length + 1 + 'One display'.length + 1;
    const two = 44 + 'Two'.length + 1 + 'Two display'.length + 1;
    assert.equal(call(0), 0);
    assert.equal(env.lastError(), ERROR_MORE_DATA);
    assert.equal(dwordAt(env.bytes, NEEDED), one + two);
    assert.equal(dwordAt(env.bytes, RETURNED), 0);

    assert.equal(call(one), 0, 'room for the first');
    assert.equal(dwordAt(env.bytes, RETURNED), 1);
    assert.equal(dwordAt(env.bytes, NEEDED), two);
    assert.equal(dwordAt(env.bytes, RESUME), 1, 'where the next call takes up');
    assert.equal(call(two), 1);
    assert.equal(dwordAt(env.bytes, RETURNED), 1);
    const name = env.bytes.subarray(dwordAt(env.bytes, ENUM_BUFFER));
    assert.equal(decodeAnsi(name.subarray(0, name.indexOf(0))), 'Two');
    assert.equal(dwordAt(env.bytes, RESUME), 0, 'and at the end it is reset');
});

test('EnumServicesStatusExW writes the names wide; a group nobody is in lists nothing', ()=>{
    const env = setup();
    makeService(env, 'Wide');
    const manager = env.fns.OpenSCManagerW.handler([0, 0, 0xf003f]);
    assert.equal(env.fns.EnumServicesStatusExW.handler([manager, 0, SERVICE_WIN32,
        SERVICE_STATE_ALL, ENUM_BUFFER, 0x400, NEEDED, RETURNED, 0, 0]), 1);
    assert.equal(dwordAt(env.bytes, RETURNED), 1);
    const at = dwordAt(env.bytes, ENUM_BUFFER);
    assert.deepEqual([...env.bytes.subarray(at, at + 10)],
        [0x57, 0, 0x69, 0, 0x64, 0, 0x65, 0, 0, 0], 'W i d e, terminated');

    env.bytes.set([0x47, 0, 0x31, 0, 0, 0], 0x700);
    assert.equal(env.fns.EnumServicesStatusExW.handler([manager, 0, SERVICE_WIN32,
        SERVICE_STATE_ALL, ENUM_BUFFER, 0x400, NEEDED, RETURNED, 0, 0x700]), 1);
    assert.equal(dwordAt(env.bytes, RETURNED), 0, 'group G1 holds nothing');
    env.bytes.set([0, 0], 0x700);
    assert.equal(env.fns.EnumServicesStatusExW.handler([manager, 0, SERVICE_WIN32,
        SERVICE_STATE_ALL, ENUM_BUFFER, 0x400, NEEDED, RETURNED, 0, 0x700]), 1);
    assert.equal(dwordAt(env.bytes, RETURNED), 1, 'the empty group: services in none');
});

test('EnumServicesStatusEx refuses a bad handle, level, type or state', ()=>{
    const env = setup();
    const manager = env.fns.OpenSCManagerA.handler([0, 0, 0xf003f]);
    const call = (/** @type {number[]} */ args)=>env.fns.EnumServicesStatusExA.handler(args);
    assert.equal(call([0x1234, 0, SERVICE_WIN32, 3, ENUM_BUFFER, 0, NEEDED, RETURNED, 0, 0]), 0);
    assert.equal(env.lastError(), ERROR_INVALID_HANDLE);
    assert.equal(call([manager, 1, SERVICE_WIN32, 3, ENUM_BUFFER, 0, NEEDED, RETURNED, 0, 0]), 0);
    assert.equal(env.lastError(), ERROR_INVALID_LEVEL);
    assert.equal(call([manager, 0, 0, 3, ENUM_BUFFER, 0, NEEDED, RETURNED, 0, 0]), 0);
    assert.equal(env.lastError(), ERROR_INVALID_PARAMETER);
    assert.equal(call([manager, 0, SERVICE_WIN32, 4, ENUM_BUFFER, 0, NEEDED, RETURNED, 0, 0]), 0);
    assert.equal(env.lastError(), ERROR_INVALID_PARAMETER);
    assert.equal(env.fns.EnumServicesStatusExA.argBytes, 40);
    assert.equal(env.fns.EnumServicesStatusExW.argBytes, 40);
});
