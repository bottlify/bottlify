/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createFileTimeFunctions, BY_HANDLE_FILE_INFORMATION, TIME_ZONE_INFORMATION,
} from './filetime.js';

function setup(){
    const bytes = new Uint8Array(0x1000);
    /** @type {number[]} */
    const errors = [];
    const file = { path: 'C:\\GAME\\WAR3.EXE' };
    /** @type {{ path: string, modified: number }[]} */
    const stamped = [];
    const fns = createFileTimeFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        setLastError: code=>{
            errors.push(code);
        },
        resolveHandle: (handle, type)=>{
            if (handle !== 8 || (type && type !== 'file'))
            {
                throw new Error('bad handle');
            }
            return file;
        },
        stat: path=>path === file.path
            ? { exists: true, isDirectory: false, size: 0x1234,
                modified: stamped.at(-1)?.modified ?? Date.UTC(1980, 0, 1) }
            : null,
        setModified: (path, modified)=>{
            stamped.push({ path, modified });
            return true;
        },
    });
    return { fns, bytes, errors, file, stamped };
}

test('a time set on a file is the time read back from it', ()=>{
    // An installer stamps every file it unpacks and, on its next pass, copies
    // again anything whose time does not match: a time accepted and not kept
    // is a file that is installed forever.
    const { fns, bytes, stamped } = setup();
    const moment = Date.UTC(2004, 7, 6, 14, 30, 20);
    new DataView(bytes.buffer)
        .setBigUint64(0x100, BigInt(moment) * 10000n + 116444736000000000n, true);

    assert.equal(fns.SetFileTime.handler([8, 0, 0, 0x100]), 1);
    assert.deepEqual(stamped, [{ path: 'C:\\GAME\\WAR3.EXE', modified: moment }]);

    assert.equal(fns.GetFileTime.handler([8, 0, 0, 0x200]), 1);
    assert.deepEqual([...bytes.slice(0x200, 0x208)], [...bytes.slice(0x100, 0x108)]);
});

/** @param {Uint8Array} bytes @param {number} at */
const dword = (bytes, at)=>
    (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

test('the structure offsets are the ones the guest compiled', ()=>{
    // The three FILETIMEs are eight bytes each, so nothing after the attributes
    // sits where a field count would put it. A size read from the wrong offset
    // comes back as a plausible number rather than as an error.
    assert.deepEqual(
        [BY_HANDLE_FILE_INFORMATION.nFileSizeLow, BY_HANDLE_FILE_INFORMATION.SIZE],
        [36, 52]);
    // The timezone names are WCHAR[32] -- 64 bytes, not 32 -- and getting that
    // wrong puts every field after StandardName in the wrong place.
    assert.equal(TIME_ZONE_INFORMATION.StandardDate - TIME_ZONE_INFORMATION.StandardName,
        64);
    assert.equal(TIME_ZONE_INFORMATION.SIZE, 172);
});

test('local file time is the same file time, because this machine is in UTC', ()=>{
    // Any offset invented here would make a program that timestamps with one
    // clock and reads with the other disagree with itself.
    const { fns, bytes } = setup();
    bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0x100);

    assert.equal(fns.FileTimeToLocalFileTime.handler([0x100, 0x200]), 1);
    assert.deepEqual([...bytes.slice(0x200, 0x208)], [1, 2, 3, 4, 5, 6, 7, 8]);

    assert.equal(fns.LocalFileTimeToFileTime.handler([0x200, 0x300]), 1);
    assert.deepEqual([...bytes.slice(0x300, 0x308)], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a DOS date and time round-trips through a FILETIME to the second it can name', ()=>{
    // An archive of the era stamps every member in DOS words; the installer
    // converts them for the file it writes and compares on its next pass.
    // 2004-08-06 14:30:20 -> date 0x3106, time 0x73ca (seconds stored halved).
    const { fns, bytes } = setup();

    assert.equal(fns.DosDateTimeToFileTime.handler([0x3106, 0x73ca, 0x100]), 1);
    const units = new DataView(bytes.buffer).getBigUint64(0x100, true);
    assert.equal(units, (BigInt(Date.UTC(2004, 7, 6, 14, 30, 20)) * 10000n)
        + 116444736000000000n);

    assert.equal(fns.FileTimeToDosDateTime.handler([0x100, 0x200, 0x202]), 1);
    assert.equal(bytes[0x200] | bytes[0x201] << 8, 0x3106);
    assert.equal(bytes[0x202] | bytes[0x203] << 8, 0x73ca);

    assert.equal(fns.DosDateTimeToFileTime.handler([0x31ff, 0, 0x100]), 0,
        'a month of fifteen is not a date');
    bytes.fill(0, 0x300, 0x308);
    assert.equal(fns.FileTimeToDosDateTime.handler([0x300, 0x200, 0x202]), 0,
        'and 1601 is before the DOS calendar');
});

test('a null pointer either side is a failure, not a silent nothing', ()=>{
    const { fns } = setup();
    assert.equal(fns.FileTimeToLocalFileTime.handler([0, 0x200]), 0);
    assert.equal(fns.FileTimeToLocalFileTime.handler([0x100, 0]), 0);
});

test('the file index is stable, so two handles on one file compare equal', ()=>{
    // A program compares two indices to decide whether two handles name one
    // file. A fresh number each time makes every comparison say no.
    const { fns, bytes } = setup();
    assert.equal(fns.GetFileInformationByHandle.handler([8, 0x400]), 1);
    const first = dword(bytes, 0x400 + BY_HANDLE_FILE_INFORMATION.nFileIndexLow);

    assert.equal(fns.GetFileInformationByHandle.handler([8, 0x500]), 1);
    assert.equal(dword(bytes, 0x500 + BY_HANDLE_FILE_INFORMATION.nFileIndexLow), first);
    assert.notEqual(first, 0);

    assert.equal(dword(bytes, 0x400 + BY_HANDLE_FILE_INFORMATION.nFileSizeLow), 0x1234);
    assert.equal(dword(bytes, 0x400 + BY_HANDLE_FILE_INFORMATION.nNumberOfLinks), 1);
});

test('a handle that is not a file is refused everywhere', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetFileTime.handler([99, 0x100, 0, 0]), 0);
    assert.equal(fns.SetFileTime.handler([99, 0, 0, 0]), 0);
    assert.equal(fns.GetFileInformationByHandle.handler([99, 0x400]), 0);
});

test('the timezone reports no bias and no daylight saving', ()=>{
    // Reporting a transition would make the two conversions above wrong twice a
    // year, in a build with no user whose wall clock this would be.
    const { fns, bytes } = setup();
    bytes.fill(0xaa, 0x600, 0x600 + TIME_ZONE_INFORMATION.SIZE);

    assert.equal(fns.GetTimeZoneInformation.handler([0x600]), 0);
    assert.equal(dword(bytes, 0x600 + TIME_ZONE_INFORMATION.Bias), 0);
    assert.equal(dword(bytes, 0x600 + TIME_ZONE_INFORMATION.StandardDate), 0,
        'and no transition date, which is what makes the bias mean anything');
});

test('the clock cannot be set', ()=>{
    // It is what every timestamp and every elapsed-time measurement in the run
    // is taken against; letting a program move it makes a measurement that
    // spans the call meaningless.
    const { fns } = setup();
    assert.equal(fns.SetLocalTime.handler(), 0);
});
