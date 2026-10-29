/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDriveFunctions, onVolume, volumeName } from './drives.js';
import { decodeAnsi } from './locale.js';

const DRIVE_NO_ROOT_DIR = 1;
const DRIVE_FIXED = 3;
const DRIVE_CDROM = 5;

/**
 * @param {string[]} [mounted]
 * @param {Record<string, any>} [volumes]  What each letter says of itself.
 * @param {Record<string, any>} [extra]  More of the host, for the calls that need it.
 */
function setup(mounted = ['C'], volumes = {}, extra = {}){
    const bytes = new Uint8Array(0x1000);
    /** @type {number[]} */
    const errors = [];
    const fns = createDriveFunctions({
        // As the memory layer reads an ANSI string: in Windows-1252, which is
        // what the Encoding standard calls latin1.
        readCString: (address, maxLength)=>{
            let end = address;
            while (end - address < maxLength && bytes[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(bytes.subarray(address, end));
        },
        readWideString: (address, maxLength)=>{
            let text = '';
            for (let at = 0; at < maxLength; at++)
            {
                const code = bytes[address + at * 2] | bytes[address + at * 2 + 1] << 8;
                if (code === 0)
                {
                    break;
                }
                text += String.fromCharCode(code);
            }
            return text;
        },
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        setLastError: code=>{
            errors.push(code);
        },
        drives: ()=>mounted,
        volume: letter=>volumes[letter] ?? (mounted.includes(letter) ? { readOnly: false } : null),
        ...extra,
    });
    return { fns, bytes, errors };
}

/** @param {Uint8Array} bytes @param {number} at @param {string} text */
const plant = (bytes, at, text)=>{
    for (let i = 0; i < text.length; i++)
    {
        bytes[at + i] = text.charCodeAt(i);
    }
    bytes[at + text.length] = 0;
};

/** @param {Uint8Array} bytes @param {number} at */
const dword = (bytes, at)=>
    (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

test('the drive mask has a bit per letter, counted from A', ()=>{
    // A caller walks the bits rather than reading a list, so a letter missing
    // here is a drive that does not exist however well it answers elsewhere.
    assert.equal(setup(['C']).fns.GetLogicalDrives.handler(), 0b100);
    assert.equal(setup(['A', 'C', 'D']).fns.GetLogicalDrives.handler(), 0b1101);
});

test('the drive strings block ends with an empty entry', ()=>{
    // That second terminator is what stops a caller walking off the end of it.
    const { fns, bytes } = setup(['C', 'D']);
    // Dirtied first: on a zero-filled buffer "it ends in a terminator" is true
    // of a block that was never written, which asserts nothing.
    bytes.fill(0xaa, 0x40, 0x60);
    const length = fns.GetLogicalDriveStringsA.handler([0x100, 0x40]);

    assert.equal(length, 8, 'two roots of four bytes each, without the closing NUL');
    assert.equal(String.fromCharCode(...bytes.slice(0x40, 0x48)),
        `C:${String.fromCharCode(92)}\0D:${String.fromCharCode(92)}\0`);
    assert.equal(bytes[0x48], 0);
});

test('the wide drive strings are the same block, counted in characters', ()=>{
    const { fns, bytes } = setup(['C', 'D']);
    bytes.fill(0xaa, 0x40, 0x60);
    assert.equal(fns.GetLogicalDriveStringsW.handler([0x100, 0x40]), 8);
    const text = String.fromCharCode(...new Uint16Array(bytes.slice(0x40, 0x52).buffer));
    assert.equal(text, `C:${String.fromCharCode(92)}\0D:${String.fromCharCode(92)}\0\0`);
    assert.equal(fns.GetLogicalDriveStringsW.handler([4, 0x40]), 9, 'too small: the size');
});

test('a buffer with no room is told the size instead of being written', ()=>{
    const { fns, bytes } = setup(['C']);
    bytes[0x40] = 0xaa;
    assert.equal(fns.GetLogicalDriveStringsA.handler([2, 0x40]), 5);
    assert.equal(bytes[0x40], 0xaa, 'and nothing was written');
});

test('a mounted drive is fixed and an unmounted one has no root', ()=>{
    // Never removable, and never a CD unless it is one: both send a program
    // down a path that ends at a disc nobody can insert.
    const { fns, bytes } = setup(['C']);
    plant(bytes, 0x200, 'C:' + String.fromCharCode(92));
    plant(bytes, 0x220, 'E:' + String.fromCharCode(92));

    assert.equal(fns.GetDriveTypeA.handler([0x200]), DRIVE_FIXED);
    assert.equal(fns.GetDriveTypeA.handler([0x220]), DRIVE_NO_ROOT_DIR);
});

test('the byte-count form says the whole volume, which the cluster form clamps', ()=>{
    const { fns, bytes } = setup(['C']);
    plant(bytes, 0x200, 'C:' + String.fromCharCode(92));
    assert.equal(fns.GetDiskFreeSpaceA.handler([0x200, 0x100, 0x104, 0x108, 0x10c]), 1);
    const cluster = dword(bytes, 0x100) * dword(bytes, 0x104);

    assert.equal(fns.GetDiskFreeSpaceExA.handler([0x200, 0x110, 0x118, 0x120]), 1);
    /** @param {number} at */
    const qword = at=>dword(bytes, at) + dword(bytes, at + 4) * 0x1_0000_0000;
    assert.equal(qword(0x118), 32 * 1024 * 1024 * 1024, 'the whole volume');
    assert.equal(qword(0x110), 24 * 1024 * 1024 * 1024, 'and what is free of it');
    assert.equal(qword(0x120), qword(0x110), 'which with one user is what is available');
    assert.ok(qword(0x118) > dword(bytes, 0x10c) * cluster,
        'more than the cluster call can say, which is clamped rather than wrapped');
    assert.equal(dword(bytes, 0x10c) * cluster, 0x1_0000_0000 - cluster, 'to just under 2^32');

    plant(bytes, 0x220, 'Q:' + String.fromCharCode(92));
    assert.equal(fns.GetDiskFreeSpaceExA.handler([0x220, 0x110, 0x118, 0x120]), 0,
        'a drive that is not there has no size');
});

test('both spellings of GetDriveType agree', ()=>{
    // Two implementations of one answer drift, and the drift shows as a drive
    // that exists when asked one way and not the other.
    const { fns, bytes } = setup(['C']);
    plant(bytes, 0x200, 'C:' + String.fromCharCode(92));
    for (const [at, character] of [...'C:' + String.fromCharCode(92)].entries())
    {
        bytes[0x300 + at * 2] = character.charCodeAt(0);
        bytes[0x300 + at * 2 + 1] = 0;
    }
    bytes[0x306] = 0;
    bytes[0x307] = 0;

    assert.equal(fns.GetDriveTypeW.handler([0x300]), fns.GetDriveTypeA.handler([0x200]));
});

test('the free-space figures multiply without wrapping', ()=>{
    // The documented way to get a byte count out of this is to multiply all
    // four, and a caller doing that on 32-bit values must not overflow.
    const { fns, bytes } = setup(['C']);
    plant(bytes, 0x200, 'C:' + String.fromCharCode(92));

    assert.equal(fns.GetDiskFreeSpaceA.handler([0x200, 0x100, 0x104, 0x108, 0x10c]), 1);
    const sectors = dword(bytes, 0x100);
    const bytesPerSector = dword(bytes, 0x104);
    const free = dword(bytes, 0x108);
    const total = dword(bytes, 0x10c);

    assert.ok(free <= total);
    assert.ok(total * sectors * bytesPerSector <= 0xffffffff,
        'the product stays inside what a caller can hold');
});

test('GetComputerName reports the length it wrote, and the length it needed', ()=>{
    // The size argument is in and out, and the two answers differ by one. A
    // caller sizing its second attempt from the wrong one is short for ever.
    const { fns, bytes } = setup();
    bytes.set([2, 0, 0, 0], 0x104);
    assert.equal(fns.GetComputerNameA.handler([0x140, 0x104]), 0);
    assert.equal(dword(bytes, 0x104), 9, 'the room needed, including the terminator');

    bytes.set([32, 0, 0, 0], 0x104);
    assert.equal(fns.GetComputerNameA.handler([0x140, 0x104]), 1);
    assert.equal(dword(bytes, 0x104), 8, 'and now the length written, without it');
    assert.equal(String.fromCharCode(...bytes.slice(0x140, 0x148)), 'BOTTLIFY');

    bytes.set([32, 0, 0, 0], 0x104);
    assert.equal(fns.GetComputerNameW.handler([0x180, 0x104]), 1);
    assert.equal(dword(bytes, 0x104), 8, 'the wide one counts characters');
    assert.equal(String.fromCharCode(...new Uint16Array(bytes.slice(0x180, 0x192).buffer)),
        'BOTTLIFY\0');
});

test('a label set on a volume is the one its information reads back', ()=>{
    const { fns, bytes, errors } = setup(['C']);
    plant(bytes, 0x100, 'C:\\');
    plant(bytes, 0x120, 'WAR3');
    assert.equal(fns.SetVolumeLabelA.argBytes, 8);
    assert.equal(fns.SetVolumeLabelA.handler([0x100, 0x120]), 1);
    assert.equal(fns.GetVolumeInformationA.handler([0x100, 0x200, 32, 0, 0, 0, 0, 0]), 1);
    assert.equal(String.fromCharCode(...bytes.slice(0x200, 0x204)), 'WAR3');
    assert.equal(bytes[0x204], 0);

    // A null name clears it, and a root that is no drive is refused.
    assert.equal(fns.SetVolumeLabelA.handler([0x100, 0]), 1);
    assert.equal(fns.GetVolumeInformationA.handler([0x100, 0x200, 32, 0, 0, 0, 0, 0]), 1);
    assert.equal(bytes[0x200], 0);
    plant(bytes, 0x140, 'Q:\\');
    assert.equal(fns.SetVolumeLabelA.handler([0x140, 0x120]), 0);
    assert.equal(errors.at(-1), 87);
});

test('a label in the upper half of the ANSI page reads back as the bytes it was set as', ()=>{
    // The label is kept as the memory layer read it, where 0x80 is the euro
    // sign, 0x99 the trade mark and 0x97 an em dash, and goes back in that page.
    const { fns, bytes } = setup(['C']);
    plant(bytes, 0x100, 'C:\\');
    const label = [0x80, 0x99, 0x97, 0xe9];
    bytes.set([...label, 0], 0x120);
    assert.equal(fns.SetVolumeLabelA.handler([0x100, 0x120]), 1);
    assert.equal(fns.GetVolumeInformationA.handler([0x100, 0x200, 32, 0, 0, 0, 0, 0]), 1);
    assert.deepEqual([...bytes.subarray(0x200, 0x200 + label.length + 1)], [...label, 0]);
});

const DISC = { kind: 'cdrom', label: 'NFS_DEMO', serial: 0x1234abcd, size: 616 * 1024 * 1024,
    unicode: true, readOnly: true };

test('a disc is a CD-ROM with its own label, serial and file system', ()=>{
    const { fns, bytes } = setup(['C', 'D'], { D: DISC });
    plant(bytes, 0x100, 'D:\\');
    plant(bytes, 0x110, 'C:\\');
    assert.equal(fns.GetDriveTypeA.handler([0x100]), DRIVE_CDROM);
    assert.equal(fns.GetDriveTypeA.handler([0x110]), DRIVE_FIXED);

    assert.equal(fns.GetVolumeInformationA.handler(
        [0x100, 0x200, 32, 0x240, 0x244, 0x248, 0x260, 16]), 1);
    assert.equal(decodeAnsi(bytes.subarray(0x200, 0x208)), 'NFS_DEMO');
    assert.equal(bytes[0x208], 0);
    assert.equal(dword(bytes, 0x240), 0x1234abcd);
    assert.equal(dword(bytes, 0x244), 110, 'the longest Joliet name, in characters');
    assert.equal(dword(bytes, 0x248) & 0x00080000, 0x00080000, 'a read-only volume');
    assert.equal(dword(bytes, 0x248) & 0x4, 0x4, 'with its names in Unicode');
    assert.equal(decodeAnsi(bytes.subarray(0x260, 0x264)), 'CDFS');

    // The machine's own disk still answers as itself.
    assert.equal(fns.GetVolumeInformationA.handler([0x110, 0x200, 32, 0x240, 0, 0, 0x260, 16]), 1);
    assert.equal(decodeAnsi(bytes.subarray(0x200, 0x208)), 'Bottlify');
    assert.equal(decodeAnsi(bytes.subarray(0x260, 0x264)), 'NTFS');
});

test('the wide form of the volume information writes the same answers in UTF-16', ()=>{
    const { fns, bytes, errors } = setup(['C', 'D'], { D: DISC });
    const root = 'D:\\\0';
    for (const [at, character] of [...root].entries())
    {
        bytes[0x100 + at * 2] = character.charCodeAt(0);
    }
    assert.equal(fns.GetVolumeInformationW.handler([0x100, 0x200, 9, 0x240, 0, 0, 0x280, 5]), 1);
    assert.equal(String.fromCharCode(...new Uint16Array(bytes.slice(0x200, 0x212).buffer)),
        'NFS_DEMO\0');
    assert.equal(String.fromCharCode(...new Uint16Array(bytes.slice(0x280, 0x28a).buffer)),
        'CDFS\0');
    // A buffer one character short of the label is refused, counted in characters.
    assert.equal(fns.GetVolumeInformationW.handler([0x100, 0x200, 8, 0, 0, 0, 0, 0]), 0);
    assert.equal(errors.at(-1), 87);
});

test('a disc is full, sized as the disc, and keeps its own label', ()=>{
    const { fns, bytes, errors } = setup(['C', 'D'], { D: DISC });
    plant(bytes, 0x100, 'D:\\');
    assert.equal(fns.GetDiskFreeSpaceA.handler([0x100, 0x120, 0x124, 0x128, 0x12c]), 1);
    assert.equal(dword(bytes, 0x120), 1);
    assert.equal(dword(bytes, 0x124), 2048);
    assert.equal(dword(bytes, 0x128), 0);
    assert.equal(dword(bytes, 0x12c), DISC.size / 2048);

    assert.equal(fns.GetDiskFreeSpaceExA.handler([0x100, 0x130, 0x138, 0x140]), 1);
    assert.equal(dword(bytes, 0x130), 0);
    assert.equal(dword(bytes, 0x138), DISC.size);
    assert.equal(dword(bytes, 0x140), 0);

    plant(bytes, 0x160, 'MINE');
    assert.equal(fns.SetVolumeLabelA.handler([0x100, 0x160]), 0);
    assert.equal(errors.at(-1), 19, 'ERROR_WRITE_PROTECT');
});

test('the wide free-space calls answer what the A calls answer', ()=>{
    const { fns, bytes } = setup(['C']);
    plant(bytes, 0x200, 'C:' + String.fromCharCode(92));
    for (const [at, character] of [...'C:' + String.fromCharCode(92)].entries())
    {
        bytes[0x300 + at * 2] = character.charCodeAt(0);
        bytes[0x300 + at * 2 + 1] = 0;
    }
    bytes[0x306] = 0;
    bytes[0x307] = 0;

    assert.equal(fns.GetDiskFreeSpaceW.argBytes, 20);
    assert.equal(fns.GetDiskFreeSpaceA.handler([0x200, 0x100, 0x104, 0x108, 0x10c]), 1);
    const narrow = [0x100, 0x104, 0x108, 0x10c].map(at=>dword(bytes, at));
    bytes.fill(0, 0x100, 0x110);
    assert.equal(fns.GetDiskFreeSpaceW.handler([0x300, 0x100, 0x104, 0x108, 0x10c]), 1);
    assert.deepEqual([0x100, 0x104, 0x108, 0x10c].map(at=>dword(bytes, at)), narrow);

    assert.equal(fns.GetDiskFreeSpaceExW.argBytes, 16);
    assert.equal(fns.GetDiskFreeSpaceExW.handler([0x300, 0, 0x118, 0]), 1);
    assert.equal(dword(bytes, 0x118) + dword(bytes, 0x11c) * 0x1_0000_0000,
        32 * 1024 * 1024 * 1024);
});

test('QueryDosDevice names the device behind a drive letter, and lists every drive for none', ()=>{
    const bs = String.fromCharCode(92);
    const { fns, bytes, errors } = setup(['C', 'D', 'E'], { D: { kind: 'cdrom' } });
    plant(bytes, 0x200, 'c:');
    assert.equal(fns.QueryDosDeviceA.argBytes, 12);

    const length = fns.QueryDosDeviceA.handler([0x200, 0x300, 0x40]);
    const first = `${bs}Device${bs}HarddiskVolume1\0\0`;
    assert.equal(length, first.length, 'the characters stored, both terminators counted');
    assert.equal(String.fromCharCode(...bytes.slice(0x300, 0x300 + length)), first);

    plant(bytes, 0x200, 'D:');
    fns.QueryDosDeviceA.handler([0x200, 0x300, 0x40]);
    assert.equal(String.fromCharCode(...bytes.slice(0x300, 0x300 + 14)), `${bs}Device${bs}CdRom0`);
    plant(bytes, 0x200, 'E:');
    fns.QueryDosDeviceA.handler([0x200, 0x300, 0x40]);
    assert.equal(String.fromCharCode(...bytes.slice(0x300, 0x300 + 23)),
        `${bs}Device${bs}HarddiskVolume2`, 'volumes count apart from discs');

    const all = fns.QueryDosDeviceA.handler([0, 0x300, 0x40]);
    assert.equal(String.fromCharCode(...bytes.slice(0x300, 0x300 + all)), 'C:\0D:\0E:\0\0');

    plant(bytes, 0x200, 'Z:');
    assert.equal(fns.QueryDosDeviceA.handler([0x200, 0x300, 0x40]), 0);
    assert.equal(errors.at(-1), 2, 'ERROR_FILE_NOT_FOUND');
    plant(bytes, 0x200, 'C:');
    bytes[0x300] = 0xaa;
    assert.equal(fns.QueryDosDeviceA.handler([0x200, 0x300, 4]), 0);
    assert.equal(errors.at(-1), 122, 'ERROR_INSUFFICIENT_BUFFER');
    assert.equal(bytes[0x300], 0xaa, 'and nothing was stored');
});

test('QueryDosDeviceW answers in UTF-16', ()=>{
    const { fns, bytes } = setup(['C']);
    [...'C:'].forEach((character, index)=>{
        bytes[0x200 + index * 2] = character.charCodeAt(0);
        bytes[0x201 + index * 2] = 0;
    });
    bytes[0x204] = 0;
    bytes[0x205] = 0;
    const length = fns.QueryDosDeviceW.handler([0x200, 0x300, 0x40]);
    assert.equal(length, 25, '\\Device\\HarddiskVolume1 and two terminators');
    assert.equal(bytes[0x300], 0x5c);
    assert.equal(bytes[0x301], 0);
});

/** @param {Uint8Array} bytes @param {number} at */
const ansiAt = (bytes, at)=>String.fromCharCode(...bytes.subarray(at, bytes.indexOf(0, at)));

/** @param {Uint8Array} bytes @param {number} at @param {number} [count] */
const wideAt = (bytes, at, count)=>{
    const units = new Uint16Array(bytes.slice(at, at + (count ?? 0x200) * 2).buffer);
    const text = String.fromCharCode(...units);
    return count === undefined ? text.slice(0, text.indexOf('\0')) : text;
};

test('each drive has one volume name, the same each time, that leads back to it', ()=>{
    const name = volumeName('C');
    assert.match(name, /^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\$/);
    assert.equal(name.length, 49);
    assert.equal(volumeName('c'), name);
    assert.notEqual(volumeName('D'), name);
    assert.deepEqual(onVolume(`${name}WINDOWS`), { letter: 'C', rest: 'WINDOWS' });
    assert.deepEqual(onVolume(name.slice(0, -1)), { letter: 'C', rest: '' });
    assert.equal(onVolume('C:\\WINDOWS'), null);
    assert.deepEqual(onVolume(`\\\\.\\${name.slice(4, -1)}`), { letter: 'C', rest: '' },
        'the device namespace\'s spelling');
});

test('FindFirstVolume and FindNextVolume walk the drives, then say there are no more', ()=>{
    const { fns, bytes, errors } = setup(['C', 'D']);
    const find = fns.FindFirstVolumeA.handler([0x100, 50]);
    assert.notEqual(find, 0xffffffff);
    assert.equal(ansiAt(bytes, 0x100), volumeName('C'));
    assert.equal(fns.FindNextVolumeA.handler([find, 0x100, 49]), 0, 'no room for the terminator');
    assert.equal(errors.at(-1), 206, 'ERROR_FILENAME_EXCED_RANGE');
    assert.equal(fns.FindNextVolumeA.handler([find, 0x100, 50]), 1);
    assert.equal(ansiAt(bytes, 0x100), volumeName('D'));
    assert.equal(fns.FindNextVolumeA.handler([find, 0x100, 50]), 0);
    assert.equal(errors.at(-1), 18, 'ERROR_NO_MORE_FILES');
    assert.equal(fns.FindVolumeClose.handler([find]), 1);
    assert.equal(fns.FindVolumeClose.handler([find]), 0, 'closed once');
    assert.equal(fns.FindFirstVolumeW.handler([0x100, 50]) >>> 0 !== 0xffffffff, true);
    assert.equal(wideAt(bytes, 0x100), volumeName('C'));
});

test('a drive\'s root names its volume; anything that is no mount point is refused', ()=>{
    const { fns, bytes, errors } = setup(['C'], {}, {
        stat: (/** @type {string} */ path)=>({ exists: path === 'C:\\WINDOWS', isDirectory: true }) });
    const ask = (/** @type {string} */ point, room = 50)=>{
        plant(bytes, 0x10, point);
        return fns.GetVolumeNameForVolumeMountPointA.handler([0x10, 0x200, room]);
    };
    assert.equal(ask('C:\\'), 1);
    assert.equal(ansiAt(bytes, 0x200), volumeName('C'));
    assert.equal(ask('C:/'), 1, 'a forward slash too');
    assert.equal(ask(volumeName('C')), 1, 'the volume\'s own name');
    assert.equal(ask('C:'), 0);
    assert.equal(errors.at(-1), 123, 'ERROR_INVALID_NAME without the separator');
    assert.equal(ask('C:\\', 49), 0);
    assert.equal(errors.at(-1), 206);
    assert.equal(ask('C:\\WINDOWS\\'), 0);
    assert.equal(errors.at(-1), 4390, 'ERROR_NOT_A_REPARSE_POINT');
    assert.equal(ask('Q:\\'), 0);
    assert.equal(errors.at(-1), 2);
});

test('GetVolumePathName answers a path\'s drive root, kept in its own spelling when long', ()=>{
    const { fns, bytes, errors } = setup(['C'], {}, { currentDirectory: ()=>'C:\\GAME' });
    const ask = (/** @type {string} */ path, room = 0x100)=>{
        plant(bytes, 0x10, path);
        return fns.GetVolumePathNameA.handler([0x10, 0x200, room]) === 1
            ? ansiAt(bytes, 0x200) : `error ${errors.at(-1)}`;
    };
    assert.equal(ask('c:\\windows\\system32'), 'C:\\');
    assert.equal(ask('relative\\file'), 'C:\\', 'on the current directory\'s drive');
    assert.equal(ask('\\\\?\\c:\\windows'), '\\\\?\\c:\\');
    assert.equal(ask(`${volumeName('C')}x`), volumeName('C'));
    assert.equal(ask('Q:\\x'), 'error 2');
    assert.equal(ask('\\\\server\\share'), 'error 123');
    assert.equal(ask('C:\\x', 4), 'C:\\');
    assert.equal(ask('C:\\x', 3), 'C:', 'one short, the separator goes');
    assert.equal(ask('C:\\x', 2), 'error 206');
});

test('a volume is mounted at its drive\'s root alone, in a list ended twice', ()=>{
    const { fns, bytes, errors } = setup(['C']);
    plant(bytes, 0x10, volumeName('C'));
    assert.equal(fns.GetVolumePathNamesForVolumeNameA.handler([0x10, 0x200, 2, 0x300]), 0);
    assert.equal(errors.at(-1), 234, 'ERROR_MORE_DATA');
    assert.equal(dword(bytes, 0x300), 5);
    assert.equal(fns.GetVolumePathNamesForVolumeNameA.handler([0x10, 0x200, 5, 0x300]), 1);
    assert.deepEqual([...bytes.subarray(0x200, 0x205)], [...'C:\\\0\0'].map(c=>c.charCodeAt(0)));
    plant(bytes, 0x10, 'C:\\');
    assert.equal(fns.GetVolumePathNamesForVolumeNameA.handler([0x10, 0x200, 5, 0x300]), 0);
    assert.equal(errors.at(-1), 123);
});

test('DefineDosDevice names a target QueryDosDevice reports; removing it uncovers the last', ()=>{
    const { fns, bytes, errors } = setup(['C']);
    plant(bytes, 0x10, 'BTLDEV');
    plant(bytes, 0x40, 'C:/GAME');
    assert.equal(fns.DefineDosDeviceA.handler([0, 0x10, 0x40]), 1);
    plant(bytes, 0x40, '\\Device\\Raw');
    assert.equal(fns.DefineDosDeviceA.handler([1, 0x10, 0x40]), 1, 'DDD_RAW_TARGET_PATH');
    assert.equal(fns.QueryDosDeviceA.handler([0x10, 0x200, 0x100]) > 0, true);
    assert.equal(ansiAt(bytes, 0x200), '\\Device\\Raw', 'the latest first');
    assert.equal(fns.DefineDosDeviceA.handler([2, 0x10, 0]), 1, 'DDD_REMOVE_DEFINITION');
    assert.equal(fns.QueryDosDeviceA.handler([0x10, 0x200, 0x100]) > 0, true);
    assert.equal(ansiAt(bytes, 0x200), '\\??\\C:\\GAME', 'its slashes turned');
    plant(bytes, 0x40, '\\??\\C:\\ELSE');
    assert.equal(fns.DefineDosDeviceA.handler([2 | 4, 0x10, 0x40]), 0, 'no such target');
    assert.equal(errors.at(-1), 2);
    assert.equal(fns.DefineDosDeviceA.handler([2, 0x10, 0]), 1);
    assert.equal(fns.QueryDosDeviceA.handler([0x10, 0x200, 0x100]), 0, 'gone');
    assert.equal(fns.DefineDosDeviceA.handler([0, 0, 0x40]), 0);
    assert.equal(errors.at(-1), 87);
});

test('no folder is a mount point: making one is refused and said, removing one finds none', ()=>{
    /** @type {string[]} */
    const said = [];
    const { fns, errors } = setup(['C'], {}, {
        divergence: (/** @type {string} */ api)=>said.push(api) });
    assert.equal(/** @type {any} */ (fns.SetVolumeMountPointA).handler([0x10, 0x40]), 0);
    assert.equal(errors.at(-1), 5);
    assert.deepEqual(said, ['SetVolumeMountPointA']);
    assert.equal(/** @type {any} */ (fns.DeleteVolumeMountPointW).handler([0x10]), 0);
    assert.equal(errors.at(-1), 4390);
});

test('a volume is described the same by its handle, natively and by its root', ()=>{
    const opened = { path: 'C:\\WINDOWS' };
    const handles = { resolve: (/** @type {number} */ handle, /** @type {string} */ kind)=>{
        if (handle === 0x44 && kind === 'file')
        {
            return opened;
        }
        throw new Error('no such handle');
    } };
    const { fns, bytes, errors } = setup(['C', 'D'], { D: { kind: 'cdrom', label: 'DISC',
        serial: 0x1234, size: 2048 * 10, unicode: true } }, { handles });
    const byHandle = fns.GetVolumeInformationByHandleW;
    assert.equal(byHandle.argBytes, 32);
    assert.equal(byHandle.handler([0xffffffff, 0x100, 20, 0x180, 0x184, 0x188, 0x190, 20]), 0);
    assert.equal(errors.at(-1), 6, 'ERROR_INVALID_HANDLE');
    assert.equal(byHandle.handler([0x44, 0, 0, 0, 0, 0, 0, 0]), 1, 'nothing asked');
    assert.equal(byHandle.handler([0x44, 0x100, 20, 0x180, 0x184, 0x188, 0x190, 20]), 1);
    plant(bytes, 0x10, 'C:\\');
    assert.equal(fns.GetVolumeInformationA.handler([0x10, 0x200, 20, 0x280, 0x284, 0x288,
        0x290, 20]), 1);
    assert.equal(wideAt(bytes, 0x100), ansiAt(bytes, 0x200), 'the label');
    assert.equal(wideAt(bytes, 0x190), ansiAt(bytes, 0x290), 'the file system');
    for (const at of [0, 4, 8])
    {
        assert.equal(dword(bytes, 0x180 + at), dword(bytes, 0x280 + at));
    }
    assert.equal(byHandle.handler([0x44, 0, 0, 0, 0x184, 0x188, 0x190, 2]), 0);
    assert.equal(errors.at(-1), 24, 'ERROR_BAD_LENGTH');

    const query = /** @type {any} */ (byHandle).natives.NtQueryVolumeInformationFile;
    assert.equal(query.argBytes, 20);
    const system = ansiAt(bytes, 0x290);
    assert.equal(query.handler([0x44, 0x300, 0x400, 50, 5]), 0, 'FileFsAttributeInformation');
    assert.equal(dword(bytes, 0x400), dword(bytes, 0x288));
    assert.equal(dword(bytes, 0x404), dword(bytes, 0x284));
    assert.equal(dword(bytes, 0x408), system.length * 2);
    assert.equal(wideAt(bytes, 0x40c, system.length), system);
    assert.equal(dword(bytes, 0x304), 12 + system.length * 2);
    const label = ansiAt(bytes, 0x200);
    assert.equal(query.handler([0x44, 0x300, 0x400, 50, 1]), 0, 'FileFsVolumeInformation');
    assert.equal(dword(bytes, 0x408), dword(bytes, 0x280), 'the serial');
    assert.equal(dword(bytes, 0x40c), label.length * 2);
    assert.equal(wideAt(bytes, 0x412, label.length), label);
    assert.equal(query.handler([0x44, 0x300, 0x400, 20, 1]) >>> 0, 0x80000005,
        'STATUS_BUFFER_OVERFLOW: part of the label');
    assert.equal(dword(bytes, 0x304), 20);
    assert.equal(query.handler([0x44, 0x300, 0x400, 17, 1]) >>> 0, 0xc0000004,
        'STATUS_INFO_LENGTH_MISMATCH');
    assert.equal(query.handler([0x44, 0x300, 0x400, 32, 7]), 0, 'FileFsFullSizeInformation');
    assert.equal(dword(bytes, 0x418), 8, 'sectors per cluster');
    assert.equal(dword(bytes, 0x41c), 512);
    assert.equal(query.handler([0x44, 0x300, 0x400, 8, 4]), 0, 'FileFsDeviceInformation');
    assert.equal(dword(bytes, 0x400), 7, 'FILE_DEVICE_DISK');
    assert.equal(query.handler([0x44, 0x300, 0x400, 50, 2]) >>> 0, 0xc0000003);
    assert.equal(query.handler([0x45, 0x300, 0x400, 50, 1]) >>> 0, 0xc0000008);

    opened.path = 'D:\\SETUP.EXE';
    assert.equal(query.handler([0x44, 0x300, 0x400, 8, 4]), 0);
    assert.equal(dword(bytes, 0x400), 2, 'FILE_DEVICE_CD_ROM');
    assert.equal(dword(bytes, 0x404), 0x23, 'mounted, removable, read-only');
    assert.equal(query.handler([0x44, 0x300, 0x400, 24, 3]), 0, 'FileFsSizeInformation');
    assert.equal(dword(bytes, 0x400), 10);
    assert.equal(dword(bytes, 0x414), 2048);
});
