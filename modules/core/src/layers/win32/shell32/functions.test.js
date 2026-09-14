/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellFunctions } from './functions.js';

/** @param {number} [allocator]  The IMalloc pointer ole32 would hand out, if any. */
function machine(allocator){
    const memory = new Uint8Array(0x200).fill(0xaa);
    /** @type {string[]} */
    const diverged = [];
    const host = {
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>
            memory.set(b, a),
        taskAllocator: allocator === undefined ? undefined : { pointer: ()=>allocator },
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
    };
    return { memory, diverged, shell: /** @type {any} */ (createShellFunctions(host)) };
}

test('the shell namespace is refused out loud, with a name the reporter can key on', ()=>{
    // The reporter takes the name and the detail as two arguments; a notice
    // handed to it as one object is keyed as "[object Object]" and every
    // refusal after the first is swallowed as a repeat.
    const m = machine();
    assert.equal(m.shell.SHGetDesktopFolder.handler([0x100]) | 0, 0x80004005 | 0);
    assert.deepEqual([...m.memory.slice(0x100, 0x104)], [0, 0, 0, 0]);
    assert.equal(m.shell.SHGetDesktopFolder.argBytes, 4);
    assert.deepEqual(m.diverged.map(line=>line.split(':')[0]), ['SHGetDesktopFolder']);
});

/** The machine above with a heap and the folder table, for the special folders. */
function machineWithFolders(){
    const memory = new Uint8Array(0x1000).fill(0xaa);
    let free = 0x800;
    const host = {
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.slice(a, a + n),
        allocate: (/** @type {number} */ bytes)=>{
            const at = free;
            free += bytes;
            return at;
        },
        folders: { Desktop: 'C:\\Desk', ProgramFiles: 'C:\\Program Files' },
    };
    /** @param {number} at */
    const string = at=>new TextDecoder('latin1').decode(memory.subarray(at, memory.indexOf(0, at)));
    return { memory, string, shell: /** @type {any} */ (createShellFunctions(host)) };
}

test('a special folder is answered as a list that turns back into its path', ()=>{
    const m = machineWithFolders();
    const CSIDL_DESKTOPDIRECTORY = 0x10;
    const CSIDL_FLAG_CREATE = 0x8000;

    assert.equal(m.shell.SHGetSpecialFolderLocation.handler(
        [0, CSIDL_DESKTOPDIRECTORY | CSIDL_FLAG_CREATE, 0x100]), 0);
    const list = new DataView(m.memory.buffer).getUint32(0x100, true);
    assert.notEqual(list, 0);
    assert.equal(m.shell.SHGetPathFromIDListA.handler([list, 0x200]), 1);
    assert.equal(m.string(0x200), 'C:\\Desk');
    assert.equal(m.memory[list + (m.memory[list] | m.memory[list + 1] << 8)], 0,
        'the list ends in an empty item');
});

test('a folder this machine does not have is refused, with the pointer and the path cleared', ()=>{
    const m = machineWithFolders();
    const CSIDL_NETWORK = 0x12;

    assert.equal(m.shell.SHGetSpecialFolderLocation.handler([0, CSIDL_NETWORK, 0x100]) | 0,
        0x80070057 | 0);
    assert.equal(new DataView(m.memory.buffer).getUint32(0x100, true), 0);
    assert.equal(m.shell.SHGetSpecialFolderPathA.handler([0, 0x200, CSIDL_NETWORK, 0]), 0);
    assert.equal(m.memory[0x200], 0);
    assert.equal(m.shell.SHGetSpecialFolderLocation.argBytes, 12);
});

test('the path spellings answer the same folder', ()=>{
    const m = machineWithFolders();
    const CSIDL_PROGRAM_FILES = 0x26;

    assert.equal(m.shell.SHGetSpecialFolderPathA.handler([0, 0x200, CSIDL_PROGRAM_FILES, 1]), 1);
    assert.equal(m.string(0x200), 'C:\\Program Files');
    assert.equal(m.shell.SHGetFolderPathA.handler([0, CSIDL_PROGRAM_FILES, 0, 0, 0x300]), 0);
    assert.equal(m.string(0x300), 'C:\\Program Files');
});

test('launching something is refused, not quietly succeeded', ()=>{
    // Success for something that did not happen is the failure that costs most:
    // the caller carries on believing a program started.
    const m = machine();
    assert.ok(m.shell.ShellExecuteA.handler([0, 0, 0, 0, 0, 0]) <= 32,
        'ShellExecute reports failure as a value of 32 or less');
    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0, 0, 0, 0]), 5);
});

/**
 * The machine above with an ANSI string reader and a path resolver, which is
 * what FindExecutable needs to read a file name and qualify it. The resolver
 * mirrors the filesystem's: a qualified path is normalised, a relative one is
 * taken against the current directory.
 *
 * @param {string} cwd  The current directory the resolver qualifies against.
 */
function machineWithPaths(cwd){
    const memory = new Uint8Array(0x1000).fill(0xaa);
    /** @param {string} text @param {number} at */
    const put = (text, at)=>{
        for (let i = 0; i < text.length; i++)
        {
            memory[at + i] = text.charCodeAt(i) & 0xff;
        }
        memory[at + text.length] = 0;
    };
    const host = {
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.slice(a, a + n),
        readCString: (/** @type {number} */ address)=>{
            let end = address;
            while (memory[end] !== 0)
            {
                end++;
            }
            return new TextDecoder('latin1').decode(memory.subarray(address, end));
        },
        resolve: (/** @type {string} */ path)=>{
            return /^[A-Za-z]:[\\/]/.test(path) ? path : `${cwd}\\${path}`;
        },
    };
    /** @param {number} at */
    const string = at=>new TextDecoder('latin1').decode(memory.subarray(at, memory.indexOf(0, at)));
    return { memory, put, string, shell: /** @type {any} */ (createShellFunctions(host)) };
}

test('finding an executable that cannot be read reports no association', ()=>{
    const m = machine();
    assert.equal(m.shell.FindExecutableA.handler([0, 0, 0x100]), 31);
    assert.equal(m.memory[0x100], 0,
        'a caller reads the buffer whatever the return says');
});

test('an executable is associated with itself, qualified against the directory', ()=>{
    const m = machineWithPaths('C:\\App');
    m.put('setup.exe', 0x100);
    const answer = m.shell.FindExecutableA.handler([0x100, 0, 0x200]);
    assert.ok(answer > 32, 'success is a value above 32');
    assert.equal(m.string(0x200), 'C:\\App\\setup.exe',
        'the relative name is qualified against the current directory');
    assert.equal(m.shell.FindExecutableA.argBytes, 12);
});

test('a qualified executable is answered as itself, and a directory overrides', ()=>{
    const m = machineWithPaths('C:\\App');
    m.put('C:\\Games\\doom.exe', 0x100);
    assert.ok(m.shell.FindExecutableA.handler([0x100, 0, 0x200]) > 32);
    assert.equal(m.string(0x200), 'C:\\Games\\doom.exe');

    m.put('setup.exe', 0x100);
    m.put('D:\\Other', 0x140);
    assert.ok(m.shell.FindExecutableA.handler([0x100, 0x140, 0x200]) > 32);
    assert.equal(m.string(0x200), 'D:\\Other\\setup.exe',
        'a relative name resolves against the directory it was given');
});

test('a document still reports no association, and clears the buffer', ()=>{
    const m = machineWithPaths('C:\\App');
    m.put('readme.txt', 0x100);
    assert.equal(m.shell.FindExecutableA.handler([0x100, 0, 0x200]), 31,
        'this build has no document-handler registry to consult');
    assert.equal(m.memory[0x200], 0);
});

test('a window may accept drops, and no files are ever dropped on it', ()=>{
    const m = machine();
    assert.equal(m.shell.DragAcceptFiles.handler([0x40, 1]), 0);
    assert.equal(m.shell.DragAcceptFiles.handler([0x40, 0]), 0);
    assert.equal(m.shell.DragQueryFileA.handler([0, 0xffffffff, 0, 0]), 0,
        'the count a caller loops over is zero, which runs no times');
});

test('browsing for a folder is a cancelled browse, and yields no path', ()=>{
    const m = machine();
    assert.equal(m.shell.SHBrowseForFolderA.handler([0x100]), 0);
    assert.equal(m.shell.SHGetPathFromIDListA.handler([0, 0x100]), 0);
    assert.equal(m.memory[0x100], 0);
    assert.equal(m.shell.SHBrowseForFolder, m.shell.SHBrowseForFolderA,
        'and the bare name the real library also exports finds the same entry');
    assert.equal(m.shell.SHGetPathFromIDList, m.shell.SHGetPathFromIDListA);
});

test('the allocator is the one ole32 hands out, and null when there is none', ()=>{
    const m = machine(0x20100);
    assert.equal(m.shell.SHGetMalloc.handler([0x100]), 0);
    assert.deepEqual([...m.memory.slice(0x100, 0x104)], [0x00, 0x01, 0x02, 0x00]);
    assert.equal(m.shell.SHGetMalloc.handler([0]) | 0, 0x80070057 | 0);

    // A caller that ignores the HRESULT then fails on a null it can see, rather
    // than on whatever its own stack held.
    const none = machine();
    assert.equal(none.shell.SHGetMalloc.handler([0x100]) | 0, 0x80004001 | 0);
    assert.deepEqual([...none.memory.slice(0x100, 0x104)], [0, 0, 0, 0]);
});

test('the extended launch is refused the same way, in the record the caller reads', ()=>{
    const m = machine();
    assert.equal(m.shell.ShellExecuteExA.handler([0x100]), 0);
    assert.deepEqual([...m.memory.slice(0x120, 0x124)], [5, 0, 0, 0],
        'hInstApp is SE_ERR_ACCESSDENIED');
    assert.equal(m.shell.ShellExecuteExA.argBytes, 4);
});

test('a shell file operation is refused as not implemented and marked aborted', ()=>{
    const m = machine();
    assert.equal(m.shell.SHFileOperationA.handler([0x100]), 120);
    assert.deepEqual([...m.memory.slice(0x114, 0x118)], [1, 0, 0, 0], 'fAnyOperationsAborted');
    assert.equal(m.shell.SHChangeNotify.handler([0x8000000, 0, 0, 0]), 0);
    assert.equal(m.shell.SHGetFileInfoA.handler([0x100, 0, 0x120, 352, 0x100]), 0);
    assert.deepEqual([m.shell.SHFileOperationA, m.shell.SHChangeNotify, m.shell.SHGetFileInfoA]
        .map(fn=>fn.argBytes), [4, 16, 20]);
});

test('a notification icon is refused, with both arguments popped', ()=>{
    const fns = createShellFunctions({ writeMemory: ()=>{} });
    assert.equal(fns.Shell_NotifyIconA.argBytes, 8);
    assert.equal(fns.Shell_NotifyIconA.handler(), 0);
});

test('DragFinish pops the drop it is handed', ()=>{
    const fns = createShellFunctions({ writeMemory: ()=>{} });
    assert.equal(fns.DragFinish.argBytes, 4);
    assert.equal(fns.DragFinish.handler(), 0);
});
