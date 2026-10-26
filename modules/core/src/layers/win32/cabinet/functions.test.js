/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { COMPRESSION } from './cabinet.js';
import { buildCabinet } from './cabinet.fixture.js';
import { FDIERROR, FDINT, createCabinetFunctions } from './functions.js';

/** @param {number} length @param {number} seed */
const pattern = (length, seed)=>Uint8Array.from({ length }, (_, at)=>(at * 13 + seed) % 247);

const CAB = 'C:\\dir\\data.cab';
const ENTRIES = { alloc: 0x1000, free: 0x1004, open: 0x1008, read: 0x100c, write: 0x1010,
    close: 0x1014, seek: 0x1018, notify: 0x101c };

/**
 * The guest: a block of memory, and the callbacks a program hands FDI, each
 * a function here reached by its address. The cabinet is a file the program
 * "opens" by name; what it is told to write is collected by handle.
 *
 * @param {Uint8Array} cabinet
 * @param {(kind: number, fields: Record<string, any>) => number} [onNotify]
 */
function setup(cabinet, onNotify){
    const memory = new Uint8Array(0x40000);
    let top = 0x2000;
    /** @type {Map<number, Uint8Array[]>} */
    const written = new Map();
    /** @type {Map<number, number>} */
    const positions = new Map();
    /** @type {[number, Record<string, any>][]} */
    const notifications = [];
    let nextHandle = 7;
    const view = new DataView(memory.buffer);
    /** @param {number} at */
    const text = at=>{
        let end = at;
        while (memory[end] !== 0)
        {
            end++;
        }
        return String.fromCharCode(...memory.subarray(at, end));
    };
    const calls = [];
    const host = {
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            memory.subarray(address, address + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
            memory.set(bytes, address);
        },
        readCString: (/** @type {number} */ address)=>text(address),
        allocate: (/** @type {number} */ bytes)=>{
            const at = top;
            top += (bytes + 15) & ~15;
            return at;
        },
        free: ()=>{},
        callerThread: ()=>({}),
        call: (/** @type {number} */ entry, /** @type {number[]} */ args)=>{
            calls.push(entry);
            switch (entry)
            {
                case ENTRIES.open:
                {
                    const name = text(args[0]);
                    if (name === CAB)
                    {
                        positions.set(1, 0);
                        return 1;
                    }
                    const handle = nextHandle++;
                    written.set(handle, []);
                    return handle;
                }
                case ENTRIES.seek:
                {
                    const [handle, distance, how] = args;
                    // SetFilePointer on a handle that is no file.
                    if (handle === 0xffffffff)
                    {
                        return 0xffffffff;
                    }
                    const at = how === 2 ? cabinet.length + (distance | 0)
                        : how === 1 ? (positions.get(handle) ?? 0) + (distance | 0) : distance;
                    positions.set(handle, at);
                    return at;
                }
                case ENTRIES.read:
                {
                    const [handle, buffer, length] = args;
                    const at = positions.get(handle) ?? 0;
                    const part = cabinet.subarray(at, at + length);
                    memory.set(part, buffer);
                    positions.set(handle, at + part.length);
                    return part.length;
                }
                case ENTRIES.write:
                {
                    const [handle, buffer, length] = args;
                    written.get(handle)?.push(memory.slice(buffer, buffer + length));
                    return length;
                }
                case ENTRIES.close:
                    return 0;
                case ENTRIES.notify:
                {
                    const [kind, address] = args;
                    const fields = {
                        cb: view.getInt32(address, true),
                        psz1: view.getUint32(address + 4, true) === 0 ? '' : text(
                            view.getUint32(address + 4, true)),
                        psz2: view.getUint32(address + 8, true) === 0 ? '' : text(
                            view.getUint32(address + 8, true)),
                        pv: view.getUint32(address + 16, true),
                        hf: view.getInt32(address + 20, true),
                        attribs: view.getUint16(address + 28, true),
                        setId: view.getUint16(address + 30, true),
                        iFolder: view.getUint16(address + 34, true),
                    };
                    notifications.push([kind, fields]);
                    if (onNotify)
                    {
                        return onNotify(kind, fields);
                    }
                    if (kind !== FDINT.COPY_FILE)
                    {
                        return 1;
                    }
                    const handle = nextHandle++;
                    written.set(handle, []);
                    return handle;
                }
                default:
                    return 0;
            }
        },
    };
    const fns = /** @type {Record<string, any>} */ (createCabinetFunctions(host));
    const erf = 0x100;
    const ctx = fns.FDICreate.handler([ENTRIES.alloc, ENTRIES.free, ENTRIES.open, ENTRIES.read,
        ENTRIES.write, ENTRIES.close, ENTRIES.seek, 1, erf]);
    memory.set([...CAB].map(character=>character.charCodeAt(0)), 0x200);
    memory.set([...'C:\\dir\\'].map(character=>character.charCodeAt(0)), 0x300);
    memory.set([...'data.cab'].map(character=>character.charCodeAt(0)), 0x340);
    return { fns, ctx, memory, view, written, notifications, erf };
}

const sample = ()=>{
    const first = pattern(32768, 1);
    const second = pattern(2000, 2);
    return buildCabinet({
        folders: [{ compression: COMPRESSION.MSZIP, blocks: [
            { packed: Uint8Array.from([0x43, 0x4b, ...deflateRawSync(first)]), size: 32768 },
            { packed: Uint8Array.from([0x43, 0x4b, ...deflateRawSync(second,
                { dictionary: first })]), size: 2000 },
        ] }],
        files: [
            { name: 'a.bin', size: 30000, offset: 0, folder: 0 },
            { name: 'b.bin', size: 4768, offset: 30000, folder: 0 },
        ],
    });
};

test('FDICopy tells of each file, gives it the handle the program answered, and closes it',
    async()=>{
        const { fns, ctx, written, notifications, erf, view } = setup(sample());
        assert.notEqual(ctx, 0);
        assert.equal(view.getUint32(erf + 8, true), 0, 'no error recorded');
        assert.equal(await fns.FDICopy.handler([ctx, 0x340, 0x300, 0, ENTRIES.notify, 0, 0x77]), 1);
        assert.deepEqual(notifications.map(([kind, fields])=>[kind, fields.psz1]), [
            [FDINT.CABINET_INFO, ''], [FDINT.COPY_FILE, 'a.bin'], [FDINT.CLOSE_FILE_INFO, 'a.bin'],
            [FDINT.COPY_FILE, 'b.bin'], [FDINT.CLOSE_FILE_INFO, 'b.bin'],
        ], 'one file at a time, as the folder decodes');
        assert.equal(notifications[1][1].cb, 30000, 'the size');
        assert.equal(notifications[1][1].pv, 0x77, 'the program\'s own pointer comes back');
        const handles = [...written.keys()];
        const joined = (/** @type {number} */ handle)=>{
            const chunks = /** @type {Uint8Array[]} */ (written.get(handle));
            const out = new Uint8Array(chunks.reduce((sum, chunk)=>sum + chunk.length, 0));
            let at = 0;
            for (const chunk of chunks)
            {
                out.set(chunk, at);
                at += chunk.length;
            }
            return out;
        };
        const whole = new Uint8Array(34768);
        whole.set(pattern(32768, 1));
        whole.set(pattern(2000, 2), 32768);
        assert.deepEqual(joined(handles[0]), whole.subarray(0, 30000));
        assert.deepEqual(joined(handles[1]), whole.subarray(30000));
        assert.equal(notifications[2][1].hf, handles[0], 'the close names the handle it was given');
    });

test('a file answered with no handle is skipped, and -1 stops the copy', async()=>{
    let seen = 0;
    const skip = setup(sample(), kind=>{
        if (kind !== FDINT.COPY_FILE)
        {
            return 1;
        }
        return seen++ === 0 ? 0 : 99;
    });
    assert.equal(await skip.fns.FDICopy.handler(
        [skip.ctx, 0x340, 0x300, 0, ENTRIES.notify, 0, 0]), 1);
    assert.deepEqual([...skip.written.keys()], [], 'nothing was written for the first');
    const stop = setup(sample(), kind=>(kind === FDINT.COPY_FILE ? -1 : 1));
    assert.equal(await stop.fns.FDICopy.handler(
        [stop.ctx, 0x340, 0x300, 0, ENTRIES.notify, 0, 0]), 0);
    assert.equal(stop.view.getUint32(stop.erf, true), FDIERROR.USER_ABORT);
    assert.equal(stop.view.getUint32(stop.erf + 8, true), 1, 'fError set');
});

test('FDIIsCabinet answers for a cabinet and says what is not one', async()=>{
    const { fns, ctx, view, erf } = setup(sample());
    assert.equal(await fns.FDIIsCabinet.handler([ctx, 1, 0x400]), 1);
    assert.equal(view.getUint16(0x404, true), 1, 'folders');
    assert.equal(view.getUint16(0x406, true), 2, 'files');
    const bad = setup(new Uint8Array(100));
    assert.equal(await bad.fns.FDIIsCabinet.handler([bad.ctx, 1, 0x400]), 0);
    assert.equal(bad.view.getUint32(bad.erf + 8, true), 0, 'the ERF is left alone');
    // Wine's fdi test: a handle of -1, whose seek fails, is no cabinet either.
    assert.equal(await fns.FDIIsCabinet.handler([ctx, 0xffffffff, 0x400]), 0);
    void erf;
});

test('the entry points are C calling convention and a context is destroyed once', ()=>{
    const { fns, ctx } = setup(sample());
    for (const name of ['FDICreate', 'FDIIsCabinet', 'FDICopy', 'FDIDestroy'])
    {
        assert.equal(fns[name].convention, 'cdecl', name);
    }
    assert.deepEqual([fns.FDICreate.argBytes, fns.FDICopy.argBytes, fns.FDIIsCabinet.argBytes,
        fns.FDIDestroy.argBytes], [36, 28, 12, 4]);
    assert.equal(fns.FDIDestroy.handler([ctx]), 1);
    assert.equal(fns.FDIDestroy.handler([ctx]), 0);
    assert.equal(fns.FDICreate.handler([0, 0, 0, 0, 0, 0, 0, 1, 0]), 0, 'no callbacks, no context');
});
