/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpawner, createSpawnFunctions, isRedistributableInstaller } from './spawn.js';
import { createProcessTable } from '../../kernel/internal/processes.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_HANDLE = 6;
const CREATE_SUSPENDED = 0x00000004;
const CURRENT_PROCESS = 0xffffffff;
const WINEXEC_SUCCESS = 33;

/**
 * @param {Object} [options]
 * @param {string[]} [options.files]  Paths on the volume. Matched by fold, the
 *        way the real volume matches them.
 * @param {string} [options.imagePath]
 * @param {string} [options.cwd]  The current directory a relative name is taken
 *        against, as the volume takes it.
 */
function fakeHost({ files = [], imagePath = 'C:\\App\\launcher.exe', cwd = 'C:\\' } = {}){
    const bytes = new Uint8Array(0x2000);
    /** @type {number[]} */
    const errors = [];
    /** @type {any[]} */
    const requests = [];
    /** @type {Map<number, { type: string, object: any }>} */
    const handles = new Map();
    let nextHandle = 0x40;
    const present = new Set(files.map(path=>path.toLowerCase()));

    /** @param {string} path */
    const qualify = path=>(/^[A-Za-z]:[\\/]/.test(path) ? path : `${cwd}${path}`);

    return {
        bytes,
        errors,
        requests,
        handles,
        cwd,
        view: new DataView(bytes.buffer),
        kernel: {
            processes: createProcessTable(),
            handles: {
                /** @param {string} type @param {any} object */
                open(type, object){
                    const handle = nextHandle;
                    nextHandle += 4;
                    handles.set(handle, { type, object });
                    return handle;
                },
                /** @param {number} handle @param {string} [type] */
                resolve(handle, type){
                    const held = handles.get(handle);
                    if (!held || (type && held.type !== type))
                    {
                        throw new Error(`bad handle ${handle}`);
                    }
                    return held.object;
                },
            },
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} max */
        readCString(address, max){
            let text = '';
            for (let at = 0; at < max && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
        /** @param {number} address @param {number} max */
        readWideString(address, max){
            let text = '';
            for (let at = 0; at < max; at++)
            {
                const unit = bytes[address + at * 2] | bytes[address + at * 2 + 1] << 8;
                if (unit === 0)
                {
                    break;
                }
                text += String.fromCharCode(unit);
            }
            return text;
        },
        /** @param {number} code */
        setLastError: code=>errors.push(code),
        /** @param {string} path */
        stat: path=>(present.has(qualify(path).toLowerCase())
            ? { exists: true, isDirectory: false }
            : null),
        resolve: qualify,
        imagePath: ()=>imagePath,
        /** @param {any} request */
        spawned: (/** @type {any} */ request)=>requests.push(request),
    };
}

/** @param {any} host @param {number} at @param {string} text */
function putAnsi(host, at, text){
    for (let index = 0; index < text.length; index++)
    {
        host.bytes[at + index] = text.charCodeAt(index);
    }
    host.bytes[at + text.length] = 0;
    return at;
}

/** @param {any} host @param {number} at @param {string} text */
function putWide(host, at, text){
    for (let index = 0; index < text.length; index++)
    {
        host.bytes[at + index * 2] = text.charCodeAt(index) & 0xff;
        host.bytes[at + index * 2 + 1] = text.charCodeAt(index) >>> 8;
    }
    host.bytes[at + text.length * 2] = 0;
    host.bytes[at + text.length * 2 + 1] = 0;
    return at;
}

/**
 * The child that is to take this process's place, asserted to be there. Every
 * test below reads a field off it, and a null would report as a type error
 * rather than as the recording having failed.
 *
 * @param {any} host
 * @param {{ suspended?: boolean }} [options]  Read a child that is not pending yet.
 */
function pending(host, options){
    const child = options?.suspended
        ? host.kernel.processes.all()[0]
        : host.kernel.processes.pending();
    assert.ok(child, 'a child was recorded');
    return child;
}

test('a child is found however the caller spelled its name', ()=>{
    // Win32 paths do not distinguish case and the names in a bundle do. A
    // launcher naming `war3.exe` for an entry stored as `War3.exe` used to fall
    // through to the manifest's entry point -- itself -- and loop for ever.
    const host = fakeHost({ files: ['C:\\App\\War3.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'war3.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    // The caller's spelling is what travels on, because every lookup after this
    // folds case too. What matters is that the lookup found the entry at all
    // rather than falling through to whatever the manifest names.
    assert.equal(pending(host).imagePath, 'C:\\App\\war3.exe');
});

test('a bare name is looked for beside the program that asked for it', ()=>{
    const host = fakeHost({
        files: ['C:\\App\\child.exe'], imagePath: 'C:\\App\\launcher.exe',
    });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    assert.equal(pending(host).imagePath, 'C:\\App\\child.exe');
});

test('a child is recorded with a full path, however the caller spelled it', ()=>{
    // Everything downstream reads a location off the child's image -- the
    // directory it starts in, first of all -- and reads it against the child. A
    // bare name left relative puts the child wherever the next program happens
    // to look, which is not where the file is.
    const host = fakeHost({
        files: ['C:\\App\\setup.exe'], imagePath: 'C:\\Other\\sfx.exe', cwd: 'C:\\App\\',
    });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'setup.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    assert.equal(pending(host).imagePath, 'C:\\App\\setup.exe');
    assert.equal(pending(host).commandLine, '"C:\\App\\setup.exe"',
        'and the line composed for it names the same full path');
});

test('a name with no extension gets .exe, as CreateProcess gives it', ()=>{
    const host = fakeHost({ files: ['C:\\App\\setup.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'setup'), 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    assert.equal(pending(host).imagePath, 'C:\\App\\setup.exe');
});

test('an unquoted command line with a space in the path still finds the image', ()=>{
    // `C:\Program Files\Setup.exe /S` could be `C:\Program` with three
    // arguments. Windows tries each prefix in turn, and so does this -- without
    // it, every unquoted path containing a space names nothing.
    const host = fakeHost({ files: ['C:\\Program Files\\Setup.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.WinExec.handler(
        [putAnsi(host, 0x100, 'C:\\Program Files\\Setup.exe /S'), 0]), WINEXEC_SUCCESS);
    assert.equal(pending(host).imagePath, 'C:\\Program Files\\Setup.exe');
});

test('a quoted first token is taken whole and needs no guessing', ()=>{
    const host = fakeHost({ files: ['C:\\App\\Frozen Throne.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.WinExec.handler(
        [putAnsi(host, 0x100, '"C:\\App\\Frozen Throne.exe" -launch'), 0]), WINEXEC_SUCCESS);
    assert.equal(pending(host).imagePath, 'C:\\App\\Frozen Throne.exe');
});

test('a command line we compose ourselves quotes argv[0]', ()=>{
    // A child is handed one string, and its argv[0] ends at the first space.
    // Unquoted, a launcher that strips argv[0] to build its next command line
    // keeps the tail of its own path and re-appends it every restart.
    const host = fakeHost({ files: ['C:\\App\\Frozen Throne.exe'] });
    const fns = createSpawnFunctions(host);

    fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'C:\\App\\Frozen Throne.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    assert.equal(pending(host).commandLine,
        '"C:\\App\\Frozen Throne.exe"');
});

test('a command line the caller gave is passed through untouched', ()=>{
    const host = fakeHost({ files: ['C:\\App\\war3.exe'] });
    const fns = createSpawnFunctions(host);

    fns.CreateProcessA.handler([
        putAnsi(host, 0x100, 'C:\\App\\war3.exe'),
        putAnsi(host, 0x200, 'war3.exe -opengl'),
        0, 0, 0, 0, 0, 0, 0, 0,
    ]);

    assert.equal(pending(host).commandLine, 'war3.exe -opengl');
});

test('PROCESS_INFORMATION comes back filled in with usable handles', ()=>{
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);
    const information = 0x300;

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0, information]), 1);
    assert.deepEqual(host.errors, [ERROR_SUCCESS]);

    const child = pending(host);
    assert.equal(host.view.getUint32(information + 0, true), child.handle);
    assert.equal(host.view.getUint32(information + 4, true), child.threadHandle);
    assert.equal(host.view.getUint32(information + 8, true), child.id);
    assert.equal(host.view.getUint32(information + 12, true), child.threadId);

    assert.equal(host.kernel.handles.resolve(child.handle, 'process'), child);
    assert.equal(host.kernel.handles.resolve(child.threadHandle, 'process-thread'), child);
});

test('OpenProcess finds the program itself and the children it made, and nothing else', ()=>{
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);
    const ERROR_INVALID_PARAMETER = 87;
    const PROCESS_ALL_ACCESS = 0x1f0fff;
    fns.CreateProcessA.handler([putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const child = pending(host);

    assert.equal(fns.OpenProcess.argBytes, 12);
    const opened = fns.OpenProcess.handler([PROCESS_ALL_ACCESS, 0, child.id]);
    assert.notEqual(opened, 0);
    assert.notEqual(opened, child.handle, 'a handle of its own');
    assert.equal(host.kernel.handles.resolve(opened, 'process'), child);
    assert.equal(fns.OpenProcess.handler([PROCESS_ALL_ACCESS, 0, 0x1000]), CURRENT_PROCESS,
        'the program itself');
    assert.equal(fns.OpenProcess.handler([PROCESS_ALL_ACCESS, 0, 0x7777]), 0);
    assert.equal(host.errors.at(-1), ERROR_INVALID_PARAMETER);
});

test('an image that is not there is refused rather than recorded', ()=>{
    const host = fakeHost({ files: [] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'missing.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0x300]), 0);
    assert.deepEqual(host.errors, [ERROR_FILE_NOT_FOUND]);
    assert.equal(host.kernel.processes.pending(), null);
    assert.equal(host.view.getUint32(0x300, true), 0, 'and nothing was written back');

    assert.equal(fns.WinExec.handler([putAnsi(host, 0x100, 'missing.exe'), 0]),
        ERROR_FILE_NOT_FOUND, 'WinExec answers below 32 with the error itself');
});

test('CREATE_SUSPENDED records the child without arming the replacement', ()=>{
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, CREATE_SUSPENDED, 0, 0, 0, 0x300]), 1);
    assert.equal(host.kernel.processes.pending(), null);
    assert.equal(host.kernel.processes.all()[0].suspended, true);
});

test('the wide spelling starts the same child as the narrow one', ()=>{
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessW.handler(
        [putWide(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    assert.equal(pending(host).imagePath, 'C:\\App\\child.exe');
});

test('a write into a suspended child is deferred, not applied', ()=>{
    // The child's image is not mapped, so there is nowhere to put these bytes
    // yet. They are kept against the address they name and replayed once the PE
    // is there -- which is process hollowing implemented as a queue.
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);
    fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, CREATE_SUSPENDED, 0, 0, 0, 0x300]);
    const child = pending(host, { suspended: true });

    host.bytes.set([0x90, 0xcc, 0x90], 0x400);
    assert.equal(fns.WriteProcessMemory.handler(
        [child.handle, 0x401000, 0x400, 3, 0x500]), 1);

    assert.equal(child.patches.length, 1);
    assert.equal(child.patches[0].address, 0x401000);
    assert.deepEqual([...child.patches[0].bytes], [0x90, 0xcc, 0x90]);
    assert.equal(host.view.getUint32(0x500, true), 3, 'and it reported all three written');

    // Copied, not viewed: the machine these bytes came from is gone by the time
    // they are replayed.
    host.bytes[0x400] = 0xff;
    assert.deepEqual([...child.patches[0].bytes], [0x90, 0xcc, 0x90]);
});

test('a write against this process writes memory, as it always did', ()=>{
    const host = fakeHost();
    const fns = createSpawnFunctions(host);
    host.bytes.set([1, 2, 3, 4], 0x400);

    assert.equal(fns.WriteProcessMemory.handler(
        [CURRENT_PROCESS, 0x600, 0x400, 4, 0]), 1);
    assert.deepEqual([...host.bytes.slice(0x600, 0x604)], [1, 2, 3, 4]);
});

test('a write against a handle that is not a process fails', ()=>{
    const host = fakeHost();
    const fns = createSpawnFunctions(host);

    assert.equal(fns.WriteProcessMemory.handler([0x1234, 0x600, 0x400, 4, 0]), 0);
    assert.deepEqual(host.errors, [ERROR_INVALID_HANDLE]);
});

test('every request is reported while the stack that made it still stands', ()=>{
    // A replacement erases the logs of the run that asked for it, so the record
    // has to leave this process at the moment of the call.
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);

    fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    fns.WinExec.handler([putAnsi(host, 0x100, 'C:\\App\\child.exe'), 0]);

    assert.deepEqual(host.requests.map((/** @type {any} */ r)=>r.imagePath),
        ['C:\\App\\child.exe', 'C:\\App\\child.exe']);
});

test('argument sizes match what the guest compiled against', ()=>{
    const fns = createSpawnFunctions(fakeHost());

    assert.equal(fns.CreateProcessA.argBytes, 40);
    assert.equal(fns.CreateProcessW.argBytes, 40);
    assert.equal(fns.WinExec.argBytes, 8);
    assert.equal(fns.WriteProcessMemory.argBytes, 20);
});

test('the launcher every spelling shares finds one image and opens the handles', ()=>{
    // CreateProcess, WinExec and the shell's launch all resolve an image the same
    // way, because a program started through the shell has to be the one that was
    // named. A caller that asked to wait on the child needs a handle on it
    // whichever spelling started it, so the record carries one from the start.
    const host = fakeHost({
        files: ['C:\\App\\child.exe'], imagePath: 'C:\\App\\launcher.exe',
    });
    const spawner = createSpawner(host);

    assert.equal(spawner.imageOf('child.exe'), 'C:\\App\\child.exe',
        'a bare name is the one beside the program that asked');
    assert.equal(spawner.imageOf('C:\\App\\child.exe'), 'C:\\App\\child.exe');
    assert.equal(spawner.imageOf('missing.exe'), null);

    const made = spawner.launch('C:\\App\\child.exe', '"C:\\App\\child.exe" /s', 0);
    assert.equal(pending(host), made);
    assert.equal(made.commandLine, '"C:\\App\\child.exe" /s');
    assert.notEqual(made.handle, 0);
    assert.equal(host.kernel.handles.resolve(made.handle, 'process'), made);
    assert.equal(host.kernel.handles.resolve(made.threadHandle, 'process-thread'), made);
    assert.deepEqual(host.requests.map((/** @type {any} */ r)=>r.imagePath),
        ['C:\\App\\child.exe'], 'and the request left the process as it was recorded');
});

test('the redistributables the engine stands in for are recognised by what they are', ()=>{
    for (const name of ['vcredist_x86.exe', 'vc_redist.x86.exe', 'dotnetfx35.exe',
        'ndp48-x86-x64.exe', 'C:\\Install\\vcredist\\vcredist_x86.EXE', 'oalinst.exe'])
    {
        assert.equal(isRedistributableInstaller(name), true, name);
    }
    // The DirectX End-User Runtime is not among them: the engine carries no
    // copy of the libraries it installs, so its setup is a program like any other.
    for (const name of ['speedDemo.exe', 'War3.exe', 'launcher.exe', 'DXSETUP.exe',
        'dxwebsetup.exe', 'directx_Jun2010_redist.exe', 'C:\\Install\\DirectX\\DXSETUP.EXE',
        'C:\\Install\\DirectX\\anything.exe'])
    {
        assert.equal(isRedistributableInstaller(name), false, name);
    }
});

test('a redistributable child is answered as a process that already ran and exited 0', ()=>{
    // An installer starts the Visual C++ redistributable and waits for it. The
    // engine carries the C runtime itself, so the child is over before it
    // begins -- and it must not be what this process hands over to.
    const host = fakeHost({ files: ['C:\\App\\vcredist_x86.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'vcredist_x86.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    const made = host.kernel.processes.all()[0];
    assert.equal(made.completed, true);
    assert.equal(made.exitCode, 0, 'it exited cleanly');
    assert.equal(host.kernel.processes.pending(), null, 'nothing to replace this process with');
    assert.notEqual(made.handle, 0, 'and the caller still gets a process to wait on');
    assert.deepEqual(host.requests.map((/** @type {any} */ r)=>r.imagePath),
        ['C:\\App\\vcredist_x86.exe'], 'reported like any other child');

    // WinExec is the other spelling an SFX stub uses for the same child.
    const viaExec = fakeHost({ files: ['C:\\App\\vcredist_x86.exe'] });
    const execFns = createSpawnFunctions(viaExec);
    assert.equal(execFns.WinExec.handler(
        [putAnsi(viaExec, 0x100, 'vcredist_x86.exe /Q'), 0]), WINEXEC_SUCCESS);
    assert.equal(viaExec.kernel.processes.pending(), null);
    assert.equal(viaExec.kernel.processes.all()[0].exitCode, 0);
});

test('DXSETUP runs as the child it is, and installs the runtime itself', ()=>{
    // The libraries a title links against beyond Direct3D itself (d3dx9 and
    // the rest) are the DirectX setup's to put in system32, as on a machine
    // that never had them; the engine carries none of its own.
    const host = fakeHost({ files: ['C:\\Install\\DirectX\\DXSETUP.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'C:\\Install\\DirectX\\DXSETUP.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    1);
    const made = host.kernel.processes.all()[0];
    assert.equal(made.completed, false);
    assert.equal(host.kernel.processes.pending()?.imagePath, 'C:\\Install\\DirectX\\DXSETUP.exe');
});

test('an ordinary child is still held pending for the replacement', ()=>{
    const host = fakeHost({ files: ['C:\\App\\game.exe'] });
    const fns = createSpawnFunctions(host);

    fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'game.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(host.kernel.processes.all()[0].completed, false);
    assert.equal(host.kernel.processes.pending()?.imagePath, 'C:\\App\\game.exe');
});

test('ReadProcessMemory reads this process, and of a child only what was written into it', ()=>{
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);
    host.bytes.set([5, 6, 7, 8], 0x400);
    assert.equal(fns.ReadProcessMemory.handler([CURRENT_PROCESS, 0x400, 0x600, 4, 0x700]), 1);
    assert.deepEqual([...host.bytes.slice(0x600, 0x604)], [5, 6, 7, 8]);
    assert.equal(host.view.getUint32(0x700, true), 4);

    fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, CREATE_SUSPENDED, 0, 0, 0, 0x300]);
    const child = pending(host, { suspended: true });
    host.bytes.set([0x11, 0x22, 0x33, 0x44], 0x400);
    fns.WriteProcessMemory.handler([child.handle, 0x401000, 0x400, 4, 0]);
    assert.equal(fns.ReadProcessMemory.handler([child.handle, 0x401001, 0x800, 2, 0x700]), 1);
    assert.deepEqual([...host.bytes.slice(0x800, 0x802)], [0x22, 0x33],
        'the bytes it was handed, which is all of it there is yet');

    host.errors.length = 0;
    assert.equal(fns.ReadProcessMemory.handler([child.handle, 0x402000, 0x800, 2, 0x700]), 0);
    assert.equal(host.view.getUint32(0x700, true), 0);
    assert.deepEqual(host.errors, [299], 'ERROR_PARTIAL_COPY: nothing is mapped there yet');
    assert.equal(fns.ReadProcessMemory.handler([0x1234, 0x400, 0x800, 2, 0]), 0);
    assert.equal(host.errors.at(-1), ERROR_INVALID_HANDLE);
    assert.equal(fns.ReadProcessMemory.argBytes, 20);
});

test('a STARTUPINFO\'s output and error files are handed to the child, the parent\'s own', ()=>{
    // winetest hands each test its log this way and reads what the test wrote.
    const host = fakeHost({ files: ['C:\\App\\test.exe'] });
    const fns = createSpawnFunctions(host);
    const log = { path: 'C:\\App\\log.txt', node: {}, read: true, write: true, position: 12 };
    const file = host.kernel.handles.open('file', log);
    const startup = 0x400;
    host.view.setUint32(startup + 44, 0x100, true); // STARTF_USESTDHANDLES
    host.view.setUint32(startup + 60, file, true);
    host.view.setUint32(startup + 64, file, true);

    assert.equal(fns.CreateProcessA.handler(
        [0, putAnsi(host, 0x100, 'test.exe --list'), 0, 0, 1, 0, 0, 0, startup, 0]), 1);
    const { standardFiles } = pending(host);
    assert.equal(standardFiles.output, log, 'the same open file, so its position is shared');
    assert.equal(standardFiles.error, log);

    host.view.setUint32(startup + 44, 0, true);
    assert.equal(fns.CreateProcessA.handler(
        [0, putAnsi(host, 0x100, 'test.exe'), 0, 0, 0, 0, 0, 0, startup, 0]), 1);
    assert.equal(host.requests.at(-1).standardFiles, undefined,
        'without the flag the child keeps the console');
});

test('this process and its children are in the interactive session, and no other id is', ()=>{
    // Wine's kernel32 process.c test_session_info.
    const host = fakeHost();
    const fns = createSpawnFunctions(host);
    const child = host.kernel.processes.create({ imagePath: 'C:/App/child.exe', commandLine: '' });
    for (const id of [0x1000, child.id])
    {
        host.view.setUint32(0x100, 0xdeadbeef, true);
        assert.equal(fns.ProcessIdToSessionId.handler([id, 0x100]), 1);
        assert.equal(host.view.getUint32(0x100, true), 1);
    }
    assert.equal(fns.ProcessIdToSessionId.handler([0x7777, 0x100]), 0);
    assert.equal(host.errors.at(-1), 87);
    assert.equal(fns.WTSGetActiveConsoleSessionId.handler(), 1);
    assert.equal(fns.ProcessIdToSessionId.argBytes, 8);
});

test('a process-thread attribute list is laid out as Windows lays it, each kind once', ()=>{
    // Wine's kernel32 process.c test_ProcThreadAttributeList and
    // test_handle_list_attribute, which called the missing entry blind.
    const host = fakeHost();
    const fns = createSpawnFunctions(host);
    const LIST = 0x400;
    const SIZE = 0x100;
    const VALUE = 0x200;
    host.bytes.fill(0xcc, LIST, LIST + 0x100);
    host.view.setUint32(SIZE, 0, true);
    assert.equal(fns.InitializeProcThreadAttributeList.handler([0, 3, 0, SIZE]), 0);
    assert.equal(host.errors.at(-1), 122, 'ERROR_INSUFFICIENT_BUFFER');
    assert.equal(host.view.getUint32(SIZE, true), 20 + 3 * 12);
    assert.equal(fns.InitializeProcThreadAttributeList.handler([LIST, 3, 0, SIZE]), 1);
    const word = (/** @type {number} */ at)=>host.view.getUint32(LIST + at, true);
    assert.deepEqual([0, 4, 8, 12, 16].map(word), [0, 3, 0, 0xcccccccc, 0],
        'mask, room, count, an untouched pad, a zero word');

    const update = (/** @type {number} */ attribute, /** @type {number} */ size)=>
        fns.UpdateProcThreadAttribute.handler([LIST, 0, attribute, VALUE, size, 0, 0]);
    assert.equal(update(0xcafe, 4), 0);
    assert.equal(host.errors.at(-1), 50, 'ERROR_NOT_SUPPORTED');
    assert.equal(update(0x20000, 2), 0);
    assert.equal(host.errors.at(-1), 24, 'ERROR_BAD_LENGTH');
    assert.equal(update(0x20000, 4), 1, 'the parent process');
    assert.equal(update(0x20000, 4), 0);
    assert.equal(host.errors.at(-1), 5010, 'ERROR_OBJECT_NAME_EXISTS');
    assert.equal(update(0x20002, 15), 0, 'a handle list of part of a handle');
    assert.equal(update(0x20002, 16), 1);
    assert.equal(update(0x30003, 12), 1, 'group affinity');
    assert.equal(update(0x30005, 4), 0, 'no room left');
    assert.equal(host.errors.at(-1), 31, 'ERROR_GEN_FAILURE');
    assert.deepEqual([0, 8].map(word), [(1 << 0 | 1 << 2 | 1 << 3) >>> 0, 3]);
    assert.deepEqual([20, 24, 28, 32, 36, 40].map(word),
        [0x20000, 4, VALUE, 0x20002, 16, VALUE], 'each entry its number, size and value');
    assert.deepEqual([fns.InitializeProcThreadAttributeList.argBytes,
        fns.UpdateProcThreadAttribute.argBytes, fns.DeleteProcThreadAttributeList.argBytes],
    [16, 28, 4]);
});
