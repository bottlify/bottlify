/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A byte stream over a file, as Wine's test_file_stream says Windows answers:
 * a reader shares reading only, a writer nothing; the stream keeps its own
 * position, past the end too; it answers IMFAttributes with the file's name
 * and modification time, and IMFGetService with no service.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mfMachine } from './machine.fixture.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const MF_E_UNSUPPORTED_SERVICE = 0xc00d36ba | 0;
const SHARING_VIOLATION = 0x80070020 | 0;
const FILE_NOT_FOUND = 0x80070002 | 0;
const FILE_EXISTS = 0x80070050 | 0;
const IID_IMFATTRIBUTES = '{2CD2D921-C447-44A7-A13C-4ADABFC247E3}';
const IID_IMFGETSERVICE = '{FA993888-4383-415A-A930-DD472A8CF6F7}';
const ORIGIN_NAME = '{FC358288-3CB6-460C-A424-B6681260375A}';
const LAST_MODIFIED = '{FC35828B-3CB6-460C-A424-B6681260375A}';
const READ = 1;
const WRITE = 2;
const FAIL_IF_NOT_EXIST = 0;
const FAIL_IF_EXIST = 1;

/**
 * Files as CreateFile keeps them: their bytes, and the opens on each with
 * their access and sharing, checked both ways as Windows checks them.
 */
function fakeFiles(){
    /** @type {Map<string, Uint8Array>} */
    const disk = new Map([['C:\\test.mp4', Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)]]);
    /** @type {Map<number, { path: string, access: number, share: number }>} */
    const handles = new Map();
    let next = 4;
    /** @type {import('./bytestream.js').FileCalls} */
    const files = {
        open: async(path, access, share, disposition)=>{
            const exists = disk.has(path);
            if (!exists && disposition === 3)
            {
                return { error: 2 };
            }
            if (exists && disposition === 1)
            {
                return { error: 80 };
            }
            for (const open of handles.values())
            {
                if (open.path !== path)
                {
                    continue;
                }
                // Each open's sharing must allow the other's access.
                const theirsAllow = ((access & 0x80000000) === 0 || (open.share & 1) !== 0)
                    && ((access & 0x40000000) === 0 || (open.share & 2) !== 0);
                const oursAllow = ((open.access & 0x80000000) === 0 || (share & 1) !== 0)
                    && ((open.access & 0x40000000) === 0 || (share & 2) !== 0);
                if (!theirsAllow || !oursAllow)
                {
                    return { error: 32 };
                }
            }
            if (!exists)
            {
                disk.set(path, new Uint8Array(0));
            }
            const handle = next;
            next += 4;
            handles.set(handle, { path, access, share });
            return { handle };
        },
        transfer: async()=>({ done: 0 }),
        size: async handle=>BigInt(disk.get(/** @type {any} */ (handles.get(handle)).path)?.length
            ?? 0),
        setSize: async()=>true,
        flush: async()=>true,
        modified: async()=>Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
        close: handle=>{
            handles.delete(handle);
        },
    };
    return { files, handles };
}

/** A machine whose mfplat reads files from `fakeFiles`. */
function machine(){
    const { files, handles } = fakeFiles();
    const m = mfMachine({ files });
    return { ...m, handles };
}

/**
 * @param {ReturnType<typeof machine>} m @param {number} access @param {number} open
 * @param {string} path
 */
async function create(m, access, open, path){
    const out = m.out(4);
    const hr = await m.mf.table.MFCreateFile.handler([access, open, 0, m.wide(path), out]);
    return { hr, stream: m.u32(out) };
}

test('a stream over a file: its capabilities, its length, a position past the end kept', async()=>{
    const m = machine();
    const { hr, stream } = await create(m, READ, FAIL_IF_NOT_EXIST, 'C:\\test.mp4');
    assert.equal(hr, S_OK);
    const out = m.out(8);
    assert.equal(await m.call(stream, 'GetCapabilities', out), S_OK);
    assert.equal(m.u32(out), 0x1 | 0x4, 'readable and seekable');
    assert.equal(await m.call(stream, 'GetLength', 0), E_INVALIDARG);
    assert.equal(await m.call(stream, 'GetLength', out), S_OK);
    assert.equal(m.u32(out), 8);
    assert.equal(await m.call(stream, 'SetCurrentPosition', 8, 0), S_OK);
    assert.equal(await m.call(stream, 'IsEndOfStream', out), S_OK);
    assert.equal(m.u32(out), 1);
    assert.equal(await m.call(stream, 'SetCurrentPosition', 16, 0), S_OK);
    assert.equal(await m.call(stream, 'GetCurrentPosition', 0), E_INVALIDARG);
    assert.equal(await m.call(stream, 'GetCurrentPosition', out), S_OK);
    assert.equal(m.u32(out), 16);
});

test('the stream\'s attributes are the file\'s name and modification time; no service', async()=>{
    const m = machine();
    const { stream } = await create(m, READ, FAIL_IF_NOT_EXIST, 'C:\\test.mp4');
    const attributes = m.out(4);
    assert.equal(await m.call(stream, 'QueryInterface', m.guid(IID_IMFATTRIBUTES), attributes),
        S_OK);
    const store = m.u32(attributes);
    const out = m.out(8);
    assert.equal(await m.call(store, 'GetCount', out), S_OK);
    assert.equal(m.u32(out), 2);
    assert.equal(await m.call(store, 'GetStringLength', m.guid(ORIGIN_NAME), out), S_OK);
    assert.equal(m.u32(out), 'C:\\test.mp4'.length);
    assert.equal(await m.call(store, 'GetItemType', m.guid(LAST_MODIFIED), out), S_OK);
    assert.equal(m.u32(out), 0x1011, 'a blob');
    const service = m.out(4);
    assert.equal(await m.call(stream, 'QueryInterface', m.guid(IID_IMFGETSERVICE), service), S_OK);
    assert.equal(await m.call(m.u32(service), 'GetService', m.guid(ORIGIN_NAME),
        m.guid(IID_IMFATTRIBUTES), out), MF_E_UNSUPPORTED_SERVICE);
});

test('a reader shares reading only, a writer nothing; missing and existing files refused',
    async()=>{
        const m = machine();
        const first = await create(m, READ, FAIL_IF_NOT_EXIST, 'C:\\test.mp4');
        assert.equal((await create(m, READ, FAIL_IF_NOT_EXIST, 'C:\\test.mp4')).hr, S_OK);
        assert.equal((await create(m, WRITE, FAIL_IF_NOT_EXIST, 'C:\\test.mp4')).hr,
            SHARING_VIOLATION);
        assert.equal((await create(m, READ, FAIL_IF_NOT_EXIST, 'C:\\new.mp4')).hr, FILE_NOT_FOUND);
        assert.equal((await create(m, WRITE, FAIL_IF_EXIST, 'C:\\test.mp4')).hr, FILE_EXISTS);
        const written = await create(m, WRITE, FAIL_IF_EXIST, 'C:\\new.mp4');
        assert.equal(written.hr, S_OK);
        assert.equal((await create(m, READ, FAIL_IF_NOT_EXIST, 'C:\\new.mp4')).hr,
            SHARING_VIOLATION);
        assert.notEqual((await create(m, READ, FAIL_IF_NOT_EXIST, 'file://C:\\test.mp4')).hr, S_OK,
            'a URL is not a file name');
        await m.call(first.stream, 'Release');
        assert.equal(m.handles.size, 2, 'the released stream closed its file');
    });
