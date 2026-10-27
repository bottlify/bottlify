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

test('a time is set only through a handle that may write attributes', ()=>{
    const { fns, errors, file, stamped } = setup();
    const held = /** @type {any} */ (file);
    held.writeAttributes = false;
    assert.equal(fns.SetFileTime.handler([8, 0, 0, 0]), 0);
    assert.equal(errors.at(-1), 5, 'ERROR_ACCESS_DENIED, even setting nothing');
    held.writeAttributes = true;
    assert.equal(fns.SetFileTime.handler([8, 0, 0, 0]), 1);
    assert.deepEqual(stamped, []);
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

test('the dynamic zone calls: the machine\'s zone by its key, another by its key and year', ()=>{
    // Wine's time.c test_GetDynamicTimeZoneInformation and test_GetTimeZoneInformationForYear.
    const { fns, bytes, errors } = setup();
    const view = new DataView(bytes.buffer);
    const DYNAMIC = 0x800;
    const keyOf = (/** @type {number} */ at)=>{
        let key = '';
        for (let code = view.getUint16(at + 172, true), next = 0; code !== 0;
            code = view.getUint16(at + 172 + (next += 2), true))
        {
            key += String.fromCharCode(code);
        }
        return key;
    };
    const plantKey = (/** @type {string} */ key)=>{
        bytes.fill(0, DYNAMIC, DYNAMIC + 432);
        [...key].forEach((character, at)=>view.setUint16(DYNAMIC + 172 + at * 2,
            character.charCodeAt(0), true));
    };

    assert.equal(fns.GetDynamicTimeZoneInformation.handler([DYNAMIC]), 0);
    assert.equal(keyOf(DYNAMIC), 'UTC');
    assert.equal(fns.GetTimeZoneInformation.handler([0x600]), 0);
    assert.deepEqual(bytes.subarray(DYNAMIC, DYNAMIC + 172), bytes.subarray(0x600, 0x600 + 172));

    assert.equal(fns.GetTimeZoneInformationForYear.handler([2020, 0, 0x400]), 1);
    assert.deepEqual(bytes.subarray(0x400, 0x400 + 172), bytes.subarray(0x600, 0x600 + 172));
    plantKey('Greenland Standard Time');
    assert.equal(fns.GetTimeZoneInformationForYear.handler([2016, DYNAMIC, 0x400]), 1);
    assert.equal(view.getInt32(0x400, true), 180);
    assert.equal(view.getUint16(0x400 + 68 + 2, true), 10, 'standard time from October');
    plantKey('Greenland Daylight Time');
    assert.equal(fns.GetTimeZoneInformationForYear.handler([2016, DYNAMIC, 0x400]), 0);
    assert.deepEqual(errors, [2]);

    assert.equal(fns.EnumDynamicTimeZoneInformation.handler([0, DYNAMIC]), 0);
    assert.ok(keyOf(DYNAMIC).length > 0);
    assert.equal(fns.EnumDynamicTimeZoneInformation.handler([100000, DYNAMIC]), 259);
});

test('the clock cannot be set', ()=>{
    // It is what every timestamp and every elapsed-time measurement in the run
    // is taken against; letting a program move it makes a measurement that
    // spans the call meaningless.
    const { fns } = setup();
    assert.equal(fns.SetLocalTime.handler(), 0);
});

test('GetFileInformationByHandleEx answers the four classes and refuses the rest', ()=>{
    // Wine's kernel32 process.c (test_handle_list_attribute) asks a name of it.
    const { fns, bytes, errors } = setup();
    const view = new DataView(bytes.buffer);
    assert.equal(fns.GetFileInformationByHandleEx.handler([8, 1, 0x400, 24]), 1);
    assert.equal(view.getBigUint64(0x408, true), 0x1234n, 'FileStandardInfo: the end of file');
    assert.equal(view.getUint32(0x410, true), 1, 'one link');
    assert.equal(fns.GetFileInformationByHandleEx.handler([8, 2, 0x400, 0x100]), 1);
    const length = view.getUint32(0x400, true);
    const name = String.fromCharCode(...Array.from({ length: length / 2 },
        (_, at)=>view.getUint16(0x404 + at * 2, true)));
    assert.equal(name.endsWith('WAR3.EXE') && !name.includes(':'), true,
        'FileNameInfo: the path below the drive');
    assert.equal(fns.GetFileInformationByHandleEx.handler([8, 2, 0x400, 8]), 0);
    assert.equal(errors.at(-1), 234, 'ERROR_MORE_DATA for a name that does not fit');
    assert.equal(view.getUint32(0x400, true), length, 'with its whole length still told');
    assert.equal(fns.GetFileInformationByHandleEx.handler([8, 0, 0x400, 16]), 0);
    assert.equal(errors.at(-1), 24, 'ERROR_BAD_LENGTH');
    assert.equal(fns.GetFileInformationByHandleEx.handler([8, 21, 0x400, 64]), 0);
    assert.equal(errors.at(-1), 87, 'a class this build does not answer');
    assert.equal(fns.GetFileInformationByHandleEx.handler([99, 0, 0x400, 40]), 0);
    assert.equal(errors.at(-1), 6);
    assert.equal(fns.GetFileInformationByHandleEx.argBytes, 16);
});

/**
 * A SYSTEMTIME's eight words.
 *
 * @param {Uint8Array} bytes @param {number} at @param {number[]} words
 */
const putWords = (bytes, at, words)=>{
    const view = new DataView(bytes.buffer);
    words.forEach((word, index)=>view.setUint16(at + index * 2, word, true));
};
/** @param {Uint8Array} bytes @param {number} at */
const words = (bytes, at)=>{
    const view = new DataView(bytes.buffer);
    return Array.from({ length: 8 }, (_, index)=>view.getUint16(at + index * 2, true));
};

test('SystemTimeToTzSpecificLocalTime with no zone is this machine\'s, which is UTC', ()=>{
    const { fns, bytes } = setup();
    putWords(bytes, 0x100, [2026, 10, 0, 4, 13, 45, 30, 250]);
    assert.equal(fns.SystemTimeToTzSpecificLocalTime.argBytes, 12);
    assert.equal(fns.SystemTimeToTzSpecificLocalTime.handler([0, 0x100, 0x120]), 1);
    assert.deepEqual(words(bytes, 0x120), [2026, 10, 0, 4, 13, 45, 30, 250],
        'unchanged, the day of the week (Sunday) computed');

    // The same as the zone GetTimeZoneInformation hands out, passed back in.
    assert.equal(fns.GetTimeZoneInformation.handler([0x600]), 0);
    assert.equal(fns.SystemTimeToTzSpecificLocalTime.handler([0x600, 0x100, 0x140]), 1);
    assert.deepEqual(words(bytes, 0x140), words(bytes, 0x120));
});

test('SystemTimeToTzSpecificLocalTime applies a zone\'s bias and its daylight rules', ()=>{
    const { fns, bytes } = setup();
    const ZONE = 0x600;
    const view = new DataView(bytes.buffer);
    // UTC+1, daylight from the last Sunday of March at 02:00 to the last
    // Sunday of October at 03:00, an hour more.
    view.setInt32(ZONE + TIME_ZONE_INFORMATION.Bias, -60, true);
    view.setInt32(ZONE + TIME_ZONE_INFORMATION.StandardBias, 0, true);
    view.setInt32(ZONE + TIME_ZONE_INFORMATION.DaylightBias, -60, true);
    putWords(bytes, ZONE + TIME_ZONE_INFORMATION.StandardDate, [0, 10, 0, 5, 3, 0, 0, 0]);
    putWords(bytes, ZONE + TIME_ZONE_INFORMATION.DaylightDate, [0, 3, 0, 5, 2, 0, 0, 0]);

    /** @param {number[]} utc */
    const convert = utc=>{
        putWords(bytes, 0x100, utc);
        assert.equal(fns.SystemTimeToTzSpecificLocalTime.handler([ZONE, 0x100, 0x120]), 1);
        return words(bytes, 0x120);
    };
    assert.deepEqual(convert([2026, 1, 0, 15, 12, 0, 0, 0]), [2026, 1, 4, 15, 13, 0, 0, 0]);
    assert.deepEqual(convert([2026, 7, 0, 1, 12, 0, 0, 0]), [2026, 7, 3, 1, 14, 0, 0, 0]);
    // 2026's last Sunday of March is the 29th: 01:00 UTC is 02:00 standard.
    assert.deepEqual(convert([2026, 3, 0, 29, 0, 59, 0, 0]), [2026, 3, 0, 29, 1, 59, 0, 0]);
    assert.deepEqual(convert([2026, 3, 0, 29, 1, 0, 0, 0]), [2026, 3, 0, 29, 3, 0, 0, 0]);
    // And of October the 25th: 01:00 UTC is 03:00 daylight.
    assert.deepEqual(convert([2026, 10, 0, 25, 0, 59, 0, 0]), [2026, 10, 0, 25, 2, 59, 0, 0]);
    assert.deepEqual(convert([2026, 10, 0, 25, 1, 0, 0, 0]), [2026, 10, 0, 25, 2, 0, 0, 0]);
    // Across midnight and the year.
    assert.deepEqual(convert([2026, 12, 0, 31, 23, 30, 0, 0]), [2027, 1, 5, 1, 0, 30, 0, 0]);
});

test('SystemTimeToTzSpecificLocalTime runs a southern zone\'s daylight across the new year', ()=>{
    const { fns, bytes } = setup();
    const ZONE = 0x600;
    const view = new DataView(bytes.buffer);
    // UTC+10, daylight from the first Sunday of October to the first of April.
    view.setInt32(ZONE + TIME_ZONE_INFORMATION.Bias, -600, true);
    view.setInt32(ZONE + TIME_ZONE_INFORMATION.DaylightBias, -60, true);
    putWords(bytes, ZONE + TIME_ZONE_INFORMATION.StandardDate, [0, 4, 0, 1, 3, 0, 0, 0]);
    putWords(bytes, ZONE + TIME_ZONE_INFORMATION.DaylightDate, [0, 10, 0, 1, 2, 0, 0, 0]);
    putWords(bytes, 0x100, [2026, 1, 0, 10, 0, 0, 0, 0]);
    assert.equal(fns.SystemTimeToTzSpecificLocalTime.handler([ZONE, 0x100, 0x120]), 1);
    assert.deepEqual(words(bytes, 0x120).slice(4, 6), [11, 0], 'January is daylight there');
    putWords(bytes, 0x100, [2026, 6, 0, 10, 0, 0, 0, 0]);
    fns.SystemTimeToTzSpecificLocalTime.handler([ZONE, 0x100, 0x120]);
    assert.deepEqual(words(bytes, 0x120).slice(4, 6), [10, 0], 'June is not');
});

test('SystemTimeToTzSpecificLocalTime refuses a time that names no moment', ()=>{
    const { fns, bytes, errors } = setup();
    putWords(bytes, 0x100, [2026, 2, 0, 30, 0, 0, 0, 0]);
    assert.equal(fns.SystemTimeToTzSpecificLocalTime.handler([0, 0x100, 0x120]), 0);
    assert.equal(fns.SystemTimeToTzSpecificLocalTime.handler([0, 0, 0x120]), 0);
    assert.deepEqual(errors, [87, 87]);
});

test('TzSpecificLocalTimeToSystemTime reads daylight off the local clock, as Windows does', ()=>{
    // Kernel32's time tests' three zones, in 2004: the hour each answer is
    // the UTC hour Windows gives, the transition hours included -- the hour
    // skipped in spring and the hour repeated in autumn both daylight time.
    const { fns, bytes, errors } = setup();
    const view = new DataView(bytes.buffer);
    /** @param {number} at @param {number[]} zone [bias, standard, daylight] dates */
    const zoneAt = (at, zone)=>{
        const [bias, standardMonth, standardDay, standardHour,
            daylightMonth, daylightDay, daylightHour] = zone;
        view.setInt32(at + TIME_ZONE_INFORMATION.Bias, bias, true);
        view.setInt32(at + TIME_ZONE_INFORMATION.DaylightBias, -60, true);
        putWords(bytes, at + TIME_ZONE_INFORMATION.StandardDate,
            [0, standardMonth, 0, standardDay, standardHour, 0, 0, 0]);
        putWords(bytes, at + TIME_ZONE_INFORMATION.DaylightDate,
            [0, daylightMonth, 0, daylightDay, daylightHour, 0, 0, 0]);
        return at;
    };
    const east = zoneAt(0x600, [-600, 10, 5, 3, 3, 5, 2]);
    const west = zoneAt(0x700, [240, 10, 4, 2, 4, 1, 2]);
    const south = zoneAt(0x800, [240, 4, 1, 2, 10, 4, 2]);
    const cases = [
        [east, 3, 28, 1, 0, 15], [east, 3, 28, 1, 59, 15], [east, 3, 28, 2, 0, 15],
        [east, 10, 31, 2, 0, 15], [east, 10, 31, 2, 59, 15], [east, 10, 31, 3, 0, 17],
        [west, 4, 4, 1, 0, 5], [west, 4, 4, 1, 59, 5], [west, 4, 4, 2, 0, 5],
        [west, 10, 24, 1, 0, 4], [west, 10, 24, 1, 59, 4], [west, 10, 24, 2, 0, 6],
        [south, 4, 4, 1, 0, 4], [south, 4, 4, 1, 59, 4], [south, 4, 4, 2, 0, 6],
        [south, 10, 24, 1, 0, 5], [south, 10, 24, 1, 59, 5], [south, 10, 24, 2, 0, 5],
    ];
    assert.equal(fns.TzSpecificLocalTimeToSystemTime.argBytes, 12);
    for (const [zone, month, day, hour, minute, expected] of cases)
    {
        putWords(bytes, 0x100, [2004, month, 0, day, hour, minute, 0, 0]);
        assert.equal(fns.TzSpecificLocalTimeToSystemTime.handler([zone, 0x100, 0x120]), 1);
        assert.equal(words(bytes, 0x120)[4], expected,
            `${month}/${day} ${hour}:${minute} in the zone at ${zone.toString(16)}`);
    }

    // The way there and back again agree away from the transitions.
    putWords(bytes, 0x100, [2004, 7, 0, 14, 9, 30, 15, 500]);
    fns.SystemTimeToTzSpecificLocalTime.handler([east, 0x100, 0x140]);
    fns.TzSpecificLocalTimeToSystemTime.handler([east, 0x140, 0x160]);
    assert.deepEqual(words(bytes, 0x160), [2004, 7, 3, 14, 9, 30, 15, 500]);

    putWords(bytes, 0x100, [2026, 10, 0, 4, 13, 45, 30, 250]);
    assert.equal(fns.TzSpecificLocalTimeToSystemTime.handler([0, 0x100, 0x120]), 1);
    assert.deepEqual(words(bytes, 0x120), [2026, 10, 0, 4, 13, 45, 30, 250],
        'no zone is this machine\'s, UTC');
    putWords(bytes, 0x100, [2026, 2, 0, 30, 0, 0, 0, 0]);
    assert.equal(fns.TzSpecificLocalTimeToSystemTime.handler([0, 0x100, 0x120]), 0);
    assert.equal(fns.TzSpecificLocalTimeToSystemTime.handler([0, 0x100, 0]), 0);
    assert.deepEqual(errors, [87, 87]);
});

test('a directory lists by handle as many entries as fit, then goes on, then has no more', ()=>{
    const bytes = new Uint8Array(0x1000);
    /** @type {number[]} */
    const errors = [];
    const folder = { path: 'C:\\GAME', directory: true };
    const fns = createFileTimeFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        setLastError: code=>{
            errors.push(code);
        },
        resolveHandle: ()=>folder,
        stat: ()=>({ exists: true, isDirectory: true, size: 0 }),
        list: ()=>[{ name: 'SAVE.DAT', isDirectory: false, size: 5000 },
            { name: 'DATA', isDirectory: true, size: 0 }],
    });
    const list = fns.GetFileInformationByHandleEx;
    assert.equal(list.handler([8, 10, 0, 0]), 0);
    assert.equal(errors.at(-1), 24, 'ERROR_BAD_LENGTH');
    assert.equal(list.handler([8, 10, 0, 0x400]), 0);
    assert.equal(errors.at(-1), 998, 'ERROR_NOACCESS');
    assert.equal(list.handler([8, 10, 0x100, 0]), 0);
    assert.equal(errors.at(-1), 24);

    // ".", ".." and SAVE.DAT fit: 104 + 2 -> 112, 104 + 4 -> 224, 104 + 16 = 344.
    assert.equal(list.handler([8, 10, 0x100, 344]), 1);
    assert.equal(dword(bytes, 0x100), 112, 'the next entry on an eight-byte boundary');
    assert.equal(dword(bytes, 0x100 + 60), 2, '"." named');
    assert.equal(bytes[0x100 + 104], '.'.charCodeAt(0));
    assert.equal(dword(bytes, 0x100 + 112), 112);
    const third = 0x100 + 224;
    assert.equal(dword(bytes, third), 0, 'the last of this call');
    assert.equal(dword(bytes, third + 40), 5000, 'EndOfFile');
    assert.equal(dword(bytes, third + 48), 8192, 'whole clusters');
    assert.equal(dword(bytes, third + 56), 0x20, 'FILE_ATTRIBUTE_ARCHIVE');
    assert.equal(dword(bytes, third + 60), 16);
    assert.notEqual(dword(bytes, third + 96), 0, 'a file ID');

    assert.equal(list.handler([8, 10, 0x100, 0x400]), 1, 'on from where it stopped');
    assert.equal(dword(bytes, 0x100 + 56), 0x10, 'DATA, a directory');
    assert.equal(dword(bytes, 0x100), 0);
    assert.equal(list.handler([8, 10, 0x100, 0x400]), 0);
    assert.equal(errors.at(-1), 18, 'ERROR_NO_MORE_FILES');
    assert.equal(list.handler([8, 11, 0x100, 112]), 1, 'a restart lists from the start');
    assert.equal(dword(bytes, 0x100 + 60), 2);
    assert.equal(list.handler([8, 10, 0x100, 100]), 0, 'no room for one entry');
    assert.equal(errors.at(-1), 234, 'ERROR_MORE_DATA');
});
