/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A name longer than an NTFS volume holds, through the real volume: a
 * component is at most 255 UTF-16 units (GetVolumeInformation's maximum
 * component length, MS-FSCC 2.1.5.2), and the file system refuses a longer
 * one as STATUS_OBJECT_NAME_INVALID (MS-FSA 2.1.5.1) - ERROR_INVALID_NAME
 * to a Win32 caller - with nothing made. The `\\?\` form takes the names
 * past MAX_PATH's own check, so what answers is the volume.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testPageFile } from '../../../process/page-file.fixture.js';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from './vfs.js';
import { createFileFunctions } from './files.js';
import { createNamedObjects } from './named-objects.js';
import { freshSpace } from '../../cache/testing.fixture.js';

const INVALID_HANDLE_VALUE = 0xffffffff;
const GENERIC_WRITE = 0x40000000;
const CREATE_NEW = 1;
const ERROR_INVALID_NAME = 123;
const STATUS_OBJECT_NAME_INVALID = 0xc0000033;
const FILE_CREATE = 2;
const FILE_DIRECTORY_FILE = 1;

const NAME = 0x1000;
const NAME2 = 0x2000;

async function setup(){
    const fs = await filesystemModule.create({ pageFile: await testPageFile() });
    const volume = /** @type {any} */ (createVolume(fs, null, { kept: freshSpace('reads') }));
    const bytes = new Uint8Array(0x4000);
    /** @type {Map<number, any>} */
    const table = new Map();
    let nextHandle = 4;
    const handles = {
        /** @param {string} type @param {any} object */
        open(type, object){
            table.set(nextHandle, { type, object });
            return (nextHandle += 4) - 4;
        },
        /** @param {number} handle */
        resolve: handle=>table.get(handle)?.object,
        /** @param {number} handle */
        typeOf: handle=>table.get(handle)?.type,
        /** @param {number} handle */
        close(handle){
            const entry = table.get(handle);
            table.delete(handle);
            return entry?.object;
        },
    };
    /** @type {number[]} */
    const errors = [];
    const fns = /** @type {any} */ (createFileFunctions(/** @type {any} */ ({
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            bytes.slice(address, address + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ data)=>
            bytes.set(data, address),
        readCString: ()=>'',
        readWideString: (/** @type {number} */ address, /** @type {number} */ limit)=>{
            let text = '';
            for (let at = address; at + 1 < address + limit; at += 2)
            {
                const code = bytes[at] | bytes[at + 1] << 8;
                if (code === 0)
                {
                    return text;
                }
                text += String.fromCharCode(code);
            }
            return text;
        },
        files: volume,
        setLastError: (/** @type {number} */ code)=>errors.push(code),
        writeConsole: ()=>{},
        handles,
        namedObjects: createNamedObjects(),
    })));
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        [...text, '\0'].forEach((c, i)=>{
            bytes[at + i * 2] = c.charCodeAt(0);
            bytes[at + i * 2 + 1] = c.charCodeAt(0) >> 8;
        });
        return at;
    };
    const lastError = ()=>errors[errors.length - 1];
    /**
     * NtCreateFile of a `\\??\\` name made: OBJECT_ATTRIBUTES at 0x3000, its
     * UNICODE_STRING at 0x3020, the status block at 0x3040.
     *
     * @param {string} name @param {number} options
     */
    const ntCreate = (name, options)=>{
        const view = new DataView(bytes.buffer);
        put(NAME, name);
        view.setUint32(0x3000, 24, true);
        view.setUint32(0x3008, 0x3020, true);
        view.setUint16(0x3020, name.length * 2, true);
        view.setUint16(0x3022, name.length * 2 + 2, true);
        view.setUint32(0x3024, NAME, true);
        return fns.CreateFileW.natives.NtCreateFile.handler([0x3050, GENERIC_WRITE, 0x3000,
            0x3040, 0, 0, 7, FILE_CREATE, options, 0, 0]) >>> 0;
    };
    return { fns, volume, put, lastError, ntCreate };
}

test('a component of 256 units is ERROR_INVALID_NAME, nothing made; 255 is a name',
    async()=>{
        const { fns, volume, put, lastError, ntCreate } = await setup();
        const long = 'n'.repeat(256);
        const longest = 'n'.repeat(255);
        const at = (/** @type {string} */ name)=>`\\\\?\\C:\\${name}`;

        assert.equal(fns.CreateFileW.handler([put(NAME, at(long)), GENERIC_WRITE, 0, 0, CREATE_NEW,
            0, 0]), INVALID_HANDLE_VALUE);
        assert.equal(lastError(), ERROR_INVALID_NAME, 'CreateFileW');
        assert.equal(fns.CreateDirectoryW.handler([put(NAME, at(long)), 0]), 0);
        assert.equal(lastError(), ERROR_INVALID_NAME, 'CreateDirectoryW');
        assert.equal(fns.CreateDirectoryW.handler([put(NAME, at(`${long}\\inner`)), 0]), 0);
        assert.equal(lastError(), ERROR_INVALID_NAME, 'CreateDirectoryW under one');

        assert.equal(ntCreate(`\\??\\C:\\${long}`, 0), STATUS_OBJECT_NAME_INVALID, 'NtCreateFile');
        assert.equal(ntCreate(`\\??\\C:\\${long}`, FILE_DIRECTORY_FILE), STATUS_OBJECT_NAME_INVALID,
            'NtCreateFile of a directory');

        const file = fns.CreateFileW.handler([put(NAME, at(longest)), GENERIC_WRITE, 0, 0,
            CREATE_NEW, 0, 0]);
        assert.notEqual(file, INVALID_HANDLE_VALUE, 'CreateFileW of 255');
        fns.CloseHandle.handler([file]);
        assert.equal(fns.MoveFileW.handler([put(NAME, at(longest)), put(NAME2, at(long))]), 0);
        assert.equal(lastError(), ERROR_INVALID_NAME, 'MoveFileW');
        assert.ok(volume.stat(`C:\\${longest}`)?.exists, 'the file where it was');
        const other = at('d'.repeat(255));
        assert.equal(fns.MoveFileW.handler([put(NAME, at(longest)), put(NAME2, other)]), 1,
            'MoveFileW to 255');
        assert.equal(fns.CreateDirectoryW.handler([put(NAME, at(longest)), 0]), 1,
            'CreateDirectoryW of 255');

        assert.deepEqual(volume.list('C:\\*').map((/** @type {any} */ entry)=>entry.name.length)
            .filter((/** @type {number} */ length)=>length >= 255), [255, 255], 'nothing of 256 made');
    });
