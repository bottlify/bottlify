/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';
import { IID_ISEQUENTIAL_STREAM, IID_ISTREAM, createFileArguments } from './stream.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const STG_E_ACCESSDENIED = 0x80030005 | 0;
const STG_E_INVALIDPOINTER = 0x80030009 | 0;
const STG_E_LOCKVIOLATION = 0x80030021 | 0;

const STGM_READ = 0x0;
const STGM_WRITE = 0x1;
const STGM_READWRITE = 0x2;
const STGM_SHARE_EXCLUSIVE = 0x10;
const STGM_SHARE_DENY_WRITE = 0x20;
const STGM_CREATE = 0x1000;
const STGM_TRANSACTED = 0x10000;
const STGM_CONVERT = 0x20000;
const STGM_DELETEONRELEASE = 0x4000000;

const SLOTS = ['QueryInterface', 'AddRef', 'Release', 'Read', 'Write', 'Seek', 'SetSize', 'CopyTo',
    'Commit', 'Revert', 'LockRegion', 'UnlockRegion', 'Stat', 'Clone'];

/**
 * A machine whose streams are kept by pointer, with a volume of files that
 * kernel32's handle calls read and write.
 */
function machine(){
    /** @type {Map<number, any>} */
    const objects = new Map();
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** @type {Map<number, { name: string, at: number }>} */
    const handles = new Map();
    let nextHandle = 0x100;
    let nextPointer = 0x7000;
    let lastError = 0;
    /** @type {any} */
    let m = null;
    const kernel32 = {
        CreateFileW: (/** @type {number[]} */ [path, , , , disposition])=>{
            const name = m.read(path, true);
            if (disposition === 3 && !files.has(name))
            {
                lastError = 2;
                return -1;
            }
            if (disposition === 1 && files.has(name))
            {
                lastError = 80;
                return -1;
            }
            if (disposition === 2 || !files.has(name))
            {
                files.set(name, new Uint8Array(0));
            }
            handles.set(nextHandle, { name, at: 0 });
            return nextHandle++;
        },
        GetLastError: ()=>lastError,
        SetFilePointer: (/** @type {number[]} */ [handle, low])=>{
            /** @type {any} */ (handles.get(handle)).at = low;
            return low;
        },
        ReadFile: (/** @type {number[]} */ [handle, buffer, length, count])=>{
            const open = /** @type {any} */ (handles.get(handle));
            const bytes = /** @type {Uint8Array} */ (files.get(open.name))
                .slice(open.at, open.at + length);
            m.memory.set(bytes, buffer);
            m.view.setUint32(count, bytes.length, true);
            open.at += bytes.length;
            return 1;
        },
        WriteFile: (/** @type {number[]} */ [handle, buffer, length, count])=>{
            const open = /** @type {any} */ (handles.get(handle));
            const old = /** @type {Uint8Array} */ (files.get(open.name));
            const grown = new Uint8Array(Math.max(old.length, open.at + length));
            grown.set(old);
            grown.set(m.memory.subarray(buffer, buffer + length), open.at);
            files.set(open.name, grown);
            m.view.setUint32(count, length, true);
            open.at += length;
            return 1;
        },
        GetFileSize: (/** @type {number[]} */ [handle, high])=>{
            m.view.setUint32(high, 0, true);
            return /** @type {Uint8Array} */ (files.get(
                /** @type {any} */ (handles.get(handle)).name)).length;
        },
        SetEndOfFile: (/** @type {number[]} */ [handle])=>{
            const open = /** @type {any} */ (handles.get(handle));
            const old = /** @type {Uint8Array} */ (files.get(open.name));
            files.set(open.name, old.slice(0, open.at));
            return 1;
        },
        CloseHandle: (/** @type {number[]} */ [handle])=>(handles.delete(handle) ? 1 : 0),
    };
    let taskMemory = 0x60000;
    m = shlwapiMachine({
        library: name=>{
            /** @type {Record<string, (args: number[]) => number>} */
            const table = name === 'KERNEL32.dll' ? kernel32 : name === 'ole32.dll'
                ? { CoTaskMemAlloc: ([bytes])=>{
                    const at = taskMemory;
                    taskMemory += bytes + 16;
                    return at;
                } } : {};
            return Object.fromEntries(Object.entries(table).map(([key, handler])=>[key,
                { handler }]));
        },
        publish: (object, iid)=>{
            assert.equal(iid, IID_ISTREAM);
            objects.set(nextPointer, object);
            return (nextPointer += 16) - 16;
        },
    });
    /**
     * A stream method called as the program calls it.
     *
     * @param {number} pointer @param {string} name @param {number[]} args
     */
    const call = async(pointer, name, ...args)=>{
        const object = objects.get(pointer);
        const method = object.interfaceFor(IID_ISTREAM).methods[SLOTS.indexOf(name)];
        assert.equal(method.name, name);
        return /** @type {number} */ (await method.invoke(object, args)) | 0;
    };
    /** @param {number} handler @param {number[]} args */
    const open = async(handler, ...args)=>{
        const out = m.count(0xdeadbeef);
        const status = await m.fns[handler === 0 ? 'SHCreateStreamOnFileW'
            : 'SHCreateStreamOnFileEx'].handler([...args.slice(0, -1), out]);
        return { status, stream: m.dwordAt(out) };
    };
    return { ...m, objects, files, handles, call, open };
}

test('SHCreateStreamOnFile turns a mode into CreateFile\'s arguments', ()=>{
    assert.deepEqual(createFileArguments(STGM_READ, false),
        { access: 0x80000000, sharing: 3, disposition: 3 });
    assert.deepEqual(createFileArguments(STGM_WRITE | STGM_SHARE_EXCLUSIVE, false),
        { access: 0xc0000000, sharing: 0, disposition: 3 }, 'a stream to write reads too');
    assert.deepEqual(createFileArguments(STGM_READWRITE | STGM_SHARE_DENY_WRITE | STGM_CREATE,
        false), { access: 0xc0000000, sharing: 1, disposition: 2 });
    assert.deepEqual(createFileArguments(STGM_READ, true).disposition, 1, 'fCreate: a new file');
});

test('SHCreateStreamOnFile refuses what the short form cannot do, and answers kernel32\'s errors',
    async()=>{
        // Wine's test_SHCreateStreamOnFileA and test_SHCreateStreamOnFileW.
        const m = machine();
        const path = m.put('C:\\testW.txt', true);
        for (const flag of [STGM_CONVERT, STGM_DELETEONRELEASE, STGM_TRANSACTED])
        {
            assert.deepEqual(await m.open(0, path, STGM_READ | flag, 0),
                { status: E_INVALIDARG, stream: 0 });
        }
        assert.deepEqual(await m.open(0, 0, STGM_READ, 0), { status: 0x80070003 | 0, stream: 0 });
        assert.deepEqual(await m.open(0, path, STGM_READ, 0),
            { status: 0x80070002 | 0, stream: 0 });
        const made = await m.open(0, path, STGM_READ | STGM_CREATE, 0);
        assert.equal(made.status, S_OK);
        assert.ok(m.files.has('C:\\testW.txt'));
        assert.deepEqual(await m.open(1, path, STGM_READ, 0, 1, 0, 0),
            { status: 0x80070050 | 0, stream: 0 }, 'fCreate on a file that is there');
        assert.deepEqual(await m.open(1, path, STGM_READ | STGM_TRANSACTED, 0, 0, 0, 0),
            { status: E_INVALIDARG, stream: 0 }, 'a transacted stream to read');
        assert.equal((await m.open(1, path, STGM_READ | STGM_DELETEONRELEASE, 0, 0, 0, 0)).status,
            S_OK, 'the Ex form takes the flags the short one refuses');
    });

test('a file stream reads, writes and seeks as Windows\' does', async()=>{
    // Wine's test_stream_read_write and test_IStream_invalid_operations.
    const m = machine();
    const path = m.put('C:\\t.txt', true);
    const { stream } = await m.open(0, path, STGM_WRITE | STGM_CREATE, 0);
    const buffer = m.put('', false, 64);
    const count = m.count(0xdeadbeaf);
    m.memory.set([0x5e, 0xa7], buffer);
    assert.equal(await m.call(stream, 'Write', buffer, 2, count), S_OK);
    assert.equal(m.dwordAt(count), 2);
    assert.equal(await m.call(stream, 'Seek', 0, 0, 0, 0), S_OK);
    assert.equal(await m.call(stream, 'Read', buffer + 8, 2, count), S_OK,
        'a stream to write reads');
    assert.deepEqual([...m.memory.subarray(buffer + 8, buffer + 10)], [0x5e, 0xa7]);
    assert.equal(await m.call(stream, 'Read', buffer, 0, count), S_OK);
    assert.equal(await m.call(stream, 'Read', buffer, 16, count), S_FALSE, 'short');
    assert.equal(m.dwordAt(count), 0);
    assert.equal(await m.call(stream, 'Read', 0, 0, count), S_OK);
    assert.equal(await m.call(stream, 'Read', 0, 4, count), STG_E_INVALIDPOINTER);
    assert.equal(await m.call(stream, 'Seek', 0, 0, 20, 0), E_INVALIDARG);
    const position = m.put('', false, 8);
    assert.equal(await m.call(stream, 'Seek', 0, 0, 2, position), S_OK);
    assert.equal(m.dwordAt(position), 2, 'from the end');
    assert.equal(await m.call(stream, 'CopyTo', 0, 0, 0, position, position), S_OK);
    assert.equal(await m.call(stream, 'Commit', 0), S_OK);
    assert.equal(await m.call(stream, 'Revert'), E_NOTIMPL);
    assert.equal(await m.call(stream, 'LockRegion', 0, 0, 0, 0, 0), S_OK);
    assert.equal(await m.call(stream, 'UnlockRegion', 0, 0, 0, 0, 0), S_OK);
    assert.equal(await m.call(stream, 'UnlockRegion', 0, 0, 0, 0, 0), STG_E_LOCKVIOLATION);
    assert.equal(await m.call(stream, 'Stat', 0, 0), STG_E_INVALIDPOINTER);
    const stat = m.put('', false, 72);
    assert.equal(await m.call(stream, 'Stat', stat, 0), S_OK);
    assert.equal(m.read(m.dwordAt(stat), true), 'C:\\t.txt', 'named, in task memory');
    assert.deepEqual([m.dwordAt(stat + 4), m.dwordAt(stat + 8), m.dwordAt(stat + 40)],
        [2, 2, STGM_WRITE | STGM_CREATE]);
    assert.equal(await m.call(stream, 'Stat', stat, 1), S_OK);
    assert.equal(m.dwordAt(stat), 0, 'STATFLAG_NONAME');
    const clone = m.count(0);
    assert.equal(await m.call(stream, 'Clone', clone), E_NOTIMPL);
    assert.equal(m.dwordAt(clone), 0);
    assert.equal(await m.call(stream, 'SetSize', 1, 0), S_OK);
    assert.deepEqual([.../** @type {Uint8Array} */ (m.files.get('C:\\t.txt'))], [0x5e]);

    const { stream: reader } = await m.open(0, path, STGM_READ, 0);
    assert.equal(m.dwordAt(count), 0);
    m.view.setUint32(count, 0xdeadbeaf, true);
    assert.equal(await m.call(reader, 'Write', buffer, 2, count), STG_E_ACCESSDENIED);
    assert.equal(m.dwordAt(count), 0xdeadbeaf, 'the count untouched');
    assert.equal(await m.call(reader, 'Write', 0, 0, count), STG_E_ACCESSDENIED);
    assert.equal(await m.call(reader, 'SetSize', 0, 0), STG_E_ACCESSDENIED);

    const qi = m.objects.get(stream).interfaceFor(IID_ISEQUENTIAL_STREAM);
    assert.equal(qi?.methods[3].name, 'Read', 'ISequentialStream is IStream\'s first two methods');
    m.objects.get(stream).release();
    assert.equal(m.handles.size, 1, 'the last release closes the file');
});

test('CopyTo copies what there is into another of the streams', async()=>{
    // Wine's test_SHCreateStreamOnFileEx_CopyTo: a count past the end falls short.
    const m = machine();
    const { stream: source } = await m.open(1, m.put('C:\\a', true),
        STGM_READWRITE | STGM_CREATE, 0, 0, 0, 0);
    const { stream: target } = await m.open(1, m.put('C:\\b', true),
        STGM_READWRITE | STGM_CREATE, 0, 0, 0, 0);
    const buffer = m.put('x');
    assert.equal(await m.call(source, 'Write', buffer, 1, 0), S_OK);
    assert.equal(await m.call(source, 'Seek', 0, 0, 0, 0), S_OK);
    const read = m.put('', false, 8);
    const written = m.put('', false, 8);
    assert.equal(await m.call(source, 'CopyTo', target, 2, 0, read, written), S_OK);
    assert.deepEqual([m.dwordAt(read), m.dwordAt(written)], [1, 1]);
    assert.deepEqual([.../** @type {Uint8Array} */ (m.files.get('C:\\b'))], [0x78]);
});

test('SHCreateMemStream is a stream over a copy, read and written alike', async()=>{
    // Wine's test_SHCreateMemStream.
    const m = machine();
    const stream = /** @type {number} */ (m.fns.SHCreateMemStream.handler([0, 0]));
    const buffer = m.put('', false, 16);
    const count = m.count(0);
    assert.equal(await m.call(stream, 'Read', buffer, 10, count), S_FALSE);
    m.memory.fill(0x55, buffer, buffer + 10);
    assert.equal(await m.call(stream, 'Write', buffer, 10, count), S_OK);
    assert.equal(await m.call(stream, 'Seek', 0, 0, 0, 0), S_OK);
    m.memory.fill(0, buffer, buffer + 10);
    assert.equal(await m.call(stream, 'Read', buffer, 10, count), S_OK);
    assert.deepEqual([...m.memory.subarray(buffer, buffer + 10)], new Array(10).fill(0x55));
    assert.equal(await m.call(stream, 'Read', buffer, 10, count), S_FALSE);
    m.memory.fill(0x11, buffer, buffer + 10);
    assert.equal(await m.call(stream, 'Write', buffer, 10, count), S_OK);
    assert.equal(await m.call(stream, 'Seek', -10 >>> 0, 0, 1, 0), S_OK,
        'back ten bytes: -sizeof(buffer) is 0xfffffff6 widened unsigned');
    m.memory.fill(0, buffer, buffer + 10);
    assert.equal(await m.call(stream, 'Read', buffer, 10, count), S_OK);
    assert.deepEqual([...m.memory.subarray(buffer, buffer + 10)], new Array(10).fill(0x11));
    const initial = m.put('abc');
    const copy = /** @type {number} */ (m.fns.SHCreateMemStream.handler([initial, 3]));
    m.memory[initial] = 0x7a;
    assert.equal(await m.call(copy, 'Read', buffer, 3, count), S_OK);
    assert.equal(m.read(buffer).slice(0, 3), 'abc', 'its own copy');
});
