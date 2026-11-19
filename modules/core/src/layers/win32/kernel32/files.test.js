/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { volumeName } from './drives.js';
import { createFileFunctions, withSystemLibraries, WIN32_FIND_DATAA } from './files.js';
import { HANDLE_STDOUT } from './console.js';
import { decodeAnsi } from './locale.js';
import { systemProgramAt, systemProgramImage } from '../programs/table.js';

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
const ERROR_FILENAME_EXCED_RANGE = 206;
const ERROR_DIRECTORY = 267;
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
/**
 * A volume's numbering as the filesystem keeps it: a number per file, given
 * the first time it is asked for, the same for the same path whatever its case.
 */
function numbering(){
    /** @type {Map<string, { id: number, path: string }>} */
    const ids = new Map();
    return {
        /** @param {string} path */
        fileId: path=>{
            const key = path.toLowerCase();
            if (!ids.has(key))
            {
                ids.set(key, { id: 64 + ids.size, path });
            }
            return /** @type {{ id: number }} */ (ids.get(key)).id;
        },
        /** @param {string} path @param {number} id */
        pathOfFileId: (path, id)=>[...ids.values()].find(one=>one.id === id
            && one.path.slice(0, 2).toLowerCase() === path.slice(0, 2).toLowerCase())?.path
            ?? null,
    };
}

function fakeFiles(){
    /** @type {Map<string, { data: Uint8Array, directory: boolean }>} */
    const nodes = new Map();
    /** The opens not closed yet. @type {Set<{ path: string }>} */
    const live = new Set();
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
                    ...attributes.has(path) ? { attributes: attributes.get(path) } : {},
                    .../** @type {any} */ (node).link ?? {} }
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
            const node = { path };
            live.add(node);
            return node;
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
        /** @param {{ path: string, closed?: boolean }} node */
        close: node=>{
            node.closed = true;
            live.delete(node);
        },
        /** Whether any open of the file is still open. @param {string} path */
        isOpen: path=>[...live].some(node=>node.path.toLowerCase() === path.toLowerCase()),
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
        ...numbering(),
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
    /** @type {Map<number, { type: string, object: any, access: number | null }>} */
    const entries = new Map();
    let next = 4;
    return {
        /** @param {string} type @param {any} object @param {number | null} [access] */
        open(type, object, access = null){
            const handle = next;
            next += 4;
            entries.set(handle, { type, object, access });
            return handle;
        },
        /** @param {number} handle */
        access: handle=>entries.get(handle)?.access ?? null,
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
     * @param {number} [flags]
     */
    const open = (path, disposition, access = GENERIC_READ | GENERIC_WRITE, flags = 0)=>{
        memory.putString(NAME, path);
        const handle = fns.CreateFileA.handler([NAME, access, 0, 0, disposition, flags, 0]);
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
    // The volume holds what it held plus the machine's own directories.
    assert.equal(files.nodes.size, 11, 'nothing was created for it');
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

test('a write hands the volume the guest\'s own bytes when the memory layer lends them', ()=>{
    // A volume keeps a copy of what it is written; reading the buffer into a
    // copy first, and copying that again, was most of an installer's write.
    /** @type {Uint8Array[]} */
    const handed = [];
    const memory = { lent: /** @type {Uint8Array | null} */ (null) };
    const { files, fns, open } = setup({
        windowMemory: (/** @type {number} */ address, /** @type {number} */ length)=>{
            memory.lent = new Uint8Array(64).fill(0x41).subarray(0, length);
            return memory.lent;
        },
    });
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    const write = files.write.bind(files);
    files.write = (/** @type {any} */ node, /** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>{
        handed.push(bytes);
        return write(node, at, bytes);
    };
    assert.equal(fns.WriteFile.handler([handle, BUFFER, 2, OUT_COUNT, 0]), 1);
    assert.equal(handed[0], memory.lent, 'the lent bytes, not a copy of them');
    assert.equal(files.text('C:\\GAME\\SAVE.DAT'), 'AAcd');
});

test('a write whose file is still being fetched parks, then reports its count', async()=>{
    // A bundled file is copied up on its first write; when its blocks are not
    // here the volume answers with a promise, and the guest is parked on it
    // exactly as on a read -- the count and the position land when it settles.
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcd');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    memory.putDword(OUT_COUNT, 0xdeadbeef);
    const anyFiles = /** @type {any} */ (files);
    anyFiles.writeOrFetch = (/** @type {any} */ node, /** @type {number} */ at,
        /** @type {Uint8Array} */ bytes)=>Promise.resolve().then(()=>files.write(node, at, bytes));

    const answer = /** @type {any} */ (fns.WriteFile.handler([handle, BUFFER, 2, OUT_COUNT, 0]));
    assert.equal(typeof answer?.then, 'function', 'the call is parked, not answered');
    assert.equal(memory.dword(OUT_COUNT), 0,
        'nothing is reported before the write is done: the count zeroed, as Windows does first');
    assert.equal(await answer, 1);
    assert.equal(memory.dword(OUT_COUNT), 2);
});

test('a request on a file bound to a completion port cannot also ask for an APC', ()=>{
    /** @type {Set<number>} */
    const bound = new Set();
    /** @type {number[]} */
    const queued = [];
    const { files, fns, open } = setup({
        ports: { offsetOf: ()=>0, completed: ()=>false, closed: ()=>{},
            bound: (/** @type {number} */ file)=>bound.has(file) },
        queueApc: (/** @type {any} */ thread, /** @type {number} */ routine)=>queued.push(routine),
    });
    files.put('C:\\GAME\\SAVE.DAT', 'abcdef');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    const natives = /** @type {any} */ (fns.CreateFileW).natives;
    bound.add(handle);
    for (const call of [natives.NtReadFile, natives.NtWriteFile])
    {
        assert.equal(call.handler([handle, 0, 0x4000, 0, 0x500, BUFFER, 4, 0, 0]) >>> 0,
            0xc000000d, 'STATUS_INVALID_PARAMETER');
    }
    assert.deepEqual(queued, [], 'nothing done, nothing queued');
    assert.equal(natives.NtReadFile.handler([handle, 0, 0, 0, 0x500, BUFFER, 4, 0, 0]), 0,
        'without an APC it reads');
    bound.delete(handle);
    assert.equal(natives.NtReadFile.handler([handle, 0, 0x4000, 0, 0x500, BUFFER, 2, 0, 0]), 0,
        'unbound, the APC is queued');
    assert.deepEqual(queued, [0x4000]);
});

test('NtReadFile and NtWriteFile move bytes where ByteOffset says, and fill the block', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcdef');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    const natives = /** @type {any} */ (fns.CreateFileW).natives;
    const block = 0x500;
    const offset = 0x510;

    assert.equal(natives.NtReadFile.handler([handle, 0, 0, 0, block, BUFFER, 4, 0, 0]), 0);
    assert.deepEqual([memory.dword(block), memory.dword(block + 4)], [0, 4]);
    assert.equal(String.fromCharCode(...memory.bytes.subarray(BUFFER, BUFFER + 4)), 'abcd');

    // At an offset; then from the pointer, which the read moved.
    memory.putDword(offset, 1);
    memory.putDword(offset + 4, 0);
    assert.equal(natives.NtReadFile.handler([handle, 0, 0, 0, block, BUFFER, 2, offset, 0]), 0);
    assert.equal(String.fromCharCode(...memory.bytes.subarray(BUFFER, BUFFER + 2)), 'bc');
    memory.putDword(offset, 0xfffffffe);
    memory.putDword(offset + 4, 0xffffffff);
    assert.equal(natives.NtReadFile.handler([handle, 0, 0, 0, block, BUFFER, 8, offset, 0]), 0);
    assert.deepEqual([memory.dword(block), memory.dword(block + 4)], [0, 3]);
    assert.equal(natives.NtReadFile.handler([handle, 0, 0, 0, block, BUFFER, 8, 0, 0]),
        0xc0000011, 'STATUS_END_OF_FILE');
    assert.deepEqual([memory.dword(block), memory.dword(block + 4)], [0xc0000011, 0]);

    // Writing at the end of the file, wherever the pointer is.
    memory.bytes.set([0x67, 0x68], BUFFER);
    memory.putDword(offset, 0xffffffff);
    memory.putDword(offset + 4, 0xffffffff);
    assert.equal(natives.NtWriteFile.handler([handle, 0, 0, 0, block, BUFFER, 2, offset, 0]), 0);
    assert.deepEqual([memory.dword(block), memory.dword(block + 4)], [0, 2]);
    assert.equal(files.stat('C:\\GAME\\SAVE.DAT')?.size, 8);

    memory.putDword(block, 0xdeadbeef);
    assert.equal(natives.NtReadFile.handler([0x4321, 0, 0, 0, block, BUFFER, 2, 0, 0]),
        0xc0000008, 'STATUS_INVALID_HANDLE');
    assert.equal(memory.dword(block), 0xdeadbeef, 'a refusal leaves the block alone');
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

test('a move that has to wait for the blocks it copies is parked, then answered', async()=>{
    const { files, fns, at } = setup();
    files.put('C:\\GAME\\A.DAT', 'a');
    const anyFiles = /** @type {any} */ (files);
    anyFiles.renameOrFetch = (/** @type {string} */ from, /** @type {string} */ to)=>
        Promise.resolve().then(()=>files.rename(from, to));
    const answer = /** @type {any} */ (fns.MoveFileA.handler(
        [at(NAME, 'C:\\GAME\\A.DAT'), at(NAME2, 'C:\\GAME\\C.DAT')]));
    assert.equal(typeof answer?.then, 'function', 'the call is parked, not answered');
    assert.equal(await answer, 1);
    assert.equal(files.text('C:\\GAME\\C.DAT'), 'a');
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

test('a copy goes through a symbolic link at either end, the link left as it is', ()=>{
    const { error, files, fns, at } = setup();
    files.put('C:\\GAME\\TARGET.DAT', 'target');
    files.put('C:\\GAME\\LINK.DAT', '');
    /** @type {any} */ (files.nodes.get('C:\\GAME\\LINK.DAT')).link =
        { reparseTag: 0xa000000c, junction: 'GAME\\TARGET.DAT' };
    files.put('C:\\GAME\\NEW.DAT', 'new');

    assert.equal(fns.CopyFileA.handler(
        [at(NAME, 'C:\\GAME\\LINK.DAT'), at(NAME2, 'C:\\GAME\\COPY.DAT'), 0]), 1);
    assert.equal(files.text('C:\\GAME\\COPY.DAT'), 'target', 'what the link names');

    assert.equal(fns.CopyFileA.handler(
        [at(NAME, 'C:\\GAME\\NEW.DAT'), at(NAME2, 'C:\\GAME\\LINK.DAT'), 1]), 0);
    assert.equal(error.code, ERROR_FILE_EXISTS, 'the link is there');
    assert.equal(fns.CopyFileA.handler(
        [at(NAME, 'C:\\GAME\\NEW.DAT'), at(NAME2, 'C:\\GAME\\LINK.DAT'), 0]), 1);
    assert.equal(files.text('C:\\GAME\\TARGET.DAT'), 'new', 'written where it points');
    assert.equal(files.text('C:\\GAME\\LINK.DAT'), '', 'the link itself untouched');
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

    // What the volume refuses to remove - the current directory, held open -
    // is a sharing violation, not a directory that is not empty.
    Object.assign(files, { removalRefused: ()=>'SHARING_VIOLATION' });
    assert.equal(fns.RemoveDirectoryA.handler([at(NAME, 'C:\\GAME\\DATA')]), 0);
    assert.equal(error.code, ERROR_SHARING_VIOLATION);
    Object.assign(files, { removalRefused: ()=>null });
    assert.equal(fns.RemoveDirectoryA.handler([at(NAME, 'C:\\GAME\\DATA')]), 1);

    // No directory is called by a wildcard, so none is made or looked for.
    for (const name of ['C:\\GAME\\DATA?', 'C:\\GAME\\DATA*'])
    {
        assert.equal(fns.CreateDirectoryA.handler([at(NAME, name), 0]), 0);
        assert.equal(error.code, ERROR_INVALID_NAME);
        assert.equal(fns.RemoveDirectoryA.handler([at(NAME, name)]), 0);
        assert.equal(error.code, ERROR_INVALID_NAME);
    }
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

test('an ANSI name longer than MAX_PATH is refused by a call that takes one name', ()=>{
    const { error, files, fns, at, memory } = setup();
    const LONG = 0xa00;
    const tooLong = `C:\\GAME\\${'a'.repeat(253)}`;
    const fits = `C:\\GAME\\${'b'.repeat(252)}`;
    assert.equal(tooLong.length, 261);
    assert.equal(fits.length, 260);

    /** @type {[string, number[], number][]} */
    const calls = [
        ['GetFileAttributesA', [LONG], 0xffffffff],
        ['CreateFileA', [LONG, GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0], INVALID_HANDLE_VALUE],
        ['FindFirstFileA', [LONG, FIND_DATA], INVALID_HANDLE_VALUE],
        ['DeleteFileA', [LONG], 0],
        ['CreateDirectoryA', [LONG, 0], 0],
        ['SetCurrentDirectoryA', [LONG], 0],
        ['GetFullPathNameA', [LONG, 0x100, OUT_PATH, 0], 0],
    ];
    for (const [name, args, failed] of calls)
    {
        at(LONG, tooLong);
        error.code = ERROR_SUCCESS;
        assert.equal(/** @type {any} */ (fns)[name].handler(args), failed, name);
        assert.equal(error.code, ERROR_FILENAME_EXCED_RANGE, name);
    }
    assert.equal(files.stat(tooLong)?.exists ?? false, false, 'nothing made under the name');

    // MAX_PATH characters fit: the name is looked for as any other.
    at(LONG, fits);
    assert.equal(fns.GetFileAttributesA.handler([LONG]), 0xffffffff);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);
    files.put(fits, 'x');
    assert.equal(fns.GetFileAttributesA.handler([LONG]), 0x20);

    // The wide spelling and a call with two names have no such buffer.
    putWide(memory, 0xc00, tooLong);
    assert.equal(fns.GetFileAttributesW.handler([0xc00]), 0xffffffff);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);
    at(LONG, tooLong);
    assert.equal(fns.MoveFileA.handler([LONG, at(NAME2, 'C:\\GAME\\B.DAT')]), 0);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);
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

test('a name cannot end in a dot or a space; a folder before a separator drops one dot', ()=>{
    const { memory, fns, at } = setup();
    /** @param {string} name */
    const full = name=>{
        fns.GetFullPathNameA.handler([at(NAME, name), 0x40, OUT_TEXT, OUT_PART]);
        return memory.string(OUT_TEXT);
    };
    assert.equal(full('C:/test  ....   ..   '), 'C:\\test');
    assert.equal(full('C:/test./file'), 'C:\\test\\file');
    assert.equal(full('C:/test.. /file'), 'C:\\test.. \\file', 'only a single dot goes');
    assert.equal(full('C:\\dir\\*.'), 'C:\\dir\\*',
        'the full path of a pattern loses them too (FindFirstFile reads its own)');
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
    files.nodes.set('C:\\TEMP\\{A}\\Disk1', { data: new Uint8Array(0), directory: true });
    assert.equal(fns.SearchPathA.handler([at(NAME + 0x80, 'C:\\TEMP\\{A}'), at(NAME, 'Disk1'), 0,
        0x80, OUT_TEXT, 0]), 'C:\\TEMP\\{A}\\Disk1'.length,
    'a directory is found as a file is: an InstallShield setup looks for its Disk1 so');
    assert.equal(memory.string(OUT_TEXT), 'C:\\TEMP\\{A}\\Disk1');
    assert.equal(fns.SearchPathA.handler([0, at(NAME, 'local.dat'), 0, 4, OUT_TEXT, 0]),
        'C:\\GAME\\local.dat'.length + 1, 'too small: the size needed, terminator included');
    assert.equal(fns.SearchPathA.argBytes, 24);

    const wide = fns.SearchPathW.handler(
        [0, putWide(memory, NAME, 'cabinet.dll'), 0, 0x80, OUT_TEXT, OUT_PART]);
    assert.equal(wide, 'C:\\WINDOWS\\system32\\cabinet.dll'.length, 'the wide twin');
    assert.equal(memory.dword(OUT_PART), OUT_TEXT + 'C:\\WINDOWS\\system32\\'.length * 2,
        'and its file part is in characters of two bytes');
});

test('a \\\\?\\ path is its own full path, handed back as written', ()=>{
    // That namespace turns the parsing off, GetFullPathName's included.
    const { memory, fns, at } = setup();
    const written = fns.GetFullPathNameA.handler(
        [at(NAME, '\\\\?\\C:\\GAME\\..\\x'), 0x40, OUT_TEXT, OUT_PART]);
    assert.equal(memory.string(OUT_TEXT), '\\\\?\\C:\\GAME\\..\\x');
    assert.equal(written, '\\\\?\\C:\\GAME\\..\\x'.length);
    assert.equal(memory.string(memory.dword(OUT_PART)), 'x');
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

    // Not there is told apart as everywhere else: the last name, or the way to it.
    assert.equal(fns.SetCurrentDirectoryA.handler([at(NAME, 'C:\\NOWHERE')]), 0);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);
    assert.equal(fns.SetCurrentDirectoryA.handler([at(NAME, 'C:\\NOWHERE\\SUB')]), 0);
    assert.equal(error.code, ERROR_PATH_NOT_FOUND);
    files.put('C:\\GAME\\FILE.DAT', 'a file');
    assert.equal(fns.SetCurrentDirectoryA.handler([at(NAME, 'C:\\GAME\\FILE.DAT')]), 0);
    assert.equal(error.code, ERROR_DIRECTORY);

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

test('GetTempPath is the first of TMP, TEMP and USERPROFILE set, else the Windows directory,'
    + ' as a full path', ()=>{
    /** @type {Record<string, string>} */
    const variables = { TEMP: 'C:\\SCRATCH', USERPROFILE: 'C:\\Users\\User' };
    const { memory, fns } = setup({
        /** @param {string} name */
        environmentVariable: name=>variables[name],
    });
    const asked = ()=>{
        fns.GetTempPathA.handler([0x40, OUT_TEXT]);
        return memory.string(OUT_TEXT);
    };
    assert.equal(asked(), 'C:\\SCRATCH\\');
    variables.TMP = 'C:';
    assert.equal(asked(), 'C:\\GAME\\', 'a drive alone is its current directory');
    variables.TMP = 'C:\\';
    assert.equal(asked(), 'C:\\');
    delete variables.TMP;
    delete variables.TEMP;
    assert.equal(asked(), 'C:\\Users\\User\\');
    delete variables.USERPROFILE;
    assert.equal(asked(), 'C:\\WINDOWS\\');
});

test('the path calls refuse no name and a wildcard, and a temporary name needs its directory',
    ()=>{
        const { error, fns, at } = setup();
        assert.equal(fns.GetFullPathNameA.handler([0, 260, BUFFER, 0]), 0);
        assert.equal(error.code, ERROR_INVALID_NAME, 'Windows from 7 on');
        assert.equal(fns.GetFullPathNameA.handler([at(NAME, ''), 260, BUFFER, 0]), 0);
        assert.equal(error.code, ERROR_INVALID_NAME);
        assert.equal(fns.GetLongPathNameA.handler([0, BUFFER, 260]), 0);
        assert.equal(error.code, ERROR_INVALID_PARAMETER);
        for (const form of ['GetLongPathNameA', 'GetShortPathNameA'])
        {
            assert.equal(fns[form].handler([at(NAME, 'C:\\GAME\\*'), BUFFER, 260]), 0);
            assert.equal(error.code, ERROR_INVALID_NAME, form);
        }
        for (const unique of [0, 1])
        {
            assert.equal(fns.GetTempFileNameA.handler(
                [at(NAME, 'C:\\GAME\\NOWHERE'), at(NAME2, 'tfn'), unique, BUFFER]), 0);
            assert.equal(error.code, ERROR_DIRECTORY);
        }
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

test('a move into a folder that is not there is a path not found, and moves once it is made',
    ()=>{
        // A WiX setup moves a payload into its package cache, makes the folder
        // on ERROR_PATH_NOT_FOUND and moves again; a refusal stopped it.
        const { files, memory, fns, error } = setup();
        files.put('C:\\TEMP\\PAYLOAD.EXE', 'payload');
        const from = putWide(memory, NAME, 'C:\\TEMP\\PAYLOAD.EXE');
        const to = putWide(memory, NAME2, 'C:\\CACHE\\HASH\\PAYLOAD.EXE');
        assert.equal(fns.MoveFileExW.handler([from, to, 3]), 0);
        assert.equal(error.code, 3, 'ERROR_PATH_NOT_FOUND');
        assert.ok(files.stat('C:\\TEMP\\PAYLOAD.EXE')?.exists, 'nothing moved');
        files.mkdir('C:\\CACHE');
        files.mkdir('C:\\CACHE\\HASH');
        assert.equal(fns.MoveFileExW.handler([from, to, 3]), 1);
        assert.equal(files.text('C:\\CACHE\\HASH\\PAYLOAD.EXE'), 'payload');
    });

test('MoveFileWithProgressW moves as MoveFileExW does, and a rename calls no progress routine',
    ()=>{
        const { files, memory, fns, error } = setup();
        files.put('C:\\GAME\\NEW.DLL', 'fresh');
        files.put('C:\\GAME\\OLD.DLL', 'stale');
        const from = putWide(memory, NAME, 'C:\\GAME\\NEW.DLL');
        const to = putWide(memory, NAME2, 'C:\\GAME\\OLD.DLL');
        // A routine the guest never wrote: called, it would run nothing there.
        const routine = 0x7000;
        assert.equal(fns.MoveFileWithProgressW.handler([from, to, routine, 0, 0]), 0);
        assert.equal(error.code, ERROR_ALREADY_EXISTS);
        assert.equal(fns.MoveFileWithProgressW.handler([from, to, routine, 0, 1]), 1);
        assert.equal(files.text('C:\\GAME\\OLD.DLL'), 'fresh');
        assert.equal(fns.MoveFileWithProgressW.argBytes, 20);
        assert.equal(fns.MoveFileWithProgressA.argBytes, 20);
    });

test('after SetFileApisToOEM the ANSI spellings read and write names in the OEM page', ()=>{
    const { files, memory, fns } = setup();
    assert.equal(fns.AreFileApisANSI.handler(), 1, 'the ANSI page by default');
    files.put('C:\\GAME\\\u00fc.TXT', 'umlaut');
    // 0x81 is u-umlaut in page 437 and no character at all in page 1252.
    memory.writeMemory(NAME, Uint8Array.from([...'C:\\GAME\\'].map(c=>c.charCodeAt(0))
        .concat([0x81], [...'.TXT'].map(c=>c.charCodeAt(0)), [0])));
    assert.equal(fns.GetFileAttributesA.handler([NAME]), 0xffffffff, 'not that name in 1252');
    fns.SetFileApisToOEM.handler();
    assert.equal(fns.AreFileApisANSI.handler(), 0);
    assert.notEqual(fns.GetFileAttributesA.handler([NAME]), 0xffffffff, 'found in 437');
    const length = fns.GetFullPathNameA.handler([NAME, 0x40, NAME2, 0]);
    assert.equal(memory.bytes[NAME2 + length - 5], 0x81, 'and written back in it');
    fns.SetFileApisToANSI.handler();
    assert.equal(fns.AreFileApisANSI.handler(), 1);
});

test('in the OEM page a name ending just short of the end of its memory is read without reading'
    + ' past it', ()=>{
    // Past the end lies another allocation, or nothing: memory refuses a read
    // that runs into it, as the memory layer refuses one past a region's end.
    const end = 0x1000;
    const { files, memory, fns } = setup({
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>{
            assert.ok(address + length <= end, `read of ${length} bytes at`
                + ` 0x${address.toString(16)} runs past the end of memory`);
            return memory.bytes.subarray(address, address + length);
        },
    });
    files.put('C:\\GAME\\\u00fc.TXT', 'umlaut');
    const name = Uint8Array.from([...'C:\\GAME\\'].map(c=>c.charCodeAt(0))
        .concat([0x81], [...'.TXT'].map(c=>c.charCodeAt(0)), [0]));
    memory.writeMemory(end - 8 - name.length, name);
    fns.SetFileApisToOEM.handler();
    assert.notEqual(fns.GetFileAttributesA.handler([end - 8 - name.length]), 0xffffffff);
    fns.SetFileApisToANSI.handler();
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
        [putWide(memory, NAME, 'C:\\GAME\\*.DAT'), 0x600]);
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

test('no file answers a control code', ()=>{
    const { fns, error, files, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'x');
    const file = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    assert.equal(fns.DeviceIoControl.handler([file, 0x70000, 0, 0, 0x400, 24, 0x500, 0]), 0);
    assert.equal(error.code, 1, 'ERROR_INVALID_FUNCTION');
    assert.equal(fns.DeviceIoControl.argBytes, 32);
    const control = /** @type {any} */ (fns.CreateFileW).natives.NtDeviceIoControlFile;
    assert.equal(control.argBytes, 40);
    assert.equal(control.handler([file, 0, 0, 0, 0x300, 0x70000, 0, 0, 0, 0]) >>> 0,
        0xc0000010, 'STATUS_INVALID_DEVICE_REQUEST');
    assert.equal(control.handler([0x999, 0, 0, 0, 0x300, 0x70000, 0, 0, 0, 0]) >>> 0,
        0xc0000008, 'STATUS_INVALID_HANDLE');
});

test('the mount manager opens by name and lists every drive\'s two links', ()=>{
    const { fns, memory, error } = setup({ drives: ()=>['C', 'D'],
        volume: (/** @type {string} */ letter)=>(letter === 'D' ? { kind: 'cdrom' } : {}) });
    const device = fns.CreateFileW.handler(
        [putWide(memory, NAME, '\\\\.\\MountPointManager'), 0, 0, 0, OPEN_EXISTING, 0, 0]);
    assert.notEqual(device, INVALID_HANDLE_VALUE);
    assert.equal(error.code, 0);
    const control = /** @type {any} */ (fns.CreateFileW).natives.NtDeviceIoControlFile;
    const block = 0x300;
    const input = 0x340;
    const out = 0xa00;
    memory.bytes.fill(0, input, input + 24);
    memory.bytes.fill(0xcc, out, out + 0x600);
    const QUERY = 0x6d0008;
    const untouched = ()=>{
        memory.writeMemory(block, new Uint8Array([0x0d, 0xf0, 0xad, 0xde, 0x0d, 0xf0, 0xad, 0xde]));
    };

    untouched();
    assert.equal(control.handler([device, 0, 0, 0, block, QUERY, 0, 0, 0, 0]) >>> 0, 0xc000000d);
    assert.equal(memory.dword(block) >>> 0, 0xdeadf00d, 'a refusal writes no block');
    assert.equal(control.handler([device, 0, 0, 0, block, QUERY, input, 23, out, 32]) >>> 0,
        0xc000000d, 'an input short of a MOUNTMGR_MOUNT_POINT');
    assert.equal(control.handler([device, 0, 0, 0, block, QUERY, input, 24, out, 31]) >>> 0,
        0xc000000d, 'an output short of MOUNTMGR_MOUNT_POINTS');
    assert.equal(memory.dword(out) >>> 0, 0xcccccccc);

    assert.equal(control.handler([device, 0, 0, 0, block, QUERY, input, 24, out, 32]) >>> 0,
        0x80000005, 'STATUS_BUFFER_OVERFLOW');
    assert.equal(memory.dword(block) >>> 0, 0x80000005);
    assert.equal(memory.dword(block + 4), 8, 'the header');
    const size = memory.dword(out);
    assert.equal(memory.dword(out + 4), 4, 'C: and D:, each by letter and by volume');

    assert.equal(control.handler([device, 0, 0, 0, block, QUERY, input, 24, out, size]), 0);
    assert.equal(memory.dword(block + 4), size);
    /** @param {number} at */
    const text = at=>{
        const offset = memory.dword(at);
        const length = memory.bytes[at + 4] | memory.bytes[at + 5] << 8;
        let read = '';
        for (let unit = 0; unit < length; unit += 2)
        {
            read += String.fromCharCode(memory.bytes[out + offset + unit]
                | memory.bytes[out + offset + unit + 1] << 8);
        }
        return read;
    };
    assert.equal(text(out + 8), '\\DosDevices\\C:');
    assert.equal(text(out + 8 + 16), '\\Device\\HarddiskVolume1');
    assert.match(text(out + 32), /^\\\?\?\\Volume\{[0-9a-f-]{36}\}$/);
    assert.equal(text(out + 56 + 16), '\\Device\\CdRom0');
    assert.equal(memory.dword(out + 32 + 8 + 4) & 0xffff, 12, 'an MBR unique ID');

    assert.equal(fns.DeviceIoControl.handler([device, QUERY, input, 24, out, 32, 0x500, 0]), 0);
    assert.equal(error.code, 234, 'ERROR_MORE_DATA');
    assert.equal(memory.dword(0x500), 8);
    assert.equal(fns.DeviceIoControl.handler([device, QUERY, input, 24, out, size, 0x500, 0]),
        1);
    assert.equal(memory.dword(0x500), size);
    assert.equal(fns.CloseHandle.handler([device]), 1);
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

test('the long and short forms keep the name as given; an 8.3 component takes the volume\'s case',
    ()=>{
        // Wine's kernel32 path tests: relative stays relative, a trailing
        // '\\' stays, a long component keeps the caller's case.
        const { files, fns, at, memory } = setup();
        files.mkdir('C:\\WINDOWS\\TEMP\\shortdir');
        files.put('C:\\WINDOWS\\TEMP\\shortdir\\pathtest.pth', 'x');
        files.put('C:\\WINDOWS\\TEMP\\Long Directory\\Long File test.path', 'x');
        // The volume matches names without regard to case; this fake does not.
        const stat = files.stat.bind(files);
        files.stat = path=>stat(['C:\\WINDOWS\\TEMP\\shortdir\\pathtest.pth',
            'C:\\WINDOWS\\TEMP\\Long Directory\\Long File test.path']
            .find(known=>known.toLowerCase() === path.toLowerCase()) ?? path);
        assert.equal(fns.SetCurrentDirectoryA.handler([at(NAME, 'C:\\WINDOWS\\TEMP')]), 1);
        /** @param {string} api @param {string} name */
        const form = (api, name)=>(fns[api].handler([at(NAME, name), OUT_PATH, 260])
            ? memory.readCString(OUT_PATH, 260) : null);
        assert.equal(form('GetShortPathNameA', 'C:\\WINDOWS\\TEMP\\'), 'C:\\WINDOWS\\TEMP\\');
        assert.equal(form('GetLongPathNameA', 'C:'), 'C:');
        assert.equal(form('GetShortPathNameA', 'shortdir\\pathtest.pth'), 'shortdir\\pathtest.pth');
        assert.equal(form('GetLongPathNameA', 'SHORTDIR\\Pathtest.pth'), 'shortdir\\pathtest.pth');
        assert.equal(form('GetLongPathNameA', '.\\long directory\\long File test.path'),
            '.\\long directory\\long File test.path');
        assert.equal(form('GetLongPathNameA', 'shortdir\\absent.txt'), null);
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
        'C:\\WINDOWS\\system32\\drivers', 'C:\\WINDOWS\\system32\\drivers\\etc',
        // GetWindowsDirectory and "inf": where a driver's setup puts its INF.
        'C:\\WINDOWS\\inf',
        // Windows Installer's cache, where WiX's deferred actions keep their scripts.
        'C:\\WINDOWS\\Installer',
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
    memory.bytes.set([...bytesOf('C:\\GAME\\*'), 0xe9, 0], NAME);
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

test('CreateFile opens the pipe device by its Win32 name, as its native name opens', ()=>{
    /** @type {[string, number, number][]} */
    const opens = [];
    const { fns, at, handles } = setup({ pipes: {
        /** @param {{ root: number, name: string }} given @param {number} access @param {number} options */
        nativeOpen: (given, access, options)=>{
            opens.push([given.name, access, options]);
            return { handle: handles.open('pipe', {}, access) };
        },
        isPipe: ()=>false,
    } });
    const device = fns.CreateFileA.handler([at(NAME, '\\\\.\\pipe'), 0, 0, 0, OPEN_EXISTING, 0, 0]);
    assert.notEqual(device >>> 0, 0xffffffff);
    assert.deepEqual(opens.at(-1), ['\\??\\pipe', 0x00100080, 0x20],
        'the device, with SYNCHRONIZE and FILE_READ_ATTRIBUTES, opened for synchronous I/O');
    fns.CreateFileA.handler([at(NAME, '\\\\.\\PIPE\\'), 0, 0, 0, OPEN_EXISTING, 0x40000000, 0]);
    assert.deepEqual(opens.at(-1), ['\\??\\pipe\\', 0x00100080, 0], 'its root, overlapped');
});

test('NtCreateFile opens what the pipe device answers there, with the rights asked', ()=>{
    /** @type {[string, number, number, number][]} */
    const opens = [];
    const { fns, memory, handles } = setup({ pipes: {
        /**
         * @param {{ root: number, name: string }} given @param {number} access
         * @param {number} options @param {number} disposition
         */
        nativeOpen: (given, access, options, disposition)=>{
            if (!/pipe/i.test(given.name))
            {
                return null;
            }
            opens.push([given.name, access, options, disposition]);
            return given.name.endsWith('busy') ? { error: 231 }
                : given.name.endsWith('gone') ? { status: 0xc0000033 }
                    : { handle: handles.open('pipe', {}, access) };
        },
        isPipe: ()=>false,
    } });
    const native = /** @type {any} */ (fns.CreateFileW).natives.NtCreateFile;
    const SYNCHRONIZE = 0x00100000;
    /** @param {string} name @param {number} options */
    const open = (name, options)=>native.handler([NT_HANDLE, SYNCHRONIZE,
        objectAttributes(memory, name), NT_STATUS, 0, 0, 3, FILE_OPEN, options, 0, 0]) >>> 0;
    assert.equal(open('\\??\\pipe\\game', 0x20), 0);
    assert.deepEqual(opens.at(-1), ['\\??\\pipe\\game', SYNCHRONIZE, 0x20, FILE_OPEN],
        'the name, the rights, the options and the disposition, as given');
    assert.equal(open('\\??\\pipe\\busy', 0), 0xc00000ac, 'a Win32 error as its status');
    assert.equal(open('\\??\\pipe\\gone', 0), 0xc0000033, 'a status as it is');

    // FileAccessInformation is the handle's rights; a process handle is the wrong object.
    const query = /** @type {any} */ (fns.CreateFileW).natives.NtQueryInformationFile;
    assert.equal(open('\\??\\pipe\\game', 0x20), 0);
    assert.equal(query.handler([memory.dword(NT_HANDLE), 0x300, 0x400, 4, 8]), 0);
    assert.equal(memory.dword(0x400), SYNCHRONIZE);
    assert.equal(query.handler([0xffffffff, 0x300, 0x400, 8, 23]) >>> 0, 0xc0000024,
        'STATUS_OBJECT_TYPE_MISMATCH');
    assert.equal(query.handler([0x7770, 0x300, 0x400, 8, 23]) >>> 0, 0xc0000008,
        'STATUS_INVALID_HANDLE');
});

test('a native request on a pipe end clears its event first, and one done at once with a'
    + ' warning signals it and queues its APC', ()=>{
    /** @type {string[]} */
    const said = [];
    /** @type {any[]} */
    const queued = [];
    /** @type {{ handles: any }} */
    const held = { handles: null };
    const { fns, handles } = setup({
        resetEvent: (/** @type {number} */ event)=>said.push(`reset ${event}`),
        setEvent: (/** @type {number} */ event)=>said.push(`set ${event}`),
        currentThread: ()=>'main',
        queueApc: (/** @type {any[]} */ ...args)=>queued.push(args),
        streams: [{
            /** @param {number} handle */
            read: handle=>(held.handles.typeOf(handle) === 'pipe' ? 0x80000005 : null),
            write: ()=>null,
        }],
        pipes: {
            isPipe: (/** @type {number} */ handle)=>held.handles.typeOf(handle) === 'pipe',
            control: ()=>({ status: 0, information: 16 }),
            flushNative: ()=>0,
            information: ()=>null,
            setInformation: ()=>null,
        },
    });
    held.handles = handles;
    const pipe = handles.open('pipe', {});
    const natives = /** @type {any} */ (fns.CreateFileW).natives;
    assert.equal(natives.NtReadFile.handler([pipe, 0x44, 0x401000, 5, 0x300, 0x400, 2, 0, 0])
        >>> 0, 0x80000005, 'STATUS_BUFFER_OVERFLOW: part of a message');
    assert.deepEqual(said, ['reset 68', 'set 68'], 'cleared as made, set as done');
    assert.deepEqual(queued.at(-1), ['main', 0x401000, [5, 0x300, 0]]);
    said.length = 0;
    assert.equal(natives.NtFsControlFile.handler([pipe, 0x44, 0, 0, 0x300, 0x11400c, 0, 0,
        0x400, 32]), 0);
    assert.deepEqual(said, ['reset 68', 'set 68'], 'a peek done at once says so too');
    assert.equal(natives.NtFlushBuffersFile.handler([pipe, 0x300]), 0, 'the pipe flushes it');
});

test('a deletion is the file\'s: pending, it opens no more and goes with the last open of it',
    ()=>{
        const { memory, files, fns, open } = setup();
        const set = /** @type {any} */ (fns.CreateFileW).natives.NtSetInformationFile;
        const query = /** @type {any} */ (fns.CreateFileW).natives.NtQueryInformationFile;
        const native = /** @type {any} */ (fns.CreateFileW).natives.NtCreateFile;
        files.put('C:\\GAME\\d.tmp', 'x');
        const writer = open('C:\\GAME\\d.tmp', OPEN_EXISTING, GENERIC_WRITE);
        memory.bytes[0x800] = 1;
        assert.equal(set.handler([writer, 0x300, 0x800, 1, 13]) >>> 0, 0xc0000022,
            'STATUS_ACCESS_DENIED: no DELETE on the handle');
        const deleter = open('C:\\GAME\\d.tmp', OPEN_EXISTING, DELETE);
        assert.equal(set.handler([deleter, 0x300, 0x800, 1, 13]), 0);
        assert.equal(query.handler([writer, 0x300, 0x400, 24, 5]), 0);
        assert.equal(memory.bytes[0x400 + 20], 1, 'DeletePending, through either handle');
        assert.equal(native.handler([NT_HANDLE, GENERIC_READ,
            objectAttributes(memory, '\\??\\C:\\GAME\\d.tmp'), NT_STATUS, 0, 0, 7, FILE_OPEN,
            0, 0, 0]) >>> 0, 0xc0000056, 'STATUS_DELETE_PENDING');
        const attributes = /** @type {any} */ (fns.CreateFileW).natives.NtQueryAttributesFile;
        assert.equal(attributes.handler([objectAttributes(memory, '\\??\\C:\\GAME\\d.tmp'),
            0x400]) >>> 0, 0xc0000056, 'its attributes asked by name: pending too');
        assert.equal(fns.CloseHandle.handler([deleter]), 1);
        assert.ok(files.nodes.has('C:\\GAME\\d.tmp'), 'the writer still has it open');
        assert.equal(fns.CloseHandle.handler([writer]), 1);
        assert.ok(!files.nodes.has('C:\\GAME\\d.tmp'), 'gone with the last');

        // A handle deleting on close leaves the file pending to the open it shares.
        files.put('C:\\GAME\\e.tmp', 'x');
        const reader = open('C:\\GAME\\e.tmp', OPEN_EXISTING, GENERIC_READ);
        const closing = open('C:\\GAME\\e.tmp', OPEN_EXISTING, GENERIC_READ, 0x04000000);
        assert.equal(fns.CloseHandle.handler([closing]), 1);
        assert.ok(files.nodes.has('C:\\GAME\\e.tmp'));
        assert.equal(fns.CloseHandle.handler([reader]), 1);
        assert.ok(!files.nodes.has('C:\\GAME\\e.tmp'));

        // A read-only file cannot be deleted: the native call names it.
        files.put('C:\\GAME\\r.tmp', 'x');
        files.setAttributes('C:\\GAME\\r.tmp', FILE_ATTRIBUTE_READONLY);
        const readOnly = open('C:\\GAME\\r.tmp', OPEN_EXISTING, DELETE);
        assert.equal(set.handler([readOnly, 0x300, 0x800, 1, 13]) >>> 0, 0xc0000121,
            'STATUS_CANNOT_DELETE');
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

test('NtCreateFile checks its options before the name, and a name before the volume', ()=>{
    const { fns, memory, files } = setup();
    const native = /** @type {any} */ (fns.CreateFileW).natives.NtCreateFile;
    const SYNCHRONIZE = 0x100000;
    const FILE_SUPERSEDE = 0;
    const FILE_OVERWRITE_IF = 5;
    const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
    /**
     * @param {string} name @param {number} access @param {number} disposition
     * @param {number} options
     */
    const open = (name, access, disposition, options)=>
        native.handler([NT_HANDLE, access, objectAttributes(memory, name), NT_STATUS,
            0, 0, 7, disposition, options, 0, 0]) >>> 0;

    assert.equal(open('\\SystemRoot\\nowhere', GENERIC_READ, FILE_OPEN,
        FILE_SYNCHRONOUS_IO_NONALERT), 0xc000000d,
    'synchronous I/O without SYNCHRONIZE asked: refused before the name is looked for');
    assert.equal(open('\\??\\C:\\GAME', GENERIC_READ | SYNCHRONIZE, FILE_SUPERSEDE,
        FILE_DIRECTORY_FILE), 0xc000000d, 'a directory is only opened or made');
    assert.equal(open('\\??\\C:\\GAME', GENERIC_READ, FILE_OVERWRITE_IF, 0), 0xc0000022,
        'nor is one emptied as a file');
    for (const name of ['\\??\\C:\\GAME\\a?b', '\\??\\C:\\GAME\\a|b', '\\??\\', '\\\\?\\'])
    {
        assert.equal(open(name, GENERIC_READ | SYNCHRONIZE, FILE_CREATE, FILE_DIRECTORY_FILE),
            0xc0000033, `${name}: STATUS_OBJECT_NAME_INVALID`);
    }
    assert.equal(files.stat('C:\\GAME\\a?b')?.exists ?? false, false, 'nothing made');

    // A directory has no bytes: reading it is no request its file system takes.
    assert.equal(open('\\??\\C:\\GAME', GENERIC_READ | SYNCHRONIZE, FILE_OPEN,
        FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT), 0);
    const read = /** @type {any} */ (fns.CreateFileW).natives.NtReadFile;
    assert.equal(read.handler([memory.dword(NT_HANDLE), 0, 0, 0, 0x300, 0x400, 4, 0, 0]) >>> 0,
        0xc0000010, 'STATUS_INVALID_DEVICE_REQUEST');
});

test('a handle keeps the I/O mode it was opened in, and an asynchronous one has no pointer',
    ()=>{
        const { fns, memory, files } = setup();
        const native = /** @type {any} */ (fns.CreateFileW).natives;
        const SYNCHRONIZE = 0x100000;
        files.put('C:\\GAME\\M.DAT', 'abcdef');
        /** @param {number} options */
        const open = options=>{
            assert.equal(native.NtCreateFile.handler([NT_HANDLE, GENERIC_READ | GENERIC_WRITE
                | SYNCHRONIZE, objectAttributes(memory, '\\??\\C:\\GAME\\M.DAT'), NT_STATUS,
            0, 0, 7, FILE_OPEN, options, 0, 0]), 0);
            return memory.dword(NT_HANDLE);
        };
        /** @param {number} handle */
        const mode = handle=>{
            assert.equal(native.NtQueryInformationFile.handler([handle, 0x300, 0x400, 4, 16]), 0);
            return memory.dword(0x400);
        };
        // FILE_WRITE_THROUGH, FILE_SEQUENTIAL_ONLY, FILE_SYNCHRONOUS_IO_ALERT kept;
        // FILE_DELETE_ON_CLOSE and FILE_RANDOM_ACCESS act at the open and are gone.
        assert.equal(mode(open(0x2 | 0x4 | 0x10 | 0x800)), 0x16);
        assert.equal(mode(open(0)), 0, 'opened for asynchronous I/O');

        const handle = open(0);
        const write = native.NtWriteFile;
        assert.equal(write.handler([handle, 0, 0, 0, 0x300, 0x500, 2, 0, 0]) >>> 0, 0xc000000d,
            'an asynchronous request says where');
        memory.putDword(0x600, 0xfffffffe);
        memory.putDword(0x604, 0xffffffff);
        assert.equal(write.handler([handle, 0, 0, 0, 0x300, 0x500, 2, 0x600, 0]) >>> 0,
            0xc000000d, 'and the file pointer it has none of is no place');
        memory.putDword(0x600, 2);
        memory.putDword(0x604, 0);
        assert.equal(write.handler([handle, 0, 0, 0, 0x300, 0x500, 2, 0x600, 0]), 0);
        assert.equal(native.NtQueryInformationFile.handler([handle, 0x300, 0x400, 8, 14]), 0);
        assert.equal(memory.dword(0x400), 0, 'FilePositionInformation: the pointer stays');
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

test('CopyFileEx tells its progress routine the stream and each chunk, and stops as it says',
    async()=>{
        /** @type {number[][]} */
        const calls = [];
        /** @type {number[]} */
        let answers = [];
        const { files, error, fns, memory } = setup({
            currentThread: ()=>'caller',
            /** @param {number} entry @param {number[]} args @param {any} thread */
            callGuest: async(entry, args, thread)=>{
                assert.equal(entry, 0x7000);
                assert.equal(thread, 'caller', 'on the copying thread');
                calls.push(args);
                return answers.shift() ?? 0;
            },
        });
        files.put('C:\\GAME\\A.TXT', 'abc');
        putWide(memory, NAME, 'C:\\GAME\\A.TXT');
        putWide(memory, NAME2, 'C:\\GAME\\B.TXT');
        const copy = ()=>fns.CopyFileExW.handler([NAME, NAME2, 0x7000, 0x55, 0, 0]);

        assert.equal(await copy(), 1);
        assert.equal(files.text('C:\\GAME\\B.TXT'), 'abc');
        // total, transferred, stream size, stream transferred (each two
        // dwords), the stream, the reason, the two handles, the data.
        assert.deepEqual(calls.map(args=>[args[2], args[9], args[12]]),
            [[0, 1, 0x55], [3, 0, 0x55]],
            'CALLBACK_STREAM_SWITCH with nothing copied, then CALLBACK_CHUNK_FINISHED at 3');
        assert.deepEqual(calls[0].slice(0, 2), [3, 0], 'the size');
        assert.equal(calls[0][8], 1, 'the first stream');
        assert.notEqual(calls[0][10], 0, 'the source\'s handle');
        assert.notEqual(calls[0][11], 0, 'the destination\'s handle');

        calls.length = 0;
        answers = [1];
        error.code = 0;
        assert.equal(await copy(), 0, 'PROGRESS_CANCEL');
        assert.equal(error.code, ERROR_REQUEST_ABORTED);
        assert.equal(files.stat('C:\\GAME\\B.TXT')?.exists ?? false, false,
            'a cancelled copy deletes its destination');
        assert.equal(calls.length, 1);

        answers = [0, 2];
        assert.equal(await copy(), 0, 'PROGRESS_STOP after the chunk');
        assert.equal(error.code, ERROR_REQUEST_ABORTED);
        assert.equal(files.text('C:\\GAME\\B.TXT'), 'abc', 'a stopped copy keeps what it wrote');

        calls.length = 0;
        answers = [3];
        assert.equal(await copy(), 1, 'PROGRESS_QUIET');
        assert.equal(calls.length, 1, 'and is not called again');
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

test('NtQueryInformationFile answers the name, the size and the position of an open file', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcdefghij');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    fns.SetFilePointer.handler([handle, 3, 0, FILE_BEGIN]);
    const query = /** @type {any} */ (fns.CreateFileW).natives.NtQueryInformationFile;
    const block = 0x300;
    const out = 0x400;

    assert.equal(query.handler([handle, block, out, 0x100, 9]), 0, 'FileNameInformation');
    const name = '\\GAME\\SAVE.DAT';
    assert.equal(memory.dword(out), name.length * 2);
    assert.equal(memory.bytes[out + 4], name.charCodeAt(0));
    assert.equal(memory.dword(block + 4), 4 + name.length * 2);

    assert.equal(query.handler([handle, block, out, 0x100, 5]), 0, 'FileStandardInformation');
    assert.equal(memory.dword(out + 8), 10, 'EndOfFile');
    assert.equal(query.handler([handle, block, out, 8, 14]), 0, 'FilePositionInformation');
    assert.equal(memory.dword(out), 3);

    assert.equal(query.handler([handle, block, out, 4, 5]) >>> 0, 0xc0000004, 'too short');
    // A name's record needs its length and a character, aligned, before
    // anything is written: four bytes are refused, eight hold a part.
    assert.equal(query.handler([handle, block, out, 4, 9]) >>> 0, 0xc0000004);
    assert.equal(query.handler([handle, block, out, 8, 9]) >>> 0, 0x80000005);
    assert.equal(memory.dword(out), name.length * 2, 'the whole name\'s length');
    assert.equal(query.handler([handle, block, out, 0x100, 1]) >>> 0, 0xc0000003,
        'a class NtQueryDirectoryFile answers, not this');
    assert.equal(query.handler([0x999, block, out, 0x100, 9]) >>> 0, 0xc0000008);

    const control = /** @type {any} */ (fns.CreateFileW).natives.NtFsControlFile;
    assert.equal(control.argBytes, 40);
    assert.equal(control.handler([handle, 0, 0, 0, block, 0x900a8]) >>> 0, 0xc0000010,
        'STATUS_INVALID_DEVICE_REQUEST');
    assert.equal(memory.dword(block) >>> 0, 0xc0000010);
    assert.equal(control.handler([0xffffffff, 0, 0, 0, 0, 0]) >>> 0, 0xc0000008,
        'no block to write is not a fault');
});

test('NtQueryEaFile: a file has none, said without the block; another object is a mismatch', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abc');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING, GENERIC_READ);
    const query = /** @type {any} */ (fns.CreateFileW).natives.NtQueryEaFile;
    memory.putDword(0x300, 0xdeadbeef);
    memory.bytes.fill(0xcc, 0x400, 0x410);
    assert.equal(query.handler([handle, 0x300, 0x400, 8, 1, 0, 0, 0, 0]) >>> 0, 0xc0000052,
        'STATUS_NO_EAS_ON_FILE');
    assert.equal(memory.dword(0x300) >>> 0, 0xdeadbeef, 'the block untouched');
    assert.deepEqual([...memory.bytes.subarray(0x400, 0x409)], [0, 0, 0, 0, 0, 0, 0, 0, 0xcc],
        'the buffer cleared to its length');
    assert.equal(query.handler([0xffffffff, 0x300, 0x400, 8, 1, 0, 0, 0, 0]) >>> 0, 0xc0000024,
        'the process\'s pseudo-handle');
    assert.equal(query.handler([0xdead, 0x300, 0x400, 8, 1, 0, 0, 0, 0]) >>> 0, 0xc0000008);
});

test('a file opens by the number FileInternalInformation answers, from any folder of its drive',
    ()=>{
        const { memory, files, fns, open } = setup();
        files.put('C:\\GAME\\SAVE.DAT', 'abcdefghij');
        files.nodes.set('C:\\GAME\\LEVELS', { data: new Uint8Array(0), directory: true });
        files.put('C:\\GAME\\LEVELS\\ONE.MAP', 'map');
        const native = /** @type {any} */ (fns.CreateFileW).natives;
        const query = native.NtQueryInformationFile;
        const save = open('C:\\GAME\\LEVELS\\ONE.MAP', OPEN_EXISTING, GENERIC_READ);
        assert.equal(query.handler([save, 0x300, 0x400, 8, 6]), 0, 'FileInternalInformation');
        const low = memory.dword(0x400);
        assert.equal(memory.dword(0x404), 0);
        fns.CloseHandle.handler([save]);

        assert.equal(native.NtCreateFile.handler([NT_HANDLE, GENERIC_READ, objectAttributes(memory,
            '\\??\\C:\\GAME'), NT_STATUS, 0, 0, 3, FILE_OPEN, FILE_DIRECTORY_FILE, 0, 0]), 0);
        const folder = memory.dword(NT_HANDLE);
        /** @param {number[]} id @param {number} root */
        const byId = (id, root)=>{
            objectAttributes(memory, '');
            id.forEach((value, at)=>memory.putDword(NT_NAME + at * 4, value));
            memory.putDword(NT_STRING, id.length * 4 | id.length * 4 << 16);
            memory.putDword(NT_ATTRIBUTES + 4, root);
            return native.NtCreateFile.handler([NT_HANDLE, GENERIC_READ, NT_ATTRIBUTES,
                NT_STATUS, 0, 0, 3, FILE_OPEN, 0x2000, 0, 0]) >>> 0;
        };
        assert.equal(byId([low, 0], folder), 0, 'found below the root handle\'s folder');
        const opened = memory.dword(NT_HANDLE);
        assert.equal(fns.ReadFile.handler([opened, BUFFER, 3, OUT_COUNT, 0]), 1);
        assert.equal(memory.dword(OUT_COUNT), 3, 'the same file: its three bytes');
        assert.equal(byId([low, 1], folder), 0xc000000d, 'a number no file has');
        assert.equal(byId([low, 0, 0, 0], folder), 0xc000000d, 'an object id: none kept');
        assert.equal(byId([low, 0], 0), 0xc0000008, 'a number needs a volume to be on');
    });

test('NtQueryInformationFile answers the mode, times, access and the whole record', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcdefghij');
    const query = /** @type {any} */ (fns.CreateFileW).natives.NtQueryInformationFile;
    const block = 0x300;
    const out = 0x400;
    const plain = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING, GENERIC_READ);
    assert.equal(query.handler([plain, block, out, 4, 16]), 0, 'FileModeInformation');
    assert.equal(memory.dword(out), 0x20, 'FILE_SYNCHRONOUS_IO_NONALERT alone');
    assert.equal(memory.dword(block + 4), 4);
    const sequential = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING, GENERIC_READ, 0x08000000);
    assert.equal(query.handler([sequential, block, out, 4, 16]), 0);
    assert.equal(memory.dword(out), 0x24, 'FILE_SEQUENTIAL_SCAN shows as FILE_SEQUENTIAL_ONLY');

    assert.equal(query.handler([plain, block, out, 40, 4]), 0, 'FileBasicInformation');
    assert.ok(memory.dword(out) !== 0 || memory.dword(out + 4) !== 0, 'a creation time');
    assert.equal(memory.dword(out + 24), memory.dword(out + 16), 'one time for each');
    assert.equal(memory.dword(out + 32), 0x20, 'FILE_ATTRIBUTE_ARCHIVE');

    assert.equal(query.handler([plain, block, out, 8, 35]), 0, 'FileAttributeTagInformation');
    assert.equal(memory.dword(out), 0x20);
    assert.equal(memory.dword(out + 4), 0, 'no reparse tag');

    assert.equal(query.handler([plain, block, out, 56, 34]), 0, 'FileNetworkOpenInformation');
    assert.equal(memory.dword(out + 40), 10, 'EndOfFile');
    assert.equal(memory.dword(out + 48), 0x20);

    assert.equal(query.handler([plain, block, out, 4, 8]), 0, 'FileAccessInformation');
    assert.equal(memory.dword(out), 0x120089, 'FILE_GENERIC_READ');

    assert.equal(query.handler([plain, block, out, 8, 6]), 0, 'FileInternalInformation');
    const index = memory.dword(out);
    assert.equal(query.handler([sequential, block, out, 8, 6]), 0);
    assert.equal(memory.dword(out), index, 'one file, one number');

    const name = '\\GAME\\SAVE.DAT';
    assert.equal(query.handler([plain, block, out, 0x100, 18]), 0, 'FileAllInformation');
    assert.equal(memory.dword(block + 4), 100 + name.length * 2);
    assert.equal(memory.dword(out + 48), 10, 'Standard.EndOfFile at 40 + 8');
    assert.equal(memory.dword(out + 88), 0x20, 'Mode at 88, after Position at 80');
    assert.equal(memory.dword(out + 96), name.length * 2, 'the name\'s length at 96');
    assert.equal(memory.bytes[out + 100], name.charCodeAt(0));
    assert.equal(query.handler([plain, block, out, 104, 18]) >>> 0, 0x80000005,
        'STATUS_BUFFER_OVERFLOW: the fixed part and what of the name fits');
    assert.equal(memory.dword(out + 96), name.length * 2, 'the whole length said');
});

test('a directory opens only with FILE_FLAG_BACKUP_SEMANTICS, and holds no bytes', ()=>{
    const { memory, files, fns, error, at } = setup();
    files.mkdir('C:\\GAME\\DATA');
    const BACKUP = 0x02000000;
    /** @param {number} disposition @param {number} flags @param {number} [access] */
    const openDir = (disposition, flags, access = GENERIC_READ)=>fns.CreateFileA.handler(
        [at(NAME, 'C:\\GAME\\DATA'), access, 0, 0, disposition, flags, 0]);
    assert.equal(openDir(OPEN_EXISTING, 0), INVALID_HANDLE_VALUE);
    assert.equal(error.code, 5, 'ERROR_ACCESS_DENIED without the flag');
    assert.equal(openDir(CREATE_ALWAYS, BACKUP), INVALID_HANDLE_VALUE);
    assert.equal(error.code, 5);
    assert.equal(openDir(CREATE_NEW, BACKUP), INVALID_HANDLE_VALUE);
    assert.equal(error.code, 80, 'ERROR_FILE_EXISTS');
    const directory = openDir(OPEN_EXISTING, BACKUP);
    assert.notEqual(directory, INVALID_HANDLE_VALUE);
    assert.equal(fns.ReadFile.handler([directory, 0x600, 4, 0x500, 0]), 0);
    assert.equal(error.code, 5, 'no bytes to read');

    const query = /** @type {any} */ (fns.CreateFileW).natives.NtQueryInformationFile;
    assert.equal(query.handler([directory, 0x300, 0x400, 24, 5]), 0);
    assert.equal(memory.bytes[0x400 + 21], 1, 'FileStandardInformation.Directory');
    assert.equal(query.handler([directory, 0x300, 0x400, 8, 35]), 0);
    assert.equal(memory.dword(0x400) & 0x10, 0x10, 'FILE_ATTRIBUTE_DIRECTORY');
    assert.equal(fns.CloseHandle.handler([directory]), 1);
    // A folder watched through a completion port (a FileSystemWatcher's) is
    // opened for overlapped I/O, and the port takes only such a handle.
    const FILE_MODE = 16;
    const plain = openDir(OPEN_EXISTING, BACKUP);
    assert.equal(query.handler([plain, 0x300, 0x400, 4, FILE_MODE]), 0);
    assert.equal(memory.dword(0x400) & 0x20, 0x20, 'FILE_SYNCHRONOUS_IO_NONALERT as opened');
    assert.equal(fns.CloseHandle.handler([plain]), 1);
    const watched = openDir(OPEN_EXISTING, BACKUP | 0x40000000);
    assert.equal(query.handler([watched, 0x300, 0x400, 4, FILE_MODE]), 0);
    assert.equal(memory.dword(0x400) & 0x20, 0, 'opened overlapped, it is not synchronous');
    assert.equal(fns.CloseHandle.handler([watched]), 1);
});

test('a volume\'s own name opens as its drive\'s root', ()=>{
    const { files, fns, at, error } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abc');
    const file = fns.CreateFileA.handler([at(NAME, `${volumeName('C')}GAME\\SAVE.DAT`),
        GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]);
    assert.notEqual(file, INVALID_HANDLE_VALUE);
    assert.equal(fns.GetFileSize.handler([file, 0]), 3);
    const root = fns.CreateFileA.handler([at(NAME, volumeName('C')), 0, 0, 0, OPEN_EXISTING,
        0x02000000, 0]);
    assert.notEqual(root, INVALID_HANDLE_VALUE, 'the root, as a directory');
    assert.equal(fns.CreateFileA.handler([at(NAME, volumeName('C')), GENERIC_READ, 0, 0,
        OPEN_EXISTING, 0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, 3, 'ERROR_PATH_NOT_FOUND: a directory spelled so, as a file');
    files.mkdir('C:\\GAME\\DATA');
    assert.notEqual(fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\DATA\\'), GENERIC_READ, 0, 0,
        OPEN_EXISTING, 0x02000000, 0]), INVALID_HANDLE_VALUE, 'a trailing separator, as itself');
    const device = `\\\\.\\${volumeName('C').slice(4, -1)}`;
    assert.equal(fns.CreateFileA.handler([at(NAME, device), GENERIC_READ, 0, 0, OPEN_EXISTING,
        0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, 5, 'the volume itself is not the caller\'s to read');
});

/**
 * Stands a watch in for the volume's, keeping what it was asked and whom to tell.
 *
 * @param {any} files
 */
function stubWatch(files){
    /** @type {{ asked: any[], notify: any }} */
    const kept = { asked: [], notify: null };
    /** @param {string} path @param {boolean} subtree @param {number} filter @param {any} notify */
    const watch = (path, subtree, filter, notify)=>{
        kept.asked.push({ path, subtree, filter });
        kept.notify = notify;
        return { close: ()=>{} };
    };
    files.watch = watch;
    return kept;
}

test('ReadDirectoryChangesW keeps changes until asked; the first call sets the watch', async()=>{
    /** @type {string[]} */
    const reset = [];
    /** @type {{ thread: any, routine: number, args: number[] }[]} */
    const queued = [];
    const { memory, files, fns, error, at } = setup({
        resetEvent: (/** @type {number} */ handle)=>reset.push(`reset ${handle}`),
        currentThread: ()=>'main',
        queueApc: (/** @type {any} */ thread, /** @type {number} */ routine,
            /** @type {number[]} */ args)=>queued.push({ thread, routine, args }),
    });
    files.mkdir('C:\\GAME\\SAVES');
    const stub = stubWatch(files);
    const watches = stub.asked;
    const told = (/** @type {any[]} */ records)=>stub.notify(records);
    const directory = fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\SAVES'), GENERIC_READ, 3, 0,
        OPEN_EXISTING, 0x02000000 | 0x40000000, 0]);
    const read = fns.ReadDirectoryChangesW;
    assert.equal(read.argBytes, 32);
    const buffer = 0x600;
    const ov = 0x500;
    memory.bytes.fill(0, ov, ov + 20);
    memory.writeMemory(ov + 16, new Uint8Array([0x44, 0, 0, 0]));

    assert.equal(read.handler([0, 0, 0, 0, 0, 0, 0, 0]), 0);
    assert.equal(error.code, 87, 'no filter is a bad parameter, before the handle');
    assert.equal(read.handler([directory, buffer, 0x100, 0, 0x200, 0, ov, 0]), 0);
    assert.equal(error.code, 87, 'a filter flag that is none');
    assert.equal(read.handler([0x999, buffer, 0x100, 0, 1, 0, ov, 0]), 0);
    assert.equal(error.code, 6);

    assert.equal(read.handler([directory, buffer, 0x100, 1, 0x3, 0, ov, 0]), 1);
    assert.deepEqual(watches, [{ path: 'C:\\GAME\\SAVES', subtree: true, filter: 3 }]);
    assert.equal(memory.dword(ov), 0x103, 'STATUS_PENDING');
    assert.deepEqual(reset, ['reset 68'], 'its event cleared');
    told([{ action: 1, name: 'hoo' }]);
    assert.equal(memory.dword(ov), 0, 'STATUS_SUCCESS');
    assert.equal(memory.dword(ov + 4), 0x12, 'one record, unpadded');
    assert.equal(memory.dword(buffer), 0);
    assert.equal(memory.dword(buffer + 4), 1, 'FILE_ACTION_ADDED');
    assert.equal(memory.dword(buffer + 8), 6);
    assert.equal(memory.bytes[buffer + 12], 'h'.charCodeAt(0));

    told([{ action: 4, name: 'a' }, { action: 5, name: 'bb' }]);
    assert.equal(read.handler([directory, buffer, 0x100, 0, 0x10, 0, ov, 0]), 1,
        'kept since; the later filter is not looked at');
    assert.equal(watches.length, 1);
    assert.equal(memory.dword(buffer), 16, 'the next on a four-byte boundary');
    assert.equal(memory.dword(buffer + 16 + 4), 5);
    assert.equal(memory.dword(ov + 4), 16 + 16);

    assert.equal(read.handler([directory, buffer, 0x10, 0, 3, 0, ov, 0]), 1);
    told([{ action: 2, name: 'hoo' }]);
    assert.equal(memory.dword(ov), 0x10c, 'STATUS_NOTIFY_ENUM_DIR: no room');
    assert.equal(memory.dword(ov + 4), 0);

    const resets = reset.length;
    assert.equal(read.handler([directory, buffer, 0x100, 0, 3, 0, ov, 0x7000]), 1);
    told([{ action: 3, name: 'x' }]);
    assert.deepEqual(queued, [{ thread: 'main', routine: 0x7000, args: [0, 14, ov] }],
        'the routine told on the calling thread');
    assert.equal(reset.length, resets, 'with a routine the event is not touched');

    const waiting = read.handler([directory, buffer, 0x100, 0, 3, 0x580, 0, 0]);
    assert.ok(waiting instanceof Promise, 'a synchronous call waits');
    told([{ action: 2, name: 'x' }]);
    assert.equal(await waiting, 1);
    assert.equal(memory.dword(0x580), 14);

    files.put('C:\\GAME\\SAVES\\ONE.DAT', 'x');
    const file = fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\SAVES\\ONE.DAT'), GENERIC_READ, 0,
        0, OPEN_EXISTING, 0, 0]);
    assert.equal(read.handler([file, buffer, 0x100, 0, 3, 0, ov, 0]), 0);
    assert.equal(error.code, 87, 'a file is no directory to watch');
});

test('a watch made with no room loses every change and says so', ()=>{
    const { memory, files, fns, at } = setup();
    files.mkdir('C:\\GAME\\SAVES');
    const stub = stubWatch(files);
    const told = (/** @type {any[]} */ records)=>stub.notify(records);
    const directory = fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\SAVES'), GENERIC_READ, 3, 0,
        OPEN_EXISTING, 0x02000000 | 0x40000000, 0]);
    const ov = 0x500;
    memory.bytes.fill(0, ov, ov + 20);
    assert.equal(fns.ReadDirectoryChangesW.handler([directory, 0, 0, 0, 3, 0, ov, 0]), 1);
    told([{ action: 1, name: 'hoo' }]);
    assert.equal(memory.dword(ov), 0x10c);
    assert.equal(fns.ReadDirectoryChangesW.handler([directory, 0x600, 0x100, 0, 3, 0, ov, 0]), 1);
    told([{ action: 2, name: 'hoo' }]);
    assert.equal(memory.dword(ov), 0x10c, 'the first call\'s room is the watch\'s');
});

test('FileLinkInformation gives an open file one more name, a taken one only when replacing',
    ()=>{
        const { memory, files, fns, open } = setup();
        const anyFiles = /** @type {any} */ (files);
        anyFiles.link = (/** @type {string} */ name, /** @type {string} */ existing)=>{
            files.put(name, files.text(existing) ?? '');
            return null;
        };
        const view = new DataView(memory.bytes.buffer);
        const native = /** @type {any} */ (fns.CreateFileW).natives.NtSetInformationFile;
        const LINK = 11;
        const LINK_EX = 72;
        /** @param {number} handle @param {string} name @param {number} flags @param {number} kind */
        const link = (handle, name, flags, kind = LINK)=>{
            memory.bytes.fill(0, 0x800, 0x880);
            view.setUint32(0x800, flags, true);
            view.setUint32(0x808, name.length * 2, true);
            putWide(memory, 0x80c, name);
            view.setUint32(0x300, 0xdeadbeef, true);
            return native.handler([handle, 0x300, 0x800, 12 + name.length * 2, kind]) >>> 0;
        };
        files.put('C:\\GAME\\a.tmp', 'abc');
        files.put('C:\\GAME\\taken.tmp', 'old');
        const file = open('C:\\GAME\\a.tmp', OPEN_EXISTING, GENERIC_WRITE);
        assert.equal(link(file, 'b.tmp', 0), 0, 'no DELETE needed');
        assert.equal(memory.dword(0x300), 0, 'the block says so');
        assert.equal(files.text('C:\\GAME\\b.tmp'), 'abc');
        assert.equal(files.text('C:\\GAME\\a.tmp'), 'abc', 'the first name stays');
        assert.equal(link(file, 'taken.tmp', 0), 0xc0000035, 'STATUS_OBJECT_NAME_COLLISION');
        assert.equal(link(file, 'taken.tmp', 1), 0);
        assert.equal(files.text('C:\\GAME\\taken.tmp'), 'abc', 'replaced');
        assert.equal(link(file, 'a.tmp', 0), 0xc0000035, 'its own name is taken');
        assert.equal(link(file, 'a.tmp', 1), 0, 'and is its link already');

        files.put('C:\\GAME\\ro.tmp', 'ro');
        files.setAttributes('C:\\GAME\\ro.tmp', 0x1);
        assert.equal(link(file, 'ro.tmp', 0x1, LINK_EX), 0xc0000022, 'a read-only one kept');
        assert.equal(link(file, 'ro.tmp', 0x41, LINK_EX), 0, 'unless ignored');

        const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        const folder = fns.CreateFileA.handler([memory.putString(NAME, 'C:\\GAME') ?? NAME,
            GENERIC_WRITE, 0, 0, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, 0]) >>> 0;
        assert.equal(link(folder, 'c.tmp', 0), 0xc00000ba, 'STATUS_FILE_IS_A_DIRECTORY');
    });

test('CreateHardLink links through the volume and answers its refusals as Windows does', ()=>{
    /** @type {string[]} */
    const said = [];
    const { files, error, fns, at } = setup({
        divergence: (/** @type {string} */ api)=>said.push(api) });
    const anyFiles = /** @type {any} */ (files);
    assert.equal(fns.CreateHardLinkA.argBytes, 12);
    assert.equal(fns.CreateHardLinkA.handler(
        [at(NAME2, 'C:\\GAME\\LINK.DAT'), at(NAME, 'C:\\GAME\\SAVE.DAT'), 0]), 0);
    assert.equal(error.code, 1, 'a volume that keeps no links: ERROR_INVALID_FUNCTION');
    assert.deepEqual(said, ['CreateHardLink']);

    /** @type {string[][]} */
    const asked = [];
    let refusal = /** @type {string | null} */ (null);
    anyFiles.link = (/** @type {string} */ name, /** @type {string} */ existing)=>{
        asked.push([name, existing]);
        return refusal;
    };
    assert.equal(fns.CreateHardLinkA.handler([NAME2, NAME, 0]), 1);
    assert.deepEqual(asked, [['C:\\GAME\\LINK.DAT', 'C:\\GAME\\SAVE.DAT']]);
    for (const [code, expected] of /** @type {[string, number][]} */ ([
        ['ALREADY_EXISTS', 183], ['ACCESS_DENIED', 5], ['NOT_SAME_DEVICE', 17],
        ['NOT_FOUND', 2], ['PATH_NOT_FOUND', 3], ['WRITE_PROTECTED', 19]]))
    {
        refusal = code;
        assert.equal(fns.CreateHardLinkA.handler([NAME2, NAME, 0]), 0, code);
        assert.equal(error.code, expected, code);
    }

    assert.equal(fns.CreateSymbolicLinkW.argBytes, 12);
    assert.equal(fns.CreateSymbolicLinkA.handler([NAME2, NAME, 0]), 0);
    assert.equal(error.code, 1314, 'ERROR_PRIVILEGE_NOT_HELD');
    assert.equal(said.at(-1), 'CreateSymbolicLink');
});

test('a directory handle sets, reads and deletes a mount point through DeviceIoControl', ()=>{
    // fusion makes an assembly's GAC folder a junction to its WinSxS copy:
    // FSCTL_SET_REPARSE_POINT on the folder opened with backup semantics.
    const { memory, files, fns, error, at } = setup();
    const anyFiles = /** @type {any} */ (files);
    files.mkdir('C:\\GAME\\LIB');
    /** @type {[string, any][]} */
    const asked = [];
    /** @type {{ tag: number, data: Uint8Array | null, target: string | null } | null} */
    let point = null;
    let refusal = /** @type {string | null} */ (null);
    anyFiles.setReparse = (/** @type {string} */ path, /** @type {any} */ given)=>{
        asked.push([path, given && { tag: given.tag, target: given.target }]);
        if (refusal === null)
        {
            point = given;
        }
        return refusal;
    };
    anyFiles.reparseOf = ()=>point && { tag: point.tag, data: point.data };
    const stat = anyFiles.stat.bind(files);
    anyFiles.stat = (/** @type {string} */ path)=>{
        const entry = stat(path);
        return entry && point && path === 'C:\\GAME\\LIB'
            ? { ...entry, reparseTag: point.tag, junction: point.target?.slice(3) } : entry;
    };
    const folder = fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\LIB'), GENERIC_READ, 0, 0,
        OPEN_EXISTING, 0x02200000, 0]);
    assert.notEqual(folder, INVALID_HANDLE_VALUE);

    const SET = 0x900a4;
    const GET = 0x900a8;
    const UNSET = 0x900ac;
    const target = '\\??\\C:\\SXS\\LIB';
    const input = 0x600;
    const buffer = new Uint8Array(16 + target.length * 2 + 2 + 2);
    const view = new DataView(buffer.buffer);
    view.setUint32(0, 0xa0000003, true);
    view.setUint16(4, buffer.length - 8, true);
    view.setUint16(10, target.length * 2, true);
    view.setUint16(12, target.length * 2 + 2, true);
    for (let i = 0; i < target.length; i++)
    {
        view.setUint16(16 + i * 2, target.charCodeAt(i), true);
    }
    memory.writeMemory(input, buffer);
    assert.equal(fns.DeviceIoControl.handler(
        [folder, SET, input, buffer.length, 0, 0, 0x500, 0]), 1);
    assert.deepEqual(asked, [['C:\\GAME\\LIB', { tag: 0xa0000003, target: 'C:\\SXS\\LIB' }]],
        'the NT prefix is taken off');

    assert.equal(fns.DeviceIoControl.handler([folder, GET, 0, 0, 0x800, 4, 0x500, 0]), 0);
    assert.equal(error.code, 122, 'smaller than a GUID buffer\'s head: ERROR_INSUFFICIENT_BUFFER');
    assert.equal(fns.DeviceIoControl.handler([folder, GET, 0, 0, 0x800, 0x100, 0x500, 0]), 1);
    assert.deepEqual(memory.readMemory(0x800, buffer.length), buffer, 'handed back as it was set');
    assert.equal(memory.dword(0x500), buffer.length);
    assert.equal(fns.GetFileAttributesA.handler([NAME]) & 0x410, 0x410,
        'a junction is a directory and a reparse point');

    // A delete hands the header alone, at the size of REPARSE_GUID_DATA_BUFFER's head.
    memory.writeMemory(input, new Uint8Array([3, 0, 0, 0xa0, ...new Array(20).fill(0)]));
    assert.equal(fns.DeviceIoControl.handler([folder, UNSET, input, 8, 0, 0, 0x500, 0]), 0);
    assert.equal(error.code, 4392, 'a header too short: ERROR_INVALID_REPARSE_DATA');
    memory.writeMemory(input, new Uint8Array([0x0c, 0, 0, 0xa0]));
    assert.equal(fns.DeviceIoControl.handler([folder, UNSET, input, 24, 0, 0, 0x500, 0]), 0);
    assert.equal(error.code, 4394, 'another tag than the one set: ERROR_REPARSE_TAG_MISMATCH');
    memory.writeMemory(input, new Uint8Array([3, 0, 0, 0xa0]));
    assert.equal(fns.DeviceIoControl.handler([folder, UNSET, input, 24, 0, 0, 0x500, 0]), 1);
    assert.deepEqual(asked.at(-1), ['C:\\GAME\\LIB', null]);
    assert.equal(fns.DeviceIoControl.handler([folder, GET, 0, 0, 0x800, 0x100, 0x500, 0]), 0);
    assert.equal(error.code, 4390, 'ERROR_NOT_A_REPARSE_POINT');

    refusal = 'DIRECTORY_NOT_EMPTY';
    memory.writeMemory(input, buffer);
    assert.equal(fns.DeviceIoControl.handler(
        [folder, SET, input, buffer.length, 0, 0, 0x500, 0]), 0);
    assert.equal(error.code, 145, 'ERROR_DIR_NOT_EMPTY');
    memory.writeMemory(input, new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(fns.DeviceIoControl.handler([folder, SET, input, 8, 0, 0, 0x500, 0]), 0);
    assert.equal(error.code, 4393, 'tag 0: ERROR_REPARSE_TAG_INVALID');
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

test('CancelIo has nothing to cancel on a file, and refuses what is no file object', ()=>{
    const { fns, handles, error, open } = setup();
    const file = open('C:\\GAME\\cancel.dat', CREATE_ALWAYS);
    assert.equal(fns.CancelIo.argBytes, 4);
    assert.equal(fns.CancelIo.handler([file]), 1);
    assert.equal(fns.CancelIo.handler([2]), 1, 'a standard stream is one');
    const event = handles.open('event', { kind: 'event' });
    assert.equal(fns.CancelIo.handler([event]), 0);
    assert.equal(error.code, ERROR_INVALID_HANDLE);
    error.code = 0;
    assert.equal(fns.CancelIo.handler([0x7770]), 0);
    assert.equal(error.code, ERROR_INVALID_HANDLE);
});

test('ReplaceFile with no suffix is the wide call', ()=>{
    const { fns } = setup();
    assert.equal(fns.ReplaceFile, fns.ReplaceFileW);
});

test('the serial calls refuse a file as its file system does, anything else as no device', ()=>{
    /** @type {string[]} */
    const said = [];
    const { fns, handles, error, open } = setup({ divergence: (/** @type {string} */ api)=>
        said.push(api) });
    const file = open('C:\\GAME\\COM1.txt', CREATE_ALWAYS);
    const event = handles.open('event', { kind: 'event' });
    const ERROR_INVALID_FUNCTION = 1;
    const calls = {
        GetCommState: 8, SetCommState: 8, SetupComm: 12, PurgeComm: 8, WaitCommEvent: 12,
        ClearCommError: 12, EscapeCommFunction: 8, GetCommConfig: 12, SetCommConfig: 12,
        SetCommMask: 8, SetCommTimeouts: 8,
    };
    for (const [name, argBytes] of Object.entries(calls))
    {
        const call = /** @type {any} */ (fns)[name];
        assert.equal(call.argBytes, argBytes, `${name} pops its arguments`);
        assert.equal(call.handler([file, 0x200, 0x200]), 0, `${name} on a file`);
        assert.equal(error.code, ERROR_INVALID_FUNCTION, `${name}: the file system's no`);
        assert.equal(call.handler([event, 0x200, 0x200]), 0);
        assert.equal(error.code, ERROR_INVALID_HANDLE, `${name}: an event is no device`);
        assert.equal(call.handler([0x7770, 0x200, 0x200]), 0);
        assert.equal(error.code, ERROR_INVALID_HANDLE, `${name}: nor is nothing`);
    }
    assert.equal(said.length, Object.keys(calls).length, 'each call said once');
});

test('a port asked for by name is not found: there is none', ()=>{
    const { error, fns, at } = setup();
    for (const name of ['GetDefaultCommConfigA', 'SetDefaultCommConfigA', 'CommConfigDialogA',
        'GetDefaultCommConfigW', 'SetDefaultCommConfigW', 'CommConfigDialogW'])
    {
        const call = /** @type {any} */ (fns)[name];
        assert.equal(call.argBytes, 12, `${name} pops its arguments`);
        error.code = ERROR_SUCCESS;
        assert.equal(call.handler([at(NAME, 'COM1'), 0x200, 0x300]), 0, name);
        assert.equal(error.code, ERROR_FILE_NOT_FOUND, name);
    }
});

test('a library this build implements stands in the system folder as a file', ()=>{
    // A setup asks for a system library before loading it -- InstallShield's
    // UseDLL looks with FindFirstFile, and stopped at "UseDLL failed" when the
    // folder held nothing of the name.
    const { files, memory, error, fns, at } = setup({ systemLibraries: ()=>['SHELL32.dll'] });
    const INVALID_FILE_ATTRIBUTES = 0xffffffff;
    const FILE_ATTRIBUTE_ARCHIVE = 0x20;

    const handle = fns.FindFirstFileA.handler(
        [at(NAME, 'C:\\WINDOWS\\system32\\Shell32.dll'), FIND_DATA]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    assert.equal(memory.string(FIND_DATA + 44), 'SHELL32.dll', 'under its own name');
    assert.equal(fns.FindClose.handler([handle]), 1);
    assert.equal(fns.GetFileAttributesA.handler([at(NAME, 'c:\\windows\\SYSTEM32\\shell32.DLL')]),
        FILE_ATTRIBUTE_ARCHIVE);

    assert.equal(fns.GetFileAttributesA.handler([at(NAME, 'C:\\WINDOWS\\system32\\nothere.dll')]),
        INVALID_FILE_ATTRIBUTES, 'only the libraries there are');
    assert.equal(fns.GetFileAttributesA.handler([at(NAME, 'C:\\Game\\Shell32.dll')]),
        INVALID_FILE_ATTRIBUTES, 'and only in the system folder');
    assert.equal(fns.FindFirstFileA.handler([at(NAME, 'C:\\WINDOWS\\system32\\*.dll'), FIND_DATA]),
        INVALID_HANDLE_VALUE, 'a wildcard lists the folder as it is');
    assert.equal(error.code, ERROR_FILE_NOT_FOUND);

    files.put('C:\\WINDOWS\\system32\\shell32.dll', 'a real one');
    assert.equal(fns.CreateFileA.handler([at(NAME, 'C:\\WINDOWS\\system32\\shell32.dll'),
        GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]) === INVALID_HANDLE_VALUE, false,
    'a file on the volume is the file');
});

test('a program this build runs in the system folder stands there as a file too', ()=>{
    // The .NET Framework 4.5 and later setups refuse a machine whose Windows
    // Installer service has no msiexec.exe behind it; Notepad stands in the
    // Windows folder as well, where setups name it.
    const { files, memory, fns, at } = setup({ systemLibraries: ()=>['SHELL32.dll'],
        systemPrograms: { at: systemProgramAt, image: systemProgramImage } });
    const INVALID_FILE_ATTRIBUTES = 0xffffffff;
    const FILE_ATTRIBUTE_ARCHIVE = 0x20;
    for (const path of ['C:\\WINDOWS\\system32\\msiexec.exe', 'c:\\windows\\SYSTEM32\\MsiExec.EXE',
        'C:\\WINDOWS\\system32\\rundll32.exe', 'C:\\WINDOWS\\notepad.exe'])
    {
        assert.equal(fns.GetFileAttributesA.handler([at(NAME, path)]), FILE_ATTRIBUTE_ARCHIVE,
            path);
    }
    assert.equal(fns.GetFileAttributesA.handler([at(NAME, 'C:\\WINDOWS\\msiexec.exe')]),
        INVALID_FILE_ATTRIBUTES, 'only where Windows keeps it');
    const handle = fns.FindFirstFileA.handler(
        [at(NAME, 'C:\\WINDOWS\\system32\\msiexec.exe'), FIND_DATA]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    assert.equal(memory.string(FIND_DATA + 44).toLowerCase(), 'msiexec.exe');
    assert.equal(fns.FindClose.handler([handle]), 1);
    const read = fns.CreateFileA.handler([at(NAME, 'C:\\WINDOWS\\system32\\msiexec.exe'),
        GENERIC_READ, 1, 0, OPEN_EXISTING, 0, 0]);
    assert.notEqual(read, INVALID_HANDLE_VALUE, 'and it reads as its image');
    assert.equal(fns.ReadFile.handler([read, 0x600, 2, 0x700, 0]), 1);
    assert.equal(memory.readCString(0x600, 2), 'MZ');
    assert.equal(fns.CloseHandle.handler([read]), 1);
    files.put('C:\\WINDOWS\\system32\\msiexec.exe', 'a real one');
    assert.equal(files.stat('C:\\WINDOWS\\system32\\msiexec.exe')?.size, 10,
        'a file there wins');
});

test('a library standing in the system folder is held by its mapping past its handle', ()=>{
    // Wine's kernel32:virtual maps system32\\kernel32.dll as an image: the
    // section asks the file's size and holds it, the file handle is closed,
    // the view reads it. A stand-in is no node of the volume's to ask either.
    const image = Uint8Array.of(0x4d, 0x5a, 1, 2, 3);
    /** @type {any[]} */
    const realCalls = [];
    const real = /** @type {any} */ ({
        open: ()=>null,
        stat: ()=>null,
        read: ()=>{
            throw new Error('a stand-in read from the volume');
        },
        retain: (/** @type {any} */ node)=>realCalls.push(['retain', node]),
        close: (/** @type {any} */ node)=>realCalls.push(['close', node]),
        section: ()=>{
            throw new Error('a stand-in has no section of the volume');
        },
    });
    const volume = withSystemLibraries(real, ()=>['KERNEL32.dll'],
        { imageOf: ()=>image });
    const node = volume.open('C:\\WINDOWS\\system32\\kernel32.dll', { read: true });
    assert.deepEqual([...volume.standInImage?.(node) ?? []], [...image], 'its bytes, its size');
    assert.equal(volume.standInImage?.({}), null, 'a node of the volume is not one');
    assert.equal(volume.section?.(node, 'image'), null, 'the mapping holds the stand-in itself');
    volume.retain?.(node);
    volume.close(node);
    assert.deepEqual([...volume.read(node, 0, 2)], [0x4d, 0x5a],
        'the file handle closed, the mapping still reads it');
    volume.close(node);
    assert.equal(volume.standInImage?.(node), null, 'gone with the last hold');
    assert.deepEqual(realCalls, [], 'none of it reached the volume');
});

test('a library standing in the system folder is replaced by a setup that writes it', ()=>{
    // A game's DXSETUP opened d3dx9_26.dll there to see whether it was in
    // use, was refused, and put its copy off to a restart. Written, the name
    // becomes the setup's file; read, it is still the engine's.
    const { files, fns, at } = setup({ systemLibraries: ()=>['d3dx9_26.dll'] });
    const path = 'C:\\WINDOWS\\system32\\d3dx9_26.dll';
    assert.equal(fns.CreateFileA.handler([at(NAME, path), GENERIC_READ, 1, 0, OPEN_EXISTING,
        0, 0]), INVALID_HANDLE_VALUE, 'nothing to read');
    const handle = fns.CreateFileA.handler([at(NAME, path), GENERIC_WRITE, 3, 0, OPEN_EXISTING,
        0, 0]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE, 'open to be written');
    assert.equal(fns.CloseHandle.handler([handle]), 1);
    assert.ok(files.stat(path)?.exists, 'and a file on the volume now');
});

test('a read through an OVERLAPPED moves a synchronous handle\'s pointer, not an overlapped one\'s',
    ()=>{
        const { memory, files, fns, open } = setup({ ports: {
            offsetOf: ()=>2,
            completed: ()=>true,
        } });
        files.put('C:\\GAME\\SAVE.DAT', 'abcdefghij');
        const plain = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING, GENERIC_READ);
        assert.equal(fns.ReadFile.handler([plain, 0x600, 3, 0x700, 0x500]), 1);
        assert.equal(memory.readCString(0x600, 3), 'cde', 'at the OVERLAPPED\'s offset');
        assert.equal(fns.SetFilePointer.handler([plain, 0, 0, FILE_CURRENT]), 5, 'moved past it');

        memory.putString(0x800, 'C:\\GAME\\SAVE.DAT');
        const overlapped = fns.CreateFileA.handler([0x800, GENERIC_READ, 0, 0, OPEN_EXISTING,
            0x40000000, 0]);
        assert.equal(fns.ReadFile.handler([overlapped, 0x600, 3, 0x700, 0x500]), 1);
        assert.equal(fns.SetFilePointer.handler([overlapped, 0, 0, FILE_CURRENT]), 0,
            'FILE_FLAG_OVERLAPPED: no pointer moved');
        assert.equal(fns.ReadFile.handler([overlapped, 0x600, 3, 0x700, 0]), 1);
        assert.equal(fns.SetFilePointer.handler([overlapped, 0, 0, FILE_CURRENT]), 3,
            'a read with no OVERLAPPED still moves it');
    });

test('a folder lists itself and its parent first, and a drive\'s root does not', ()=>{
    // A program that skips the first two entries unseen -- Titan Quest
    // listing its characters -- loses the first real one without them.
    const { memory, files, fns } = setup();
    files.mkdir('C:\\GAME\\SAVE');
    files.mkdir('C:\\GAME\\SAVE\\_ONE');
    files.put('C:\\TOP.TXT', 'x');
    const name = FIND_DATA + WIN32_FIND_DATAA.cFileName;
    /** @param {string} pattern */
    const listing = pattern=>{
        memory.bytes.set([...Array.from(pattern, c=>c.charCodeAt(0)), 0], NAME);
        const search = fns.FindFirstFileA.handler([NAME, FIND_DATA]);
        if (search === INVALID_HANDLE_VALUE)
        {
            return [];
        }
        const names = [];
        for (let more = true; more; more = fns.FindNextFileA.handler([search, FIND_DATA]) !== 0)
        {
            names.push(String.fromCharCode(...memory.bytes.subarray(name,
                memory.bytes.indexOf(0, name))));
        }
        fns.FindClose.handler([search]);
        return names;
    };
    assert.deepEqual(listing('C:\\GAME\\SAVE\\*'), ['.', '..', '_ONE']);
    assert.deepEqual(listing('C:\\GAME\\SAVE\\?*'), ['.', '..', '_ONE']);
    assert.deepEqual(listing('C:\\GAME\\SAVE\\_*'), ['_ONE'], 'a pattern with a name in it');
    assert.ok(!listing('C:\\*').includes('.'), 'the root has neither');
});

test('an open CreateFile refuses is told, with its path, its error and what was asked', ()=>{
    // A program that goes silent where a file of its own would not open says
    // nothing else: the report names the file.
    /** @type {any[]} */
    const refused = [];
    const { files, fns, at } = setup({ openRefused: (/** @type {any} */ record)=>refused.push(record) });
    files.put('C:\\GAME\\THERE.DAT', 'here');
    fns.CreateFileA.handler(
        [at(NAME, 'C:\\GAME\\THERE.DAT'), GENERIC_READ, 1, 0, OPEN_EXISTING, 0, 0]);
    assert.equal(fns.CreateFileA.handler(
        [at(NAME, 'C:\\GAME\\GONE.DAT'), GENERIC_READ, 1, 0, OPEN_EXISTING, 0x80, 0]),
    INVALID_HANDLE_VALUE);
    assert.deepEqual(refused, [{ path: 'C:\\GAME\\GONE.DAT', error: ERROR_FILE_NOT_FOUND,
        access: GENERIC_READ, share: 1, disposition: OPEN_EXISTING, flags: 0x80 }],
    'only the open that failed');
});

test('CreateFile hands on its sharing terms; their refusal is a sharing violation', ()=>{
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'x');
    const anyFiles = /** @type {any} */ (files);
    const opened = anyFiles.open.bind(files);
    /** @type {any[]} */
    const asked = [];
    anyFiles.open = (/** @type {string} */ path, /** @type {any} */ mode)=>{
        asked.push(mode);
        return opened(path, mode);
    };
    const GENERIC_EXECUTE = 0x20000000;
    const FILE_SHARE_DELETE = 0x4;
    const handle = fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\SAVE.DAT'),
        GENERIC_EXECUTE | 0x10000, FILE_SHARE_DELETE, 0, OPEN_EXISTING, 0, 0]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    const terms = [asked[0].read, asked[0].shareRead, asked[0].shareWrite, asked[0].delete,
        asked[0].shareDelete];
    assert.deepEqual(terms, [true, false, false, true, true],
        'executing reads, as sharing counts it; only deletion shared');

    anyFiles.open = ()=>null;
    anyFiles.openRefusal = ()=>'SHARING_VIOLATION';
    assert.equal(fns.CreateFileA.handler([NAME, GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]),
        INVALID_HANDLE_VALUE);
    assert.equal(error.code, 32, 'ERROR_SHARING_VIOLATION');
    anyFiles.openRefusal = ()=>null;
    fns.CreateFileA.handler([NAME, GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]);
    assert.equal(error.code, ERROR_ACCESS_DENIED, 'any other refusal of a file that is there');
});

test('MoveFile to a name with a wildcard is refused as an invalid name', ()=>{
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'x');
    assert.equal(fns.MoveFileA.handler([at(NAME, 'C:\\GAME\\SAVE.DAT'),
        at(NAME2, 'C:\\GAME\\wild?.*')]), 0);
    assert.equal(error.code, 123, 'ERROR_INVALID_NAME');
    assert.equal(files.stat('C:\\GAME\\SAVE.DAT')?.exists, true);
});

test('CopyFile reads sharing everything and writes sharing all but deletion, refusals named', ()=>{
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\A.DAT', 'abc');
    files.put('C:\\GAME\\B.DAT', 'old!');
    const anyFiles = /** @type {any} */ (files);
    const opened = anyFiles.open.bind(files);
    /** @type {any[]} */
    const asked = [];
    anyFiles.open = (/** @type {string} */ path, /** @type {any} */ mode)=>{
        asked.push({ path, ...mode });
        return opened(path, mode);
    };
    assert.equal(fns.CopyFileA.handler([at(NAME, 'C:\\GAME\\A.DAT'),
        at(NAME2, 'C:\\GAME\\B.DAT'), 0]), 1);
    const [input, output] = asked;
    assert.deepEqual([input.read, input.shareRead, input.shareWrite, input.shareDelete],
        [true, true, true, true]);
    assert.deepEqual([output.write, output.shareRead, output.shareWrite,
        output.shareDelete ?? false, output.truncate ?? false], [true, true, true, false, false],
    'settled before it is emptied');
    assert.equal(files.stat('C:\\GAME\\B.DAT')?.size, 3);

    anyFiles.mappedAs = ()=>'readonly';
    assert.equal(fns.CopyFileA.handler([NAME, NAME2, 0]), 0);
    assert.equal(error.code, 1224, 'ERROR_USER_MAPPED_FILE');
    anyFiles.mappedAs = ()=>null;
    anyFiles.open = ()=>null;
    anyFiles.openRefusal = ()=>'SHARING_VIOLATION';
    assert.equal(fns.CopyFileA.handler([NAME, NAME2, 0]), 0);
    assert.equal(error.code, 32, 'ERROR_SHARING_VIOLATION');
});

test('NUL opens anywhere, reads as its end, swallows writes, and is found as itself', ()=>{
    const { memory, error, fns, at, files } = setup();
    const handle = fns.CreateFileA.handler([at(NAME, '\\\\.\\NUL'), GENERIC_READ | GENERIC_WRITE,
        0, 0, OPEN_EXISTING, 0, 0]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    memory.putDword(OUT_COUNT, 0xdeadbeef);
    assert.equal(fns.ReadFile.handler([handle, BUFFER, 16, OUT_COUNT, 0]), 1);
    assert.equal(memory.dword(OUT_COUNT), 0);
    assert.equal(fns.WriteFile.handler([handle, BUFFER, 12, OUT_COUNT, 0]), 1);
    assert.equal(memory.dword(OUT_COUNT), 12);
    assert.equal(error.code, ERROR_SUCCESS);

    // By its name in a folder, as a volume resolves one.
    const anyFiles = /** @type {any} */ (files);
    anyFiles.deviceOf = (/** @type {string} */ path)=>(/\\nul$/i.test(path) ? 'NUL' : null);
    assert.notEqual(fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\nul'), GENERIC_WRITE, 0, 0,
        OPEN_EXISTING, 0, 0]), INVALID_HANDLE_VALUE);
    const found = fns.FindFirstFileA.handler([NAME, FIND_DATA]);
    assert.notEqual(found, INVALID_HANDLE_VALUE);
    assert.equal(memory.dword(FIND_DATA + WIN32_FIND_DATAA.dwFileAttributes), 0x20);
    const named = FIND_DATA + WIN32_FIND_DATAA.cFileName;
    assert.equal(String.fromCharCode(...memory.bytes.subarray(named, named + 3)), 'nul');
    assert.equal(fns.FindNextFileA.handler([found, FIND_DATA]), 0);
    assert.equal(error.code, ERROR_NO_MORE_FILES);
});

test('a lock of no bytes is taken over held ones, and blocks a range that covers it', ()=>{
    const { files, error, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'x'.repeat(300));
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    assert.equal(fns.LockFile.handler([handle, 100, 0, 100, 0]), 1);
    assert.equal(fns.LockFile.handler([handle, 150, 0, 10, 0]), 0, 'exclusive over its own');
    assert.equal(fns.LockFile.handler([handle, 120, 0, 0, 0]), 1, 'no bytes: taken all the same');
    assert.equal(fns.UnlockFile.handler([handle, 100, 0, 100, 0]), 1);
    assert.equal(fns.LockFile.handler([handle, 118, 0, 4, 0]), 0, 'it covers the point');
    assert.equal(error.code, 33, 'ERROR_LOCK_VIOLATION');
    assert.equal(fns.LockFile.handler([handle, 110, 0, 10, 0]), 1, 'up to it, not over it');
    assert.equal(fns.UnlockFile.handler([handle, 120, 0, 0, 0]), 1);
});

test('names and dispositions Windows refuses before it looks for the file', ()=>{
    const { files, error, fns, at } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'x');
    const FILE_WRITE_DATA = 0x2;
    const TRUNCATE = 5;
    assert.equal(fns.CreateFileA.handler([at(NAME, 'C:\\GAME\\SAVE.DAT'), FILE_WRITE_DATA, 0, 0,
        TRUNCATE, 0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_INVALID_PARAMETER, 'emptying asks GENERIC_WRITE itself');
    assert.equal(fns.CreateFileA.handler([at(NAME, '\\\\.\\Bogus'), GENERIC_READ, 0, 0,
        OPEN_EXISTING, 0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, ERROR_FILE_NOT_FOUND, 'no such device');
    assert.equal(fns.CreateFileA.handler([at(NAME, 'C:c:\\windows'), GENERIC_READ, 0, 0,
        OPEN_EXISTING, 0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(error.code, 123, 'ERROR_INVALID_NAME: a colon past the drive');

    /** @type {any} */ (files).mappedAs = ()=>'image';
    assert.equal(fns.DeleteFileA.handler([at(NAME, 'C:\\GAME\\SAVE.DAT')]), 0);
    assert.equal(error.code, ERROR_ACCESS_DENIED, 'an image section keeps its file');
    assert.equal(files.stat('C:\\GAME\\SAVE.DAT')?.exists, true);
});

test('CancelIoEx finds nothing left to cancel on a file', ()=>{
    const { fns, error, open } = setup();
    const file = open('C:\\GAME\\cancel.dat', CREATE_ALWAYS);
    assert.equal(fns.CancelIoEx.handler([file, 0]), 0);
    assert.equal(error.code, 1168, 'ERROR_NOT_FOUND');
    assert.equal(fns.CancelIoEx.handler([0x7770, 0]), 0);
    assert.equal(error.code, ERROR_INVALID_HANDLE);
});

test('OpenFile fills its OFSTRUCT on an open, and on a refusal says only the error', ()=>{
    // Wine's file.c test_OpenFile: cBytes is left as the caller had it, and
    // a name past the structure's 128 characters is refused untouched.
    const { memory, files, error, fns, at } = setup();
    files.put('C:\\GAME\\HERE.TXT', 'x');
    const OFS = 0x600;
    memory.bytes.fill(0xa5, OFS, OFS + 136);
    assert.equal(fns.OpenFile.handler([at(NAME, 'C:\\GAME\\HERE.TXT'), OFS, 0x4000]), 1,
        'OF_EXIST');
    assert.equal(memory.bytes[OFS], 136, 'cBytes');
    assert.equal(memory.bytes[OFS + 2] | memory.bytes[OFS + 3] << 8, 0, 'nErrCode');
    assert.equal(memory.readCString(OFS + 8, 128), 'C:\\GAME\\HERE.TXT');

    memory.bytes.fill(0xa5, OFS, OFS + 136);
    assert.equal(fns.OpenFile.handler([at(NAME, 'C:\\GAME\\GONE.TXT'), OFS, 0x4000]) >>> 0,
        0xffffffff);
    assert.equal(error.code, 2, 'ERROR_FILE_NOT_FOUND');
    assert.equal(memory.bytes[OFS], 0xa5, 'cBytes as it was');
    assert.equal(memory.bytes[OFS + 2] | memory.bytes[OFS + 3] << 8, 2, 'nErrCode the error');

    memory.bytes.fill(0xa5, OFS, OFS + 136);
    assert.equal(fns.OpenFile.handler([at(NAME, `C:\\GAME\\${'+'.repeat(130)}`), OFS, 0x4000])
        >>> 0, 0xffffffff);
    assert.equal(error.code, 206, 'ERROR_FILENAME_EXCED_RANGE');
    assert.equal(memory.bytes[OFS + 2], 206);
    assert.equal(memory.bytes[OFS + 8], 0xa5, 'the path left as it was');
});

test('ReOpenFile opens the same file again as a handle of its own', ()=>{
    const { fns, open, error } = setup();
    const file = open('C:\\GAME\\SAVE.DAT', CREATE_ALWAYS);
    // GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_FLAG_OVERLAPPED.
    const again = fns.ReOpenFile.handler([file, 0x80000000, 3, 0x40000000]);
    assert.notEqual(again >>> 0, 0xffffffff);
    assert.notEqual(again, file, 'a handle of its own');
    assert.equal(fns.GetFinalPathNameByHandleW.handler([again, 0x400, 64, 0]),
        '\\\\?\\C:\\GAME\\SAVE.DAT'.length, 'to the same file');
    assert.equal(fns.ReOpenFile.handler([0x7770, 0x80000000, 3, 0]) >>> 0, 0xffffffff);
    assert.equal(error.code, ERROR_INVALID_HANDLE);
    // FILE_ATTRIBUTE_NORMAL: an attribute, which only the file's making sets.
    assert.equal(fns.ReOpenFile.handler([file, 0x80000000, 3, 0x80]) >>> 0, 0xffffffff);
    assert.equal(error.code, 87, 'ERROR_INVALID_PARAMETER');
});

test('a file a section maps grows and is not cut shorter', ()=>{
    const { files, fns, open, error } = setup();
    const file = open('C:\\GAME\\MAPPED.DAT', CREATE_ALWAYS);
    /** @type {any} */ (files).mappedAs = ()=>'data';
    assert.equal(fns.SetFilePointer.handler([file, 8, 0, 0]), 8);
    assert.equal(fns.SetEndOfFile.handler([file]), 1, 'longer');
    assert.equal(fns.SetFilePointer.handler([file, 6, 0, 0]), 6);
    assert.equal(fns.SetEndOfFile.handler([file]), 0, 'shorter');
    assert.equal(error.code, 1224, 'ERROR_USER_MAPPED_FILE');
    assert.equal(fns.GetFileSize.handler([file, 0]), 8);
});

test('GetFinalPathNameByHandle names the file in the namespace asked for', ()=>{
    const { memory, fns, open, error } = setup();
    const file = open('C:\\GAME\\SAVE.DAT', CREATE_ALWAYS);
    const dos = '\\\\?\\C:\\GAME\\SAVE.DAT';
    assert.equal(fns.GetFinalPathNameByHandleW.handler([file, 0x400, 64, 0]), dos.length);
    assert.equal(wideAt(memory, 0x400), dos);
    assert.equal(fns.GetFinalPathNameByHandleA.handler([file, 0x400, 64, 2]),
        '\\Device\\HarddiskVolume1\\GAME\\SAVE.DAT'.length);
    assert.equal(memory.string(0x400), '\\Device\\HarddiskVolume1\\GAME\\SAVE.DAT');
    assert.equal(fns.GetFinalPathNameByHandleA.handler([file, 0x400, 64, 4]), 14);
    assert.equal(memory.string(0x400), '\\GAME\\SAVE.DAT');
    assert.equal(fns.GetFinalPathNameByHandleW.handler([file, 0x400, 5, 0]), dos.length + 1,
        'too little room: the room it needs, terminator counted');
    assert.equal(fns.GetFinalPathNameByHandleW.handler([file, 0x400, 64, 1]), 0);
    assert.equal(error.code, ERROR_INVALID_PARAMETER, 'no volume GUID path');
    assert.equal(fns.GetFinalPathNameByHandleW.handler([0x7770, 0x400, 64, 0]), 0);
    assert.equal(error.code, ERROR_INVALID_HANDLE);
});

test('SetFileInformationByHandle renames, deletes on close and moves the end', ()=>{
    const { memory, files, fns, open, error } = setup();
    files.put('C:\\GAME\\a.tmp', 'abcdef');
    const file = open('C:\\GAME\\a.tmp', OPEN_EXISTING, GENERIC_READ | GENERIC_WRITE | DELETE);
    const view = new DataView(memory.bytes.buffer);
    view.setBigInt64(0x800, 3n, true);
    assert.equal(fns.SetFileInformationByHandle.handler([file, 6, 0x800, 8]), 1);
    assert.equal(files.text('C:\\GAME\\a.tmp'), 'abc', 'FileEndOfFileInfo');
    view.setBigInt64(0x800, 10n, true);
    assert.equal(fns.SetFileInformationByHandle.handler([file, 5, 0x800, 8]), 1);
    assert.equal(files.text('C:\\GAME\\a.tmp'), 'abc', 'an allocation past the end adds nothing');

    // FILE_RENAME_INFO: replace if there, no root, the name in bytes, a bare name.
    files.put('C:\\GAME\\b.dat', 'old');
    memory.bytes.fill(0, 0x800, 0x840);
    view.setUint32(0x800, 0, true);
    view.setUint32(0x808, 10, true);
    putWide(memory, 0x80c, 'b.dat');
    assert.equal(fns.SetFileInformationByHandle.handler([file, 3, 0x800, 24]), 0);
    assert.equal(error.code, ERROR_ALREADY_EXISTS);
    view.setUint32(0x800, 1, true);
    assert.equal(fns.SetFileInformationByHandle.handler([file, 3, 0x800, 24]), 1);
    assert.equal(files.text('C:\\GAME\\b.dat'), 'abc');
    assert.ok(!files.nodes.has('C:\\GAME\\a.tmp'));

    // FileDispositionInfo: asked of a handle that may delete; pending, the
    // file opens no more and is gone with the last handle onto it.
    const reader = open('C:\\GAME\\b.dat', OPEN_EXISTING, GENERIC_READ);
    memory.bytes[0x800] = 1;
    assert.equal(fns.SetFileInformationByHandle.handler([reader, 4, 0x800, 1]), 0);
    assert.equal(error.code, 5, 'no DELETE: ERROR_ACCESS_DENIED');
    assert.equal(fns.SetFileInformationByHandle.handler([file, 4, 0x800, 1]), 1);
    memory.putString(NAME, 'C:\\GAME\\b.dat');
    assert.equal(fns.CreateFileA.handler([NAME, GENERIC_READ, 7, 0, OPEN_EXISTING, 0, 0]),
        INVALID_HANDLE_VALUE, 'pending: no more opens');
    assert.equal(error.code, 5);
    assert.equal(fns.CloseHandle.handler([file]), 1);
    assert.ok(files.nodes.has('C:\\GAME\\b.dat'), 'not while another handle is open');
    assert.equal(fns.CloseHandle.handler([reader]), 1);
    assert.ok(!files.nodes.has('C:\\GAME\\b.dat'));

    const other = open('C:\\GAME\\c.dat', CREATE_ALWAYS);
    assert.equal(fns.SetFileInformationByHandle.handler([other, 6, 0x800, 4]), 0);
    assert.equal(error.code, 24, 'ERROR_BAD_LENGTH');
    assert.equal(fns.SetFileInformationByHandle.handler([other, 30, 0x800, 64]), 0);
    assert.equal(error.code, ERROR_INVALID_PARAMETER);
    // FileBasicInfo: attributes set, zero times left alone.
    memory.bytes.fill(0, 0x800, 0x840);
    view.setUint32(0x820, 0x2, true);
    assert.equal(fns.SetFileInformationByHandle.handler([other, 0, 0x800, 40]), 1);
    assert.equal(files.stat('C:\\GAME\\c.dat')?.attributes, 0x2);
});

test('a rename through a handle needs DELETE and holds the file against its other opens',
    ()=>{
        const { memory, files, fns, open, error } = setup();
        const view = new DataView(memory.bytes.buffer);
        /** @param {string} name @param {number} flags */
        const renameInfo = (name, flags)=>{
            memory.bytes.fill(0, 0x800, 0x880);
            view.setUint32(0x800, flags, true);
            view.setUint32(0x808, name.length * 2, true);
            putWide(memory, 0x80c, name);
            return 12 + name.length * 2;
        };
        files.put('C:\\GAME\\a.tmp', 'abc');
        // An open that shares nothing, its own deletion asked: the file
        // system would refuse anyone else, never the handle that holds it.
        Object.assign(files, { removalRefused: ()=>'SHARING_VIOLATION' });
        const holder = open('C:\\GAME\\a.tmp', OPEN_EXISTING, GENERIC_WRITE | DELETE);
        assert.equal(fns.SetFileInformationByHandle.handler([holder, 3, 0x800,
            renameInfo('b.tmp', 0)]), 1);
        assert.equal(files.text('C:\\GAME\\b.tmp'), 'abc');

        const writer = open('C:\\GAME\\b.tmp', OPEN_EXISTING, GENERIC_WRITE);
        assert.equal(fns.SetFileInformationByHandle.handler([writer, 3, 0x800,
            renameInfo('c.tmp', 0)]), 0);
        assert.equal(error.code, 5, 'no DELETE: ERROR_ACCESS_DENIED');
        Object.assign(files, { removalRefused: ()=>null });

        // FileRenameInformationEx: a read-only file at the name is replaced
        // only when the call ignores the attribute.
        files.put('C:\\GAME\\ro.tmp', 'old');
        files.setAttributes('C:\\GAME\\ro.tmp', 0x1);
        const native = /** @type {any} */ (fns.CreateFileW).natives.NtSetInformationFile;
        const RENAME_EX = 65;
        const REPLACE = 0x1;
        const IGNORE_READONLY = 0x40;
        const length = renameInfo('ro.tmp', REPLACE);
        assert.equal(native.handler([holder, 0x300, 0x800, length, RENAME_EX]) >>> 0,
            0xc0000022, 'STATUS_ACCESS_DENIED');
        renameInfo('ro.tmp', REPLACE | IGNORE_READONLY);
        assert.equal(native.handler([holder, 0x300, 0x800, length, RENAME_EX]), 0);
        assert.equal(files.text('C:\\GAME\\ro.tmp'), 'abc');

        // A name relative to a folder CreateFile opened (a file object of a folder).
        const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        const folder = fns.CreateFileA.handler([memory.putString(NAME, 'C:\\GAME') ?? NAME, 0, 0,
            0, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, 0]) >>> 0;
        const RENAME = 10;
        const relative = renameInfo('d.tmp', 0);
        view.setUint32(0x804, folder, true);
        assert.equal(native.handler([holder, 0x300, 0x800, relative, RENAME]), 0);
        assert.equal(files.text('C:\\GAME\\d.tmp'), 'abc');
    });

test('GetBinaryType tells programs apart by their headers, and refuses a library', async()=>{
    const { memory, files, fns, error } = setup();
    /** @param {number} characteristics @param {number} magic */
    const image = (characteristics, magic)=>{
        const bytes = new Uint8Array(0x100);
        const view = new DataView(bytes.buffer);
        bytes.set([0x4d, 0x5a]);
        view.setUint32(0x3c, 0x80, true);
        view.setUint32(0x80, 0x4550, true);
        view.setUint16(0x80 + 22, characteristics, true);
        view.setUint16(0x80 + 24, magic, true);
        return String.fromCharCode(...bytes);
    };
    files.put('C:\\GAME\\app.exe', image(0x102, 0x10b));
    files.put('C:\\GAME\\app64.exe', image(0x22, 0x20b));
    files.put('C:\\GAME\\lib.dll', image(0x2102, 0x10b));
    files.put('C:\\GAME\\dos.exe', 'MZ' + '\0'.repeat(0x3e));
    files.put('C:\\GAME\\tool.com', '\xb4\x4c\xcd\x21');
    files.put('C:\\GAME\\readme.txt', 'hello');
    for (const [name, kind] of /** @type {[string, number][]} */ ([['app.exe', 0],
        ['app64.exe', 6], ['dos.exe', 1], ['tool.com', 1]]))
    {
        memory.putString(NAME, `C:\\GAME\\${name}`);
        assert.equal(await fns.GetBinaryTypeA.handler([NAME, OUT_COUNT]), 1, name);
        assert.equal(memory.dword(OUT_COUNT), kind, name);
    }
    memory.putString(NAME, 'C:\\GAME\\lib.dll');
    assert.equal(await fns.GetBinaryTypeA.handler([NAME, OUT_COUNT]), 0);
    assert.equal(error.code, 193, 'ERROR_BAD_EXE_FORMAT');
    putWide(memory, NAME, 'C:\\GAME\\readme.txt');
    assert.equal(await fns.GetBinaryTypeW.handler([NAME, OUT_COUNT]), 0);
    putWide(memory, NAME, 'C:\\GAME\\none.exe');
    assert.equal(await fns.GetBinaryTypeW.handler([NAME, OUT_COUNT]), 0);
    assert.equal(error.code, 2);
});

test('NtReadFile refuses a negative offset and a missing buffer before it moves anything', ()=>{
    const { memory, files, fns, open } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcdef');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    const natives = /** @type {any} */ (fns.CreateFileW).natives;
    const block = 0x500;
    const offset = 0x510;
    memory.putDword(block, 0xdeadbeef);
    memory.putDword(offset, -20 >>> 0);
    memory.putDword(offset + 4, 0xffffffff);
    assert.equal(natives.NtReadFile.handler([handle, 0, 0, 0, block, BUFFER, 4, offset, 0]),
        0xc000000d, 'STATUS_INVALID_PARAMETER');
    assert.equal(natives.NtWriteFile.handler([handle, 0, 0, 0, block, BUFFER, 4, offset, 0]),
        0xc000000d, 'not the end of the file, not the pointer');
    assert.equal(natives.NtReadFile.handler([handle, 0, 0, 0, block, 0, 4, 0, 0]),
        0xc0000005, 'STATUS_ACCESS_VIOLATION');
    assert.equal(natives.NtWriteFile.handler([handle, 0, 0, 0, block, 0, 4, 0, 0]),
        0xc00000e8, 'a write from nowhere: STATUS_INVALID_USER_BUFFER');
    assert.equal(memory.dword(block), 0xdeadbeef, 'the status block untouched by each');
});

test('NtSetInformationFile sets what SetFileInformationByHandle does, and its own classes', ()=>{
    const { memory, files, fns } = setup();
    const natives = /** @type {any} */ (fns.CreateFileW).natives;
    files.put('C:\\GAME\\SAVE.DAT', 'abcdef');
    assert.equal(natives.NtCreateFile.handler([NT_HANDLE, GENERIC_READ | GENERIC_WRITE | 0x10000,
        objectAttributes(memory, '\\??\\C:\\GAME\\SAVE.DAT'), NT_STATUS, 0, 0, 7, FILE_OPEN,
        FILE_NON_DIRECTORY_FILE, 0, 0]), 0);
    const handle = memory.dword(NT_HANDLE);
    const set = (/** @type {number} */ kind, /** @type {number[]} */ dwords)=>{
        dwords.forEach((value, at)=>memory.putDword(BUFFER + at * 4, value));
        return natives.NtSetInformationFile.handler([handle, NT_STATUS, BUFFER,
            dwords.length * 4, kind]);
    };

    assert.equal(set(20, [2, 0]), 0, 'FileEndOfFileInformation');
    assert.equal(files.stat('C:\\GAME\\SAVE.DAT')?.size, 2);
    assert.equal(set(14, [1, 0]), 0, 'FilePositionInformation');
    assert.equal(fns.ReadFile.handler([handle, BUFFER, 4, OUT_COUNT, 0]), 1);
    assert.equal(memory.dword(OUT_COUNT), 1, 'read on from the position set');
    assert.equal(set(14, [0, 0x80000000]), 0xc000000d, 'a negative position');
    assert.equal(set(20, [0]), 0xc0000004, 'STATUS_INFO_LENGTH_MISMATCH');
    assert.equal(set(9, [0, 0]), 0xc0000003, 'a class nothing keeps');
    memory.putDword(NT_STATUS, 0xdeadbeef);
    assert.equal(set(14, [0, 0x80000000]), 0xc000000d);
    assert.equal(memory.dword(NT_STATUS), 0xdeadbeef, 'a refused set leaves the status block');

    // FileRenameInformation: a bare name and no root stays in the folder.
    const name = 'NEW.DAT';
    memory.putDword(BUFFER, 0);
    memory.putDword(BUFFER + 4, 0);
    memory.putDword(BUFFER + 8, name.length * 2);
    [...name].forEach((unit, at)=>memory.bytes.set([unit.charCodeAt(0), 0], BUFFER + 12 + at * 2));
    assert.equal(natives.NtSetInformationFile.handler([handle, NT_STATUS, BUFFER,
        12 + name.length * 2, 10]), 0);
    assert.equal(files.stat('C:\\GAME\\NEW.DAT')?.exists, true);
    assert.notEqual(files.stat('C:\\GAME\\SAVE.DAT')?.exists, true);

    assert.equal(natives.NtFlushBuffersFile.handler([handle, NT_STATUS]), 0);
    assert.equal(natives.NtSetInformationFile.handler([0x4321, NT_STATUS, BUFFER, 8, 20]),
        0xc0000008, 'STATUS_INVALID_HANDLE');
});

test('a file named rather than opened: its attributes, its deletion', ()=>{
    const { memory, files, fns } = setup();
    const natives = /** @type {any} */ (fns.CreateFileW).natives;
    files.put('C:\\GAME\\SAVE.DAT', 'abcdef');
    files.mkdir('C:\\GAME\\FULL');
    files.put('C:\\GAME\\FULL\\X.DAT', 'x');

    assert.equal(natives.NtQueryFullAttributesFile.handler([objectAttributes(memory,
        '\\??\\C:\\GAME\\SAVE.DAT'), BUFFER]), 0);
    assert.equal(memory.dword(BUFFER + 40), 6, 'FILE_NETWORK_OPEN_INFORMATION.EndOfFile');
    assert.equal(natives.NtQueryAttributesFile.handler([objectAttributes(memory,
        '\\??\\C:\\GAME\\NONE.DAT'), BUFFER]), 0xc0000034, 'STATUS_OBJECT_NAME_NOT_FOUND');

    assert.equal(natives.NtDeleteFile.handler([objectAttributes(memory,
        '\\??\\C:\\GAME\\FULL')]), 0xc0000101, 'STATUS_DIRECTORY_NOT_EMPTY');
    assert.equal(natives.NtDeleteFile.handler([objectAttributes(memory,
        '\\??\\C:\\GAME\\SAVE.DAT')]), 0);
    assert.notEqual(files.stat('C:\\GAME\\SAVE.DAT')?.exists, true);
});

test('NtQueryDirectoryFile lists a folder a call at a time, from where it left off', ()=>{
    const { memory, files, fns } = setup();
    const natives = /** @type {any} */ (fns.CreateFileW).natives;
    files.mkdir('C:\\GAME\\DIR');
    files.put('C:\\GAME\\DIR\\A.TXT', 'a');
    files.put('C:\\GAME\\DIR\\B.TXT', 'bb');
    assert.equal(natives.NtCreateFile.handler([NT_HANDLE, GENERIC_READ,
        objectAttributes(memory, '\\??\\C:\\GAME\\DIR'), NT_STATUS, 0, 0, 7, FILE_OPEN,
        FILE_DIRECTORY_FILE, 0, 0]), 0);
    const handle = memory.dword(NT_HANDLE);
    const names = [];
    for (;;)
    {
        // FileNamesInformation, one entry a call.
        const status = natives.NtQueryDirectoryFile.handler([handle, 0, 0, 0, NT_STATUS, BUFFER,
            0x100, 12, 1, 0, 0]);
        if (status !== 0)
        {
            assert.equal(status, 0x80000006, 'STATUS_NO_MORE_FILES at the end');
            break;
        }
        const length = memory.dword(BUFFER + 8);
        names.push(String.fromCharCode(...[...memory.bytes.subarray(BUFFER + 12,
            BUFFER + 12 + length)].filter((_, at)=>at % 2 === 0)));
    }
    assert.deepEqual(names.filter(name=>!name.startsWith('.')), ['A.TXT', 'B.TXT']);
    // A restart lists again; FileDirectoryInformation, every entry that fits,
    // each record linked to the next at an eight-aligned offset.
    assert.equal(natives.NtQueryDirectoryFile.handler([handle, 0, 0, 0, NT_STATUS, BUFFER,
        0x100, 1, 0, 0, 1]), 0);
    const next = memory.dword(BUFFER);
    assert.ok(next > 0 && next % 8 === 0, `the next record at ${next}`);
});

test('NtQueryDirectoryFile matches its mask as a native expression, "." and ".." first', ()=>{
    const { memory, files, fns } = setup();
    const natives = /** @type {any} */ (fns.CreateFileW).natives;
    files.mkdir('C:\\GAME\\DIR');
    files.put('C:\\GAME\\DIR\\A.TXT', 'a');
    files.put('C:\\GAME\\DIR\\README', 'r');
    assert.equal(natives.NtCreateFile.handler([NT_HANDLE, GENERIC_READ,
        objectAttributes(memory, '\\??\\C:\\GAME\\DIR'), NT_STATUS, 0, 0, 7, FILE_OPEN,
        FILE_DIRECTORY_FILE, 0, 0]), 0);
    const handle = memory.dword(NT_HANDLE);
    /** A UNICODE_STRING mask at 0xe00, its characters at 0xe10. @param {string} text */
    const mask = text=>{
        memory.bytes.set([text.length * 2 & 0xff, text.length * 2 >> 8, 0, 0, 0x10, 0x0e, 0, 0],
            0xe00);
        [...text].forEach((c, i)=>memory.bytes.set([c.charCodeAt(0), 0], 0xe10 + i * 2));
        return 0xe00;
    };
    /** Every name the mask lists, one a call. @param {string} text */
    const names = text=>{
        const found = [];
        let restart = 1;
        let first = mask(text);
        for (;;)
        {
            const status = natives.NtQueryDirectoryFile.handler([handle, 0, 0, 0, NT_STATUS,
                BUFFER, 0x100, 12, 1, first, restart]);
            restart = 0;
            first = 0;
            if (status !== 0)
            {
                return { found, status: status >>> 0, block: memory.dword(NT_STATUS) };
            }
            const length = memory.dword(BUFFER + 8);
            found.push(String.fromCharCode(...[...memory.bytes.subarray(BUFFER + 12,
                BUFFER + 12 + length)].filter((_, at)=>at % 2 === 0)));
        }
    };
    const all = names('*');
    assert.deepEqual(all.found, ['.', '..', 'A.TXT', 'README']);
    assert.equal(all.status, 0x80000006);
    assert.equal(all.block, 0x80000006, 'a warning writes the status block');
    assert.deepEqual(names('*.*').found, ['.', '..', 'A.TXT'], '*.* asks for a dot');
    assert.deepEqual(names('<').found, ['.', '..', 'README'], 'DOS_STAR stops at the dot');
    memory.bytes.set([0xef, 0xbe, 0xad, 0xde], NT_STATUS);
    const none = names('nothing');
    assert.equal(none.status, 0xc000000f, 'STATUS_NO_SUCH_FILE');
    assert.equal(none.block, 0xdeadbeef, 'an error leaves the status block alone');
});

test('a file handle reads and writes by the rights it holds: a second handle onto the open'
    + ' with fewer is refused', ()=>{
    const { memory, files, handles, fns, open, error } = setup();
    files.put('C:\\GAME\\SAVE.DAT', 'abcdef');
    const handle = open('C:\\GAME\\SAVE.DAT', OPEN_EXISTING);
    const file = handles.resolve(handle, 'file');
    // What DuplicateHandle makes of it asking FILE_READ_DATA alone: the same
    // open, a handle of its own with that right.
    const reader = handles.open('file', file, 0x00100081);
    memory.putString(BUFFER, 'XY');
    assert.equal(fns.WriteFile.handler([reader, BUFFER, 2, OUT_COUNT, 0]), 0);
    assert.equal(error.code, ERROR_ACCESS_DENIED);
    assert.equal(fns.ReadFile.handler([reader, BUFFER, 2, OUT_COUNT, 0]), 1);
    const appender = handles.open('file', file, 0x00100004);
    assert.equal(fns.WriteFile.handler([appender, BUFFER, 2, OUT_COUNT, 0]), 1,
        'FILE_APPEND_DATA writes');
    assert.equal(fns.ReadFile.handler([appender, BUFFER, 2, OUT_COUNT, 0]), 0);
    assert.equal(handles.access(handle), 0x0012019f,
        'CreateFile grants what it was asked, generic rights mapped, with SYNCHRONIZE and'
        + ' FILE_READ_ATTRIBUTES');
});

test('a device that holds no files opens as itself, in the mode it was opened in', ()=>{
    const { memory, fns } = setup();
    const native = /** @type {any} */ (fns.CreateFileW).natives;
    const SYNCHRONIZE = 0x100000;
    const FILE_SYNCHRONOUS_IO_ALERT = 0x10;
    for (const name of ['\\??\\MAILSLOT\\', '\\??\\MountPointManager',
        '\\Device\\MountPointManager'])
    {
        for (const mode of [0, FILE_SYNCHRONOUS_IO_ALERT])
        {
            assert.equal(native.NtCreateFile.handler([NT_HANDLE, SYNCHRONIZE,
                objectAttributes(memory, name), NT_STATUS, 0, 0, 0, FILE_OPEN, mode, 0, 0]), 0,
            name);
            const device = memory.dword(NT_HANDLE);
            memory.putDword(0x400, 0xcccccccc);
            assert.equal(native.NtQueryInformationFile.handler([device, 0x300, 0x400, 4, 16]), 0,
                'FileModeInformation');
            assert.equal(memory.dword(0x400), mode, `${name} opened in mode ${mode}`);
            assert.equal(fns.CloseHandle.handler([device]), 1);
        }
    }
    assert.equal(native.NtCreateFile.handler([NT_HANDLE, SYNCHRONIZE,
        objectAttributes(memory, '\\??\\MountPointManager'), NT_STATUS, 0, 0, 0, FILE_CREATE, 0,
        0, 0]) >>> 0, 0xc000000d, 'a device is opened, never made');
});

test('NtCreateFile overwrites without write access, and supersedes a read-only file', ()=>{
    const { memory, files, fns } = setup();
    const native = /** @type {any} */ (fns.CreateFileW).natives.NtCreateFile;
    const FILE_SUPERSEDE = 0;
    const FILE_OVERWRITE = 4;
    const FILE_OVERWRITE_IF = 5;
    const FILE_ATTRIBUTE_ARCHIVE = 0x20;
    /** @param {string} name @param {number} disposition @param {number} attributes */
    const create = (name, disposition, attributes)=>{
        const status = native.handler([NT_HANDLE, GENERIC_READ, objectAttributes(memory, name),
            NT_STATUS, 0, attributes, 3, disposition, 0, 0, 0]) >>> 0;
        if (status === 0)
        {
            fns.CloseHandle.handler([memory.dword(NT_HANDLE)]);
        }
        return status;
    };
    files.put('C:\\GAME\\o.tmp', 'abc');
    assert.equal(create('\\??\\C:\\GAME\\o.tmp', FILE_OVERWRITE, FILE_ATTRIBUTE_READONLY), 0,
        'GENERIC_READ is enough to overwrite');
    assert.equal(memory.dword(NT_STATUS + 4), 3, 'FILE_OVERWRITTEN');
    assert.equal(files.text('C:\\GAME\\o.tmp'), '', 'emptied');
    assert.equal(files.stat('C:\\GAME\\o.tmp')?.attributes,
        FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE, 'and given the attributes asked');
    assert.equal(create('\\??\\C:\\GAME\\o.tmp', FILE_OVERWRITE, 0), 0xc0000022,
        'a read-only file is not overwritten');
    assert.equal(create('\\??\\C:\\GAME\\o.tmp', FILE_OVERWRITE_IF, 0), 0xc0000022);
    assert.equal(create('\\??\\C:\\GAME\\o.tmp', FILE_SUPERSEDE, 0), 0, 'but superseded');
    assert.equal(memory.dword(NT_STATUS + 4), 0, 'FILE_SUPERSEDED');
    assert.equal(create('\\??\\C:\\GAME\\none.tmp', FILE_OVERWRITE, 0), 0xc0000034,
        'nothing to overwrite');
    assert.equal(create('\\??\\C:\\GAME\\dir\\', 2, 0), 0xc0000033,
        'a name ending in a separator is no file\'s');
});
