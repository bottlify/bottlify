/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistryFunctions } from './functions.js';
import {
    createHive,
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
const INPUT = 0x300;
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
function fakeMemory(size = 0x1000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let i = 0; i < maxLength && bytes[address + i] !== 0; i++)
            {
                text += String.fromCharCode(bytes[address + i]);
            }
            return text;
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
    const hive = createHive();
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

test('a key cannot delete itself', ()=>{
    const { fns, create } = setup();
    const key = create('Software\\Test');
    assert.equal(fns.RegDeleteKeyA.handler([key, 0]), ERROR_FILE_NOT_FOUND);
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
        hive: createHive(),
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
