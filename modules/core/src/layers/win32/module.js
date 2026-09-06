/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { createConsoleFunctions } from './kernel32/console.js';
import { createThreadingFunctions } from './kernel32/threading.js';
import { createDebugFunctions } from './kernel32/debug.js';
import { createHeapAllocator, createHeapFunctions } from './kernel32/heap.js';
import { createProcessFunctions, createThreadState } from './kernel32/process.js';
import { createModuleFunctions } from './kernel32/modules.js';
import { createFileFunctions } from './kernel32/files.js';
import { createVolume } from './kernel32/vfs.js';
import { createMsvcrtFunctions } from './msvcrt/functions.js';
import { createWindowFunctions } from './user32/windows.js';
import { createMessageQueue } from './user32/messages.js';
import { createRegistryFunctions } from './advapi32/functions.js';
import { createHive } from './advapi32/registry.js';
import { createGdiFunctions } from './gdi32/functions.js';
import { createOleFunctions } from './ole32/functions.js';
import { createComRegistry } from './ole32/objects.js';

/**
 * win32 — the API surface the guest was compiled against.
 *
 * Grouped by the library that exports it, because that grouping is a fact about
 * the guest rather than a filing convention: an import descriptor names a DLL,
 * `GetProcAddress` is asked about one module at a time, and a synthesised module
 * has to know exactly which functions it exports.
 *
 * Nothing here registers anything or knows how a guest call arrives. The module
 * hands out tables; whoever assembles the process binds them to the bridge.
 */

/** @type {Record<string, Record<string, any>>} */
let libraries = {};
/** @type {number | null} */
let exitCode = null;
/** @type {any} */
let hive = null;
/** @type {any} */
let queue = null;
/** @type {any} */
let com = null;

export const win32Module = {
    name: 'win32',
    version: '0.2.0',
    requires: /** @type {readonly string[]} */ ([
        'bridge',
        'kernel',
        'memory',
        'loader',
        'filesystem',
        'log',
    ]),

    /**
     * @param {any} config
     * @param {import('../../system/contract.js').ScopedModuleHost} host
     * @returns {Promise<any>}
     */
    async create(config, host){
        const memory = host.requireApi('memory');
        const kernel = host.requireApi('kernel');
        const bridge = host.requireApi('bridge');
        const filesystem = host.requireApi('filesystem');
        exitCode = null;

        /** @type {(handle: number, text: string) => void} */
        const sink = config?.onOutput ?? (()=>{});
        /** @type {(text: string) => void} */
        const trace = config?.onTrace ?? (()=>{});

        // What the assembling caller owns and we are only handed: where the heap
        // may allocate, how to reach a module, and how a waiting call gets to
        // look again. Each is read when a guest calls, never now, so the caller
        // can fill them in after the graph is built.
        const arena = config?.arena ?? { base: 0, size: 0 };
        const modules = config?.modules ?? {
            find: ()=>null, byBase: ()=>null, imagePath: ()=>'',
        };
        const idle = config?.idle ?? (()=>Promise.resolve());

        const readMemory = (/** @type {number} */ address, /** @type {number} */ length)=>
            memory.readBytes(address, length);
        const writeMemory = (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            memory.writeBytes(address, bytes);
        const readCString = (/** @type {number} */ address, /** @type {number} */ maxLength)=>
            memory.readCString(address, maxLength);

        const { setError } = createThreadState(()=>kernel.currentThread());
        const volume = createVolume(filesystem);
        hive = createHive();
        queue = createMessageQueue();
        com = createComRegistry();

        // One allocator over the whole arena. Everything the guest is handed
        // memory from -- the heap it asks for, the bits of a DIB section, COM
        // task memory, a vtable -- comes out of the same free list, because
        // carving it up in advance is guessing at proportions nobody knows.
        const allocator = createHeapAllocator(arena);
        const heap = {
            /** @param {number} bytes */
            allocate: bytes=>allocator.allocate(bytes),
            /** @param {number} address */
            free: address=>allocator.free(address),
            /** @param {number} address */
            block: address=>allocator.block(address),
            /** @param {number} address @param {number} bytes */
            resize: (address, bytes)=>allocator.resize(address, bytes),
        };
        bridge.useHeap(heap);

        libraries = {
            'KERNEL32.dll': {
                ...createConsoleFunctions({
                    write: (handle, text)=>sink(handle, text),
                    exit: code=>{
                        exitCode = code;
                    },
                    park: ()=>bridge.park(),
                }),
                ...createThreadingFunctions({
                    kernel,
                    readMemory,
                    currentThread: ()=>kernel.currentThread(),
                    park: thread=>bridge.park(thread),
                }),
                ...createDebugFunctions({
                    readCString,
                    readWideString: (address, maxLength)=>
                        memory.readWideString(address, maxLength),
                    say: text=>trace(text),
                }),
                ...createHeapFunctions({ arena, allocator, readMemory, writeMemory }),
                ...createProcessFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    currentThread: ()=>kernel.currentThread(),
                    now: ()=>kernel.clock.virtualTime(),
                    systemTimeMs: ()=>kernel.clock.wallClock(),
                    moduleHandle: name=>modules.find(name)?.base ?? 0,
                    // Actually waiting is the scheduler's, and there is no timed
                    // wait yet. Crediting the clock is what we can honour, and
                    // it is what keeps a guest from believing no time passed.
                    sleep: milliseconds=>kernel.clock.advance(milliseconds),
                }),
                ...createModuleFunctions({
                    readCString,
                    writeMemory,
                    find: name=>modules.find(name),
                    byBase: base=>modules.byBase(base),
                    setLastError: setError,
                    imagePath: ()=>modules.imagePath(),
                }),
                // Last, deliberately: writing and closing a handle are the same
                // entry points for a file as for a console or an event, and the
                // one that knows about files answers for all of them.
                ...createFileFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    files: volume,
                    setLastError: setError,
                    writeConsole: (handle, text)=>sink(handle, text),
                    handles: {
                        open: (type, object)=>kernel.handles.open(type, object),
                        resolve: (handle, type)=>kernel.handles.resolve(handle, type),
                        close: handle=>kernel.handles.close(handle),
                    },
                }),
            },

            'msvcrt.dll': createMsvcrtFunctions({
                readMemory,
                writeMemory,
                readCString,
                write: (handle, text)=>sink(handle, text),
                callGuest: (entry, args)=>bridge.callGuest({ entry, args }),
            }),

            'USER32.dll': createWindowFunctions({
                readMemory,
                writeMemory,
                readCString,
                handles: {
                    open: (type, object)=>kernel.handles.open(type, object),
                    close: handle=>kernel.handles.close(handle),
                },
                queue,
                dispatch: (wndProc, message)=>bridge.callGuest({
                    entry: wndProc,
                    // The four arguments a window procedure declares, in order.
                    args: [message.hwnd, message.message, message.wParam, message.lParam],
                }),
                park: ()=>bridge.park(),
                idle,
                created: config?.created ?? (()=>{}),
            }),

            'ADVAPI32.dll': createRegistryFunctions({
                readMemory,
                writeMemory,
                readCString,
                hive,
            }),

            'GDI32.dll': createGdiFunctions({
                readMemory,
                writeMemory,
                readCString,
                handles: {
                    open: (type, object)=>kernel.handles.open(type, object),
                    close: handle=>kernel.handles.close(handle),
                },
                surfaces: heap,
            }),

            'ole32.dll': createOleFunctions({
                readMemory,
                writeMemory,
                currentThread: ()=>kernel.currentThread(),
                heap,
                registry: com,
                vtables: {
                    /** @param {any} object @param {string} interfaceId */
                    publish: (object, interfaceId)=>
                        bridge.publishInterface(object, interfaceId),
                },
            }),
        };

        /** Every function, whichever library exports it. */
        const flat = ()=>Object.assign({}, ...Object.values(libraries));

        return {
            /** @returns {Record<string, Record<string, any>>} library name -> its exports */
            libraries: ()=>libraries,

            /**
             * @param {string} name
             * @returns {{ argBytes: number, handler: Function } | null}
             */
            resolve: name=>flat()[name] ?? null,

            /**
             * Where the guest's messages come from. The input layer posts here,
             * and so does whoever is driving the machine.
             */
            queue: ()=>queue,

            /** The registry, whose contents outlive the process (§9). */
            registry: ()=>hive,

            /**
             * Where a COM class is registered. Whoever implements an interface
             * -- graphics, audio -- puts its factory here, and a guest reaches
             * it through CoCreateInstance like any other.
             */
            com: ()=>com,

            /** Set once the guest has asked to terminate. */
            exitCode: ()=>exitCode,
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        const counts = Object.fromEntries(
            Object.entries(libraries).map(([name, table])=>[name, Object.keys(table).length]));
        return {
            name: 'win32',
            version: '0.2.0',
            status: Object.keys(libraries).length > 0 ? 'ready' : 'created',
            metrics: {
                libraries: counts,
                implemented: Object.values(libraries)
                    .reduce((total, table)=>total + Object.keys(table).length, 0),
                exitCode,
            },
        };
    },

    async dispose(){
        libraries = {};
        exitCode = null;
        hive = null;
        queue = null;
        com = null;
    },
};
