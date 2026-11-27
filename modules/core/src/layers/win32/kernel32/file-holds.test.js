/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What holds an open file, through the real volume.
 *
 * On Windows a mapping holds the file it maps, a view holds its mapping and a
 * duplicate is a second handle onto the same file, so a program may close them
 * in any order: map a file, close the file handle, map a view, close the
 * mapping, read the view, unmap it. The unit tests of each surface use a fake
 * volume that never closes anything, which is exactly where this went wrong --
 * so these drive the surfaces together over the filesystem layer itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from './vfs.js';
import { createFileFunctions } from './files.js';
import { createMappingFunctions } from './mapping.js';
import { createThreadingFunctions } from './threading.js';
import { createNamedObjects } from './named-objects.js';

const INVALID_HANDLE_VALUE = 0xffffffff;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const PAGE_READONLY = 0x02;
const PAGE_READWRITE = 0x04;
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_READ = 0x0004;
const CURRENT_PROCESS = 0xffffffff;

/** Where the path is written for CreateFileA. */
const NAME = 0x100;
const PATH = 'C:\\data.bin';
const CONTENTS = [1, 2, 3, 4, 5, 6, 7, 8];

async function setup(){
    const fs = await filesystemModule.create({});
    const volume = /** @type {any} */ (createVolume(fs));
    const seeded = volume.open(PATH, { read: true, write: true, create: true });
    volume.write(seeded, 0, new Uint8Array(CONTENTS));
    volume.close(seeded);

    const bytes = new Uint8Array(0x10000);
    let nextAddress = 0x1000;
    /** @type {Map<number, { type: string, object: any }>} */
    const table = new Map();
    let nextHandle = 4;
    const handles = {
        /** @param {string} type @param {any} object */
        open(type, object){
            const handle = nextHandle;
            nextHandle += 4;
            table.set(handle, { type, object });
            return handle;
        },
        /** @param {number} handle @param {string} [type] */
        resolve(handle, type){
            const entry = table.get(handle);
            if (!entry || (type && entry.type !== type))
            {
                throw new Error('Invalid handle');
            }
            return entry.object;
        },
        /** @param {number} handle */
        typeOf: handle=>table.get(handle)?.type,
        /** @param {number} handle */
        close(handle){
            const entry = table.get(handle);
            if (!entry)
            {
                throw new Error('Invalid handle');
            }
            table.delete(handle);
            return entry.object;
        },
    };
    const memory = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let at = 0; at < maxLength && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
        readWideString: ()=>'',
    };
    const namedObjects = createNamedObjects();
    /** @type {number[]} */
    const errors = [];
    const setLastError = (/** @type {number} */ code)=>{
        errors.push(code);
    };
    const files = createFileFunctions({
        ...memory,
        files: volume,
        setLastError,
        writeConsole: ()=>{},
        handles,
        namedObjects,
    });
    const mapping = createMappingFunctions({
        ...memory,
        setLastError,
        namedObjects,
        allocate: size=>{
            const address = nextAddress;
            nextAddress += size + 16;
            return address;
        },
        release: ()=>{},
        handles,
        // Wired as the module wires it: the volume for the bytes, the
        // filesystem for a mapping's default size.
        files: {
            /** @param {any} node @param {number} offset @param {number} length */
            read: (node, offset, length)=>volume.read(node, offset, length),
            /**
             * @param {any} node @param {number} offset @param {number} length
             * @param {(bytes: Uint8Array, at: number) => void} put
             */
            readInto: (node, offset, length, put)=>volume.readInto(node, offset, length, put),
            /** @param {any} node @param {number} offset @param {Uint8Array} data */
            write: (node, offset, data)=>volume.write(node, offset, data),
            /** @param {any} node */
            size: node=>fs.size(node),
            /** @param {any} node */
            retain: node=>volume.retain(node),
            /** @param {any} node */
            close: node=>volume.close(node),
            /** @param {any} node @param {string} kind */
            section: (node, kind)=>volume.section(node, kind),
        },
    });

    const threading = createThreadingFunctions({
        ...memory,
        kernel: /** @type {any} */ ({ handles }),
        setLastError,
        namedObjects,
        currentThread: ()=>null,
        park: ()=>0,
        /** @param {number} handle */
        handleType: handle=>handles.typeOf(handle) ?? null,
        /** @param {any} node */
        retainNode: node=>volume.retain(node),
    });

    /** @param {number} access */
    const open = access=>{
        [...PATH, '\0'].forEach((ch, at)=>{
            bytes[NAME + at] = ch.charCodeAt(0);
        });
        const handle = files.CreateFileA.handler([NAME, access, 0, 0, OPEN_EXISTING, 0, 0]);
        assert.notEqual(handle, INVALID_HANDLE_VALUE, 'the file opens');
        return handle;
    };
    /** What the file holds now, read past every handle this test made. */
    const onDisk = ()=>{
        const node = volume.open(PATH, { read: true });
        const data = [...volume.read(node, 0, CONTENTS.length)];
        volume.close(node);
        return data;
    };
    /** How many opens of the volume are still open, whoever holds them. */
    const openFiles = ()=>/** @type {any} */ (filesystemModule.diagnostics()).metrics.handles.open;
    /** @param {number} at */
    const dword = at=>
        (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
    // Merged in the module's own order, so the CloseHandle that answers is the
    // one a program reaches.
    const fns = { ...threading, ...mapping, ...files };
    return { fns, bytes, dword, open, onDisk, openFiles, errors };
}

test('a mapping keeps its file after the file handle is closed', async()=>{
    // CreateFileMapping, CloseHandle(file), MapViewOfFile: the order a
    // program uses when it wants the bytes and not the handle. The mapping is
    // what holds the file now.
    const { fns, bytes, open, openFiles } = await setup();
    const file = open(GENERIC_READ);
    const mapping = fns.CreateFileMappingA.handler([file, 0, PAGE_READONLY, 0, 0, 0]);
    assert.notEqual(mapping, 0);
    assert.equal(fns.CloseHandle.handler([file]), 1);

    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 0]);
    assert.notEqual(view, 0, 'the view is made from the file the mapping still holds');
    assert.deepEqual([...bytes.slice(view, view + CONTENTS.length)], CONTENTS);
    assert.equal(fns.UnmapViewOfFile.handler([view]), 1);
    assert.equal(fns.CloseHandle.handler([mapping]), 1);

    assert.equal(openFiles(), 0, 'nothing holds the file any more, so it is closed');
});

test('a writable view reaches the file after both handles are closed', async()=>{
    // The view holds the mapping and the mapping the file, so the write-back
    // at unmap still has somewhere to go.
    const { fns, bytes, open, onDisk, openFiles } = await setup();
    const file = open(GENERIC_READ | GENERIC_WRITE);
    const mapping = fns.CreateFileMappingA.handler([file, 0, PAGE_READWRITE, 0, 0, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_WRITE, 0, 0, 0]);
    assert.notEqual(view, 0);
    assert.equal(fns.CloseHandle.handler([file]), 1);
    assert.equal(fns.CloseHandle.handler([mapping]), 1);
    assert.equal(openFiles(), 1, 'the view still holds the file');

    bytes[view + 3] = 0x99;
    assert.equal(fns.UnmapViewOfFile.handler([view]), 1);
    assert.deepEqual(onDisk(), [1, 2, 3, 0x99, 5, 6, 7, 8]);
    assert.equal(openFiles(), 0, 'and the unmap was the last hold on it');
});

test('the file handle stays usable after its mapping is closed', async()=>{
    // The other order: the mapping goes first, and the program's own close of
    // the file afterwards must still find a file to close.
    const { fns, open, openFiles } = await setup();
    const file = open(GENERIC_READ);
    const mapping = fns.CreateFileMappingA.handler([file, 0, PAGE_READONLY, 0, 0, 0]);
    const view = fns.MapViewOfFile.handler([mapping, FILE_MAP_READ, 0, 0, 0]);
    assert.equal(fns.UnmapViewOfFile.handler([view]), 1);
    assert.equal(fns.CloseHandle.handler([mapping]), 1);

    assert.equal(fns.GetFileSize.handler([file, 0]), CONTENTS.length);
    assert.equal(fns.CloseHandle.handler([file]), 1);
    assert.equal(openFiles(), 0);
});

test('a duplicate of a file handle outlives the handle it was made from', async()=>{
    // A duplicate names the same open file, so closing the original leaves
    // the duplicate reading where the two of them had got to.
    const DUPLICATE = 0x2000;
    const DUPLICATE_SAME_ACCESS = 2;
    const BUFFER = 0x2100;
    const READ = 0x2200;
    const { fns, bytes, dword, open, openFiles } = await setup();
    const file = open(GENERIC_READ);
    assert.equal(fns.DuplicateHandle.handler(
        [CURRENT_PROCESS, file, CURRENT_PROCESS, DUPLICATE, 0, 0, DUPLICATE_SAME_ACCESS]), 1);
    const duplicate = dword(DUPLICATE);
    assert.equal(fns.CloseHandle.handler([file]), 1);

    assert.equal(fns.ReadFile.handler([duplicate, BUFFER, 4, READ, 0]), 1,
        'the duplicate still reads');
    assert.equal(dword(READ), 4);
    assert.deepEqual([...bytes.slice(BUFFER, BUFFER + 4)], [1, 2, 3, 4]);
    assert.equal(openFiles(), 1);
    assert.equal(fns.CloseHandle.handler([duplicate]), 1);
    assert.equal(openFiles(), 0, 'and closing it as well closes the file');
});

test('a duplicate that closes its source holds the file once, not twice', async()=>{
    const DUPLICATE_CLOSE_SOURCE = 1;
    const DUPLICATE = 0x2000;
    const { fns, dword, open, openFiles } = await setup();
    const file = open(GENERIC_READ);
    assert.equal(fns.DuplicateHandle.handler(
        [CURRENT_PROCESS, file, CURRENT_PROCESS, DUPLICATE, 0, 0, DUPLICATE_CLOSE_SOURCE]), 1);

    assert.equal(fns.CloseHandle.handler([dword(DUPLICATE)]), 1);
    assert.equal(openFiles(), 0);
});

/**
 * CreateFileA on `path` as the setup's bytes hold it.
 *
 * @param {Awaited<ReturnType<typeof setup>>} machine @param {string} path
 * @param {number} access @param {number} share @param {number} disposition @param {number} flags
 */
const createFile = ({ fns, bytes }, path, access, share, disposition, flags)=>{
    [...path, '\0'].forEach((ch, at)=>{
        bytes[NAME + at] = ch.charCodeAt(0);
    });
    return fns.CreateFileA.handler([NAME, access, share, 0, disposition, flags, 0]);
};

/** @param {Awaited<ReturnType<typeof setup>>} machine @param {string} name @param {string} path */
const byName = ({ fns, bytes }, name, path)=>{
    [...path, '\0'].forEach((ch, at)=>{
        bytes[NAME + at] = ch.charCodeAt(0);
    });
    return fns[name].handler([NAME, 0]);
};

const DELETE = 0x00010000;
const FILE_SHARE_DELETE = 4;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
const ERROR_SHARING_VIOLATION = 32;

test('a directory\'s opens share and refuse as a file\'s, and RemoveDirectory is settled against'
    + ' them', async()=>{
    const machine = await setup();
    const { fns, errors } = machine;
    assert.equal(byName(machine, 'CreateDirectoryA', 'C:\\dir'), 1);
    const held = createFile(machine, 'C:\\dir', DELETE, 0, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS);
    assert.notEqual(held, INVALID_HANDLE_VALUE);
    assert.equal(byName(machine, 'RemoveDirectoryA', 'C:\\dir'), 0,
        'held without sharing deletion');
    assert.equal(errors.at(-1), ERROR_SHARING_VIOLATION);
    assert.equal(createFile(machine, 'C:\\dir', DELETE, FILE_SHARE_DELETE, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS), INVALID_HANDLE_VALUE, 'a second open the first refuses');
    assert.equal(errors.at(-1), ERROR_SHARING_VIOLATION);
    assert.equal(fns.CloseHandle.handler([held]), 1);
    assert.equal(byName(machine, 'RemoveDirectoryA', 'C:\\dir'), 1, 'let go, it goes');
});

test('a directory opened to delete on close goes with the last open of it, and only empty',
    async()=>{
        const machine = await setup();
        const { fns } = machine;
        assert.equal(byName(machine, 'CreateDirectoryA', 'C:\\dir'), 1);
        const closing = createFile(machine, 'C:\\dir', DELETE, FILE_SHARE_DELETE, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_DELETE_ON_CLOSE);
        const other = createFile(machine, 'C:\\dir', DELETE, FILE_SHARE_DELETE, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS);
        assert.notEqual(other, INVALID_HANDLE_VALUE);
        assert.equal(fns.CloseHandle.handler([closing]), 1);
        assert.notEqual(byName(machine, 'GetFileAttributesA', 'C:\\dir'), INVALID_HANDLE_VALUE,
            'another open still holds it');
        assert.equal(fns.CloseHandle.handler([other]), 1);
        assert.equal(byName(machine, 'GetFileAttributesA', 'C:\\dir'), INVALID_HANDLE_VALUE);

        assert.equal(byName(machine, 'CreateDirectoryA', 'C:\\full'), 1);
        fns.CloseHandle.handler([createFile(machine, 'C:\\full\\in', GENERIC_WRITE, 0, 2, 0)]);
        const full = createFile(machine, 'C:\\full', DELETE, 0, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_DELETE_ON_CLOSE);
        assert.equal(fns.CloseHandle.handler([full]), 1);
        assert.notEqual(byName(machine, 'GetFileAttributesA', 'C:\\full'), INVALID_HANDLE_VALUE,
            'something in it: it stays');
        assert.notEqual(createFile(machine, 'C:\\full', GENERIC_READ, 0, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS), INVALID_HANDLE_VALUE, 'and is no longer pending');
    });

test('a file a section maps is not deleted, and delete-on-close is the open\'s', async()=>{
    const machine = await setup();
    const { fns, bytes } = machine;
    const set = /** @type {any} */ (fns.CreateFileW).natives.NtSetInformationFile;
    const INFO = 0x2400;
    const file = createFile(machine, PATH, GENERIC_READ | GENERIC_WRITE | DELETE, 0, OPEN_EXISTING,
        0);
    const mapping = fns.CreateFileMappingA.handler([file, 0, PAGE_READONLY, 0, 0, 0]);
    bytes[INFO] = 1;
    assert.equal(set.handler([file, 0x2300, INFO, 1, 13]) >>> 0, 0xc0000121,
        'STATUS_CANNOT_DELETE while the section maps it');
    assert.equal(fns.CloseHandle.handler([mapping]), 1);
    assert.equal(set.handler([file, 0x2300, INFO, 1, 13]), 0, 'and deletable once it does not');
    bytes[INFO] = 0;
    assert.equal(set.handler([file, 0x2300, INFO, 1, 13]), 0, 'then not deleted after all');
    assert.equal(fns.CloseHandle.handler([file]), 1);
    assert.notEqual(byName(machine, 'GetFileAttributesA', PATH), INVALID_HANDLE_VALUE);

    // Clearing the disposition does not undo FILE_FLAG_DELETE_ON_CLOSE;
    // FileDispositionInformationEx's FILE_DISPOSITION_ON_CLOSE does.
    const closing = createFile(machine, PATH, GENERIC_WRITE | DELETE, 0, OPEN_EXISTING,
        FILE_FLAG_DELETE_ON_CLOSE);
    assert.equal(set.handler([closing, 0x2300, INFO, 1, 13]), 0);
    bytes.set([8, 0, 0, 0], INFO);
    assert.equal(set.handler([closing, 0x2300, INFO, 4, 64]), 0, 'FILE_DISPOSITION_ON_CLOSE');
    assert.equal(fns.CloseHandle.handler([closing]), 1);
    assert.notEqual(byName(machine, 'GetFileAttributesA', PATH), INVALID_HANDLE_VALUE,
        'its delete-on-close cleared');
    const again = createFile(machine, PATH, GENERIC_WRITE | DELETE, 0, OPEN_EXISTING,
        FILE_FLAG_DELETE_ON_CLOSE);
    bytes[INFO] = 0;
    assert.equal(set.handler([again, 0x2300, INFO, 1, 13]), 0);
    assert.equal(fns.CloseHandle.handler([again]), 1);
    assert.equal(byName(machine, 'GetFileAttributesA', PATH), INVALID_HANDLE_VALUE,
        'a cleared disposition leaves delete-on-close');
});
