/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the module hands the system libraries it assembles.
 *
 * Several libraries take a capability from the module rather than build it
 * themselves -- a wide-string reader, the heap, whether a library is one the
 * engine answers for -- and each has tests of its
 * own with a fake in its place. What those cannot show is that the module
 * passes the real one; these build the module and ask through it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32Module } from './module.js';
import { filesystemModule } from '../filesystem/module.js';

const ARENA = { base: 0x100000, size: 0x200000 };

/**
 * The least of a module graph this layer can be built over, on real bytes.
 *
 * @param {Record<string, any>} [replace]  Whole APIs, or kernel entries, to use
 *   in place of the stand-ins.
 */
function hostOver(replace = {}){
    const bytes = new Uint8Array(0x400000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, { type: string, object: any }>} */
    const opened = new Map();
    let nextHandle = 0x100;
    /** @type {Record<string, any>} */
    const apis = {
        memory: {
            /** @param {number} at @param {number} length */
            readBytes: (at, length)=>bytes.slice(at, at + length),
            /** @param {number} at @param {Uint8Array} data */
            writeBytes: (at, data)=>bytes.set(data, at),
            /** @param {number} at @param {number} value @param {number} length */
            fillBytes: (at, value, length)=>bytes.fill(value, at, at + length),
            /** @param {number} at @param {number} max */
            readCString(at, max){
                let text = '';
                for (let i = at; i < at + max && bytes[i] !== 0; i++)
                {
                    text += String.fromCharCode(bytes[i]);
                }
                return text;
            },
            /** @param {number} at @param {number} max */
            readWideString(at, max){
                let text = '';
                for (let i = at; i < at + max * 2 && view.getUint16(i, true) !== 0; i += 2)
                {
                    text += String.fromCharCode(view.getUint16(i, true));
                }
                return text;
            },
            /** @param {number} at */
            readU32: at=>view.getUint32(at, true),
            find: ()=>null,
            scanCString: ()=>({ index: 0, byte: 0 }),
        },
        kernel: {
            handles: {
                /** @param {string} type @param {any} object */
                open(type, object){
                    const handle = nextHandle++;
                    opened.set(handle, { type, object });
                    return handle;
                },
                /** @param {number} handle */
                close: handle=>(opened.delete(handle) ? true : null),
                /** @param {number} handle */
                resolve: handle=>opened.get(handle)?.object ?? null,
                /** @param {number} handle */
                typeOf: handle=>opened.get(handle)?.type ?? null,
            },
            clock: { virtualTime: ()=>0 },
            currentThread: ()=>null,
            exitThread: ()=>{},
            setEvent: ()=>{},
            onTimeout: ()=>{},
        },
        bridge: {
            register: ()=>0,
            park: ()=>0,
            useHeap: ()=>{},
            publishInterface: ()=>0,
            callGuest: ()=>Promise.resolve(0),
            callerThread: ()=>null,
            label: ()=>{},
        },
        filesystem: replace.filesystem ?? { drives: ()=>[], stat: ()=>null },
    };
    Object.assign(apis.kernel, replace.kernel ?? {});
    const host = /** @type {any} */ ({
        /** @param {string} name */
        requireApi: name=>apis[name],
        provide: ()=>{},
    });
    return { bytes, view, host };
}

/** @param {Record<string, any>} [replace] */
async function build(replace){
    const { bytes, view, host } = hostOver(replace);
    const api = /** @type {any} */ (await win32Module.create(/** @type {any} */ ({
        arena: ARENA,
        modules: {
            find: ()=>null,
            byBase: ()=>null,
            imagePath: ()=>'C:\\app.exe',
            versionInfo: ()=>null,
            /** @param {string} name */
            systemLibrary: name=>name.toLowerCase() === 'kernel32.dll',
        },
    }), host));
    return { bytes, view, libraries: api.libraries(), lastError: ()=>api.lastError() };
}

test('SHLWAPI\'s wide spellings read wide strings', async()=>{
    const { view, libraries } = await build();
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        [...text, '\0'].forEach((ch, i)=>view.setUint16(at + i * 2, ch.charCodeAt(0), true));
        return at;
    };
    const out = 0x3000;
    assert.equal(libraries['SHLWAPI.dll'].PathCombineW.handler(
        [out, wide(0x1000, 'C:\\Games'), wide(0x2000, 'save.dat')]), out);
    let text = '';
    for (let at = out; view.getUint16(at, true) !== 0; at += 2)
    {
        text += String.fromCharCode(view.getUint16(at, true));
    }
    assert.equal(text, 'C:\\Games\\save.dat');
    await win32Module.dispose();
});

test('VERSION knows which libraries the engine answers for', async()=>{
    const { bytes, libraries } = await build();
    bytes.set([...'kernel32.dll\0'].map(ch=>ch.charCodeAt(0)), 0x4000);
    assert.ok(libraries['VERSION.dll'].GetFileVersionInfoSizeA.handler([0x4000, 0]) > 0);
    await win32Module.dispose();
});

test('an mmio buffer comes from the program\'s heap', async()=>{
    // mmioGetInfo hands the buffer's pointers to the program, so the buffer
    // mmio allocates has to be guest memory.
    const MMIO_ALLOCBUF = 0x10000;
    const FOURCC_MEM = 0x204d454d;
    const { view, libraries } = await build();
    const info = 0x5000;
    view.setUint32(info + 4, FOURCC_MEM, true);
    view.setUint32(info + 20, 256, true);
    const handle = libraries['WINMM.dll'].mmioOpenA.handler([0, info, 0]);
    assert.notEqual(handle, 0);
    const got = 0x5100;
    assert.equal(libraries['WINMM.dll'].mmioGetInfo.handler([handle, got, 0]), 0);
    assert.equal(view.getUint32(got, true) & MMIO_ALLOCBUF, MMIO_ALLOCBUF);
    const buffer = view.getUint32(got + 24, true);
    assert.ok(buffer >= ARENA.base && buffer < ARENA.base + ARENA.size,
        `the buffer is in the arena: 0x${buffer.toString(16)}`);
    assert.equal(libraries['WINMM.dll'].mmioClose.handler([handle, 0]), 0);
    await win32Module.dispose();
});

test('the synchronisation calls leave their failures as the thread\'s last error', async()=>{
    // A suspend the kernel refuses (the count is at its maximum) and a one-time
    // initialisation begun with flags that cannot go together each answer
    // failure; GetLastError then has to say why.
    const ERROR_SIGNAL_REFUSED = 156;
    const ERROR_INVALID_PARAMETER = 87;
    const thread = { id: 1 };
    const { libraries, lastError } = await build({
        kernel: { currentThread: ()=>thread, suspendThread: ()=>null },
    });
    const kernel32 = libraries['KERNEL32.dll'];
    const CURRENT_THREAD = 0xfffffffe;

    assert.equal(kernel32.SuspendThread.handler([CURRENT_THREAD]), 0xffffffff);
    assert.equal(lastError(), ERROR_SIGNAL_REFUSED);

    const INIT_ONCE_CHECK_ONLY_ASYNC = 3;
    assert.equal(kernel32.InitOnceBeginInitialize.handler(
        [0x6000, INIT_ONCE_CHECK_ONLY_ASYNC, 0x6004, 0x6008]), 0);
    assert.equal(lastError(), ERROR_INVALID_PARAMETER);
    await win32Module.dispose();
});

test('a structure written to a profile is read from guest memory and read back', async()=>{
    const filesystem = await filesystemModule.create({});
    const thread = { id: 1 };
    const { bytes, libraries, lastError } = await build({
        filesystem,
        kernel: { currentThread: ()=>thread },
    });
    const kernel32 = libraries['KERNEL32.dll'];
    /** @param {number} at @param {string} text */
    const narrow = (at, text)=>{
        bytes.set([...text, '\0'].map(ch=>ch.charCodeAt(0)), at);
        return at;
    };
    const section = narrow(0x1000, 'Setup');
    const key = narrow(0x1100, 'Window');
    const file = narrow(0x1200, 'C:\\app.ini');
    bytes.set([0x10, 0x20, 0x30, 0x40], 0x2000);

    assert.equal(kernel32.WritePrivateProfileStructA.handler([section, key, 0x2000, 4, file]),
        1, `written, last error ${lastError()}`);
    assert.equal(kernel32.GetPrivateProfileStructA.handler([section, key, 0x3000, 4, file]), 1);
    assert.deepEqual([...bytes.subarray(0x3000, 0x3004)], [0x10, 0x20, 0x30, 0x40]);
    await win32Module.dispose();
    await filesystemModule.dispose();
});
