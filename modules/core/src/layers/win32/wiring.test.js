/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the module hands the system libraries it assembles.
 *
 * Several libraries take a capability from the module rather than build it
 * themselves -- a wide-string reader, the heap, whether a library is one the
 * engine answers for -- and each has tests of its
 * own with a fake in its place. What those cannot show is that the module
 * passes the real one; these build the module and ask through it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32Module } from './module.js';
import { filesystemModule } from '../filesystem/module.js';
import { certificates, NOW, signedCabinet } from './wintrust/fixtures.test.js';

const ARENA = { base: 0x100000, size: 0x200000 };

/**
 * The least of a module graph this layer can be built over, on real bytes.
 *
 * @param {Record<string, any>} [replace]  Whole APIs, or kernel entries, to use
 *   in place of the stand-ins.
 */
function hostOver(replace = {}){
    const bytes = new Uint8Array(0x400000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, { type: string, object: any }>} */
    const opened = new Map();
    let nextHandle = 0x100;
    /** @type {Record<string, any>} */
    const apis = {
        memory: {
            /** @param {number} at @param {number} length */
            readBytes: (at, length)=>bytes.slice(at, at + length),
            /** @param {number} at @param {Uint8Array} data */
            writeBytes: (at, data)=>bytes.set(data, at),
            /** @param {number} at @param {number} value @param {number} length */
            fillBytes: (at, value, length)=>bytes.fill(value, at, at + length),
            /** @param {number} at @param {number} max */
            readCString(at, max){
                let text = '';
                for (let i = at; i < at + max && bytes[i] !== 0; i++)
                {
                    text += String.fromCharCode(bytes[i]);
                }
                return text;
            },
            /** @param {number} at @param {number} max */
            readWideString(at, max){
                let text = '';
                for (let i = at; i < at + max * 2 && view.getUint16(i, true) !== 0; i += 2)
                {
                    text += String.fromCharCode(view.getUint16(i, true));
                }
                return text;
            },
            /** @param {number} at */
            readU32: at=>view.getUint32(at, true),
            find: ()=>null,
            scanCString: ()=>({ index: 0, byte: 0 }),
        },
        kernel: {
            handles: {
                /** @param {string} type @param {any} object */
                open(type, object){
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
            callGuest: ()=>Promise.resolve(0),
            callerThread: ()=>null,
            label: ()=>{},
        },
        filesystem: replace.filesystem ?? { drives: ()=>[], stat: ()=>null },
    };
    Object.assign(apis.kernel, replace.kernel ?? {});
    Object.assign(apis.bridge, replace.bridge ?? {});
    const host = /** @type {any} */ ({
        /** @param {string} name */
        requireApi: name=>apis[name],
        provide: ()=>{},
    });
    return { bytes, view, host };
}

/** @param {Record<string, any>} [replace] */
async function build(replace){
    const { bytes, view, host } = hostOver(replace);
    const api = /** @type {any} */ (await win32Module.create(/** @type {any} */ ({
        arena: ARENA,
        modules: {
            find: ()=>null,
            byBase: ()=>null,
            imagePath: ()=>'C:\\app.exe',
            versionInfo: ()=>null,
            /** @param {string} name */
            systemLibrary: name=>name.toLowerCase() === 'kernel32.dll',
            ...replace?.modules,
        },
        registers: replace?.registers,
        trustedRoots: replace?.trustedRoots,
    }), host));
    return {
        bytes, view, libraries: api.libraries(), lastError: ()=>api.lastError(),
        exitCode: ()=>api.exitCode(),
    };
}

test('SHLWAPI\'s wide spellings read wide strings', async()=>{
    const { view, libraries } = await build();
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        [...text, '\0'].forEach((ch, i)=>view.setUint16(at + i * 2, ch.charCodeAt(0), true));
        return at;
    };
    const out = 0x3000;
    assert.equal(libraries['SHLWAPI.dll'].PathCombineW.handler(
        [out, wide(0x1000, 'C:\\Games'), wide(0x2000, 'save.dat')]), out);
    let text = '';
    for (let at = out; view.getUint16(at, true) !== 0; at += 2)
    {
        text += String.fromCharCode(view.getUint16(at, true));
    }
    assert.equal(text, 'C:\\Games\\save.dat');
    await win32Module.dispose();
});

test('DirectX 8.1\'s NAT helper is one of the machine\'s libraries, so it loads', async()=>{
    // The version check the DirectX SDK's samples taught takes a d3d8.dll
    // with dpnhpast.dll beside it for DirectX 8.1 and d3d8.dll alone for 8.0.
    const { libraries } = await build();
    assert.equal(typeof libraries['DPNHPAST.dll']?.DllGetClassObject?.handler, 'function');
    await win32Module.dispose();
});

test('ADVPACK answers IsNTAdmin from the same token the advapi32 calls read', async()=>{
    const { libraries } = await build();
    assert.equal(libraries['ADVPACK.dll'].IsNTAdmin.handler(), 1);
    await win32Module.dispose();
});

test('VERSION knows which libraries the engine answers for', async()=>{
    const { bytes, libraries } = await build();
    bytes.set([...'kernel32.dll\0'].map(ch=>ch.charCodeAt(0)), 0x4000);
    assert.ok(libraries['VERSION.dll'].GetFileVersionInfoSizeA.handler([0x4000, 0]) > 0);
    await win32Module.dispose();
});

test('a library another layer answers for stands in the system folder too', async()=>{
    // A setup that looks for DDRAW.DLL in the system folder before reading
    // its version found nothing -- only this layer's own libraries stood
    // there -- and said no DirectX was installed.
    const { bytes, libraries } = await build({ modules: {
        systemLibraries: ()=>['KERNEL32.dll', 'DDRAW.dll'] } });
    bytes.set([...'C:\\WINDOWS\\system32\\ddraw.dll\0'].map(ch=>ch.charCodeAt(0)), 0x4000);
    assert.notEqual(libraries['KERNEL32.dll'].GetFileAttributesA.handler([0x4000]), 0xffffffff);
    await win32Module.dispose();
});

test('an mmio buffer comes from the program\'s heap', async()=>{
    // mmioGetInfo hands the buffer's pointers to the program, so the buffer
    // mmio allocates has to be guest memory.
    const MMIO_ALLOCBUF = 0x10000;
    const FOURCC_MEM = 0x204d454d;
    const { view, libraries } = await build();
    const info = 0x5000;
    view.setUint32(info + 4, FOURCC_MEM, true);
    view.setUint32(info + 20, 256, true);
    const handle = libraries['WINMM.dll'].mmioOpenA.handler([0, info, 0]);
    assert.notEqual(handle, 0);
    const got = 0x5100;
    assert.equal(libraries['WINMM.dll'].mmioGetInfo.handler([handle, got, 0]), 0);
    assert.equal(view.getUint32(got, true) & MMIO_ALLOCBUF, MMIO_ALLOCBUF);
    const buffer = view.getUint32(got + 24, true);
    assert.ok(buffer >= ARENA.base && buffer < ARENA.base + ARENA.size,
        `the buffer is in the arena: 0x${buffer.toString(16)}`);
    assert.equal(libraries['WINMM.dll'].mmioClose.handler([handle, 0]), 0);
    await win32Module.dispose();
});

test('the synchronisation calls leave their failures as the thread\'s last error', async()=>{
    // A suspend the kernel refuses (the count is at its maximum) and a one-time
    // initialisation begun with flags that cannot go together each answer
    // failure; GetLastError then has to say why.
    const ERROR_SIGNAL_REFUSED = 156;
    const ERROR_INVALID_PARAMETER = 87;
    const thread = { id: 1 };
    const { libraries, lastError } = await build({
        kernel: { currentThread: ()=>thread, suspendThread: ()=>null },
    });
    const kernel32 = libraries['KERNEL32.dll'];
    const CURRENT_THREAD = 0xfffffffe;

    assert.equal(kernel32.SuspendThread.handler([CURRENT_THREAD]), 0xffffffff);
    assert.equal(lastError(), ERROR_SIGNAL_REFUSED);

    const INIT_ONCE_CHECK_ONLY_ASYNC = 3;
    assert.equal(kernel32.InitOnceBeginInitialize.handler(
        [0x6000, INIT_ONCE_CHECK_ONLY_ASYNC, 0x6004, 0x6008]), 0);
    assert.equal(lastError(), ERROR_INVALID_PARAMETER);
    await win32Module.dispose();
});

test('a structure written to a profile is read from guest memory and read back', async()=>{
    const filesystem = await filesystemModule.create({});
    const thread = { id: 1 };
    const { bytes, libraries, lastError } = await build({
        filesystem,
        kernel: { currentThread: ()=>thread },
    });
    const kernel32 = libraries['KERNEL32.dll'];
    /** @param {number} at @param {string} text */
    const narrow = (at, text)=>{
        bytes.set([...text, '\0'].map(ch=>ch.charCodeAt(0)), at);
        return at;
    };
    const section = narrow(0x1000, 'Setup');
    const key = narrow(0x1100, 'Window');
    const file = narrow(0x1200, 'C:\\app.ini');
    bytes.set([0x10, 0x20, 0x30, 0x40], 0x2000);

    assert.equal(kernel32.WritePrivateProfileStructA.handler([section, key, 0x2000, 4, file]),
        1, `written, last error ${lastError()}`);
    assert.equal(kernel32.GetPrivateProfileStructA.handler([section, key, 0x3000, 4, file]), 1);
    assert.deepEqual([...bytes.subarray(0x3000, 0x3004)], [0x10, 0x20, 0x30, 0x40]);
    await win32Module.dispose();
    await filesystemModule.dispose();
});

test('msvcrt\'s descriptors and kernel32\'s file handles are handles in one table', async()=>{
    // _get_osfhandle gives a handle kernel32's calls take, at the descriptor's
    // position; _open_osfhandle takes CreateFile's; the descriptor closes
    // either through the CloseHandle a program calls.
    const filesystem = await filesystemModule.create({});
    /** @type {Map<number, { type: string, object: any }>} */
    const entries = new Map();
    let next = 0x100;
    const handles = {
        /** @param {string} type @param {any} object */
        open(type, object){
            entries.set(next, { type, object });
            next += 4;
            return next - 4;
        },
        /** @param {number} handle @param {string} [type] */
        resolve(handle, type){
            const entry = entries.get(handle);
            if (!entry || (type && entry.type !== type))
            {
                throw new Error(`invalid handle ${handle}`);
            }
            return entry.object;
        },
        /** @param {number} handle */
        close(handle){
            const entry = entries.get(handle);
            if (!entry)
            {
                throw new Error(`invalid handle ${handle}`);
            }
            entries.delete(handle);
            return entry.object;
        },
        /** @param {number} handle */
        typeOf: handle=>entries.get(handle)?.type ?? null,
    };
    const thread = { id: 1 };
    const { bytes, libraries } = await build({
        filesystem, kernel: { handles, currentThread: ()=>thread },
    });
    const kernel32 = libraries['KERNEL32.dll'];
    const crt = libraries['msvcrt.dll'];
    /** @param {number} at @param {string} text */
    const narrow = (at, text)=>{
        bytes.set([...text, '\0'].map(ch=>ch.charCodeAt(0)), at);
        return at;
    };
    const O_RDWR_CREAT_BINARY = 0x8102;
    const FILE_BEGIN = 0;
    const GENERIC_READ = 0x80000000;
    const OPEN_EXISTING = 3;

    const fd = crt._open.handler([narrow(0x1000, 'C:\\save.dat'), O_RDWR_CREAT_BINARY, 0x180]);
    assert.equal(crt._write.handler([fd, narrow(0x1100, 'abc'), 3]), 3);
    const handle = crt._get_osfhandle.handler([fd]);
    assert.equal(kernel32.GetFileSize.handler([handle, 0]), 3);
    assert.equal(kernel32.SetFilePointer.handler([handle, 1, 0, FILE_BEGIN]), 1);
    assert.equal(crt._tell.handler([fd]), 1, 'the handle moved the descriptor');
    assert.equal(crt._close.handler([fd]), 0);
    assert.equal(kernel32.CloseHandle.handler([handle]), 0, 'the descriptor closed it');

    const created = kernel32.CreateFileA.handler(
        [narrow(0x1200, 'C:\\save.dat'), GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0]);
    const adopted = crt._open_osfhandle.handler([created, 0]);
    assert.equal(crt._read.handler([adopted, 0x2000, 16]), 3);
    assert.deepEqual([...bytes.subarray(0x2000, 0x2003)], [0x61, 0x62, 0x63]);
    assert.equal(crt._close.handler([adopted]), 0);
    assert.equal(kernel32.CloseHandle.handler([created]), 0, 'and this one too');
    await win32Module.dispose();
    await filesystemModule.dispose();
});

test('a file msvcrt opened to be deleted on close is gone once the process ends', async()=>{
    // However the process ends, every handle it held closes: ExitProcess and
    // TerminateProcess alike.
    const O_CREAT_RDWR_TEMPORARY = 0x0142;
    const CURRENT_PROCESS = 0xffffffff;
    /** @type {[string, (kernel32: any) => void][]} */
    const endings = [
        ['ExitProcess', kernel32=>kernel32.ExitProcess.handler([0])],
        ['TerminateProcess', kernel32=>kernel32.TerminateProcess.handler([CURRENT_PROCESS, 1])],
    ];
    for (const [how, end] of endings)
    {
        const filesystem = await filesystemModule.create({});
        const { bytes, libraries, exitCode } = await build({
            filesystem, kernel: { currentThread: ()=>({ id: 1 }) },
            modules: { processDetach: ()=>[] },
        });
        bytes.set([...'C:\\scratch.tmp\0'].map(ch=>ch.charCodeAt(0)), 0x1000);
        assert.ok(libraries['msvcrt.dll']._open.handler([0x1000, O_CREAT_RDWR_TEMPORARY, 0]) > 2);
        assert.notEqual(filesystem.stat('C:\\scratch.tmp'), null, how);

        end(libraries['KERNEL32.dll']);
        assert.notEqual(exitCode(), null, how);
        assert.equal(filesystem.stat('C:\\scratch.tmp'), null, how);
        await win32Module.dispose();
        await filesystemModule.dispose();
    }
});

test('msvcrt\'s __int64 answers reach EDX through the processor\'s registers', async()=>{
    const filesystem = await filesystemModule.create({});
    /** @type {Record<string, number>} */
    const written = {};
    const { bytes, libraries } = await build({
        filesystem,
        registers: {
            read: ()=>0,
            /** @param {string} name @param {number} value */
            write: (name, value)=>{
                written[name] = value;
            },
        },
    });
    const crt = libraries['msvcrt.dll'];
    bytes.set([...'C:\\big.dat\0'].map(ch=>ch.charCodeAt(0)), 0x1000);
    const O_CREAT_RDWR_BINARY = 0x8102;
    const fd = crt._open.handler([0x1000, O_CREAT_RDWR_BINARY, 0]);
    const SEEK_SET = 0;

    assert.equal(crt._lseeki64.handler([fd, 7, 1, SEEK_SET]) >>> 0, 7);
    assert.equal(written.edx, 1, 'the high half of 0x100000007');
    await win32Module.dispose();
    await filesystemModule.dispose();
});

test('LoadLibraryEx\'s flags reach whoever assembled the process', async()=>{
    /** @type {any[][]} */
    const asked = [];
    const { bytes, libraries } = await build({ modules: {
        /** @param {string} name @param {number} flags */
        load: (name, flags)=>{
            asked.push([name, flags]);
            return 0x10000001;
        },
        /** @param {number} handle */
        dataFile: handle=>(handle === 0x10000001
            ? { name: 'probe.dll', base: 0x10000000, release: ()=>1 } : null),
    } });
    bytes.set([...'probe.dll\0'].map(ch=>ch.charCodeAt(0)), 0x4000);
    const LOAD_LIBRARY_AS_DATAFILE = 0x2;

    assert.equal(libraries['KERNEL32.dll'].LoadLibraryExA.handler(
        [0x4000, 0, LOAD_LIBRARY_AS_DATAFILE]), 0x10000001);
    assert.deepEqual(asked, [['probe.dll', LOAD_LIBRARY_AS_DATAFILE]]);
    assert.equal(libraries['KERNEL32.dll'].FreeLibrary.handler([0x10000001]), 1,
        'and the data file is given back by its handle');
    await win32Module.dispose();
});

test('ExitProcess ends the other threads and tells each attached image, last first', async()=>{
    // What Microsoft documents for ExitProcess: every other thread ends, then
    // each attached DLL's entry point is called with DLL_PROCESS_DETACH on the
    // calling thread -- lpvReserved non-NULL, since the process is ending --
    // and only then does the process end with the code. An image's TLS
    // callbacks are called for every reason its entry point is, before it;
    // the program's own have no entry point after them.
    const DLL_PROCESS_DETACH = 0;
    const self = { id: 1, state: 'running' };
    const other = { id: 2, state: 'blocked' };
    const gone = { id: 3, state: 'terminated' };
    /** @type {any[][]} */
    const ended = [];
    /** @type {any[]} */
    const called = [];
    const { libraries, exitCode } = await build({
        kernel: {
            currentThread: ()=>self,
            threads: ()=>[self, other, gone],
            ThreadState: { TERMINATED: 'terminated' },
            /** @param {any} thread @param {number} code */
            exitThread: (thread, code)=>ended.push([thread.id, code]),
        },
        bridge: {
            /** @param {any} call */
            callGuest: call=>{
                called.push({ ...call, exitCode: exitCode() });
                return Promise.resolve(1);
            },
        },
        modules: {
            processDetach: ()=>[
                { base: 0x10100000, routines: [0x10101000] },
                { base: 0x10000000, routines: [0x10000800, 0x10001000] },
                { base: 0x400000, routines: [0x401800] },
            ],
        },
    });

    const answer = libraries['KERNEL32.dll'].ExitProcess.handler([7]);
    assert.ok(answer instanceof Promise, 'the libraries run before the process ends');
    assert.deepEqual(ended, [[2, 7]], 'the other live thread is ended first');
    await answer;
    assert.deepEqual(called.map(call=>[call.entry, call.args, call.thread, call.exitCode]), [
        [0x10101000, [0x10100000, DLL_PROCESS_DETACH, 1], self, null],
        [0x10000800, [0x10000000, DLL_PROCESS_DETACH, 1], self, null],
        [0x10001000, [0x10000000, DLL_PROCESS_DETACH, 1], self, null],
        [0x401800, [0x400000, DLL_PROCESS_DETACH, 1], self, null],
    ]);
    assert.equal(exitCode(), 7);
    await win32Module.dispose();
});

test('the runtime\'s exit tells the attached libraries too, after the atexit handlers', async()=>{
    // exit runs what atexit registered and then ends the process the way
    // ExitProcess does, DLL_PROCESS_DETACH included; the handlers are guest
    // code, so by then the call has left the bridge and must not park.
    const DLL_PROCESS_DETACH = 0;
    const self = { id: 1, state: 'running' };
    /** @type {any[]} */
    const called = [];
    const { libraries, exitCode } = await build({
        kernel: {
            currentThread: ()=>self,
            threads: ()=>[self],
            ThreadState: { TERMINATED: 'terminated' },
            exitThread: ()=>{},
        },
        bridge: {
            /** @param {any} call */
            callGuest: call=>{
                called.push([call.entry, call.args]);
                return Promise.resolve(1);
            },
        },
        modules: {
            processDetach: ()=>[{ base: 0x10000000, routines: [0x10001000] }],
        },
    });
    const crt = libraries['msvcrt.dll'];
    assert.equal(crt.atexit.handler([0x401000]), 0);
    await crt.exit.handler([5]);
    assert.deepEqual(called, [
        [0x401000, []],
        [0x10001000, [0x10000000, DLL_PROCESS_DETACH, 1]],
    ], 'the handler, then the library');
    assert.equal(exitCode(), 5);
    await win32Module.dispose();
});

test('ExitProcess with no library to tell ends the process at once', async()=>{
    /** @type {any[]} */
    const ended = [];
    const { libraries, exitCode } = await build({
        kernel: {
            currentThread: ()=>({ id: 1 }),
            threads: ()=>[{ id: 2 }],
            exitThread: (/** @type {any} */ thread)=>ended.push(thread),
        },
        modules: { processDetach: ()=>[] },
    });

    libraries['KERNEL32.dll'].ExitProcess.handler([3]);
    assert.equal(exitCode(), 3);
    assert.deepEqual(ended, [], 'nothing runs after it, so nothing else is ended');
    await win32Module.dispose();
});

test('MsgWaitForMultipleObjectsEx with MWMO_INPUTAVAILABLE wakes for a message seen already',
    async()=>{
        // user32's message tests: a message a PeekMessage has looked at and left
        // no longer ends a wait for new input, but it ends one that asks whether
        // any input is there at all.
        const QS_POSTMESSAGE = 0x8;
        const MWMO_INPUTAVAILABLE = 0x4;
        const PM_NOREMOVE = 0;
        const WAIT_OBJECT_0 = 0;
        const WAIT_TIMEOUT = 0x102;
        const WM_USER = 0x400;
        const thread = { id: 1 };
        const { libraries } = await build({ kernel: { currentThread: ()=>thread } });
        const user32 = libraries['USER32.dll'];

        assert.equal(user32.PostMessageA.handler([0, WM_USER, 0, 0]), 1);
        assert.equal(user32.PeekMessageA.handler([0x6000, 0, 0, 0, PM_NOREMOVE]), 1);
        assert.equal(user32.MsgWaitForMultipleObjectsEx.handler([0, 0, 0, QS_POSTMESSAGE, 0]),
            WAIT_TIMEOUT, 'nothing new');
        assert.equal(user32.MsgWaitForMultipleObjectsEx.handler(
            [0, 0, 0, QS_POSTMESSAGE, MWMO_INPUTAVAILABLE]), WAIT_OBJECT_0, 'but something there');
        await win32Module.dispose();
    });

test('SETUPAPI finds an INF on the volume by bare name and registers into advapi32\'s hive',
    async()=>{
        const filesystem = await filesystemModule.create({});
        const thread = { id: 1 };
        const { bytes, view, libraries, lastError } = await build({
            filesystem,
            kernel: { currentThread: ()=>thread },
            bridge: { callerThread: ()=>thread },
        });
        const kernel32 = libraries['KERNEL32.dll'];
        const setupapi = libraries['SETUPAPI.dll'];
        let next = 0x1000;
        /** @param {string} text */
        const narrow = text=>{
            const at = next;
            bytes.set([...text, '\0'].map(ch=>ch.charCodeAt(0)), at);
            next += text.length + 0x10;
            return at;
        };
        const INF_STYLE_WIN4 = 2;
        const INVALID_HANDLE_VALUE = 0xffffffff;
        kernel32.CreateDirectoryA.handler([narrow('C:\\WINDOWS'), 0]);
        kernel32.CreateDirectoryA.handler([narrow('C:\\WINDOWS\\inf'), 0]);
        assert.equal(kernel32.WritePrivateProfileStringA.handler([narrow('Version'),
            narrow('Signature'), narrow('"$Chicago$"'), narrow('C:\\WINDOWS\\inf\\wired.inf')]), 1,
        `written, last error ${lastError()}`);

        const inf = await setupapi.SetupOpenInfFileA.handler(
            [narrow('wired.inf'), 0, INF_STYLE_WIN4, 0]);
        assert.notEqual(inf, INVALID_HANDLE_VALUE, `found, last error ${lastError()}`);
        const context = 0x3000;
        assert.equal(await setupapi.SetupFindFirstLineA.handler(
            [inf, narrow('Version'), narrow('Signature'), context]), 1);
        assert.equal(await setupapi.SetupGetLineTextA.handler([context, 0, 0, 0, 0x3100, 64, 0]),
            1);
        assert.equal(String.fromCharCode(...bytes.subarray(0x3100, 0x3109)), '$Chicago$');
        setupapi.SetupCloseInfFile.handler([inf]);

        const data = 0x4000;
        const exception = 0x5000;
        view.setUint32(data, 0xdc, true);
        bytes.set([0x78, 0x56, 0x34, 0x12, 0x34, 0x12, 0x78, 0x56, 1, 2, 3, 4, 5, 6, 7, 8],
            data + 4);
        view.setUint32(exception, 0x454, true);
        assert.equal(setupapi.SetupRegisterOsComponent.handler([data, exception]), 1,
            `registered, last error ${lastError()}`);
        const HKEY_LOCAL_MACHINE = 0x80000002;
        const KEY_READ = 0x20019;
        assert.equal(libraries['ADVAPI32.dll'].RegOpenKeyExA.handler([HKEY_LOCAL_MACHINE,
            narrow('SYSTEM\\CurrentControlSet\\Control\\Setup\\OsComponents\\'
                + '{12345678-1234-5678-0102-030405060708}'), 0, KEY_READ, 0x6000]), 0);
        await win32Module.dispose();
        await filesystemModule.dispose();
    });

/**
 * A handle table that refuses what it does not hold, as the kernel's does,
 * and says what it holds.
 */
function handleTable(){
    /** @type {Map<number, { type: string, object: any }>} */
    const entries = new Map();
    let next = 0x100;
    return {
        entries,
        /** @param {string} type @param {any} object */
        open(type, object){
            entries.set(next, { type, object });
            next += 4;
            return next - 4;
        },
        /** @param {number} handle @param {string} [type] */
        resolve(handle, type){
            const entry = entries.get(handle);
            if (!entry || (type && entry.type !== type))
            {
                throw new Error(`invalid handle ${handle}`);
            }
            return entry.object;
        },
        /** @param {number} handle */
        close(handle){
            const entry = entries.get(handle);
            if (!entry)
            {
                throw new Error(`invalid handle ${handle}`);
            }
            entries.delete(handle);
            return entry.object;
        },
        /** @param {number} handle */
        typeOf: handle=>entries.get(handle)?.type ?? null,
    };
}

test('mmio opens a file by the handle kernel32 gave the program, and closes it with its own',
    async()=>{
        // mmio.c test_mmioSeek: the file is read from where the handle stands.
        const filesystem = await filesystemModule.create({});
        const handles = handleTable();
        const thread = { id: 1 };
        const { bytes, view, libraries } = await build({
            filesystem, kernel: { handles, currentThread: ()=>thread },
        });
        const kernel32 = libraries['KERNEL32.dll'];
        const winmm = libraries['WINMM.dll'];
        const GENERIC_READ_WRITE = 0xc0000000;
        const CREATE_ALWAYS = 2;
        const FILE_BEGIN = 0;
        bytes.set([...'C:\\riff.bin\0'].map(ch=>ch.charCodeAt(0)), 0x1000);
        const file = kernel32.CreateFileA.handler(
            [0x1000, GENERIC_READ_WRITE, 0, 0, CREATE_ALWAYS, 0, 0]);
        bytes.set(Array.from({ length: 64 }, (_, index)=>index), 0x2000);
        assert.equal(kernel32.WriteFile.handler([file, 0x2000, 64, 0x1100, 0]), 1);
        assert.equal(kernel32.SetFilePointer.handler([file, 16, 0, FILE_BEGIN]), 16);

        const info = 0x3000;
        view.setUint32(info + 48, file, true);
        const handle = winmm.mmioOpenA.handler([0, info, 0]);
        assert.notEqual(handle, 0, `opened, error ${view.getUint32(info + 12, true)}`);
        assert.equal(winmm.mmioSeek.handler([handle, 0, 1]), 16);
        assert.equal(winmm.mmioRead.handler([handle, 0x4000, 4]), 4);
        assert.deepEqual([...bytes.subarray(0x4000, 0x4004)], [16, 17, 18, 19]);
        assert.equal(winmm.mmioClose.handler([handle, 0]), 0);
        assert.equal(handles.entries.has(file), false, 'CloseHandle closed the program\'s handle');
        await win32Module.dispose();
        await filesystemModule.dispose();
    });

test('a program\'s own I/O procedure is called through the bridge, on the calling thread',
    async()=>{
        const thread = { id: 1 };
        /** @type {{ entry: number, args: number[], thread: unknown }[]} */
        const calls = [];
        const { bytes, view, libraries } = await build({
            bridge: {
                /** @param {{ entry: number, args: number[], thread: unknown }} call */
                callGuest: call=>{
                    calls.push(call);
                    return Promise.resolve(0);
                },
                callerThread: ()=>thread,
            },
        });
        const winmm = libraries['WINMM.dll'];
        const PROCEDURE = 0x401000;
        const XYZ = 0x205a5958;
        const MMIO_INSTALLPROC = 0x10000;
        const MMIOM_OPEN = 3;
        const MMIOM_CLOSE = 4;
        winmm.mmioInstallIOProcA.handler([XYZ, PROCEDURE, MMIO_INSTALLPROC]);
        bytes.set([...'movie.xyz\0'].map(ch=>ch.charCodeAt(0)), 0x1000);
        const info = 0x3000;
        view.setUint32(info + 4, XYZ, true);
        const handle = await winmm.mmioOpenA.handler([0x1000, info, 0]);
        assert.notEqual(handle, 0);
        assert.deepEqual([calls[0].entry, calls[0].args[1], calls[0].thread],
            [PROCEDURE, MMIOM_OPEN, thread]);
        const [record, , name] = calls[0].args;
        assert.equal(String.fromCharCode(...bytes.subarray(name, bytes.indexOf(0, name))),
            'movie.xyz');
        assert.ok(record >= ARENA.base && record < ARENA.base + ARENA.size,
            'the MMIOINFO the procedure is handed is on the program\'s heap');
        assert.equal(await winmm.mmioClose.handler([handle, 0]), 0);
        assert.equal(calls.at(-1)?.args[1], MMIOM_CLOSE);
        await win32Module.dispose();
    });

test('a drop target is the property user32 answers for its window', async()=>{
    // dragdrop.c test_Register_Revoke reads it back with GetPropA. The
    // desktop is a window user32 answers for without a program making one.
    const thread = { id: 1 };
    const { bytes, view, libraries } = await build({
        kernel: { currentThread: ()=>thread }, bridge: { callerThread: ()=>thread },
    });
    const user32 = libraries['USER32.dll'];
    const ole32 = libraries['ole32.dll'];
    const window = user32.GetDesktopWindow.handler([]);
    assert.equal(user32.IsWindow.handler([window]), 1);
    assert.equal(ole32.OleInitialize.handler([0]), 0);
    const target = 0x2000;
    view.setUint32(target, 0x2100, true);
    assert.equal(await ole32.RegisterDragDrop.handler([window, target]), 0);
    // Above 0xFFFF, where a pointer is a name rather than an atom.
    const name = 0x20000;
    bytes.set([...'OleDropTargetInterface\0'].map(ch=>ch.charCodeAt(0)), name);
    assert.equal(user32.GetPropA.handler([window, name]), target);
    assert.equal(await ole32.RevokeDragDrop.handler([window]), 0);
    assert.equal(user32.GetPropA.handler([window, name]), 0);
    await win32Module.dispose();
});

test('a PROPVARIANT\'s BSTR and SAFEARRAY are copied and freed by oleaut32\'s own calls', async()=>{
    // propvariant.c test_copy: a BSTR copy is SysAllocString's, so it stops
    // at an embedded NUL, and an array is SafeArrayCopy's.
    const { bytes, view, libraries } = await build();
    const ole32 = libraries['ole32.dll'];
    const oleaut32 = libraries['OLEAUT32.dll'];
    const VT_I4 = 3;
    const VT_BSTR = 8;
    const VT_ARRAY = 0x2000;
    [...'Test Str\0ing'].forEach((ch, index)=>view.setUint16(0x1000 + index * 2,
        ch.charCodeAt(0), true));
    const bstr = oleaut32.SysAllocStringLen.handler([0x1000, 12]);
    const source = 0x2000;
    const dest = 0x2100;
    view.setUint16(source, VT_BSTR, true);
    view.setUint32(source + 8, bstr, true);
    assert.equal(await ole32.PropVariantCopy.handler([dest, source]), 0);
    const copy = view.getUint32(dest + 8, true);
    assert.ok(copy !== 0 && copy !== bstr);
    assert.equal(oleaut32.SysStringLen.handler([copy]), 8);
    assert.equal(await ole32.PropVariantClear.handler([dest]), 0);
    assert.equal(await ole32.PropVariantClear.handler([source]), 0);
    assert.deepEqual([...bytes.subarray(source, source + 16)], new Array(16).fill(0));

    const bound = 0x3000;
    view.setUint32(bound, 2, true);
    view.setInt32(bound + 4, 0, true);
    const array = oleaut32.SafeArrayCreate.handler([VT_I4, 1, bound]);
    assert.notEqual(array, 0);
    view.setUint16(source, VT_ARRAY | VT_I4, true);
    view.setUint32(source + 8, array, true);
    assert.equal(await ole32.PropVariantCopy.handler([dest, source]), 0);
    const copied = view.getUint32(dest + 8, true);
    assert.ok(copied !== 0 && copied !== array);
    assert.equal(oleaut32.SafeArrayGetUBound.handler([copied, 1, 0x3100]), 0);
    assert.equal(view.getInt32(0x3100, true), 1, 'two elements, as the source has');
    assert.equal(await ole32.PropVariantClear.handler([dest]), 0);
    assert.equal(await ole32.PropVariantClear.handler([source]), 0);
    await win32Module.dispose();
});

test('WINTRUST reads the file from the volume and judges it against the configured roots',
    async()=>{
        const filesystem = await filesystemModule.create({});
        const thread = { id: 1 };
        const chain = certificates();
        const { bytes, view, libraries, lastError } = await build({
            filesystem,
            kernel: {
                currentThread: ()=>thread,
                clock: { virtualTime: ()=>0, wallClock: ()=>NOW },
            },
            bridge: { callerThread: ()=>thread },
            trustedRoots: [chain.root],
        });
        filesystem.apply([{ path: 'C:\\signed.cab', bytes: signedCabinet() },
            { path: 'C:\\unsigned.cab', bytes: signedCabinet({ unsigned: true }) }]);
        const action = 0x1000;
        bytes.set([0x6b, 0xc5, 0xaa, 0x00, 0x44, 0xcd, 0xd0, 0x11,
            0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee], action);
        const data = 0x1100;
        const file = 0x1200;
        const path = 0x1300;
        /** @param {string} name */
        const verify = name=>{
            [...name, '\0'].forEach((ch, i)=>view.setUint16(path + i * 2, ch.charCodeAt(0), true));
            view.setUint32(data, 48, true);
            view.setUint32(data + 20, 1, true);
            view.setUint32(data + 24, file, true);
            view.setUint32(file, 16, true);
            view.setUint32(file + 4, path, true);
            return libraries['WINTRUST.dll'].WinVerifyTrust.handler([0xffffffff, action, data]);
        };
        assert.equal(await verify('C:\\signed.cab'), 0, `last error ${lastError()}`);
        assert.equal(await verify('C:\\unsigned.cab'), 0x800b0100, 'TRUST_E_NOSIGNATURE');
        assert.equal(lastError(), 0x800b0100);
        await win32Module.dispose();
        await filesystemModule.dispose();
    });

test('a \\\\?\\ path reaches the volume\'s files as the plain path does', async()=>{
    // A program that builds its paths in the Win32 file namespace -- a profile folder under
    // My Documents, created a level at a time -- finds and makes what a plain path finds.
    const filesystem = await filesystemModule.create({});
    const thread = { id: 1 };
    const { bytes, libraries, lastError } = await build({
        filesystem,
        kernel: { currentThread: ()=>thread },
        bridge: { callerThread: ()=>thread },
    });
    const kernel32 = libraries['KERNEL32.dll'];
    let next = 0x1000;
    /** @param {string} text */
    const wide = text=>{
        const at = next;
        [...text, '\0'].forEach((ch, i)=>{
            bytes[at + i * 2] = ch.charCodeAt(0) & 0xff;
            bytes[at + i * 2 + 1] = ch.charCodeAt(0) >> 8;
        });
        next += text.length * 2 + 0x10;
        return at;
    };
    const ERROR_ALREADY_EXISTS = 183;
    const FILE_ATTRIBUTE_DIRECTORY = 0x10;
    assert.equal(kernel32.CreateDirectoryW.handler([wide('C:\\Profiles'), 0]), 1);
    assert.equal(kernel32.CreateDirectoryW.handler([wide('\\\\?\\C:\\Profiles'), 0]), 0);
    assert.equal(lastError(), ERROR_ALREADY_EXISTS);
    assert.equal(kernel32.CreateDirectoryW.handler([wide('\\\\?\\C:\\Profiles\\Default'), 0]),
        1, `made, last error ${lastError()}`);
    assert.equal(kernel32.GetFileAttributesW.handler([wide('C:\\Profiles\\Default')]) & 0x10,
        FILE_ATTRIBUTE_DIRECTORY);
    assert.equal(kernel32.GetFileAttributesW.handler([wide('\\\\?\\C:\\Profiles/Default')]),
        0xffffffff, 'a slash is no separator there');
    await win32Module.dispose();
    await filesystemModule.dispose();
});
