/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL32_ORDINALS, createShellFunctions } from './functions.js';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';
import { decodeAnsi } from '../kernel32/locale.js';

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

test('DllGetVersion answers the shell of Windows XP SP3 in either structure', ()=>{
    // A program checks the shell's version before calling what a newer one
    // has; the first field says which structure it passed.
    const memory = new Uint8Array(0x100).fill(0xaa);
    const shell = /** @type {any} */ (createShellFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ l)=>memory.slice(a, a + l),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
    }));
    const view = new DataView(memory.buffer);
    const E_INVALIDARG = 0x80070057 | 0;
    assert.equal(shell.DllGetVersion.argBytes, 4);

    view.setUint32(0x10, 20, true);
    assert.equal(shell.DllGetVersion.handler([0x10]), 0);
    assert.deepEqual([0x14, 0x18, 0x1c, 0x20].map(at=>view.getUint32(at, true)), [6, 0, 2900, 2]);
    assert.equal(memory[0x24], 0xaa, 'nothing past a DLLVERSIONINFO');

    view.setUint32(0x40, 32, true);
    assert.equal(shell.DllGetVersion.handler([0x40]), 0);
    assert.equal(view.getUint32(0x54, true), 0, 'no flags');
    assert.equal(view.getBigUint64(0x58, true), (6n << 48n) | (2900n << 16n) | 5512n);

    view.setUint32(0x80, 24, true);
    assert.equal(shell.DllGetVersion.handler([0x80]), E_INVALIDARG);
    assert.equal(shell.DllGetVersion.handler([0]), E_INVALIDARG);
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
    const string = at=>decodeAnsi(memory.subarray(at, memory.indexOf(0, at)));
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

test('the wide spelling of a folder path is UTF-16 in the buffer', ()=>{
    // shfolder and shell32 both export the W form, and a program that links
    // against either gets the path twice as wide with a two-byte terminator.
    const m = machineWithFolders();
    const CSIDL_PROGRAM_FILES = 0x26;
    const PATH = 'C:\\Program Files';

    assert.equal(m.shell.SHGetFolderPathW.handler([0, CSIDL_PROGRAM_FILES, 0, 0, 0x300]), 0);
    assert.equal(
        new TextDecoder('utf-16le').decode(
            m.memory.subarray(0x300, 0x300 + PATH.length * 2)),
        PATH);
    assert.deepEqual([...m.memory.slice(0x300 + PATH.length * 2, 0x300 + PATH.length * 2 + 2)],
        [0, 0], 'terminated by two zero bytes');

    assert.equal(m.shell.SHGetSpecialFolderPathW.handler([0, 0x340, CSIDL_PROGRAM_FILES, 1]), 1);
    assert.equal(
        new TextDecoder('utf-16le').decode(
            m.memory.subarray(0x340, 0x340 + PATH.length * 2)),
        PATH);
});

test('launching nothing is refused, not quietly succeeded', ()=>{
    // Success for something that did not happen is the failure that costs most:
    // the caller carries on believing a program started.
    const m = machine();
    assert.ok(m.shell.ShellExecuteA.handler([0, 0, 0, 0, 0, 0]) <= 32,
        'ShellExecute reports failure as a value of 32 or less');
    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0, 0, 0, 0]), 5);
});

/**
 * The machine above with a launcher standing in for kernel32's spawner, which
 * is what a launch goes through: the shell resolves an image and composes a
 * command line, and the test reads back both.
 *
 * @param {string[]} files  The images the launcher finds, by full or bare name.
 * @param {object} [extra]  More of the host.
 */
function machineWithLauncher(files, extra){
    /** @type {{ named: string, line: string, flags: number }[]} */
    const launched = [];
    /** @type {string[]} */
    const diverged = [];
    const known = new Map();
    for (const path of files)
    {
        known.set(path.toLowerCase(), path);
        known.set(path.slice(path.lastIndexOf('\\') + 1).toLowerCase(), path);
    }
    const m = machineWithPaths('C:\\App', {
        launcher: {
            /**
             * @param {string} named @param {string} line @param {number} flags
             */
            launch(named, line, flags){
                launched.push({ named, line, flags });
                return { id: 0x2000, handle: 0x40, threadHandle: 0x44 };
            },
            imageOf: (/** @type {string} */ name)=>
                known.get(name.trim().toLowerCase()) ?? null,
        },
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
        ...extra,
    });
    return { ...m, launched, diverged };
}

test('the shell starts an executable, with its arguments and a quoted image', ()=>{
    const m = machineWithLauncher(['C:\\App\\setup.exe']);
    m.put('setup.exe', 0x100);
    m.put('/s', 0x140);

    assert.equal(m.shell.ShellExecuteA.handler([0x1c, 0, 0x100, 0x140, 0, 1]), 33,
        'success is a value above 32');
    assert.deepEqual(m.launched,
        [{ named: 'C:\\App\\setup.exe', line: '"C:\\App\\setup.exe" /s', flags: 0 }]);
    assert.deepEqual(m.diverged, [], 'starting the program named is what Windows does');
    assert.equal(m.shell.ShellExecuteA.argBytes, 24);
});

test('a path with a space in it travels quoted, so its tail is not an argument', ()=>{
    const m = machineWithLauncher(['C:\\Program Files\\Game\\setup.exe']);
    m.put('C:\\Program Files\\Game\\setup.exe', 0x100);

    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x100, 0, 0, 1]), 33);
    assert.equal(m.launched[0].line, '"C:\\Program Files\\Game\\setup.exe"');
});

test('a launch with no arguments hands the child its own name and nothing else', ()=>{
    const m = machineWithLauncher(['C:\\App\\setup.exe']);
    m.put('setup.exe', 0x100);

    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x100, 0, 0, 5]), 33);
    assert.equal(m.launched[0].line, '"C:\\App\\setup.exe"');
});

test('a document, and a verb that needs one, are refused as having no handler', ()=>{
    const m = machineWithLauncher(['C:\\App\\setup.exe', 'C:\\App\\readme.txt']);
    m.put('readme.txt', 0x100);
    m.put('setup.exe', 0x140);
    m.put('print', 0x180);

    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x100, 0, 0, 1]), 31,
        'a readme belongs to a handler registry this build does not have');
    assert.equal(m.shell.ShellExecuteA.handler([0, 0x180, 0x140, 0, 0, 1]), 31,
        'and "print" names a handler rather than the file itself');
    assert.deepEqual(m.launched, [], 'nothing was started for either');
});

test('a text file opens in Notepad, as XP\'s registry has it', ()=>{
    const m = machineWithLauncher(['C:\\App\\readme.txt', 'C:\\WINDOWS\\system32\\notepad.exe']);
    m.put('readme.txt', 0x100);
    m.put('open', 0x140);

    assert.equal(m.shell.ShellExecuteA.handler([0, 0x140, 0x100, 0, 0, 1]), 33);
    const notepad = 'C:\\WINDOWS\\system32\\notepad.exe';
    assert.deepEqual(m.launched,
        [{ named: notepad, line: `${notepad} C:\\App\\readme.txt`, flags: 0 }],
        'the file after the program, unquoted, as %1 is in the command');

    m.put('missing.log', 0x180);
    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x180, 0, 0, 1]), 2,
        'a text file that is not there is not found, rather than opened empty');
    assert.equal(m.launched.length, 1);
});

test('FindExecutable names Notepad for a text file, and not one that is not there', ()=>{
    // A setup asks before it starts the program on its readme.
    const m = machineWithLauncher(['C:\\App\\readme.txt', 'C:\\WINDOWS\\system32\\notepad.exe']);
    m.put('readme.txt', 0x100);
    assert.equal(m.shell.FindExecutableA.handler([0x100, 0, 0x200]), 33);
    assert.equal(m.string(0x200), 'C:\\WINDOWS\\system32\\notepad.exe');
    m.put('gone.txt', 0x100);
    assert.equal(m.shell.FindExecutableA.handler([0x100, 0, 0x200]), 2, 'SE_ERR_FNF');
});

test('an address goes to whoever is in front of the run, and is refused without one', ()=>{
    /** @type {string[]} */
    const opened = [];
    const m = machineWithLauncher([], { openUrl: (/** @type {string} */ url)=>{
        opened.push(url);
        return true;
    } });
    m.put('http://www.example.com/', 0x100);
    m.put('mailto:someone@example.com', 0x180);

    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x100, 0, 0, 1]), 33);
    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x180, 0, 0, 1]), 33);
    assert.deepEqual(opened, ['http://www.example.com/', 'mailto:someone@example.com']);
    assert.deepEqual(m.launched, [], 'no program of the machine\'s was started for them');

    const none = machineWithLauncher([]);
    none.put('http://www.example.com/', 0x100);
    assert.equal(none.shell.ShellExecuteA.handler([0, 0, 0x100, 0, 0, 1]), 31,
        'nothing took it: no association');
    assert.equal(none.diverged.length, 1);
});

test('a program that is not on the volume is reported missing, not started', ()=>{
    const m = machineWithLauncher(['C:\\App\\setup.exe']);
    m.put('other.exe', 0x100);

    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x100, 0, 0, 1]), 2);
    assert.deepEqual(m.launched, []);
});

test('a verb that asks for a prompt runs anyway, and says that it did not ask', ()=>{
    const m = machineWithLauncher(['C:\\App\\setup.exe']);
    m.put('setup.exe', 0x100);
    m.put('runas', 0x140);

    assert.equal(m.shell.ShellExecuteA.handler([0, 0x140, 0x100, 0, 0, 1]), 33);
    assert.equal(m.launched.length, 1);
    assert.equal(m.diverged.length, 1, 'one user and one volume: there is nothing to ask');
});

test('a directory for the child is reported, because it is not carried', ()=>{
    const m = machineWithLauncher(['C:\\App\\setup.exe']);
    m.put('setup.exe', 0x100);
    m.put('D:\\Elsewhere', 0x140);

    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x100, 0, 0x140, 1]), 33);
    assert.equal(m.launched[0].named, 'C:\\App\\setup.exe',
        'the file is still resolved where the caller is, not where the child goes');
    assert.equal(m.diverged.length, 1);
});

test('a build with nothing that can start a program says no rather than nothing', ()=>{
    const m = machineWithPaths('C:\\App');
    m.put('setup.exe', 0x100);
    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x100, 0, 0, 1]), 5);
});

test('the extended launch answers in the record, and hands over the child', ()=>{
    const m = machineWithLauncher(['C:\\App\\setup.exe']);
    m.put('setup.exe', 0x200);
    const view = new DataView(m.memory.buffer);
    const SEE_MASK_NOCLOSEPROCESS = 0x40;
    m.memory.fill(0, 0x100, 0x140);
    view.setUint32(0x104, SEE_MASK_NOCLOSEPROCESS, true);   // fMask
    view.setUint32(0x110, 0x200, true);                     // lpFile
    view.setUint32(0x11c, 1, true);                         // nShow

    assert.equal(m.shell.ShellExecuteExA.handler([0x100]), 1);
    assert.equal(view.getUint32(0x120, true), 33, 'hInstApp is what ShellExecute returns');
    assert.equal(view.getUint32(0x138, true), 0x40,
        'hProcess is a handle on the child, which is what a caller waits on');
    assert.equal(m.launched[0].line, '"C:\\App\\setup.exe"');
});

test('the extended launch starts the program whatever the flags that change nothing here',
    ()=>{
        // A setup starting its redistributable asks for no error boxes, no
        // asynchronous launch and the variables expanded; none of them makes
        // the file anything but the program to run.
        const SEE_MASK_NOCLOSEPROCESS = 0x40;
        const SEE_MASK_FLAG_NO_UI = 0x400;
        const SEE_MASK_NOASYNC = 0x100;
        const SEE_MASK_DOENVSUBST = 0x200;
        for (const mask of [SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_DOENVSUBST])
        {
            const m = machineWithLauncher(['C:\\WINDOWS\\TEMP\\DPLAY61A.EXE']);
            m.put('C:\\WINDOWS\\TEMP\\DPLAY61A.EXE', 0x200);
            m.put('/Q:A /R:N', 0x280);
            const view = new DataView(m.memory.buffer);
            m.memory.fill(0, 0x100, 0x140);
            view.setUint32(0x104, mask | SEE_MASK_NOCLOSEPROCESS, true);
            view.setUint32(0x110, 0x200, true);
            view.setUint32(0x114, 0x280, true);

            assert.equal(m.shell.ShellExecuteExA.handler([0x100]), 1, `mask ${mask}`);
            assert.equal(view.getUint32(0x120, true), 33);
            assert.equal(m.launched[0].line, '"C:\\WINDOWS\\TEMP\\DPLAY61A.EXE" /Q:A /R:N');
        }
    });

test('the extended launch refuses a record that names a list, or asks for a class it does not name',
    ()=>{
        for (const mask of [0x4, 0x1])
        {
            const m = machineWithLauncher(['C:\\App\\setup.exe']);
            m.put('setup.exe', 0x200);
            const view = new DataView(m.memory.buffer);
            m.memory.fill(0, 0x100, 0x140);
            view.setUint32(0x104, mask, true);
            view.setUint32(0x110, 0x200, true);

            assert.equal(m.shell.ShellExecuteExA.handler([0x100]), 0, `mask ${mask}`);
            assert.equal(view.getUint32(0x120, true), 31);
            assert.deepEqual(m.launched, []);
        }
    });

/** A volume with the executables and documents the FindExecutable tests name. */
const PATHS = Object.freeze({ volume: {
    files: new Set(['c:\\app\\setup.exe', 'c:\\games\\doom.exe', 'd:\\other\\setup.exe',
        'c:\\app\\readme.txt']),
    /** @param {string} path */
    stat(path){
        return { exists: this.files.has(path.toLowerCase()), isDirectory: false, size: 0 };
    },
    open: ()=>null,
    read: ()=>new Uint8Array(0),
    close: ()=>{},
} });

/**
 * The machine above with an ANSI string reader and a path resolver, which is
 * what FindExecutable needs to read a file name and qualify it. The resolver
 * mirrors the filesystem's: a qualified path is normalised, a relative one is
 * taken against the current directory.
 *
 * @param {string} cwd  The current directory the resolver qualifies against.
 * @param {Object} [extra]  More of the host, laid over the four above.
 */
function machineWithPaths(cwd, extra){
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
        readCString: (/** @type {number} */ address, /** @type {number} */ max)=>{
            let end = address;
            while (end < memory.length && end - address < max && memory[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(memory.subarray(address, end));
        },
        resolve: (/** @type {string} */ path)=>{
            return /^[A-Za-z]:[\\/]/.test(path) ? path : `${cwd}\\${path}`;
        },
        ...extra,
    };
    /** @param {number} at */
    const string = at=>decodeAnsi(memory.subarray(at, memory.indexOf(0, at)));
    return { memory, put, string, shell: /** @type {any} */ (createShellFunctions(host)) };
}

test('finding an executable that cannot be read reports no association', ()=>{
    const m = machine();
    assert.equal(m.shell.FindExecutableA.handler([0, 0, 0x100]), 31);
    assert.equal(m.memory[0x100], 0,
        'a caller reads the buffer whatever the return says');
});

test('an executable is associated with itself, qualified against the directory', ()=>{
    const m = machineWithPaths('C:\\App', PATHS);
    m.put('setup.exe', 0x100);
    const answer = m.shell.FindExecutableA.handler([0x100, 0, 0x200]);
    assert.ok(answer > 32, 'success is a value above 32');
    assert.equal(m.string(0x200), 'C:\\App\\setup.exe',
        'the relative name is qualified against the current directory');
    assert.equal(m.shell.FindExecutableA.argBytes, 12);
});

test('a qualified executable is answered as itself, and a directory overrides', ()=>{
    const m = machineWithPaths('C:\\App', PATHS);
    m.put('C:\\Games\\doom.exe', 0x100);
    assert.ok(m.shell.FindExecutableA.handler([0x100, 0, 0x200]) > 32);
    assert.equal(m.string(0x200), 'C:\\Games\\doom.exe');

    m.put('setup.exe', 0x100);
    m.put('D:\\Other', 0x140);
    assert.ok(m.shell.FindExecutableA.handler([0x100, 0x140, 0x200]) > 32);
    assert.equal(m.string(0x200), 'D:\\Other\\setup.exe',
        'a relative name resolves against the directory it was given');
});

test('FindExecutable looks for the file before its type: missing is not found', ()=>{
    const m = machineWithPaths('C:\\App', PATHS);
    m.put('missing.exe', 0x100);
    assert.equal(m.shell.FindExecutableA.handler([0x100, 0, 0x200]), 2, 'SE_ERR_FNF');
    assert.equal(m.memory[0x200], 0);
    m.put('file:///C|/App/setup.exe', 0x100);
    assert.equal(m.shell.FindExecutableA.handler([0x100, 0, 0x200]), 2, 'a URL is no file name');
    m.put('C:\\App\\setup.exe.', 0x100);
    assert.ok(m.shell.FindExecutableA.handler([0x100, 0, 0x200]) > 32, 'a trailing dot is no part');
    assert.equal(m.string(0x200), 'C:\\App\\setup.exe');
});

test('a document still reports no association, and clears the buffer', ()=>{
    const m = machineWithPaths('C:\\App', PATHS);
    m.put('readme.txt', 0x100);
    assert.equal(m.shell.FindExecutableA.handler([0x100, 0, 0x200]), 31,
        'this build has no document-handler registry to consult');
    assert.equal(m.memory[0x200], 0);
});

test('a window may accept drops, and a handle that is no drop holds no files', async()=>{
    const m = machine();
    assert.equal(m.shell.DragAcceptFiles.handler([0x40, 1]), 0);
    assert.equal(m.shell.DragAcceptFiles.handler([0x40, 0]), 0);
    assert.equal(await m.shell.DragQueryFileA.handler([0, 0xffffffff, 0, 0]), 0,
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
    // shellapi.h packs the structure to one byte on Win32: fFlags is a WORD
    // at 16, so the BOOL follows at 18 and hNameMappings at 22.
    assert.deepEqual([...m.memory.slice(0x112, 0x116)], [1, 0, 0, 0], 'fAnyOperationsAborted');
    assert.deepEqual([...m.memory.slice(0x110, 0x112)], [0xaa, 0xaa], 'fFlags is not touched');
    assert.deepEqual([...m.memory.slice(0x116, 0x11a)], [0xaa, 0xaa, 0xaa, 0xaa],
        'hNameMappings is not touched');
    assert.equal(m.shell.SHChangeNotify.handler([0x8000000, 0, 0, 0]), 0);
    assert.equal(m.shell.SHGetFileInfoA.handler([0x100, 0, 0x120, 352, 0x100]), 0);
    assert.deepEqual([m.shell.SHFileOperationA, m.shell.SHChangeNotify, m.shell.SHGetFileInfoA]
        .map(fn=>fn.argBytes), [4, 16, 20]);
});

test('a notification icon is refused, with both arguments popped', ()=>{
    const fns = createShellFunctions({ writeMemory: ()=>{} });
    assert.equal(fns.Shell_NotifyIconA.argBytes, 8);
    assert.equal(fns.Shell_NotifyIconA.handler(), 0);
    assert.equal(fns.Shell_NotifyIconW.argBytes, 8);
    assert.equal(fns.Shell_NotifyIconW.handler(), 0);
});

/**
 * A shell over a real volume, with guest memory for a SHFILEOPSTRUCT and the
 * lists it points at.
 *
 * @param {Record<string, any>} [extra]  More of the host, laid over the rest.
 * @param {number} [allocationEnd]  Where an allocation ends and nothing may lie
 *     past it: memory refuses a read across it.
 */
async function machineWithVolume(extra = {}, allocationEnd = 0){
    const fs = await filesystemModule.create({});
    const volume = /** @type {any} */ (createVolume(fs));
    volume.mkdir('C:\\work');
    volume.setCurrentDirectory('C:\\work');
    for (const name of ['a.txt', 'b.txt'])
    {
        const node = volume.open(name, { write: true, create: true, truncate: true });
        volume.write(node, 0, Uint8Array.of(0x41));
        volume.close(node);
    }
    const memory = new Uint8Array(0x4000);
    const view = new DataView(memory.buffer);
    let next = 0x1000;
    const shell = /** @type {any} */ (createShellFunctions({
        readMemory: (address, length)=>{
            assert.ok(address >= allocationEnd || address + length <= allocationEnd,
                `read of ${length} bytes at`
                + ` 0x${address.toString(16)} runs past the end of an allocation`);
            return memory.slice(address, address + length);
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        // As the memory layer reads an ANSI string: in Windows-1252, which is
        // what the Encoding standard calls latin1.
        readCString: (address, limit)=>{
            let end = address;
            while (end < address + limit && memory[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(memory.subarray(address, end));
        },
        resolve: path=>fs.resolve(path).path,
        volume: { ...volume, drives: ()=>['C'] },
        ...extra,
    }));
    /** A list of names, each terminated, and one more terminator. @param {string[]} names @param {boolean} wide */
    const list = (names, wide)=>{
        const at = next;
        for (const unit of [...names.join('\0'), '\0', '\0'])
        {
            if (wide)
            {
                view.setUint16(next, unit.charCodeAt(0), true);
                next += 2;
            }
            else
            {
                memory[next++] = unit.charCodeAt(0);
            }
        }
        next = next + 15 & ~15;
        return at;
    };
    /**
     * SHFILEOPSTRUCT at 0x100, packed to one byte as shellapi.h declares it.
     *
     * @param {number} func @param {number} from @param {number} to @param {number} flags
     */
    const record = (func, from, to, flags)=>{
        memory.fill(0xaa, 0x100, 0x120);
        view.setUint32(0x100, 0, true);
        view.setUint32(0x104, func, true);
        view.setUint32(0x108, from, true);
        view.setUint32(0x10c, to, true);
        view.setUint16(0x110, flags, true);
        return 0x100;
    };
    return { fs, volume, shell, memory, view, list, record };
}

test('SHFileOperation copies, moves, renames and deletes on the volume', async()=>{
    // shlfileop.c: FO_DELETE answers ERROR_SUCCESS with fAnyOperationsAborted
    // FALSE and the files gone; the same record read through either spelling.
    const m = await machineWithVolume();
    const FO_MOVE = 1;
    const FO_COPY = 2;
    const FO_DELETE = 3;
    const FO_RENAME = 4;
    const FOF_NO_UI = 0x0614;

    const copy = m.record(FO_COPY, m.list(['a.txt', 'b.txt'], false),
        m.list(['copies'], false), FOF_NO_UI);
    assert.equal(await m.shell.SHFileOperation.handler([copy]), 0,
        'the undecorated name is the ANSI call');
    assert.equal(m.view.getUint32(0x112, true), 0, 'fAnyOperationsAborted, at 18');
    assert.equal(m.view.getUint32(0x116, true), 0xaaaaaaaa, 'hNameMappings is not asked for');
    assert.ok(m.volume.stat('copies\\a.txt') && m.volume.stat('copies\\b.txt'));

    const move = m.record(FO_MOVE, m.list(['copies\\a.txt'], true), m.list(['moved.txt'], true),
        FOF_NO_UI);
    assert.equal(await m.shell.SHFileOperationW.handler([move]), 0);
    assert.ok(!m.volume.stat('copies\\a.txt') && m.volume.stat('moved.txt'));

    const rename = m.record(FO_RENAME, m.list(['moved.txt'], false), m.list(['renamed.txt'], false),
        FOF_NO_UI);
    assert.equal(await m.shell.SHFileOperationA.handler([rename]), 0);
    assert.ok(m.volume.stat('renamed.txt'));

    const remove = m.record(FO_DELETE, m.list(['copies', 'renamed.txt'], true), 0, FOF_NO_UI);
    assert.equal(await m.shell.SHFileOperationW.handler([remove]), 0);
    assert.ok(!m.volume.stat('copies') && !m.volume.stat('renamed.txt'));
    assert.ok(m.volume.stat('a.txt'), 'the sources of the copy are where they were');

    const missing = m.record(FO_DELETE, m.list(['nonexistent.txt'], false), 0, FOF_NO_UI);
    assert.equal(await m.shell.SHFileOperationA.handler([missing]), 2, 'ERROR_FILE_NOT_FOUND');
    assert.equal(m.view.getUint32(0x112, true), 0, 'a failure is not an abort');
    const none = m.record(FO_DELETE, 0, 0, FOF_NO_UI);
    assert.equal(await m.shell.SHFileOperationA.handler([none]), 87, 'ERROR_INVALID_PARAMETER');
    assert.equal(m.view.getUint32(0x112, true), 0xaaaaaaaa, 'and the record left alone');
    assert.deepEqual([m.shell.SHFileOperationA.argBytes, m.shell.SHFileOperationW.argBytes],
        [4, 4]);
});

test('SHFileOperation reads lists that end just short of the end of their memory', async()=>{
    const end = 0x4000;
    const m = await machineWithVolume({}, end);
    /** @param {string[]} names @param {boolean} wide @param {number} before */
    const listBefore = (names, wide, before)=>{
        const units = [...names.join('\0'), '\0', '\0'].map(c=>c.charCodeAt(0));
        const bytes = wide ? new Uint8Array(Uint16Array.from(units).buffer)
            : Uint8Array.from(units);
        m.memory.set(bytes, before - 8 - bytes.length);
        return before - 8 - bytes.length;
    };
    const copy = m.record(2, listBefore(['a.txt', 'b.txt'], true, 0x3000),
        listBefore(['copies'], true, end), 0x0614);
    assert.equal(await m.shell.SHFileOperationW.handler([copy]), 0);
    assert.ok(m.volume.stat('copies\\a.txt') && m.volume.stat('copies\\b.txt'));
    const remove = m.record(3, listBefore(['copies'], false, end), 0, 0x0614);
    assert.equal(await m.shell.SHFileOperationA.handler([remove]), 0);
    assert.ok(!m.volume.stat('copies'));
    // A path is one name: the list's second terminator is the next thing in memory.
    assert.equal(m.shell.SHCreateDirectoryExW.handler([0, listBefore(['C:\\work\\made'], true,
        end), 0]), 0);
    assert.ok(m.volume.stat('C:\\work\\made')?.isDirectory);
});

test('an ANSI name in the upper half of the page names the file CreateFileA made by it', async()=>{
    // 0x80 is the euro sign in Windows-1252 and 0x99 the trade mark, as every
    // ANSI path is read: a list of them names the same file, not one called
    // by the control characters of the same codes.
    const m = await machineWithVolume();
    const node = m.volume.open('\u20ac\u2122.txt', { write: true, create: true, truncate: true });
    m.volume.close(node);
    const remove = m.record(3, m.list(['\x80\x99.txt'], false), 0, 0x0614);
    assert.equal(await m.shell.SHFileOperationA.handler([remove]), 0);
    assert.ok(!m.volume.stat('\u20ac\u2122.txt'));
});

test('a folder path in the upper half of the ANSI page goes back in that page', ()=>{
    // Through the item id list and out of SHGetPathFromIDListA, and straight
    // out of SHGetSpecialFolderPathA: the euro sign 0x80, the trade mark 0x99.
    const memory = new Uint8Array(0x1000).fill(0xaa);
    let free = 0x800;
    const shell = /** @type {any} */ (createShellFunctions({
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.slice(a, a + n),
        allocate: (/** @type {number} */ bytes)=>{
            const at = free;
            free += bytes;
            return at;
        },
        folders: { Desktop: 'C:\\\u20ac\u2122' },
    }));
    const CSIDL_DESKTOPDIRECTORY = 0x10;
    assert.equal(shell.SHGetSpecialFolderLocation.handler([0, CSIDL_DESKTOPDIRECTORY, 0x100]), 0);
    const list = new DataView(memory.buffer).getUint32(0x100, true);
    assert.equal(shell.SHGetPathFromIDListA.handler([list, 0x200]), 1);
    assert.deepEqual([...memory.subarray(0x200, 0x206)], [0x43, 0x3a, 0x5c, 0x80, 0x99, 0]);
    assert.equal(shell.SHGetSpecialFolderPathA.handler([0, 0x300, CSIDL_DESKTOPDIRECTORY, 0]), 1);
    assert.deepEqual([...memory.subarray(0x300, 0x306)], [0x43, 0x3a, 0x5c, 0x80, 0x99, 0]);
});

test('SHCreateDirectoryEx makes the whole path, and says when it was there', async()=>{
    const m = await machineWithVolume();
    const narrow = m.list(['C:\\work\\one\\two'], false);
    assert.equal(m.shell.SHCreateDirectoryExA.handler([0, narrow, 0]), 0);
    assert.ok(m.volume.stat('C:\\work\\one\\two')?.isDirectory);
    assert.equal(m.shell.SHCreateDirectoryExA.handler([0, narrow, 0]), 183,
        'ERROR_ALREADY_EXISTS');
    const wide = m.list(['C:\\work\\\u00e9t\u00e9\\three'], true);
    assert.equal(m.shell.SHCreateDirectoryExW.handler([0, wide, 0]), 0);
    assert.ok(m.volume.stat('C:\\work\\\u00e9t\u00e9\\three')?.isDirectory);
    assert.deepEqual([m.shell.SHCreateDirectoryExA.argBytes, m.shell.SHCreateDirectoryExW.argBytes],
        [12, 12]);
});

test('SHCreateDirectory is the wide one with no attributes, and is shell32\'s ordinal 165',
    async()=>{
        // A game's voice setup saves its settings into a folder it makes this
        // way, imported by number alone.
        const m = await machineWithVolume();
        const path = m.list(['C:\\work\\voice'], true);
        assert.equal(m.shell.SHCreateDirectory.handler([0, path]), 0);
        assert.ok(m.volume.stat('C:\\work\\voice')?.isDirectory);
        assert.equal(m.shell.SHCreateDirectory.argBytes, 8);
        assert.equal(SHELL32_ORDINALS[165], 'SHCreateDirectory');
    });

/** @param {Uint8Array} memory @param {string} text @param {number} at */
function putWide(memory, text, at){
    const view = new DataView(memory.buffer);
    [...text, '\0'].forEach((unit, index)=>
        view.setUint16(at + index * 2, unit.charCodeAt(0), true));
    return at;
}

test('the wide launch reads its strings wide, and starts the same program', ()=>{
    const m = machineWithLauncher(['C:\\App\\setup.exe']);
    putWide(m.memory, 'setup.exe', 0x100);
    putWide(m.memory, '/s', 0x140);

    assert.equal(m.shell.ShellExecuteW.handler([0, 0, 0x100, 0x140, 0, 1]), 33);
    assert.deepEqual(m.launched,
        [{ named: 'C:\\App\\setup.exe', line: '"C:\\App\\setup.exe" /s', flags: 0 }]);
    putWide(m.memory, 'readme.txt', 0x100);
    assert.equal(m.shell.ShellExecuteW.handler([0, 0, 0x100, 0, 0, 1]), 31,
        'a document is refused in either spelling');
    assert.equal(m.shell.ShellExecuteW.argBytes, 24);
});

test('the wide extended launch reads the same record with wide strings', ()=>{
    // SHELLEXECUTEINFOW is SHELLEXECUTEINFOA field for field.
    const m = machineWithLauncher(['C:\\App\\setup.exe']);
    putWide(m.memory, 'setup.exe', 0x200);
    putWide(m.memory, '/VERYSILENT', 0x240);
    const view = new DataView(m.memory.buffer);
    m.memory.fill(0, 0x100, 0x140);
    view.setUint32(0x100, 60, true);                        // cbSize
    view.setUint32(0x104, 0x40, true);                      // SEE_MASK_NOCLOSEPROCESS
    view.setUint32(0x110, 0x200, true);                     // lpFile
    view.setUint32(0x114, 0x240, true);                     // lpParameters

    assert.equal(m.shell.ShellExecuteExW.handler([0x100]), 1);
    assert.equal(view.getUint32(0x120, true), 33);
    assert.equal(view.getUint32(0x138, true), 0x40);
    assert.equal(m.launched[0].line, '"C:\\App\\setup.exe" /VERYSILENT');

    view.setUint32(0x104, 0x4, true);                       // SEE_MASK_IDLIST
    assert.equal(m.shell.ShellExecuteExW.handler([0x100]), 0);
    assert.equal(view.getUint32(0x120, true), 31);
    assert.equal(m.shell.ShellExecuteExW.handler([0]), 0);
    assert.equal(m.shell.ShellExecuteExW.argBytes, 4);
});

test('a list turns back into its path in UTF-16, and the wide browse is cancelled too', ()=>{
    const m = machineWithFolders();
    const CSIDL_PROGRAM_FILES = 0x26;
    const PATH = 'C:\\Program Files';
    assert.equal(m.shell.SHGetSpecialFolderLocation.handler([0, CSIDL_PROGRAM_FILES, 0x100]), 0);
    const list = new DataView(m.memory.buffer).getUint32(0x100, true);

    assert.equal(m.shell.SHGetPathFromIDListW.handler([list, 0x200]), 1);
    assert.equal(new TextDecoder('utf-16le').decode(
        m.memory.subarray(0x200, 0x200 + PATH.length * 2 + 2)), `${PATH}\0`);
    assert.equal(m.shell.SHGetPathFromIDListW.handler([0, 0x300]), 0);
    assert.deepEqual([...m.memory.subarray(0x300, 0x302)], [0, 0], 'a wide empty path');

    assert.equal(m.shell.SHBrowseForFolderW.handler([0x100]), 0);
    assert.deepEqual([m.shell.SHGetPathFromIDListW.argBytes, m.shell.SHBrowseForFolderW.argBytes],
        [8, 4]);
});

test('SHGetFileInfoW refuses as its ANSI twin does, and leaves the wider record alone', ()=>{
    // SHFILEINFOW is 692 bytes to SHFILEINFOA's 352; neither is written.
    const SHGFI_SYSICONINDEX = 0x4000;
    const SHGFI_SMALLICON = 0x1;
    const memory = new Uint8Array(0x400).fill(0xaa);
    const shell = /** @type {any} */ (createShellFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    }));
    putWide(memory, 'C:\\App', 0x10);
    assert.equal(shell.SHGetFileInfoW.handler([0x10, 0, 0x40, 692,
        SHGFI_SYSICONINDEX | SHGFI_SMALLICON]), 0);
    assert.ok(memory.subarray(0x40, 0x40 + 692).every(byte=>byte === 0xaa));
    assert.equal(shell.SHGetFileInfoW.argBytes, 20);
});

test('SHPathPrepareForWrite finds a directory, refuses a file, makes one asked for', async()=>{
    /** @type {string[]} */
    const diverged = [];
    const m = await machineWithVolume({
        divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
            diverged.push(`${api}: ${detail}`),
    });
    const SHPPFW_NONE = 0;
    const SHPPFW_DIRCREATE = 1;
    const SHPPFW_ASKDIRCREATE = 2;
    const SHPPFW_IGNOREFILENAME = 4;
    const S_OK = 0;
    const PATH_NOT_FOUND = 0x80070003 | 0;
    const DIRECTORY = 0x8007010b | 0;
    /** @param {string} path @param {number} flags @param {boolean} [wide] */
    const prepare = (path, flags, wide = false)=>m.shell[
        wide ? 'SHPathPrepareForWriteW' : 'SHPathPrepareForWriteA'].handler(
        [0, 0, m.list([path], wide), flags]);

    assert.equal(prepare('C:\\work', SHPPFW_NONE), S_OK);
    assert.equal(prepare('C:\\work\\', SHPPFW_NONE), S_OK, 'a trailing separator');
    assert.equal(prepare('C:\\', SHPPFW_NONE), S_OK, 'the root');
    assert.equal(prepare('a.txt', SHPPFW_NONE), DIRECTORY, 'a file where a directory should be');
    assert.equal(prepare('a.txt\\', SHPPFW_DIRCREATE), DIRECTORY, 'and not made over it');
    assert.equal(prepare('a.txt', SHPPFW_IGNOREFILENAME), S_OK,
        'a bare file name is in the current directory');

    assert.equal(prepare('C:\\work\\missing\\file.txt', SHPPFW_IGNOREFILENAME), PATH_NOT_FOUND);
    assert.equal(m.volume.stat('missing'), null, 'and nothing was made');
    assert.equal(prepare('C:\\work\\missing\\file.txt',
        SHPPFW_IGNOREFILENAME | SHPPFW_DIRCREATE), S_OK);
    assert.ok(m.volume.stat('C:\\work\\missing')?.isDirectory);
    assert.equal(m.volume.stat('C:\\work\\missing\\file.txt'), null, 'the file name is not made');
    assert.equal(prepare('C:\\work\\whole\\', SHPPFW_IGNOREFILENAME | SHPPFW_DIRCREATE), S_OK,
        'a trailing separator leaves no file name to ignore');
    assert.ok(m.volume.stat('C:\\work\\whole')?.isDirectory);

    // Wine's conformance test: a relative path is found, but not made.
    assert.equal(prepare('.\\missing', SHPPFW_DIRCREATE), S_OK);
    assert.equal(prepare('.\\relative\\dir', SHPPFW_DIRCREATE), PATH_NOT_FOUND);
    assert.equal(m.volume.stat('relative'), null);

    assert.equal(prepare('C:\\work\\one\\two', SHPPFW_DIRCREATE, true), S_OK);
    assert.ok(m.volume.stat('C:\\work\\one\\two')?.isDirectory, 'every directory of the path');
    assert.equal(prepare('C:\\work\\\u00e9t\u00e9', SHPPFW_NONE, true), PATH_NOT_FOUND);
    assert.deepEqual(diverged, []);

    assert.equal(prepare('C:\\work\\asked', SHPPFW_ASKDIRCREATE), S_OK);
    assert.ok(m.volume.stat('C:\\work\\asked')?.isDirectory);
    assert.equal(diverged.length, 1, 'made without asking, which is said');

    assert.equal(m.shell.SHPathPrepareForWriteW.handler([0, 0, 0, SHPPFW_DIRCREATE]) | 0,
        0x80070057 | 0, 'no path is E_INVALIDARG');
    assert.deepEqual(
        [m.shell.SHPathPrepareForWriteA.argBytes, m.shell.SHPathPrepareForWriteW.argBytes],
        [16, 16]);
});

test('SHPathPrepareForWrite with no volume finds no path', ()=>{
    const m = machineWithPaths('C:\\App');
    m.put('C:\\App', 0x100);
    assert.equal(m.shell.SHPathPrepareForWriteA.handler([0, 0, 0x100, 1]) | 0, 0x80070003 | 0);
});

test('FindExecutableW is the same association in UTF-16, and DragQueryFileW no drop', async()=>{
    const m = machineWithPaths('C:\\App', PATHS);
    /** @param {string} text @param {number} at */
    const wide = (text, at)=>{
        [...text, '\0'].forEach((c, i)=>{
            m.memory[at + i * 2] = c.charCodeAt(0) & 0xff;
            m.memory[at + i * 2 + 1] = c.charCodeAt(0) >>> 8;
        });
    };
    /** @param {number} at */
    const read = at=>{
        let text = '';
        for (let i = at; m.memory[i] !== 0 || m.memory[i + 1] !== 0; i += 2)
        {
            text += String.fromCharCode(m.memory[i] | m.memory[i + 1] << 8);
        }
        return text;
    };
    wide('setup.exe', 0x100);
    assert.equal(m.shell.FindExecutableW.handler([0x100, 0, 0x200]), 33);
    assert.equal(read(0x200), 'C:\\App\\setup.exe');
    wide('readme.txt', 0x100);
    assert.equal(m.shell.FindExecutableW.handler([0x100, 0, 0x200]), 31);
    assert.equal(read(0x200), '', 'cleared');
    assert.equal(m.shell.FindExecutableW.argBytes, 12);

    assert.equal(await m.shell.DragQueryFileW.handler([0, 0xffffffff, 0, 0]), 0);
    assert.equal(m.shell.DragQueryFileW.argBytes, 16);
    assert.equal(m.shell.DragQueryFile, m.shell.DragQueryFileA, 'the bare name is the ANSI one');
    assert.equal(m.shell.ShellExecuteEx, m.shell.ShellExecuteExA);
});

test('a name without an extension is looked for as a program', ()=>{
    const m = machineWithLauncher(['C:\\WINDOWS\\system32\\msiexec.exe']);
    m.put('msiexec', 0x100);
    m.put('/i setup.msi', 0x140);
    m.put('readme', 0x180);

    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x100, 0x140, 0, 1]), 33,
        'the shell searches with ".exe" as the default extension');
    assert.deepEqual(m.launched, [{ named: 'C:\\WINDOWS\\system32\\msiexec.exe',
        line: '"C:\\WINDOWS\\system32\\msiexec.exe" /i setup.msi', flags: 0 }]);
    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0x180, 0, 0, 1]), 2,
        'and a name with no program by it is a file not found');
});
