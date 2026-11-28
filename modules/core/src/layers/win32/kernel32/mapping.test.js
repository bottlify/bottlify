/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingGuest } from '../common/guest.fixture.js';
import { createMappingFunctions, imageRefusal, imageSections, imageViewAt } from './mapping.js';
import { mapImage } from '../../loader/internal/image.js';
import { imageKind } from '../../loader/internal/pe.js';
import { imageWriteCopy, protectionWithin, sectionRights, viewProtection }
    from './view-rights.js';
import { createNamedObjects } from './named-objects.js';
import { readIntoBy } from './vfs.js';
import { buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';

const INVALID_HANDLE_VALUE = 0xffffffff;
const PAGE_READWRITE = 0x04;
const PAGE_READONLY = 0x02;
const FILE_MAP_COPY = 0x0001;
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_READ = 0x0004;

/**
 * @param {Record<number, string>} [names] What each name pointer spells, for
 *   the tests that are about named mappings. Every other test passes nothing
 *   and every pointer reads as the empty name, which is no name at all.
 */
/** @param {Record<number, string>} [names] @param {Record<string, any>} [extra] */
function setup(names = {}, extra = {}){
    const bytes = new Uint8Array(0x100000);
    /** Where a view was placed by address, so a second one there is refused. */
    const placed = new Set();
    /** Holds taken on the file and not given back. */
    let holds = 0;
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
    // A name the test hands reads as its text, in either width.
    const memory = recordingGuest({ names });
    memory.use(bytes);
    const fns = createMappingFunctions({
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
        guest: memory.guest,
        namedObjects: createNamedObjects(),
        setLastError: code=>{
            errors.push(code);
        },
        allocate: (size, { alignment = 8 } = {})=>{
            const address = Math.ceil(nextAddress / alignment) * alignment;
            nextAddress = address + size + 16;
            return address;
        },
        allocateAt: (address, size)=>{
            if (placed.has(address) || address + size > bytes.length)
            {
                return false;
            }
            placed.add(address);
            return true;
        },
        release: ()=>{},
        zero: (address, length)=>void bytes.fill(0, address, address + length),
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
            /**
             * Through `read` as it is when called: a test may put another in its place.
             *
             * @param {any} node @param {number} offset @param {number} length
             * @param {(bytes: Uint8Array, at: number) => void} put
             * @returns {number | Promise<number>}
             */
            readInto(node, offset, length, put){
                return readIntoBy(this.read)(node, offset, length, put);
            },
            /** @type {(node: any, offset: number, length: number) => Uint8Array | Promise<Uint8Array>} */
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
            retain: ()=>{
                holds++;
            },
            close: ()=>{
                holds--;
            },
        },
        ...extra,
    });

    const fileHandle = nextHandle;
    nextHandle += 4;
    // Shaped as kernel32 keeps an open file: the volume's node is a field of
    // the record a handle resolves to, not the record itself.
    table.set(fileHandle, { type: 'file', object: { node: file, position: 0 } });
    return { fns, bytes, errors, errorsFor, file, fileHandle, said, table,
        /** How many holds on the file are taken and not given back. */
        held: ()=>holds };
}

/** @param {Uint8Array} bytes @param {number} at */
const dword = (bytes, at)=>
    (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

test('a view starts on an allocation granule, as every view on Windows does', ()=>{
    // A program that maps a file a window at a time unmaps at the granule it
    // works out from the view's address; one mid-granule had it unmap
    // nothing and stop reading.
    const { fns } = setup();
    const mapping = fns.CreateFileMappingA.handler([INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0,
        0x100, 0]);
    const first = fns.MapViewOfFile.handler([mapping, FILE_MAP_WRITE, 0, 0, 0x100]);
    const second = fns.MapViewOfFile.handler([mapping, FILE_MAP_WRITE, 0, 0, 0x100]);
    assert.deepEqual([first % 0x10000, second % 0x10000], [0, 0]);
    assert.notEqual(first, second);
    assert.equal(fns.UnmapViewOfFile.handler([second]), 1);
});

test('a directory opened for its handle has no bytes to map', ()=>{
    const { fns, errors, table } = setup();
    table.set(0x7000, { type: 'file',
        object: { path: 'C:\\GAME', node: null, directory: true, position: 0 } });
    assert.equal(fns.CreateFileMappingA.handler([0x7000, 0, PAGE_READWRITE, 0, 0x100, 0]), 0);
    assert.equal(errors.at(-1), 5, 'ERROR_ACCESS_DENIED');
});

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

test('a flushed view reaches its file at once, from the address flushed on, and stays', ()=>{
    // What a program that keeps a file mapped -- a launcher's registry of
    // what it has installed -- relies on to have its writes in the file while
    // it goes on working through the view.
    const { fns, bytes, file, fileHandle, errors } = setup();
    const mapping = fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READWRITE, 0, 8, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_WRITE, 0, 0, 8]);
    bytes[view + 1] = 0x11;
    bytes[view + 5] = 0x55;
    bytes[view + 6] = 0x66;

    assert.equal(fns.FlushViewOfFile.argBytes, 8);
    assert.equal(fns.FlushViewOfFile.handler([view + 4, 2]), 1);
    assert.deepEqual([...file.data], [1, 2, 3, 4, 5, 0x55, 7, 8],
        'the two bytes from the address flushed');
    assert.equal(fns.FlushViewOfFile.handler([view + 1, 0]), 1);
    assert.deepEqual([...file.data], [1, 0x11, 3, 4, 5, 0x55, 0x66, 8],
        'and with no count, the rest of the view');
    bytes[view] = 0x99;
    assert.equal(fns.UnmapViewOfFile.handler([view]), 1, 'the view was still there');
    assert.equal(file.data[0], 0x99);

    assert.equal(fns.FlushViewOfFile.handler([view, 0]), 0, 'unmapped, there is nothing to flush');
    assert.equal(errors.at(-1), 87);
});

test('MapViewOfFileEx puts a view where it is asked, on a granule, unless that is taken', ()=>{
    // A heap library's shared pool and a debugging library's image maps ask
    // for an address; a null one is anywhere, as MapViewOfFile.
    const { fns, bytes, fileHandle, errors } = setup();
    const mapping = fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READWRITE, 0, 8, 0]);
    assert.equal(fns.MapViewOfFileEx.argBytes, 24);

    assert.equal(fns.MapViewOfFileEx.handler([mapping, FILE_MAP_WRITE, 0, 0, 8, 0x20000]), 0x20000);
    assert.deepEqual([...bytes.slice(0x20000, 0x20008)], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(fns.MapViewOfFileEx.handler([mapping, FILE_MAP_WRITE, 0, 0, 8, 0x20000]), 0,
        'the range is taken');
    assert.equal(errors.at(-1), 487, 'ERROR_INVALID_ADDRESS');
    assert.equal(fns.MapViewOfFileEx.handler([mapping, FILE_MAP_WRITE, 0, 0, 8, 0x10100]), 0,
        'not on a granule');
    assert.equal(errors.at(-1), 1132, 'ERROR_MAPPED_ALIGNMENT');
    const anywhere = fns.MapViewOfFileEx.handler([mapping, FILE_MAP_WRITE, 0, 0, 8, 0]);
    assert.ok(anywhere !== 0 && anywhere !== 0x20000, 'a null address is anywhere');
    assert.equal(fns.UnmapViewOfFile.handler([0x20000]), 1, 'a view like any other');
});

test('a read-only view is not written back', ()=>{
    const { fns, bytes, file, fileHandle } = setup();
    const mapping = fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READONLY, 0, 8, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 8]);

    bytes[view] = 0x77;
    fns.UnmapViewOfFile.handler([view]);
    assert.equal(file.data[0], 1, 'the file kept what it had');
});

test('a view asks no more of its section than the section\'s protection allows', ()=>{
    // Wine's kernel32:virtual (test_mapping): writing needs a read-write
    // section, executing an executable one, and anything else reads; a view
    // past that is ERROR_ACCESS_DENIED. Its pages start with the protection
    // its access names, and VirtualProtect gives them one within the
    // section's (heap.js).
    assert.deepEqual([0x02, 0x04, 0x08, 0x20, 0x40, 0x80].map(sectionRights),
        [0x05, 0x07, 0x05, 0x2d, 0x2f, 0x2d]);
    assert.equal(sectionRights(0x01), 0, 'PAGE_NOACCESS allows nothing');
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 0x20, 0x21, 0x22, 0x24].map(viewProtection),
        [0x01, 0x08, 0x04, 0x04, 0x02, 0x02, 0x04, 0x01, 0x80, 0x40, 0x20]);
    // A page takes no access its view's protection lacks: a read-only view's
    // pages read or copy; an image's (PAGE_EXECUTE_WRITECOPY) take any, its
    // writable ones as their copy-on-write forms.
    const pages = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];
    assert.deepEqual(pages.filter(page=>protectionWithin(0x02, page)), [0x01, 0x02, 0x08]);
    assert.deepEqual(pages.filter(page=>protectionWithin(0x01, page)), [0x01]);
    assert.deepEqual(pages.map(imageWriteCopy),
        [0x01, 0x02, 0x08, 0x08, 0x10, 0x20, 0x80, 0x80]);
    assert.ok(pages.map(imageWriteCopy).every(page=>protectionWithin(0x80, page)));

    const { fns, errors, fileHandle } = setup();
    const readOnly = fns.CreateFileMappingA.handler([fileHandle, 0, 0x02, 0, 8, 0]);
    assert.equal(fns.MapViewOfFile.handler([readOnly, FILE_MAP_WRITE, 0, 0, 8]), 0);
    assert.equal(errors.at(-1), 5, 'ERROR_ACCESS_DENIED');
    assert.equal(fns.MapViewOfFile.handler([readOnly, 0x20 | 4, 0, 0, 8]), 0, 'not executable');
    assert.notEqual(fns.MapViewOfFile.handler([readOnly, 0, 0, 0, 8]), 0, 'nothing asked reads');
    assert.notEqual(fns.MapViewOfFile.handler([readOnly, FILE_MAP_COPY, 0, 0, 8]), 0);
    for (const refused of [0x01, 0x10, 0])
    {
        assert.equal(fns.CreateFileMappingA.handler([fileHandle, 0, refused, 0, 8, 0]), 0);
        assert.equal(errors.at(-1), 87, `ERROR_INVALID_PARAMETER for 0x${refused.toString(16)}`);
    }
});

test('a copy-on-write view is written in memory and never reaches its file', ()=>{
    // PAGE_WRITECOPY and PAGE_EXECUTE_WRITECOPY give the process its own copy
    // of each page it writes; the file, which may be open for reading alone,
    // keeps what it had through the unmap and any flush.
    for (const page of [0x08, 0x80])
    {
        const { fns, bytes, file, fileHandle } = setup();
        const mapping = fns.CreateFileMappingA.handler([fileHandle, 0, page, 0, 8, 0]);
        assert.equal(fns.MapViewOfFile.handler([mapping, FILE_MAP_WRITE, 0, 0, 8]), 0,
            'a copy-on-write section is never written through');
        const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_COPY, 0, 0, 8]);
        assert.notEqual(view, 0);
        bytes[view] = 0x77;
        assert.equal(fns.FlushViewOfFile.handler([view, 0]), 1);
        assert.equal(fns.UnmapViewOfFile.handler([view]), 1);
        assert.equal(file.data[0], 1, `the file kept what it had (0x${page.toString(16)})`);
    }
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

const SEC_FILE = 0x800000;
const SEC_IMAGE = 0x1000000;
const SEC_RESERVE = 0x4000000;
const SEC_COMMIT = 0x8000000;
const SEC_NOCACHE = 0x10000000;
const SEC_LARGE_PAGES = 0x80000000;
const CURRENT_PROCESS = 0xffffffff;

/**
 * NtQuerySection's basic information for a handle, read back.
 *
 * @param {ReturnType<typeof setup>} at @param {number} handle
 */
const basicInformation = ({ fns, bytes }, handle)=>{
    const status = fns.CreateFileMappingW.natives.NtQuerySection.handler(
        [handle, 0, 0x300, 16, 0x320]);
    return { status, base: dword(bytes, 0x300), attributes: dword(bytes, 0x304),
        size: dword(bytes, 0x308), high: dword(bytes, 0x30c), returned: dword(bytes, 0x320) };
};

test('a file\'s section is SEC_FILE; the page file\'s keeps what was asked, in whole pages', ()=>{
    // What NtQuerySection reports is what CreateFileMapping made: kernel32's
    // tests pin it for every combination of the SEC_* half of flProtect.
    const at = setup();
    const { fns, fileHandle } = at;
    const reserved = fns.CreateFileMappingA.handler(
        [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE | SEC_RESERVE, 0, 4090, 0]);
    assert.deepEqual(basicInformation(at, reserved),
        { status: 0, base: 0, attributes: SEC_RESERVE, size: 0x1000, high: 0, returned: 16 });
    const plain = fns.CreateFileMappingA.handler(
        [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 64, 0]);
    assert.equal(basicInformation(at, plain).attributes, SEC_COMMIT, 'nothing asked is SEC_COMMIT');
    const overFile = fns.CreateFileMappingA.handler(
        [fileHandle, 0, PAGE_READWRITE | SEC_COMMIT | SEC_NOCACHE, 0, 0, 0]);
    assert.deepEqual(basicInformation(at, overFile),
        { status: 0, base: 0, attributes: SEC_FILE | SEC_NOCACHE, size: 8, high: 0, returned: 16 },
        'the commit is dropped, the caching kept, and the size is the file\'s own');
});

test('the SEC_* combinations Windows refuses are refused, each with its own error', ()=>{
    const { fns, fileHandle, errors } = setup();
    const ERROR_NOT_ENOUGH_MEMORY = 8;
    const ERROR_INVALID_PARAMETER = 87;
    const ERROR_BAD_EXE_FORMAT = 193;
    for (const [file, protect, error] of [
        [INVALID_HANDLE_VALUE, PAGE_READWRITE | SEC_RESERVE | SEC_COMMIT, ERROR_INVALID_PARAMETER],
        [INVALID_HANDLE_VALUE, PAGE_READWRITE | SEC_NOCACHE, ERROR_INVALID_PARAMETER],
        [INVALID_HANDLE_VALUE, PAGE_READWRITE | SEC_RESERVE | SEC_LARGE_PAGES,
            ERROR_INVALID_PARAMETER],
        [INVALID_HANDLE_VALUE, PAGE_READWRITE | SEC_FILE, ERROR_INVALID_PARAMETER],
        [INVALID_HANDLE_VALUE, PAGE_READONLY | SEC_IMAGE, ERROR_BAD_EXE_FORMAT],
        [fileHandle, PAGE_READONLY | SEC_IMAGE, ERROR_BAD_EXE_FORMAT],
        [fileHandle, PAGE_READONLY | SEC_IMAGE | SEC_COMMIT, ERROR_INVALID_PARAMETER],
    ])
    {
        assert.equal(fns.CreateFileMappingA.handler([file, 0, protect, 0, 0x10, 0]), 0,
            `0x${(protect >>> 0).toString(16)} is refused`);
        assert.equal(errors.at(-1), error, `0x${(protect >>> 0).toString(16)}'s error`);
    }
    // Larger than its file: only a section that may be written grows the file.
    assert.equal(fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READONLY, 0, 9, 0]), 0);
    assert.equal(errors.at(-1), ERROR_NOT_ENOUGH_MEMORY);
    assert.notEqual(fns.CreateFileMappingA.handler([fileHandle, 0, PAGE_READWRITE, 0, 9, 0]), 0);
});

/**
 * A library linked for `base`, whose data's first dword is the address of
 * its code, with a fixup for it when `relocatable`, for ASLR when
 * `dynamicBase`; its code is 9 8 7 6.
 *
 * @param {number} base @param {boolean} [relocatable] @param {boolean} [dynamicBase]
 */
const imageAt = (base, relocatable = true, dynamicBase = false)=>buildExe({
    dll: true,
    imageBase: base,
    dynamicBase,
    imports: {},
    data: { pointer: [0, 0x10, 0, 0].map((byte, index)=>(index === 3 ? base >>> 24
        : index === 2 ? base >>> 16 & 0xff : byte)) },
    codeSize: 0x10,
    code: ()=>[9, 8, 7, 6],
    ...relocatable ? { relocations: { pointer: [0] } } : {},
});

/** Where the image's data dword is (codeSize 0x10, the section at 0x1000). @param {number} view */
const pointerAt = view=>view + 0x1010;

/** @param {Uint8Array} bytes @param {number} view */
const imageBaseOf = (bytes, view)=>dword(bytes, view + dword(bytes, view + 0x3c) + 24 + 28);

test('a SEC_IMAGE view is the file laid out as its image: each section at its address', ()=>{
    // fusion maps a managed library so and reads its manifest by RVA; a view
    // of the file as it lies put the metadata elsewhere, and the .NET
    // Framework's setup could not put one assembly into the cache.
    const at = setup();
    const { fns, bytes, file, fileHandle } = at;
    file.data = imageAt(0x40000);
    const mapping = fns.CreateFileMappingA.handler(
        [fileHandle, 0, PAGE_READONLY | SEC_IMAGE, 0, 0, 0]);
    assert.notEqual(mapping, 0);
    assert.equal(basicInformation(at, mapping).size, dword(file.data, dword(file.data, 0x3c) + 80),
        'the size of the image, not of the file');
    const before = at.held();
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 0]);
    assert.equal(view, 0x40000, 'at its own base, which is free');
    assert.deepEqual([...bytes.subarray(view, view + 2)], [0x4d, 0x5a], 'the headers at the start');
    assert.deepEqual([...bytes.subarray(view + 0x1000, view + 0x1004)], [9, 8, 7, 6],
        'the section at its virtual address');
    assert.equal(dword(bytes, pointerAt(view)), 0x41000, 'nothing moved');
    assert.equal(fns.UnmapViewOfFile.handler([view]), 1);
    assert.equal(at.held(), before, 'the view gave back the hold it took on the file');
});

test('an image view away from its base is moved there, each view for its own address', ()=>{
    // The CLR maps an assembly with SEC_IMAGE and reads it where it lands;
    // Windows applies the image's fixups and writes the new base into its
    // header, and NtMapViewOfSection answers STATUS_IMAGE_NOT_AT_BASE.
    const at = setup();
    const { fns, bytes, file, fileHandle } = at;
    const STATUS_IMAGE_NOT_AT_BASE = 0x40000003;
    file.data = imageAt(0x79720000);
    const mapping = fns.CreateFileMappingA.handler(
        [fileHandle, 0, PAGE_READONLY | SEC_IMAGE, 0, 0, 0]);
    const views = [0x200, 0x204].map(out=>{
        at.bytes.fill(0, out, out + 4);
        at.bytes.fill(0, 0x210, 0x214);
        const status = fns.CreateFileMappingW.natives.NtMapViewOfSection.handler(
            [mapping, CURRENT_PROCESS, out, 0, 0, 0, 0x210, 1, 0, PAGE_READONLY]);
        assert.equal(status, STATUS_IMAGE_NOT_AT_BASE);
        return dword(bytes, out);
    });
    assert.notEqual(views[0], views[1]);
    for (const view of views)
    {
        assert.equal(dword(bytes, pointerAt(view)), view + 0x1000, 'the fixup applied');
        assert.equal(imageBaseOf(bytes, view), view, 'the header names where it is');
        assert.deepEqual([...bytes.subarray(view + 0x1000, view + 0x1004)], [9, 8, 7, 6]);
    }
});

test('an image linked for ASLR is moved even where its base is free, as Windows moves it', ()=>{
    // The CLR maps an assembly so and then reserves the assembly's base for
    // the native image it compiles of it.
    const at = setup();
    const { fns, bytes, file, fileHandle } = at;
    file.data = imageAt(0x40000, true, true);
    const mapping = fns.CreateFileMappingA.handler(
        [fileHandle, 0, PAGE_READONLY | SEC_IMAGE, 0, 0, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 0]);
    assert.notEqual(view, 0x40000);
    assert.equal(dword(bytes, pointerAt(view)), view + 0x1000, 'moved there');
    assert.equal(imageBaseOf(bytes, view), view);
});

test('an image without fixups whose base is taken is mapped elsewhere as it lies', ()=>{
    // Windows maps the view where there is room, nothing fixed up, and
    // NtMapViewOfSection answers STATUS_IMAGE_NOT_AT_BASE (Wine's
    // kernel32:loader test_image_mapping); MapViewOfFile takes that as success.
    const at = setup();
    const { fns, bytes, file, fileHandle } = at;
    const STATUS_IMAGE_NOT_AT_BASE = 0x40000003;
    file.data = imageAt(0x79720000, false);
    const mapping = fns.CreateFileMappingA.handler(
        [fileHandle, 0, PAGE_READONLY | SEC_IMAGE, 0, 0, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 0]);
    assert.notEqual(view, 0);
    assert.notEqual(view, 0x79720000);
    assert.equal(dword(bytes, pointerAt(view)), 0x79720000 + 0x1000, 'nothing fixed up');
    assert.equal(imageBaseOf(bytes, view), 0x79720000, 'the header names its own base');
    at.bytes.fill(0, 0x200, 0x204);
    at.bytes.fill(0, 0x210, 0x214);
    assert.equal(fns.CreateFileMappingW.natives.NtMapViewOfSection.handler(
        [mapping, CURRENT_PROCESS, 0x200, 0, 0, 0, 0x210, 1, 0, PAGE_READONLY]),
    STATUS_IMAGE_NOT_AT_BASE);
    assert.notEqual(dword(bytes, 0x200), 0);
});

test('a fresh page-file view reads zeroes, whatever the memory it is given held before', ()=>{
    // Memory an unmapped view gave back is handed out again as it was left; the
    // CLR's shared code-page table read an unmapped image's bytes and took them
    // for a table already filled.
    const { fns, bytes } = setup();
    bytes.fill(0xcc, 0x1000);
    const mapping = fns.CreateFileMappingA.handler(
        [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 0x2004, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_WRITE, 0, 0, 0]);
    assert.notEqual(view, 0);
    assert.ok(bytes.subarray(view, view + 0x3000).every(byte=>byte === 0),
        'zero, to its last page');
});

test('a read-write mapping that names its commit is still written back to its file', ()=>{
    // PAGE_READWRITE | SEC_COMMIT is how many programs spell an ordinary
    // read-write mapping; read as one number it is no PAGE_* at all, and the
    // view's writes never reached the file.
    const { fns, bytes, file, fileHandle } = setup();
    const mapping = fns.CreateFileMappingA.handler(
        [fileHandle, 0, PAGE_READWRITE | SEC_COMMIT, 0, 8, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_WRITE, 0, 0, 8]);
    bytes[view + 2] = 0x77;
    assert.equal(fns.UnmapViewOfFile.handler([view]), 1);
    assert.equal(file.data[2], 0x77);
});

test('a SEC_IMAGE section refuses each kind of file as Windows answers it', ()=>{
    // Wine's kernel32:loader NtCreateSection cases, by what the headers say.
    const image = imageAt(0x10000000);
    const lfanew = dword(image, 0x3c);
    /** @param {(view: DataView) => void} edit */
    const kind = edit=>{
        const copy = image.slice();
        edit(new DataView(copy.buffer));
        return imageRefusal(imageKind(copy), false);
    };
    assert.equal(kind(()=>{}), null, 'a 32-bit PE image is taken');
    assert.equal(kind(view=>view.setUint16(0, 0, true)), 0xc000012f, 'no MZ: NOT_MZ');
    assert.equal(kind(view=>view.setUint32(0x3c, 0x98760000, true)), 0xc0000130,
        'a new header past the file: PROTECT');
    assert.equal(kind(view=>view.setUint32(lfanew, 0xdeadbeef, true)), 0xc0000130,
        'a signature of no kind: PROTECT');
    /** @param {number} system */
    const ne = system=>kind(view=>{
        view.setUint16(lfanew, 0x454e, true);
        view.setUint8(lfanew + 0x36, system);
    });
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(ne), [0xc000011b, 0xc000011b, 0xc0000131,
        0xc000011b, 0xc000011b, 0xc0000130, 0xc000011b], 'NE: Windows 16-bit, a VxD, the rest');
    assert.equal(kind(view=>view.setUint16(lfanew + 24, 0xdead, true)), 0xc000007b,
        'an optional header of no magic: FORMAT');
    assert.equal(kind(view=>view.setUint16(lfanew + 4, 0x8664, true)), 0xc000007b,
        'a PE32 of the other machine: FORMAT');
    /** @param {boolean} machine64 */
    const pe64 = machine64=>{
        const copy = image.slice();
        const view = new DataView(copy.buffer);
        view.setUint16(lfanew + 24, 0x20b, true);
        view.setUint16(lfanew + 4, 0x8664, true);
        return imageRefusal(imageKind(copy), machine64);
    };
    assert.equal(pe64(false), 0xc000035a, 'PE32+ on a 32-bit Windows: WIN_64');
    assert.equal(pe64(true), null, 'and taken where x86-64 runs');
});

test('an image section answers its image information and keeps the size it was made with', ()=>{
    const at = setup();
    const { fns, bytes, file, fileHandle, errors } = at;
    file.data = imageAt(0x10000000, true, true);
    const mapping = fns.CreateFileMappingA.handler(
        [fileHandle, 0, PAGE_READONLY | SEC_IMAGE, 0, 0, 0]);
    const query = fns.CreateFileMappingW.natives.NtQuerySection.handler;
    assert.equal(query([mapping, 1, 0x300, 48, 0]), 0);
    const lfanew = dword(file.data, 0x3c);
    const optional = lfanew + 24;
    assert.equal(dword(bytes, 0x300), 0x10000000 + dword(file.data, optional + 16),
        'TransferAddress: the base and the entry point');
    assert.equal(dword(bytes, 0x308), dword(file.data, optional + 72), 'MaximumStackSize');
    assert.equal(dword(bytes, 0x310) & 0xffff, file.data[optional + 68], 'SubSystemType');
    assert.equal(bytes[0x300 + 32] | bytes[0x300 + 33] << 8, 0x14c, 'Machine');
    assert.equal(bytes[0x300 + 34], 1, 'ImageContainsCode');
    assert.equal(bytes[0x300 + 35] & 0x0c, 0x04, 'dynamically relocated, not flat');
    assert.equal(dword(bytes, 0x300 + 40), file.data.length, 'ImageFileSize');

    // A maximum size up to the image's is the section's; past it, refused.
    const size = basicInformation(at, mapping).size;
    const small = fns.CreateFileMappingA.handler(
        [fileHandle, 0, PAGE_READONLY | SEC_IMAGE, 0, 1, 0]);
    assert.equal(basicInformation(at, small).size, 1);
    assert.equal(fns.CreateFileMappingA.handler(
        [fileHandle, 0, PAGE_READONLY | SEC_IMAGE, 0, size + 1, 0]), 0);
    assert.equal(errors.at(-1), 8, 'STATUS_SECTION_TOO_BIG, ERROR_NOT_ENOUGH_MEMORY');
});

test('NtQuerySection refuses a short buffer, a plain section\'s image class, a non-section', ()=>{
    const at = setup();
    const { fns, fileHandle } = at;
    const query = fns.CreateFileMappingW.natives.NtQuerySection.handler;
    const STATUS_INVALID_INFO_CLASS = 0xc0000003;
    const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
    const STATUS_INVALID_HANDLE = 0xc0000008;
    const STATUS_OBJECT_TYPE_MISMATCH = 0xc0000024;
    const STATUS_SECTION_NOT_IMAGE = 0xc0000049;
    const mapping = fns.CreateFileMappingA.handler(
        [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 64, 0]);
    assert.equal(query([mapping, 0, 0x300, 15, 0]), STATUS_INFO_LENGTH_MISMATCH);
    assert.equal(query([mapping, 0, 0x300, 17, 0]), 0, 'a longer buffer is fine');
    assert.equal(query([mapping, 1, 0x300, 47, 0]), STATUS_INFO_LENGTH_MISMATCH,
        'the length is checked before the kind of section');
    assert.equal(query([mapping, 1, 0x300, 48, 0]), STATUS_SECTION_NOT_IMAGE);
    assert.equal(query([mapping, 2, 0x300, 64, 0]), STATUS_INVALID_INFO_CLASS);
    assert.equal(query([fileHandle, 0, 0x300, 16, 0]), STATUS_OBJECT_TYPE_MISMATCH);
    assert.equal(query([0x999, 0, 0x300, 16, 0]), STATUS_INVALID_HANDLE);
});

test('a native section maps a view that must fit inside it, and unmaps it once', ()=>{
    const at = setup();
    const { fns, bytes, fileHandle } = at;
    const { NtCreateSection, NtMapViewOfSection, NtUnmapViewOfSection } =
        fns.CreateFileMappingW.natives;
    const STATUS_INVALID_VIEW_SIZE = 0xc000001f;
    const STATUS_SECTION_TOO_BIG = 0xc0000040;
    const STATUS_NOT_MAPPED_VIEW = 0xc0000019;
    /** @param {number} size */
    const create = (size, file = fileHandle)=>{
        bytes.set([size & 0xff, size >>> 8, 0, 0, 0, 0, 0, 0], 0x210);
        return NtCreateSection.handler([0x200, 0, 0, 0x210, PAGE_READONLY, SEC_COMMIT, file]);
    };
    assert.equal(create(9), STATUS_SECTION_TOO_BIG, 'past the end of a read-only file');
    assert.equal(create(6), 0);
    const section = dword(bytes, 0x200);
    assert.deepEqual(basicInformation(at, section),
        { status: 0, base: 0, attributes: SEC_FILE, size: 6, high: 0, returned: 16 });

    /** @param {number} size */
    const map = size=>{
        bytes.set([0, 0, 0, 0, size, 0, 0, 0], 0x220);
        return NtMapViewOfSection.handler(
            [section, CURRENT_PROCESS, 0x220, 0, 0, 0, 0x224, 1, 0, PAGE_READONLY]);
    };
    assert.equal(map(7), STATUS_INVALID_VIEW_SIZE, 'a view past the section is refused');
    assert.equal(map(6), 0);
    const view = dword(bytes, 0x220);
    assert.deepEqual([...bytes.slice(view, view + 6)], [1, 2, 3, 4, 5, 6]);
    assert.equal(dword(bytes, 0x224), 0x1000, 'the view\'s size is whole pages');
    assert.equal(NtUnmapViewOfSection.handler([CURRENT_PROCESS, view]), 0);
    assert.equal(NtUnmapViewOfSection.handler([CURRENT_PROCESS, view]), STATUS_NOT_MAPPED_VIEW);

    assert.equal(create(0x3452, 0), 0);
    assert.equal(basicInformation(at, dword(bytes, 0x200)).size, 0x4000,
        'the page file\'s section is whole pages');
});

test('a native unmap names a view by any address in it, through a handle to this process'
    + ' or in a child where the child runs', async()=>{
    const SELF = 0x80;
    const CHILD = 0x84;
    const DENIED = 0x88;
    /** @type {any[]} */
    const asked = [];
    const child = { id: 0x700 };
    const at = setup({}, {
        /** @param {number} handle @param {number} right */
        processTarget: (handle, right)=>{
            assert.equal(right, 0x0008, 'PROCESS_VM_OPERATION');
            return handle === CURRENT_PROCESS || handle === SELF ? { here: true }
                : handle === CHILD ? { child } : handle === DENIED ? { error: 5 } : { error: 6 };
        },
        /** @param {any} record @param {any} call */
        askChild: (record, call)=>{
            asked.push([record, call]);
            return Promise.resolve({ result: 0, error: null, outs: [] });
        },
    });
    const { fns, bytes } = at;
    const { NtCreateSection, NtMapViewOfSection, NtUnmapViewOfSection } =
        fns.CreateFileMappingW.natives;
    bytes.set([0, 0x20, 0, 0, 0, 0, 0, 0], 0x210);
    assert.equal(NtCreateSection.handler([0x200, 0, 0, 0x210, PAGE_READWRITE, SEC_COMMIT, 0]), 0);
    const section = dword(bytes, 0x200);
    /** @param {number} process */
    const map = process=>{
        bytes.fill(0, 0x220, 0x228);
        return NtMapViewOfSection.handler(
            [section, process, 0x220, 0, 0, 0, 0x224, 1, 0, PAGE_READWRITE]);
    };
    assert.equal(map(SELF), 0, 'a handle OpenProcess gave for this process maps here');
    const view = dword(bytes, 0x220);
    assert.equal(NtUnmapViewOfSection.handler([SELF, view + 0x1050]), 0,
        'an address inside the view names it');
    assert.equal(NtUnmapViewOfSection.handler([SELF, view]), 0xc0000019, 'and it is gone');
    assert.equal(map(DENIED), 0xc0000022, 'a handle without the right is refused');
    assert.equal(map(0x99), 0xc0000008, 'a handle naming no process');
    assert.equal(NtUnmapViewOfSection.handler([DENIED, view]), 0xc0000022);
    assert.equal(await NtUnmapViewOfSection.handler([CHILD, 0x5000]), 0, 'the child answers');
    assert.deepEqual(asked, [[child, { call: 'NtUnmapViewOfSection',
        args: [CURRENT_PROCESS, 0x5000] }]]);
});

test('NtOpenSection opens a section by its object name, and refuses physical memory', ()=>{
    const NAME = 0x900;
    const { fns, bytes } = setup({ [NAME]: 'Local\\Survey' });
    const { NtOpenSection } = fns.CreateFileMappingW.natives;
    const STATUS_ACCESS_DENIED = 0xc0000022;
    const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
    const STATUS_ACCESS_VIOLATION = 0xc0000005;
    const made = fns.CreateFileMappingA.handler(
        [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, 0x1000, NAME]);
    assert.notEqual(made, 0);
    /**
     * OBJECT_ATTRIBUTES at 0x400 naming `path` (a UNICODE_STRING at 0x420, its
     * characters at 0x440), with `root` as its directory; the section's
     * handle written at 0x200.
     *
     * @param {string} path @param {number} [root]
     */
    const open = (path, root = 0)=>{
        bytes.fill(0, 0x200, 0x600);
        const units = [...path].flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]);
        bytes.set(units, 0x440);
        bytes.set([units.length, 0, units.length, 0, 0x40, 0x04, 0, 0], 0x420);
        bytes.set([24, 0, 0, 0, root & 0xff, root >> 8, 0, 0, 0x20, 0x04, 0, 0], 0x400);
        return NtOpenSection.handler([0x200, 0x4, 0x400]);
    };
    for (const path of ['\\Sessions\\1\\BaseNamedObjects\\Survey', '\\BaseNamedObjects\\Survey'])
    {
        assert.equal(open(path), 0, path);
        const handle = dword(bytes, 0x200);
        assert.ok(handle !== 0 && handle !== made, `${path}: a handle of its own`);
        assert.notEqual(fns.MapViewOfFile.handler([handle, FILE_MAP_WRITE, 0, 0, 0]), 0,
            `${path}: onto the same section`);
    }
    assert.equal(open('\\Device\\PhysicalMemory'), STATUS_ACCESS_DENIED,
        'refused to user mode since Windows Server 2003 SP1');
    assert.equal(dword(bytes, 0x200), 0, 'and no handle written');
    assert.equal(open('\\BaseNamedObjects\\Nothing'), STATUS_OBJECT_NAME_NOT_FOUND);
    assert.equal(NtOpenSection.handler([0, 0x4, 0x400]), STATUS_ACCESS_VIOLATION);
    assert.equal(NtOpenSection.argBytes, 12);
});

test('an image view\'s sections take the protection a loaded image\'s do', ()=>{
    // Wine's kernel32:loader (test_image_mapping): a section only executed is
    // PAGE_EXECUTE, not PAGE_EXECUTE_READ, mapped as a view as loaded.
    /** @param {number} characteristics */
    const of = characteristics=>imageSections(/** @type {any} */ ({ sectionAlignment: 0x1000,
        sections: [{ virtualAddress: 0x1000, virtualSize: 0x10, rawSize: 0x200,
            characteristics }] }))[0].protect;
    assert.equal(of(0x20000000), 0x10, 'executed only');
    assert.equal(of(0x60000020), 0x20, 'read and executed');
    assert.equal(of(0xc0000040), 0x08, 'written: copy-on-write');
    assert.equal(of(0xd0000040), 0x04, 'shared: written through');
    assert.equal(of(0x00000040), 0x01, 'none');
});

test('a view of an image at its base is the laid-out image itself; one moved is a copy', ()=>{
    // A map copies the view into guest memory: a copy of the whole image made
    // first for a view that moves nothing was a second copy, made and let go.
    const laid = mapImage(imageAt(0x40000), undefined, { wide: true });
    const before = laid.bytes.slice();
    assert.equal(imageViewAt(laid, 0x40000), laid.bytes, 'at its base: the section\'s own bytes');
    const moved = imageViewAt(laid, 0x50000);
    assert.notEqual(moved, laid.bytes);
    assert.equal(dword(moved, 0x1010), 0x51000, 'moved there');
    assert.deepEqual(laid.bytes, before, 'and what the section keeps is as it was');
});
