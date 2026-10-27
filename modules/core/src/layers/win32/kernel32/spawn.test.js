/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createSpawner, createSpawnFunctions, isRedistributableInstaller, writeThroughProtection,
} from './spawn.js';
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

test('CreateProcess refuses a malformed name before it looks for a file', ()=>{
    // Wine's kernel32 test_CommandLine: what Windows answers to each spelling.
    const ERROR_PATH_NOT_FOUND = 3;
    const ERROR_INVALID_PARAMETER = 87;
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);
    /** @param {number} application @param {string} line */
    const refusal = (application, line)=>{
        assert.equal(fns.CreateProcessA.handler(
            [application, putAnsi(host, 0x200, line), 0, 0, 0, 0, 0, 0, 0, 0]), 0, line);
        return host.errors.at(-1);
    };

    assert.equal(refusal(putAnsi(host, 0x100, ''), 'child.exe'), ERROR_PATH_NOT_FOUND,
        'an empty application name, as against none');
    assert.equal(refusal(putAnsi(host, 0x100, ''), ''), ERROR_PATH_NOT_FOUND);
    for (const line of ['', ' ', ' child.exe', '\tchild.exe', '""', '" "'])
    {
        assert.equal(refusal(0, line), ERROR_INVALID_PARAMETER, JSON.stringify(line));
    }
    // Blanks inside the quotes but before the name are part of it.
    for (const line of ['"\t"', '" child.exe"', '"\tchild.exe"', '"child\t"'])
    {
        assert.equal(refusal(0, line), ERROR_FILE_NOT_FOUND, JSON.stringify(line));
    }
    assert.equal(host.kernel.processes.all().length, 0, 'and none of them started anything');

    // A refusal, and a file not there, leave nothing in PROCESS_INFORMATION.
    for (const line of [' child.exe', 'missing.exe'])
    {
        host.bytes.fill(0x0a, 0x300, 0x310);
        assert.equal(fns.CreateProcessA.handler(
            [0, putAnsi(host, 0x200, line), 0, 0, 0, 0, 0, 0, 0, 0x300]), 0);
        assert.deepEqual([...host.bytes.subarray(0x300, 0x310)], new Array(16).fill(0), line);
    }

    // Trailing spaces inside the quotes are not, and .exe is still added.
    assert.equal(fns.CreateProcessA.handler(
        [0, putAnsi(host, 0x200, '"child " /s'), 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    assert.equal(pending(host).imagePath, 'C:\\App\\child.exe');
});

test('QueryFullProcessImageName answers this process\'s image and a child\'s', ()=>{
    // Wine's kernel32 test_QueryFullProcessImageNameA/W.
    const ERROR_INVALID_PARAMETER = 87;
    const ERROR_INSUFFICIENT_BUFFER = 122;
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = /** @type {Record<string, any>} */ (createSpawnFunctions(host));
    const view = new DataView(host.bytes.buffer);
    const own = 'C:\\App\\launcher.exe';
    /** @param {string} name @param {number[]} args @param {number} room */
    const ask = (name, args, room)=>{
        view.setUint32(0x300, room, true);
        return fns[name].handler([...args.slice(0, 2), args[2], 0x300]);
    };
    const ansi = ()=>new TextDecoder().decode(host.bytes.subarray(0x400,
        host.bytes.indexOf(0, 0x400)));

    assert.equal(ask('QueryFullProcessImageNameA', [CURRENT_PROCESS, 0, 0x400], 260), 1);
    assert.equal(ansi(), own);
    assert.equal(view.getUint32(0x300, true), own.length, 'the length without the terminator');

    assert.equal(ask('QueryFullProcessImageNameW', [CURRENT_PROCESS, 0, 0x600], 260), 1);
    let wide = '';
    for (let at = 0x600; view.getUint16(at, true) !== 0; at += 2)
    {
        wide += String.fromCharCode(view.getUint16(at, true));
    }
    assert.equal(wide, own);

    host.bytes.fill(0x41, 0x400, 0x410);
    host.bytes[0x410] = 0;
    assert.equal(ask('QueryFullProcessImageNameA', [CURRENT_PROCESS, 0, 0x400], own.length), 0,
        'no room for the terminator');
    assert.equal(host.errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(view.getUint32(0x300, true), own.length, 'the size left as it was');
    assert.equal(ansi(), 'A'.repeat(16), 'and the buffer');
    assert.equal(ask('QueryFullProcessImageNameW', [CURRENT_PROCESS, 0, 0], 0), 0);
    assert.equal(host.errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(ask('QueryFullProcessImageNameA', [CURRENT_PROCESS, 0, 0], 1024), 0);
    assert.equal(host.errors.at(-1), ERROR_INVALID_PARAMETER, 'room, and nowhere to put it');
    assert.equal(ask('QueryFullProcessImageNameW', [CURRENT_PROCESS, 2, 0x600], 260), 0);
    assert.equal(host.errors.at(-1), ERROR_INVALID_PARAMETER, 'a flag that is not one');
    assert.equal(ask('QueryFullProcessImageNameA', [0x999, 0, 0x400], 260), 0);
    assert.equal(host.errors.at(-1), ERROR_INVALID_HANDLE);

    fns.CreateProcessA.handler([putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0x200]);
    const child = view.getUint32(0x200, true);
    assert.equal(ask('QueryFullProcessImageNameA', [child, 0, 0x400], 260), 1);
    assert.equal(ansi(), 'C:\\App\\child.exe');
    assert.equal(fns.QueryFullProcessImageNameW.argBytes, 16);
});

test('PROCESS_NAME_NATIVE names the image by its volume\'s device, as the drives say', ()=>{
    // Wine's kernel32 test_QueryFullProcessImageNameA/W, with the native flag.
    const host = /** @type {any} */ (fakeHost());
    /** @type {string[]} */
    const asked = [];
    host.nativePath = (/** @type {string} */ path)=>{
        asked.push(path);
        return `\\Device\\HarddiskVolume1${path.slice(2)}`;
    };
    const fns = /** @type {Record<string, any>} */ (createSpawnFunctions(host));
    const view = new DataView(host.bytes.buffer);
    view.setUint32(0x300, 260, true);
    assert.equal(fns.QueryFullProcessImageNameA.handler([CURRENT_PROCESS, 1, 0x400, 0x300]), 1);
    const native = '\\Device\\HarddiskVolume1\\App\\launcher.exe';
    assert.equal(new TextDecoder().decode(host.bytes.subarray(0x400, 0x400 + native.length)),
        native);
    assert.equal(view.getUint32(0x300, true), native.length);
    assert.deepEqual(asked, ['C:\\App\\launcher.exe']);

    // A path no drive holds has no native name.
    host.nativePath = ()=>null;
    view.setUint32(0x300, 260, true);
    assert.equal(fns.QueryFullProcessImageNameA.handler([CURRENT_PROCESS, 1, 0x400, 0x300]), 0);
    assert.equal(host.errors.at(-1), 50);
});

test('the child is handed the STARTUPINFO its parent gave, a NULL desktop the parent\'s', ()=>{
    // Wine's kernel32 test_Startup reads it back in the child.
    const host = /** @type {any} */ (fakeHost({ files: ['C:\\App\\child.exe'] }));
    host.startup = ()=>({ desktop: 'winsta0\\default' });
    const fns = createSpawnFunctions(host);
    const view = new DataView(host.bytes.buffer);
    view.setUint32(0x400, 68, true);
    view.setUint32(0x400 + 12, putAnsi(host, 0x500, 'I\'m the title string'), true);
    view.setUint32(0x400 + 16, 0x34343434, true);
    view.setUint32(0x400 + 44, 1, true);
    view.setUint16(0x400 + 48, 1, true);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0x400, 0]), 1);
    const { startup } = host.kernel.processes.all()[0];
    assert.equal(startup.title, 'I\'m the title string');
    assert.equal(startup.desktop, 'winsta0\\default', 'none named: the parent\'s own');
    assert.equal(startup.x, 0x34343434);
    assert.equal(startup.flags, 1);
    assert.equal(startup.showWindow, 1);
    assert.equal(host.kernel.processes.all()[0].parentId, host.processId ?? 0,
        'and the process that started it');

    view.setUint32(0x400 + 12, putWide(host, 0x600, 'wide'), true);
    assert.equal(fns.CreateProcessW.handler(
        [putWide(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0x400, 0]), 1);
    assert.equal(host.kernel.processes.all()[1].startup.title, 'wide', 'read in the call\'s width');
    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    assert.equal(host.kernel.processes.all()[2].startup, null, 'no STARTUPINFO, nothing handed');
});

test('the child\'s environment is the block its parent handed, or the parent\'s own', ()=>{
    // Wine's kernel32 test_Environment.
    const host = /** @type {any} */ (fakeHost({ files: ['C:\\App\\child.exe'] }));
    host.environment = ()=>({ PATH: 'C:\\WINDOWS', FOO: 'set by the parent' });
    const fns = createSpawnFunctions(host);
    const block = '=C:=C:\\FOO\\BAR\0PATH=C:\\MY\\OWN\\DIR\0FOO=BAR\0EMPTY=\0\0';
    putAnsi(host, 0x700, block.slice(0, -1));
    const childOf = (/** @type {number} */ at)=>host.kernel.processes.all()[at].environment;

    fns.CreateProcessA.handler([putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0x700, 0, 0, 0]);
    assert.deepEqual(childOf(0), { '=C:': 'C:\\FOO\\BAR', PATH: 'C:\\MY\\OWN\\DIR', FOO: 'BAR',
        EMPTY: '' }, 'the per-drive directory\'s name begins with its \'=\'');

    // CreateProcessW reads an ANSI block unless told the block is wide.
    fns.CreateProcessW.handler([putWide(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0x700, 0, 0, 0]);
    assert.equal(childOf(1).FOO, 'BAR');
    putWide(host, 0x900, 'FOO=wide');
    host.bytes[0x900 + 18] = 0;
    host.bytes[0x900 + 19] = 0;
    fns.CreateProcessW.handler([putWide(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0x400, 0x900, 0, 0,
        0]);
    assert.deepEqual(childOf(2), { FOO: 'wide' }, 'CREATE_UNICODE_ENVIRONMENT');

    fns.CreateProcessA.handler([putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(childOf(3).FOO, 'set by the parent', 'no block: the parent\'s variables now');
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
    assert.equal(host.kernel.handles.resolve(child.threadHandle, 'process-thread').process, child,
        'the child\'s first thread');
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

test('CREATE_SUSPENDED records the child for the run to start, its first thread held', ()=>{
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, CREATE_SUSPENDED, 0, 0, 0, 0x300]), 1);
    assert.equal(host.kernel.processes.pending(), host.kernel.processes.all()[0]);
    assert.equal(host.kernel.processes.all()[0].suspended, true);
});

test('the wide spelling starts the same child as the narrow one', ()=>{
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);

    assert.equal(fns.CreateProcessW.handler(
        [putWide(host, 0x100, 'child.exe'), 0, 0, 0, 0, 0, 0, 0, 0, 0]), 1);
    assert.equal(pending(host).imagePath, 'C:\\App\\child.exe');
});

/**
 * A host whose calls into a child are answered by `answer`, each one kept.
 *
 * @param {(call: any) => any} answer
 */
function askingHost(answer){
    const host = /** @type {any} */ (fakeHost({ files: ['C:\\App\\child.exe'] }));
    /** @type {any[]} */
    const asked = [];
    const caller = { name: 'caller' };
    /** @type {[any, number][]} */
    const errorsFor = [];
    Object.assign(host, {
        askChild: (/** @type {any} */ record, /** @type {any} */ call)=>{
            asked.push({ record, call });
            return Promise.resolve(answer(call));
        },
        currentThread: ()=>caller,
        setLastErrorFor: (/** @type {any} */ thread, /** @type {number} */ code)=>
            errorsFor.push([thread, code]),
    });
    return { host, asked, caller, errorsFor };
}

test('a write into a child is made in the child, and its answer comes back to the caller',
    async()=>{
        // A launcher hollowing its child: the bytes cross, the call is the
        // child's own WriteProcessMemory on itself, through its protection.
        const { host, asked, caller, errorsFor } = askingHost(()=>({ result: 1, error: 0,
            outs: [null, null, null, null, new Uint8Array([3, 0, 0, 0])] }));
        const fns = createSpawnFunctions(host);
        fns.CreateProcessA.handler(
            [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, CREATE_SUSPENDED, 0, 0, 0, 0x300]);
        const child = host.kernel.processes.all()[0];

        host.bytes.set([0x90, 0xcc, 0x90], 0x400);
        const written = fns.WriteProcessMemory.handler([child.handle, 0x401000, 0x400, 3, 0x500]);
        // Copied when asked, not viewed: the caller may write its buffer again.
        host.bytes[0x400] = 0xff;
        assert.equal(await written, 1);
        assert.equal(asked[0].record, child);
        assert.deepEqual(asked[0].call.call, 'WriteProcessMemory');
        const [process, base, data, size, out] = asked[0].call.args;
        assert.deepEqual([process, base, [...data.in], size, out],
            [CURRENT_PROCESS, 0x401000, [0x90, 0xcc, 0x90], 3, { out: 4 }]);
        assert.equal(host.view.getUint32(0x500, true), 3, 'the count the child wrote');
        assert.deepEqual(errorsFor, [[caller, 0]], 'the error set on the thread that asked');
    });

test('a child the run cannot reach is refused, and a handle that is none is invalid', ()=>{
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const fns = createSpawnFunctions(host);
    fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, CREATE_SUSPENDED, 0, 0, 0, 0x300]);
    const child = host.kernel.processes.all()[0];
    assert.equal(fns.WriteProcessMemory.handler([child.handle, 0x401000, 0x400, 3, 0]), 0);
    assert.equal(host.errors.at(-1), 5, 'ERROR_ACCESS_DENIED');
    assert.equal(fns.ReadProcessMemory.handler([0x1234, 0x400, 0x800, 2, 0]), 0);
    assert.equal(host.errors.at(-1), ERROR_INVALID_HANDLE);
});

test('a write against this process writes memory, as it always did', ()=>{
    const host = fakeHost();
    const fns = createSpawnFunctions(host);
    host.bytes.set([1, 2, 3, 4], 0x400);

    assert.equal(fns.WriteProcessMemory.handler(
        [CURRENT_PROCESS, 0x600, 0x400, 4, 0]), 1);
    assert.deepEqual([...host.bytes.slice(0x600, 0x604)], [1, 2, 3, 4]);
});

test('a write into this process goes through code that only executes, and puts it back', ()=>{
    // A heap library replacing the C runtime's malloc writes a jump over its
    // first bytes, which lie in a region that is read and execute only;
    // Windows lifts the protection for the write. Nowhere mapped is refused.
    const bytes = new Uint8Array(0x100);
    /** @type {{ name: string, base: number, size: number, access: string }[]} */
    const regions = [{ name: 'msvcrt.dll', base: 0x40, size: 0x40, access: 'rx' },
        { name: 'data', base: 0x80, size: 0x40, access: 'rw' }];
    /** @type {string[]} */
    const changes = [];
    const memory = {
        find: (/** @type {number} */ address)=>regions.find(region=>address >= region.base
            && address < region.base + region.size),
        protect: (/** @type {string} */ name, /** @type {string} */ access)=>{
            changes.push(`${name} ${access}`);
            Object.assign(/** @type {any} */ (regions.find(region=>region.name === name)), { access });
        },
        writeBytes: (/** @type {number} */ address, /** @type {Uint8Array} */ data)=>{
            assert.ok(memory.find(address)?.access.includes('w'), 'written only while writable');
            bytes.set(data, address);
        },
    };
    assert.equal(writeThroughProtection(memory, 0x50, Uint8Array.of(0xe9, 1, 2, 3, 4)), true);
    assert.deepEqual([...bytes.subarray(0x50, 0x55)], [0xe9, 1, 2, 3, 4]);
    assert.deepEqual(changes, ['msvcrt.dll rwx', 'msvcrt.dll rx'], 'lifted, then put back');
    assert.equal(writeThroughProtection(memory, 0x90, Uint8Array.of(7)), true);
    assert.equal(changes.length, 2, 'a writable page is written as it is');
    assert.equal(writeThroughProtection(memory, 0x10, Uint8Array.of(7)), false, 'nothing there');
    assert.equal(writeThroughProtection(memory, 0x7e, Uint8Array.of(1, 2, 3, 4)), false,
        'running out of the region');

    const host = fakeHost();
    /** @type {any} */ (host).patchMemory = (/** @type {number} */ address)=>address === 0x600;
    const fns = createSpawnFunctions(host);
    assert.equal(fns.WriteProcessMemory.handler([CURRENT_PROCESS, 0x600, 0x400, 4, 0]), 1);
    assert.equal(fns.WriteProcessMemory.handler([CURRENT_PROCESS, 0x900, 0x400, 4, 0]), 0);
    assert.equal(host.errors.at(-1), 998, 'ERROR_NOACCESS');
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
    assert.equal(host.kernel.handles.resolve(made.threadHandle, 'process-thread').process, made);
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

test('ReadProcessMemory reads this process, and a child\'s memory in the child', async()=>{
    const { host, asked } = askingHost(call=>({ result: 1, error: 0, outs: [null, null,
        new Uint8Array([0x22, 0x33]).subarray(0, call.args[2].out), null,
        new Uint8Array([2, 0, 0, 0])] }));
    const fns = createSpawnFunctions(host);
    host.bytes.set([5, 6, 7, 8], 0x400);
    assert.equal(fns.ReadProcessMemory.handler([CURRENT_PROCESS, 0x400, 0x600, 4, 0x700]), 1);
    assert.deepEqual([...host.bytes.slice(0x600, 0x604)], [5, 6, 7, 8]);
    assert.equal(host.view.getUint32(0x700, true), 4);

    fns.CreateProcessA.handler(
        [putAnsi(host, 0x100, 'child.exe'), 0, 0, 0, 0, CREATE_SUSPENDED, 0, 0, 0, 0x300]);
    const child = host.kernel.processes.all()[0];
    assert.equal(await fns.ReadProcessMemory.handler([child.handle, 0x401001, 0x800, 2, 0x700]),
        1);
    assert.deepEqual(asked[0].call.args, [CURRENT_PROCESS, 0x401001, { out: 2 }, 2, { out: 4 }]);
    assert.deepEqual([...host.bytes.slice(0x800, 0x802)], [0x22, 0x33]);
    assert.equal(host.view.getUint32(0x700, true), 2);
    assert.equal(fns.ReadProcessMemory.argBytes, 20);
});

test('ReadProcessMemory of this process where nothing is mapped is ERROR_PARTIAL_COPY', ()=>{
    // A crash handler walks the stack through it wherever a frame pointer
    // leads; the read faulted the engine instead of answering FALSE.
    const host = fakeHost({ files: [] });
    const read = host.readMemory;
    host.readMemory = (/** @type {number} */ address, /** @type {number} */ length)=>{
        if (address >= 0x900)
        {
            throw new Error(`Unmapped read at 0x${address.toString(16)}`);
        }
        return read(address, length);
    };
    const fns = createSpawnFunctions(host);
    host.view.setUint32(0x700, 0xaaaaaaaa, true);
    assert.equal(fns.ReadProcessMemory.handler([CURRENT_PROCESS, 0x971, 0x600, 4, 0x700]), 0);
    assert.equal(host.view.getUint32(0x700, true), 0, 'nothing read');
    assert.equal(host.errors.at(-1), 299);
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

test('a system program is found by bare name, in any case, with no file for it', ()=>{
    // `msiexec /i setup.msi`, `MsiExec.exe /X{...}`, `RunDll32 x,y`: the name
    // an installer writes, found in the system folder as CreateProcess looks
    // there after the program's own directory and the current one.
    const host = fakeHost({ cwd: 'C:\\App\\' });
    const spawner = createSpawner({ ...host, currentDirectory: ()=>'C:\\App' });
    assert.equal(spawner.imageOf('msiexec'), 'C:\\WINDOWS\\system32\\msiexec.exe');
    assert.equal(spawner.imageOf('RunDll32.EXE x,y'), 'C:\\WINDOWS\\system32\\RunDll32.EXE');
    assert.equal(spawner.imageOf('C:\\Windows\\System32\\regsvr32.exe /s a.dll'),
        'C:\\Windows\\System32\\regsvr32.exe', 'a full path, spelled as the caller spelled it');
    assert.equal(spawner.imageOf('C:\\App\\msiexec.exe'), null,
        'only in the system folder: anywhere else it is a file that is not there');
    assert.equal(spawner.imageOf('calc.exe'), null, 'and only the programs the engine has');
    assert.equal(spawner.imageOf('C:\\WINDOWS\\Notepad.exe readme.txt'),
        'C:\\WINDOWS\\Notepad.exe', 'Notepad in the Windows directory as well');

    const made = spawner.launch('', 'msiexec /i setup.msi /qn', 0);
    assert.equal(made.imagePath, 'C:\\WINDOWS\\system32\\msiexec.exe');
    assert.equal(made.commandLine, 'msiexec /i setup.msi /qn', 'its line as the caller gave it');
    assert.equal(made.startDirectory, 'C:\\App',
        'it starts in its parent\'s current directory, where `setup.msi` is');
    assert.equal(pending(host), made, 'a process like any other, waiting to run');
});

test('a file the volume has wins over the program the engine provides, and starts as any child',
    ()=>{
        const host = fakeHost({ files: ['C:\\WINDOWS\\system32\\msiexec.exe',
            'C:\\WINDOWS\\system32\\tool.exe'] });
        const spawner = createSpawner({ ...host, currentDirectory: ()=>'C:\\App' });
        const made = spawner.launch('', 'msiexec /i x.msi', 0);
        assert.equal(made.imagePath, 'C:\\WINDOWS\\system32\\msiexec.exe');
        assert.equal(made.startDirectory, undefined, 'its own directory, as for any child');
        assert.equal(spawner.imageOf('tool'), 'C:\\WINDOWS\\system32\\tool.exe',
            'and any bare name is looked for in the system folder too');
        assert.equal(spawner.imageOf('sub\\tool.exe'), null,
            'but a name with a directory in it is not searched for');
    });

test('CreateProcess\'s current directory is where a system program starts', ()=>{
    const host = fakeHost({ cwd: 'C:\\App\\' });
    const fns = createSpawnFunctions({ ...host, currentDirectory: ()=>'C:\\App' });
    const line = putAnsi(host, 0x100, 'regsvr32 /s x.dll');
    const directory = putAnsi(host, 0x200, 'C:\\Libraries');
    assert.equal(fns.CreateProcessA.handler([0, line, 0, 0, 0, 0, 0, directory, 0, 0x300]), 1);
    assert.equal(pending(host).startDirectory, 'C:\\Libraries');
    const wide = putWide(host, 0x400, 'rundll32 x.dll,Entry');
    const there = putWide(host, 0x600, 'Other');
    assert.equal(fns.CreateProcessW.handler([0, wide, 0, 0, 0, 0, 0, there, 0, 0x300]), 1);
    assert.equal(/** @type {any} */ (host.kernel.processes.all()[1]).startDirectory,
        'C:\\App\\Other',
        'a relative one taken against the parent\'s');
});

test('an unquoted image name with a space reaches the child quoted, as CreateProcess quotes it',
    ()=>{
        const host = fakeHost({ files: ['C:\\Program Files\\Game\\game.exe'] });
        const spawner = createSpawner(host);

        // The child's runtime ends argv[0] at the first unquoted space, so the
        // caller's spelling would give WinMain `Files\Game\game.exe` as its
        // lpCmdLine.
        const bare = spawner.launch('', 'C:\\Program Files\\Game\\game.exe', 0);
        assert.equal(bare.imagePath, 'C:\\Program Files\\Game\\game.exe');
        assert.equal(bare.commandLine, '"C:\\Program Files\\Game\\game.exe"');

        const withArguments = spawner.launch('', 'C:\\Program Files\\Game\\game.exe -w  x', 0);
        assert.equal(withArguments.commandLine, '"C:\\Program Files\\Game\\game.exe" -w  x',
            'the arguments as the caller spaced them');

        const quoted = spawner.launch('', '"C:\\Program Files\\Game\\game.exe" -w', 0);
        assert.equal(quoted.commandLine, '"C:\\Program Files\\Game\\game.exe" -w',
            'a line already quoted is left alone');

        const named = spawner.launch('C:\\Program Files\\Game\\game.exe',
            'C:\\Program Files\\Game\\game.exe', 0);
        assert.equal(named.commandLine, 'C:\\Program Files\\Game\\game.exe',
            'with an application name the line is the caller\'s, verbatim');

        assert.equal(spawner.imageOf('C:\\Program Files\\Game\\game.exe -w'),
            'C:\\Program Files\\Game\\game.exe');
    });

test('an unquoted image name without a space keeps the caller\'s line', ()=>{
    const host = fakeHost({ files: ['C:\\App\\child.exe'] });
    const made = createSpawner(host).launch('', 'C:\\App\\child.exe /s', 0);
    assert.equal(made.commandLine, 'C:\\App\\child.exe /s');
});
