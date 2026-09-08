/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpawnFunctions } from './spawn.js';
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
 */
function fakeHost({ files = [], imagePath = 'C:\\App\\launcher.exe' } = {}){
    const bytes = new Uint8Array(0x2000);
    /** @type {number[]} */
    const errors = [];
    /** @type {any[]} */
    const requests = [];
    /** @type {Map<number, { type: string, object: any }>} */
    const handles = new Map();
    let nextHandle = 0x40;
    const present = new Set(files.map(path=>path.toLowerCase()));

    return {
        bytes,
        errors,
        requests,
        handles,
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
        stat: path=>(present.has(path.toLowerCase())
            ? { exists: true, isDirectory: false }
            : null),
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
