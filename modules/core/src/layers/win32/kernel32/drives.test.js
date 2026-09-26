/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDriveFunctions } from './drives.js';
import { decodeAnsi } from './locale.js';

const DRIVE_NO_ROOT_DIR = 1;
const DRIVE_FIXED = 3;

/** @param {string[]} [mounted] */
function setup(mounted = ['C']){
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

test('a buffer with no room is told the size instead of being written', ()=>{
    const { fns, bytes } = setup(['C']);
    bytes[0x40] = 0xaa;
    assert.equal(fns.GetLogicalDriveStringsA.handler([2, 0x40]), 5);
    assert.equal(bytes[0x40], 0xaa, 'and nothing was written');
});

test('a mounted drive is fixed and an unmounted one has no root', ()=>{
    // Never removable and never a CD: both send a program down a path that ends
    // at a disc nobody can insert.
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
