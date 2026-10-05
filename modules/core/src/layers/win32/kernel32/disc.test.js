/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A disc image mounted as D:, through the file surface and the real volume:
 * what an installer started from it sees when it reads its own files, copies
 * them to the hard disk, and tries to write where it was started from.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from '../../filesystem/module.js';
import { buildIso } from '../../filesystem/internal/iso/build.js';
import { openIso } from '../../filesystem/internal/iso/iso9660.js';
import { createIsoSource } from '../../filesystem/internal/iso/source.js';
import { createVolume } from './vfs.js';
import { createFileFunctions } from './files.js';

const INVALID_HANDLE_VALUE = 0xffffffff;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_WRITE_PROTECT = 19;
const FILE_ATTRIBUTE_READONLY = 0x01;
const FILE_ATTRIBUTE_HIDDEN = 0x02;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_ARCHIVE = 0x20;

const NAME = 0x100;
const NAME2 = 0x200;
const BUFFER = 0x1000;
const COUNT = 0x300;
const FIND = 0x2000;

const CABINET = Uint8Array.from({ length: 70000 }, (_, at)=>(at * 7 + 3) & 0xff);

async function setup(){
    const image = buildIso({
        label: 'DEMO',
        files: {
            'AUTORUN.INF': '[autorun]\r\nopen=Setup.exe\r\n',
            'Setup.exe': 'MZ',
            'Data/Game Data.cab': CABINET,
            'Hidden.dat': 'h',
        },
        hidden: ['Hidden.dat'],
    });
    const fs = await filesystemModule.create({});
    const iso = await openIso((offset, length)=>image.subarray(offset, offset + length));
    fs.mount('D', { source: createIsoSource(iso), readOnly: true,
        volume: { kind: 'cdrom', label: iso.volume.label } });
    fs.createDirectory('C:\\Game');

    const bytes = new Uint8Array(0x20000);
    /** @type {Map<number, any>} */
    const table = new Map();
    let nextHandle = 4;
    /** @type {number[]} */
    const errors = [];
    const files = createFileFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString(address, maxLength){
            let text = '';
            for (let at = 0; at < maxLength && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
        readWideString: ()=>'',
        files: /** @type {any} */ (createVolume(fs)),
        setLastError: code=>{
            errors.push(code);
        },
        writeConsole: ()=>{},
        handles: {
            open(type, object){
                table.set(nextHandle, { type, object });
                nextHandle += 4;
                return nextHandle - 4;
            },
            resolve(handle, type){
                const entry = table.get(handle);
                if (!entry || (type && entry.type !== type))
                {
                    throw new Error('Invalid handle');
                }
                return entry.object;
            },
            close(handle){
                const entry = table.get(handle);
                table.delete(handle);
                return entry?.object;
            },
            typeOf: handle=>table.get(handle)?.type,
        },
    });
    const fns = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        /** @type {unknown} */ (files));
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        bytes.set(Uint8Array.from(text, character=>character.charCodeAt(0)), at);
        bytes[at + text.length] = 0;
    };
    /** @param {number} at */
    const dword = at=>(bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
        | bytes[at + 3] << 24) >>> 0;
    /** @param {string} path @param {number} access @param {number} disposition */
    const create = (path, access, disposition)=>{
        put(NAME, path);
        return fns.CreateFileA.handler([NAME, access, 1, 0, disposition, 0x80, 0]);
    };
    return { fs, fns, bytes, errors, put, dword, create };
}

test('a file on the disc opens and reads for reading', async()=>{
    const { fns, bytes, dword, create, errors } = await setup();
    const handle = create('D:\\Data\\Game Data.cab', GENERIC_READ, OPEN_EXISTING);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    assert.equal(fns.ReadFile.handler([handle, BUFFER, 4096, COUNT, 0]), 1);
    assert.equal(dword(COUNT), 4096);
    assert.deepEqual(bytes.slice(BUFFER, BUFFER + 4096), CABINET.subarray(0, 4096));
    // Opening an existing file to read is a read, whatever the disposition
    // would have done to a missing one.
    const again = create('D:\\Setup.exe', GENERIC_READ, OPEN_ALWAYS);
    assert.notEqual(again, INVALID_HANDLE_VALUE);
    assert.equal(errors.at(-1), 183, 'ERROR_ALREADY_EXISTS, as for any file OPEN_ALWAYS finds');
    await filesystemModule.dispose();
});

test('everything that would change the disc is refused as write-protected', async()=>{
    const { fns, errors, put, create } = await setup();
    assert.equal(create('D:\\Setup.exe', GENERIC_READ | GENERIC_WRITE, OPEN_EXISTING),
        INVALID_HANDLE_VALUE);
    assert.equal(errors.at(-1), ERROR_WRITE_PROTECT);
    assert.equal(create('D:\\new.txt', GENERIC_READ, OPEN_ALWAYS), INVALID_HANDLE_VALUE);
    assert.equal(errors.at(-1), ERROR_WRITE_PROTECT);
    assert.equal(create('D:\\Setup.exe', GENERIC_READ, CREATE_ALWAYS), INVALID_HANDLE_VALUE);
    assert.equal(errors.at(-1), ERROR_WRITE_PROTECT);

    put(NAME, 'D:\\Saves');
    assert.equal(fns.CreateDirectoryA.handler([NAME, 0]), 0);
    assert.equal(errors.at(-1), ERROR_WRITE_PROTECT);
    put(NAME, 'D:\\Setup.exe');
    assert.equal(fns.DeleteFileA.handler([NAME]), 0);
    assert.equal(errors.at(-1), ERROR_WRITE_PROTECT);
    assert.equal(fns.SetFileAttributesA.handler([NAME, 0x80]), 0);
    assert.equal(errors.at(-1), ERROR_WRITE_PROTECT);
    put(NAME2, 'C:\\Game\\Setup.exe');
    assert.equal(fns.MoveFileA.handler([NAME, NAME2]), 0);
    assert.equal(errors.at(-1), ERROR_WRITE_PROTECT);
    put(NAME, 'D:\\Data');
    assert.equal(fns.RemoveDirectoryA.handler([NAME]), 0);
    assert.equal(errors.at(-1), ERROR_WRITE_PROTECT);

    // A name that is not there is still not there.
    put(NAME, 'D:\\missing.txt');
    assert.equal(fns.DeleteFileA.handler([NAME]), 0);
    assert.equal(errors.at(-1), ERROR_FILE_NOT_FOUND);
    await filesystemModule.dispose();
});

test('a file copied off the disc lands on the hard disk whole', async()=>{
    const { fs, fns, errors, put } = await setup();
    put(NAME, 'D:\\Data\\Game Data.cab');
    put(NAME2, 'C:\\Game\\data.cab');
    assert.equal(fns.CopyFileA.handler([NAME, NAME2, 1]), 1, `error ${errors.at(-1)}`);
    const handle = fs.open('C:\\Game\\data.cab');
    assert.deepEqual(fs.read(handle, CABINET.length + 10), CABINET);
    fs.close(handle);
    // And the other way is refused.
    assert.equal(fns.CopyFileA.handler([NAME2, NAME, 0]), 0);
    assert.equal(errors.at(-1), ERROR_WRITE_PROTECT);
    await filesystemModule.dispose();
});

test('names on the disc are read-only, a hidden one hidden, and nothing archived', async()=>{
    const { fns, errors, put, dword } = await setup();
    put(NAME, 'D:\\Setup.exe');
    assert.equal(fns.GetFileAttributesA.handler([NAME]), FILE_ATTRIBUTE_READONLY);
    put(NAME, 'D:\\Data');
    assert.equal(fns.GetFileAttributesA.handler([NAME]),
        FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_READONLY);
    put(NAME, 'D:\\Hidden.dat');
    assert.equal(fns.GetFileAttributesA.handler([NAME]),
        FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN);
    put(NAME, 'C:\\Game');
    assert.equal(fns.GetFileAttributesA.handler([NAME]), FILE_ATTRIBUTE_DIRECTORY);

    put(NAME, 'D:\\*.exe');
    const search = fns.FindFirstFileA.handler([NAME, FIND]);
    assert.notEqual(search, INVALID_HANDLE_VALUE);
    assert.equal(errors.at(-1), ERROR_SUCCESS);
    assert.equal(dword(FIND), FILE_ATTRIBUTE_READONLY);
    assert.equal(dword(FIND) & FILE_ATTRIBUTE_ARCHIVE, 0);
    await filesystemModule.dispose();
});
