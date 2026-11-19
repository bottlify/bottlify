/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoaderFunctions } from './loader.js';
import { STATUS } from './status.js';
import { DLL_SEARCH_PATH } from '../kernel32/modules.js';

const NAME = 0x100;
const TEXT = 0x200;
const OUT = 0x300;

/** Guest memory, a bump heap, and a kernel32 loader knowing one module. */
/**
 * @param {Record<string, any>} [also]  kernel32 calls beside the ones here, or
 *     in place of them
 */
function machine(also = {}){
    const bytes = new Uint8Array(0x30000);
    const view = new DataView(bytes.buffer);
    // Above 64 KiB: GetProcAddress takes a pointer below it for an ordinal.
    let next = 0x20000;
    let lastError = 0;
    /** @type {{ flags: number, name: string }[]} */
    const asked = [];
    /** @type {any[]} */
    const loads = [];
    /** @type {Map<number, any>} */
    const registered = new Map();
    let cookies = 0;
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let code; (code = view.getUint16(at, true)) !== 0; at += 2)
        {
            text += String.fromCharCode(code);
        }
        return text;
    };
    /** @param {number} at */
    const ansiAt = at=>{
        let text = '';
        for (let code; (code = bytes[at]) !== 0; at++)
        {
            text += String.fromCharCode(code);
        }
        return text;
    };
    const kernel32 = {
        GetModuleHandleExW: { handler: (/** @type {number[]} */ [flags, name, out])=>{
            const text = (flags & 4) !== 0 ? `@${name.toString(16)}` : wideAt(name);
            asked.push({ flags, name: text });
            const found = text.toLowerCase() === 'game.dll' || text === '@10000000';
            view.setUint32(out, found ? 0x10000000 : 0, true);
            return found ? 1 : 0;
        } },
        LoadLibraryW: { handler: (/** @type {number[]} */ [name])=>{
            loads.push(wideAt(name));
            return Promise.resolve(['late.dll', 'D:\\Two\\x.dll'].includes(wideAt(name))
                ? 0x20000000 : 0);
        } },
        LoadLibraryExW: { handler: (/** @type {number[]} */ [name, , flags])=>{
            loads.push([wideAt(name), flags]);
            return 0;
        } },
        [DLL_SEARCH_PATH]: (/** @type {string} */ module, /** @type {number} */ flags)=>
            [`for ${module}`, flags.toString(16)],
        GetProcAddress: { handler: (/** @type {number[]} */ [, name])=>{
            if (name < 0x10000)
            {
                lastError = 127;
                return name === 7 ? 0x10001000 : 0;
            }
            lastError = 127;
            return ansiAt(name) === 'Run' ? 0x10002000 : 0;
        } },
        GetLastError: { handler: ()=>lastError },
        SetDllDirectoryW: { handler: ()=>1 },
        GetDllDirectoryW: { handler: ()=>1 },
        ...also,
    };
    const table = createLoaderFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        kernel32,
        allocate: size=>{
            const at = next;
            next += size + 8;
            return at;
        },
        free: ()=>true,
        notifications: {
            register: (callback, context)=>{
                registered.set(++cookies, { callback, context });
                return cookies;
            },
            unregister: cookie=>registered.delete(cookie),
        },
    });
    /** A counted string at NAME over TEXT. @param {string} text @param {number} unit */
    const counted = (text, unit = 2)=>{
        for (let i = 0; i < text.length; i++)
        {
            if (unit === 2)
            {
                view.setUint16(TEXT + i * 2, text.charCodeAt(i), true);
            }
            else
            {
                bytes[TEXT + i] = text.charCodeAt(i);
            }
        }
        view.setUint16(NAME, text.length * unit, true);
        view.setUint16(NAME + 2, text.length * unit, true);
        view.setUint32(NAME + 4, TEXT, true);
    };
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>table[name].handler(args);
    /** @param {number} code */
    const failWith = code=>{
        lastError = code;
    };
    return { view, call, counted, asked, loads, wideAt, registered, failWith };
}

test('a loaded module by its name, its count left alone; one not loaded is not found', ()=>{
    const { view, call, counted, asked } = machine();
    counted('GAME.DLL');
    assert.equal(call('LdrGetDllHandle', 0, 0, NAME, OUT), STATUS.SUCCESS);
    assert.equal(view.getUint32(OUT, true), 0x10000000);
    assert.deepEqual(asked.at(-1), { flags: 2, name: 'GAME.DLL' }, 'UNCHANGED_REFCOUNT');
    assert.equal(call('LdrGetDllHandleEx', 2, 0, 0, NAME, OUT), STATUS.SUCCESS);
    assert.equal(asked.at(-1)?.flags, 1, 'pinned');
    counted('other.dll');
    assert.equal(call('LdrGetDllHandle', 0, 0, NAME, OUT), STATUS.DLL_NOT_FOUND);
    assert.equal(call('LdrGetDllHandleEx', 3, 0, 0, NAME, OUT), STATUS.INVALID_PARAMETER);
});

test('a load that waits, and one that finds nothing', async()=>{
    const { view, call, counted } = machine();
    counted('late.dll');
    assert.equal(await call('LdrLoadDll', 0, 0, NAME, OUT), STATUS.SUCCESS);
    assert.equal(view.getUint32(OUT, true), 0x20000000);
    counted('none.dll');
    assert.equal(await call('LdrLoadDll', 0, 0, NAME, OUT), STATUS.DLL_NOT_FOUND);
});

test('a search path is the directories looked in alone; low bit set, it is search flags', async()=>{
    const { view, call, counted, loads } = machine();
    const PATH = 0x400;
    const path = 'C:\\One;D:\\Two\\';
    for (let i = 0; i < path.length; i++)
    {
        view.setUint16(PATH + i * 2, path.charCodeAt(i), true);
    }
    counted('x.dll');
    view.setUint32(OUT, 0xdeadbeef, true);
    assert.equal(await call('LdrLoadDll', PATH, 0, NAME, OUT), STATUS.SUCCESS);
    assert.deepEqual(loads.splice(0), ['C:\\One\\x.dll', 'D:\\Two\\x.dll'], 'in order');
    assert.equal(view.getUint32(OUT, true), 0x20000000);
    view.setUint32(OUT, 0xdeadbeef, true);
    assert.equal(await call('LdrLoadDll', 0x801, 0, NAME, OUT), STATUS.DLL_NOT_FOUND);
    assert.deepEqual(loads.splice(0), [['x.dll', 0x800]], 'LoadLibraryEx\'s flags');
    assert.equal(view.getUint32(OUT, true), 0xdeadbeef, 'a failed load leaves the out alone');
    counted('C:\\Full\\x.dll');
    await call('LdrLoadDll', PATH, 0, NAME, OUT);
    assert.deepEqual(loads.splice(0), ['C:\\Full\\x.dll'], 'a full path is not searched for');
});

test('a library found and refused ends the search: its section\'s status, or its failed start',
    async()=>{
        // Wine's kernel32:loader (test_image_mapping): LdrLoadDll maps what it
        // finds; a file NtCreateSection(SEC_IMAGE) refuses ends the search
        // with that status, one whose DllMain fails with
        // STATUS_DLL_INIT_FAILED, and one a section takes but the load still
        // refuses is passed over for the next directory.
        const STATUS_INVALID_IMAGE_NOT_MZ = 0xc000012f;
        /** @type {Map<string, number>} */
        const files = new Map();
        /** @type {number[]} */
        const closed = [];
        let opened = '';
        /** @type {(code: number) => void} */
        let failWith = ()=>{};
        let wideAt = (/** @type {number} */ at)=>String(at);
        const one = machine({
            LoadLibraryW: { handler: (/** @type {number[]} */ [name])=>{
                const text = wideAt(name);
                if (text === 'C:\\One\\x.dll' && (files.get(text) ?? 0) < 0)
                {
                    failWith(files.get(text) === -1 ? 1114 : 87);
                }
                else
                {
                    failWith(126);
                }
                return text === 'D:\\Two\\x.dll' ? 0x20000000 : 0;
            } },
            CreateFileW: { handler: (/** @type {number[]} */ [name])=>{
                opened = wideAt(name);
                return files.has(opened) ? 0x44 : 0xffffffff;
            } },
            CloseHandle: { handler: (/** @type {number[]} */ [handle])=>closed.push(handle) },
            CreateFileMappingW: { handler: ()=>0, natives: { NtCreateSection: {
                handler: ()=>Math.max(files.get(opened) ?? 0, 0) } } },
        });
        ({ failWith, wideAt } = one);
        const { view, call, counted } = one;
        const PATH = 0x400;
        const path = 'C:\\One;D:\\Two';
        for (let i = 0; i < path.length; i++)
        {
            view.setUint16(PATH + i * 2, path.charCodeAt(i), true);
        }
        counted('x.dll');
        assert.equal(await call('LdrLoadDll', PATH, 0, NAME, OUT), STATUS.SUCCESS,
            'none there: the next directory');
        files.set('C:\\One\\x.dll', 0);
        assert.equal(await call('LdrLoadDll', PATH, 0, NAME, OUT), STATUS.SUCCESS,
            'a section takes it, the load does not: the next directory');
        assert.deepEqual(closed.splice(0), [0, 0x44], 'the section and the file closed');
        files.set('C:\\One\\x.dll', STATUS_INVALID_IMAGE_NOT_MZ);
        view.setUint32(OUT, 0xdeadbeef, true);
        assert.equal(await call('LdrLoadDll', PATH, 0, NAME, OUT), STATUS_INVALID_IMAGE_NOT_MZ);
        assert.equal(view.getUint32(OUT, true), 0xdeadbeef);
        assert.deepEqual(closed.splice(0), [0x44], 'the file closed');
        files.set('C:\\One\\x.dll', -1);
        assert.equal(await call('LdrLoadDll', PATH, 0, NAME, OUT), 0xc0000142,
            'STATUS_DLL_INIT_FAILED');
        files.set('C:\\One\\x.dll', -2);
        assert.equal(await call('LdrLoadDll', PATH, 0, NAME, OUT), STATUS.INVALID_PARAMETER,
            'refused as asked');
    });

test('LdrGetDllPath answers the search\'s directories in a block RtlReleasePath gives back', ()=>{
    const { view, call, wideAt } = machine();
    const MODULE = 0x400;
    const module = 'C:\\Lib\\a.dll';
    for (let i = 0; i < module.length; i++)
    {
        view.setUint16(MODULE + i * 2, module.charCodeAt(i), true);
    }
    view.setUint32(OUT + 4, 0xdeadbeef, true);
    assert.equal(call('LdrGetDllPath', MODULE, 0x800, OUT, OUT + 4), STATUS.SUCCESS);
    assert.equal(wideAt(view.getUint32(OUT, true)), 'for C:\\Lib\\a.dll;800');
    assert.equal(view.getUint32(OUT + 4, true), 0, 'the unknown out NULL');
    assert.equal(call('RtlReleasePath', view.getUint32(OUT, true)), 0);
    assert.equal(call('LdrGetDllPath', 0, 0, 0, OUT + 4), STATUS.INVALID_PARAMETER);
});

test('a DLL notification is registered by its callback and context and taken back once', ()=>{
    const { view, call, registered } = machine();
    assert.equal(call('LdrRegisterDllNotification', 0, 0x401000, 0x1234, OUT), STATUS.SUCCESS);
    const cookie = view.getUint32(OUT, true);
    assert.deepEqual(registered.get(cookie), { callback: 0x401000, context: 0x1234 });
    assert.equal(call('LdrRegisterDllNotification', 1, 0x401000, 0, OUT),
        STATUS.INVALID_PARAMETER, 'flags must be zero');
    assert.equal(call('LdrRegisterDllNotification', 0, 0, 0, OUT), STATUS.INVALID_PARAMETER);
    assert.equal(call('LdrUnregisterDllNotification', cookie), STATUS.SUCCESS);
    assert.equal(call('LdrUnregisterDllNotification', cookie), STATUS.DLL_NOT_FOUND,
        'a cookie already taken back');
});

test('an export by name or ordinal, and the status each miss is', ()=>{
    const { view, call, counted } = machine();
    counted('Run', 1);
    assert.equal(call('LdrGetProcedureAddress', 0x10000000, NAME, 0, OUT), STATUS.SUCCESS);
    assert.equal(view.getUint32(OUT, true), 0x10002000);
    assert.equal(call('LdrGetProcedureAddress', 0x10000000, 0, 7, OUT), STATUS.SUCCESS);
    counted('Walk', 1);
    assert.equal(call('LdrGetProcedureAddress', 0x10000000, NAME, 0, OUT), 0xc000007a);
    assert.equal(call('LdrGetProcedureAddress', 0x10000000, 0, 8, OUT), 0xc0000138);
});

test('the loader lock is taken with a cookie; a try with nowhere to answer is refused', ()=>{
    const { view, call } = machine();
    assert.equal(call('LdrLockLoaderLock', 0, OUT, OUT + 4), STATUS.SUCCESS);
    assert.equal(view.getUint32(OUT, true), 1);
    const cookie = view.getUint32(OUT + 4, true);
    assert.notEqual(cookie, 0);
    assert.equal(call('LdrLockLoaderLock', 2, 0, OUT + 4), 0xc00000f0);
    assert.equal(view.getUint32(OUT + 4, true), 0, 'the cookie cleared, by a refusal too');
    view.setUint32(OUT, 10, true);
    assert.equal(call('LdrLockLoaderLock', 0, OUT, 0), 0xc00000f1, 'no cookie');
    assert.equal(view.getUint32(OUT, true), 0, 'the disposition cleared');
    assert.equal(call('LdrUnlockLoaderLock', 0, cookie), STATUS.SUCCESS);
    assert.equal(call('LdrUnlockLoaderLock', 0, 0), 0xc00000f0);
});

test('LdrGetDllDirectory fills a counted string; one too small is told the bytes it needs',
    ()=>{
    // Wine's kernel32:module (test_SetDllDirectory): a string with room has
    // the directory and its length without the terminator; one without is
    // STATUS_BUFFER_TOO_SMALL, its length the bytes needed with the
    // terminator, its buffer an empty string.
        const directory = 'C:\\Libs';
        /** @type {DataView} */
        let into = new DataView(new ArrayBuffer(0));
        const one = machine({
            GetDllDirectoryW: { handler: (/** @type {number[]} */ [size, buffer])=>{
                if (directory.length + 1 > size)
                {
                    return directory.length + 1;
                }
                for (let i = 0; i <= directory.length; i++)
                {
                    const unit = i < directory.length ? directory.charCodeAt(i) : 0;
                    into.setUint16(buffer + i * 2, unit, true);
                }
                return directory.length;
            } },
        });
        into = one.view;
        const { view, call, wideAt } = one;
        const STRING = 0x400;
        const BUFFER = 0x500;
        view.setUint32(STRING + 4, BUFFER, true);
        view.setUint16(STRING + 2, 64, true);
        assert.equal(call('LdrGetDllDirectory', STRING), STATUS.SUCCESS);
        assert.equal(view.getUint16(STRING, true), directory.length * 2);
        assert.equal(wideAt(BUFFER), directory);
        for (let at = BUFFER; at < BUFFER + 16; at += 2)
        {
            view.setUint16(at, 0xcccc, true);
        }
        view.setUint16(STRING + 2, (directory.length - 1) * 2, true);
        assert.equal(call('LdrGetDllDirectory', STRING), STATUS.BUFFER_TOO_SMALL);
        assert.equal(view.getUint16(STRING, true), (directory.length + 1) * 2);
        assert.deepEqual([view.getUint16(BUFFER, true), view.getUint16(BUFFER + 2, true)],
            [0, 0xcccc]);
    });

test('LdrShutdownProcess begins the shutdown RtlDllShutdownInProgress answers', async()=>{
    // Wine's kernel32:loader (child phase 0): before it the process is not
    // shutting down; LdrShutdownProcess tells the images DLL_PROCESS_DETACH,
    // the process goes on, and from then on it is.
    let begun = false;
    let told = 0;
    /** @param {number} address @param {number} length */
    const readMemory = (address, length)=>new Uint8Array(length);
    const table = createLoaderFunctions({
        readMemory, writeMemory: ()=>{}, kernel32: {}, allocate: ()=>0x1000, free: ()=>true,
        shutdown: {
            inProgress: ()=>begun,
            begin: ()=>{
                begun = true;
                told++;
                return Promise.resolve();
            },
            terminate: ()=>{},
        },
    });
    assert.equal(table.RtlDllShutdownInProgress.handler([]), 0);
    assert.equal(await table.LdrShutdownProcess.handler([]), STATUS.SUCCESS);
    assert.equal(told, 1, 'the images told');
    assert.equal(table.RtlDllShutdownInProgress.handler([]), 1);

    const none = createLoaderFunctions({
        readMemory, writeMemory: ()=>{}, kernel32: {}, allocate: ()=>0, free: ()=>true });
    assert.equal(none.LdrShutdownProcess, undefined, 'not exported with no shutdown to begin');
    assert.equal(none.RtlDllShutdownInProgress.handler([]), 0);
});
