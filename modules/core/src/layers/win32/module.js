/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createConsoleFunctions } from './kernel32/console.js';
import { createThreadingFunctions } from './kernel32/threading.js';
import { createNamedObjects } from './kernel32/named-objects.js';
import { createDebugFunctions } from './kernel32/debug.js';
import { createHeapAllocator, createHeapFunctions } from './kernel32/heap.js';
import { createProcessFunctions, createThreadState } from './kernel32/process.js';
import { TEB } from './kernel32/teb.js';
import { createModuleFunctions } from './kernel32/modules.js';
import { createFileFunctions } from './kernel32/files.js';
import { createSyncFunctions } from './kernel32/sync.js';
import { createCodeArena } from './kernel32/code-arena.js';
import { createCriticalSections } from './kernel32/critical.js';
import { createLocaleFunctions } from './kernel32/locale.js';
import { createEnvironmentFunctions, defaultEnvironment } from './kernel32/environment.js';
import { reportedVersion, windowsVersion } from './kernel32/versions.js';
import { createSystemFunctions } from './kernel32/system.js';
import { createSpawner, createSpawnFunctions } from './kernel32/spawn.js';
import { createAtomFunctions } from './kernel32/atoms.js';
import { createSeh } from './kernel32/seh.js';
import { createEntryPointCaller } from './kernel32/dllentry.js';
import { createCrtSeh } from './msvcrt/seh.js';
import { createCxxExceptions } from './msvcrt/eh.js';
import { createApcs } from './kernel32/apc.js';
import { createResourceFunctions } from './kernel32/resources.js';
import { createProfileFunctions } from './kernel32/profile.js';
import { createDriveFunctions } from './kernel32/drives.js';
import { createMappingFunctions } from './kernel32/mapping.js';
import { createIoCompletionPorts } from './kernel32/iocp.js';
import { createFileTimeFunctions } from './kernel32/filetime.js';
import { createConsoleIoFunctions } from './kernel32/consoleio.js';
import { createVolume } from './kernel32/vfs.js';
import { createMsvcrtFunctions } from './msvcrt/functions.js';
import { createCrtdllFunctions } from './msvcrt/crtdll.js';
import { createWindowFunctions } from './user32/windows.js';
import { createMessageQueue } from './user32/messages.js';
import { createRegistryFunctions } from './advapi32/functions.js';
import { ADMINISTRATORS_SID, createTokenFunctions, isTokenMember } from './advapi32/tokens.js';
import { createServiceFunctions } from './advapi32/services.js';
import { createCryptoFunctions } from './advapi32/crypto.js';
import { createHive, profileDirectories, shellFolders } from './advapi32/registry.js';
import { createGdiFunctions } from './gdi32/functions.js';
import { createWinsockFunctions } from './wsock32/functions.js';
import { createSocketRegistry } from './wsock32/sockets.js';
import { createLoopbackAdapter } from './wsock32/loopback.js';
import { createWinmmFunctions, WINMM_ORDINALS } from './winmm/functions.js';
import { createMmioFunctions } from './winmm/mmio.js';
import { createWaveNotifier } from './winmm/notify.js';
import { createNoticeThread } from './winmm/thread.js';
import { createTimerService } from './winmm/timers.js';
import { COMCTL32_ORDINALS, createComctlFunctions } from './comctl32/functions.js';
import { createCommonControls } from './comctl32/controls.js';
import { createImageLists } from './comctl32/imagelist.js';
import { createShellFunctions } from './shell32/functions.js';
import { registerShellLinkClasses } from './shell32/shelllink.js';
import { registerWbemClasses } from './ole32/wbem.js';
import { createRpcFunctions } from './rpcrt4/functions.js';
import { createVersionFunctions } from './version/functions.js';
import { createLzFunctions } from './lz32/functions.js';
import { createCommonDialogFunctions } from './comdlg32/functions.js';
import { createImmFunctions } from './imm32/functions.js';
import { createShlwapiFunctions } from './shlwapi/functions.js';
import { createAdvpackFunctions } from './advpack/functions.js';
import { SFC_ORDINALS, createSfcFunctions } from './sfc/functions.js';
import { createSetupapiFunctions } from './setupapi/functions.js';
import { createWintrustFunctions } from './wintrust/functions.js';
import { createD3dxFunctions } from './d3dx9/functions.js';
import { createSpoolerFunctions } from './winspool/functions.js';
import { createNetworkFunctions } from './mpr/functions.js';
import { createAcmFunctions } from './msacm32/functions.js';
import { createWininetFunctions } from './wininet/functions.js';
import { createOleFunctions, createTaskAllocator } from './ole32/functions.js';
import { createAutomationFunctions, OLEAUT32_ORDINALS } from './oleaut32/functions.js';
import { createNtdllFunctions } from './ntdll/functions.js';
import { createComObject, createComRegistry } from './ole32/objects.js';
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
 * The libraries whose undecorated exports are cdecl: the C runtime and its
 * versioned and debug siblings, `crtdll`, and the universal runtime.
 *
 * Every other library Windows ships exports stdcall, and its undecorated names
 * say nothing about how many bytes the callee pops. That is what a stub
 * standing in for an export nobody wrote has to know: a cdecl caller cleans
 * up after itself and the stub may return; a stdcall caller expects the
 * callee to, and a stub that guesses leaves the stack short by the argument
 * bytes, which surfaces as a fault several calls later. Declared here, beside
 * the tables, because it is a fact about the library and not about any one
 * name in it.
 */
const CDECL_LIBRARIES = /^(msvcrt|msvcr\d+d?|msvcp\d+d?|crtdll|ucrtbase)\.dll$/i;

/** The reason a DllMain is called with when its library is unloaded, or the process ends. */
const DLL_PROCESS_DETACH = 0;

/**
 * Every version of the D3DX 9 helper library, d3dx9_24 to d3dx9_43, bound to
 * one table: the versions' mathematics is the same, and a program imports the
 * one its SDK named.
 *
 * @param {Record<string, any>} table
 */
const d3dxLibraries = table=>Object.fromEntries(Array.from({ length: 20 },
    (_, i)=>[`d3dx9_${24 + i}.dll`, table]));

/**
 * The libraries Windows keeps under
 * `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\KnownDLLs`.
 *
 * A name in this set is mapped out of the system directory and the
 * application's own directory is never consulted for it: a program that ships
 * its own `kernel32.dll` beside itself gets the system one, which is a fact
 * about the loader rather than about any library's exports. Everything not
 * listed here -- `d3dx9_26`, `d3d9`, `dinput8`, `comctl32` and the rest -- is
 * the other way round: the program's own file, when there is one, is what
 * loads, and our table is only the fallback for a name it did not bring.
 *
 * The list is Wine's own default (`loader/wine.inf.in`, the `[KnownDLLs]`
 * registry entries), which is the same set Windows installs.
 */
const KNOWN_DLLS = new Set([
    'advapi32.dll', 'clbcatq.dll', 'combase.dll', 'comdlg32.dll', 'coml2.dll',
    'difxapi.dll', 'gdi32.dll', 'gdiplus.dll', 'imagehlp.dll', 'imm32.dll',
    'kernel32.dll', 'msctf.dll', 'msvcrt.dll', 'normaliz.dll', 'nsi.dll',
    'ole32.dll', 'oleaut32.dll', 'psapi.dll', 'rpcrt4.dll', 'sechost.dll',
    'setupapi.dll', 'shcore.dll', 'shell32.dll', 'shlwapi.dll', 'user32.dll',
    'wldap32.dll', 'wow64.dll', 'wow64cpu.dll', 'wow64win.dll', 'wowarmhw.dll',
    'ws2_32.dll', 'xtajit.dll', 'xtajit64.dll',
]);

/** The win32 layer's module for one graph; see `defaultModules`. */
export function createWin32Module(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * The module contract puts both on the module rather than on the api, so
     * something outside a `create()` call has to be able to see in. That is
     * the only reason this exists, and it holds a reference rather than the
     * state itself -- everything a running process owns lives inside its own
     * `create()`, so two of them cannot write over each other. They did: the
     * registry hive, the message queue and the COM registry were
     * module-scoped, and a second process in one realm silently took the
     * first one's.
     *
     * @type {any}
     */
    let current = null;

    return {
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
            // Before anything else: a Windows that is not one of the four is a
            // configuration error, not a machine to build.
            const windows = windowsVersion(config?.windows);
            // What the running program is told, which Windows 10 decides from
            // what the program says it knows; everything else keeps the truth.
            const reported = reportedVersion(windows, config?.compatibility);
            const folders = shellFolders(windows);

            const memory = host.requireApi('memory');
            const kernel = host.requireApi('kernel');
            const bridge = host.requireApi('bridge');
            const filesystem = host.requireApi('filesystem');
            const journal = host.requireApi('log');

            // The one namespace a mutex, event, semaphore, timer and file mapping
            // all share. Handed a table from outside when there is a process
            // replacement to survive; a caller with nothing to carry across a
            // rebuild gets one that does not.
            const namedObjects = createNamedObjects({ table: config?.namedObjects });

            /** @type {Record<string, Record<string, any>>} */
            let libraries = {};
            /** @type {number | null} */
            let exitCode = null;
            /**
             * What runs when the process ends, whichever way it ends: every handle
             * a process held closes then, which is when a file opened to be
             * deleted on close goes. Run once, after the code is recorded.
             *
             * @type {(() => void)[]}
             */
            const endTasks = [];
            const processEnded = ()=>endTasks.splice(0).forEach(task=>task());
            /** @type {{ list: () => any[], clientRect: (hwnd: number) => any,
             *     place: (hwnd: number, x: number, y: number, width: number,
             *     height: number, how?: { announce?: boolean }) => boolean,
             *     active: () => number, deactivated: () => boolean,
             *     deactivations: () => number, refresh: () => void,
             *     rawInput: (report: import('./user32/rawinput.js').RawInputEvent) => void,
             *     modalLoop: import('./user32/windows.js').WindowService['modalLoop'] }} */
            let windowService = {
                list: ()=>[], clientRect: ()=>null, place: ()=>false, active: ()=>0,
                deactivated: ()=>false, deactivations: ()=>0, refresh: ()=>{}, rawInput: ()=>{},
                modalLoop: ()=>0,
            };

            /** @type {(handle: number, text: string) => void} */
            const sink = config?.onOutput ?? (()=>{});
            /** @type {(text: string) => void} */
            const trace = config?.onTrace ?? (()=>{});

            /**
             * A modal dialog or message box put to an unattended run: the
             * embedder's answerer chooses, and without one the default button
             * is pressed, as Enter would press it. Either way the log says
             * what was answered, since nobody saw it.
             *
             * @param {import('./user32/dialogs.js').UnattendedDialog} dialog
             * @returns {number | Promise<number>}
             */
            const answerUnattended = dialog=>{
                const fallback = dialog.buttons.find(button=>button.default)?.id
                    ?? dialog.buttons[0]?.id ?? 1;
                const chosen = config?.answer ? config.answer(dialog) : fallback;
                /** @param {number} id */
                const told = id=>{
                    config?.divergence?.(dialog.kind === 'messagebox' ? 'MessageBox' : 'DialogBox',
                        `unattended: answered ${id} to "${dialog.title}: ${dialog.text}"`);
                    return id;
                };
                return chosen instanceof Promise ? chosen.then(told) : told(chosen);
            };

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
            // Clearing a recycled block is the one write whose length is the
            // program's rather than a structure's, so it goes in without a host
            // buffer to hold the pattern.
            const fillMemory = (/** @type {number} */ address, /** @type {number} */ value,
                /** @type {number} */ length)=>memory.fillBytes(address, value, length);
            const readCString = (/** @type {number} */ address, /** @type {number} */ maxLength)=>
                memory.readCString(address, maxLength);
            // The scan under the C string functions whose answer is a position
            // rather than a text: it walks the same chunks readCString does and
            // never materialises the string.
            const scanCString = (/** @type {number} */ address, /** @type {number} */ limit,
                /** @type {Uint8Array} */ wanted)=>memory.scanCString(address, limit, wanted);

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
            const hive = createHive({ processorMhz: config?.processorMhz, windows });
            // The guest's clock, because a timer is due against the clock the
            // program itself reads, and the input layer's key state, because a
            // hot key fires on a combination and only the layer that sees the
            // presses knows which modifiers are down when one arrives.
            // What the page pasted, for the clipboard functions to answer with;
            // the version is what tells a fresh paste from the one a program
            // already read.
            /** @type {{ text: string | null, version: number }} */
            const pasteboard = { text: null, version: 0 };
            const queue = createMessageQueue({
                now: ()=>kernel.clock.virtualTime(),
                keyState: config?.keyState,
                currentThread: ()=>kernel.currentThread(),
            });

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
            // The guest code the engine writes itself, on pages nothing else is
            // handed (`code-arena.js`).
            const placeCode = createCodeArena(bytes=>allocator.allocate(bytes));
            const heap = {
                /** @param {number} bytes */
                allocate: bytes=>allocator.allocate(bytes),
                /** @param {number} bytes */
                allocateCode: bytes=>placeCode(bytes),
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
                divergence: config?.divergence,
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
                // A font enumeration's callback is the program's own code.
                call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                callerThread: ()=>bridge.callerThread(),
                setLastError: setError,
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
                // Readiness as a window message, over the same queue PostMessage
                // uses -- built below, but a function reaching for it now only
                // ever runs once the machine is up and the queue exists.
                /** @param {import('./user32/messages.js').PostedMessage} message */
                post: message=>queue.post(message),
                // Readiness as a kernel event, for WSAEventSelect. A stale or
                // mistyped handle is the program's mistake, not a fault here.
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

            // Multimedia timers fire on a thread of their own, like the notices
            // above, but the kernel's clock is what wakes it.
            const mmTimers = createTimerService({
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
                /** @param {any} thread @param {string} reason
                 *  @param {{ deadline: number, result: number }} [timed] */
                block: (thread, reason, timed)=>kernel.block(thread, reason, timed),
                /** @param {any} thread @param {number} result */
                wake: (thread, result)=>kernel.wake(thread, result),
                /** @param {any} thread */
                park: thread=>bridge.park(thread),
                now: ()=>kernel.clock.virtualTime(),
                // A stale handle is the program's mistake, as for the notices.
                /** @param {number} handle */
                setEvent: handle=>{
                    try
                    {
                        kernel.setEvent(kernel.handles.resolve(handle, 'event'));
                    }
                    catch (e){
                        void e;
                    }
                },
                /** @param {number} handle */
                pulseEvent: handle=>{
                    try
                    {
                        const event = kernel.handles.resolve(handle, 'event');
                        kernel.setEvent(event);
                        kernel.resetEvent(event);
                    }
                    catch (e){
                        void e;
                    }
                },
            });

            // Built here rather than with the other tables because two things need
            // it: the library a program links against, and whoever drives the
            // machine, which has to move the play cursor from outside a guest call.
            const winmm = createWinmmFunctions({
                timers: mmTimers,
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
                divergence: config?.divergence,
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

            /**
             * How the C runtime ends a process that has already lost -- `abort`,
             * `terminate`, a pure virtual call: exit code 3, as the runtime's own
             * does, and a line saying why, since the code alone says nothing.
             *
             * @param {string} why
             */
            const abortProcess = why=>{
                trace(`the C runtime aborted the process: ${why}`);
                exitCode ??= 3;
                processEnded();
            };

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
                // With the flags: a raised exception's context carries them as a
                // fault's does, and a handler that continues from it gets them back.
                registers: ()=>Object.fromEntries(
                    [...registerNames, 'eflags'].map(name=>[name, cpuRegisters.read(name)])),
                setRegisters,
                /** @param {any} call */
                callGuest: call=>bridge.callGuest(call),
                currentThread: ()=>kernel.currentThread(),
                /** @param {string} text */
                trace: text=>trace(text),
                // What Windows does once nothing handled an exception and the
                // last-chance filter declined it: the process ends, with the
                // exception's code as its exit code.
                terminate: ({ code })=>{
                    exitCode = code >>> 0;
                    processEnded();
                },
            });

            // The one IMalloc, shared by ole32 and shell32: a block the shell
            // hands out is freed through the allocator COM hands out.
            const comVtables = {
                /** @param {any} object @param {string} interfaceId */
                publish: (object, interfaceId)=>bridge.publishInterface(object, interfaceId),
            };
            const taskAllocator = createTaskAllocator({
                heap, registry: com, vtables: comVtables, readMemory, writeMemory,
            });

            // shell32's COM class, registered beside the shell's own table because
            // an installer reaches it through CoCreateInstance rather than an
            // export. It saves onto the same volume every file call uses and hands
            // back strings from the same task heap CoTaskMemAlloc does.
            registerShellLinkClasses(com, {
                readMemory,
                writeMemory,
                readCString,
                readWideString,
                /** @param {number} bytes */
                allocate: bytes=>heap.allocate(bytes),
                files: volume,
                divergence: config?.divergence,
            });

            // WMI's locator, which a program asks for its video memory.
            registerWbemClasses({
                registry: com, vtables: comVtables, heap, readMemory, writeMemory, readWideString,
                divergence: config?.divergence,
            });

            // One way of starting a program, behind three spellings of asking for
            // one: kernel32's CreateProcess and WinExec, and the shell's launch. A
            // program a self-extractor starts through ShellExecute has to be the one
            // it named, which needs the image found the same way in both.
            const spawner = createSpawner({
                kernel,
                /** @param {string} path */
                stat: path=>volume.stat(path),
                // A child is recorded with a full path, because everything that
                // reads a location off its image -- the directory it starts in,
                // first of all -- reads it against the child, not against us.
                /** @param {string} path */
                resolve: path=>filesystem.resolve(path).path,
                imagePath: ()=>modules.imagePath(),
                // Where the record of a replacement request goes. It has to leave
                // this process, because honouring one erases every log and ring the
                // run that asked for it produced.
                /** @param {any} request */
                spawned: request=>config?.spawned?.(request),
            });

            // Routines queued to a thread and run by it when it waits alertably:
            // the waits themselves are the ordinary ones, looked up when called.
            const apcs = createApcs({
                kernel,
                register: (name, fn)=>bridge.register(name, fn),
                /** @param {any} call */
                callGuest: call=>bridge.callGuest(call),
                currentThread: ()=>kernel.currentThread(),
                writeU32: (address, value)=>memory.writeU32(address, value),
                setLastError: setError,
                call: name=>{
                    const entry = libraries['KERNEL32.dll']?.[name]
                        ?? libraries['USER32.dll']?.[name];
                    return /** @type {(args: number[]) => any} */ (entry.handler);
                },
            });

            // Every DllMain this layer or the loader calls goes through the
            // loader's own frame, so an exception out of one ends it rather
            // than reaching the program's handlers.
            const callEntryPoint = createEntryPointCaller({
                register: (name, fn)=>bridge.register(name, fn),
                callGuest: call=>bridge.callGuest(call),
                continueAt: (registers, options)=>bridge.continueAt(registers, options),
                unwind: (frame, address, options)=>seh.unwind(frame, address, options),
                readU32: address=>memory.readU32(address),
                writeU32: (address, value)=>memory.writeU32(address, value),
                stackPointer: ()=>cpuRegisters.read('esp') >>> 0,
                teb: thread=>(thread?.tebAddress ?? kernel.currentThread()?.tebAddress ?? 0) >>> 0,
                divergence: detail=>config?.divergence?.('DllMain', detail),
            });

            /** Set once the process has begun to end, so that it ends only once. */
            let ending = false;
            /**
             * ExitProcess, and the C runtime's exits that end in it: every other
             * thread ends, each library still attached is called with
             * DLL_PROCESS_DETACH on this thread -- the last attached first, and
             * lpvReserved non-NULL because the process is ending -- and only then
             * is the code recorded, which is what stops the machine. With nothing
             * to tell, nothing else would run, so the code is recorded at once.
             * An ExitProcess from inside one of those DllMains ends it there.
             *
             * @param {number} code
             */
            const endProcess = code=>{
                const told = detachAndEnd(code);
                return told === null ? bridge.park() : told;
            };

            /**
             * The ending itself: null when there was nothing to tell and the code
             * is recorded already, else the promise of telling the libraries and
             * then recording it. Apart from endProcess so that a caller which has
             * already left the bridge -- the runtime's exit, after its atexit
             * handlers -- ends the process the same way without parking.
             *
             * @param {number} code
             * @returns {Promise<number> | null}
             */
            const detachAndEnd = code=>{
                const attached = ending ? [] : (modules.attachedLibraries?.() ?? []);
                ending = true;
                if (attached.length === 0)
                {
                    exitCode = code;
                    processEnded();
                    return null;
                }
                const self = kernel.currentThread();
                for (const thread of kernel.threads())
                {
                    if (thread !== self && thread.state !== kernel.ThreadState?.TERMINATED)
                    {
                        kernel.exitThread(thread, code);
                    }
                }
                /** @type {Promise<any>} */
                let told = Promise.resolve(0);
                for (const library of attached)
                {
                    told = told.then(()=>callEntryPoint({
                        entry: library.entryPoint,
                        base: library.base,
                        reason: DLL_PROCESS_DETACH,
                        reserved: 1,
                        thread: self,
                    }));
                }
                return told.then(()=>{
                    exitCode = code;
                    processEnded();
                    return 0;
                });
            };

            // comctl32's image lists, drawn with gdi32's own calls: its exports,
            // and what its tab control draws from.
            const imageLists = createImageLists({
                readMemory, writeMemory, divergence: config?.divergence,
                gdi32: name=>libraries['GDI32.dll']?.[name],
                bitmapSize: bitmap=>gdi.bitmapSize(bitmap),
            });

            libraries = {
                'KERNEL32.dll': {
                    ...createConsoleFunctions({
                        write: (handle, text)=>sink(handle, text),
                        exit: code=>{
                            exitCode = code;
                            processEnded();
                        },
                        park: ()=>bridge.park(),
                        end: code=>endProcess(code),
                    }),
                    ...createThreadingFunctions({
                        kernel,
                        readMemory,
                        readCString,
                        readWideString,
                        writeMemory,
                        setLastError: setError,
                        namedObjects,
                        currentThread: ()=>kernel.currentThread(),
                        park: (/** @type {any} */ thread)=>bridge.park(thread),
                        // Where a start routine returns to. Registered once, the
                        // first time a thread is made, because registering it costs
                        // a stub and a build that never makes a thread needs none.
                        threadReturn: ()=>threadReturnAddress(),
                        processId: 0x1000,
                        imagePath: ()=>modules.imagePath(),
                        divergence: config?.divergence,
                        // Every thread gets a block of its own, made by whoever
                        // owns the process's, which win32 is only handed.
                        threadBlock: config?.threadBlock,
                        /** @param {number} handle */
                        handleType: handle=>kernel.handles.typeOf(handle),
                        /** @param {any} node */
                        retainNode: node=>volume.retain(node),
                        queueApc: (thread, routine, args)=>apcs.queue(thread, routine, args),
                    }),
                    ...apcs.table,
                    ...createDebugFunctions({
                        readCString,
                        readWideString: (address, maxLength)=>
                            memory.readWideString(address, maxLength),
                        say: text=>trace(text),
                    }),
                    ...createHeapFunctions({
                        arena, allocator, readMemory, writeMemory, fillMemory,
                        setLastError: setError,
                        divergence: config?.divergence,
                        /** @param {number} address */
                        regionAt: address=>memory.find(address),
                        /** @param {number} address */
                        nextRegionAfter: address=>memory.nextRegionAfter(address) ?? null,
                    }),
                    ...createProcessFunctions({
                        readMemory,
                        writeMemory,
                        readCString,
                        readWideString,
                        currentThread: ()=>kernel.currentThread(),
                        now: ()=>kernel.clock.virtualTime(),
                        systemTimeMs: ()=>kernel.clock.wallClock(),
                        // The clock a program reads without calling us: the block
                        // is refreshed wherever guest time moves, so a routine that
                        // reads it answers what a call would have answered.
                        publishClock: refresh=>kernel.clock.whenMoved(refresh),
                        moduleHandle: name=>modules.find(name)?.base ?? 0,
                        version: reported,
                        setRegisters,
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
                        /** @param {number} bytes */
                        allocateCode: bytes=>heap.allocateCode(bytes),
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
                        /** @param {number} bytes */
                        allocateCode: bytes=>heap.allocateCode(bytes),
                        advanceClock: (/** @type {number} */ ms)=>kernel.clock.advance(ms),
                        setLastError: setError,
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
                        findResource: (instance, type, name, language = null)=>
                            modules.findResource?.(instance, type, name, language) ?? null,
                        /** @param {number} instance */
                        listResources: instance=>modules.listResources?.(instance) ?? [],
                        /** @param {number} instance */
                        moduleBase: instance=>modules.moduleBase?.(instance) ?? 0,
                        /**
                         * @param {number} entry @param {number[]} args @param {any} [thread]
                         */
                        call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                        callerThread: ()=>bridge.callerThread(),
                    }),
                    ...createProfileFunctions({
                        readMemory,
                        writeMemory,
                        readCString,
                        files: volume,
                        setLastError: setError,
                    }),
                    ...createDriveFunctions({
                        readCString, readWideString, readMemory, writeMemory,
                        setLastError: setError,
                        drives: ()=>filesystem.drives(),
                        volume: (/** @type {string} */ letter)=>filesystem.volume?.(letter) ?? null,
                    }),
                    ...createMappingFunctions({
                        readMemory,
                        writeMemory,
                        readCString,
                        readWideString,
                        setLastError: setError,
                        namedObjects,
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
                            /** @param {any} node */
                            size: node=>filesystem.size(node),
                            /** @param {any} node */
                            retain: node=>volume.retain(node),
                            /** @param {any} node */
                            close: node=>volume.close(node),
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
                        /** @param {string} path @param {number} modified */
                        setModified: (path, modified)=>filesystem.setModified(path, modified),
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
                        environment: ()=>config?.environment
                            ?? defaultEnvironment(windows, folders),
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
                        currentThread: ()=>kernel.currentThread(),
                        exit: code=>{
                            exitCode = code >>> 0;
                            processEnded();
                        },
                    }),
                    ...createAtomFunctions({
                        writeMemory,
                        readCString,
                        setLastError: setError,
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
                        spawned: request=>config?.spawned?.(request),
                        spawner,
                    }),
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
                        /** @param {string} name @param {number} [flags] */
                        load: (name, flags)=>modules.load?.(name, flags) ?? 0,
                        /** @param {number} handle */
                        dataFile: handle=>modules.dataFile?.(handle) ?? null,
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
                        directories: profileDirectories(windows),
                        imagePath: ()=>modules.imagePath(),
                        setLastError: setError,
                        writeConsole: (handle, text)=>sink(handle, text),
                        handles,
                        namedObjects,
                        currentThread: ()=>kernel.currentThread(),
                        setLastErrorFor: setErrorOn,
                        queueApc: (thread, routine, args)=>apcs.queue(thread, routine, args),
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
                        continueAt: (registers, options)=>bridge.continueAt(registers, options),
                        currentThread: ()=>kernel.currentThread(),
                        teb: ()=>kernel.currentThread()?.tebAddress ?? 0,
                        unwind: seh.unwind,
                        divergence: config?.divergence,
                    }).table,
                    ...createMsvcrtFunctions({
                        readMemory,
                        writeMemory,
                        fillMemory,
                        readCString,
                        scanCString,
                        // The `va_list` window stops at the end of its region: a
                        // thread formatting from just below its stack's top is
                        // entitled to, and reading off the end is the host's bug.
                        regionAt: address=>memory.find(address) ?? null,
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
                        exitProcess: (/** @type {number} */ code)=>endProcess(code),
                        exit: (/** @type {number} */ code)=>detachAndEnd(code),
                        atProcessEnd: task=>endTasks.push(task),
                        // The high half of an __int64 answer, which a program
                        // reads from EDX.
                        setRegisters,
                        version: reported,
                        files: volume,
                        // kernel32's own file handles, so the handle
                        // `_get_osfhandle` gives is one ReadFile and
                        // CreateFileMapping take, and a descriptor closes its
                        // handle through the same CloseHandle a program calls.
                        handles: {
                            open: file=>handles.open('file', file),
                            file: handle=>{
                                try
                                {
                                    return handles.resolve(handle, 'file') ?? null;
                                }
                                catch (e){
                                    void e;
                                    return null;
                                }
                            },
                            close: handle=>
                                libraries['KERNEL32.dll'].CloseHandle.handler([handle]) !== 0,
                        },
                        // The standard streams are records in the runtime's own
                        // image, wherever the loader put its `_iob`.
                        iob: ()=>modules.find('msvcrt.dll')?.addressOf?.('_iob') ?? 0,
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
                        // The runtime's threads are kernel32's threads: made and
                        // ended by the same calls, read from the table at the
                        // moment of the call, once it exists.
                        threads: {
                            start: ({ entry, stackSize, parameter, threadIdOut })=>
                                libraries['KERNEL32.dll'].CreateThread.handler(
                                    [0, stackSize, entry, parameter, 0, threadIdOut]) >>> 0,
                            exit: code=>libraries['KERNEL32.dll'].ExitThread.handler([code]),
                            sleep: ms=>libraries['KERNEL32.dll'].Sleep.handler([ms]),
                        },
                        divergence: config?.divergence,
                        abort: abortProcess,
                    }),
                    // After the runtime's own table: `terminate` is answered here,
                    // where the handler `set_terminate` installed is known.
                    ...createCxxExceptions({
                        readMemory,
                        writeMemory,
                        readCString,
                        /** @param {number} address */
                        isMapped: address=>memory.find(address) !== null,
                        registers: ()=>Object.fromEntries(
                            registerNames.map(name=>[name, cpuRegisters.read(name)])),
                        /** @param {any} call */
                        callGuest: call=>bridge.callGuest(call),
                        continueAt: (registers, options)=>bridge.continueAt(registers, options),
                        currentThread: ()=>kernel.currentThread(),
                        raise: what=>seh.raise(what),
                        unwind: (targetFrame, address, options)=>
                            seh.unwind(targetFrame, address, options),
                        abort: abortProcess,
                        park: ()=>bridge.park(),
                        divergence: config?.divergence,
                    }).table,
                },

                // One registry behind all three, as on a real machine: a socket
                // opened through one of these names is the same socket seen through
                // another, and they share one error domain.
                'WSOCK32.dll': winsock.sockets,
                'WS2_32.dll': winsock.sockets,
                'MSWSOCK.dll': winsock.extensions,

                'WINMM.dll': {
                    ...winmm.table,
                    // The files a program reads its sounds from are the volume's.
                    ...createMmioFunctions({
                        readMemory, writeMemory, readCString, files: volume,
                        // A file the program opened itself and hands mmio by its
                        // handle is kernel32's, and closes as CloseHandle closes it.
                        handles: {
                            file: handle=>{
                                try
                                {
                                    return handles.resolve(handle, 'file') ?? null;
                                }
                                catch (e){
                                    void e;
                                    return null;
                                }
                            },
                            close: handle=>
                                libraries['KERNEL32.dll'].CloseHandle.handler([handle]) !== 0,
                        },
                        // A buffer mmio makes is guest memory, because mmioGetInfo
                        // hands its pointers to the program.
                        allocate: bytes=>heap.allocate(bytes),
                        free: address=>{
                            heap.free(address);
                        },
                        // A file through the program's own I/O procedure is read
                        // and written by calling it.
                        call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                        callerThread: ()=>bridge.callerThread(),
                        divergence: config?.divergence,
                    }),
                },

                'COMCTL32.dll': createComctlFunctions({
                    readMemory, writeMemory, divergence: config?.divergence, imageLists,
                    // What _TrackMouseEvent is documented to call where the
                    // system has it; looked up when called, as user32 is built
                    // beside it.
                    trackMouseEvent: request=>
                        libraries['USER32.dll'].TrackMouseEvent.handler([request]),
                    // A property sheet is a dialog made with user32's own calls,
                    // as a program would make one, around a dialog procedure the
                    // bridge gives an address.
                    user32: name=>libraries['USER32.dll'][name],
                    allocate: bytes=>heap.allocate(bytes),
                    release: address=>heap.free(address),
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                    procedure: (name, handler)=>bridge.register(`<${name}>`,
                        { argBytes: 16, handler }),
                    findResource: (instance, type, name)=>
                        modules.findResource?.(instance, type, name) ?? null,
                    moduleBase: instance=>modules.moduleBase?.(instance) ?? 0,
                    loadString: (instance, id)=>modules.loadString?.(instance, id) ?? null,
                    // A modal sheet's own loop, which user32 lends it.
                    modal: (hwnd, options)=>windowService.modalLoop(hwnd, options),
                }),

                'SHELL32.dll': createShellFunctions({
                    writeMemory, readMemory, readCString,
                    // FindExecutable resolves an executable against the current
                    // directory the file calls use, which is the filesystem's.
                    resolve: path=>filesystem.resolve(path).path,
                    // And a launch starts the program kernel32 would have started.
                    launcher: spawner,
                    divergence: config?.divergence,
                    taskAllocator,
                    // The task allocator's memory: a caller frees an item id list
                    // with CoTaskMemFree, which is this same heap.
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                    folders,
                    // The namespace a folder browser walks is the volume every
                    // file call uses, published through the same vtables COM uses.
                    volume: { ...volume, drives: ()=>filesystem.drives() },
                    publish: comVtables.publish,
                }),

                'VERSION.dll': createVersionFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    readWideString,
                    setLastError: setError,
                    /** @param {string} path */
                    versionInfo: path=>modules.versionInfo?.(path) ?? null,
                    // The libraries the engine answers for with no file behind
                    // them, which carry a version all the same.
                    /** @param {string} name */
                    systemLibrary: name=>modules.systemLibrary?.(name) ?? false,
                    // Where VerInstallFile reads a compressed source and writes the
                    // expanded file: the same volume every other file call uses.
                    files: volume,
                    windows,
                }),

                'LZ32.dll': createLzFunctions({ readCString, writeMemory, files: volume }),

                'COMDLG32.dll': createCommonDialogFunctions(
                    { readMemory, readCString, writeMemory }),

                'IMM32.dll': createImmFunctions({ writeMemory }),

                'SHLWAPI.dll': createShlwapiFunctions({ readCString, readWideString, writeMemory }),

                'ADVPACK.dll': createAdvpackFunctions({
                    isAdministrator: ()=>isTokenMember(ADMINISTRATORS_SID),
                }),

                'SFC.dll': createSfcFunctions({ writeMemory, readCString, files: volume }),

                // An installer's INF files, cabinets and file queues, over the
                // volume every file call uses; a queue's notifications go to the
                // program's own callback on the thread that asked.
                'SETUPAPI.dll': createSetupapiFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    readWideString,
                    setLastError: setError,
                    setLastErrorFor: setErrorOn,
                    files: volume,
                    /** @param {string} path */
                    fullPath: path=>filesystem.resolve(path).path,
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                    /** @param {number} address */
                    free: address=>heap.free(address),
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                    handles,
                    folders,
                    registry: hive,
                    divergence: config?.divergence,
                }),

                // Authenticode: whether a signed file is intact and its publisher
                // chains to a root this machine trusts -- `trustedRoots`, read when
                // a program asks, or Microsoft's root when it is not configured.
                'WINTRUST.dll': createWintrustFunctions({
                    readMemory,
                    writeMemory,
                    readWideString,
                    setLastErrorFor: setErrorOn,
                    callerThread: ()=>bridge.callerThread(),
                    files: volume,
                    /** @param {string} path */
                    fullPath: path=>filesystem.resolve(path).path,
                    handles,
                    trustedRoots: ()=>config?.trustedRoots,
                    now: ()=>kernel.clock.wallClock(),
                    divergence: config?.divergence,
                }),

                // The maths half of the Direct3D helper: pure vector and matrix
                // functions, here for their stack width as much as their answers,
                // since d3dx9 exports them undecorated though they are stdcall.
                ...d3dxLibraries(createD3dxFunctions({ readMemory, writeMemory })),

                'WINSPOOL.DRV': createSpoolerFunctions({ setLastError: setError }),

                'MPR.dll': createNetworkFunctions({ setLastError: setError }),

                // Audio middleware links against the codec manager statically;
                // with no drivers installed it answers "not possible" and the
                // middleware decodes on its own.
                'MSACM32.dll': createAcmFunctions(),

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
                    // wvsprintfA reads a `va_list` window too, clamped the same way.
                    regionAt: address=>memory.find(address) ?? null,
                    handles,
                    queue,
                    windowService: (/** @type {typeof windowService} */ service)=>{
                        windowService = service;
                    },
                    // What GetSystemMetrics and EnumDisplaySettings answer with.
                    // The same screen GDI and the drawing layer are given: a
                    // program picks its mode from this and would otherwise be
                    // offered one the device it then creates does not have.
                    screen: config?.screen,
                    dispatching,
                    // One line per message a window procedure receives, under
                    // its own category and nothing at all when nobody asked: a
                    // program's calls say what it asked, never what it was told,
                    // and what it was told is where a device reset, a pause or a
                    // throttle is decided.
                    trace: message=>{
                        if (!journal.enabled('input.message', journal.Level.TRACE))
                        {
                            return;
                        }
                        journal.write('trace', 'input.message',
                            'hwnd=0x{0} msg=0x{1} wParam=0x{2} lParam=0x{3}',
                            message.hwnd.toString(16), message.message.toString(16),
                            message.wParam.toString(16), message.lParam.toString(16));
                    },
                    dispatch: (wndProc, message, thread)=>bridge.callGuest({
                        entry: wndProc,
                        // The four arguments a window procedure declares, in order.
                        args: [message.hwnd, message.message, message.wParam, message.lParam],
                        thread,
                    }),
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                    divergence: config?.divergence,
                    /** @param {number} id */
                    threadExists: id=>kernel.threads().some(
                        (/** @type {{ id: number }} */ thread)=>(thread.id >>> 0) === id),
                    setLastError: setError,
                    park: ()=>bridge.park(),
                    idle,
                    // The handles half of a wait that also watches the queue.
                    // Read at call time: the table it lives in is built below.
                    /** @param {number[]} args */
                    waitForObjects: args=>
                        libraries['KERNEL32.dll'].WaitForMultipleObjects.handler(args),
                    now: ()=>kernel.clock.virtualTime(),
                    created: config?.created ?? (()=>{}),
                    /** @param {number} instance @param {number} id */
                    loadString: (instance, id)=>modules.loadString?.(instance, id) ?? null,
                    /** @param {number} instance @param {number} type @param {number | string} name */
                    findResource: (instance, type, name)=>
                        modules.findResource?.(instance, type, name) ?? null,
                    /** @param {number} instance */
                    moduleBase: instance=>modules.moduleBase?.(instance) ?? 0,
                    // A bitmap resource made a bitmap for the display: CreateDIBitmap
                    // on a screen context, as LoadBitmap and LoadImage make one.
                    /** @param {number} info @param {number} bits */
                    bitmapFromDib: (info, bits)=>{
                        const CBM_INIT = 4;
                        const hdc = gdi.windowContext(0, null);
                        try
                        {
                            return gdi.table.CreateDIBitmap.handler(
                                [hdc, info, CBM_INIT, bits, info, 0]);
                        }
                        finally
                        {
                            gdi.table.ReleaseDC.handler([0, hdc]);
                        }
                    },
                    // Where the pointer is and what is held down. The input layer
                    // is above this one and cannot be imported from here, so both
                    // are handed down as thunks; a build without one answers what
                    // it answered before, which is that nothing is pressed.
                    cursor: config?.cursor,
                    keyState: config?.keyState,
                    // The same state in the other two forms a program reads it:
                    // the async low bit, which the read itself clears, and the
                    // whole 256-byte table GetKeyboardState fills and
                    // SetKeyboardState writes back.
                    asyncKeyState: config?.asyncKeyState,
                    keyboardState: config?.keyboardState,
                    setKeyboardState: config?.setKeyboardState,
                    // The cursor space a program declares with ClipCursor, handed
                    // down the same way and for the same reason: the input layer
                    // that scales pointer motion into it sits above this one.
                    clipCursor: config?.clipCursor,
                    placeCursor: config?.placeCursor,
                    // Where SendInput's events go. The input layer owns the router
                    // and is above this one, so the thunk is handed down like the
                    // cursor's, and a build without one injects nothing.
                    sendInput: config?.sendInput,
                    // The picture the page shows as the program's cursor, handed up
                    // whenever user32's own state (ShowCursor's count, a null
                    // SetCursor) changes it. The same event the Direct3D device
                    // methods already emit through the graphics layer's cursor
                    // callback, so the page sees one cursor from two producers and
                    // the last report wins.
                    reportCursor: config?.reportCursor,
                    // Where a window's device context comes from. GDI owns the
                    // contexts and lives in this same module, so user32's GetDC is
                    // GDI's under the window's name: a program that takes a DC on
                    // its window to ask the display about itself must get one, or
                    // it reads a null context's answers as facts about the screen.
                    dc: ()=>({
                        /**
                         * @param {number} hwnd
                         * @param {{ left: number, top: number, right: number,
                         *     bottom: number } | null} [bounds]
                         *     Where on the screen the window's client area is.
                         */
                        get: (hwnd, bounds = null)=>gdi.windowContext(hwnd, bounds),
                        /** @param {number} hwnd @param {number} hdc */
                        release: (hwnd, hdc)=>gdi.table.ReleaseDC.handler([hwnd, hdc]),
                    }),
                    // The window manager's own painting -- frames, captions and
                    // the controls of the system classes -- through GDI's engine.
                    draw: gdi.draw,
                    // Regions are GDI objects; the update area is user32's.
                    /** @param {number} region */
                    regionBox: region=>gdi.regionBox(region),
                    /** @param {number} region @param {any} rect */
                    setRegion: (region, rect)=>gdi.setRegion(region, rect),
                    // Shows the desktop once a paint pass has finished. The
                    // graphics layer is above this one and is reached the way the
                    // drawing engine is: through what the assembling caller hands
                    // down, and only when it did.
                    present: ()=>config?.graphics?.presentDesktop?.(),
                    // The window procedure of a system class lives on this side,
                    // and a program that subclasses one still needs an address it
                    // can call through: a stub the bridge traps back to the handler.
                    /**
                     * @param {string} name
                     * @param {(message: { hwnd: number, message: number, wParam: number,
                     *     lParam: number }) => number | Promise<number>} handler
                     */
                    registerProcedure: (name, handler)=>bridge.register(name, {
                        argBytes: 16,
                        /** @param {number[]} args */
                        handler: ([hwnd, message, wParam, lParam])=>handler({
                            hwnd: hwnd >>> 0, message: message >>> 0,
                            wParam: wParam >>> 0, lParam: lParam >>> 0,
                        }),
                    }),
                    // The common controls are built-in classes of the window
                    // manager, built from the same host and drawing helpers its
                    // own system classes use: comctl32 owns their behaviour, not
                    // their registration.
                    registerControls: (controlHost, toolkit, register)=>{
                        for (const definition
                            of createCommonControls(controlHost, toolkit, imageLists))
                        {
                            register(definition);
                        }
                    },
                    // A program's own explanation of why it is stopping, handed up
                    // whole rather than as a line of log, so whoever is embedding
                    // this engine can show it the way a person would have seen it.
                    // Unattended, nobody is at the page to answer it.
                    /** @param {any} notice */
                    messageBox: notice=>(config?.unattended === true
                        ? answerUnattended({
                            kind: 'messagebox', title: notice.caption, text: notice.text,
                            buttons: notice.buttons.map((/** @type {any} */ button)=>
                                ({ ...button, default: button.id === notice.defaultButton })),
                        })
                        : config?.onMessageBox?.(notice)),
                    unattended: config?.unattended === true,
                    answer: answerUnattended,
                    /** @param {string} text */
                    clipboard: text=>config?.onClipboard?.(text),
                    pasteboard,
                    say: (/** @type {string} */ text)=>trace(text),
                    // A CREATESTRUCT has to live where the guest can read it, and
                    // only for the length of the two messages that carry it.
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                    /** @param {number} address */
                    release: address=>heap.free(address),
                }),

                'ADVAPI32.dll': {
                    ...createRegistryFunctions({
                        readMemory,
                        writeMemory,
                        readCString,
                        hive,
                        setLastError: setError,
                        // A SID has to live where a program can compare it byte by byte.
                        /** @param {number} bytes */
                        allocate: bytes=>heap.allocate(bytes),
                    }),
                    ...createTokenFunctions({
                        readMemory,
                        writeMemory,
                        readCString,
                        setLastError: setError,
                        handles,
                    }),
                    ...createServiceFunctions({
                        readCString,
                        hive,
                        setLastError: setError,
                        divergence: config?.divergence,
                    }),
                    ...createCryptoFunctions({
                        readMemory,
                        writeMemory,
                        readCString,
                        setLastError: setError,
                        divergence: config?.divergence,
                    }),
                },

                'GDI32.dll': gdi.table,

                'ole32.dll': createOleFunctions({
                    readMemory,
                    writeMemory,
                    fillMemory,
                    currentThread: ()=>kernel.currentThread(),
                    heap,
                    registry: com,
                    taskAllocator,
                    divergence: config?.divergence,
                    vtables: comVtables,
                    hive,
                    // A docfile is a file on the volume, and an object a program
                    // saves into one answers GetClassID and Save on its own side.
                    files: volume,
                    /** @param {number} entry @param {number[]} args @param {unknown} [thread] */
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                    // Read at call time: the table they live in is built above,
                    // but the object holding it is assigned after this literal.
                    libraries: {
                        /** @param {number} name */
                        load: name=>libraries['KERNEL32.dll'].LoadLibraryW.handler([name]),
                        /** @param {number} module */
                        free: module=>libraries['KERNEL32.dll'].FreeLibrary.handler([module]),
                        /** @param {number} name */
                        loadAnsi: name=>libraries['KERNEL32.dll'].LoadLibraryA.handler([name]),
                        /** @param {number} module @param {number} name */
                        procAddress: (module, name)=>
                            libraries['KERNEL32.dll'].GetProcAddress.handler([module, name]),
                    },
                    makeObject: createComObject,
                    // A drop target hangs on a window, which user32 knows, and is
                    // the window's property as well.
                    /** @param {number} window */
                    isWindow: window=>libraries['USER32.dll'].IsWindow.handler([window]) === 1,
                    windowProperty: {
                        set: (window, name, value)=>
                            libraries['USER32.dll'].SetPropA.handler([window, name, value]),
                        remove: (window, name)=>
                            libraries['USER32.dll'].RemovePropA.handler([window, name]),
                    },
                    // A BSTR or a SAFEARRAY a PROPVARIANT holds is oleaut32's to
                    // copy and to free, in its own layout.
                    bstr: {
                        copy: bstr=>libraries['OLEAUT32.dll'].SysAllocString.handler([bstr]),
                        free: bstr=>libraries['OLEAUT32.dll'].SysFreeString.handler([bstr]),
                    },
                    safeArray: {
                        copy: (array, out)=>
                            libraries['OLEAUT32.dll'].SafeArrayCopy.handler([array, out]),
                        destroy: array=>libraries['OLEAUT32.dll'].SafeArrayDestroy.handler([array]),
                    },
                }),

                'RPCRT4.dll': createRpcFunctions({
                    writeMemory, readCString, readMemory, divergence: config?.divergence,
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                    /** @param {number} address */
                    free: address=>heap.free(address),
                }),

                'OLEAUT32.dll': createAutomationFunctions({
                    readMemory,
                    writeMemory,
                    fillMemory,
                    heap,
                    divergence: config?.divergence,
                    // A type library is a file a program loads and an object it
                    // registers, so automation reads the volume, publishes through
                    // the same vtables COM uses and writes the same hive.
                    files: volume,
                    vtables: comVtables,
                    hive,
                    /** @param {number} entry @param {number[]} args */
                    call: (entry, args)=>bridge.callGuest({ entry, args }),
                }),
            };

            // shfolder.dll is a forwarder and nothing else: the two exports it
            // has are shell32's folder calls under another library's name, so a
            // program that linked against this small library gets the same answers
            // as one that linked against shell32 directly.
            libraries['USER32.dll'].MsgWaitForMultipleObjectsEx =
                apcs.user32.MsgWaitForMultipleObjectsEx;

            libraries['SHFOLDER.dll'] = {
                SHGetFolderPathA: libraries['SHELL32.dll'].SHGetFolderPathA,
                SHGetFolderPathW: libraries['SHELL32.dll'].SHGetFolderPathW,
            };

            // timeGetTime answers the milliseconds GetTickCount answers, off the
            // same clock and with the same wrap -- timeBeginPeriod changes nothing
            // here -- so where GetTickCount is the guest's own read of the clock
            // block, timeGetTime is the same routine: a frame loop reads it tens of
            // times a frame, each a crossing into the host for one dword. Its
            // handler stays for a build with no block to read.
            const ticks = libraries['KERNEL32.dll'].GetTickCount;
            if (ticks?.guest)
            {
                libraries['WINMM.dll'].timeGetTime = {
                    ...libraries['WINMM.dll'].timeGetTime, guest: ticks.guest,
                };
            }

            // The runtime before msvcrt, built from it: the same entries under the
            // same names, and its own few beside them.
            libraries['CRTDLL.dll'] = createCrtdllFunctions(libraries['msvcrt.dll']);

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
                windows,
            });

            /** Every function, whichever library exports it. */
            const flat = ()=>Object.assign({}, ...Object.values(libraries));

            const api = {
                /** @returns {Record<string, Record<string, any>>} library name -> its exports */
                libraries: ()=>libraries,

                /**
                 * The names Windows always maps out of the system directory.
                 *
                 * Whoever assembles the process needs this to decide whether a
                 * file beside the program wins over the table we synthesised: it
                 * does for everything except these, and never for these.
                 *
                 * @returns {string[]}
                 */
                knownDlls: ()=>[...KNOWN_DLLS],

                /**
                 * What an undecorated export of a library is, when nothing else
                 * says: `'cdecl'` for the C runtime family, `'stdcall'` for the rest.
                 *
                 * By name rather than by table, because the question is asked
                 * about libraries this build does not have as well as the ones
                 * it does.
                 *
                 * @param {string} library  As an import descriptor names it.
                 * @returns {'cdecl' | 'stdcall'}
                 */
                libraryConvention: library=>CDECL_LIBRARIES.test(library) ? 'cdecl' : 'stdcall',

                /**
                 * Calls a library's entry point as the loader does: inside a
                 * frame of the loader's that takes whatever it raises, which
                 * then ends the call with 0.
                 *
                 * @param {{ entry: number, base: number, reason: number,
                 *     reserved: number, thread: any }} call
                 * @returns {Promise<number>}
                 */
                callEntryPoint: call=>callEntryPoint(call),

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
                    /** @param {number} hdc */
                    describeDrawable: hdc=>gdi.describeDrawable(hdc),
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
                    // The one common-controls entry point the header exports by
                    // number: a framework's start-up calls it and nothing else.
                    'COMCTL32.dll': COMCTL32_ORDINALS,
                    'WINMM.dll': WINMM_ORDINALS,
                    'SFC.dll': SFC_ORDINALS,
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
                 * Puts text on the clipboard from outside, as a paste on the page
                 * does: the next GetClipboardData for a text format answers with
                 * it, until a program empties the clipboard or the host pastes
                 * again.
                 *
                 * @param {string} text
                 */
                paste: text=>{
                    pasteboard.text = text;
                    pasteboard.version++;
                },

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
                lastError: ()=>{
                    const thread = kernel.currentThread();
                    return thread ? lastErrorOf(thread) : 0;
                },

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
                /** Every top-level window's rectangle, as the program declared it. */
                windows: ()=>windowService.list(),

                /** The window the program is active through, as GetForegroundWindow answers. */
                activeWindow: ()=>windowService.active(),

                /**
                 * Whether the application has been told it is no longer the
                 * active one (WM_ACTIVATEAPP(0)) and not told otherwise since:
                 * what DirectDraw's exclusive mode is lost on.
                 */
                applicationDeactivated: ()=>windowService.deactivated(),

                /**
                 * How many times the application has been told it is no longer
                 * the active one: a caller that asks only when a program next
                 * calls it still learns of a deactivation that came and went.
                 */
                applicationDeactivations: ()=>windowService.deactivations(),

                /**
                 * One event of the mouse or the keyboard as the device reported
                 * it, from the input layer: WM_INPUT for a program that registered
                 * for raw input, and nothing for one that did not.
                 *
                 * @param {import('./user32/rawinput.js').RawInputEvent} report
                 */
                rawInput: report=>windowService.rawInput(report),

                /**
                 * Whether one of this process's threads is blocked waiting on a
                 * child it started: the parent that goes on once the child is
                 * done, which the engine then runs the child beside rather than
                 * replacing it.
                 *
                 * @param {any} child  The child's process record.
                 */
                childWaitedOn: (/** @type {any} */ child)=>(child?.waiters?.length ?? 0) > 0,

                /**
                 * A child run beside this process has exited: its record takes the
                 * exit code -- what GetExitCodeProcess and a later wait read --
                 * and every thread waiting on it wakes with its wait's answer.
                 *
                 * @param {any} child @param {number} code
                 */
                childExited(child, code){
                    child.exitCode = code >>> 0;
                    child.completed = true;
                    const waiters = child.waiters ?? [];
                    child.waiters = [];
                    for (const { thread, result, settle } of waiters)
                    {
                        kernel.wake(thread, settle ? settle() : result);
                    }
                },

                /** Every window repaints: the process's desktop is shown again. */
                refreshWindows: ()=>windowService.refresh(),

                /**
                 * Places a window as the system would, telling the program with a
                 * move and a size. What a fullscreen device does to the window it
                 * presents into: the picture is the mode's size, and a window left
                 * at its old size has the program clipping its cursor to a corner
                 * of it.
                 *
                 * @param {number} hwnd @param {number} x @param {number} y
                 * @param {number} width @param {number} height
                 * @param {{ announce?: boolean }} [how]
                 */
                placeWindow: (hwnd, x, y, width, height, how)=>
                    windowService.place(hwnd, x, y, width, height, how),

                /**
                 * One window's client rectangle on the screen, or null for a
                 * handle that names no window: GetClientRect's size at
                 * ClientToScreen's origin, for the callers outside this layer that
                 * answer a size a program asked for as zero -- a back buffer, whose
                 * zero means exactly this -- or place a picture inside the window.
                 *
                 * @param {number} hwnd
                 */
                clientRect: (/** @type {number} */ hwnd)=>windowService.clientRect(hwnd),

                windowProcedures: ()=>dispatching.map(held=>({
                    hwnd: `0x${held.hwnd.toString(16)}`,
                    message: `0x${held.message.toString(16)}`,
                    forMs: held.at ? Date.now() - held.at : 0,
                })),

                /**
                 * A processor exception the running thread took, offered to the
                 * handlers it registered. Null when it is not one a program can
                 * be handed; otherwise settles with where the thread goes on --
                 * or with null once nothing took it, for the machine to stop on
                 * the fault as it always has. A handler that finds its catch
                 * sends the thread on by itself, and then this never settles.
                 *
                 * @param {{ vector: number, eip: number, errorCode: number | null,
                 *           eflags: number, eax?: number, edx?: number, stack?: number }} fault
                 * @returns {Promise<any> | null}
                 */
                dispatchFault(fault){
                    if (!kernel.currentThread() || fault.stack === undefined
                        || !seh.claims(fault.vector))
                    {
                        return null;
                    }
                    const registers = {
                        ...Object.fromEntries(
                            registerNames.map(name=>[name, cpuRegisters.read(name)])),
                        eax: fault.eax ?? 0,
                        edx: fault.edx ?? 0,
                        esp: fault.stack,
                        // A breakpoint is reported at the instruction, not after
                        // it, as the system reports one.
                        eip: fault.vector === 3 ? fault.eip - 1 >>> 0 : fault.eip,
                        eflags: fault.eflags,
                    };
                    return seh.onFault(fault, registers).then(result=>(result.handled
                        ? bridge.continueAt(/** @type {Record<string, number>} */ (result.registers))
                        : null));
                },

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
                    windows: current ? current.windows() : [],
                    windowProcedures: current ? current.windowProcedures() : [],
                    exitCode: current ? current.exitCode() : null,
                },
            };
        },

        async dispose(){
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const win32Module = createWin32Module();
