/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileFunctions, WIN32_FIND_DATAA } from './files.js';
import { HANDLE_STDOUT } from './console.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NO_MORE_FILES = 18;
const ERROR_FILE_EXISTS = 80;
const ERROR_NEGATIVE_SEEK = 131;
const ERROR_ALREADY_EXISTS = 183;

const INVALID_HANDLE_VALUE = 0xffffffff;

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;

const CREATE_NEW = 1;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const TRUNCATE_EXISTING = 5;

const FILE_BEGIN = 0;
const FILE_CURRENT = 1;
const FILE_END = 2;

/** Addresses the fixtures use; nothing about them matters but that they differ. */
const NAME = 0x100;
const NAME2 = 0x180;
const BUFFER = 0x200;
const OUT_COUNT = 0x300;
const OUT_HIGH = 0x304;
const OUT_QWORD = 0x308;
const OUT_PART = 0x310;
const OUT_TEXT = 0x400;
const FIND_DATA = 0x600;

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

/**
 * A filesystem stand-in with the contract the real one promises, so these tests
 * are about the translation into the guest's vocabulary and not about storage.
 *
 * Paths are matched exactly: case folding belongs to the filesystem, and a test
 * that relied on it here would be testing this fake.
 */
function fakeFiles(){
    /** @type {Map<string, { data: Uint8Array, directory: boolean }>} */
    const nodes = new Map();
    let current = 'C:\\GAME';
    nodes.set('C:\\', { data: new Uint8Array(0), directory: true });
    nodes.set('C:\\GAME', { data: new Uint8Array(0), directory: true });

    /** @param {string} path @param {string} text */
    const put = (path, text)=>{
        nodes.set(path, {
            data: Uint8Array.from(text, character=>character.charCodeAt(0) & 0xff),
            directory: false,
        });
    };

    /** @param {string} pattern */
    const matcher = pattern=>{
        const expression = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        return new RegExp(`^${expression}$`, 'i');
    };

    const files = {
        nodes,
        put,
        /** @param {string} path */
        text: path=>String.fromCharCode(.../** @type {any} */ (nodes.get(path)).data),
        /** @param {string} path */
        stat(path){
            const node = nodes.get(path);
            return node
                ? { exists: true, isDirectory: node.directory, size: node.data.length }
                : null;
        },
        /** @param {string} path @param {import('./files.js').OpenMode} mode */
        open(path, mode){
            const existing = nodes.get(path);
            if (existing && mode.failIfExists)
            {
                return null;
            }
            if (!existing && !mode.create)
            {
                return null;
            }
            if (!existing && !nodes.has(parent(path)))
            {
                return null;
            }
            if (!existing || mode.truncate)
            {
                nodes.set(path, { data: new Uint8Array(0), directory: false });
            }
            return { path };
        },
        /** @param {{ path: string }} node @param {number} offset @param {number} length */
        read(node, offset, length){
            const data = /** @type {any} */ (nodes.get(node.path)).data;
            return data.slice(Math.min(offset, data.length),
                Math.min(offset + length, data.length));
        },
        /** @param {{ path: string }} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            const entry = /** @type {any} */ (nodes.get(node.path));
            const grown = new Uint8Array(Math.max(entry.data.length, offset + bytes.length));
            grown.set(entry.data);
            grown.set(bytes, offset);
            entry.data = grown;
            return bytes.length;
        },
        /** @param {{ path: string }} node @param {number} size */
        truncate(node, size){
            const entry = /** @type {any} */ (nodes.get(node.path));
            const cut = new Uint8Array(size);
            cut.set(entry.data.subarray(0, Math.min(size, entry.data.length)));
            entry.data = cut;
        },
        close: ()=>{},
        /** @param {string} path */
        remove(path){
            const node = nodes.get(path);
            if (node?.directory && [...nodes.keys()].some(key=>key.startsWith(path + '\\')))
            {
                return false;
            }
            return nodes.delete(path);
        },
        /** @param {string} path */
        mkdir(path){
            if (!nodes.has(parent(path)))
            {
                return false;
            }
            nodes.set(path, { data: new Uint8Array(0), directory: true });
            return true;
        },
        /** @param {string} from @param {string} to */
        rename(from, to){
            const node = nodes.get(from);
            if (!node)
            {
                return false;
            }
            nodes.delete(from);
            nodes.set(to, node);
            return true;
        },
        /** @param {string} path @param {string} pattern */
        list(path, pattern){
            const matches = matcher(pattern);
            const prefix = path.endsWith('\\') ? path : path + '\\';
            return [...nodes.entries()]
                .filter(([key])=>key.startsWith(prefix)
                    && !key.slice(prefix.length).includes('\\'))
                .filter(([key])=>matches.test(key.slice(prefix.length)))
                .map(([key, node])=>({
                    name: key.slice(prefix.length),
                    isDirectory: node.directory,
                    size: node.data.length,
                }));
        },
        currentDirectory: ()=>current,
        /** @param {string} path */
        setCurrentDirectory: path=>{
            current = path;
        },
    };
    return files;
}

/** @param {string} path */
function parent(path){
    const at = path.lastIndexOf('\\');
    return at <= 2 ? path.slice(0, at + 1) : path.slice(0, at);
}

/** The handle table the real kernel provides, with the same reuse discipline. */
function fakeHandles(){
    /** @type {Map<number, { type: string, object: any }>} */
    const entries = new Map();
    let next = 4;
    return {
        /** @param {string} type @param {any} object */
        open(type, object){
            const handle = next;
            next += 4;
            entries.set(handle, { type, object });
            return handle;
        },
        /** @param {number} handle @param {string} [type] */
        resolve(handle, type){
            const entry = entries.get(handle);
            if (!entry)
            {
                throw new Error('Invalid handle');
            }
            if (type && entry.type !== type)
            {
                throw new Error('Wrong type');
            }
            return entry.object;
        },
        /** @param {number} handle */
        close(handle){
            const entry = entries.get(handle);
            if (!entry)
            {
                throw new Error('Invalid handle');
            }
            entries.delete(handle);
            return entry.object;
        },
        /** @param {number} handle */
        has: handle=>entries.has(handle),
    };
}

function setup(){
    const memory = fakeMemory();
    const files = fakeFiles();
    const handles = fakeHandles();
    /** @type {{ code: number }} */
    const error = { code: ERROR_SUCCESS };
    /** @type {{ handle: number, text: string }[]} */
    const console = [];

    const fns = createFileFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        files,
        setLastError: code=>{
            error.code = code;
        },
        writeConsole: (handle, text)=>console.push({ handle, text }),
        handles,
    });

    /**
     * Opens a file the way a program would, and fails the test rather than
     * carrying an invalid handle into the assertions that follow.
     *
     * @param {string} path @param {number} disposition @param {number} [access]
     */
    const open = (path, disposition, access = GENERIC_READ | GENERIC_WRITE)=>{
        memory.putString(NAME, path);
        const handle = fns.CreateFileA.handler([NAME, access, 0, 0, disposition, 0, 0]);
        assert.notEqual(handle, INVALID_HANDLE_VALUE, `could not open ${path}`);
        return handle;
    };

    /** @param {number} pointer @param {string} path */
    const at = (pointer, path)=>{
        memory.putString(pointer, path);
        return pointer;
    };

    return { memory, files, handles, error, console, fns, open, at };
}

test('CREATE_NEW refuses a file that is already there', ()=>{
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'old');

    const handle = fns.CreateFileA.handler(
        [at(NAME, 'C:\\GAME\\SAVE.DAT'), GENERIC_WRITE, 0, 0, CREATE_NEW, 0, 0]);

    assert.equal(handle, INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_FILE_EXISTS);
    assert.equal(files.text('C:\\GAME\\SAVE.DAT'), 'old', 'and leaves it alone');
});

test('CREATE_ALWAYS succeeds on an existing file and says so through the error', ()=>{
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'old');

    const handle = fns.CreateFileA.handler(
        [at(NAME, 'C:\\GAME\\SAVE.DAT'), GENERIC_WRITE, 0, 0, CREATE_ALWAYS, 0, 0]);

    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_ALREADY_EXISTS,
        'the documented way a caller learns it overwrote something');
    assert.equal(files.text('C:\\GAME\\SAVE.DAT'), '', 'and it was truncated');
});

test('a creation that found nothing to overwrite clears the error', ()=>{
    const { error, fns, at } = setup();
    error.code = ERROR_ALREADY_EXISTS;

    fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\NEW.DAT'), GENERIC_WRITE, 0, 0,
        OPEN_ALWAYS, 0, 0]);

    assert.equal(error.code, ERROR_SUCCESS,
        'otherwise the previous call answers this one');
});

test('OPEN_EXISTING distinguishes a missing file from a missing directory', ()=>{
    const { error, fns, at } = setup();

    assert.equal(fns.CreateFileA.handler(
        [at(NAME, 'C:\\GAME\\GONE.DAT'), GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]),
    INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);

    assert.equal(fns.CreateFileA.handler(
        [at(NAME, 'C:\\NOWHERE\\GONE.DAT'), GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]),
    INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND);
});

test('a directory is not a file, and TRUNCATE_EXISTING needs write access', ()=>{
    const { error, fns, at } = setup();

    assert.equal(fns.CreateFileA.handler(
        [at(NAME, 'C:\\GAME'), GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]),
    INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_ACCESS_DENIED);

    assert.equal(fns.CreateFileA.handler(
        [at(NAME, 'C:\\GAME\\SAVE.DAT'), GENERIC_READ, 0, 0, TRUNCATE_EXISTING, 0, 0]),
    INVALID_HANDLE_VALUE);
});

test('a relative name is resolved against the current directory', ()=>{
    const { files, fns, at } = setup();

    fns.CreateFileA.handler([at(NAME, 'DATA\\..\\SAVE.DAT'), GENERIC_WRITE, 0, 0,
        CREATE_ALWAYS, 0, 0]);

    assert.ok(files.nodes.has('C:\\GAME\\SAVE.DAT'), 'and the dot segments collapse');
});

test('reading past the end of the file succeeds and reports nothing read', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putDword(OUT_COUNT, 0xdeadbeef);

    fns.SetFilePointer.handler([handle, 4, 0, FILE_BEGIN]);
    const result = fns.ReadFile.handler([handle, BUFFER, 16, OUT_COUNT, 0]);

    assert.equal(result, 1, 'the end of a file is not a failure');
    assert.equal(memory.dword(OUT_COUNT), 0,
        'and the count is written anyway -- it is how the caller knows');
});

test('a read stops at the end of the file and advances by what it got', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);

    fns.SetFilePointer.handler([handle, 2, 0, FILE_BEGIN]);
    fns.ReadFile.handler([handle, BUFFER, 16, OUT_COUNT, 0]);

    assert.equal(memory.dword(OUT_COUNT), 2);
    assert.equal(String.fromCharCode(memory.bytes[BUFFER], memory.bytes[BUFFER + 1]), 'cd');
    assert.equal(fns.SetFilePointer.handler([handle, 0, 0, FILE_CURRENT]), 4);
});

test('a write to a standard handle goes to the console, not to the filesystem', ()=>{
    const { memory, files, console, fns } = setup();
    memory.putString(BUFFER, 'hello');

    const result = fns.WriteFile.handler([HANDLE_STDOUT, BUFFER, 5, OUT_COUNT, 0]);

    assert.equal(result, 1);
    assert.deepEqual(console, [{ handle: HANDLE_STDOUT, text: 'hello' }]);
    assert.equal(memory.dword(OUT_COUNT), 5);
    assert.equal(files.nodes.size, 2, 'nothing was created for it');
});

test('a write to a file lands at the position and moves it on', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putString(BUFFER, 'XY');

    fns.SetFilePointer.handler([handle, 1, 0, FILE_BEGIN]);
    fns.WriteFile.handler([handle, BUFFER, 2, OUT_COUNT, 0]);

    assert.equal(files.text('C:\\GAME\\SAVE.DAT'), 'aXYd');
    assert.equal(memory.dword(OUT_COUNT), 2);
    assert.equal(fns.SetFilePointer.handler([handle, 0, 0, FILE_CURRENT]), 3);
});

test('a zero-length write still reports a count', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putDword(OUT_COUNT, 0xdeadbeef);

    assert.equal(fns.WriteFile.handler([handle, BUFFER, 0, OUT_COUNT, 0]), 1);
    assert.equal(memory.dword(OUT_COUNT), 0);
});

test('a file opened for reading refuses a write, and the other way round', ()=>{
    const { files, error, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');

    const reader = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING, GENERIC_READ);
    assert.equal(fns.WriteFile.handler([reader, BUFFER, 1, OUT_COUNT, 0]), 0);
    assert.equal(error.code, ERROR_ACCESS_DENIED);

    const writer = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING, GENERIC_WRITE);
    assert.equal(fns.ReadFile.handler([writer, BUFFER, 1, OUT_COUNT, 0]), 0);
    assert.equal(error.code, ERROR_ACCESS_DENIED);
});

test('SetFilePointer tells a legal 0xffffffff from a failure only by the error', ()=>{
    const { memory, error, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);

    // A caller clears the error, seeks, and reads it back: this is the position
    // 4294967295, not a failure, and only the cleared error says so. It takes
    // the high half to get here at all -- without one the distance is a signed
    // LONG, and 0xffffffff would be a seek of minus one.
    memory.putDword(OUT_HIGH, 0);
    error.code = ERROR_ALREADY_EXISTS;
    const position = fns.SetFilePointer.handler([handle, 0xffffffff, OUT_HIGH, FILE_BEGIN]);
    assert.equal(position, 0xffffffff);
    assert.equal(memory.dword(OUT_HIGH), 0);
    assert.equal(error.code, ERROR_SUCCESS);

    // The same value from a seek before the start of the file, which is one.
    const failure = fns.SetFilePointer.handler([handle, -1, 0, FILE_BEGIN]);
    assert.equal(failure, 0xffffffff);
    assert.equal(error.code, ERROR_NEGATIVE_SEEK);
});

test('the high half of a seek is both an argument and a result', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putDword(OUT_HIGH, 1);

    const result = fns.SetFilePointer.handler([handle, 8, OUT_HIGH, FILE_BEGIN]);

    assert.equal(result, 8, 'the low half comes back as the return value');
    assert.equal(memory.dword(OUT_HIGH), 1, 'and the high half through the pointer');
});

test('a seek from the end is relative to the size the filesystem reports', ()=>{
    const { files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcdefgh');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);

    assert.equal(fns.SetFilePointer.handler([handle, -3, 0, FILE_END]), 5);
});

test('SetFilePointerEx answers through its pointer instead of ambiguously', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);

    const result = fns.SetFilePointerEx.handler([handle, 0xffffffff, 0, OUT_QWORD, FILE_BEGIN]);

    assert.equal(result, 1);
    assert.equal(memory.dword(OUT_QWORD), 0xffffffff);
    assert.equal(memory.dword(OUT_QWORD + 4), 0);
});

test('SetEndOfFile cuts the file at wherever the pointer stands', ()=>{
    const { files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcdefgh');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);

    fns.SetFilePointer.handler([handle, 3, 0, FILE_BEGIN]);
    assert.equal(fns.SetEndOfFile.handler([handle]), 1);

    assert.equal(files.text('C:\\GAME\\SAVE.DAT'), 'abc');
});

test('the two size queries agree, and the ambiguous one clears the error', ()=>{
    const { memory, error, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcdefgh');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    error.code = ERROR_ALREADY_EXISTS;

    assert.equal(fns.GetFileSize.handler([handle, OUT_HIGH]), 8);
    assert.equal(memory.dword(OUT_HIGH), 0);
    assert.equal(error.code, ERROR_SUCCESS, 'the INVALID_FILE_SIZE idiom depends on it');

    assert.equal(fns.GetFileSizeEx.handler([handle, OUT_QWORD]), 1);
    assert.equal(memory.dword(OUT_QWORD), 8);
});

test('closing a file handle closes it once and for all', ()=>{
    const { error, files, handles, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);

    assert.equal(fns.FlushFileBuffers.handler([handle]), 1);
    assert.equal(fns.CloseHandle.handler([handle]), 1);
    assert.equal(handles.has(handle), false);
    assert.equal(fns.CloseHandle.handler([handle]), 0, 'closing twice is a failure');
    assert.equal(error.code, ERROR_INVALID_HANDLE);
    assert.equal(fns.ReadFile.handler([handle, BUFFER, 1, OUT_COUNT, 0]), 0);
    assert.equal(fns.FlushFileBuffers.handler([handle]), 0);
});

test('CloseHandle closes what other tables opened, without telling the filesystem', ()=>{
    const { handles, fns } = setup();
    const event = handles.open('event', { signalled: false });

    assert.equal(fns.CloseHandle.handler([event]), 1,
        'one handle space means one CloseHandle');
    assert.equal(handles.has(event), false);
});

test('deleting reports which half of the path was not there', ()=>{
    const { error, files, fns, at } = setup();

    assert.equal(fns.DeleteFileA.handler([at(NAME, 'C:\\GAME\\GONE.DAT')]), 0);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);

    assert.equal(fns.DeleteFileA.handler([at(NAME, 'C:\\NOWHERE\\GONE.DAT')]), 0);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND);

    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    assert.equal(fns.DeleteFileA.handler([at(NAME, 'C:\\GAME\\SAVE.DAT')]), 1);
    assert.equal(files.nodes.has('C:\\GAME\\SAVE.DAT'), false);
});

test('a move never replaces what is already at the destination', ()=>{
    const { error, files, fns, at } = setup();
    files.put('C:\\GAME\\A.DAT', 'a');
    files.put('C:\\GAME\\B.DAT', 'b');

    assert.equal(fns.MoveFileA.handler(
        [at(NAME, 'C:\\GAME\\A.DAT'), at(NAME2, 'C:\\GAME\\B.DAT')]), 0);
    assert.equal(error.code, ERROR_ALREADY_EXISTS);
    assert.equal(files.text('C:\\GAME\\B.DAT'), 'b', 'and leaves it untouched');

    assert.equal(fns.MoveFileA.handler(
        [at(NAME, 'C:\\GAME\\A.DAT'), at(NAME2, 'C:\\GAME\\C.DAT')]), 1);
    assert.equal(files.text('C:\\GAME\\C.DAT'), 'a');
    assert.equal(files.nodes.has('C:\\GAME\\A.DAT'), false);
});

test('a copy overwrites unless the caller says not to', ()=>{
    const { error, files, fns, at } = setup();
    files.put('C:\\GAME\\A.DAT', 'source');
    files.put('C:\\GAME\\B.DAT', 'destination');

    assert.equal(fns.CopyFileA.handler(
        [at(NAME, 'C:\\GAME\\A.DAT'), at(NAME2, 'C:\\GAME\\B.DAT'), 1]), 0);
    assert.equal(error.code, ERROR_FILE_EXISTS);
    assert.equal(files.text('C:\\GAME\\B.DAT'), 'destination');

    assert.equal(fns.CopyFileA.handler(
        [at(NAME, 'C:\\GAME\\A.DAT'), at(NAME2, 'C:\\GAME\\B.DAT'), 0]), 1);
    assert.equal(files.text('C:\\GAME\\B.DAT'), 'source',
        'and the whole file, not part of it');
});

test('directories are made one level at a time and removed only when empty', ()=>{
    const { error, files, fns, at } = setup();

    assert.equal(fns.CreateDirectoryA.handler([at(NAME, 'C:\\GAME\\DATA'), 0]), 1);
    assert.equal(fns.CreateDirectoryA.handler([at(NAME, 'C:\\GAME\\DATA'), 0]), 0);
    assert.equal(error.code, ERROR_ALREADY_EXISTS);
    assert.equal(fns.CreateDirectoryA.handler([at(NAME, 'C:\\NOWHERE\\DATA'), 0]), 0);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND);

    files.put('C:\\GAME\\DATA\\A.DAT', 'a');
    assert.equal(fns.RemoveDirectoryA.handler([at(NAME, 'C:\\GAME\\DATA')]), 0);
    files.nodes.delete('C:\\GAME\\DATA\\A.DAT');
    assert.equal(fns.RemoveDirectoryA.handler([at(NAME, 'C:\\GAME\\DATA')]), 1);
});

test('attributes say what a path is, and 0xffffffff says it is not there', ()=>{
    const { error, files, fns, at } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');

    assert.equal(fns.GetFileAttributesA.handler([at(NAME, 'C:\\GAME\\SAVE.DAT')]), 0x20);
    assert.equal(fns.GetFileAttributesA.handler([at(NAME, 'C:\\GAME')]), 0x10);
    assert.equal(fns.GetFileAttributesA.handler([at(NAME, 'C:\\GAME\\GONE.DAT')]), 0xffffffff);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);

    assert.equal(fns.SetFileAttributesA.handler([at(NAME, 'C:\\GAME\\SAVE.DAT'), 1]), 1);
    assert.equal(fns.SetFileAttributesA.handler([at(NAME, 'C:\\GAME\\GONE.DAT'), 1]), 0);
});

test('GetFullPathNameA resolves textually and points at the last component', ()=>{
    const { memory, fns, at } = setup();

    const written = fns.GetFullPathNameA.handler(
        [at(NAME, 'DATA\\..\\SAVE.DAT'), 0x40, OUT_TEXT, OUT_PART]);

    assert.equal(memory.string(OUT_TEXT), 'C:\\GAME\\SAVE.DAT');
    assert.equal(written, 'C:\\GAME\\SAVE.DAT'.length, 'the length, without the terminator');
    assert.equal(memory.dword(OUT_PART), OUT_TEXT + 'C:\\GAME\\'.length);
    assert.equal(memory.string(memory.dword(OUT_PART)), 'SAVE.DAT');
});

test('a path ending in a separator has no file part', ()=>{
    const { memory, fns, at } = setup();

    fns.GetFullPathNameA.handler([at(NAME, 'C:\\GAME\\DATA\\'), 0x40, OUT_TEXT, OUT_PART]);

    assert.equal(memory.string(OUT_TEXT), 'C:\\GAME\\DATA\\');
    assert.equal(memory.dword(OUT_PART), 0);
});

test('a buffer too small is answered with the size to allocate', ()=>{
    const { memory, fns, at } = setup();
    memory.putDword(OUT_TEXT, 0);

    const needed = fns.GetFullPathNameA.handler(
        [at(NAME, 'C:\\GAME\\SAVE.DAT'), 4, OUT_TEXT, OUT_PART]);

    assert.equal(needed, 'C:\\GAME\\SAVE.DAT'.length + 1, 'and this one counts the terminator');
    assert.equal(memory.dword(OUT_TEXT), 0, 'nothing was written into it');
});

test('the current directory is read and set through the same two-call protocol', ()=>{
    const { memory, error, files, fns, at } = setup();

    assert.equal(fns.GetCurrentDirectoryA.handler([2, OUT_TEXT]), 'C:\\GAME'.length + 1);
    assert.equal(fns.GetCurrentDirectoryA.handler([0x40, OUT_TEXT]), 'C:\\GAME'.length);
    assert.equal(memory.string(OUT_TEXT), 'C:\\GAME');

    assert.equal(fns.SetCurrentDirectoryA.handler([at(NAME, 'C:\\NOWHERE')]), 0);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND);

    files.mkdir('C:\\GAME\\DATA');
    assert.equal(fns.SetCurrentDirectoryA.handler([at(NAME, 'DATA')]), 1);
    assert.equal(files.currentDirectory(), 'C:\\GAME\\DATA');
});

test('GetTempPathA ends in a separator, because callers concatenate onto it', ()=>{
    const { memory, fns } = setup();

    const written = fns.GetTempPathA.handler([0x40, OUT_TEXT]);

    assert.ok(memory.string(OUT_TEXT).endsWith('\\'));
    assert.equal(written, memory.string(OUT_TEXT).length);
});

test('a search with nothing to match is not the same as nowhere to look', ()=>{
    const { error, fns, at } = setup();

    assert.equal(fns.FindFirstFileA.handler([at(NAME, 'C:\\GAME\\*.SAV'), FIND_DATA]),
        INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);

    assert.equal(fns.FindFirstFileA.handler([at(NAME, 'C:\\NOWHERE\\*.SAV'), FIND_DATA]),
        INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND);
});

test('a search runs out with its own code, not with a general failure', ()=>{
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\A.SAV', 'a');
    files.put('C:\\GAME\\B.SAV', 'bb');
    files.put('C:\\GAME\\C.DAT', 'ccc');

    const handle = fns.FindFirstFileA.handler([at(NAME, 'C:\\GAME\\*.SAV'), FIND_DATA]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);

    assert.equal(fns.FindNextFileA.handler([handle, FIND_DATA]), 1);
    assert.equal(fns.FindNextFileA.handler([handle, FIND_DATA]), 0, 'two matched, not three');
    assert.equal(error.code, ERROR_NO_MORE_FILES);
    assert.equal(fns.FindClose.handler([handle]), 1);
    assert.equal(fns.FindNextFileA.handler([handle, FIND_DATA]), 0, 'and the handle is gone');
});

test('a search handle is not a file handle', ()=>{
    const { files, fns, at, open } = setup();
    files.put('C:\\GAME\\A.SAV', 'a');
    const search = fns.FindFirstFileA.handler([at(NAME, 'C:\\GAME\\*.SAV'), FIND_DATA]);
    const file = open('C:\\GAME\\A.SAV', OPEN_EXISTING);

    assert.equal(fns.ReadFile.handler([search, BUFFER, 1, OUT_COUNT, 0]), 0,
        'a search cannot be read from');
    assert.equal(fns.FindClose.handler([file]), 0, 'and a file cannot be enumerated');
});

test('WIN32_FIND_DATAA is laid out where the guest declared it', ()=>{
    // Pinned to the numbers rather than to each other: a field read through the
    // same constant that placed it agrees with itself wherever it lands, and
    // the guest is the only one who would notice.
    assert.deepEqual({ ...WIN32_FIND_DATAA }, {
        dwFileAttributes: 0,
        ftCreationTime: 4,
        ftLastAccessTime: 12,
        ftLastWriteTime: 20,
        nFileSizeHigh: 28,
        nFileSizeLow: 32,
        dwReserved0: 36,
        dwReserved1: 40,
        cFileName: 44,
        cAlternateFileName: 304,
        SIZE: 320,
    });
});

test('WIN32_FIND_DATAA is filled in where the guest reads it', ()=>{
    const { memory, files, fns, at } = setup();
    files.put('C:\\GAME\\A.SAV', 'abcde');
    memory.bytes.fill(0xcc, FIND_DATA, FIND_DATA + WIN32_FIND_DATAA.SIZE);

    fns.FindFirstFileA.handler([at(NAME, 'C:\\GAME\\A.SAV'), FIND_DATA]);

    assert.equal(memory.dword(FIND_DATA + WIN32_FIND_DATAA.dwFileAttributes), 0x20);
    assert.equal(memory.dword(FIND_DATA + WIN32_FIND_DATAA.nFileSizeLow), 5);
    assert.equal(memory.dword(FIND_DATA + WIN32_FIND_DATAA.nFileSizeHigh), 0);
    assert.equal(memory.string(FIND_DATA + WIN32_FIND_DATAA.cFileName), 'A.SAV',
        'the name alone, not the path it was found under');
    assert.equal(memory.dword(FIND_DATA + WIN32_FIND_DATAA.ftLastWriteTime), 0,
        'what we do not know is zeroed rather than left as it was');
    assert.equal(memory.bytes[FIND_DATA + WIN32_FIND_DATAA.cAlternateFileName], 0);
});

test('every function declares the stack it pops', ()=>{
    const { fns } = setup();
    // stdcall: the callee cleans up, so a wrong count corrupts the guest stack
    // silently. These are the documented signatures, in bytes.
    assert.equal(fns.CreateFileA.argBytes, 28);
    assert.equal(fns.ReadFile.argBytes, 20);
    assert.equal(fns.WriteFile.argBytes, 20);
    assert.equal(fns.SetFilePointer.argBytes, 16);
    // Its LARGE_INTEGER is passed by value, which is eight of these twenty.
    assert.equal(fns.SetFilePointerEx.argBytes, 20);
    assert.equal(fns.SetEndOfFile.argBytes, 4);
    assert.equal(fns.FlushFileBuffers.argBytes, 4);
    assert.equal(fns.GetFileSize.argBytes, 8);
    assert.equal(fns.GetFileSizeEx.argBytes, 8);
    assert.equal(fns.CloseHandle.argBytes, 4);
    assert.equal(fns.DeleteFileA.argBytes, 4);
    assert.equal(fns.MoveFileA.argBytes, 8);
    assert.equal(fns.CopyFileA.argBytes, 12);
    assert.equal(fns.CreateDirectoryA.argBytes, 8);
    assert.equal(fns.RemoveDirectoryA.argBytes, 4);
    assert.equal(fns.GetFileAttributesA.argBytes, 4);
    assert.equal(fns.SetFileAttributesA.argBytes, 8);
    assert.equal(fns.GetFullPathNameA.argBytes, 16);
    assert.equal(fns.GetCurrentDirectoryA.argBytes, 8);
    assert.equal(fns.SetCurrentDirectoryA.argBytes, 4);
    assert.equal(fns.GetTempPathA.argBytes, 8);
    assert.equal(fns.FindFirstFileA.argBytes, 8);
    assert.equal(fns.FindNextFileA.argBytes, 8);
    assert.equal(fns.FindClose.argBytes, 4);
});
