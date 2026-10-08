/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessFunctions } from './process.js';

const STATUS_SUCCESS = 0;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_CID = 0xc000000b;
const STATUS_INVALID_PARAMETER_MIX = 0xc0000030;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_RESOURCE_TYPE_NOT_FOUND = 0xc000008a;
const STATUS_MESSAGE_NOT_FOUND = 0xc0000109;

const MODULE = 0x400000;
const TABLE = 0x1000;
const OUT = 0x100;
const STRING = 0x200;
const TEB = 0x3000;
const PEB = 0x3100;

function setup(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    let lastError = 0x77;
    let heap = 0x8000;
    /** @type {number[]} */
    const freed = [];
    /** @type {any[]} */
    const created = [];
    let tableSize = 0;
    /** @param {number} address */
    const wideAt = address=>{
        let text = '';
        for (let at = address; view.getUint16(at, true) !== 0; at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };
    /** @type {Record<string, { handler: Function }>} */
    const kernel32 = {
        GetLastError: { handler: ()=>lastError },
        SetLastError: { handler: (/** @type {number[]} */ [code])=>{
            lastError = code;
            return 0;
        } },
        ResumeThread: { handler: (/** @type {number[]} */ [handle])=>{
            if (handle === 0x10)
            {
                return 2;
            }
            lastError = 6;
            return 0xffffffff;
        } },
        OpenProcess: { handler: (/** @type {number[]} */ [, , id])=>{
            if (id === 0x1000)
            {
                return 0x44;
            }
            lastError = 87;
            return 0;
        } },
        FindResourceExW: { handler: (/** @type {number[]} */ [base, type, name, language])=>{
            if (base === MODULE && type === 11 && name === 1 && language === 0)
            {
                return 0x5000;
            }
            lastError = 1813;
            return 0;
        } },
        LoadResource: { handler: ()=>TABLE },
        SizeofResource: { handler: ()=>tableSize },
        CreateProcessW: { handler: (/** @type {number[]} */ args)=>{
            const [application, line, , , inherit, flags, environment, folder, startup,
                information] = args;
            created.push({
                application: wideAt(application), line: wideAt(line), inherit, flags,
                environment, folder: folder === 0 ? null : wideAt(folder),
                startupSize: view.getUint32(startup, true),
            });
            if (wideAt(application).endsWith('missing.exe'))
            {
                lastError = 2;
                return 0;
            }
            [0x50, 0x54, 0x1004, 0x1008].forEach((value, at)=>
                view.setUint32(information + at * 4, value, true));
            return 1;
        } },
    };
    const fns = /** @type {Record<string, any>} */ (createProcessFunctions({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        kernel32,
        teb: ()=>TEB,
        allocate: size=>{
            const at = heap;
            heap += (size + 7) & ~7;
            return at;
        },
        free: address=>{
            freed.push(address);
            return true;
        },
    }));
    /** A UNICODE_STRING at `at`, its text just after it. @param {number} at @param {string} text */
    const counted = (at, text)=>{
        view.setUint16(at, text.length * 2, true);
        view.setUint16(at + 2, text.length * 2 + 2, true);
        view.setUint32(at + 4, at + 8, true);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + 8 + i * 2, text.charCodeAt(i), true);
        }
        view.setUint16(at + 8 + text.length * 2, 0, true);
        return at;
    };
    return {
        bytes, view, fns, freed, created, counted, wideAt,
        lastError: ()=>lastError,
        /** @param {number} size */
        setTableSize: size=>{
            tableSize = size;
        },
    };
}

test('NtResumeThread is ResumeThread as a status, the last error left alone', ()=>{
    const { view, fns, lastError } = setup();
    assert.equal(fns.NtResumeThread.handler([0x10, OUT]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), 2, 'the count before');
    assert.equal(fns.NtResumeThread.handler([0x10, 0]), STATUS_SUCCESS, 'no count asked for');
    assert.equal(fns.NtResumeThread.handler([0x99, OUT]), STATUS_INVALID_HANDLE);
    assert.equal(lastError(), 0x77, 'a native call leaves no last error');
    assert.equal(fns.NtResumeThread.argBytes, 8);
});

test('NtOpenProcess opens by the client id, and refuses what names nothing', ()=>{
    const { view, fns, lastError } = setup();
    view.setUint32(0x300, 0x1000, true);
    view.setUint32(0x304, 0, true);
    assert.equal(fns.NtOpenProcess.handler([OUT, 0x1f0fff, 0, 0x300]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), 0x44);
    view.setUint32(0x300, 0x2000, true);
    assert.equal(fns.NtOpenProcess.handler([OUT, 0x1f0fff, 0, 0x300]), STATUS_INVALID_CID);
    assert.equal(fns.NtOpenProcess.handler([OUT, 0x1f0fff, 0, 0]), STATUS_INVALID_PARAMETER_MIX);
    assert.equal(fns.NtOpenProcess.handler([0, 0x1f0fff, 0, 0x300]), STATUS_ACCESS_VIOLATION);
    assert.equal(lastError(), 0x77);
    assert.equal(fns.NtOpenProcess.argBytes, 16);
});

test('RtlFindMessage walks the message table to the entry, in the module\'s own image', ()=>{
    const { view, fns, setTableSize } = setup();
    // Two blocks: ids 1-2, then 100. Entries: a length, flags, then the text.
    view.setUint32(TABLE, 2, true);
    view.setUint32(TABLE + 4, 1, true);
    view.setUint32(TABLE + 8, 2, true);
    view.setUint32(TABLE + 12, 28, true);
    view.setUint32(TABLE + 16, 100, true);
    view.setUint32(TABLE + 20, 100, true);
    view.setUint32(TABLE + 24, 44, true);
    view.setUint16(TABLE + 28, 8, true);
    view.setUint16(TABLE + 36, 8, true);
    view.setUint16(TABLE + 44, 8, true);
    setTableSize(52);

    assert.equal(fns.RtlFindMessage.handler([MODULE, 11, 0, 1, OUT]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), TABLE + 28);
    assert.equal(fns.RtlFindMessage.handler([MODULE, 11, 0, 2, OUT]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), TABLE + 36, 'past the first by its own length');
    assert.equal(fns.RtlFindMessage.handler([MODULE, 11, 0, 100, OUT]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), TABLE + 44);
    assert.equal(fns.RtlFindMessage.handler([MODULE, 11, 0, 3, OUT]), STATUS_MESSAGE_NOT_FOUND);
    assert.equal(fns.RtlFindMessage.handler([MODULE, 6, 0, 1, OUT]),
        STATUS_RESOURCE_TYPE_NOT_FOUND, 'no table of that type');
    assert.equal(fns.RtlFindMessage.argBytes, 20);
});

test('RtlCreateProcessParameters builds the block with offsets, the image as the command line',
    ()=>{
        const { bytes, view, fns, counted, freed } = setup();
        // The running process's own block, normalised, with a directory to inherit.
        const own = 0x4000;
        view.setUint32(TEB + 0x30, PEB, true);
        view.setUint32(PEB + 0x10, own, true);
        view.setUint32(own + 8, 1, true);
        counted(0x4400, 'C:\\game\\');
        bytes.copyWithin(own + 0x24, 0x4400, 0x4408);
        view.setUint32(own + 0x48, 0x6000, true);

        const image = counted(STRING, 'C:\\game\\child.exe');
        assert.equal(fns.RtlCreateProcessParameters.handler(
            [OUT, image, 0, 0, 0, 0, 0, 0, 0, 0]), STATUS_SUCCESS);
        const block = view.getUint32(OUT, true);
        const total = view.getUint32(block, true);
        assert.equal(view.getUint32(block + 4, true), total, 'Length is the whole block');
        assert.equal(view.getUint32(block + 8, true), 0, 'not normalised: offsets');
        /** @param {number} field */
        const text = field=>{
            const length = view.getUint16(block + field, true);
            const offset = view.getUint32(block + field + 4, true);
            assert.ok(offset >= 0x290 && offset + length <= total, `0x${field.toString(16)}`);
            return String.fromCharCode(...new Uint16Array(
                bytes.slice(block + offset, block + offset + length).buffer));
        };
        assert.equal(text(0x38), 'C:\\game\\child.exe');
        assert.equal(text(0x40), 'C:\\game\\child.exe', 'the command line is the image');
        assert.equal(text(0x24), 'C:\\game\\', 'the directory the process has');
        assert.equal(view.getUint16(block + 0x26, true), 520, 'a directory has MAX_PATH');
        assert.equal(text(0x70), '');
        assert.equal(view.getUint32(block + 0x48, true), 0x6000, 'the environment it has');

        assert.equal(fns.RtlDestroyProcessParameters.handler([block]), STATUS_SUCCESS);
        assert.deepEqual(freed, [block]);
        assert.equal(fns.RtlCreateProcessParameters.handler([OUT, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            0xc000000d, 'no image is STATUS_INVALID_PARAMETER');
        assert.equal(fns.RtlCreateProcessParameters.argBytes, 40);
    });

test('RtlCreateUserProcess is CreateProcessW over the parameters, its thread suspended', ()=>{
    const { view, fns, counted, created, lastError } = setup();
    const image = counted(STRING, 'C:\\game\\child.exe');
    const line = counted(0x500, '"C:\\game\\child.exe" -x');
    assert.equal(fns.RtlCreateProcessParameters.handler(
        [OUT, image, 0, 0, line, 0x6000, 0, 0, 0, 0]), STATUS_SUCCESS);
    const parameters = view.getUint32(OUT, true);
    const name = counted(0x600, '\\??\\C:\\game\\child.exe');
    const INFO = 0x700;
    assert.equal(fns.RtlCreateUserProcess.handler(
        [name, 0, parameters, 0, 0, 0, 1, 0, 0, INFO]), STATUS_SUCCESS);
    assert.deepEqual(created[0], {
        application: 'C:\\game\\child.exe', line: '"C:\\game\\child.exe" -x', inherit: 1,
        flags: 0x404, environment: 0x6000, folder: null, startupSize: 68,
    });
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>view.getUint32(INFO + at, true)),
        [0x44, 0x50, 0x54, 0x1004, 0x1008], 'the size, both handles and the client id');

    const missing = counted(0x800, '\\??\\C:\\game\\missing.exe');
    assert.equal(fns.RtlCreateUserProcess.handler(
        [missing, 0, parameters, 0, 0, 0, 0, 0, 0, INFO]), STATUS_OBJECT_NAME_NOT_FOUND);
    assert.equal(lastError(), 0x77);
    assert.equal(fns.RtlCreateUserProcess.argBytes, 40);
});
