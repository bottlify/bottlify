/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the configured display reaches.
 *
 * The libraries that answer for a screen -- GetSystemMetrics in user32,
 * GetDeviceCaps in gdi32 -- each take one and each fall back to 640x480 when
 * they are not given one. Both fallbacks are correct and both were reached,
 * because nothing handed the module's own `screen` down to either: a caller
 * that configured a display got it in the drawing layer alone, and a program
 * asking the system how big the desktop is was told something the device it
 * then created did not match.
 *
 * These assert the wiring rather than the answer -- the answer already has
 * tests of its own next to each library -- so what they pin is that a screen
 * put into the module's configuration comes back out of both tables.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32Module } from './module.js';

/** SM_CXSCREEN and SM_CYSCREEN, the two a program sizes itself from. */
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

/** HORZRES, VERTRES and BITSPIXEL, as GetDeviceCaps indexes them. */
const HORZRES = 8;
const VERTRES = 10;
const BITSPIXEL = 12;

/** Deliberately none of the fallbacks, so a fallback cannot pass by accident. */
const SCREEN = { width: 1024, height: 768, bitsPerPixel: 16 };

/**
 * The least of a module graph this layer can be built over.
 *
 * Every entry is a thunk the tables close over rather than something they call
 * while being built, so answering nothing is enough for the two questions asked
 * here -- and an answer invented for one of them would be the test agreeing
 * with itself.
 *
 * @returns {import('../../system/contract.js').ScopedModuleHost}
 */
function stubHost(){
    // Handles that tell each other apart: a DC taken twice is two contexts, and
    // a table that hands out zero for both cannot show that.
    /** @type {Map<number, { type: string, object: any }>} */
    const opened = new Map();
    let nextHandle = 0x100;
    /** @type {Record<string, any>} */
    const apis = {
        memory: {
            readBytes: ()=>new Uint8Array(0),
            writeBytes: ()=>{},
            readCString: ()=>'',
            readWideString: ()=>'',
            readU32: ()=>0,
        },
        kernel: {
            handles: {
                /** @param {string} type @param {any} object */
                open: (type, object)=>{
                    const handle = nextHandle++;
                    opened.set(handle, { type, object });
                    return handle;
                },
                /** @param {number} handle */
                close: handle=>(opened.delete(handle) ? true : null),
                /** @param {number} handle */
                resolve: handle=>opened.get(handle)?.object ?? null,
                /** @param {number} handle */
                typeOf: handle=>opened.get(handle)?.type ?? null,
            },
            clock: { virtualTime: ()=>0 },
            currentThread: ()=>null,
            exitThread: ()=>{},
            setEvent: ()=>{},
            onTimeout: ()=>{},
        },
        bridge: {
            register: ()=>0,
            park: ()=>0,
            useHeap: ()=>{},
            publishInterface: ()=>0,
        },
        filesystem: {
            drives: ()=>[],
            stat: ()=>null,
        },
    };
    return /** @type {any} */ ({
        /** @param {string} name */
        requireApi: (/** @type {string} */ name)=>apis[name],
        provide: ()=>{},
    });
}

test('a configured screen reaches the libraries that answer for one', async()=>{
    const api = await win32Module.create({ screen: SCREEN }, stubHost());
    const user32 = api.libraries()['USER32.dll'];
    const gdi32 = api.libraries()['GDI32.dll'];

    assert.equal(user32.GetSystemMetrics.handler([SM_CXSCREEN]), SCREEN.width);
    assert.equal(user32.GetSystemMetrics.handler([SM_CYSCREEN]), SCREEN.height);

    // A display DC: GetDC(NULL) is the desktop, which is the surface these
    // metrics describe.
    const dc = gdi32.GetDC.handler([0]);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, HORZRES]), SCREEN.width);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, VERTRES]), SCREEN.height);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, BITSPIXEL]), SCREEN.bitsPerPixel);

    await win32Module.dispose();
});

test('WINMM\'s ordinal 2 is PlaySoundA, as winmm.spec numbers it', async()=>{
    // Exported by number and without a name on Windows; a program importing it
    // that way bound to timeBeginPeriod, which pops four bytes rather than
    // twelve.
    const api = await win32Module.create({ screen: SCREEN }, stubHost());
    assert.equal(api.ordinals()['WINMM.dll'][2], 'PlaySoundA');
    assert.equal(api.libraries()['WINMM.dll'].PlaySoundA.argBytes, 12);
    await win32Module.dispose();
});

test('dsetup is a library here, so an autorun that loads it by name finds DirectX', async()=>{
    // An autorun that cannot load it reads the installed DirectX as none and
    // refuses to install, whatever the registry says.
    const api = await win32Module.create({ screen: SCREEN }, stubHost());
    const dsetup = api.libraries()['DSETUP.dll'];
    assert.ok(dsetup, 'in the table of libraries the loader synthesises');
    assert.deepEqual(['DirectXSetupA', 'DirectXSetupGetVersion']
        .map(name=>dsetup[name]?.argBytes), [12, 8]);
    await win32Module.dispose();
});

test('a child runs beside a parent that has not exited, however the parent waits for it',
    async()=>{
        const api = await win32Module.create({ screen: SCREEN }, stubHost());
        assert.equal(api.childWaitedOn({ waiters: [{}] }), true, 'blocked on its handle');
        assert.equal(api.childWaitedOn({}), true, 'polling it, or idle in its message loop');
        assert.equal(api.childWaitedOn({ handsOver: true }), false,
            'blocked on a wait for all of a set the child cannot answer alone');
        await win32Module.dispose();
    });

test('a DC taken through user32 is one GDI answers for', async()=>{
    // A program asks the display about itself through its own window: GetDC
    // on the window, GetDeviceCaps on what came back. Both libraries live in
    // this module, so user32 hands out GDI's context under the window's name
    // rather than a null one whose caps read as zero.
    const api = await win32Module.create({ screen: SCREEN }, stubHost());
    const user32 = api.libraries()['USER32.dll'];
    const gdi32 = api.libraries()['GDI32.dll'];
    const hwnd = 0x40b4;

    const dc = user32.GetDC.handler([hwnd]);
    assert.notEqual(dc, 0, 'a window has a device context');
    assert.equal(gdi32.GetDeviceCaps.handler([dc, BITSPIXEL]), SCREEN.bitsPerPixel);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, HORZRES]), SCREEN.width);
    assert.equal(user32.ReleaseDC.handler([hwnd, dc]), 1);
    assert.equal(user32.ReleaseDC.handler([hwnd, dc]), 0, 'released once, gone');

    await win32Module.dispose();
});

test('unattended, a message box answers its default button', async()=>{
    /** @type {string[]} */
    const said = [];
    const api = await win32Module.create({
        unattended: true,
        divergence: (/** @type {string} */ name, /** @type {string} */ detail)=>
            said.push(`${name}: ${detail}`),
    }, stubHost());
    const user32 = api.libraries()['USER32.dll'];
    // MB_YESNO | MB_DEFBUTTON2: the second button, No.
    assert.equal(user32.MessageBoxA.handler([0, 0, 0, 0x4 | 0x100]), 7, 'IDNO');
    assert.equal(said.length, 1);
    assert.match(said[0], /^MessageBox: unattended: answered 7/);
    await win32Module.dispose();
});

test('unattended, a message box is put to the answerer, and its choice is the answer', async()=>{
    /** @type {any[]} */
    const asked = [];
    const api = await win32Module.create({
        unattended: true,
        answer: (/** @type {any} */ dialog)=>{
            asked.push(dialog);
            return 6;
        },
    }, stubHost());
    const user32 = api.libraries()['USER32.dll'];
    assert.equal(user32.MessageBoxA.handler([0, 0, 0, 0x4 | 0x100]), 6, 'IDYES, as chosen');
    assert.deepEqual(asked[0].buttons.map((/** @type {any} */ button)=>
        [button.id, button.default]), [[6, false], [7, true]]);
    assert.equal(asked[0].kind, 'messagebox');
    await win32Module.dispose();
});

test('no configured screen leaves both libraries on the same fallback', async()=>{
    const api = await win32Module.create({}, stubHost());
    const user32 = api.libraries()['USER32.dll'];
    const gdi32 = api.libraries()['GDI32.dll'];
    const dc = gdi32.GetDC.handler([0]);

    assert.equal(user32.GetSystemMetrics.handler([SM_CXSCREEN]), 640);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, HORZRES]), 640);

    await win32Module.dispose();
});

test('the C runtime family is cdecl and every other library is stdcall', async()=>{
    // What a stub for an export nobody wrote has to know before it may
    // return: the C runtime's caller cleans up, a Win32 library's callee
    // does. The list is by name, because the question is asked about
    // libraries this build does not have as much as the ones it does.
    const api = await win32Module.create({}, stubHost());

    for (const library of ['msvcrt.dll', 'MSVCRT.dll', 'msvcr71.dll', 'msvcr80d.dll',
        'msvcp60.dll', 'crtdll.dll', 'ucrtbase.dll'])
    {
        assert.equal(api.libraryConvention(library), 'cdecl', library);
    }
    for (const library of ['KERNEL32.dll', 'USER32.dll', 'ntdll.dll', 'OLEACC.dll',
        'msvcrtd.dll.bak', 'game.dll'])
    {
        assert.equal(api.libraryConvention(library), 'stdcall', library);
    }

    await win32Module.dispose();
});

test('the runtime\'s _sleep is Sleep, wired to kernel32', async()=>{
    // The runtime exports _sleep only once its thread seam can sleep; left
    // unwired it is an import bound to the missing-import stub, and a loop
    // that sleeps between polls spins.
    const api = await win32Module.create({}, stubHost());
    const sleep = api.libraries()['msvcrt.dll']._sleep;
    assert.ok(sleep, 'exported');
    assert.equal(sleep.convention, 'cdecl');
    assert.equal(sleep.argBytes, 4);

    await win32Module.dispose();
});

test('the KnownDLLs are the ones Windows never searches beside the program', async()=>{
    // The set decides which of our tables a program's own file may replace.
    // The system libraries are in it; every library a title is likely to have
    // brought -- the D3DX runtimes, Direct3D, DirectInput, common controls,
    // version -- is not, so a file of that name beside the program wins.
    const api = await win32Module.create({}, stubHost());
    const known = new Set(api.knownDlls()
        .map((/** @type {string} */ name)=>name.toLowerCase()));

    for (const library of ['KERNEL32.dll', 'USER32.dll', 'GDI32.dll', 'ADVAPI32.dll',
        'ole32.dll', 'OLEAUT32.dll', 'SHELL32.dll', 'COMDLG32.dll', 'RPCRT4.dll',
        'WS2_32.dll', 'SHLWAPI.dll', 'msvcrt.dll'])
    {
        assert.ok(known.has(library.toLowerCase()), library);
    }
    for (const library of ['d3dx9_26.dll', 'D3D9.dll', 'DDRAW.dll', 'DINPUT8.dll',
        'COMCTL32.dll', 'VERSION.dll', 'WINMM.dll', 'WSOCK32.dll'])
    {
        assert.ok(!known.has(library.toLowerCase()), library);
    }

    await win32Module.dispose();
});

test('the D3DX helpers are the redistributables, and Windows\' own libraries are not', async()=>{
    // A bottle carries what an installation put in system32 except the
    // libraries the engine synthesises as Windows' own; these are the ones a
    // setup installs, whose table is only the fallback.
    const api = await win32Module.create({}, stubHost());
    const redistributable = api.redistributables();
    assert.equal(redistributable.length, 20);
    assert.ok(redistributable.includes('d3dx9_24.dll') && redistributable.includes('d3dx9_43.dll'));
    for (const name of redistributable)
    {
        assert.ok(name in api.libraries(), `${name} has a table`);
    }
    assert.ok(!redistributable.some((/** @type {string} */ name)=>/^(kernel32|user32|d3d9)/i
        .test(name)));
    await win32Module.dispose();
});

test('shfolder is the shell folder call under the name a program linked against', async()=>{
    // The library Windows ships with exactly two exports, both forwarders.
    // A program that imported SHGetFolderPathA from it has to get shell32's
    // implementation, not a missing import and not a second copy.
    const api = await win32Module.create({}, stubHost());
    const libraries = /** @type {Record<string, any>} */ (api.libraries());

    assert.ok(libraries['SHFOLDER.dll'], 'shfolder.dll is a library this build has');
    assert.equal(libraries['SHFOLDER.dll'].SHGetFolderPathA,
        libraries['SHELL32.dll'].SHGetFolderPathA);
    assert.equal(libraries['SHFOLDER.dll'].SHGetFolderPathW,
        libraries['SHELL32.dll'].SHGetFolderPathW);

    await win32Module.dispose();
});

test('comctl32\'s _TrackMouseEvent is user32\'s TrackMouseEvent', async()=>{
    // comctl32 documents _TrackMouseEvent as calling TrackMouseEvent where the
    // system has one. A query shows it: user32 fills in what it tracks --
    // nothing -- where a request only accepted would leave the fields alone.
    const TME_QUERY = 0x40000000;
    const REQUEST = 0x100;
    const bytes = new Uint8Array(0x200);
    const view = new DataView(bytes.buffer);
    const host = stubHost();
    const memory = {
        readBytes: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        writeBytes: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        readCString: ()=>'',
        readWideString: ()=>'',
        readU32: (/** @type {number} */ at)=>view.getUint32(at, true),
    };
    const api = await win32Module.create({}, /** @type {any} */ ({
        ...host,
        requireApi: (/** @type {string} */ name)=>(name === 'memory'
            ? memory : host.requireApi(name)),
    }));
    [16, TME_QUERY, 0xdeadbeef, 0xdeadbeef].forEach((value, index)=>
        view.setUint32(REQUEST + index * 4, value, true));

    assert.equal(api.libraries()['COMCTL32.dll']._TrackMouseEvent.handler([REQUEST]), 1);
    assert.deepEqual([4, 8, 12].map(at=>view.getUint32(REQUEST + at, true)), [0, 0, 0]);

    await win32Module.dispose();
});

/**
 * The stub host over a guest memory that holds what is written to it, for the
 * calls that answer by filling a structure.
 */
function hostWithMemory(){
    const bytes = new Uint8Array(0x2000);
    const view = new DataView(bytes.buffer);
    const host = stubHost();
    /** @param {number} at @param {number} limit @param {number} unit */
    const text = (at, limit, unit)=>{
        let result = '';
        for (let index = 0; index < limit; index++)
        {
            const code = unit === 1 ? bytes[at + index] : view.getUint16(at + index * 2, true);
            if (code === 0)
            {
                break;
            }
            result += String.fromCharCode(code);
        }
        return result;
    };
    const memory = {
        readBytes: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        writeBytes: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        readCString: (/** @type {number} */ at, /** @type {number} */ limit)=>text(at, limit, 1),
        readWideString: (/** @type {number} */ at, /** @type {number} */ limit)=>
            text(at, limit, 2),
        readU32: (/** @type {number} */ at)=>view.getUint32(at, true),
    };
    return {
        bytes,
        view,
        /** @param {number} at @param {string} value */
        put: (at, value)=>{
            bytes.set([...value].map(character=>character.charCodeAt(0)).concat([0]), at);
            return at;
        },
        /** @param {number} at */
        text: at=>text(at, 260, 1),
        host: /** @type {any} */ ({
            ...host,
            requireApi: (/** @type {string} */ name)=>(name === 'memory'
                ? memory : host.requireApi(name)),
        }),
    };
}

test('the configured Windows is the one every library answers with', async()=>{
    // GetVersionEx, the registry, the environment, the shell's folders: a
    // program asks two of them and compares, so a setting that reached one
    // and not the others would be a machine that contradicts itself.
    const machine = hostWithMemory();
    /** @type {Record<string, number>} */
    const registers = {};
    const api = await win32Module.create({
        windows: 'win7',
        registers: {
            read: ()=>0,
            write: (/** @type {string} */ name, /** @type {number} */ value)=>{
                registers[name] = value;
            },
        },
    }, machine.host);
    const libraries = /** @type {Record<string, any>} */ (api.libraries());
    const kernel32 = libraries['KERNEL32.dll'];

    machine.view.setUint32(0x100, 156, true);
    assert.equal(kernel32.GetVersionExA.handler([0x100]), 1);
    assert.deepEqual([4, 8, 12].map(at=>machine.view.getUint32(0x100 + at, true)), [6, 1, 7601]);
    assert.equal(machine.text(0x100 + 20), 'Service Pack 1');

    const size = kernel32.GetEnvironmentVariableA.handler([machine.put(0x300, 'APPDATA'),
        0x400, 260]);
    assert.equal(machine.text(0x400), 'C:\\Users\\User\\AppData\\Roaming');
    assert.equal(size, 'C:\\Users\\User\\AppData\\Roaming'.length);

    const CSIDL_APPDATA = 0x1a;
    assert.equal(libraries['SHELL32.dll'].SHGetFolderPathA.handler([0, CSIDL_APPDATA, 0, 0,
        0x600]), 0);
    assert.equal(machine.text(0x600), 'C:\\Users\\User\\AppData\\Roaming');

    const hive = api.registry();
    const key = hive.open(/** @type {any} */ (hive.root(0x80000002)),
        'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion');
    const current = key && hive.getValue(key, 'CurrentVersion');
    assert.equal(current && String.fromCharCode(...current.data.subarray(0, 3)), '6.1');

    const winver = libraries['msvcrt.dll']._winver.data();
    assert.equal(new DataView(winver.buffer).getUint32(0, true), 0x0601,
        'the C runtime\'s own copy of the version');

    assert.ok(kernel32.VerSetConditionMask, 'the 64-bit answer has registers to go to');
    kernel32.VerSetConditionMask.handler([0, 0, 0x80, 1]);
    assert.equal(registers.edx, 0);

    await win32Module.dispose();
});

test('the C runtime\'s copy of the environment starts as the process\'s', async()=>{
    const machine = hostWithMemory();
    const api = await win32Module.create({ arena: { base: 0x1000, size: 0x1000 } }, machine.host);
    const libraries = /** @type {Record<string, any>} */ (api.libraries());
    const kernel32 = libraries['KERNEL32.dll'];
    const name = machine.put(0x300, 'APPDATA');
    kernel32.GetEnvironmentVariableA.handler([name, 0x400, 260]);
    const value = libraries['msvcrt.dll'].getenv.handler([name]);
    assert.ok(value >= 0x1000, 'on the heap');
    assert.equal(machine.text(value), machine.text(0x400));
    await win32Module.dispose();
});

test('a program Windows 10 knows nothing of is told 6.2, and the machine stays 10', async()=>{
    const machine = hostWithMemory();
    const api = await win32Module.create({
        windows: 'win10',
        compatibility: { supportedOS: [], imageVersion: { major: 4, minor: 0 } },
    }, machine.host);
    const libraries = /** @type {Record<string, any>} */ (api.libraries());

    machine.view.setUint32(0x100, 148, true);
    assert.equal(libraries['KERNEL32.dll'].GetVersionExA.handler([0x100]), 1);
    assert.deepEqual([4, 8, 12].map(at=>machine.view.getUint32(0x100 + at, true)),
        [6, 2, 9200]);

    const hive = api.registry();
    const key = hive.open(/** @type {any} */ (hive.root(0x80000002)),
        'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion');
    const major = key && hive.getValue(key, 'CurrentMajorVersionNumber');
    assert.deepEqual(major && [...major.data], [10, 0, 0, 0]);

    await win32Module.dispose();
});

test('a Windows that is not one of the four is refused when the layer is made', async()=>{
    await assert.rejects(win32Module.create({ windows: 'win98' }, stubHost()),
        /win2000, winxp, win7, win10/);
});

test('a DirectX that is not one of the three is refused when the layer is made', async()=>{
    await assert.rejects(win32Module.create({ directx: '6' }, stubHost()),
        /unknown DirectX "6": the choices are 7, 8, 9/);
});

test('the configured Windows\'s profile folders are made on the volume at start', async()=>{
    // The folders the registry and the environment name for this Windows, and
    // not the other layout's.
    /** @type {string[]} */
    const made = [];
    const host = stubHost();
    const filesystem = {
        drives: ()=>[],
        stat: ()=>null,
        createDirectory: (/** @type {string} */ path)=>{
            made.push(path);
        },
    };
    await win32Module.create({ windows: 'win7' }, /** @type {any} */ ({
        ...host,
        requireApi: (/** @type {string} */ name)=>(name === 'filesystem'
            ? filesystem : host.requireApi(name)),
    }));
    assert.ok(made.includes('C:\\Users\\User\\AppData\\Roaming'));
    assert.ok(made.includes('C:\\ProgramData'));
    assert.ok(!made.some(path=>path.startsWith('C:\\Documents and Settings')));
    await win32Module.dispose();
});
