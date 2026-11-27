/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiskSpaceFunctions } from './diskspace.js';

const FILEOP_COPY = 0;
const FILEOP_RENAME = 1;
const FILEOP_DELETE = 2;
const ERROR_INVALID_DRIVE = 15;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_NAME = 123;

function build(existing = /** @type {Record<string, number>} */ ({})){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    /** @type {Map<number, any>} */
    const handles = new Map();
    let next = 0x40;
    const fns = /** @type {Record<string, any>} */ (createDiskSpaceFunctions({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        text: at=>{
            if (at === 0)
            {
                return null;
            }
            let end = at;
            while (bytes[end] !== 0)
            {
                end++;
            }
            return String.fromCharCode(...bytes.subarray(at, end));
        },
        encode: value=>Uint8Array.from([...value, '\0'], c=>c.charCodeAt(0)),
        fullPath: name=>(/^[A-Za-z]:/.test(name) ? name : `C:\\cwd\\${name}`),
        sizeOf: path=>existing[path] ?? null,
        setLastError: code=>errors.push(code),
        open: (type, object)=>{
            handles.set(next, { type, object });
            return next++;
        },
        resolve: (handle, type)=>{
            const held = handles.get(handle);
            if (!held || held.type !== type)
            {
                throw new Error('not a list');
            }
            return held.object;
        },
        close: handle=>handles.delete(handle),
    }));
    let argAt = 0x100;
    /** @param {string} text */
    const str = text=>{
        const at = argAt;
        bytes.set([...text, '\0'].map(c=>c.charCodeAt(0)), at);
        argAt += text.length + 16;
        return at;
    };
    const space = 0x8000;
    /** @param {number} list @param {string} drive */
    const query = (list, drive)=>(fns.SetupQuerySpaceRequiredOnDriveA.handler([list, str(drive),
        space, 0, 0]) ? Number(view.getBigInt64(space, true)) : `error ${errors.at(-1)}`);
    /** @param {number} list @param {string} path @param {number} size @param {number} op */
    const add = (list, path, size, op)=>fns.SetupAddToDiskSpaceListA.handler([list, str(path), size,
        0, op, 0, 0]);
    return { fns, view, errors, str, query, add, bytes };
}

test('a list counts a file once, in clusters, a copy replacing a delete but not the reverse', ()=>{
    // Wine's setupapi test_SetupQuerySpaceRequiredOnDriveA.
    const { fns, query, add } = build();
    const list = fns.SetupCreateDiskSpaceListA.handler([0, 0, 0]);
    assert.equal(query(list, 'c:'), `error ${ERROR_INVALID_DRIVE}`, 'a drive it has nothing on');
    add(list, 'C:/file1', 10000, FILEOP_COPY);
    add(list, 'C:/file2', 13, FILEOP_COPY);
    add(list, 'C:\\file1', 5000, FILEOP_COPY);
    add(list, 'C:/file1', 4000, FILEOP_DELETE);
    add(list, 'D:/file1', 4000, FILEOP_COPY);
    assert.equal(query(list, 'c:'), 4096 * 3);
    for (const drive of ['c', 'c:\\'])
    {
        assert.equal(query(list, drive), `error ${ERROR_INVALID_DRIVE}`, drive);
    }
});

test('a file already there counts what it holds, unless the disk is to be ignored', ()=>{
    const { fns, query, add } = build({ 'C:\\temp\\f': 1025 });
    const list = fns.SetupCreateDiskSpaceListA.handler([0, 0, 0]);
    add(list, 'C:\\temp\\f', 10000, FILEOP_DELETE);
    assert.equal(query(list, 'C:'), -4096, 'a delete gives back its clusters');
    add(list, 'C:\\temp\\f', 4097, FILEOP_COPY);
    assert.equal(query(list, 'C:'), 4096, 'a copy over it needs what it grows by');
    const ignoring = fns.SetupCreateDiskSpaceListA.handler([0, 0, 1]);
    add(ignoring, 'C:\\temp\\f', 4097, FILEOP_COPY);
    assert.equal(query(ignoring, 'C:'), 8192);
});

test('what cannot be listed, and the drives a list has, as Windows answers them', ()=>{
    // Wine's setupapi test_add_files and test_query_drives.
    const { fns, errors, view, str, add, bytes } = build();
    assert.equal(fns.SetupCreateDiskSpaceListA.handler([0, 0, ~0]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    const list = fns.SetupCreateDiskSpaceListA.handler([0, 0, 0]);
    assert.equal(fns.SetupDuplicateDiskSpaceListA.handler([0, 1, 0, 0]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER, 'the reserved arguments before the list');
    for (const [path, op, error] of /** @type {[string, number, number][]} */ ([
        ['W:/file1', FILEOP_RENAME, ERROR_INVALID_PARAMETER], ['W:/dir/', FILEOP_COPY,
            ERROR_INVALID_PARAMETER], ['\\\\unc\\file1', FILEOP_COPY, ERROR_INVALID_PARAMETER],
        ['', FILEOP_COPY, ERROR_INVALID_NAME]]))
    {
        assert.equal(add(list, path, 0, op), 0, path);
        assert.equal(errors.at(-1), error, path);
    }
    for (const path of ['P:/file1', 'H:file3', 'R:/file4'])
    {
        assert.equal(add(list, path, 123, FILEOP_DELETE), 1, path);
    }
    const out = str('\xcc'.repeat(19));
    const needed = 0x9000;
    assert.equal(fns.SetupQueryDrivesInDiskSpaceListA.handler([list, out, 4, needed]), 0);
    assert.equal(errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(view.getUint32(needed, true), 7, 'as far as the first drive that did not fit');
    assert.deepEqual([...bytes.subarray(out, out + 4)], [0x68, 0x3a, 0, 0xcc]);
    assert.equal(fns.SetupQueryDrivesInDiskSpaceListA.handler([list, out, 20, needed]), 1);
    assert.equal(String.fromCharCode(...bytes.subarray(out, out + 10)), 'h:\0p:\0r:\0\0');
    assert.equal(view.getUint32(needed, true), 10);
});
