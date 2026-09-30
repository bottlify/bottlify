/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileFunctions, WIN32_FIND_DATAA } from './files.js';
import { HANDLE_STDOUT } from './console.js';
import { decodeAnsi } from './locale.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NO_MORE_FILES = 18;
const ERROR_FILE_EXISTS = 80;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NEGATIVE_SEEK = 131;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_NOT_SUPPORTED = 50;

/** What the old file family answers with when it fails. */
const HFILE_ERROR = 0xffffffff;

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
const OUT_PATH = 0x400;
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
    /** What SetFileAttributes recorded, as the volume adapter records it. @type {Map<string, number>} */
    const attributes = new Map();
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
                ? { exists: true, isDirectory: node.directory, size: node.data.length,
                    ...attributes.has(path) ? { attributes: attributes.get(path) } : {} }
                : null;
        },
        /** @param {string} path @param {number | null} value */
        setAttributes(path, value){
            if (!nodes.has(path))
            {
                return false;
            }
            if (value === null)
            {
                attributes.delete(path);
            }
            else
            {
                attributes.set(path, value);
            }
            return true;
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
        /** @param {{ path: string }} node */
        close: node=>{
            void node;
        },
        /** @param {string} path */
        remove(path){
            const node = nodes.get(path);
            if (node?.directory && [...nodes.keys()].some(key=>key.startsWith(path + '\\')))
            {
                return false;
            }
            attributes.delete(path);
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
            if (attributes.has(from))
            {
                attributes.set(to, /** @type {number} */ (attributes.get(from)));
                attributes.delete(from);
            }
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
        typeOf(handle){
            return entries.get(handle)?.type;
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
        /** @param {any} object */
        holds: object=>[...entries.values()].some(entry=>entry.object === object),
    };
}

/** @param {Record<string, any>} [extra]  More of the host, for the calls that need it. */
function setup(extra = {}){
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
        // The memory layer's contract: the limit counts bytes, and a string
        // with no terminator inside it throws.
        /** @param {number} address @param {number} maxLength */
        readWideString: (address, maxLength)=>{
            let text = '';
            for (let at = 0; at + 1 < maxLength; at += 2)
            {
                const code = memory.bytes[address + at] | memory.bytes[address + at + 1] << 8;
                if (code === 0)
                {
                    return text;
                }
                text += String.fromCharCode(code);
            }
            throw new Error(`No wide NUL within ${maxLength} bytes of 0x${address.toString(16)}`);
        },
        files,
        setLastError: code=>{
            error.code = code;
        },
        writeConsole: (handle, text)=>console.push({ handle, text }),
        handles,
        ...extra,
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

test('a name past MAX_PATH is read whole, not cut at 260 characters', ()=>{
    const { files, fns, at } = setup();
    const long = 'C:\\GAME\\' + 'x'.repeat(300) + '.DAT';
    const cut = long.slice(0, 260);
    files.put(cut, 'the wrong file');
    assert.equal(fns.CreateFileA.handler(
        [at(NAME, long), GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]), INVALID_HANDLE_VALUE,
    'the first 260 characters name another file');
});

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
    // The volume holds what it held plus the machine's own five directories.
    assert.equal(files.nodes.size, 7, 'nothing was created for it');
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

test('a write from a null buffer is refused, a zero-length one is not', ()=>{
    const { memory, files, error, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putDword(OUT_COUNT, 0xdeadbeef);
    assert.equal(fns.WriteFile.handler([handle, 0, 10, OUT_COUNT, 0]), 0);
    assert.equal(error.code, 1784, 'ERROR_INVALID_USER_BUFFER');
    assert.equal(memory.dword(OUT_COUNT), 0);
    assert.equal(files.text('C:\\GAME\\SAVE.DAT'), 'abcd');
    assert.equal(fns.WriteFile.handler([handle, 0, 0, OUT_COUNT, 0]), 1);

    memory.putDword(OUT_COUNT, 0xdeadbeef);
    assert.equal(fns.ReadFile.handler([handle, 0, 10, OUT_COUNT, 0]), 0);
    assert.equal(error.code, 998, 'ERROR_NOACCESS');
    assert.equal(memory.dword(OUT_COUNT), 0);
    assert.equal(fns.SetFilePointer.handler([handle, 0, 0, FILE_CURRENT]), 0, 'nothing consumed');
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
    const { handles, fns, files, open } = setup();
    const event = handles.open('event', { signalled: false });

    assert.equal(fns.CloseHandle.handler([event]), 1,
        'one handle space means one CloseHandle');
    assert.equal(handles.has(event), false);

    // A mapping over an open file carries the file's node; closing the
    // mapping leaves the file open for its own close.
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const file = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    const mapping = handles.open('mapping', { node: handles.resolve(file).node, size: 4 });
    assert.equal(fns.CloseHandle.handler([mapping]), 1);
    assert.equal(fns.CloseHandle.handler([file]), 1, 'the file was still open');
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

test('a copy from a bundle\'s file waits for its blocks and copies the whole of it', async()=>{
    // A file a bundle has not fetched yet answers a read with a promise. The
    // copy parks until the bytes come and goes on from there; it was refused
    // with ERROR_ACCESS_DENIED -- a setup copying its own files to a temporary
    // directory said it could not transfer them from the media -- and the
    // source was closed under the read still fetching it.
    /** @type {{ thread: any, code: number }[]} */
    const answered = [];
    const thread = { name: 'main' };
    const { error, files, fns, at } = setup({
        currentThread: ()=>thread,
        setLastErrorFor: (/** @type {any} */ who, /** @type {number} */ code)=>
            answered.push({ thread: who, code }),
    });
    files.put('C:\\SETUP\\AUTORUN.BMP', 'BM a banner from the media');
    /** @type {string[]} */
    const closed = [];
    const read = files.read;
    let pending = 0;
    files.read = (node, offset, length)=>{
        const bytes = read(node, offset, length);
        if (node.path !== 'C:\\SETUP\\AUTORUN.BMP')
        {
            return bytes;
        }
        pending++;
        return Promise.resolve().then(()=>{
            assert.equal(closed.includes(node.path), false, 'the source is open while it is read');
            pending--;
            return bytes;
        });
    };
    const close = files.close;
    files.close = node=>{
        closed.push(node.path);
        close(node);
    };
    error.code = 0xdead;

    const copied = fns.CopyFileA.handler(
        [at(NAME, 'C:\\SETUP\\AUTORUN.BMP'), at(NAME2, 'C:\\WINDOWS\\AUTORUN.BMP'), 0]);
    assert.equal(typeof (/** @type {any} */ (copied))?.then, 'function', 'the caller is parked');
    assert.equal(await copied, 1);
    assert.equal(pending, 0);
    assert.equal(files.text('C:\\WINDOWS\\AUTORUN.BMP'), 'BM a banner from the media');
    assert.deepEqual(closed.sort(), ['C:\\SETUP\\AUTORUN.BMP', 'C:\\WINDOWS\\AUTORUN.BMP']);
    assert.deepEqual(answered, [{ thread, code: ERROR_SUCCESS }],
        'the success is the parked thread\'s own');
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

test('SearchPathA walks the documented order, adds an extension, and reports the file part', ()=>{
    const { memory, fns, files, at } = setup();
    files.put('C:\\WINDOWS\\system32\\cabinet.dll', 'x');
    files.put('C:\\GAME\\local.dat', 'y');
    memory.putDword(OUT_PART, 0);

    const written = fns.SearchPathA.handler(
        [0, at(NAME, 'cabinet'), at(NAME + 0x40, '.dll'), 0x80, OUT_TEXT, OUT_PART]);
    assert.equal(memory.string(OUT_TEXT), 'C:\\WINDOWS\\system32\\cabinet.dll');
    assert.equal(written, 'C:\\WINDOWS\\system32\\cabinet.dll'.length);
    assert.equal(memory.string(memory.dword(OUT_PART)), 'cabinet.dll');

    assert.equal(fns.SearchPathA.handler([0, at(NAME, 'local.dat'), 0, 0x80, OUT_TEXT, 0]),
        'C:\\GAME\\local.dat'.length, 'the current directory is on the path');
    assert.equal(fns.SearchPathA.handler(
        [at(NAME + 0x80, 'C:\\NOWHERE;C:\\WINDOWS\\system32'), at(NAME, 'cabinet.dll'), 0,
            0x80, OUT_TEXT, 0]), 'C:\\WINDOWS\\system32\\cabinet.dll'.length,
    'a list given is searched in order');
    assert.equal(fns.SearchPathA.handler([0, at(NAME, 'absent.dll'), 0, 0x80, OUT_TEXT, 0]), 0);
    assert.equal(fns.SearchPathA.handler([0, at(NAME, 'local.dat'), 0, 4, OUT_TEXT, 0]),
        'C:\\GAME\\local.dat'.length + 1, 'too small: the size needed, terminator included');
    assert.equal(fns.SearchPathA.argBytes, 24);

    const wide = fns.SearchPathW.handler(
        [0, putWide(memory, NAME, 'cabinet.dll'), 0, 0x80, OUT_TEXT, OUT_PART]);
    assert.equal(wide, 'C:\\WINDOWS\\system32\\cabinet.dll'.length, 'the wide twin');
    assert.equal(memory.dword(OUT_PART), OUT_TEXT + 'C:\\WINDOWS\\system32\\'.length * 2,
        'and its file part is in characters of two bytes');
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

    // A drive named without a separator is that drive's own current
    // directory, not a path under it: the walk an installer does up a
    // directory it means to create ends at "C:", and a refusal there is
    // read as the whole path being invalid.
    assert.equal(fns.SetCurrentDirectoryA.handler([at(NAME, 'C:')]), 1);
    assert.equal(files.currentDirectory(), 'C:\\GAME\\DATA');

    files.mkdir('C:\\GAME\\DATA\\SUB');
    assert.equal(fns.SetCurrentDirectoryA.handler([at(NAME, 'C:SUB')]), 1,
        'and a drive-relative path starts from there, not from the root');
    assert.equal(files.currentDirectory(), 'C:\\GAME\\DATA\\SUB');
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

test('FindFirstFileEx searches as FindFirstFile does, at either level, in both spellings', ()=>{
    const FIND_EX_INFO_BASIC = 1;
    const FIND_EX_SEARCH_LIMIT_TO_DIRECTORIES = 1;
    const FIND_FIRST_EX_LARGE_FETCH = 2;
    const { files, memory, error, fns, at } = setup();
    files.put('C:\\GAME\\A.SAV', 'a');
    files.put('C:\\GAME\\B.SAV', 'bb');

    const handle = fns.FindFirstFileExA.handler(
        [at(NAME, 'C:\\GAME\\*.SAV'), FIND_EX_INFO_BASIC, FIND_DATA, 0, 0,
            FIND_FIRST_EX_LARGE_FETCH]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    assert.equal(memory.string(FIND_DATA + 44), 'A.SAV');
    assert.equal(fns.FindNextFileA.handler([handle, FIND_DATA]), 1, 'the handle is a search');
    assert.equal(memory.string(FIND_DATA + 44), 'B.SAV');
    fns.FindClose.handler([handle]);

    // Limiting to directories is advice a file system may not take.
    const wide = fns.FindFirstFileExW.handler([putWide(memory, NAME, 'C:\\GAME\\*'), 0,
        FIND_DATA, FIND_EX_SEARCH_LIMIT_TO_DIRECTORIES, 0, 0]);
    assert.notEqual(wide, INVALID_HANDLE_VALUE);
    fns.FindClose.handler([wide]);

    assert.equal(fns.FindFirstFileExA.handler(
        [at(NAME, 'C:\\GAME\\*.SAV'), 0, FIND_DATA, 0, 0x1234, 0]), INVALID_HANDLE_VALUE,
    'no search filter is defined');
    assert.equal(error.code, ERROR_INVALID_PARAMETER);
    assert.equal(fns.FindFirstFileExA.handler(
        [at(NAME, 'C:\\GAME\\*.SAV'), 2, FIND_DATA, 0, 0, 0]), INVALID_HANDLE_VALUE,
    'nor a third level');
    assert.equal(fns.FindFirstFileExA.handler(
        [at(NAME, 'C:\\NOWHERE\\*'), 0, FIND_DATA, 0, 0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND);
    assert.equal(fns.FindFirstFileExA.argBytes, 24);
    assert.equal(fns.FindFirstFileExW.argBytes, 24);
});

test('LockFileEx and UnlockFileEx take a range out of an OVERLAPPED, as LockFile takes one', ()=>{
    const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
    const LOCKFILE_FAIL_IMMEDIATELY = 0x1;
    const OVERLAPPED = 0x700;
    const { files, error, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'x');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);

    assert.equal(fns.LockFileEx.handler([handle,
        LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 16, 0, OVERLAPPED]), 1);
    assert.equal(fns.UnlockFileEx.handler([handle, 0, 16, 0, OVERLAPPED]), 1);

    assert.equal(fns.LockFileEx.handler([handle, 0, 1, 16, 0, OVERLAPPED]), 0,
        'the reserved word must be zero');
    assert.equal(error.code, ERROR_INVALID_PARAMETER);
    assert.equal(fns.UnlockFileEx.handler([handle, 1, 16, 0, OVERLAPPED]), 0);
    assert.equal(error.code, ERROR_INVALID_PARAMETER);
    assert.equal(fns.LockFileEx.handler([handle, 0, 0, 16, 0, 0]), 0, 'the range is in it');
    assert.equal(error.code, ERROR_INVALID_PARAMETER);
    assert.equal(fns.LockFileEx.handler([0x1234, 0, 0, 16, 0, OVERLAPPED]), 0);
    assert.equal(error.code, ERROR_INVALID_HANDLE);
    assert.equal(fns.LockFileEx.argBytes, 24);
    assert.equal(fns.UnlockFileEx.argBytes, 20);
});

test('ReadFileEx reads at the OVERLAPPED\'s offset and queues its routine to the caller', ()=>{
    // Wine's file and pipe tests: the completion routine is not called before
    // ReadFileEx returns -- it is an APC, run at the thread's next alertable
    // wait -- with the error, the count and the OVERLAPPED; Internal and
    // InternalHigh are already written for GetOverlappedResult, and hEvent is
    // the program's own and left alone.
    const OVERLAPPED = 0x700;
    const ROUTINE = 0x401000;
    const thread = { id: 1 };
    /** @type {any[][]} */
    const queued = [];
    const { memory, files, fns, open } = setup({
        currentThread: ()=>thread,
        queueApc: (/** @type {any} */ to, /** @type {number} */ routine,
            /** @type {number[]} */ args)=>queued.push([to, routine, args]),
    });
    files.put('C:\\GAME\\SAVE.DAT', 'abcdef');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putDword(OVERLAPPED, 0xdeadbeef);
    memory.putDword(OVERLAPPED + 4, 0xdeadbeef);
    memory.putDword(OVERLAPPED + 8, 2);
    memory.putDword(OVERLAPPED + 12, 0);
    memory.putDword(OVERLAPPED + 16, 0x1234);

    assert.equal(fns.ReadFileEx.handler([handle, BUFFER, 3, OVERLAPPED, ROUTINE]), 1);
    assert.equal(String.fromCharCode(...memory.bytes.subarray(BUFFER, BUFFER + 3)), 'cde');
    assert.deepEqual(queued, [[thread, ROUTINE, [0, 3, OVERLAPPED]]]);
    assert.equal(memory.dword(OVERLAPPED), 0, 'Internal: the status');
    assert.equal(memory.dword(OVERLAPPED + 4), 3, 'InternalHigh: the count');
    assert.equal(memory.dword(OVERLAPPED + 16), 0x1234, 'hEvent untouched');
    assert.equal(fns.ReadFileEx.argBytes, 20);
});

test('ReadFileEx at the end of the file fails and queues nothing', ()=>{
    // The loop in Wine's file test reads until ReadFileEx fails, and checks the
    // routine ran only for the reads that succeeded.
    const ERROR_HANDLE_EOF = 38;
    const OVERLAPPED = 0x700;
    /** @type {any[][]} */
    const queued = [];
    const { memory, files, error, fns, open } = setup({
        currentThread: ()=>({}),
        queueApc: (/** @type {any[]} */ ...args)=>queued.push(args),
    });
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putDword(OVERLAPPED + 8, 4);

    assert.equal(fns.ReadFileEx.handler([handle, BUFFER, 16, OVERLAPPED, 0x401000]), 0);
    assert.equal(error.code, ERROR_HANDLE_EOF);
    assert.deepEqual(queued, []);
    assert.equal(fns.ReadFileEx.handler([0x1234, BUFFER, 16, OVERLAPPED, 0x401000]), 0);
    assert.equal(error.code, ERROR_INVALID_HANDLE);
    assert.equal(fns.ReadFileEx.handler([handle, BUFFER, 16, 0, 0x401000]), 0,
        'there is no offset without an OVERLAPPED');
    assert.equal(error.code, ERROR_INVALID_PARAMETER);
});

test('WriteFileEx writes at the OVERLAPPED\'s offset and queues its routine', ()=>{
    const OVERLAPPED = 0x700;
    const ROUTINE = 0x401000;
    const thread = { id: 1 };
    /** @type {any[][]} */
    const queued = [];
    const { memory, files, fns, open } = setup({
        currentThread: ()=>thread,
        queueApc: (/** @type {any} */ to, /** @type {number} */ routine,
            /** @type {number[]} */ args)=>queued.push([to, routine, args]),
    });
    files.put('C:\\GAME\\SAVE.DAT', 'abcdef');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putString(BUFFER, 'XY');
    memory.putDword(OVERLAPPED + 8, 4);

    assert.equal(fns.WriteFileEx.handler([handle, BUFFER, 2, OVERLAPPED, ROUTINE]), 1);
    assert.equal(files.text('C:\\GAME\\SAVE.DAT'), 'abcdXY');
    assert.deepEqual(queued, [[thread, ROUTINE, [0, 2, OVERLAPPED]]]);
    assert.equal(memory.dword(OVERLAPPED + 4), 2);
    assert.equal(fns.WriteFileEx.argBytes, 20);
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
    // An entry the fake stamps with no time reads as the FILETIME of the
    // epoch, not as an uninitialised zero: every time here is a real one.
    assert.equal(memory.dword(FIND_DATA + WIN32_FIND_DATAA.ftLastWriteTime), 0xd53e8000);
    assert.equal(memory.dword(FIND_DATA + WIN32_FIND_DATAA.ftLastWriteTime + 4), 0x019db1de,
        'the epoch as a FILETIME, not an uninitialised zero');
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

/**
 * Plants UTF-16 text where a wide entry point will read it.
 *
 * @param {any} memory @param {number} at @param {string} text
 */
function putWide(memory, at, text){
    for (let index = 0; index < text.length; index++)
    {
        const code = text.charCodeAt(index);
        memory.bytes[at + index * 2] = code & 0xff;
        memory.bytes[at + index * 2 + 1] = code >> 8;
    }
    memory.bytes[at + text.length * 2] = 0;
    memory.bytes[at + text.length * 2 + 1] = 0;
    return at;
}

test('a file made one spelling is found by the other', ()=>{
    // The property the shared bodies exist for. Two implementations of one
    // operation drift, and the drift shows up as a file that opens one way and
    // not the other -- which is invisible until a program mixes the two, and
    // every C runtime does.
    const { memory, fns, at } = setup();

    const handle = fns.CreateFileW.handler(
        [putWide(memory, NAME, 'C:\\GAME\\WIDE.DAT'), GENERIC_WRITE, 0, 0, CREATE_ALWAYS, 0, 0]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    fns.CloseHandle.handler([handle]);

    assert.notEqual(fns.GetFileAttributesA.handler([at(NAME, 'C:\\GAME\\WIDE.DAT')]),
        0xffffffff, 'the ANSI form sees what the wide form made');
    assert.equal(fns.DeleteFileW.handler([putWide(memory, NAME, 'C:\\GAME\\WIDE.DAT')]), 1);
    assert.equal(fns.GetFileAttributesA.handler([at(NAME, 'C:\\GAME\\WIDE.DAT')]), 0xffffffff);
});

test('MoveFileExW is the same move in wide names, flags and all', ()=>{
    const { files, memory, fns, error } = setup();
    files.put('C:\\GAME\\NEW.DLL', 'fresh');
    files.put('C:\\GAME\\OLD.DLL', 'stale');
    const from = putWide(memory, NAME, 'C:\\GAME\\NEW.DLL');
    const to = putWide(memory, NAME2, 'C:\\GAME\\OLD.DLL');

    assert.equal(fns.MoveFileExW.handler([from, to, 0]), 0, 'no overwrite without the flag');
    assert.equal(error.code, ERROR_ALREADY_EXISTS);
    assert.equal(fns.MoveFileExW.handler([from, to, 1]), 1);
    assert.equal(files.text('C:\\GAME\\OLD.DLL'), 'fresh');
    assert.equal(files.stat('C:\\GAME\\NEW.DLL')?.exists, undefined);
    assert.equal(fns.MoveFileExW.argBytes, 12);
});

test('a wide directory listing writes twice as wide a name, at the same offset', ()=>{
    // WIN32_FIND_DATAW shares every offset up to cFileName with the ANSI form
    // and then does not, which is exactly why the tail is easy to get wrong.
    const { memory, files, fns } = setup();
    files.put('C:\\GAME\\ONE.DAT', 'x');
    // Marked past the end of the ANSI structure, so a short write shows: every
    // offset up to cFileName is shared between the two forms, and the tail is
    // the only place the difference is visible at all.
    memory.bytes.fill(0xee, 0x600 + 320, 0x600 + 600);

    const search = fns.FindFirstFileW.handler(
        [putWide(memory, NAME, 'C:\\GAME\\*'), 0x600]);
    assert.notEqual(search, INVALID_HANDLE_VALUE);

    // cFileName is at 44 in both forms; here it is UTF-16.
    const name = [];
    for (let at2 = 0x600 + 44; memory.bytes[at2] !== 0; at2 += 2)
    {
        name.push(String.fromCharCode(memory.bytes[at2] | memory.bytes[at2 + 1] << 8));
    }
    assert.equal(name.join(''), 'ONE.DAT');
    assert.equal(memory.bytes[0x600 + 591], 0, 'the last byte of the wide form is written');
    assert.equal(memory.bytes[0x600 + 592], 0xee, 'and nothing beyond it is');
    fns.FindClose.handler([search]);
});

test('GetFullPathNameW keeps a trailing separator the caller wrote', ()=>{
    // Resolution strips it; a caller that wrote one meant a directory and uses
    // the NULL file part to tell the two apart.
    const { memory, fns } = setup();
    const written = fns.GetFullPathNameW.handler(
        [putWide(memory, NAME, 'C:\\GAME\\DATA\\'), 64, 0x600, 0x900]);

    const text = [];
    for (let at2 = 0x600; memory.bytes[at2] !== 0 || memory.bytes[at2 + 1] !== 0; at2 += 2)
    {
        text.push(String.fromCharCode(memory.bytes[at2] | memory.bytes[at2 + 1] << 8));
    }
    assert.equal(text.join(''), 'C:\\GAME\\DATA\\');
    assert.equal(written, 13);
});

// --- the file family a self-extractor uses ---

test('_lopen and _lread read a file the old way', ()=>{
    // A self-extractor of this era opens with these rather than with
    // CreateFile, and the handle it gets back is the same kind of handle: a
    // program that opens with _lopen and closes with CloseHandle is doing
    // something Windows allows, and two kinds of handle would leak.
    const { files, memory, fns, at } = setup();
    files.put('C:\\GAME\\DATA.BIN', 'payload');

    const handle = fns._lopen.handler([at(NAME, 'C:\\GAME\\DATA.BIN'), 0]);
    assert.notEqual(handle, HFILE_ERROR);
    assert.equal(fns._lread.handler([handle, BUFFER, 7]), 7);
    assert.equal(memory.string(BUFFER), 'payload');
    assert.equal(fns._lclose.handler([handle]), 0, 'zero is success here, unlike CloseHandle');
});

test('_hread and _hwrite are _lread and _lwrite under their long names', ()=>{
    // Fallout's installer library reads its data with _hread; on Win32 the two
    // spellings are one call, every count 32 bits.
    const { files, memory, fns, at } = setup();
    files.put('C:\\GAME\\DATA.BIN', 'payload');
    const handle = fns._lopen.handler([at(NAME, 'C:\\GAME\\DATA.BIN'), 0]);
    assert.equal(fns._hread, fns._lread);
    assert.equal(fns._hwrite, fns._lwrite);
    assert.equal(fns._hread.handler([handle, BUFFER, 7]), 7);
    assert.equal(memory.string(BUFFER), 'payload');
});

test('_lclose hands the file back to the volume, as CloseHandle does', ()=>{
    // A create-and-close followed by an open for writing is how a
    // self-extractor takes a scratch file. With the handle closed and the file
    // still held underneath, that open was refused as shared with nobody.
    const { files, fns, at } = setup();
    /** @type {string[]} */
    const released = [];
    files.close = (/** @type {{ path: string }} */ node)=>{
        released.push(node.path);
    };

    const handle = fns._lcreat.handler([at(NAME, 'C:\\GAME\\SCRATCH.TMP'), 0]);
    assert.notEqual(handle, HFILE_ERROR);
    assert.equal(fns._lclose.handler([handle]), 0);
    assert.deepEqual(released, ['C:\\GAME\\SCRATCH.TMP']);
    assert.notEqual(fns._lopen.handler([at(NAME, 'C:\\GAME\\SCRATCH.TMP'), 2]), HFILE_ERROR,
        'and the name opens again for writing');
});

test('the temporary directory exists before a program asks for it', ()=>{
    // GetTempPath names it and an installer creates its first file there
    // without looking; a machine on which the promised directory is missing
    // answers that create with "access denied".
    const { files, fns, memory, at } = setup();
    assert.ok(files.stat('C:\\WINDOWS\\TEMP')?.isDirectory);

    assert.notEqual(fns.GetTempFileNameA.handler([0, at(NAME, 'GLC'), 0, BUFFER]), 0);
    const path = memory.string(BUFFER);
    assert.ok(path.startsWith('C:\\WINDOWS\\TEMP\\GLC'), path);
    assert.ok(files.stat(path)?.exists, 'the name is reserved by a file');
    assert.notEqual(fns._lopen.handler([at(NAME, path), 2]), HFILE_ERROR,
        'which the caller can open for writing: the reservation did not hold it open');
});

test('the profile\'s directories exist before a program asks for them', ()=>{
    // The registry, the environment and SHGetFolderPath all name them, and a
    // program makes its own directory inside one without looking: with the
    // folder missing, CreateDirectory fails with ERROR_PATH_NOT_FOUND.
    const APPDATA = 'C:\\Users\\User\\AppData\\Roaming';
    const { files, fns, at } = setup({ directories: ['C:\\Users', 'C:\\Users\\User',
        'C:\\Users\\User\\AppData', APPDATA] });
    assert.ok(files.stat(APPDATA)?.isDirectory);

    assert.equal(fns.CreateDirectoryA.handler([at(NAME, `${APPDATA}\\Title`), 0]), 1);
    assert.ok(files.stat(`${APPDATA}\\Title`)?.isDirectory);
});

test('_lopen refuses a file that is not there', ()=>{
    const { fns, error, at } = setup();
    assert.equal(fns._lopen.handler([at(NAME, 'C:\\GAME\\NOPE.BIN'), 0]), HFILE_ERROR);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);
});

test('_lcreat always truncates, which is what an unpack relies on', ()=>{
    // A second pass over the same name must find an empty file rather than the
    // tail of the first one.
    const { files, memory, fns, at } = setup();
    files.put('C:\\GAME\\OUT.BIN', 'a long previous payload');

    const handle = fns._lcreat.handler([at(NAME, 'C:\\GAME\\OUT.BIN'), 0]);
    assert.notEqual(handle, HFILE_ERROR);
    memory.putString(BUFFER, 'new');
    assert.equal(fns._lwrite.handler([handle, BUFFER, 3]), 3);
    fns._lclose.handler([handle]);

    assert.equal(files.text('C:\\GAME\\OUT.BIN'), 'new');
});

test('_llseek moves by all three origins and reports where it landed', ()=>{
    const { files, memory, fns, at } = setup();
    files.put('C:\\GAME\\DATA.BIN', '0123456789');
    const handle = fns._lopen.handler([at(NAME, 'C:\\GAME\\DATA.BIN'), 0]);

    assert.equal(fns._llseek.handler([handle, 4, 0]), 4, 'from the beginning');
    assert.equal(fns._lread.handler([handle, BUFFER, 2]), 2);
    assert.equal(memory.string(BUFFER).slice(0, 2), '45');

    assert.equal(fns._llseek.handler([handle, 1, 1]), 7, 'from where it stands');
    // Backwards from the end is how a program reads a trailer, and the offset
    // is signed -- read as unsigned it would seek past four gigabytes.
    assert.equal(fns._llseek.handler([handle, -3, 2]), 7, 'from the end');
    assert.equal(fns._lread.handler([handle, BUFFER, 3]), 3);
    assert.equal(memory.string(BUFFER).slice(0, 3), '789');
});

test('_llseek before the beginning fails rather than wrapping', ()=>{
    const { files, fns, error, at } = setup();
    files.put('C:\\GAME\\DATA.BIN', '0123456789');
    const handle = fns._lopen.handler([at(NAME, 'C:\\GAME\\DATA.BIN'), 0]);

    assert.equal(fns._llseek.handler([handle, -1, 0]), HFILE_ERROR);
    assert.equal(error.code, ERROR_NEGATIVE_SEEK);
});

test('the old family refuses a handle that is not one', ()=>{
    const { fns, error } = setup();
    assert.equal(fns._lread.handler([0x1234, BUFFER, 4]), HFILE_ERROR);
    assert.equal(fns._lclose.handler([0x1234]), HFILE_ERROR);
    assert.equal(error.code, ERROR_INVALID_HANDLE);
});

// --- where a self-extractor unpacks itself ---

test('GetTempFileNameA creates the file when asked to pick the name', ()=>{
    // A zero uUnique is how a caller reserves a name against anyone else taking
    // it, and it then opens that name expecting it to exist.
    const { files, memory, fns, error, at } = setup();

    const number = fns.GetTempFileNameA.handler(
        [at(NAME, 'C:\\GAME'), at(NAME2, 'WZ'), 0, OUT_PATH]);
    assert.notEqual(number, 0);
    assert.equal(error.code, ERROR_SUCCESS);

    const path = memory.string(OUT_PATH);
    assert.match(path, /^C:\\GAME\\WZ[0-9A-F]+\.tmp$/);
    assert.ok(files.stat(path)?.exists, 'the name was reserved by creating it');
});

test('a second GetTempFileNameA does not hand back the first name', ()=>{
    // The whole reason a caller asks twice.
    const { memory, fns, at } = setup();

    fns.GetTempFileNameA.handler([at(NAME, 'C:\\GAME'), at(NAME2, 'WZ'), 0, OUT_PATH]);
    const first = memory.string(OUT_PATH);
    fns.GetTempFileNameA.handler([at(NAME, 'C:\\GAME'), at(NAME2, 'WZ'), 0, OUT_PATH]);

    assert.notEqual(memory.string(OUT_PATH), first);
});

test('a chosen uUnique builds the name and creates nothing', ()=>{
    const { files, memory, fns, at } = setup();

    assert.equal(
        fns.GetTempFileNameA.handler([at(NAME, 'C:\\GAME'), at(NAME2, 'AB'), 0x41, OUT_PATH]),
        0x41, 'the number comes back so a caller can build the next one');
    const path = memory.string(OUT_PATH);
    assert.equal(path, 'C:\\GAME\\AB41.tmp');
    assert.equal(files.stat(path)?.exists, undefined, 'nothing was created');
});

test('GetTempFileName spells the number in upper case before a lower-case .tmp', ()=>{
    // kernel32's file tests compare the name byte for byte: "abcA.tmp" for 0xA.
    const { memory, fns, at } = setup();

    assert.equal(
        fns.GetTempFileNameA.handler([at(NAME, 'C:\\GAME\\'), at(NAME2, 'abc'), 0xa, OUT_PATH]),
        0xa);
    assert.equal(memory.string(OUT_PATH), 'C:\\GAME\\abcA.tmp');
    assert.equal(
        fns.GetTempFileNameA.handler([at(NAME, 'C:\\GAME'), at(NAME2, 'abc'), 0x12345, OUT_PATH]),
        0x2345, 'only the low word of uUnique is the number');
    assert.equal(memory.string(OUT_PATH), 'C:\\GAME\\abc2345.tmp');
});

test('GetTempFileNameW is the same name in wide text, and creates the file for zero', ()=>{
    const { files, memory, fns } = setup();

    const number = fns.GetTempFileNameW.handler([putWide(memory, NAME, 'C:\\GAME'),
        putWide(memory, NAME2, 'wine'), 0, OUT_PATH]);
    assert.notEqual(number, 0);
    const path = wideAt(memory, OUT_PATH);
    assert.equal(path, `C:\\GAME\\win${number.toString(16).toUpperCase()}.tmp`,
        'three characters of the prefix, in wide text');
    assert.ok(files.stat(path)?.exists, 'the name was reserved by creating it');
    assert.equal(fns.GetTempFileNameW.argBytes, 16);
});

test('GetTempPathW zeroes what the path does not fill, and a short buffer whole', ()=>{
    // kernel32's path tests: the wide form clears the rest of the buffer after
    // the path, and a buffer too short for it is cleared as far as it goes,
    // where the ANSI form leaves both untouched.
    const { memory, fns } = setup();
    const expected = 'C:\\WINDOWS\\TEMP\\';

    memory.bytes.fill(0x61, OUT_TEXT, OUT_TEXT + 0x100);
    assert.equal(fns.GetTempPathW.handler([0x80, OUT_TEXT]), expected.length);
    assert.equal(wideAt(memory, OUT_TEXT), expected);
    assert.ok(memory.bytes.subarray(OUT_TEXT + expected.length * 2, OUT_TEXT + 0x100)
        .every(byte=>byte === 0), 'the rest of the buffer is zeroed');

    memory.bytes.fill(0x61, OUT_TEXT, OUT_TEXT + 0x100);
    assert.equal(fns.GetTempPathW.handler([4, OUT_TEXT]), expected.length + 1,
        'too short: the size wanted, terminator included');
    assert.ok(memory.bytes.subarray(OUT_TEXT, OUT_TEXT + 8).every(byte=>byte === 0),
        'the characters it was given are zeroed');
    assert.equal(memory.bytes[OUT_TEXT + 8], 0x61, 'and nothing past them');

    assert.equal(fns.GetTempPathW.handler([0, 0]), expected.length + 1);
    assert.equal(fns.GetTempPathW.argBytes, 8);
});

test('a wide path longer than half of MAX_PATH is read whole', ()=>{
    // The memory layer's limit counts bytes: a wide name read with MAX_PATH as
    // its limit stopped at 130 characters and threw. winmm's mmio tests delete
    // and create a name of 169 characters.
    const { files, memory, fns } = setup();
    const name = `C:\\GAME\\very_long_filename_${'x'.repeat(150)}`;

    const handle = fns.CreateFileW.handler(
        [putWide(memory, NAME, name), GENERIC_WRITE, 0, 0, CREATE_ALWAYS, 0, 0]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    fns.CloseHandle.handler([handle]);
    assert.ok(files.stat(name)?.exists);
    assert.equal(fns.DeleteFileW.handler([putWide(memory, NAME, name)]), 1);
});

/**
 * Reads UTF-16 text a wide entry point wrote.
 *
 * @param {any} memory @param {number} at
 */
function wideAt(memory, at){
    let text = '';
    for (let index = at; memory.bytes[index] !== 0 || memory.bytes[index + 1] !== 0; index += 2)
    {
        text += String.fromCharCode(memory.bytes[index] | memory.bytes[index + 1] << 8);
    }
    return text;
}

// --- putting an unpacked file in its place ---

test('MoveFileExA replaces an existing file when told to', ()=>{
    // A second install over the first replaces rather than failing, and without
    // this it stops on the first file it already wrote.
    const { files, fns, at } = setup();
    files.put('C:\\GAME\\NEW.DLL', 'fresh');
    files.put('C:\\GAME\\OLD.DLL', 'stale');

    assert.equal(
        fns.MoveFileExA.handler(
            [at(NAME, 'C:\\GAME\\NEW.DLL'), at(NAME2, 'C:\\GAME\\OLD.DLL'), 1]),
        1);
    assert.equal(files.text('C:\\GAME\\OLD.DLL'), 'fresh');
    assert.equal(files.stat('C:\\GAME\\NEW.DLL')?.exists, undefined);
});

test('MoveFileExA without the flag still refuses to overwrite', ()=>{
    const { files, fns, error, at } = setup();
    files.put('C:\\GAME\\NEW.DLL', 'fresh');
    files.put('C:\\GAME\\OLD.DLL', 'stale');

    assert.equal(
        fns.MoveFileExA.handler(
            [at(NAME, 'C:\\GAME\\NEW.DLL'), at(NAME2, 'C:\\GAME\\OLD.DLL'), 0]),
        0);
    assert.equal(error.code, ERROR_ALREADY_EXISTS);
    assert.equal(files.text('C:\\GAME\\OLD.DLL'), 'stale');
});

test('a move delayed until reboot is refused, not quietly accepted', ()=>{
    // There is no next start here. A caller told this succeeded would believe a
    // file it still needs has been scheduled to arrive.
    const { files, fns, error, at } = setup();
    files.put('C:\\GAME\\NEW.DLL', 'fresh');

    assert.equal(
        fns.MoveFileExA.handler(
            [at(NAME, 'C:\\GAME\\NEW.DLL'), at(NAME2, 'C:\\GAME\\OLD.DLL'), 4]),
        0);
    assert.equal(error.code, ERROR_NOT_SUPPORTED);
});

test('no device answers a control code', ()=>{
    const { fns, error } = setup();
    assert.equal(fns.DeviceIoControl.handler(), 0);
    assert.equal(error.code, 1, 'ERROR_INVALID_FUNCTION');
    assert.equal(fns.DeviceIoControl.argBytes, 32);
});

test('the installer file family declares the stack it pops', ()=>{
    const { fns } = setup();
    assert.equal(fns._lopen.argBytes, 8);
    assert.equal(fns._lcreat.argBytes, 8);
    assert.equal(fns._lread.argBytes, 12);
    assert.equal(fns._lwrite.argBytes, 12);
    assert.equal(fns._llseek.argBytes, 12);
    assert.equal(fns._lclose.argBytes, 4);
    assert.equal(fns.GetTempFileNameA.argBytes, 16);
    assert.equal(fns.MoveFileExA.argBytes, 12);
});

test('the short form of a path is the path: this volume keeps no 8.3 aliases', ()=>{
    const { files, fns, at, memory } = setup();
    files.put('C:\\Program Files\\Title\\title.exe', 'MZ');
    const length = fns.GetShortPathNameA.handler(
        [at(NAME, 'C:\\Program Files\\Title\\title.exe'), OUT_PATH, 260]);
    assert.equal(memory.readCString(OUT_PATH, 260), 'C:\\Program Files\\Title\\title.exe');
    assert.equal(length, 'C:\\Program Files\\Title\\title.exe'.length);
    assert.equal(fns.GetShortPathNameA.handler([at(NAME, 'C:\\absent.exe'), OUT_PATH, 260]), 0);
    assert.equal(fns.GetShortPathNameA.argBytes, 12);

    // The wide spelling counts characters: MFC hands it a MAX_PATH buffer.
    const wide = fns.GetShortPathNameW.handler(
        [putWide(memory, NAME, 'C:\\Program Files\\Title\\title.exe'), OUT_PATH, 260]);
    assert.equal(wide, 'C:\\Program Files\\Title\\title.exe'.length);
    const units = new Uint16Array(memory.bytes.slice(OUT_PATH, OUT_PATH + wide * 2 + 2).buffer);
    assert.equal(String.fromCharCode(...units.subarray(0, wide)),
        'C:\\Program Files\\Title\\title.exe');
    assert.equal(units[wide], 0, 'and terminated');
    assert.equal(fns.GetShortPathNameW.argBytes, 12);
});

test('the directories the machine promises exist before a program asks', ()=>{
    // GetSystemDirectory and the registry's ProgramFilesDir name them, and an
    // installer changes into Program Files to find its destination; a
    // machine on which they are missing sends it looking on every other drive.
    const { files, fns, at } = setup();
    const promised = [
        'C:\\WINDOWS\\system32', 'C:\\Program Files', 'C:\\Program Files\\Common Files',
    ];
    for (const path of promised)
    {
        assert.ok(files.stat(path)?.isDirectory, path);
        assert.equal(fns.SetCurrentDirectoryA.handler([at(NAME, path)]), 1, path);
    }
});

test('a name in the upper half of the ANSI page goes back as the bytes it was read from', ()=>{
    // The memory layer reads an ANSI string as Windows-1252, where 0x80 is the
    // euro sign, 0x99 the trade mark and 0x97 an em dash; the names the ANSI
    // calls hand back are written in the same page, so a program finds the
    // bytes it named a file with.
    const { memory, files, fns } = setup();
    memory.readCString = (address, maxLength)=>decodeAnsi(
        memory.bytes.subarray(address, memory.bytes.indexOf(0, address)).subarray(0, maxLength));
    const bytesOf = (/** @type {string} */ text)=>Array.from(text, unit=>unit.charCodeAt(0));
    const name = [0x80, 0x99, 0x97, 0xe9];
    const path = [...bytesOf('C:\\GAME\\'), ...name];
    memory.bytes.set([...path, 0], NAME);

    assert.equal(fns.GetFullPathNameA.handler([NAME, 0x40, OUT_TEXT, OUT_PART]), path.length);
    assert.deepEqual([...memory.bytes.subarray(OUT_TEXT, OUT_TEXT + path.length + 1)],
        [...path, 0]);

    files.put('C:\\GAME\\\u20ac\u2122\u2014\u00e9', 'x');
    memory.bytes.set([...bytesOf('C:\\GAME\\*'), 0], NAME);
    assert.notEqual(fns.FindFirstFileA.handler([NAME, FIND_DATA]), INVALID_HANDLE_VALUE);
    const found = FIND_DATA + WIN32_FIND_DATAA.cFileName;
    assert.deepEqual([...memory.bytes.subarray(found, found + name.length + 1)], [...name, 0]);
});

test('CreateFile hands the volume the write sharing it was asked for', ()=>{
    // A second writer the first open agreed to share with must get in: an
    // installer extracting a package opens it for writing twice, both times
    // with FILE_SHARE_READ | FILE_SHARE_WRITE.
    const { files, fns, at } = setup();
    files.put('C:\\TEMP\\PKG.DAT', 'data');
    /** @type {any[]} */
    const asked = [];
    const open = files.open.bind(files);
    files.open = (/** @type {string} */ path, /** @type {any} */ mode)=>{
        asked.push(mode);
        return open(path, mode);
    };
    fns.CreateFileA.handler(
        [at(NAME, 'C:\\TEMP\\PKG.DAT'), GENERIC_READ | GENERIC_WRITE, 3, 0, OPEN_ALWAYS, 0, 0]);
    fns.CreateFileA.handler(
        [at(NAME, 'C:\\TEMP\\PKG.DAT'), GENERIC_READ | GENERIC_WRITE, 1, 0, OPEN_ALWAYS, 0, 0]);
    assert.deepEqual(asked.map(mode=>mode.shareWrite), [true, false]);
});

const DELETE = 0x00010000;
const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
const FILE_ATTRIBUTE_READONLY = 0x01;
const FILE_ATTRIBUTE_NORMAL = 0x80;

test('a read-only file refuses a delete and a write until the attribute comes off', ()=>{
    // kernel32's file tests: _lcreat with attribute 1 makes a read-only file
    // the creating handle still writes; DeleteFile and a write open are then
    // ERROR_ACCESS_DENIED, a rename is allowed and takes the attribute along,
    // and SetFileAttributes(FILE_ATTRIBUTE_NORMAL) lets the delete through.
    const { files, error, fns, at, memory } = setup();
    const handle = fns._lcreat.handler([at(NAME, 'C:\\GAME\\RO.TXT'), 1]);
    assert.notEqual(handle, HFILE_ERROR);
    memory.putString(BUFFER, 'text');
    assert.equal(fns._hwrite.handler([handle, BUFFER, 4]), 4, 'the creating handle writes');
    fns._lclose.handler([handle]);
    assert.equal(fns.GetFileAttributesA.handler([NAME]) & FILE_ATTRIBUTE_READONLY,
        FILE_ATTRIBUTE_READONLY);

    error.code = 0xdeadbeef;
    assert.equal(fns.DeleteFileA.handler([NAME]), 0);
    assert.equal(error.code, ERROR_ACCESS_DENIED);
    assert.equal(fns.CreateFileA.handler([NAME, GENERIC_WRITE, 0, 0, OPEN_EXISTING, 0, 0]),
        INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_ACCESS_DENIED);
    assert.equal(fns.CreateFileA.handler(
        [NAME, DELETE, 0, 0, OPEN_EXISTING, FILE_FLAG_DELETE_ON_CLOSE, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_ACCESS_DENIED);
    const reader = fns.CreateFileA.handler([NAME, GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]);
    assert.notEqual(reader, INVALID_HANDLE_VALUE, 'reading it is still allowed');
    fns.CloseHandle.handler([reader]);

    assert.equal(fns.MoveFileA.handler([NAME, at(NAME2, 'C:\\GAME\\RO2.TXT')]), 1);
    assert.equal(fns.DeleteFileA.handler([NAME2]), 0, 'the attribute moved with the name');
    assert.equal(fns.SetFileAttributesA.handler([NAME2, FILE_ATTRIBUTE_NORMAL]), 1);
    assert.equal(fns.GetFileAttributesA.handler([NAME2]), FILE_ATTRIBUTE_NORMAL);
    assert.equal(fns.DeleteFileA.handler([NAME2]), 1);
    assert.equal(files.stat('C:\\GAME\\RO2.TXT'), null);
});

test('CreateFile gives a new file the attributes it asked for', ()=>{
    const { error, fns, at } = setup();
    const handle = fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\NEW.TXT'), 0, 0, 0,
        CREATE_ALWAYS, FILE_ATTRIBUTE_READONLY, 0]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    fns.CloseHandle.handler([handle]);
    assert.ok(fns.GetFileAttributesA.handler([NAME]) & FILE_ATTRIBUTE_READONLY);
    assert.equal(fns.CreateFileA.handler([NAME, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, 0, 0]),
        INVALID_HANDLE_VALUE, 'and replacing it is refused');
    assert.equal(error.code, ERROR_ACCESS_DENIED);
});

test('a copy carries the read-only attribute and will not overwrite a read-only file', ()=>{
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\A.TXT', 'a');
    at(NAME, 'C:\\GAME\\A.TXT');
    at(NAME2, 'C:\\GAME\\B.TXT');
    assert.equal(fns.SetFileAttributesA.handler([NAME, FILE_ATTRIBUTE_READONLY]), 1);
    assert.equal(fns.CopyFileA.handler([NAME, NAME2, 0]), 1);
    assert.ok(fns.GetFileAttributesA.handler([NAME2]) & FILE_ATTRIBUTE_READONLY);
    assert.equal(fns.CopyFileA.handler([NAME, NAME2, 0]), 0);
    assert.equal(error.code, ERROR_ACCESS_DENIED);
});

test('FILE_FLAG_DELETE_ON_CLOSE takes the file away with its handle', ()=>{
    const { files, fns, at } = setup();
    const handle = fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\SCRATCH.TMP'),
        GENERIC_READ | GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_FLAG_DELETE_ON_CLOSE, 0]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    assert.equal(files.stat('C:\\GAME\\SCRATCH.TMP')?.exists, true, 'there while it is open');
    fns.CloseHandle.handler([handle]);
    assert.equal(files.stat('C:\\GAME\\SCRATCH.TMP'), null);
});

test('FILE_FLAG_DELETE_ON_CLOSE waits for the last handle, not a duplicate', ()=>{
    const { files, fns, at, handles } = setup();
    const handle = fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\SCRATCH.TMP'),
        GENERIC_READ | GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_FLAG_DELETE_ON_CLOSE, 0]);
    // What DuplicateHandle files: a second handle onto the same open file.
    const duplicate = handles.open('file', handles.resolve(handle));
    fns.CloseHandle.handler([duplicate]);
    assert.equal(files.stat('C:\\GAME\\SCRATCH.TMP')?.exists, true, 'the first still holds it');
    fns.CloseHandle.handler([handle]);
    assert.equal(files.stat('C:\\GAME\\SCRATCH.TMP'), null);
});

/** Where the native-open fixtures put their structures. */
const NT_NAME = 0x700;
const NT_STRING = 0x7a0;
const NT_ATTRIBUTES = 0x7b0;
const NT_STATUS = 0x7d0;
const NT_HANDLE = 0x7e0;

/**
 * Lays out OBJECT_ATTRIBUTES over a UNICODE_STRING naming `name`.
 *
 * @param {ReturnType<typeof fakeMemory>} memory @param {string} name
 */
function objectAttributes(memory, name){
    for (let at = 0; at < name.length; at++)
    {
        memory.bytes[NT_NAME + at * 2] = name.charCodeAt(at);
        memory.bytes[NT_NAME + at * 2 + 1] = 0;
    }
    const length = name.length * 2;
    memory.putDword(NT_STRING, length | (length << 16));
    memory.putDword(NT_STRING + 4, NT_NAME);
    memory.putDword(NT_ATTRIBUTES, 24);
    memory.putDword(NT_ATTRIBUTES + 4, 0);
    memory.putDword(NT_ATTRIBUTES + 8, NT_STRING);
    memory.putDword(NT_ATTRIBUTES + 12, 0x40);
    return NT_ATTRIBUTES;
}

const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_DIRECTORY_FILE = 0x1;
const FILE_NON_DIRECTORY_FILE = 0x40;
const FILE_DELETE_ON_CLOSE = 0x1000;

test('NtCreateFile opens a \\??\\ name and reports how in the status block', ()=>{
    const { files, fns, memory } = setup();
    const native = /** @type {any} */ (fns.CreateFileW).natives?.NtCreateFile;
    assert.ok(native, 'published for ntdll beside CreateFileW');
    files.put('C:\\GAME\\DATA.BIN', 'data');
    const attributes = objectAttributes(memory, '\\??\\C:\\GAME\\DATA.BIN');

    assert.equal(native.handler([NT_HANDLE, GENERIC_READ, attributes, NT_STATUS, 0, 0, 7,
        FILE_OPEN, FILE_NON_DIRECTORY_FILE, 0, 0]), 0);
    const handle = memory.dword(NT_HANDLE);
    assert.equal(memory.dword(NT_STATUS), 0);
    assert.equal(memory.dword(NT_STATUS + 4), 1, 'FILE_OPENED');
    assert.equal(fns.ReadFile.handler([handle, BUFFER, 4, OUT_COUNT, 0]), 1);
    assert.equal(memory.dword(OUT_COUNT), 4, 'the handle reads as CreateFile\'s would');
    assert.equal(fns.CloseHandle.handler([handle]), 1);

    assert.equal(native.handler([NT_HANDLE, GENERIC_WRITE, objectAttributes(memory,
        '\\??\\C:\\GAME\\NEW.BIN'), NT_STATUS, 0, 0, 0, FILE_CREATE, 0, 0, 0]), 0);
    assert.equal(memory.dword(NT_STATUS + 4), 2, 'FILE_CREATED');
    assert.equal(files.stat('C:\\GAME\\NEW.BIN')?.exists, true);
});

test('NtCreateFile answers the statuses kernel32\'s tests expect of a read-only file', ()=>{
    // file.c's _lcreat test: write access is refused first, then a
    // delete-on-close open of the read-only file, then asking a file to be a
    // directory.
    const { files, fns, memory } = setup();
    const native = /** @type {any} */ (fns.CreateFileW).natives.NtCreateFile;
    files.put('C:\\GAME\\RO.TXT', 'text');
    files.setAttributes('C:\\GAME\\RO.TXT', FILE_ATTRIBUTE_READONLY);
    const attributes = objectAttributes(memory, '\\??\\C:\\GAME\\RO.TXT');
    /** @param {number} access @param {number} options */
    const open = (access, options)=>native.handler([NT_HANDLE, access, attributes, NT_STATUS,
        0, 0, 7, FILE_OPEN, options, 0, 0]) >>> 0;

    assert.equal(open(GENERIC_READ | GENERIC_WRITE | DELETE,
        FILE_DELETE_ON_CLOSE | FILE_NON_DIRECTORY_FILE), 0xc0000022, 'STATUS_ACCESS_DENIED');
    assert.equal(open(DELETE, FILE_DELETE_ON_CLOSE | FILE_NON_DIRECTORY_FILE), 0xc0000121,
        'STATUS_CANNOT_DELETE');
    assert.equal(open(DELETE, FILE_DELETE_ON_CLOSE | FILE_DIRECTORY_FILE), 0xc0000103,
        'STATUS_NOT_A_DIRECTORY');
    assert.equal(open(GENERIC_READ, FILE_DELETE_ON_CLOSE), 0xc000000d,
        'deleting on close needs DELETE access');
    assert.equal(files.stat('C:\\GAME\\RO.TXT')?.exists, true, 'and nothing deleted it');
});

test('NtCreateFile names what is missing, and takes only object names', ()=>{
    const { fns, memory, files } = setup();
    const native = /** @type {any} */ (fns.CreateFileW).natives.NtCreateFile;
    /** @param {string} name @param {number} [disposition] @param {number} [options] */
    const open = (name, disposition = FILE_OPEN, options = 0)=>
        native.handler([NT_HANDLE, GENERIC_READ, objectAttributes(memory, name), NT_STATUS,
            0, 0, 7, disposition, options, 0, 0]) >>> 0;

    assert.equal(open('\\??\\C:\\GAME\\NONE.TXT'), 0xc0000034, 'OBJECT_NAME_NOT_FOUND');
    assert.equal(open('\\??\\C:\\NOWHERE\\NONE.TXT'), 0xc000003a, 'OBJECT_PATH_NOT_FOUND');
    assert.equal(open('C:\\GAME\\NONE.TXT'), 0xc000003b, 'a DOS path is not an object name');
    assert.equal(open('\\??\\C:\\GAME', FILE_OPEN, FILE_NON_DIRECTORY_FILE), 0xc00000ba,
        'STATUS_FILE_IS_A_DIRECTORY');
    assert.equal(open('\\??\\C:\\GAME\\SUB', FILE_CREATE, FILE_DIRECTORY_FILE), 0);
    assert.equal(files.stat('C:\\GAME\\SUB')?.isDirectory, true, 'a directory was made');
    assert.equal(fns.CloseHandle.handler([memory.dword(NT_HANDLE)]), 1,
        'and its handle closes as any other');
});

const ERROR_SHARING_VIOLATION = 32;
const ERROR_INVALID_NAME = 123;
const ERROR_REQUEST_ABORTED = 1235;

test('a file copied onto itself is a sharing violation, and a NULL name a missing path', ()=>{
    // kernel32's CopyFileA test, which on Windows opens the source and then
    // collides with it opening the destination.
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\A.TXT', 'a');
    assert.equal(fns.CopyFileA.handler([at(NAME, 'C:\\GAME\\A.TXT'), NAME, 0]), 0);
    assert.equal(error.code, ERROR_SHARING_VIOLATION);
    assert.equal(fns.CopyFileA.handler([NAME, at(NAME2, 'c:\\game\\a.txt'), 0]), 0,
        'however the second name is spelled');
    assert.equal(fns.CopyFileA.handler([0, NAME, 1]), 0);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND);
    assert.equal(fns.CopyFileA.handler([NAME, 0, 1]), 0);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND);
});

test('CopyFileW and CopyFileEx copy as CopyFileA does, and a success clears the error', ()=>{
    const { files, error, fns, memory } = setup();
    files.put('C:\\GAME\\A.TXT', 'abc');
    putWide(memory, NAME, 'C:\\GAME\\A.TXT');
    putWide(memory, NAME2, 'C:\\GAME\\B.TXT');
    error.code = 0xdeadbeef;
    assert.equal(fns.CopyFileW.handler([NAME, NAME2, 1]), 1);
    assert.equal(error.code, ERROR_SUCCESS);
    assert.equal(files.text('C:\\GAME\\B.TXT'), 'abc');
    assert.equal(fns.CopyFileW.handler([NAME, NAME2, 1]), 0);
    assert.equal(error.code, ERROR_FILE_EXISTS);
    assert.equal(fns.CopyFileExW.handler([NAME, NAME2, 0, 0, 0, 1]), 0,
        'COPY_FILE_FAIL_IF_EXISTS is bFailIfExists');
    assert.equal(fns.CopyFileExW.handler([NAME, NAME2, 0, 0, 0, 0]), 1);
    memory.putDword(OUT_COUNT, 1);
    assert.equal(fns.CopyFileExW.handler([NAME, NAME2, 0, 0, OUT_COUNT, 0]), 0,
        'a cancel already set stops the copy');
    assert.equal(error.code, ERROR_REQUEST_ABORTED);
});

test('_lopen with OF_WRITE alone opens for writing only', ()=>{
    const { files, error, fns, at, memory } = setup();
    files.put('C:\\GAME\\W.TXT', 'text');
    const handle = fns._lopen.handler([at(NAME, 'C:\\GAME\\W.TXT'), 1]);
    assert.notEqual(handle, HFILE_ERROR);
    assert.equal(fns._lread.handler([handle, BUFFER, 1]), HFILE_ERROR);
    assert.equal(error.code, ERROR_ACCESS_DENIED);
    memory.putString(BUFFER, 'new!');
    assert.equal(fns._lwrite.handler([handle, BUFFER, 4]), 4);
});

test('a wildcard or a trailing separator is not a name a file is opened or made by', ()=>{
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\F.TXT', 'f');
    assert.equal(fns._lcreat.handler([at(NAME, 'testfi/'), 0]), HFILE_ERROR);
    assert.equal(error.code, ERROR_INVALID_NAME);
    assert.equal(files.stat('C:\\GAME\\testfi'), null, 'and nothing was made');
    assert.equal(fns.CreateFileA.handler([at(NAME, 'C:\\*.*'), GENERIC_READ, 1, 0,
        OPEN_EXISTING, 0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_INVALID_NAME);
    assert.equal(fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\'), GENERIC_READ, 1, 0,
        OPEN_EXISTING, 0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND, 'a directory spelled as one');
    assert.equal(fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\NEW\\'), GENERIC_READ, 1, 0,
        OPEN_EXISTING, 0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);
});

test('a lock is the file\'s, seen through every handle, and goes with its handle', ()=>{
    // Wine's kernel32 file test_LockFile: an exclusive lock refuses any
    // overlapping one from another handle, shared locks sit together, and an
    // unlock names exactly a range it holds.
    const ERROR_LOCK_VIOLATION = 33;
    const ERROR_NOT_LOCKED = 158;
    const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
    const OVERLAPPED = 0x700;
    const { files, error, fns, open, memory } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'x');
    const first = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    const second = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);

    assert.equal(fns.LockFile.handler([first, 0, 0, 100, 0]), 1);
    assert.equal(fns.LockFile.handler([second, 50, 0, 10, 0]), 0, 'another handle\'s range');
    assert.equal(error.code, ERROR_LOCK_VIOLATION);
    assert.equal(fns.LockFile.handler([first, 50, 0, 10, 0]), 0, 'and the taker\'s own');
    assert.equal(fns.LockFile.handler([second, 100, 0, 10, 0]), 1, 'past it is free');
    assert.equal(fns.UnlockFile.handler([first, 0, 0, 50, 0]), 0, 'only the range it took');
    assert.equal(error.code, ERROR_NOT_LOCKED);
    assert.equal(fns.UnlockFile.handler([second, 0, 0, 100, 0]), 0, 'by the handle that took it');
    assert.equal(fns.UnlockFile.handler([first, 0, 0, 100, 0]), 1);

    memory.putDword(OVERLAPPED + 8, 200);
    assert.equal(fns.LockFileEx.handler([first, 0, 0, 10, 0, OVERLAPPED]), 1, 'shared');
    assert.equal(fns.LockFileEx.handler([second, 0, 0, 10, 0, OVERLAPPED]), 1,
        'beside another shared one');
    assert.equal(fns.LockFileEx.handler([second, LOCKFILE_EXCLUSIVE_LOCK, 0, 10, 0,
        OVERLAPPED]), 0, 'which an exclusive one is refused over');
    assert.equal(error.code, ERROR_LOCK_VIOLATION);

    assert.equal(fns.CloseHandle.handler([second]), 1);
    assert.equal(fns.LockFile.handler([first, 100, 0, 10, 0]), 1,
        'a handle\'s locks close with it');
    assert.equal(fns.LockFile.handler([first, 0xffffffff, 0xffffffff, 2, 0]), 0,
        'a range past the last offset is not one');
    assert.equal(error.code, ERROR_INVALID_PARAMETER);
});

test('ReplaceFile moves the replacement onto the replaced name, keeping a backup when asked',
    ()=>{
        const { files, error, fns, at } = setup();
        const dir = 'C:\\GAME\\';
        files.put(`${dir}OLD.TXT`, 'old');
        files.put(`${dir}NEW.TXT`, 'new');
        const replaced = at(NAME, `${dir}OLD.TXT`);
        const replacement = at(NAME2, `${dir}NEW.TXT`);
        const backup = at(0x200, `${dir}OLD.BAK`);
        assert.equal(fns.ReplaceFileA.argBytes, 24);
        assert.equal(fns.ReplaceFileA.handler([replaced, replacement, backup, 0, 0, 0]), 1);
        assert.equal(files.text(`${dir}OLD.TXT`), 'new');
        assert.equal(files.text(`${dir}OLD.BAK`), 'old');
        assert.ok(!files.stat(`${dir}NEW.TXT`)?.exists, 'the replacement name is gone');

        files.put(`${dir}NEW.TXT`, 'newer');
        assert.equal(fns.ReplaceFileA.handler([replaced, replacement, 0, 0, 0, 0]), 1);
        assert.equal(files.text(`${dir}OLD.TXT`), 'newer');

        assert.equal(fns.ReplaceFileA.handler([replaced, replacement, 0, 0, 0, 0]), 0);
        assert.equal(error.code, 2, 'ERROR_FILE_NOT_FOUND without a replacement');

        files.put(`${dir}NEW.TXT`, 'x');
        files.setAttributes(`${dir}OLD.TXT`, 1);
        assert.equal(fns.ReplaceFileA.handler([replaced, replacement, 0, 0, 0, 0]), 0);
        assert.equal(error.code, ERROR_ACCESS_DENIED, 'a read-only file is not replaced');
        assert.equal(files.text(`${dir}NEW.TXT`), 'x', 'and nothing moved');
    });

test('WriteFileGather and ReadFileScatter move a page per segment and complete once', ()=>{
    /** @type {number[][]} */
    const done = [];
    const { memory, files, fns, open } = setup({ ports: {
        offsetOf: ()=>2,
        /** @param {number} handle @param {number} count @param {number} pointer */
        completed: (handle, count, pointer)=>done.push([count, pointer]),
    } });
    files.put('C:\\GAME\\SAVE.DAT', 'abcdefghij');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putString(0x400, 'XYZ');
    memory.putDword(0x300, 0x400);
    memory.putDword(0x304, 0);
    assert.equal(fns.WriteFileGather.handler([handle, 0x300, 3, 0, 0x500]), 1);
    assert.equal(files.text('C:\\GAME\\SAVE.DAT'), 'abXYZfghij', 'at the OVERLAPPED\'s offset');
    assert.deepEqual(done, [[3, 0x500]]);

    memory.putDword(0x300, 0x600);
    assert.equal(fns.ReadFileScatter.handler([handle, 0x300, 4, 0, 0x500]), 1);
    assert.equal(memory.readCString(0x600, 4), 'XYZf');
    assert.deepEqual(done.at(-1), [4, 0x500]);
    assert.equal(fns.ReadFileScatter.handler([handle, 0x300, 4, 0, 0]), 0, 'overlapped only');
});

test('CreateHardLink answers as a volume without links does, and says so', ()=>{
    /** @type {string[]} */
    const said = [];
    const { files, error, fns, at } = setup({
        divergence: (/** @type {string} */ api)=>said.push(api) });
    files.put('C:\\GAME\\SAVE.DAT', 'x');
    assert.equal(fns.CreateHardLinkA.argBytes, 12);
    assert.equal(fns.CreateHardLinkA.handler(
        [at(NAME2, 'C:\\GAME\\LINK.DAT'), at(NAME, 'C:\\GAME\\SAVE.DAT'), 0]), 0);
    assert.equal(error.code, 1, 'ERROR_INVALID_FUNCTION, as FAT answers');
    assert.deepEqual(said, ['CreateHardLink']);
    assert.equal(fns.CreateHardLinkA.handler(
        [NAME2, at(NAME, 'C:\\GAME\\NONE.DAT'), 0]), 0);
    assert.equal(error.code, 2, 'a missing file is missing first');
});

test('GetFileAttributesEx fills the head a find would, and nothing past it', ()=>{
    const { memory, files, error, fns, at } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcdefghij');
    memory.bytes.fill(0xa5, 0x400, 0x440);
    assert.equal(fns.GetFileAttributesExA.argBytes, 12);
    assert.equal(fns.GetFileAttributesExA.handler([at(NAME, 'C:\\GAME\\SAVE.DAT'), 0, 0x400]), 1);
    assert.equal(memory.dword(0x400), fns.GetFileAttributesA.handler([NAME]));
    assert.equal(memory.dword(0x400 + 32), 10, 'nFileSizeLow');
    assert.equal(memory.bytes[0x400 + 36], 0xa5, 'thirty-six bytes');
    assert.equal(fns.GetFileAttributesExA.handler([NAME, 1, 0x400]), 0, 'one level');
    assert.equal(error.code, 87);
    assert.equal(fns.GetFileAttributesExA.handler([at(NAME, 'C:\\GAME\\NONE.DAT'), 0, 0x400]), 0);
    assert.equal(error.code, 2);
});
