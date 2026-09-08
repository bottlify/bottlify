/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMappingFunctions } from './mapping.js';

const INVALID_HANDLE_VALUE = 0xffffffff;
const PAGE_READWRITE = 0x04;
const PAGE_READONLY = 0x02;
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_READ = 0x0004;

function setup(){
    const bytes = new Uint8Array(0x4000);
    /** @type {Map<number, { type: string, object: any }>} */
    const table = new Map();
    let nextHandle = 4;
    let nextAddress = 0x1000;
    /** @type {number[]} */
    const errors = [];
    /** The one file a mapping can be made of, as a byte array. */
    const file = { data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };

    const fns = createMappingFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        setLastError: code=>{
            errors.push(code);
        },
        allocate: size=>{
            const address = nextAddress;
            nextAddress += size + 16;
            return address;
        },
        release: ()=>{},
        handles: {
            open: (type, object)=>{
                const handle = nextHandle;
                nextHandle += 4;
                table.set(handle, { type, object });
                return handle;
            },
            resolve: (handle, type)=>{
                const entry = table.get(handle);
                if (!entry || (type && entry.type !== type))
                {
                    throw new Error('bad handle');
                }
                return entry.object;
            },
            close: handle=>table.delete(handle),
        },
        files: {
            read: (node, offset, length)=>node.data.slice(offset, offset + length),
            write: (node, offset, data)=>{
                node.data.set(data, offset);
                return data.length;
            },
        },
    });

    const fileHandle = nextHandle;
    nextHandle += 4;
    table.set(fileHandle, { type: 'file', object: file });
    return { fns, bytes, errors, file, fileHandle };
}

/** @param {Uint8Array} bytes @param {number} at */
const dword = (bytes, at)=>
    (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

test('a view of a file starts as that file, and is written back when unmapped', ()=>{
    // The whole point of the copy: a read through the view sees the file, and a
    // write through it reaches the file. Skipping the write-back is a save that
    // a program believes it made and that is not there afterwards.
    const { fns, bytes, file, fileHandle } = setup();
    const mapping = fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READWRITE, 0, 8, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_WRITE, 0, 0, 8]);

    assert.deepEqual([...bytes.slice(view, view + 8)], [1, 2, 3, 4, 5, 6, 7, 8]);

    bytes[view + 2] = 0x99;
    assert.equal(fns.UnmapViewOfFile.handler([view]), 1);
    assert.equal(file.data[2], 0x99);
});

test('a read-only view is not written back', ()=>{
    const { fns, bytes, file, fileHandle } = setup();
    const mapping = fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READONLY, 0, 8, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 8]);

    bytes[view] = 0x77;
    fns.UnmapViewOfFile.handler([view]);
    assert.equal(file.data[0], 1, 'the file kept what it had');
});

test('a mapping with no file must be told its size', ()=>{
    // There is nothing else to derive one from, and a zero-length view would be
    // a pointer into nothing that a caller goes on to write through.
    const { fns } = setup();
    assert.equal(
        fns.CreateFileMappingA.handler([INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 0, 0]),
        0);
    assert.notEqual(
        fns.CreateFileMappingA.handler([INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 64, 0]),
        0);
});

test('unmapping an address nobody was given fails', ()=>{
    const { fns } = setup();
    assert.equal(fns.UnmapViewOfFile.handler([0x1234]), 0);
});

test('a pipe is one queue with two handles, and peeking does not consume', ()=>{
    const { fns, bytes } = setup();
    assert.equal(fns.CreatePipe.handler([0x200, 0x204, 0, 0]), 1);
    const read = dword(bytes, 0x200);
    const write = dword(bytes, 0x204);
    assert.notEqual(read, write);

    // Nothing has been written, so the queue is empty and says so rather than
    // reporting bytes a caller would then try to read.
    assert.equal(fns.PeekNamedPipe.handler([read, 0x300, 16, 0x310, 0x314, 0x318]), 1);
    assert.equal(dword(bytes, 0x310), 0);
    assert.equal(dword(bytes, 0x314), 0);
    assert.equal(fns.PeekNamedPipe.handler([write, 0x300, 16, 0x310, 0x314, 0x318]), 0,
        'and the writing end is not the end you peek');
});
