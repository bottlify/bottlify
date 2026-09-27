/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPathFunctions } from './paths.js';

const DOS = 0x100;
const NT = 0x300;
const PART = 0x310;
const RELATIVE = 0x320;

/**
 * Guest memory, a bump heap, and a GetFullPathNameW that resolves against
 * `C:\GAME` with the two-call protocol the real one keeps.
 */
function fakeHost(){
    const bytes = new Uint8Array(0x2000);
    let next = 0x1000;
    /** @type {number[]} */
    const freed = [];
    /** @param {number} address @param {number} maxLength */
    const readWideString = (address, maxLength)=>{
        let text = '';
        for (let at = 0; at + 1 < maxLength; at += 2)
        {
            const code = bytes[address + at] | (bytes[address + at + 1] << 8);
            if (code === 0)
            {
                return text;
            }
            text += String.fromCharCode(code);
        }
        throw new Error('unterminated');
    };
    /** @param {number} address @param {string} text */
    const putWide = (address, text)=>{
        for (let at = 0; at <= text.length; at++)
        {
            const code = at < text.length ? text.charCodeAt(at) : 0;
            bytes[address + at * 2] = code & 0xff;
            bytes[address + at * 2 + 1] = code >> 8;
        }
    };
    const kernel32 = {
        GetFullPathNameW: {
            /** @param {number[]} args */
            handler: ([name, size, buffer])=>{
                const asked = readWideString(name, 0x1000).replace(/\//g, '\\');
                const full = /^[A-Za-z]:\\|^\\\\/.test(asked) ? asked : `C:\\GAME\\${asked}`;
                if (buffer === 0 || full.length + 1 > size)
                {
                    return full.length + 1;
                }
                putWide(buffer, full);
                return full.length;
            },
        },
    };
    const host = {
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            bytes.subarray(address, address + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ data)=>
            bytes.set(data, address),
        readWideString,
        kernel32,
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += (size + 7) & ~7;
            return at;
        },
        free: (/** @type {number} */ address)=>{
            freed.push(address);
            return true;
        },
    };
    /** @param {number} address */
    const dword = address=>new DataView(bytes.buffer).getUint32(address, true);
    /** The string a UNICODE_STRING at `address` holds, by its length. @param {number} address */
    const counted = address=>{
        const view = new DataView(bytes.buffer);
        const length = view.getUint16(address, true);
        let text = '';
        for (let at = 0; at < length; at += 2)
        {
            text += String.fromCharCode(view.getUint16(dword(address + 4) + at, true));
        }
        return { text, length, maximum: view.getUint16(address + 2, true) };
    };
    return { bytes, host, putWide, dword, counted, freed };
}

test('a DOS path becomes its \\??\\ name, allocated with room for the terminator', ()=>{
    const { host, putWide, dword, counted } = fakeHost();
    const fns = createPathFunctions(host);
    putWide(DOS, 'C:\\WINDOWS\\TEMP\\file.txt');

    assert.equal(fns.RtlDosPathNameToNtPathName_U.handler([DOS, NT, PART, RELATIVE]), 1);
    const name = counted(NT);
    assert.equal(name.text, '\\??\\C:\\WINDOWS\\TEMP\\file.txt');
    assert.equal(name.maximum, name.length + 2);
    assert.equal(dword(PART), dword(NT + 4) + '\\??\\C:\\WINDOWS\\TEMP\\'.length * 2,
        'the file part points at the last component inside the new buffer');
});

test('a relative path is resolved first, and a share becomes UNC', ()=>{
    const { host, putWide, counted } = fakeHost();
    const fns = createPathFunctions(host);

    putWide(DOS, 'data/save.dat');
    assert.equal(fns.RtlDosPathNameToNtPathName_U.handler([DOS, NT, 0, 0]), 1);
    assert.equal(counted(NT).text, '\\??\\C:\\GAME\\data\\save.dat');

    putWide(DOS, '\\\\server\\share\\file');
    assert.equal(fns.RtlDosPathNameToNtPathName_U.handler([DOS, NT, 0, 0]), 1);
    assert.equal(counted(NT).text, '\\??\\UNC\\server\\share\\file');

    putWide(DOS, '\\\\?\\C:\\as\\written\\..');
    assert.equal(fns.RtlDosPathNameToNtPathName_U.handler([DOS, NT, 0, 0]), 1);
    assert.equal(counted(NT).text, '\\??\\C:\\as\\written\\..', 'the \\\\?\\ form is not resolved');
});

test('an empty path is refused, as a BOOLEAN and as a status', ()=>{
    const { host, putWide } = fakeHost();
    const fns = createPathFunctions(host);
    putWide(DOS, '');
    assert.equal(fns.RtlDosPathNameToNtPathName_U.handler([DOS, NT, 0, 0]), 0);
    assert.equal(fns.RtlDosPathNameToNtPathName_U_WithStatus.handler([DOS, NT, 0, 0]) >>> 0,
        0xc0000033, 'STATUS_OBJECT_NAME_INVALID');
});

test('a directory path has no file part, and the relative name is cleared', ()=>{
    const { host, putWide, dword, bytes } = fakeHost();
    const fns = createPathFunctions(host);
    bytes.fill(0xcc, RELATIVE, RELATIVE + 16);
    putWide(DOS, 'C:\\GAME\\');
    assert.equal(fns.RtlDosPathNameToNtPathName_U.handler([DOS, NT, PART, RELATIVE]), 1);
    assert.equal(dword(PART), 0);
    assert.deepEqual([...bytes.subarray(RELATIVE, RELATIVE + 16)], new Array(16).fill(0));
});

test('the scratch buffer the resolution used goes back to the heap', ()=>{
    const { host, putWide, freed } = fakeHost();
    const fns = createPathFunctions(host);
    putWide(DOS, 'C:\\x');
    fns.RtlDosPathNameToNtPathName_U.handler([DOS, NT, 0, 0]);
    assert.equal(freed.length, 1);
});
