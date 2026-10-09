/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createRegistryService } from './registry-service.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY_NATIVES, USER_NAME, createRegistryFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';
import {
    createHive,
    HKEY_CLASSES_ROOT,
    HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE,
    REG_BINARY,
    REG_DWORD,
    REG_SZ,
} from './registry.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;

const REG_CREATED_NEW_KEY = 1;
const REG_OPENED_EXISTING_KEY = 2;

/** Addresses the fixtures use; nothing about them matters but that they differ. */
const SUBKEY = 0x100;
const NAME = 0x200;
// Above the never-mapped 64 KiB, where a value's data can come from.
const INPUT = 0x10300;
const OUT_HANDLE = 0x400;
const OUT_TYPE = 0x404;
const OUT_SIZE = 0x408;
const OUT_DISPOSITION = 0x40c;
const OUT_NAME_SIZE = 0x410;
const OUT_DATA = 0x500;
const OUT_NAME = 0x600;
const OUT_INFO = 0x700;

/**
 * Guest memory as a flat array. `readMemory` hands back a view rather than a
 * copy, exactly as the real memory layer may, so anything that stores what it
 * read has to say so.
 */
function fakeMemory(size = 0x11000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            // As the memory layer reads an ANSI string: in Windows-1252, which
            // is what the Encoding standard calls latin1.
            let end = address;
            while (end - address < maxLength && bytes[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(bytes.subarray(address, end));
        },
        /** @param {number} address @param {string} text */
        putString(address, text){
            for (let i = 0; i < text.length; i++)
            {
                bytes[address + i] = text.charCodeAt(i) & 0xff;
            }
            bytes[address + text.length] = 0;
        },
        /** @param {number} address @param {number} value */
        putDword(address, value){
            for (let i = 0; i < 4; i++)
            {
                bytes[address + i] = (value >>> (i * 8)) & 0xff;
            }
        },
        /** @param {number} address */
        dword(address){
            return (bytes[address] | (bytes[address + 1] << 8)
                | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0;
        },
        /** @param {number} address */
        string(address){
            return this.readCString(address, 0x100);
        },
    };
}

function setup(){
    const memory = fakeMemory();
    const hive = createRegistryService(createHive());
    const fns = createRegistryFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        hive,
    });

    /**
     * Creates a key under HKLM and returns the handle the guest would hold.
     *
     * @param {string} path @param {number} [disposition]
     */
    const create = (path, disposition = 0)=>{
        memory.putString(SUBKEY, path);
        const status = fns.RegCreateKeyExA.handler(
            [HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, 0, 0, 0, OUT_HANDLE, disposition]);
        assert.equal(status, ERROR_SUCCESS);
        return memory.dword(OUT_HANDLE);
    };

    /**
     * Sets a REG_SZ the way a guest does: strlen bytes, terminator included.
     *
     * @param {number} handle @param {string} name @param {string} text
     */
    const setString = (handle, name, text)=>{
        memory.putString(NAME, name);
        memory.putString(INPUT, text);
        return fns.RegSetValueExA.handler(
            [handle, NAME, 0, REG_SZ, INPUT, text.length + 1]);
    };

    return { memory, hive, fns, create, setString };
}

test('a key made and a value set through the wide calls read back through the narrow ones', ()=>{
    const { memory, fns } = setup();
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        for (let i = 0; i <= text.length; i++)
        {
            const code = i < text.length ? text.charCodeAt(i) : 0;
            memory.bytes[at + i * 2] = code & 0xff;
            memory.bytes[at + i * 2 + 1] = code >>> 8;
        }
    };
    putWide(SUBKEY, 'Software\\Vendor\\Wide');
    assert.equal(fns.RegCreateKeyExW.handler(
        [HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, 0, 0, 0, OUT_HANDLE, OUT_DISPOSITION]), ERROR_SUCCESS);
    assert.equal(memory.dword(OUT_DISPOSITION), 1, 'REG_CREATED_NEW_KEY');
    const key = memory.dword(OUT_HANDLE);

    // Text arrives as UTF-16 with its byte count; a binary value is untouched.
    putWide(NAME, 'InstallPath');
    putWide(INPUT, 'C:\\Games');
    assert.equal(fns.RegSetValueExW.handler([key, NAME, 0, REG_SZ, INPUT, 9 * 2]), ERROR_SUCCESS);
    memory.putString(NAME, 'installpath');
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegQueryValueExA.handler([key, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.dword(OUT_TYPE), REG_SZ);
    assert.equal(memory.string(OUT_DATA), 'C:\\Games');
    assert.equal(memory.dword(OUT_SIZE), 9);

    putWide(NAME, 'Flags');
    memory.putDword(INPUT, 0x01020304);
    assert.equal(fns.RegSetValueExW.handler([key, NAME, 0, REG_BINARY, INPUT, 4]), ERROR_SUCCESS);
    memory.putString(NAME, 'Flags');
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegQueryValueExA.handler([key, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.dword(OUT_DATA), 0x01020304);
    assert.deepEqual([fns.RegCreateKeyExW.argBytes, fns.RegSetValueExW.argBytes], [36, 24]);

    // And the W reads: the key opened by a wide name, the string answered wide,
    // its byte count doubled -- the terminator too, as it was stored.
    putWide(SUBKEY, 'Software\\Vendor\\Wide');
    assert.equal(fns.RegOpenKeyExW.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]),
        ERROR_SUCCESS);
    const opened = memory.dword(OUT_HANDLE);
    putWide(NAME, 'InstallPath');
    memory.putDword(OUT_SIZE, 0);
    assert.equal(fns.RegQueryValueExW.handler([opened, NAME, 0, OUT_TYPE, 0, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.dword(OUT_SIZE), 9 * 2, 'the room a wide copy needs');
    assert.equal(fns.RegQueryValueExW.handler([opened, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(String.fromCharCode(...new Uint16Array(
        memory.bytes.slice(OUT_DATA, OUT_DATA + 16).buffer)), 'C:\\Games');
    putWide(NAME, 'Flags');
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegQueryValueExW.handler([opened, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.dword(OUT_SIZE), 4, 'a binary value is not widened');
});

test('names and strings are kept in the ANSI page, whichever form set them', ()=>{
    // The hive keeps a string as the A calls read it. A key named, or a value
    // set by RegSetValueA, with 0x80, 0x99 and 0x97 -- the euro sign, the
    // trade mark and an em dash in Windows-1252 -- reads back as those bytes,
    // and a wide value with those characters is stored as WideCharToMultiByte
    // (CP_ACP) writes it, not as each unit's low byte.
    const { memory, fns, create } = setup();
    const key = create('Software\\Vendor');
    const text = [0x80, 0x99, 0x97, 0xe9];
    memory.bytes.set([...text, 0], SUBKEY);
    memory.bytes.set([...text, 0], INPUT);
    assert.equal(fns.RegSetValueA.handler([key, SUBKEY, REG_SZ, INPUT, 0]), ERROR_SUCCESS);
    assert.equal(fns.RegEnumKeyA.handler([key, 0, OUT_NAME, 64]), ERROR_SUCCESS);
    assert.deepEqual([...memory.bytes.subarray(OUT_NAME, OUT_NAME + 5)], [...text, 0]);
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegQueryValueA.handler([key, SUBKEY, OUT_DATA, OUT_SIZE]), ERROR_SUCCESS);
    assert.deepEqual([...memory.bytes.subarray(OUT_DATA, OUT_DATA + 5)], [...text, 0]);

    [...'€™—é\0'].forEach((character, at)=>{
        memory.bytes[INPUT + at * 2] = character.charCodeAt(0) & 0xff;
        memory.bytes[INPUT + at * 2 + 1] = character.charCodeAt(0) >>> 8;
    });
    memory.bytes.set([0x57, 0, 0, 0], NAME);
    assert.equal(fns.RegSetValueExW.handler([key, NAME, 0, REG_SZ, INPUT, 10]), ERROR_SUCCESS);
    memory.putString(NAME, 'W');
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegQueryValueExA.handler([key, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.deepEqual([...memory.bytes.subarray(OUT_DATA, OUT_DATA + 5)], [...text, 0]);
});

test('a key is created, reopened whatever its case, and read back', ()=>{
    const { memory, fns, create, setString } = setup();
    const created = create('Software\\Vendor\\Product');
    assert.equal(setString(created, 'InstallPath', 'C:\\Games'), ERROR_SUCCESS);

    memory.putString(SUBKEY, 'SOFTWARE\\vendor\\PRODUCT');
    assert.equal(
        fns.RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]),
        ERROR_SUCCESS);
    const opened = memory.dword(OUT_HANDLE);
    assert.notEqual(opened, created, 'a second open is a second handle');

    memory.putString(NAME, 'installpath');
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(
        fns.RegQueryValueExA.handler([opened, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.dword(OUT_TYPE), REG_SZ);
    assert.equal(memory.string(OUT_DATA), 'C:\\Games');
    assert.equal(memory.dword(OUT_SIZE), 9, 'the terminator is part of the size');
});

test('RegOpenKeyA is RegOpenKeyExA without the options nobody uses', ()=>{
    const { memory, fns, create } = setup();
    create('Software\\Vendor');

    memory.putString(SUBKEY, 'Software\\Vendor');
    assert.equal(fns.RegOpenKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY, OUT_HANDLE]), ERROR_SUCCESS);
    assert.notEqual(memory.dword(OUT_HANDLE), 0);
});

test('opening a key that is not there says so and does not leave a handle behind', ()=>{
    const { memory, fns } = setup();
    memory.putDword(OUT_HANDLE, 0xdeadbeef);
    memory.putString(SUBKEY, 'Software\\Absent');

    assert.equal(
        fns.RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]),
        ERROR_FILE_NOT_FOUND);
    assert.equal(memory.dword(OUT_HANDLE), 0, 'a caller that skips the check gets NULL, not junk');
});

test('creating reports whether the key was already there', ()=>{
    const { memory, create } = setup();

    create('Software\\Vendor', OUT_DISPOSITION);
    assert.equal(memory.dword(OUT_DISPOSITION), REG_CREATED_NEW_KEY);

    create('SOFTWARE\\VENDOR', OUT_DISPOSITION);
    assert.equal(memory.dword(OUT_DISPOSITION), REG_OPENED_EXISTING_KEY);
});

test('a query with no buffer reports the size, and does not need one', ()=>{
    const { memory, fns, create, setString } = setup();
    const key = create('Software\\Test');
    setString(key, 'Path', 'abcd');

    // The first of the two calls well-behaved code makes.
    memory.putString(NAME, 'Path');
    memory.putDword(OUT_SIZE, 0);
    assert.equal(
        fns.RegQueryValueExA.handler([key, NAME, 0, OUT_TYPE, 0, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.dword(OUT_SIZE), 5);
    assert.equal(memory.dword(OUT_TYPE), REG_SZ, 'the type is known before the data is fetched');

    // And the second, now that the caller knows how much room to leave.
    memory.putDword(OUT_SIZE, 5);
    assert.equal(
        fns.RegQueryValueExA.handler([key, NAME, 0, 0, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.string(OUT_DATA), 'abcd');
    assert.equal(memory.dword(OUT_SIZE), 5);
});

test('a buffer one byte short is ERROR_MORE_DATA with the size that would fit', ()=>{
    const { memory, fns, create, setString } = setup();
    const key = create('Software\\Test');
    setString(key, 'Path', 'abcd');

    memory.putString(NAME, 'Path');
    memory.putDword(OUT_SIZE, 4); // room for the text but not its terminator
    assert.equal(
        fns.RegQueryValueExA.handler([key, NAME, 0, 0, OUT_DATA, OUT_SIZE]),
        ERROR_MORE_DATA);
    assert.equal(memory.dword(OUT_SIZE), 5);
    assert.equal(memory.bytes[OUT_DATA], 0, 'nothing is written into a buffer that cannot hold it');
});

test('asking for data without a size is the one combination that is refused', ()=>{
    const { memory, fns, create, setString } = setup();
    const key = create('Software\\Test');
    setString(key, 'Path', 'abcd');
    memory.putString(NAME, 'Path');

    assert.equal(
        fns.RegQueryValueExA.handler([key, NAME, 0, 0, OUT_DATA, 0]),
        ERROR_INVALID_PARAMETER);
    assert.equal(
        fns.RegQueryValueExA.handler([key, NAME, 0, OUT_TYPE, 0, 0]),
        ERROR_SUCCESS,
        'neither buffer nor size is a test for existence, and it succeeds');
});

test('a value that is not there is ERROR_FILE_NOT_FOUND, buffer or no buffer', ()=>{
    const { memory, fns, create } = setup();
    const key = create('Software\\Test');
    memory.putString(NAME, 'Absent');
    memory.putDword(OUT_SIZE, 0x40);

    assert.equal(
        fns.RegQueryValueExA.handler([key, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_FILE_NOT_FOUND);
    assert.equal(
        fns.RegQueryValueExA.handler([key, NAME, 0, 0, 0, OUT_SIZE]),
        ERROR_FILE_NOT_FOUND);
});

test('the unnamed default value is the one with no name', ()=>{
    const { memory, fns, hive, create } = setup();
    const key = create('Software\\Vendor');

    memory.putString(INPUT, 'default');
    assert.equal(
        fns.RegSetValueExA.handler([key, 0, 0, REG_SZ, INPUT, 8]),
        ERROR_SUCCESS,
        'a NULL name is legal and means the default');

    const stored = hive.open(
        /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), 'Software\\Vendor');
    assert.equal(/** @type {any} */ (hive.getValue(/** @type {any} */ (stored), '')).name, '');

    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(
        fns.RegQueryValueExA.handler([key, 0, 0, 0, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.string(OUT_DATA), 'default');
});

test('what a value was written from can change without changing the value', ()=>{
    const { memory, fns, create } = setup();
    const key = create('Software\\Test');
    memory.putString(NAME, 'Blob');
    memory.bytes.set([1, 2, 3, 4], INPUT);

    fns.RegSetValueExA.handler([key, NAME, 0, REG_BINARY, INPUT, 4]);
    memory.bytes.set([9, 9, 9, 9], INPUT);

    memory.putDword(OUT_SIZE, 4);
    fns.RegQueryValueExA.handler([key, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]);
    assert.deepEqual([...memory.bytes.subarray(OUT_DATA, OUT_DATA + 4)], [1, 2, 3, 4]);
    assert.equal(memory.dword(OUT_TYPE), REG_BINARY);
});

test('a closed handle is an error code, and the roots never close', ()=>{
    const { memory, fns, create } = setup();
    const key = create('Software\\Test');

    assert.equal(fns.RegCloseKey.handler([key]), ERROR_SUCCESS);
    assert.equal(fns.RegCloseKey.handler([key]), ERROR_INVALID_HANDLE, 'closing twice fails');

    memory.putString(NAME, 'Path');
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(
        fns.RegQueryValueExA.handler([key, NAME, 0, 0, OUT_DATA, OUT_SIZE]),
        ERROR_INVALID_HANDLE);
    assert.equal(
        fns.RegSetValueExA.handler([key, NAME, 0, REG_SZ, INPUT, 1]),
        ERROR_INVALID_HANDLE);
    assert.equal(
        fns.RegEnumKeyExA.handler([key, 0, OUT_NAME, OUT_NAME_SIZE, 0, 0, 0, 0]),
        ERROR_INVALID_HANDLE);
    assert.equal(fns.RegQueryInfoKeyA.handler(
        [key, 0, 0, 0, OUT_INFO, 0, 0, 0, 0, 0, 0, 0]), ERROR_INVALID_HANDLE);

    assert.equal(fns.RegCloseKey.handler([HKEY_CURRENT_USER]), ERROR_SUCCESS);
    assert.equal(
        fns.RegCreateKeyExA.handler([HKEY_CURRENT_USER, 0, 0, 0, 0, 0, 0, OUT_HANDLE, 0]),
        ERROR_SUCCESS,
        'a root is still a root after a guest closes it');
});

test('a handle nobody was given is an error code, not a crash', ()=>{
    const { memory, fns } = setup();
    memory.putDword(OUT_SIZE, 0x40);

    assert.equal(fns.RegCloseKey.handler([0x9999]), ERROR_INVALID_HANDLE);
    assert.equal(
        fns.RegOpenKeyExA.handler([0x9999, SUBKEY, 0, 0, OUT_HANDLE]),
        ERROR_INVALID_HANDLE);
    assert.equal(fns.RegDeleteValueA.handler([0x9999, NAME]), ERROR_INVALID_HANDLE);
    assert.equal(fns.RegDeleteKeyA.handler([0x9999, SUBKEY]), ERROR_INVALID_HANDLE);
    assert.equal(
        fns.RegEnumValueA.handler([0x9999, 0, OUT_NAME, OUT_NAME_SIZE, 0, 0, 0, 0]),
        ERROR_INVALID_HANDLE);
});

test('keys enumerate in a stable order and then run out', ()=>{
    const { memory, fns, create } = setup();
    const key = create('Software\\Test');
    create('Software\\Test\\Beta');
    create('Software\\Test\\Alpha');

    const names = [];
    for (let index = 0; ; index++)
    {
        memory.putDword(OUT_NAME_SIZE, 0x40);
        const status = fns.RegEnumKeyExA.handler(
            [key, index, OUT_NAME, OUT_NAME_SIZE, 0, 0, 0, OUT_INFO]);
        if (status === ERROR_NO_MORE_ITEMS)
        {
            break;
        }
        assert.equal(status, ERROR_SUCCESS);
        names.push(memory.string(OUT_NAME));
        assert.equal(memory.dword(OUT_NAME_SIZE), memory.string(OUT_NAME).length,
            'the length that comes back excludes the terminator that went out');
    }

    assert.deepEqual(names, ['Beta', 'Alpha']);

    // Asked again, in the same order: an index means the same thing twice.
    memory.putDword(OUT_NAME_SIZE, 0x40);
    fns.RegEnumKeyExA.handler([key, 0, OUT_NAME, OUT_NAME_SIZE, 0, 0, 0, 0]);
    assert.equal(memory.string(OUT_NAME), 'Beta');
});

test('an enumeration name buffer that is one character short is ERROR_MORE_DATA', ()=>{
    const { memory, fns, create } = setup();
    const key = create('Software\\Test');
    create('Software\\Test\\Beta');

    // Four characters and no room for the terminator: the classic off-by-one.
    memory.putDword(OUT_NAME_SIZE, 4);
    assert.equal(
        fns.RegEnumKeyExA.handler([key, 0, OUT_NAME, OUT_NAME_SIZE, 0, 0, 0, 0]),
        ERROR_MORE_DATA);

    memory.putDword(OUT_NAME_SIZE, 5);
    assert.equal(
        fns.RegEnumKeyExA.handler([key, 0, OUT_NAME, OUT_NAME_SIZE, 0, 0, 0, 0]),
        ERROR_SUCCESS);
    assert.equal(memory.string(OUT_NAME), 'Beta');
});

test('an enumeration with nowhere to put the name is refused', ()=>{
    const { fns, create } = setup();
    const key = create('Software\\Test');
    create('Software\\Test\\Beta');

    assert.equal(
        fns.RegEnumKeyExA.handler([key, 0, 0, OUT_NAME_SIZE, 0, 0, 0, 0]),
        ERROR_INVALID_PARAMETER);
    assert.equal(
        fns.RegEnumKeyExA.handler([key, 0, OUT_NAME, 0, 0, 0, 0, 0]),
        ERROR_INVALID_PARAMETER);
});

test('values enumerate with their type and data, and then run out', ()=>{
    const { memory, fns, create, setString } = setup();
    const key = create('Software\\Test');
    setString(key, 'First', 'abcd');
    memory.bytes.set([7, 0, 0, 0], INPUT);
    memory.putString(NAME, 'Second');
    fns.RegSetValueExA.handler([key, NAME, 0, REG_DWORD, INPUT, 4]);

    memory.putDword(OUT_NAME_SIZE, 0x40);
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(
        fns.RegEnumValueA.handler(
            [key, 0, OUT_NAME, OUT_NAME_SIZE, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.string(OUT_NAME), 'First');
    assert.equal(memory.dword(OUT_NAME_SIZE), 5);
    assert.equal(memory.dword(OUT_TYPE), REG_SZ);
    assert.equal(memory.dword(OUT_SIZE), 5, 'bytes, terminator included');
    assert.equal(memory.string(OUT_DATA), 'abcd');

    memory.putDword(OUT_NAME_SIZE, 0x40);
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(
        fns.RegEnumValueA.handler(
            [key, 1, OUT_NAME, OUT_NAME_SIZE, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.string(OUT_NAME), 'Second');
    assert.equal(memory.dword(OUT_TYPE), REG_DWORD);
    assert.equal(memory.dword(OUT_SIZE), 4);

    memory.putDword(OUT_NAME_SIZE, 0x40);
    assert.equal(
        fns.RegEnumValueA.handler([key, 2, OUT_NAME, OUT_NAME_SIZE, 0, 0, 0, 0]),
        ERROR_NO_MORE_ITEMS);
});

test('an enumerated value reports the data size it needed', ()=>{
    const { memory, fns, create, setString } = setup();
    const key = create('Software\\Test');
    setString(key, 'First', 'abcd');

    memory.putDword(OUT_NAME_SIZE, 0x40);
    memory.putDword(OUT_SIZE, 2);
    assert.equal(
        fns.RegEnumValueA.handler([key, 0, OUT_NAME, OUT_NAME_SIZE, 0, 0, OUT_DATA, OUT_SIZE]),
        ERROR_MORE_DATA);
    assert.equal(memory.dword(OUT_SIZE), 5, 'unlike the name half, this one says how much');

    // Sizing without a buffer works here too.
    memory.putDword(OUT_NAME_SIZE, 0x40);
    memory.putDword(OUT_SIZE, 0);
    assert.equal(
        fns.RegEnumValueA.handler([key, 0, OUT_NAME, OUT_NAME_SIZE, 0, 0, 0, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.dword(OUT_SIZE), 5);
});

test('RegQueryInfoKeyA is where the enumerators buffer sizes come from', ()=>{
    const { memory, fns, create, setString } = setup();
    const key = create('Software\\Test');
    create('Software\\Test\\Beta');
    create('Software\\Test\\LongerName');
    setString(key, 'First', 'abcd');
    setString(key, 'SecondValue', 'a longer string');

    const subKeys = OUT_INFO;
    const maxSubKeyLen = OUT_INFO + 4;
    const valueCount = OUT_INFO + 8;
    const maxValueNameLen = OUT_INFO + 12;
    const maxValueLen = OUT_INFO + 16;
    assert.equal(
        fns.RegQueryInfoKeyA.handler([key, 0, 0, 0, subKeys, maxSubKeyLen, 0, valueCount,
            maxValueNameLen, maxValueLen, 0, 0]),
        ERROR_SUCCESS);

    assert.equal(memory.dword(subKeys), 2);
    assert.equal(memory.dword(maxSubKeyLen), 'LongerName'.length, 'characters, no terminator');
    assert.equal(memory.dword(valueCount), 2);
    assert.equal(memory.dword(maxValueNameLen), 'SecondValue'.length);
    assert.equal(memory.dword(maxValueLen), 'a longer string'.length + 1, 'bytes, terminator too');
});

test('RegQueryInfoKeyA on an empty key answers zero rather than nothing', ()=>{
    const { memory, fns, create } = setup();
    const key = create('Software\\Test');
    memory.putDword(OUT_INFO, 0xdeadbeef);
    memory.putDword(OUT_INFO + 4, 0xdeadbeef);

    assert.equal(
        fns.RegQueryInfoKeyA.handler(
            [key, 0, 0, 0, OUT_INFO, OUT_INFO + 4, 0, 0, 0, 0, 0, 0]),
        ERROR_SUCCESS);
    assert.equal(memory.dword(OUT_INFO), 0);
    assert.equal(memory.dword(OUT_INFO + 4), 0);
});

test('deleting a value reports whether there was one to delete', ()=>{
    const { memory, fns, create, setString } = setup();
    const key = create('Software\\Test');
    setString(key, 'Path', 'x');

    memory.putString(NAME, 'PATH');
    assert.equal(fns.RegDeleteValueA.handler([key, NAME]), ERROR_SUCCESS, 'case is no obstacle');
    assert.equal(fns.RegDeleteValueA.handler([key, NAME]), ERROR_FILE_NOT_FOUND);
});

test('a key with subkeys is refused, not deleted', ()=>{
    const { memory, fns, create } = setup();
    create('Software\\Vendor\\Product');

    memory.putString(SUBKEY, 'Software\\Vendor');
    assert.equal(
        fns.RegDeleteKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY]),
        ERROR_ACCESS_DENIED,
        'NT deletes one key, never a tree');

    memory.putString(SUBKEY, 'Software\\Vendor\\PRODUCT');
    assert.equal(fns.RegDeleteKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY]), ERROR_SUCCESS);

    memory.putString(SUBKEY, 'Software\\Vendor');
    assert.equal(fns.RegDeleteKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY]), ERROR_SUCCESS);
    assert.equal(fns.RegDeleteKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY]), ERROR_FILE_NOT_FOUND);
});

test('a delete that names no subkey is refused', ()=>{
    // advapi32's registry tests: RegDeleteKeyA(key, NULL) is ERROR_INVALID_PARAMETER.
    const { fns, create } = setup();
    const key = create('Software\\Test');
    assert.equal(fns.RegDeleteKeyA.handler([key, 0]), ERROR_INVALID_PARAMETER);
});

test('what a guest writes through this surface is what the hive holds', ()=>{
    const { hive, create, setString } = setup();
    const key = create('Software\\Vendor');
    setString(key, 'InstallPath', 'C:\\Games');

    const stored = /** @type {any} */ (hive.open(
        /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), 'software\\vendor'));
    const value = /** @type {any} */ (hive.getValue(stored, 'installpath'));
    assert.equal(value.type, REG_SZ);
    assert.equal(value.data.length, 9);
});

test('every function declares the stack it pops', ()=>{
    const { fns } = setup();
    // stdcall: the callee cleans up, so a wrong count corrupts the guest stack
    // silently. These are the documented signatures, four bytes per argument.
    assert.equal(fns.RegOpenKeyExA.argBytes, 20);
    assert.equal(fns.RegOpenKeyA.argBytes, 12);
    assert.equal(fns.RegCreateKeyExA.argBytes, 36);
    assert.equal(fns.RegCloseKey.argBytes, 4);
    assert.equal(fns.RegQueryValueExA.argBytes, 24);
    assert.equal(fns.RegSetValueExA.argBytes, 24);
    assert.equal(fns.RegDeleteValueA.argBytes, 8);
    assert.equal(fns.RegDeleteKeyA.argBytes, 8);
    assert.equal(fns.RegEnumKeyExA.argBytes, 32);
    assert.equal(fns.RegEnumValueA.argBytes, 32);
    assert.equal(fns.RegQueryInfoKeyA.argBytes, 48);
});

test('flushing a key that was closed is refused, not quietly accepted', ()=>{
    // There is nothing to write to a disk here, so the only thing this call can
    // still tell a caller is whether the handle it is holding is real. Saying
    // yes to a stale one throws that away.
    const { fns, create } = setup();
    const key = create('Software\\Test');

    assert.equal(fns.RegFlushKey.handler([key]), ERROR_SUCCESS);
    fns.RegCloseKey.handler([key]);
    assert.equal(fns.RegFlushKey.handler([key]), ERROR_INVALID_HANDLE);
});

test('the user name is reported with a length that counts the terminator', ()=>{
    // This one differs from the enumerators above and from GetComputerName:
    // the size that comes back includes the null. A caller that sizes its next
    // allocation from a count that excluded it is one byte short every time.
    const { memory, fns } = setup();
    memory.putDword(OUT_SIZE, 0x100);

    assert.equal(fns.GetUserNameA.handler([OUT_NAME, OUT_SIZE]), 1);
    const name = memory.string(OUT_NAME);
    assert.ok(name.length > 0);
    assert.equal(memory.dword(OUT_SIZE), name.length + 1);

    memory.putDword(OUT_SIZE, 0x100);
    assert.equal(fns.GetUserNameW.handler([OUT_NAME, OUT_SIZE]), 1);
    assert.equal(memory.dword(OUT_SIZE), name.length + 1, 'the wide one counts characters');
    assert.equal(String.fromCharCode(...new Uint16Array(
        memory.bytes.slice(OUT_NAME, OUT_NAME + name.length * 2).buffer)), name);
});

test('too small a buffer is refused, and the size needed is written back', ()=>{
    // The whole point of the failure: a caller calls twice, sizes from the
    // first answer, and a wrong number there sends it round for ever or
    // truncates the name it finally gets.
    const { memory, fns } = setup();
    memory.putDword(OUT_SIZE, 1);

    assert.equal(fns.GetUserNameA.handler([OUT_NAME, OUT_SIZE]), 0);
    const needed = memory.dword(OUT_SIZE);
    assert.ok(needed > 1);

    memory.putDword(OUT_SIZE, needed);
    assert.equal(fns.GetUserNameA.handler([OUT_NAME, OUT_SIZE]), 1,
        'and the size it asked for is enough');
});

test('no size pointer at all is a refusal rather than a write to address zero', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetUserNameA.handler([OUT_NAME, 0]), 0);
});

test('a SID is built in guest memory in the layout a program compares byte by byte', ()=>{
    const memory = fakeMemory();
    let next = 0x800;
    /** @type {number[]} */
    const errors = [];
    const fns = createRegistryFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        hive: createRegistryService(createHive()),
        allocate: bytes=>{
            const at = next;
            next += bytes;
            return at;
        },
        setLastError: code=>errors.push(code),
    });
    // SECURITY_NT_AUTHORITY, and the two sub-authorities of the Administrators group.
    memory.bytes.set([0, 0, 0, 0, 0, 5], 0x100);

    assert.equal(fns.AllocateAndInitializeSid.handler(
        [0x100, 2, 32, 544, 0, 0, 0, 0, 0, 0, OUT_HANDLE]), 1);
    const sid = memory.dword(OUT_HANDLE);
    assert.deepEqual([...memory.bytes.slice(sid, sid + 16)],
        [1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 0x02, 0, 0]);
    assert.equal(fns.FreeSid.handler(), 0, 'NULL is success');
    assert.equal(fns.FreeSid.argBytes, 4, 'it still pops the SID it was given');

    assert.equal(fns.AllocateAndInitializeSid.handler(
        [0x100, 9, 0, 0, 0, 0, 0, 0, 0, 0, OUT_HANDLE]), 0, 'nine sub-authorities do not fit');
    assert.deepEqual(errors, [1337], 'ERROR_INVALID_SID');
});

test('a build with nowhere to put a SID says it ran out of memory rather than faulting', ()=>{
    const { fns } = setup();
    assert.equal(fns.AllocateAndInitializeSid.handler(
        [0x100, 1, 18, 0, 0, 0, 0, 0, 0, 0, OUT_HANDLE]), 0);
});

test('the wide file security calls are refused like the narrow ones, popping what they took', ()=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errors = [];
    const fns = createRegistryFunctions({
        readMemory: memory.readMemory, writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        hive: createRegistryService(createHive()), setLastError: code=>errors.push(code),
    });

    assert.equal(fns.SetFileSecurityW.handler(), 0);
    assert.deepEqual(errors, [120], 'ERROR_CALL_NOT_IMPLEMENTED');
    assert.equal(fns.SetFileSecurityW.argBytes, 12);
    assert.equal(fns.GetFileSecurityW.handler(), 0);
    assert.deepEqual(errors, [120, 120], 'and asking for a descriptor is not implemented either');
    assert.equal(fns.GetFileSecurityW.argBytes, 20);
});

test('the file security calls refuse plainly', ()=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errors = [];
    const fns = createRegistryFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        hive: createRegistryService(createHive()),
        setLastError: code=>errors.push(code),
    });
    const ERROR_CALL_NOT_IMPLEMENTED = 120;
    const expected = { GetFileSecurityA: 20, SetFileSecurityA: 12 };
    const table = /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (fns));
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(table[name].argBytes, argBytes, name);
        assert.equal(table[name].handler([]), 0, name);
    }
    assert.deepEqual(errors, Object.keys(expected).map(()=>ERROR_CALL_NOT_IMPLEMENTED));
});

test('a restart is not implemented, as the consumer line answered, and says so', ()=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const diverged = [];
    const fns = /** @type {Record<string, any>} */ (/** @type {unknown} */ (createRegistryFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        hive: createRegistryService(createHive()),
        setLastError: code=>errors.push(code),
        divergence: api=>diverged.push(api),
    })));
    const expected = { InitiateSystemShutdownA: 20, InitiateSystemShutdownW: 20,
        InitiateSystemShutdownExA: 24, InitiateSystemShutdownExW: 24 };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(fns[name].argBytes, argBytes, name);
        assert.equal(fns[name].handler([0, 0, 0, 1, 1]), 0, name);
    }
    assert.deepEqual(errors, [120, 120, 120, 120], 'ERROR_CALL_NOT_IMPLEMENTED');
    assert.deepEqual(diverged, Object.keys(expected));
});

test('RegEnumKeyA is the enumeration with a buffer and a size and nothing else', ()=>{
    const { memory, fns, create } = setup();
    create('SOFTWARE\\Vendor\\B');
    create('SOFTWARE\\Vendor\\A');
    memory.putString(SUBKEY, 'SOFTWARE\\Vendor');
    assert.equal(fns.RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]), 0);
    const key = memory.dword(OUT_HANDLE);

    assert.equal(fns.RegEnumKeyA.handler([key, 0, OUT_NAME, 64]), ERROR_SUCCESS);
    const first = memory.readCString(OUT_NAME, 64);
    assert.equal(fns.RegEnumKeyA.handler([key, 1, OUT_NAME, 64]), ERROR_SUCCESS);
    assert.deepEqual([first, memory.readCString(OUT_NAME, 64)].sort(), ['A', 'B']);
    assert.equal(fns.RegEnumKeyA.handler([key, 2, OUT_NAME, 64]), ERROR_NO_MORE_ITEMS);
    assert.equal(fns.RegEnumKeyA.handler([key, 0, OUT_NAME, 1]), ERROR_MORE_DATA,
        'no room for the terminator');
    assert.equal(fns.RegEnumKeyA.argBytes, 16);
});

/**
 * The classes root and the two keys it is a view of, as registry.c's
 * test_classesroot drives them.
 *
 * @param {ReturnType<typeof setup>} machine
 */
function classes(machine){
    const { memory, fns } = machine;
    /** @param {number} root @param {string} path */
    const createUnder = (root, path)=>{
        memory.putString(SUBKEY, path);
        assert.equal(fns.RegCreateKeyExA.handler(
            [root, SUBKEY, 0, 0, 0, 0, 0, OUT_HANDLE, 0]), ERROR_SUCCESS, path);
        return memory.dword(OUT_HANDLE);
    };
    /** @param {number} root @param {string} path */
    const open = (root, path)=>{
        memory.putString(SUBKEY, path);
        const status = fns.RegOpenKeyExA.handler([root, SUBKEY, 0, 0, OUT_HANDLE]);
        return status === ERROR_SUCCESS ? memory.dword(OUT_HANDLE) : -status;
    };
    /** @param {number} key @param {string} name */
    const read = (key, name)=>{
        memory.putString(NAME, name);
        memory.putDword(OUT_SIZE, 0x40);
        const status = fns.RegQueryValueExA.handler([key, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]);
        return status === ERROR_SUCCESS ? memory.string(OUT_DATA) : status;
    };
    /** @param {number} key @param {string} path */
    const remove = (key, path)=>{
        memory.putString(SUBKEY, path);
        return fns.RegDeleteKeyA.handler([key, SUBKEY]);
    };
    /** @param {number} key */
    const subkeys = key=>{
        const names = [];
        for (let index = 0; fns.RegEnumKeyA.handler([key, index, OUT_NAME, 64]) === 0; index++)
        {
            names.push(memory.readCString(OUT_NAME, 64));
        }
        return names;
    };
    return { createUnder, open, read, remove, subkeys };
}

test('a class the machine registers is found under the classes root, both ways', ()=>{
    // registry.c test_classesroot: HKEY_CLASSES_ROOT is not a hive of its own
    // but HKLM\Software\Classes, so a key and its values written through
    // either name are the same key and the same values.
    const machine = setup();
    const { setString } = machine;
    const { createUnder, open, read } = classes(machine);

    const hklm = createUnder(HKEY_LOCAL_MACHINE, 'Software\\Classes\\WineTestCls');
    const hkcr = open(HKEY_CLASSES_ROOT, 'WineTestCls');
    assert.ok(hkcr > 0, 'the machine class is found under HKEY_CLASSES_ROOT');

    assert.equal(setString(hklm, 'val2', 'hklm'), ERROR_SUCCESS);
    assert.equal(read(hkcr, 'val2'), 'hklm');
    assert.equal(setString(hkcr, 'val2', 'hkcr'), ERROR_SUCCESS);
    assert.equal(read(hklm, 'val2'), 'hkcr',
        'written through the classes root, read through the machine');

    // A class a program registers under the classes root is the machine's.
    createUnder(HKEY_CLASSES_ROOT, 'CLSID\\{00000000-0000-0000-0000-00000000C0DE}\\InprocServer32');
    assert.ok(open(HKEY_LOCAL_MACHINE,
        'SOFTWARE\\Classes\\CLSID\\{00000000-0000-0000-0000-00000000C0DE}\\InprocServer32') > 0);
});

test('the user\'s classes lie over the machine\'s under the classes root', ()=>{
    const machine = setup();
    const { setString } = machine;
    const { createUnder, open, read, remove, subkeys } = classes(machine);

    const hklm = createUnder(HKEY_LOCAL_MACHINE, 'Software\\Classes\\WineTestCls');
    assert.equal(setString(hklm, 'val2', 'hklm'), ERROR_SUCCESS);
    assert.equal(setString(hklm, 'machineOnly', 'm'), ERROR_SUCCESS);
    const user = createUnder(HKEY_CURRENT_USER, 'Software\\Classes\\WineTestCls');
    const hkcr = open(HKEY_CLASSES_ROOT, 'WineTestCls');

    // A value the user's key has wins; a write through the classes root goes
    // to the user's key, and the machine's keeps what it had.
    assert.equal(setString(user, 'val2', 'user'), ERROR_SUCCESS);
    assert.equal(read(hkcr, 'val2'), 'user');
    assert.equal(setString(hklm, 'val2', 'hklm'), ERROR_SUCCESS);
    assert.equal(read(hkcr, 'val2'), 'user', 'the machine does not overwrite the user');
    assert.equal(setString(hkcr, 'val2', 'hkcr'), ERROR_SUCCESS);
    assert.equal(read(user, 'val2'), 'hkcr');
    assert.equal(read(hklm, 'val2'), 'hklm');
    assert.equal(read(hkcr, 'machineOnly'), 'm', 'what only the machine has still shows');

    // A subkey the machine has is reached through the classes root; a new one
    // made through it is the machine's.
    const hklmSub = createUnder(hklm, 'subkey1');
    assert.equal(setString(hklmSub, 'subval1', 'hklm'), ERROR_SUCCESS);
    const hkcrSub = open(hkcr, 'subkey1');
    assert.ok(hkcrSub > 0);
    assert.equal(read(hkcrSub, 'subval1'), 'hklm');
    const userSub = createUnder(user, 'subkey1');
    assert.equal(setString(userSub, 'subval1', 'user'), ERROR_SUCCESS);
    assert.equal(read(hkcrSub, 'subval1'), 'user');
    createUnder(hkcr, 'subkey2');
    assert.equal(open(user, 'subkey2'), -ERROR_FILE_NOT_FOUND, 'not made in the user\'s classes');
    assert.ok(open(hklm, 'subkey2') > 0, 'but in the machine\'s');
    assert.deepEqual(subkeys(hkcr), ['subkey1', 'subkey2'], 'one name for a key both have');

    // Deleting through the classes root takes the user's key first.
    assert.equal(remove(hkcr, 'subkey1'), ERROR_SUCCESS);
    assert.equal(open(user, 'subkey1'), -ERROR_FILE_NOT_FOUND);
    assert.ok(open(hklm, 'subkey1') > 0);
    assert.equal(remove(hkcr, 'subkey1'), ERROR_SUCCESS);
    assert.equal(open(hklm, 'subkey1'), -ERROR_FILE_NOT_FOUND);
    assert.equal(remove(hkcr, 'subkey1'), ERROR_FILE_NOT_FOUND);
});

/**
 * Plants UTF-16 text where a W call reads it.
 *
 * @param {any} memory @param {number} at @param {string} text
 */
function plantWide(memory, at, text){
    for (let i = 0; i <= text.length; i++)
    {
        const code = i < text.length ? text.charCodeAt(i) : 0;
        memory.bytes[at + i * 2] = code & 0xff;
        memory.bytes[at + i * 2 + 1] = code >>> 8;
    }
    return at;
}

/** @param {any} memory @param {number} at */
function wideAt(memory, at){
    let text = '';
    for (let i = at; memory.bytes[i] !== 0 || memory.bytes[i + 1] !== 0; i += 2)
    {
        text += String.fromCharCode(memory.bytes[i] | memory.bytes[i + 1] << 8);
    }
    return text;
}

test('RegSetValueW and RegQueryValueW are the default string of a subkey, in wide text', ()=>{
    // advapi32's registry tests: only REG_SZ, to the first NUL whatever the size.
    const { memory, fns, create } = setup();
    const key = create('Software\\Wide');
    plantWide(memory, SUBKEY, 'Sub');
    plantWide(memory, INPUT, 'This\0Breaks');
    assert.equal(fns.RegSetValueW.handler([key, SUBKEY, REG_SZ, INPUT, 8]), ERROR_SUCCESS);
    assert.equal(fns.RegSetValueW.handler([key, SUBKEY, REG_BINARY, INPUT, 8]),
        ERROR_INVALID_PARAMETER);
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegQueryValueW.handler([key, SUBKEY, OUT_DATA, OUT_SIZE]), ERROR_SUCCESS);
    assert.equal(wideAt(memory, OUT_DATA), 'This');
    assert.equal(memory.dword(OUT_SIZE), 10, 'bytes, the terminator counted');
    memory.putString(SUBKEY, 'Sub');
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegQueryValueA.handler([key, SUBKEY, OUT_DATA, OUT_SIZE]), ERROR_SUCCESS);
    assert.equal(memory.string(OUT_DATA), 'This', 'and the narrow read finds it');
});

test('an enumerated value too long for either buffer writes nothing but its size', ()=>{
    // advapi32's registry tests: on ERROR_MORE_DATA the name and its count are
    // left as they were, and the data's size is what it needs.
    const { memory, fns, create, setString } = setup();
    const key = create('Software\\Enum');
    setString(key, 'Test', 'foobar');
    memory.putString(OUT_NAME, 'xxxxxxxx');
    memory.putDword(OUT_NAME_SIZE, 20);
    memory.putDword(OUT_SIZE, 2);
    assert.equal(fns.RegEnumValueA.handler(
        [key, 0, OUT_NAME, OUT_NAME_SIZE, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]), ERROR_MORE_DATA);
    assert.equal(memory.dword(OUT_NAME_SIZE), 20);
    assert.equal(memory.string(OUT_NAME), 'xxxxxxxx');
    assert.equal(memory.dword(OUT_SIZE), 7);
    assert.equal(memory.dword(OUT_TYPE), REG_SZ);

    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegEnumValueW.handler(
        [key, 0, OUT_NAME, OUT_NAME_SIZE, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]), ERROR_SUCCESS);
    assert.equal(wideAt(memory, OUT_NAME), 'Test');
    assert.equal(memory.dword(OUT_NAME_SIZE), 4);
    assert.equal(wideAt(memory, OUT_DATA), 'foobar');
    assert.equal(memory.dword(OUT_SIZE), 14, 'the string answered wide');
});

test('RegGetValue holds the value to the types it is asked for', ()=>{
    // advapi32's registry tests: a type outside the mask is
    // ERROR_UNSUPPORTED_TYPE with everything still answered, a four-byte
    // binary value is a DWORD and an eight-byte one is not.
    const { memory, fns, create } = setup();
    const key = create('Software\\Get');
    memory.putString(NAME, 'DWORD');
    memory.putDword(INPUT, 0x12345678);
    fns.RegSetValueExA.handler([key, NAME, 0, REG_DWORD, INPUT, 4]);
    memory.putString(NAME + 0x20, 'BIN64');
    fns.RegSetValueExA.handler([key, NAME + 0x20, 0, REG_BINARY, INPUT, 8]);
    const RRF_RT_REG_DWORD = 0x10;
    const RRF_RT_REG_BINARY = 0x08;
    const RRF_RT_DWORD = 0x18;
    const RRF_RT_QWORD = 0x48;

    assert.equal(fns.RegGetValueA.handler([key, 0, NAME, RRF_RT_REG_DWORD, OUT_TYPE, OUT_DATA, 0]),
        ERROR_INVALID_PARAMETER, 'data with no size');
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegGetValueA.handler(
        [key, 0, NAME, RRF_RT_REG_DWORD, OUT_TYPE, OUT_DATA, OUT_SIZE]), ERROR_SUCCESS);
    assert.deepEqual([memory.dword(OUT_TYPE), memory.dword(OUT_DATA), memory.dword(OUT_SIZE)],
        [REG_DWORD, 0x12345678, 4]);
    memory.putDword(OUT_DATA, 0);
    assert.equal(fns.RegGetValueA.handler(
        [key, 0, NAME, RRF_RT_REG_BINARY, OUT_TYPE, OUT_DATA, OUT_SIZE]), 1630);
    assert.equal(memory.dword(OUT_DATA), 0x12345678, 'answered all the same');
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegGetValueA.handler(
        [key, 0, NAME + 0x20, RRF_RT_DWORD, OUT_TYPE, OUT_DATA, OUT_SIZE]), 1629);
    memory.putDword(OUT_SIZE, 0x40);
    assert.equal(fns.RegGetValueA.handler(
        [key, 0, NAME + 0x20, RRF_RT_QWORD, OUT_TYPE, OUT_DATA, OUT_SIZE]), ERROR_SUCCESS);
    assert.equal(fns.RegGetValueA.argBytes, 28);
});

test('a tree is copied whole and deleted whole, and data below 64 KiB is refused', ()=>{
    const { memory, fns, create, setString } = setup();
    const from = create('Software\\From');
    const to = create('Software\\To');
    memory.putString(SUBKEY, 'Deep\\Deeper');
    fns.RegCreateKeyA.handler([from, SUBKEY, OUT_HANDLE]);
    setString(memory.dword(OUT_HANDLE), 'Leaf', 'green');
    assert.equal(fns.RegCopyTreeA.handler([from, 0, to]), ERROR_SUCCESS);
    memory.putString(SUBKEY, 'Deep\\Deeper');
    assert.equal(fns.RegOpenKeyA.handler([to, SUBKEY, OUT_HANDLE]), ERROR_SUCCESS);

    memory.putString(SUBKEY, 'Deep');
    assert.equal(fns.RegDeleteTreeA.handler([from, SUBKEY]), ERROR_SUCCESS);
    assert.equal(fns.RegOpenKeyA.handler([from, SUBKEY, OUT_HANDLE]), ERROR_FILE_NOT_FOUND);

    memory.putString(NAME, 'Low');
    assert.equal(fns.RegSetValueExA.handler([from, NAME, 0, REG_SZ, 1, 1]), 998,
        'ERROR_NOACCESS');
    assert.equal(fns.RegSetValueExA.handler([from, NAME, 0, REG_SZ, 0, 0]), ERROR_SUCCESS,
        'no data at all is fine');
});

/** A volume of whole files in memory, as the registry's `files` asks for one. */
function fakeFiles(){
    /** @type {Map<string, Uint8Array>} */
    const stored = new Map();
    const key = (/** @type {string} */ path)=>path.toLowerCase();
    return {
        stored,
        /** @param {string} path */
        stat: path=>(stored.has(key(path))
            ? { exists: true, isDirectory: false, size: /** @type {Uint8Array} */ (stored.get(key(path))).length }
            : null),
        /** @param {string} path @param {{ create?: boolean, truncate?: boolean }} mode */
        open(path, mode){
            if (!stored.has(key(path)) && !mode.create)
            {
                return null;
            }
            if (mode.truncate || !stored.has(key(path)))
            {
                stored.set(key(path), new Uint8Array(0));
            }
            return { path: key(path) };
        },
        /** @param {{ path: string }} node @param {number} offset @param {number} length */
        read: (node, offset, length)=>(stored.get(node.path) ?? new Uint8Array(0))
            .slice(offset, offset + length),
        /** @param {{ path: string }} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            const held = stored.get(node.path) ?? new Uint8Array(0);
            const grown = new Uint8Array(Math.max(held.length, offset + bytes.length));
            grown.set(held);
            grown.set(bytes, offset);
            stored.set(node.path, grown);
            return bytes.length;
        },
        close: ()=>{},
        /** @param {string} path */
        remove: path=>stored.delete(key(path)),
    };
}

test('an object\'s security by name is read through the volume and the hive this table holds',
    ()=>{
        // The account GetUserName names is the one LookupAccountSid names,
        // and the module reads its name from here.
        assert.equal(USER_NAME, 'User');
        const memory = fakeMemory();
        const files = fakeFiles();
        files.stored.set('c:\\setup.ini', new Uint8Array(1));
        let heap = 0x800;
        const fns = /** @type {any} */ (createRegistryFunctions({
            readMemory: memory.readMemory,
            writeMemory: memory.writeMemory,
            readCString: (address, maxLength)=>memory.readCString(address, maxLength),
            hive: createRegistryService(createHive()),
            // The drive's root, which the stand-in volume of files alone lacks.
            files: { ...files, stat: path=>(path.toLowerCase() === 'c:\\'
                ? { exists: true, isDirectory: true, size: 0 } : files.stat(path)) },
            allocate: size=>{
                heap += size + 7 & ~7;
                return heap - (size + 7 & ~7);
            },
        }));
        const SE_FILE_OBJECT = 1;
        const SE_REGISTRY_KEY = 4;
        const DACL = 0x4;
        memory.putString(NAME, 'C:\\setup.ini');
        assert.equal(fns.GetNamedSecurityInfoA.handler([NAME, SE_FILE_OBJECT, DACL, 0, 0,
            OUT_HANDLE, 0, OUT_TYPE]), ERROR_SUCCESS);
        assert.equal(memory.dword(OUT_HANDLE), 0, 'the null DACL of a volume that keeps none');
        memory.putString(NAME, 'C:\\gone.ini');
        assert.equal(fns.SetNamedSecurityInfoA.handler([NAME, SE_FILE_OBJECT, DACL, 0, 0, 0, 0]),
            ERROR_FILE_NOT_FOUND);
        memory.putString(NAME, 'CURRENT_USER\\Software');
        assert.equal(fns.GetNamedSecurityInfoA.handler([NAME, SE_REGISTRY_KEY, DACL, 0, 0,
            OUT_HANDLE, 0, OUT_TYPE]), ERROR_SUCCESS);
        assert.notEqual(memory.dword(OUT_HANDLE), 0, 'a key has a DACL');
    });

test('a key saved to a file loads under a root, writes its changes back as it unloads, '
    + 'and opens as an app key', async()=>{
    // advapi32's registry test, test_reg_load_key and test_reg_load_app_key.
    const memory = fakeMemory();
    const hive = createRegistryService(createHive());
    const files = fakeFiles();
    const fns = /** @type {any} */ (createRegistryFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        hive,
        files,
    }));
    const ERROR_ALREADY_EXISTS = 183;
    const STATUS_CANNOT_DELETE = 0xc0000121;
    const STATUS_ACCESS_DENIED = 0xc0000022;
    const HKEY_USERS = 0x80000003;
    const FILE = 0x800;
    const unload = fns[Object.getOwnPropertySymbols(fns)[0]];

    memory.putString(SUBKEY, 'Software\\Saved\\Inner');
    fns.RegCreateKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, 0, 0, 0, OUT_HANDLE, 0]);
    const inner = memory.dword(OUT_HANDLE);
    memory.putString(NAME, 'kept');
    memory.putString(INPUT, 'yes');
    fns.RegSetValueExA.handler([inner, NAME, 0, REG_SZ, INPUT, 4]);
    memory.putString(SUBKEY, 'Software\\Saved');
    fns.RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]);
    const saved = memory.dword(OUT_HANDLE);

    memory.putString(FILE, 'C:\\temp\\saved_key');
    assert.equal(fns.RegSaveKeyA.handler([saved, FILE, 0]), ERROR_SUCCESS);
    assert.equal(fns.RegSaveKeyA.handler([saved, FILE, 0]), ERROR_ALREADY_EXISTS,
        'a file already there');

    memory.putString(SUBKEY, 'Test');
    assert.equal(await fns.RegLoadKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY, FILE]), ERROR_SUCCESS);
    memory.putString(SUBKEY, 'Test\\Inner');
    assert.equal(fns.RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]),
        ERROR_SUCCESS, 'the saved subkey is there');
    const loadedInner = memory.dword(OUT_HANDLE);
    memory.putString(NAME, 'added');
    memory.putString(INPUT, 'value');
    fns.RegSetValueExA.handler([loadedInner, NAME, 0, REG_SZ, INPUT, 6]);
    assert.equal(unload(HKEY_LOCAL_MACHINE, 'Test'), STATUS_CANNOT_DELETE,
        'a handle is open on it');
    fns.RegCloseKey.handler([loadedInner]);
    memory.putString(SUBKEY, 'Test');
    assert.equal(fns.RegUnLoadKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY]), ERROR_SUCCESS);
    assert.equal(fns.RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]),
        ERROR_FILE_NOT_FOUND, 'gone once unloaded');
    memory.putString(FILE + 0x100, '');
    assert.equal(await fns.RegLoadKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY, FILE + 0x100]),
        ERROR_INVALID_PARAMETER);
    memory.putString(SUBKEY, '.Default');
    assert.equal(fns.RegUnLoadKeyA.handler([HKEY_USERS, SUBKEY]), ERROR_ACCESS_DENIED,
        'no hive loaded there');
    assert.equal(unload(HKEY_USERS, '.Default'), STATUS_ACCESS_DENIED);

    // Loaded again, the change made while it was loaded is in the file.
    memory.putString(SUBKEY, 'Test');
    assert.equal(await fns.RegLoadKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY, FILE]), ERROR_SUCCESS);
    memory.putString(SUBKEY, 'Test\\Inner');
    fns.RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]);
    const again = memory.dword(OUT_HANDLE);
    memory.putString(NAME, 'added');
    memory.putDword(OUT_SIZE, 16);
    assert.equal(fns.RegQueryValueExA.handler([again, NAME, 0, OUT_TYPE, OUT_DATA, OUT_SIZE]),
        ERROR_SUCCESS);
    assert.equal(memory.string(OUT_DATA), 'value');
    fns.RegCloseKey.handler([again]);
    memory.putString(SUBKEY, 'Test');
    fns.RegUnLoadKeyA.handler([HKEY_LOCAL_MACHINE, SUBKEY]);

    // An app key is the file's tree on a handle of its own, written back as it closes.
    assert.equal(await fns.RegLoadAppKeyA.handler([FILE, OUT_HANDLE, 0, 0, 0]), ERROR_SUCCESS);
    const app = memory.dword(OUT_HANDLE);
    memory.putString(NAME, 'app');
    memory.putString(INPUT, 'set');
    assert.equal(fns.RegSetValueExA.handler([app, NAME, 0, REG_SZ, INPUT, 4]), ERROR_SUCCESS);
    fns.RegCloseKey.handler([app]);
    assert.equal(await fns.RegLoadAppKeyA.handler([FILE, OUT_HANDLE, 0, 0, 0]), ERROR_SUCCESS);
    memory.putDword(OUT_SIZE, 16);
    assert.equal(fns.RegQueryValueExA.handler([memory.dword(OUT_HANDLE), NAME, 0, OUT_TYPE,
        OUT_DATA, OUT_SIZE]), ERROR_SUCCESS);
    assert.equal(memory.string(OUT_DATA), 'set');
    memory.putString(FILE, 'C:\\temp\\missing');
    assert.equal(await fns.RegLoadAppKeyA.handler([FILE, OUT_HANDLE, 0, 0, 0]),
        ERROR_FILE_NOT_FOUND);
});

test('RegNotifyChangeKeyValue answers one change to the key or under it, and a close', async()=>{
    // advapi32's registry test, test_RegNotifyChangeKeyValue.
    const memory = fakeMemory();
    /** @type {string[]} */
    const told = [];
    const fns = /** @type {any} */ (createRegistryFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        hive: createRegistryService(createHive()),
        events: {
            set: handle=>told.push(`set ${handle}`) > 0,
            reset: handle=>told.push(`reset ${handle}`) > 0,
        },
    }));
    const NAME_AND_LAST_SET = 0x5;
    const EVENT = 0x77;
    /** @param {number} base @param {string} path */
    const create = (base, path)=>{
        memory.putString(SUBKEY, path);
        assert.equal(fns.RegCreateKeyExA.handler(
            [base, SUBKEY, 0, 0, 0, 0, 0, OUT_HANDLE, 0]), ERROR_SUCCESS);
        return memory.dword(OUT_HANDLE);
    };
    const key = create(HKEY_LOCAL_MACHINE, 'Watched');
    assert.equal(fns.RegNotifyChangeKeyValue.handler([key, 1, NAME_AND_LAST_SET, EVENT, 1]),
        ERROR_SUCCESS);
    assert.deepEqual(told, ['reset 119'], 'reset as it is asked for');
    const sub = create(key, 'Sub');
    assert.deepEqual(told, ['reset 119', 'set 119'], 'a subkey made');
    create(key, 'Sub');
    assert.equal(told.length, 2, 'once, and a key that was there already is no change');

    fns.RegNotifyChangeKeyValue.handler([key, 1, NAME_AND_LAST_SET, EVENT, 1]);
    const deeper = create(sub, 'Deeper');
    assert.equal(told.at(-1), 'set 119', 'under it, watching the subtree');

    fns.RegNotifyChangeKeyValue.handler([key, 0, NAME_AND_LAST_SET, EVENT, 1]);
    memory.putString(INPUT, 'v');
    fns.RegSetValueA.handler([deeper, 0, REG_SZ, INPUT, 0]);
    assert.equal(told.at(-1), 'reset 119', 'deeper values not, without the subtree');
    memory.putString(NAME, 'own');
    fns.RegSetValueExA.handler([key, NAME, 0, REG_SZ, INPUT, 2]);
    assert.equal(told.at(-1), 'set 119', 'its own values');

    fns.RegNotifyChangeKeyValue.handler([key, 0, NAME_AND_LAST_SET, EVENT, 1]);
    fns.RegCloseKey.handler([key]);
    assert.equal(told.at(-1), 'set 119', 'a close signals');

    const again = create(HKEY_LOCAL_MACHINE, 'Watched');
    assert.equal(fns.RegNotifyChangeKeyValue.handler([again, 0, 0, EVENT, 1]),
        ERROR_INVALID_PARAMETER, 'no kind of change');
    assert.equal(fns.RegNotifyChangeKeyValue.handler([again, 0, 1, 0, 1]),
        ERROR_INVALID_PARAMETER, 'no event to signal');
    const waited = fns.RegNotifyChangeKeyValue.handler([again, 0, 1, 0, 0]);
    assert.ok(waited instanceof Promise, 'without one, the caller waits');
    create(again, 'Another');
    assert.equal(await waited, ERROR_SUCCESS);
});

test('the native registry calls work the same keys through the same handles', ()=>{
    // Wine's registry test calls them on keys the Reg* functions opened, and
    // a key one opens the other must read, write and close.
    const STATUS_SUCCESS = 0;
    const STATUS_BUFFER_OVERFLOW = 0x80000005;
    const STATUS_NO_MORE_ENTRIES = 0x8000001a;
    const STATUS_INVALID_HANDLE = 0xc0000008;
    const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
    const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
    const STATUS_CANNOT_DELETE = 0xc0000121;
    const KEY_VALUE_BASIC = 0;
    const KEY_VALUE_PARTIAL = 2;
    const KEY_FULL = 2;
    const { memory, fns, create } = setup();
    const native = /** @type {any} */ (fns)[REGISTRY_NATIVES];
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        native.entries[name].handler(args) >>> 0;
    /** @param {number} at @param {string} text  A UNICODE_STRING at `at`, its text after it. */
    const counted = (at, text)=>{
        memory.putDword(at, text.length * 2 | (text.length * 2 + 2) << 16);
        memory.putDword(at + 4, at + 8);
        for (let i = 0; i < text.length; i++)
        {
            memory.bytes[at + 8 + i * 2] = text.charCodeAt(i);
            memory.bytes[at + 9 + i * 2] = 0;
        }
        return at;
    };
    /** @param {number} root @param {string} name */
    const attributes = (root, name)=>{
        memory.putDword(0x900, 24);
        memory.putDword(0x904, root);
        memory.putDword(0x908, counted(0x920, name));
        return 0x900;
    };

    const parent = create('Software\\NativeParent');
    assert.ok(parent >= 0x40000004, 'apart from every handle the kernel issues');
    assert.equal(call('NtCreateKey', [OUT_HANDLE, 0, attributes(parent, 'Child'), 0, 0, 0,
        OUT_DISPOSITION]), STATUS_SUCCESS);
    const child = memory.dword(OUT_HANDLE);
    assert.equal(memory.dword(OUT_DISPOSITION), REG_CREATED_NEW_KEY);
    assert.equal(call('NtCreateKey', [OUT_HANDLE, 0, attributes(parent, 'Child'), 0, 0, 0,
        OUT_DISPOSITION]), STATUS_SUCCESS);
    assert.equal(memory.dword(OUT_DISPOSITION), REG_OPENED_EXISTING_KEY);
    assert.equal(call('NtCreateKey', [OUT_HANDLE, 0, attributes(parent, 'Gone\\Deep'), 0, 0, 0, 0]),
        STATUS_OBJECT_NAME_NOT_FOUND, 'one level at a time');
    assert.equal(call('NtOpenKey', [OUT_HANDLE, 0,
        attributes(0, '\\Registry\\Machine\\Software\\NativeParent\\Child')]), STATUS_SUCCESS);
    assert.equal(call('NtOpenKey', [OUT_HANDLE, 0, attributes(0, '\\Registry\\PerfData')]),
        STATUS_OBJECT_NAME_NOT_FOUND);

    memory.bytes.set([0x6f, 0, 0x6b, 0, 0, 0], INPUT);
    assert.equal(call('NtSetValueKey', [child, counted(0xa00, 'Word'), 0, REG_SZ, INPUT, 6]),
        STATUS_SUCCESS);
    assert.equal(fns.RegQueryValueExA.handler([child, (memory.putString(NAME, 'Word'), NAME), 0,
        OUT_TYPE, OUT_DATA, (memory.putDword(OUT_SIZE, 16), OUT_SIZE)]), ERROR_SUCCESS);
    assert.equal(memory.string(OUT_DATA), 'ok', 'what the native call wrote, Reg* reads');
    assert.equal(call('NtQueryValueKey', [child, counted(0xa00, 'Word'), KEY_VALUE_PARTIAL,
        OUT_INFO, 0x40, OUT_SIZE]), STATUS_SUCCESS);
    assert.deepEqual(
        [memory.dword(OUT_INFO + 4), memory.dword(OUT_INFO + 8), memory.dword(OUT_SIZE)],
        [REG_SZ, 6, 18], 'type, data length, and the whole answer');
    assert.equal(call('NtQueryValueKey', [child, counted(0xa00, 'Word'), KEY_VALUE_PARTIAL,
        OUT_INFO, 4, OUT_SIZE]), STATUS_BUFFER_TOO_SMALL);
    assert.equal(call('NtQueryValueKey', [child, counted(0xa00, 'Word'), KEY_VALUE_PARTIAL,
        OUT_INFO, 12, OUT_SIZE]), STATUS_BUFFER_OVERFLOW);
    assert.equal(call('NtEnumerateValueKey', [child, 0, KEY_VALUE_BASIC, OUT_INFO, 0x40, 0]),
        STATUS_SUCCESS);
    assert.equal(memory.dword(OUT_INFO + 8), 8, 'the name, four characters');
    assert.equal(call('NtEnumerateValueKey', [child, 1, KEY_VALUE_BASIC, OUT_INFO, 0x40, 0]),
        STATUS_NO_MORE_ENTRIES);

    assert.equal(call('NtQueryKey', [parent, KEY_FULL, OUT_INFO, 0x40, 0]), STATUS_SUCCESS);
    assert.equal(memory.dword(OUT_INFO + 20), 1, 'one subkey');
    assert.equal(call('NtEnumerateKey', [parent, 0, 0, OUT_INFO, 0x40, 0]), STATUS_SUCCESS);
    assert.equal(memory.dword(OUT_INFO + 12), 10, 'its name, five characters');
    assert.equal(call('NtQueryKey', [HKEY_LOCAL_MACHINE, KEY_FULL, OUT_INFO, 0x40, 0]),
        STATUS_INVALID_HANDLE, 'a predefined root is no handle to these calls');

    assert.equal(call('NtFlushKey', [child]), STATUS_SUCCESS);
    assert.equal(call('NtFlushKey', [HKEY_LOCAL_MACHINE]), STATUS_INVALID_HANDLE);
    assert.equal(call('NtDeleteValueKey', [child, counted(0xa00, 'Word')]), STATUS_SUCCESS);
    assert.equal(call('NtDeleteValueKey', [child, counted(0xa00, 'Word')]),
        STATUS_OBJECT_NAME_NOT_FOUND);
    assert.equal(call('NtDeleteKey', [parent]), STATUS_CANNOT_DELETE, 'it has a subkey');
    assert.equal(call('NtDeleteKey', [child]), STATUS_SUCCESS);
    assert.equal(call('NtOpenKey', [OUT_HANDLE, 0, attributes(parent, 'Child')]),
        STATUS_OBJECT_NAME_NOT_FOUND);

    assert.equal(native.close(child), STATUS_SUCCESS);
    assert.equal(native.close(child), null, 'closed, so no longer this table\'s');
    assert.equal(native.close(HKEY_LOCAL_MACHINE), STATUS_INVALID_HANDLE);
    assert.equal(native.close(8), null, 'a kernel handle is left to the kernel');
});

test('RegRenameKey gives a key or its subkey a new name, its values going with it', ()=>{
    // Wine's registry test_RegRenameKey: no names at all is a bad parameter,
    // a subkey that is not there is not found, and the key itself may be
    // renamed through its own handle.
    const ERROR_ALREADY_EXISTS = 183;
    const { memory, fns, create, setString } = setup();
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        for (let i = 0; i <= text.length; i++)
        {
            memory.bytes[at + i * 2] = i < text.length ? text.charCodeAt(i) : 0;
            memory.bytes[at + i * 2 + 1] = 0;
        }
        return at;
    };
    const parent = create('Software\\RenameParent');
    const child = create('Software\\RenameParent\\Old');
    assert.equal(setString(child, 'kept', 'yes'), ERROR_SUCCESS);
    assert.equal(fns.RegRenameKey.handler([parent, 0, 0]), ERROR_INVALID_PARAMETER);
    assert.equal(fns.RegRenameKey.handler([0, 0, wide(0x800, 'x')]), ERROR_INVALID_HANDLE);
    assert.equal(fns.RegRenameKey.handler([parent, wide(0x800, 'Nothing'), wide(0x840, 'x')]),
        ERROR_FILE_NOT_FOUND);
    assert.equal(fns.RegRenameKey.handler([parent, wide(0x800, 'Old'), wide(0x840, 'New')]),
        ERROR_SUCCESS);
    memory.putString(SUBKEY, 'Software\\RenameParent\\New');
    assert.equal(fns.RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]),
        ERROR_SUCCESS);
    memory.putString(NAME, 'kept');
    memory.putDword(OUT_SIZE, 16);
    assert.equal(fns.RegQueryValueExA.handler([memory.dword(OUT_HANDLE), NAME, 0, OUT_TYPE,
        OUT_DATA, OUT_SIZE]), ERROR_SUCCESS);
    assert.equal(memory.string(OUT_DATA), 'yes', 'the values went with the key');
    memory.putString(SUBKEY, 'Software\\RenameParent\\Old');
    assert.equal(fns.RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE, SUBKEY, 0, 0, OUT_HANDLE]),
        ERROR_FILE_NOT_FOUND);
    assert.equal(fns.RegRenameKey.handler([child, 0, wide(0x800, 'Itself')]), ERROR_SUCCESS,
        'the handle still holds the key, under its new name');
    create('Software\\RenameParent\\Other');
    assert.equal(fns.RegRenameKey.handler([child, 0, wide(0x800, 'Other')]), ERROR_ALREADY_EXISTS);
});

test('IsTextUnicode reads the buffer, the tests asked for, and writes back which passed', ()=>{
    const memory = fakeMemory();
    const fns = createRegistryFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        hive: createRegistryService(createHive()),
        setLastError: ()=>{},
    });
    const text = new Uint8Array(Uint16Array.from('Hi there', c=>c.charCodeAt(0)).buffer);
    const BUFFER = 0x400;
    const RESULT = 0x500;
    memory.writeMemory(BUFFER, text);
    assert.equal(fns.IsTextUnicode.handler([BUFFER, text.length, 0]), 1);
    memory.writeMemory(RESULT, new Uint8Array([1, 0, 0, 0]));
    assert.equal(fns.IsTextUnicode.handler([BUFFER, text.length, RESULT]), 1);
    assert.deepEqual([...memory.readMemory(RESULT, 4)], [1, 0, 0, 0], 'IS_TEXT_UNICODE_ASCII16');
    memory.writeMemory(RESULT, new Uint8Array([8, 0, 0, 0]));
    assert.equal(fns.IsTextUnicode.handler([BUFFER, text.length, RESULT]), 0,
        'asked only for a signature, which it has not');
    assert.deepEqual([...memory.readMemory(RESULT, 4)], [0, 0, 0, 0]);
    assert.equal(fns.IsTextUnicode.handler([BUFFER, 1, 0]), 0, 'less than a character');
    assert.equal(fns.IsTextUnicode.argBytes, 12);
});
