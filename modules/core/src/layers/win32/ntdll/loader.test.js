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
function machine(){
    const bytes = new Uint8Array(0x30000);
    const view = new DataView(bytes.buffer);
    // Above 64 KiB: GetProcAddress takes a pointer below it for an ordinal.
    let next = 0x20000;
    let lastError = 0;
    /** @type {{ flags: number, name: string }[]} */
    const asked = [];
    /** @type {any[]} */
    const loads = [];
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
    return { view, call, counted, asked, loads, wideAt };
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
    assert.notEqual(view.getUint32(OUT + 4, true), 0);
    assert.equal(call('LdrLockLoaderLock', 2, 0, OUT + 4), 0xc00000f0);
    assert.equal(call('LdrUnlockLoaderLock', 0, view.getUint32(OUT + 4, true)), STATUS.SUCCESS);
    assert.equal(call('LdrUnlockLoaderLock', 0, 0), 0xc00000f0);
});
