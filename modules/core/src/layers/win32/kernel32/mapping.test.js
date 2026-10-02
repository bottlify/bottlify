/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMappingFunctions } from './mapping.js';
import { createNamedObjects } from './named-objects.js';

const INVALID_HANDLE_VALUE = 0xffffffff;
const PAGE_READWRITE = 0x04;
const PAGE_READONLY = 0x02;
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_READ = 0x0004;

/**
 * @param {Record<number, string>} [names] What each name pointer spells, for
 *   the tests that are about named mappings. Every other test passes nothing
 *   and every pointer reads as the empty name, which is no name at all.
 */
function setup(names = {}){
    const bytes = new Uint8Array(0x4000);
    /** @type {Map<number, { type: string, object: any }>} */
    const table = new Map();
    let nextHandle = 4;
    let nextAddress = 0x1000;
    /** @type {number[]} */
    const errors = [];
    /** @type {[any, number][]} */
    const errorsFor = [];
    /** The one file a mapping can be made of, as a byte array. */
    /** @type {{ data: Uint8Array, arrives?: Promise<boolean> }} */
    const file = { data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };

    /** @type {string[]} */
    const said = [];
    const fns = createMappingFunctions({
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: pointer=>names[pointer] ?? '',
        readWideString: pointer=>names[pointer] ?? '',
        namedObjects: createNamedObjects(),
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
        currentThread: ()=>'the-caller',
        /** @param {any} thread @param {number} code */
        setLastErrorFor: (thread, code)=>{
            errorsFor.push([thread, code]);
        },
        files: {
            /** @param {any} node @param {number} offset @param {number} length */
            read: (node, offset, length)=>{
                const block = node.data.slice(offset, offset + length);
                if (node.arrives)
                {
                    return node.arrives.then((/** @type {boolean} */ ok)=>{
                        if (!ok)
                        {
                            throw new Error('the block did not arrive');
                        }
                        return block;
                    });
                }
                return block;
            },
            write: (node, offset, data)=>{
                node.data.set(data, offset);
                return data.length;
            },
            /** @param {any} node */
            size: node=>node.data.length,
            retain: ()=>{},
            close: ()=>{},
        },
    });

    const fileHandle = nextHandle;
    nextHandle += 4;
    // Shaped as kernel32 keeps an open file: the volume's node is a field of
    // the record a handle resolves to, not the record itself.
    table.set(fileHandle, { type: 'file', object: { node: file, position: 0 } });
    return { fns, bytes, errors, errorsFor, file, fileHandle, said };
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

test('a mapping of a file with no size given is as large as the file', ()=>{
    // The usual way a program maps a file whole: neither the mapping nor the
    // view names a size, and both mean "all of it".
    const { fns, bytes, file, fileHandle } = setup();
    const mapping = fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READONLY, 0, 0, 0]);
    assert.notEqual(mapping, 0);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 0]);
    assert.notEqual(view, 0);
    assert.deepEqual([...bytes.slice(view, view + file.data.length)], [...file.data]);
    assert.equal(fns.UnmapViewOfFile.handler([view]), 1);

    file.data = new Uint8Array(0);
    assert.equal(fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READONLY, 0, 0, 0]), 0,
        'an empty file cannot be mapped');
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

test('a second CreateFileMapping by the same name finds the first, wide or ansi', ()=>{
    const ERROR_ALREADY_EXISTS = 183;
    const NAME = 0x900;
    const { fns, errors, fileHandle } = setup({ [NAME]: 'MyShmem' });

    const first = fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READWRITE, 0, 8, NAME]);
    assert.notEqual(first, 0);
    assert.equal(errors.at(-1), 0, 'a fresh create is not an error');

    const second = fns.CreateFileMappingW.handler(
        [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 4, NAME]);
    assert.equal(errors.at(-1), ERROR_ALREADY_EXISTS,
        'the size and file of the second create are ignored -- the name found the first');

    const firstView = fns.MapViewOfFile.handler([first, FILE_MAP_WRITE, 0, 0, 8]);
    const secondView = fns.MapViewOfFile.handler([second, FILE_MAP_WRITE, 0, 0, 8]);
    assert.notEqual(firstView, 0);
    assert.notEqual(secondView, 0,
        'the second handle names a real mapping, not an anonymous fallback');
});

test('CreateFileMappingA argBytes accounts for the name', ()=>{
    const { fns } = setup();
    assert.equal(fns.CreateFileMappingA.argBytes, 24);
    assert.equal(fns.CreateFileMappingW.argBytes, 24);
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

test('a view of a file whose bytes are not here yet is answered when they are', async()=>{
    // A volume backed by a bundle answers a read with a promise while the
    // block is still arriving. A program that maps an archive it has just
    // opened used to be told it had run out of memory; it is parked instead,
    // as a read parks it, and gets its view once the bytes are there.
    const { fns, bytes, file, fileHandle, errors } = setup();
    /** @type {(ok: boolean) => void} */
    let arrive = ()=>{};
    file.arrives = new Promise(resolve=>{
        arrive = resolve;
    });
    const mapping = fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READWRITE, 0, 8, 0]);
    const answer = fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 8]);
    assert.equal(typeof answer.then, 'function', 'the caller is parked on the bytes');
    arrive(true);
    const view = await answer;
    assert.notEqual(view, 0);
    assert.deepEqual([...bytes.slice(view, view + 8)], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(errors, [0],
        'the create cleared the last error; nothing after it went wrong');
    assert.equal(fns.UnmapViewOfFile.handler([view]), 1);
});

test('a view whose bytes never arrive fails on the caller, not on whoever runs then', async()=>{
    const { fns, file, fileHandle, errorsFor } = setup();
    file.arrives = Promise.resolve(false);
    const mapping = fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READWRITE, 0, 8, 0]);
    const view = await fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 8]);
    assert.equal(view, 0);
    assert.deepEqual(errorsFor, [['the-caller', 1117]],
        'ERROR_IO_DEVICE, on the thread that asked');
});

test('OpenFileMapping finds a named mapping, and says why when it cannot', ()=>{
    const NAME = 0x900;
    const OTHER = 0x940;
    const { fns, errors } = setup({ [NAME]: 'Local\\Foo', [OTHER]: 'Nothing' });
    const made = fns.CreateFileMappingA.handler(
        [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 0x1000, NAME]);
    assert.notEqual(made, 0);

    const opened = fns.OpenFileMappingW.handler([FILE_MAP_WRITE, 0, NAME]);
    assert.notEqual(opened, 0);
    assert.notEqual(opened, made, 'a handle of its own onto the same mapping');
    const view = fns.MapViewOfFile.handler([opened, FILE_MAP_WRITE, 0, 0, 0]);
    assert.notEqual(view, 0);

    errors.length = 0;
    assert.equal(fns.OpenFileMappingA.handler([FILE_MAP_WRITE, 0, OTHER]), 0);
    assert.equal(fns.OpenFileMappingA.handler([FILE_MAP_WRITE, 0, 0]), 0);
    assert.deepEqual(errors, [2, 87], 'no such name, and no name at all');
    assert.equal(fns.OpenFileMappingA.argBytes, 12);
    assert.equal(fns.OpenFileMappingW.argBytes, 12);
});

test('a section in the global namespace is not the program\'s to make, not being elevated', ()=>{
    // SeCreateGlobalPrivilege, which a program started the usual way does not
    // hold (Wine's dinput hid.c skips its driver tests on this answer).
    const GLOBAL = 0x900;
    const LOCAL = 0x940;
    const { fns, errors } = setup({ [GLOBAL]: 'Global\\winetest_section', [LOCAL]: 'Local\\Foo' });
    errors.length = 0;
    assert.equal(fns.CreateFileMappingW.handler(
        [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 0x1000, GLOBAL]), 0);
    assert.deepEqual(errors, [5], 'ERROR_ACCESS_DENIED');
    assert.notEqual(fns.CreateFileMappingW.handler(
        [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 0x1000, LOCAL]), 0);
});

test('CreateNamedPipe is refused as Windows 9x refuses it, and says so', ()=>{
    // With no namespace for a client to open the other end in, a server end
    // would be a handle nothing can ever connect to.
    const { fns, errors, said } = setup();
    for (const entry of [fns.CreateNamedPipeA, fns.CreateNamedPipeW])
    {
        assert.equal(entry.argBytes, 32);
        assert.equal(entry.handler() >>> 0, 0xffffffff);
        assert.equal(errors.at(-1), 120, 'ERROR_CALL_NOT_IMPLEMENTED');
    }
    assert.equal(said.length, 2);
    assert.match(said[1], /^CreateNamedPipeW: /);
});

test('the other named-pipe calls are refused the same way, each popping its own arguments', ()=>{
    // Wine's kernel32 process.c connects the pipe it could not create.
    const { fns, errors, said } = setup();
    const table = /** @type {Record<string, any>} */ (fns);
    for (const [name, argBytes] of /** @type {[string, number][]} */ ([
        ['ConnectNamedPipe', 8], ['DisconnectNamedPipe', 4], ['WaitNamedPipeA', 8],
        ['WaitNamedPipeW', 8], ['TransactNamedPipe', 28], ['GetNamedPipeInfo', 20],
        ['GetNamedPipeHandleStateA', 28], ['SetNamedPipeHandleState', 16]]))
    {
        assert.equal(table[name].argBytes, argBytes, name);
        assert.equal(table[name].handler(), 0, name);
        assert.equal(errors.at(-1), 120, 'ERROR_CALL_NOT_IMPLEMENTED');
        assert.match(said.at(-1) ?? '', new RegExp(`^${name}: `));
    }
});

test('CreateMailslot is refused, and says so', ()=>{
    const { fns, errors, said } = setup();
    for (const entry of [fns.CreateMailslotA, fns.CreateMailslotW])
    {
        assert.equal(entry.argBytes, 16);
        assert.equal(entry.handler() >>> 0, 0xffffffff);
        assert.equal(errors.at(-1), 120, 'ERROR_CALL_NOT_IMPLEMENTED');
    }
    assert.match(said[1], /^CreateMailslotW: /);
});
