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
import { createSyncFunctions } from './kernel32/sync.js';
import { createLocaleFunctions } from './kernel32/locale.js';
import { createEnvironmentFunctions } from './kernel32/environment.js';
import { createSystemFunctions } from './kernel32/system.js';
import { createExceptionFunctions } from './kernel32/exceptions.js';
import { createSeh } from './kernel32/seh.js';
import { createCrtSeh } from './msvcrt/seh.js';
import { createResourceFunctions } from './kernel32/resources.js';
import { createDriveFunctions } from './kernel32/drives.js';
import { createMappingFunctions } from './kernel32/mapping.js';
import { createFileTimeFunctions } from './kernel32/filetime.js';
import { createConsoleIoFunctions } from './kernel32/consoleio.js';
import { createVolume } from './kernel32/vfs.js';
import { createMsvcrtFunctions } from './msvcrt/functions.js';
import { createWindowFunctions } from './user32/windows.js';
import { createMessageQueue } from './user32/messages.js';
import { createRegistryFunctions } from './advapi32/functions.js';
import { createHive } from './advapi32/registry.js';
import { createGdiFunctions } from './gdi32/functions.js';
import { createWinsockFunctions } from './wsock32/functions.js';
import { createSocketRegistry } from './wsock32/sockets.js';
import { createLoopbackAdapter } from './wsock32/loopback.js';
import { createWinmmFunctions } from './winmm/functions.js';
import { createComctlFunctions } from './comctl32/functions.js';
import { createShellFunctions } from './shell32/functions.js';
import { createVersionFunctions } from './version/functions.js';
import { createCommonDialogFunctions } from './comdlg32/functions.js';
import { createImmFunctions } from './imm32/functions.js';
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

/**
 * The most recently created instance, for `diagnostics()` alone.
 *
 * The module contract puts `diagnostics()` on the module rather than on the
 * api, so something outside a `create()` call has to be able to see in. That
 * is the only reason this exists, and it holds a reference rather than the
 * state itself -- everything a running process owns lives inside its own
 * `create()`, so two of them cannot write over each other. They did: the
 * registry hive, the message queue and the COM registry were module-scoped,
 * and a second process in one realm silently took the first one's.
 *
 * @type {any}
 */
let current = null;

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

        /** @type {Record<string, Record<string, any>>} */
        let libraries = {};
        /** @type {number | null} */
        let exitCode = null;

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

        // Registers, reached through configuration rather than by requiring the
        // cpu layer: win32 does not depend on it and should not start to. What
        // needs them is exception handling, which hands a program a context and
        // continues execution from a changed one.
        const cpuRegisters = config?.registers ?? { read: ()=>0, write: ()=>{} };
        const readWideString = (/** @type {number} */ address, /** @type {number} */ maxLength)=>
            memory.readWideString(address, maxLength);

        /** Everything a table needs from the kernel's handle table. */
        const handles = {
            /** @param {string} type @param {any} object */
            open: (type, object)=>kernel.handles.open(type, object),
            /** @param {number} handle @param {string} [type] */
            resolve: (handle, type)=>kernel.handles.resolve(handle, type),
            /** @param {number} handle */
            close: handle=>kernel.handles.close(handle),
            /** @param {number} handle */
            typeOf: handle=>kernel.handles.typeOf(handle),
        };

        const { setError } = createThreadState(()=>kernel.currentThread());
        // Absent unless a bundle is mounted, in which case a read of a block
        // that is not here yet becomes a wait rather than a fault.
        const volume = createVolume(filesystem, config?.fetchBlocks ?? null);
        const hive = createHive();
        const queue = createMessageQueue();
        const com = createComRegistry();

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

        // The transport is injected, as the GPU device and the block store are.
        // Without one this is a machine with a network card and no cable: every
        // call behaves, and nothing reaches anywhere.
        const winsock = createWinsockFunctions({
            readMemory,
            writeMemory,
            readCString,
            heap,
            currentThread: ()=>kernel.currentThread(),
            registry: createSocketRegistry({
                adapter: config?.network ?? createLoopbackAdapter(),
            }),
        });

        // Structured exception handling. Everything it needs now exists: the
        // chain's head lives in the thread block at FS:[0], and a processor
        // fault is reported with its vector rather than stopping the machine.
        const registerNames = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip'];
        const seh = createSeh({
            readMemory,
            writeMemory,
            /** @param {number} address */
            isMapped: address=>memory.find(address) !== null,
            teb: ()=>kernel.currentThread()?.tebAddress ?? 0,
            registers: ()=>Object.fromEntries(
                registerNames.map(name=>[name, cpuRegisters.read(name)])),
            /** @param {Record<string, number>} values */
            setRegisters: values=>{
                for (const [name, value] of Object.entries(values))
                {
                    cpuRegisters.write(name, value >>> 0);
                }
            },
            /** @param {any} call */
            callGuest: call=>bridge.callGuest(call),
            /** @param {string} text */
            trace: text=>trace(text),
        });

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
                    writeMemory,
                    setLastError: setError,
                    currentThread: ()=>kernel.currentThread(),
                    park: (/** @type {any} */ thread)=>bridge.park(thread),
                    /** @param {number} handle */
                    handleType: handle=>kernel.handles.typeOf(handle),
                }),
                ...createDebugFunctions({
                    readCString,
                    readWideString: (address, maxLength)=>
                        memory.readWideString(address, maxLength),
                    say: text=>trace(text),
                }),
                ...createHeapFunctions({
                    arena, allocator, readMemory, writeMemory,
                    setLastError: setError,
                    /** @param {number} address */
                    regionAt: address=>memory.find(address),
                }),
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
                ...createSyncFunctions({
                    kernel,
                    readMemory,
                    writeMemory,
                    currentThread: ()=>kernel.currentThread(),
                    park: (/** @type {any} */ thread)=>bridge.park(thread),
                    advanceClock: (/** @type {number} */ ms)=>kernel.clock.advance(ms),
                }),
                ...createLocaleFunctions({
                    readMemory, writeMemory,
                    setLastError: setError,
                    systemTimeMs: ()=>kernel.clock.wallClock(),
                }),
                ...createResourceFunctions({
                    readCString,
                    setLastError: setError,
                    /** @param {number} instance @param {any} type @param {any} name */
                    findResource: (instance, type, name)=>
                        modules.findResource?.(instance, type, name) ?? null,
                    /** @param {number} instance */
                    moduleBase: instance=>modules.moduleBase?.(instance) ?? 0,
                }),
                ...createDriveFunctions({
                    readCString, readWideString, readMemory, writeMemory,
                    setLastError: setError,
                    drives: ()=>filesystem.drives(),
                }),
                ...createMappingFunctions({
                    readMemory,
                    writeMemory,
                    setLastError: setError,
                    /** @param {number} bytes */
                    allocate: bytes=>allocator.allocate(bytes),
                    /** @param {number} address */
                    release: address=>allocator.free(address),
                    /** @param {number} ms */
                    advanceClock: ms=>kernel.clock.advance(ms),
                    handles,
                    files: {
                        /**
                         * A mapping is read here, at map time, rather than on
                         * every access -- so a block that is not resident yet
                         * would be a promise, and this call cannot wait. The
                         * mapping layer is told, and refuses rather than
                         * handing the guest a promise it cannot use.
                         *
                         * @param {any} node @param {number} offset @param {number} length
                         */
                        read: (node, offset, length)=>{
                            const bytes = volume.read(node, offset, length);
                            return bytes instanceof Promise ? null : bytes;
                        },
                        /** @param {any} node @param {number} offset @param {Uint8Array} bytes */
                        write: (node, offset, bytes)=>volume.write(node, offset, bytes),
                    },
                }),
                ...createFileTimeFunctions({
                    readMemory,
                    writeMemory,
                    setLastError: setError,
                    /** @param {number} handle @param {string} [type] */
                    resolveHandle: (handle, type)=>kernel.handles.resolve(handle, type),
                    /** @param {string} path */
                    stat: path=>filesystem.stat(path),
                }),
                ...createConsoleIoFunctions({
                    readMemory,
                    writeMemory,
                    setLastError: setError,
                    write: (/** @type {number} */ handle, /** @type {string} */ text)=>
                        sink(handle, text),
                }),
                ...createEnvironmentFunctions({
                    readCString,
                    readWideString,
                    writeMemory,
                    setLastError: setError,
                    allocate: bytes=>allocator.allocate(bytes),
                    // What a program believes it was started with. Kept stable
                    // because the pointer is handed out once and callers keep it.
                    commandLine: ()=>config?.commandLine ?? `"${modules.imagePath()}"`,
                    environment: ()=>config?.environment ?? {
                        SystemRoot: 'C:\\WINDOWS',
                        TEMP: 'C:\\WINDOWS\\TEMP',
                        windir: 'C:\\WINDOWS',
                    },
                }),
                ...createSystemFunctions({
                    readMemory,
                    writeMemory,
                    setLastError: setError,
                    systemTimeMs: ()=>kernel.clock.wallClock(),
                    /** @param {number} bytes */
                    allocate: bytes=>allocator.allocate(bytes),
                    park: ()=>bridge.park(),
                    resolveHandle: (/** @type {number} */ handle,
                        /** @type {string | undefined} */ type)=>
                        kernel.handles.resolve(handle, type),
                    exit: code=>{
                        exitCode = code >>> 0;
                    },
                }),
                // Placed after the throwing pair it replaces: RaiseException and
                // RtlUnwind are defined by not returning, and now there is a
                // chain to walk they can do that properly.
                ...createExceptionFunctions({ readMemory }),
                ...seh.table,
                ...createModuleFunctions({
                    readCString,
                    readWideString,
                    writeMemory,
                    find: name=>modules.find(name),
                    byBase: base=>modules.byBase(base),
                    setLastError: setError,
                    imagePath: ()=>modules.imagePath(),
                    /** @param {any} asked */
                    resolved: asked=>modules.resolved?.(asked),
                }),
                // Last, deliberately: writing and closing a handle are the same
                // entry points for a file as for a console or an event, and the
                // one that knows about files answers for all of them.
                ...createFileFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    readWideString,
                    files: volume,
                    setLastError: setError,
                    writeConsole: (handle, text)=>sink(handle, text),
                    handles,
                }),
            },

            'msvcrt.dll': {
                ...createCrtSeh({
                    readMemory,
                    writeMemory,
                    /** @param {number} address */
                    isMapped: address=>memory.find(address) !== null,
                    registers: ()=>Object.fromEntries(
                        registerNames.map(name=>[name, cpuRegisters.read(name)])),
                    /** @param {Record<string, number>} values */
                    setRegisters: values=>{
                        for (const [name, value] of Object.entries(values))
                        {
                            cpuRegisters.write(name, value >>> 0);
                        }
                    },
                    /** @param {any} call */
                    callGuest: call=>bridge.callGuest(call),
                    unwind: seh.unwind,
                }).table,
                ...createMsvcrtFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    write: (handle, text)=>sink(handle, text),
                    callGuest: (entry, args)=>bridge.callGuest({ entry, args }),
                    // One allocator behind malloc and HeapAlloc alike: a C++
                    // program frees with `delete` what a library function
                    // allocated with `malloc`, and Windows lets it.
                    allocate: bytes=>allocator.allocate(bytes),
                    free: address=>allocator.free(address),
                    block: address=>allocator.block(address),
                    resize: (address, bytes)=>allocator.resize(address, bytes),
                    systemTimeMs: ()=>kernel.clock.wallClock(),
                    now: ()=>kernel.clock.virtualTime(),
                    files: volume,
                }),
            },

            // One registry behind all three, as on a real machine: a socket
            // opened through one of these names is the same socket seen through
            // another, and they share one error domain.
            'WSOCK32.dll': winsock.sockets,
            'WS2_32.dll': winsock.sockets,
            'MSWSOCK.dll': winsock.extensions,

            'WINMM.dll': createWinmmFunctions({
                readMemory,
                writeMemory,
                // The guest's clock, never the host's. A frame loop that timed
                // an interval with one and read it with another would disagree
                // with itself about how long its own frame took.
                now: ()=>kernel.clock.virtualTime(),
            }),

            'COMCTL32.dll': createComctlFunctions({ readMemory, writeMemory }),

            'SHELL32.dll': createShellFunctions({ writeMemory }),

            'VERSION.dll': createVersionFunctions({
                readMemory,
                writeMemory,
                readCString,
                setLastError: setError,
                /** @param {string} path */
                versionInfo: path=>modules.versionInfo?.(path) ?? null,
            }),

            'COMDLG32.dll': createCommonDialogFunctions({ readMemory }),

            'IMM32.dll': createImmFunctions({ writeMemory }),

            'USER32.dll': createWindowFunctions({
                readMemory,
                writeMemory,
                readCString,
                handles,
                queue,
                dispatch: (wndProc, message)=>bridge.callGuest({
                    entry: wndProc,
                    // The four arguments a window procedure declares, in order.
                    args: [message.hwnd, message.message, message.wParam, message.lParam],
                }),
                park: ()=>bridge.park(),
                idle,
                created: config?.created ?? (()=>{}),
                /** @param {number} instance @param {number} id */
                loadString: (instance, id)=>modules.loadString?.(instance, id) ?? null,
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

        const api = {
            /** @returns {Record<string, Record<string, any>>} library name -> its exports */
            libraries: ()=>libraries,

            /**
             * Which ordinal is which export, for the libraries that have them.
             *
             * A library is imported by ordinal or by name, and some are only
             * ever imported by number -- there is no name in the descriptor to
             * fall back on. Whoever synthesises a module has to be told, because
             * an ordinal it assigns itself is not the one the program compiled
             * against.
             *
             * @returns {Record<string, Record<number, string>>}
             */
            ordinals: ()=>({
                'WSOCK32.dll': winsock.ordinals.wsock32,
                'WS2_32.dll': winsock.ordinals.ws2_32,
            }),

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

            /**
             * The one allocator the whole process draws from.
             *
             * Handed out because a layer that puts bytes where a guest will
             * read them -- a sound buffer it locks and writes through -- has to
             * take them from the same free list as everything else, or two
             * allocators hand out the same address.
             */
            heap: ()=>heap,

            /** Set once the guest has asked to terminate. */
            exitCode: ()=>exitCode,
        };

        current = api;
        return api;
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        /** @type {Record<string, Record<string, any>>} */
        const held = current ? current.libraries() : {};
        const counts = Object.fromEntries(
            Object.entries(held).map(([name, table])=>[name, Object.keys(table).length]));
        return {
            name: 'win32',
            version: '0.2.0',
            status: Object.keys(held).length > 0 ? 'ready' : 'created',
            metrics: {
                libraries: counts,
                implemented: Object.values(held)
                    .reduce((total, table)=>total + Object.keys(table).length, 0),
                exitCode: current ? current.exitCode() : null,
            },
        };
    },

    async dispose(){
        current = null;
    },
};
