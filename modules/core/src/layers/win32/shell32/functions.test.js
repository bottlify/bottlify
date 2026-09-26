/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellFunctions } from './functions.js';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';

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
 */
function machineWithLauncher(files){
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

test('the extended launch refuses a record that names a list rather than a file', ()=>{
    const m = machineWithLauncher(['C:\\App\\setup.exe']);
    m.put('setup.exe', 0x200);
    const view = new DataView(m.memory.buffer);
    const SEE_MASK_IDLIST = 0x4;
    m.memory.fill(0, 0x100, 0x140);
    view.setUint32(0x104, SEE_MASK_IDLIST, true);
    view.setUint32(0x110, 0x200, true);

    assert.equal(m.shell.ShellExecuteExA.handler([0x100]), 0);
    assert.equal(view.getUint32(0x120, true), 31);
    assert.deepEqual(m.launched, []);
});

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
            return new TextDecoder('latin1').decode(memory.subarray(address, end));
        },
        resolve: (/** @type {string} */ path)=>{
            return /^[A-Za-z]:[\\/]/.test(path) ? path : `${cwd}\\${path}`;
        },
        ...extra,
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
});

test('DragFinish pops the drop it is handed', ()=>{
    const fns = createShellFunctions({ writeMemory: ()=>{} });
    assert.equal(fns.DragFinish.argBytes, 4);
    assert.equal(fns.DragFinish.handler(), 0);
});

/**
 * A shell over a real volume, with guest memory for a SHFILEOPSTRUCT and the
 * lists it points at.
 */
async function machineWithVolume(){
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
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readCString: (address, limit)=>{
            let text = '';
            for (let at = address; at < address + limit && memory[at] !== 0; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        resolve: path=>fs.resolve(path).path,
        volume: { ...volume, drives: ()=>['C'] },
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
    assert.equal(await m.shell.SHFileOperationA.handler([copy]), 0);
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
