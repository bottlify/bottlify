/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createConsoleFunctions } from './kernel32/console.js';
import { createThreadingFunctions } from './kernel32/threading.js';
import { createDebugFunctions } from './kernel32/debug.js';
import { createHeapAllocator, createHeapFunctions } from './kernel32/heap.js';
import { createProcessFunctions, createThreadState } from './kernel32/process.js';
import { TEB } from './kernel32/teb.js';
import { createModuleFunctions } from './kernel32/modules.js';
import { createFileFunctions } from './kernel32/files.js';
import { createSyncFunctions } from './kernel32/sync.js';
import { createCriticalSections } from './kernel32/critical.js';
import { createLocaleFunctions } from './kernel32/locale.js';
import { createEnvironmentFunctions } from './kernel32/environment.js';
import { createSystemFunctions } from './kernel32/system.js';
import { createSpawnFunctions } from './kernel32/spawn.js';
import { createExceptionFunctions } from './kernel32/exceptions.js';
import { createSeh } from './kernel32/seh.js';
import { createCrtSeh } from './msvcrt/seh.js';
import { createResourceFunctions } from './kernel32/resources.js';
import { createDriveFunctions } from './kernel32/drives.js';
import { createMappingFunctions } from './kernel32/mapping.js';
import { createIoCompletionPorts } from './kernel32/iocp.js';
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
import { createWaveNotifier } from './winmm/notify.js';
import { createNoticeThread } from './winmm/thread.js';
import { createComctlFunctions } from './comctl32/functions.js';
import { createShellFunctions } from './shell32/functions.js';
import { createVersionFunctions } from './version/functions.js';
import { createCommonDialogFunctions } from './comdlg32/functions.js';
import { createImmFunctions } from './imm32/functions.js';
import { createWininetFunctions } from './wininet/functions.js';
import { createOleFunctions } from './ole32/functions.js';
import { createAutomationFunctions, OLEAUT32_ORDINALS } from './oleaut32/functions.js';
import { createNtdllFunctions } from './ntdll/functions.js';
import { createComRegistry } from './ole32/objects.js';
import { registerQuartzClasses } from './quartz/graph.js';

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

        /**
         * Writes back a set of registers, for the entry points whose answer is
         * a register rather than a return value -- exception handling continuing
         * from a changed context, and the arithmetic helpers that answer in a
         * pair.
         *
         * @param {Record<string, number>} values
         */
        const setRegisters = values=>{
            for (const [name, value] of Object.entries(values))
            {
                cpuRegisters.write(name, value >>> 0);
            }
        };
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

        const { setError, lastErrorOf, setErrorOn: setErrorOnBlock } = createThreadState(
            ()=>kernel.currentThread(),
            { readU32: memory.readU32, writeU32: memory.writeU32 });
        // Absent unless a bundle is mounted, in which case a read of a block
        // that is not here yet becomes a wait rather than a fault.
        const volume = createVolume(filesystem, config?.fetchBlocks ?? null);
        const hive = createHive();
        // The guest's clock, because a timer is due against the clock the
        // program itself reads.
        const queue = createMessageQueue({ now: ()=>kernel.clock.virtualTime() });

        /**
         * Where a thread's start routine returns to.
         *
         * Returning is how most threads end, and it means what calling
         * ExitThread with the same value means -- the routine's answer is the
         * thread's exit code, which is why the stub keeps EAX. Without
         * somewhere that notices, a returned thread sits on the park loop,
         * stays runnable for ever, is chosen every turn, retires no
         * instructions and never lets go of anything it holds.
         *
         * @type {number | null}
         */
        let threadReturnStub = null;
        const threadReturnAddress = ()=>{
            threadReturnStub ??= bridge.register('<thread-returned>', {
                argBytes: 0,
                // Reached by a `ret`, so the answer is already in EAX and the
                // trap needs EAX for itself; the stub moves it to ECX first.
                preserveResult: true,
                handler: ()=>{
                    const thread = kernel.currentThread();
                    kernel.exitThread(thread, cpuRegisters.read('ecx') >>> 0);
                    return bridge.park(thread);
                },
            });
            return threadReturnStub ?? 0;
        };
        const com = createComRegistry();

        /**
         * The last error of a thread that is not the one running.
         *
         * A call that parked has no turn left in which to record its own result,
         * so whoever wakes it writes the code for it -- the same handoff a
         * critical section makes when the thread that leaves publishes the
         * structure for the thread it just handed the section to.
         *
         * @param {any} thread @param {number} code
         */
        const setErrorOn = (thread, code)=>{
            if (thread)
            {
                setErrorOnBlock(thread, code);
            }
        };

        // Built before the tables because two of them need it: the completion
        // port a program waits on, and the file calls that owe it a packet when
        // an overlapped read or write finishes.
        const ports = createIoCompletionPorts({
            kernel,
            readMemory,
            writeMemory,
            setLastError: setError,
            setLastErrorFor: setErrorOn,
            currentThread: ()=>kernel.currentThread(),
            park: ()=>bridge.park(),
            // A stale or mistyped hEvent is the program's mistake and not ours
            // to fault on: resolving throws, and a completion should not stop
            // the machine over the half of itself nobody is waiting on.
            /** @param {number} handle */
            signalEvent: handle=>{
                try
                {
                    kernel.setEvent(kernel.handles.resolve(handle, 'event'));
                }
                catch (e){
                    void e;
                }
            },
            /** @param {string} text */
            trace: text=>trace(text),
        });

        /**
         * What a window procedure is inside and has not returned from.
         *
         * @type {{ hwnd: number, message: number, at: number }[]}
         */
        const dispatching = [];

        // Registered here rather than by the graphics layer, because a filter
        // graph is not a drawing device: a program reaches it through
        // CoCreateInstance alone, and everything it does -- events, a notify
        // window, a state machine -- is already in reach from this layer.
        // The graph keeps the state machine and the COM surface; what decodes
        // and what shows a frame belong to layers this one may not reach, so
        // both arrive as thunks and `tick` goes back out to whoever drives the
        // machine.
        const quartz = registerQuartzClasses(com, {
            writeMemory,
            /** @param {import('./user32/messages.js').PostedMessage} message */
            post: message=>queue.post(message),
            /** @param {number} address @param {number} maxLength */
            readWideString: (address, maxLength)=>readWideString(address, maxLength),
            video: config?.video,
            divergence: config?.divergence,
        });

        // One allocator over the whole arena. Everything the guest is handed
        // memory from -- the heap it asks for, the bits of a DIB section, COM
        // task memory, a vtable -- comes out of the same free list, because
        // carving it up in advance is guessing at proportions nobody knows.
        const allocator = createHeapAllocator(arena);
        // Counted by the mapping calls as they go.
        const mappings = { views: 0, waited: 0, failed: 0 };
        const heap = {
            /** @param {number} bytes */
            allocate: bytes=>allocator.allocate(bytes),
            /** @param {number} address */
            free: address=>allocator.free(address),
            /** @param {number} address */
            block: address=>allocator.block(address),
            /** @param {number} address @param {number} bytes */
            resize: (address, bytes)=>allocator.resize(address, bytes),
            // What is left of it. A program sizes its own caches from this
            // through GlobalMemoryStatus, so anything that takes from the arena
            // and does not give back changes how the program behaves.
            diagnostics: ()=>allocator.diagnostics(),
        };
        bridge.useHeap(heap);

        // Built here rather than with the other tables because two things need
        // it: the library a program links against, and the drawing layer, which
        // asks it for a device context over pixels GDI did not allocate.
        const gdi = createGdiFunctions({
            readMemory,
            writeMemory,
            readCString,
            handles: {
                /** @param {string} type @param {any} object */
                open: (type, object)=>kernel.handles.open(type, object),
                /** @param {number} handle */
                close: handle=>kernel.handles.close(handle),
            },
            surfaces: heap,
            // The display every device metric is derived from. It is the same
            // screen the drawing layer is configured with: a program that asks
            // GDI how big the desktop is and then creates a device that size
            // must not be told two different things.
            screen: config?.screen,
            // Where pixels go, and which pixel formats exist. The graphics
            // layer is above this one and cannot be imported from here, so the
            // assembling caller hands it down -- and reads it lazily, because
            // graphics is created after win32 and does not exist yet when this
            // configuration is read.
            graphics: config?.graphics,
        });

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

        // The host's half of a critical section: the queue behind a contended
        // one and the hand-off that wakes it. The rest is guest code.
        const critical = createCriticalSections({
            readMemory,
            writeMemory,
            currentThread: ()=>kernel.currentThread(),
            /** @param {any} thread @param {string} reason */
            block: (thread, reason)=>kernel.block(thread, reason),
            /** @param {any} thread @param {number} [result] */
            wake: (thread, result)=>kernel.wake(thread, result),
            /** @param {any} thread */
            park: thread=>bridge.park(thread),
            /** @param {number} bytes */
            allocate: bytes=>heap.allocate(bytes),
        });

        // The thread a wave device's WOM_DONE callbacks run on. Made on first
        // use: a build whose program never asks for the callback form pays for
        // no thread, no stub and no code.
        const waveNotices = createNoticeThread({
            /** @param {number} bytes */
            allocate: bytes=>heap.allocate(bytes),
            writeMemory,
            register: (name, fn)=>bridge.register(name, fn),
            /** @param {{ entry: number, name: string }} options */
            createThread: options=>{
                const thread = kernel.createThread(options);
                config?.threadBlock?.(thread);
                return thread;
            },
            currentThread: ()=>kernel.currentThread(),
            /** @param {any} thread @param {string} reason */
            block: (thread, reason)=>kernel.block(thread, reason),
            /** @param {any} thread @param {number} result */
            wake: (thread, result)=>kernel.wake(thread, result),
            /** @param {any} thread */
            park: thread=>bridge.park(thread),
        });

        // Built here rather than with the other tables because two things need
        // it: the library a program links against, and whoever drives the
        // machine, which has to move the play cursor from outside a guest call.
        const winmm = createWinmmFunctions({
            readMemory,
            writeMemory,
            // The guest's clock, never the host's. A frame loop that timed an
            // interval with one and read it with another would disagree with
            // itself about how long its own frame took.
            now: ()=>kernel.clock.virtualTime(),
            // Where the samples go, when anything is listening. The audio layer
            // is above this one and cannot be imported from here, so the
            // assembling caller hands it down -- as a thunk, because audio is
            // built after win32 and does not exist yet when this configuration
            // is read.
            output: config?.output,
            // Honouring what waveOutOpen was asked for. A program that asked to
            // be called back does not poll the flags, so accepting the request
            // and never delivering it leaves it waiting for something that
            // cannot arrive.
            // Whose call is being answered. Read before anything is awaited and
            // carried through, because a notice delivered after one goes to
            // whoever is current then -- and a callback built on a stranger's
            // stack is a crash with no author.
            currentThread: ()=>kernel.currentThread(),
            // The one notice that must not run on the caller. The routine's
            // five arguments, in the order it declares them.
            deliverDone: notice=>waveNotices.deliver(notice.target,
                [notice.device, notice.message, notice.instance, notice.param, 0]),
            notify: createWaveNotifier({
                /**
                 * @param {number} entry @param {number[]} args @param {any} [thread]
                 */
                callGuest: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                /** @param {import('./user32/messages.js').PostedMessage} message */
                post: message=>queue.post(message),
                // A stale or mistyped handle is the program's mistake and not
                // ours to fault on: resolving throws, and nothing an audio
                // device does should stop the machine.
                /** @param {number} handle */
                signal: handle=>{
                    try
                    {
                        kernel.setEvent(kernel.handles.resolve(handle, 'event'));
                    }
                    catch (e){
                        void e;
                    }
                },
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
            setRegisters,
            /** @param {any} call */
            callGuest: call=>bridge.callGuest(call),
            currentThread: ()=>kernel.currentThread(),
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
                    readCString,
                    writeMemory,
                    setLastError: setError,
                    currentThread: ()=>kernel.currentThread(),
                    park: (/** @type {any} */ thread)=>bridge.park(thread),
                    // Where a start routine returns to. Registered once, the
                    // first time a thread is made, because registering it costs
                    // a stub and a build that never makes a thread needs none.
                    threadReturn: ()=>threadReturnAddress(),
                    // Every thread gets a block of its own, made by whoever
                    // owns the process's, which win32 is only handed.
                    threadBlock: config?.threadBlock,
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
                    divergence: config?.divergence,
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
                    // A real wait: the thread stops and the scheduler moves the
                    // guest's clock when nothing else can run.
                    /** @param {number} milliseconds */
                    sleep: milliseconds=>kernel.sleep(kernel.currentThread(), milliseconds),
                    park: ()=>bridge.park(),
                    // Where the running thread keeps its TLS slots, read out of
                    // its own block rather than tracked here: the block is the
                    // loader's to place, and reading it back cannot drift from
                    // what the guest reaches through FS.
                    tlsBlock: ()=>{
                        const teb = kernel.currentThread()?.tebAddress ?? 0;
                        return teb === 0 ? 0 : memory.readU32(teb + TEB.TLS_POINTER);
                    },
                    allThreads: ()=>kernel.threads(),
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                }),
                ...createSyncFunctions({
                    kernel,
                    readMemory,
                    writeMemory,
                    currentThread: ()=>kernel.currentThread(),
                    park: (/** @type {any} */ thread)=>bridge.park(thread),
                    critical,
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
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
                    metrics: mappings,
                    /** @param {number} bytes */
                    allocate: bytes=>allocator.allocate(bytes),
                    /** @param {number} address */
                    release: address=>allocator.free(address),
                    handles,
                    files: {
                        /**
                         * A mapping is read here, at map time, rather than on
                         * every access; a block that is not resident yet is a
                         * promise, and the mapping layer parks the caller on
                         * it, as a read does.
                         *
                         * @param {any} node @param {number} offset @param {number} length
                         */
                        read: (node, offset, length)=>volume.read(node, offset, length),
                        /** @param {any} node @param {number} offset @param {Uint8Array} bytes */
                        write: (node, offset, bytes)=>volume.write(node, offset, bytes),
                    },
                    currentThread: ()=>kernel.currentThread(),
                    setLastErrorFor: setErrorOn,
                }),
                ...ports.table,
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
                ...createSpawnFunctions({
                    kernel,
                    readMemory,
                    writeMemory,
                    readCString,
                    readWideString,
                    setLastError: setError,
                    /** @param {string} path */
                    stat: path=>volume.stat(path),
                    imagePath: ()=>modules.imagePath(),
                    // Where the record of a replacement request goes. It has to
                    // leave this process, because honouring one erases every
                    // log and ring the run that asked for it produced.
                    /** @param {any} request */
                    spawned: request=>config?.spawned?.(request),
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
                    // Reading a library off the volume belongs to whoever
                    // assembled the process, so it is passed straight through.
                    // Without it LoadLibrary can only answer for what is
                    // already mapped, and a program asking for a library it
                    // ships is told the module does not exist.
                    /** @param {string} name */
                    load: name=>modules.load?.(name) ?? 0,
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
                    currentThread: ()=>kernel.currentThread(),
                    setLastErrorFor: setErrorOn,
                    ports: {
                        /** @param {number} overlapped */
                        offsetOf: overlapped=>ports.offsetOf(overlapped),
                        /** @param {number} file @param {number} n @param {number} overlapped */
                        completed: (file, n, overlapped)=>ports.completed(file, n, overlapped),
                        /** @param {number} handle @param {any} object */
                        closed: (handle, object)=>ports.closed(handle, object),
                    },
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
                    setRegisters,
                    /** @param {any} call */
                    callGuest: call=>bridge.callGuest(call),
                    currentThread: ()=>kernel.currentThread(),
                    unwind: seh.unwind,
                }).table,
                ...createMsvcrtFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    write: (handle, text)=>sink(handle, text),
                    /**
                      * @param {number} entry @param {number[]} args @param {any} [thread]
                      */
                    callGuest: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    currentThread: ()=>kernel.currentThread(),
                    // One allocator behind malloc and HeapAlloc alike: a C++
                    // program frees with `delete` what a library function
                    // allocated with `malloc`, and Windows lets it.
                    allocate: bytes=>allocator.allocate(bytes),
                    free: address=>allocator.free(address),
                    block: address=>allocator.block(address),
                    resize: (address, bytes)=>allocator.resize(address, bytes),
                    systemTimeMs: ()=>kernel.clock.wallClock(),
                    now: ()=>kernel.clock.virtualTime(),
                    // The same command line GetCommandLineA reports, because a
                    // program is free to read either and compare them.
                    commandLine: ()=>config?.commandLine ?? `"${modules.imagePath()}"`,
                    // `exit` does not come back, so like ExitProcess it records
                    // the code and parks the calling thread rather than
                    // returning to a caller that no longer exists.
                    exitProcess: (/** @type {number} */ code)=>{
                        exitCode = code;
                        return bridge.park();
                    },
                    files: volume,
                    // The same set GetLogicalDrives reports, from the same
                    // place: a program populates its drive list from whichever
                    // of the two it happens to call.
                    drives: ()=>filesystem.drives(),
                    // Without this the functions returning a double are not
                    // exported at all, and an unresolved import names the one
                    // that is missing. Exported without it they would set a
                    // register the caller never reads and leave it storing
                    // whatever was on the floating-point stack already.
                    fpu: config?.fpu,
                }),
            },

            // One registry behind all three, as on a real machine: a socket
            // opened through one of these names is the same socket seen through
            // another, and they share one error domain.
            'WSOCK32.dll': winsock.sockets,
            'WS2_32.dll': winsock.sockets,
            'MSWSOCK.dll': winsock.extensions,

            'WINMM.dll': winmm.table,

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

            // The transport is the assembling caller's to supply and is absent
            // by default: this build has no network, and the entry points say
            // so rather than pretending a request failed for some other reason.
            // The library is published either way, because a program that
            // imports it and never uses it -- which is the common case -- must
            // still be able to load.
            'WININET.dll': createWininetFunctions({
                readMemory, writeMemory, readCString, setLastError: setError,
                request: config?.http ?? null,
                divergence: config?.divergence,
            }),

            'USER32.dll': createWindowFunctions({
                readMemory,
                writeMemory,
                readCString,
                handles,
                queue,
                // What GetSystemMetrics and EnumDisplaySettings answer with.
                // The same screen GDI and the drawing layer are given: a
                // program picks its mode from this and would otherwise be
                // offered one the device it then creates does not have.
                screen: config?.screen,
                dispatching,
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
                /** @param {number} instance @param {number} type @param {number | string} name */
                findResource: (instance, type, name)=>
                    modules.findResource?.(instance, type, name) ?? null,
                // Where the pointer is and what is held down. The input layer
                // is above this one and cannot be imported from here, so both
                // are handed down as thunks; a build without one answers what
                // it answered before, which is that nothing is pressed.
                cursor: config?.cursor,
                keyState: config?.keyState,
                // The cursor space a program declares with ClipCursor, handed
                // down the same way and for the same reason: the input layer
                // that scales pointer motion into it sits above this one.
                clipCursor: config?.clipCursor,
                // Where a window's device context comes from. GDI owns the
                // contexts and lives in this same module, so user32's GetDC is
                // GDI's under the window's name: a program that takes a DC on
                // its window to ask the display about itself must get one, or
                // it reads a null context's answers as facts about the screen.
                dc: ()=>({
                    /** @param {number} hwnd */
                    get: hwnd=>gdi.table.GetDC.handler([hwnd]),
                    /** @param {number} hwnd @param {number} hdc */
                    release: (hwnd, hdc)=>gdi.table.ReleaseDC.handler([hwnd, hdc]),
                }),
                // A program's own explanation of why it is stopping, handed up
                // whole rather than as a line of log, so whoever is embedding
                // this engine can show it the way a person would have seen it.
                /** @param {any} notice */
                messageBox: notice=>config?.onMessageBox?.(notice),
                say: (/** @type {string} */ text)=>trace(text),
                // A CREATESTRUCT has to live where the guest can read it, and
                // only for the length of the two messages that carry it.
                /** @param {number} bytes */
                allocate: bytes=>heap.allocate(bytes),
                /** @param {number} address */
                release: address=>heap.free(address),
            }),

            'ADVAPI32.dll': createRegistryFunctions({
                readMemory,
                writeMemory,
                readCString,
                hive,
                setLastError: setError,
                // A SID has to live where a program can compare it byte by byte.
                /** @param {number} bytes */
                allocate: bytes=>heap.allocate(bytes),
            }),

            'GDI32.dll': gdi.table,

            'ole32.dll': createOleFunctions({
                readMemory,
                writeMemory,
                currentThread: ()=>kernel.currentThread(),
                heap,
                registry: com,
                divergence: config?.divergence,
                vtables: {
                    /** @param {any} object @param {string} interfaceId */
                    publish: (object, interfaceId)=>
                        bridge.publishInterface(object, interfaceId),
                },
            }),

            'OLEAUT32.dll': createAutomationFunctions({
                readMemory,
                writeMemory,
                heap,
                divergence: config?.divergence,
            }),
        };

        // Added after the rest because it is built from them: nearly everything
        // ntdll exports is a second name for a function another library already
        // publishes, and it has to be the same entry rather than a second
        // implementation. The heap is the clearest case -- kernel32's owns the
        // process-heap handle and the tag on every block, so a separate one
        // would reject the very handle GetProcessHeap hands out.
        libraries['ntdll.dll'] = createNtdllFunctions({
            readMemory,
            writeMemory,
            readCString,
            readWideString,
            kernel32: libraries['KERNEL32.dll'],
            crt: libraries['msvcrt.dll'],
            teb: ()=>kernel.currentThread()?.tebAddress ?? 0,
            arena,
            setRegisters,
        });

        /** Every function, whichever library exports it. */
        const flat = ()=>Object.assign({}, ...Object.values(libraries));

        const api = {
            /** @returns {Record<string, Record<string, any>>} library name -> its exports */
            libraries: ()=>libraries,

            /**
             * Device contexts over pixels this layer did not allocate.
             *
             * Not part of any library, because no program calls it: it is how a
             * drawing surface owned elsewhere becomes something GDI can draw
             * into, which is what a program is really asking for when it takes
             * a device context on a surface and then uses GDI on it.
             */
            gdi: ()=>({
                /** @param {any} attributes */
                createSurfaceDc: attributes=>gdi.createSurfaceDc(attributes),
                /** @param {number} handle */
                deleteSurfaceDc: handle=>gdi.deleteSurfaceDc(handle),
            }),

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
                // Automation is imported this way and no other: a program links
                // it through numbers, with no name in the import table at all.
                'OLEAUT32.dll': OLEAUT32_ORDINALS,
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

            /**
             * Moves every open wave device's play cursor.
             *
             * Called by whoever drives the machine, on its own schedule, because
             * nothing inside the guest will: the cursor advances only while a
             * winmm entry point is running, and a program waiting for a buffer
             * by spinning on WHDR_DONE in its own header calls nothing at all.
             * Without this that wait cannot end.
             */
            waveTick: ()=>winmm.tick(),

            /**
             * Moves every playing filter graph to `nowMs` and hands back the
             * frame to show, with whatever sound came with it.
             *
             * Out here rather than inside, for the same reason the wave cursor
             * is: nothing in the guest advances a film, and what a frame is
             * shown on belongs to the graphics layer, which this one may not
             * reach.
             *
             * @param {number} nowMs
             * @param {number | null} [soundOwedMs]
             *        Milliseconds of the running film's sound handed over and
             *        not played yet, which is what holds the picture back to
             *        it. Only whoever plays it knows.
             */
            videoTick: (nowMs, soundOwedMs)=>quartz.tick(nowMs, soundOwedMs ?? null),

            /** The registry, whose contents outlive the process (§9). */
            registry: ()=>hive,

            // The running thread's last error, for whoever is tracing. A
            // program reports a code long after the call that produced it has
            // returned, and without this nothing ties the two together.
            // Zero when there is no thread to ask: a call that ends its own
            // thread is still on the stack when this is read, and a thread that
            // has gone has no last error rather than an unknown one.
            lastError: ()=>(kernel.currentThread() ? lastErrorOf() : 0),

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
            /** Views of files: how many were mapped, waited for their bytes, or failed. */
            mappings: ()=>mappings,

            /**
             * Which threads are parked on a completion port, and for how long.
             *
             * A program whose workers are all waiting for a packet looks exactly
             * like an idle one from outside -- nothing runs, and nothing says
             * why. This is the difference, and reading it is also what notices a
             * wait long enough to be a completion somebody forgot to post.
             */
            ioCompletionWaits: ()=>ports.snapshot(),

            /**
             * What every open wave device is doing.
             *
             * The same difference as above, for sound: a program stopped
             * because a buffer never came back is inside its own wait, and from
             * outside the machine merely looks slow.
             */
            waveDevices: ()=>winmm.diagnostics(),
            /** The thread those devices call back on: whether it exists, and what it is doing. */
            waveThread: ()=>waveNotices.diagnostics(),
            /**
             * How many sections were entered and left without crossing into
             * the host, and how many crossings the contended ones cost.
             */
            criticalSections: ()=>critical.diagnostics(),

            /**
             * What the program's message loop is pumping, and what it is
             * waiting for.
             *
             * A loop that spends a third of every frame waiting is waiting for
             * one particular thing, and a count of messages does not say which.
             */
            messages: ()=>queue.diagnostics(),

            /**
             * Which messages a window procedure is still inside.
             *
             * The same difference again, for the message loop: a procedure that
             * does not return stops the thread that pumps the queue and with it
             * the whole program, and the call log cannot show it -- a call is
             * written when it answers, so the one holding everything is the one
             * missing.
             */
            windowProcedures: ()=>dispatching.map(held=>({
                hwnd: `0x${held.hwnd.toString(16)}`,
                message: `0x${held.message.toString(16)}`,
                forMs: Date.now() - held.at,
            })),

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
                ioCompletionWaits: current ? current.ioCompletionWaits() : [],
                waveDevices: current ? current.waveDevices() : [],
                waveThread: current ? current.waveThread() : null,
                criticalSections: current ? current.criticalSections() : null,
                messages: current ? current.messages() : {},
                // What is left of the one arena everything the guest is handed
                // comes out of. A program sizes its own caches from this, so a
                // layer that takes from it and never gives back does not merely
                // leak -- it tells the program to stop keeping things.
                heap: current ? current.heap().diagnostics() : null,
                mappings: current ? current.mappings() : null,
                windowProcedures: current ? current.windowProcedures() : [],
                exitCode: current ? current.exitCode() : null,
            },
        };
    },

    async dispose(){
        current = null;
    },
};
