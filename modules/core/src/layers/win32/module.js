/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createConsoleFunctions, HANDLE_STDOUT, HANDLE_STDERR } from './kernel32/console.js';
import { createThreadingFunctions } from './kernel32/threading.js';
import { createFiberFunctions } from './kernel32/fibers.js';
import { createNamedObjects, createRemoteNamedObjects } from './kernel32/named-objects.js';
import { createRegistryService } from './advapi32/registry-service.js';
import { createDebugFunctions } from './kernel32/debug.js';
import { createHeapAllocator, createHeapFunctions } from './kernel32/heap.js';
import { createProcessFunctions, createThreadState } from './kernel32/process.js';
import { TEB } from './kernel32/teb.js';
import { createModuleFunctions } from './kernel32/modules.js';
import { createFileFunctions } from './kernel32/files.js';
import { createRichEditControls } from './riched/richedit.js';
import { createRichedLibraries } from './riched/libraries.js';
import { createSyncFunctions } from './kernel32/sync.js';
import { createCodeArena } from './kernel32/code-arena.js';
import { createGuestHeap } from './kernel32/guest-heap.js';
import { createCriticalSections } from './kernel32/critical.js';
import { createLocaleFunctions, encodeAnsi } from './kernel32/locale.js';
import { createEnvironmentFunctions, createUserenvFunctions, defaultEnvironment }
    from './kernel32/environment.js';
import { createThreadPool } from './kernel32/pool.js';
import { reportedVersion, windowsVersion } from './kernel32/versions.js';
import { createSystemFunctions } from './kernel32/system.js';
import { PROCESSOR, createProcessors } from './kernel32/processor.js';
import { createPdhFunctions, createPowrprofFunctions } from './power/functions.js';
import { createSpawner, createSpawnFunctions, writeThroughProtection } from './kernel32/spawn.js';
import { createAtomFunctions } from './kernel32/atoms.js';
import { createSeh } from './kernel32/seh.js';
import { createEntryPointCaller, createGuardedCaller } from './kernel32/dllentry.js';
import { createThreadCalls, DLL_THREAD_DETACH } from './kernel32/thread-calls.js';
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
import { createMsvcr80Functions } from './msvcrt/msvcr80.js';
import { createMsvcp80Functions } from './msvcrt/msvcp80.js';
import { createUcrtbaseFunctions } from './msvcrt/ucrtbase.js';
import { createWindowFunctions } from './user32/windows.js';
import { createWindowDirectory } from './user32/directory.js';
import { createMessageQueue } from './user32/messages.js';
import { createRegistryFunctions } from './advapi32/functions.js';
import {
    ADMINISTRATORS_SID, USER_SID_TEXT, createTokenFunctions, isTokenMember,
} from './advapi32/tokens.js';
import { createServiceFunctions } from './advapi32/services.js';
import { createCryptoFunctions } from './advapi32/crypto.js';
import {
    DIRECTX_RELEASES, createHive, shellFolderDirectories, shellFolders,
} from './advapi32/registry.js';
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
import { SHELL32_ORDINALS, createShellFunctions } from './shell32/functions.js';
import { registerShellLinkClasses } from './shell32/shelllink.js';
import { registerInternetShortcutClass } from './shell32/internet-shortcut.js';
import { registerWbemClasses } from './ole32/wbem.js';
import { registerDxDiagClasses } from './ole32/dxdiag.js';
import { registerJScriptClass } from './jscript/active-script.js';
import { registerVBScriptClass } from './vbscript/active-script.js';
import { createRpcFunctions } from './rpcrt4/functions.js';
import { createVersionFunctions } from './version/functions.js';
import { createLzFunctions } from './lz32/functions.js';
import { createMspatchaFunctions } from './mspatcha/functions.js';
import { createCommonDialogFunctions } from './comdlg32/functions.js';
import { createImmFunctions } from './imm32/functions.js';
import { createShlwapiFunctions } from './shlwapi/functions.js';
import { createIphlpapiFunctions } from './iphlpapi/functions.js';
import { createCrypt32Functions } from './crypt32/functions.js';
import { createAdvpackFunctions } from './advpack/functions.js';
import { SFC_ORDINALS, createSfcFunctions } from './sfc/functions.js';
import { createHidFunctions } from './hid/functions.js';
import { ODBC32_ORDINALS, createOdbcFunctions } from './odbc32/functions.js';
import { createOleaccFunctions } from './oleacc/functions.js';
import { createSyssetupFunctions } from './syssetup/functions.js';
import { createDbghelpFunctions } from './dbghelp/functions.js';
import { createCfgmgrFunctions } from './cfgmgr32/functions.js';
import { createMsvfwFunctions } from './msvfw32/functions.js';
import { createAvifilFunctions } from './avifil32/functions.js';
import { DPLAYX_ORDINALS, createDplayFunctions, registerDplayClasses } from './dplayx/functions.js';
import { createIostreamFunctions } from './msvcirt/functions.js';
import { formatToString } from './msvcrt/format.js';
import { createDsetupFunctions } from './dsetup/functions.js';
import { createDpnhpastFunctions } from './dpnhpast/functions.js';
import { createSetupapiFunctions } from './setupapi/functions.js';
import { createMsiFunctions } from './msi/functions.js';
import { createProgramFunctions } from './programs/functions.js';
import { PROGRAMS_LIBRARY } from './programs/table.js';
import { createEventLogFunctions } from './advapi32/eventlog.js';
import { createCabinetFunctions } from './cabinet/functions.js';
import { MSI_ORDINALS } from './msi/ordinals.js';
import { SHLWAPI_ORDINALS } from './shlwapi/forwards.js';
import { COMPUTER_NAME } from './kernel32/drives.js';
import { USER_NAME } from './advapi32/functions.js';
import { createWintrustFunctions } from './wintrust/functions.js';
import { createD3dxFunctions } from './d3dx9/functions.js';
import { createSpoolerFunctions } from './winspool/functions.js';
import { createNetworkFunctions } from './mpr/functions.js';
import { createNetbiosFunctions, createSensFunctions, createSessionNotificationFunctions,
    createTelephonyFunctions } from './offline/functions.js';
import { createAcmFunctions } from './msacm32/functions.js';
import { createThemeFunctions } from './uxtheme/functions.js';
import { createWininetFunctions } from './wininet/functions.js';
import { createOleFunctions, createTaskAllocator } from './ole32/functions.js';
import { createClassTable } from './ole32/remote.js';
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
 * versioned and debug siblings, `crtdll`, and the universal runtime under its
 * own name and its API sets'.
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
const CDECL_LIBRARIES =
    /^(msvcrt|msvcr\d+d?|msvcp\d+d?|crtdll|ucrtbase|api-ms-win-crt-[a-z0-9-]+|cabinet)\.dll$/i;

/**
 * The runtimes built over msvcrt's table, msvcrt first: whichever of them a
 * program loaded holds the variables the runtime's state lives in -- a program
 * of the universal runtime loads ucrtbase and never msvcrt, and its standard
 * streams were records at address zero.
 */
const CRT_IMAGES = ['msvcrt.dll', 'ucrtbase.dll', 'MSVCR80.dll', 'MSVCR71.dll', 'CRTDLL.dll'];

/** The reason a DllMain is called with when its library is unloaded, or the process ends. */
const DLL_PROCESS_DETACH = 0;

/** RaiseException's flag for an exception execution cannot continue from. */
const EXCEPTION_NONCONTINUABLE = 1;

/** A path as GetModuleFileNameA writes one: MAX_PATH characters and the terminator. */
const MAX_PATH_BYTES = 261;

/** How many refused file opens a report names, the latest. */
const REFUSED_OPENS_KEPT = 32;

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

/**
 * What imagehlp.dll exports of dbghelp's (Wine's imagehlp.spec forwards them
 * there): the 32-bit symbol calls, the stack walk and the name undecorator.
 */
const IMAGEHLP_EXPORTS = new Set([
    'StackWalk', 'SymCleanup', 'SymFunctionTableAccess', 'SymGetModuleBase', 'SymGetOptions',
    'SymGetSymFromAddr', 'SymGetLineFromAddr', 'SymInitialize', 'SymLoadModule',
    'SymSetOptions', 'UnDecorateSymbolName', 'MakeSureDirectoryPathExists',
    'StackWalk64', 'SymGetModuleBase64', 'SymFunctionTableAccess64', 'SymFromAddr',
    'SymGetLineFromAddr64', 'SymGetModuleInfo64', 'SymEnumerateModules64',
    'SearchTreeForFile',
]);

/**
 * The DirectX a bottle's graphics choice names, by major version; undefined
 * for the default 9.0c, which a setup may still overwrite.
 *
 * @param {unknown} choice
 */
function directxOf(choice){
    if (choice === undefined)
    {
        return undefined;
    }
    const release = DIRECTX_RELEASES[/** @type {'7' | '8' | '9'} */ (String(choice))];
    if (!release)
    {
        throw new Error(`unknown DirectX ${JSON.stringify(choice)}: `
            + `the choices are ${Object.keys(DIRECTX_RELEASES).join(', ')}`);
    }
    return release;
}

/** The guest milliseconds a Sleep(0) that gives its turn away sits out. */
const SLEEP_ZERO_ASIDE_MS = 1;

/**
 * The registry a run starts from, as its first process makes it: the keys of
 * the Windows and the DirectX the machine is, and the processor at the speed
 * the engine's counter runs, under the name it is given. For a run whose
 * processes all stand in workers of their own, which the system makes before
 * any of them.
 *
 * @param {{ windows?: string, directx?: unknown, processorMhz?: number,
 *     processorName?: string, processors?: number }} [config]
 *     `processors`: how many the machine has -- the executors a process of
 *     the run is given, a CentralProcessor key for each; absent, one.
 */
export function createRunRegistry(config){
    return createRegistryService(createHive({ processorMhz: config?.processorMhz,
        processorName: config?.processorName, processors: config?.processors,
        windows: windowsVersion(config?.windows), directx: directxOf(config?.directx) }));
}

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
    /** Takes this process's windows out of the run's when it ends. */
    let leaveWindows = ()=>{};

    return {
        name: 'win32',
        version: '0.2.0',
        requires: /** @type {readonly string[]} */ ([
            'bridge',
            'kernel',
            'memory',
            'loader',
            'filesystem',
            'media',
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
            const directx = directxOf(config?.directx);
            // What the running program is told, which Windows 10 decides from
            // what the program says it knows; everything else keeps the truth.
            const reported = reportedVersion(windows, config?.compatibility);
            const folders = shellFolders(windows);

            const memory = host.requireApi('memory');
            const kernel = host.requireApi('kernel');
            const bridge = host.requireApi('bridge');
            const filesystem = host.requireApi('filesystem');
            const journal = host.requireApi('log');
            // The processors this process is told of -- one for each executor
            // the kernel runs its threads on -- and its affinity: one record,
            // which every interface that counts or sets them asks at the call.
            const processors = createProcessors(kernel);
            /**
             * A thread made here starts on its process's processors, and with a
             * block of its own, made by whoever owns the process's, which win32
             * is only handed.
             *
             * @param {any} thread
             */
            const threadMade = thread=>{
                processors.adopt(thread);
                config?.threadBlock?.(thread);
            };
            /** The variables the process starts with: its parent's, or the machine's. */
            const startingEnvironment = ()=>config?.environment
                ?? defaultEnvironment(windows, folders, processors.count());

            // What the run's processes share, as one Windows does: handed in
            // from outside when there is a process beside or after this one
            // to share it with; a caller with nothing to share it with gets
            // its own. The one namespace a mutex, event, semaphore, timer and
            // file mapping all share is part of it.
            /** @type {{ namedObjects: Map<string, any>, registry: any, windows?: any,
             *     objects?: any } | null} */
            const system = config?.system ?? null;
            // Across a link the run's namespace is asked there, and the
            // objects here are stand-ins for the run's (`system-objects.js`).
            const namedObjects = system?.objects
                ? createRemoteNamedObjects({ objects: system.objects, kernel })
                : createNamedObjects({ table: system?.namedObjects });
            // What GetCurrentProcessId answers: a child is the process its parent
            // was told of in PROCESS_INFORMATION, not a second copy of the first.
            const processId = (config?.processId ?? 0x1000) >>> 0;

            /** @type {Record<string, Record<string, any>>} */
            let libraries = {};
            /**
             * Each thread's error information: oleaut32's SetErrorInfo and
             * GetErrorInfo, and a call between processes handing a failure
             * back to the thread that made it.
             *
             * @type {Map<unknown, number>}
             */
            const errorSlots = new Map();
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
             *     deactivations: () => number,
             *     rawInput: (report: import('./user32/rawinput.js').RawInputEvent) => void,
             *     modalLoop: import('./user32/windows.js').WindowService['modalLoop'],
             *     painting: () => boolean, refreshContext?: (hdc: number) => void,
             *     surfaceOf?: (hwnd: number) => { hwnd: number, rect: any } | null,
             *     modalPump?: (thread: unknown) => number | Promise<number>,
             *     surfaces?: () => { hwnd: number, rect: any, shown: boolean,
             *         shape: any[] }[] }} */
            let windowService = {
                list: ()=>[], clientRect: ()=>null, place: ()=>false, active: ()=>0,
                deactivated: ()=>false, deactivations: ()=>0, rawInput: ()=>{},
                modalLoop: ()=>0, painting: ()=>false,
            };

            /** @type {(handle: number, text: string) => void} */
            const toConsole = config?.onOutput ?? (()=>{});
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
            /** Where kernel32 put one of its routines that runs in the guest. @param {string} name */
            const kernel32Export = name=>modules.find('kernel32.dll')?.addressOf?.(name) ?? 0;
            /** The C runtime image the program loaded (`CRT_IMAGES`), or null before it has one. */
            const crtImage = ()=>CRT_IMAGES.map(name=>modules.find(name)).find(Boolean) ?? null;
            // The scan under the C string functions whose answer is a position
            // rather than a text: it walks the same chunks readCString does and
            // never materialises the string.
            const scanCString = (/** @type {number} */ address, /** @type {number} */ limit,
                /** @type {Uint8Array} */ wanted)=>memory.scanCString(address, limit, wanted);
            /** A NUL-terminated string's units before its terminator, 1- or 2-byte units,
             * as far as its region goes. @param {number} address @param {number} unit */
            const stringLength = (address, unit)=>(unit === 1
                ? memory.scanCString(address, 0x7fffffff).index
                : memory.scanWideString(address, 0x7fffffff));

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

            // The run's class table, which is also where RPC endpoints are
            // found: COM and RPC between processes meet in the one table, and
            // a process with no run around it has one of its own.
            const comHost = config?.com ?? { table: createClassTable(), process: null };

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
                /** @param {any} object */
                holds: object=>kernel.handles.holds(object),
            };

            const { setError, lastErrorOf, setErrorOn: setErrorOnBlock } = createThreadState(
                ()=>kernel.currentThread(),
                { readU32: memory.readU32, writeU32: memory.writeU32 });
            // Absent unless a bundle is mounted, in which case a read of a block
            // that is not here yet becomes a wait rather than a fault.
            const volume = createVolume(filesystem, config?.fetchBlocks ?? null);
            // A child whose parent handed it files for its output and error
            // writes there, at the position it shares with the parent's handle,
            // rather than to the console.
            /** @type {{ output?: { path: string, position: number },
             *           error?: { path: string, position: number } } | undefined} */
            const standardFiles = config?.standardFiles;
            /** @param {number} handle @param {string} text */
            const sink = (handle, text)=>{
                const file = handle === HANDLE_STDOUT ? standardFiles?.output
                    : handle === HANDLE_STDERR ? standardFiles?.error : undefined;
                // The parent's own open file, handed on: written on the terms
                // it was opened with, whatever another open would be refused.
                const node = file && volume.open(file.path, { write: true, inherited: true });
                if (!file || !node)
                {
                    toConsole(handle, text);
                    return;
                }
                file.position += volume.write(node, file.position, encodeAnsi(text));
                volume.close(node);
            };
            // The registry is the run's: the first process's, handed to every
            // process after it rather than copied into each, so a key a parent
            // writes is there for its child the moment it is written, and the
            // child's writes are the parent's without being carried back when
            // it exits. Reached through the system half's interface, which
            // names keys by number (`registry-service.js`): what a process in
            // a worker of its own will be able to call across a ring.
            const inheritedHive = system?.registry ?? null;
            const hive = inheritedHive
                ?? createRunRegistry({ ...config, processors: processors.count() });
            if (system)
            {
                system.registry = hive;
            }
            // A window handle is the run's, and a window of another process is
            // found and posted to through it (`user32/directory.js`).
            const windowDirectory = system?.windows ?? createWindowDirectory();
            if (system)
            {
                system.windows = windowDirectory;
            }
            leaveWindows = ()=>windowDirectory.detach(processId);
            // A process's windows end with it, for every other process too.
            endTasks.push(()=>leaveWindows());
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
            /** The desktop's own timer, made the first time it has to wait. @type {any} */
            let desktopClock = null;

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
            /**
             * What the libraries are told of a thread's start and end, on the
             * thread: every thread made after the first begins in its routine.
             */
            const threadCalls = createThreadCalls({
                register: (name, fn)=>bridge.register(name, fn),
                allocate: bytes=>heap.allocate(bytes),
                allocateCode: bytes=>heap.allocateCode(bytes),
                writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
                images: ()=>modules.threadCalls?.() ?? [],
                loaderLock: ()=>{
                    const address = modules.loaderLock?.() ?? 0;
                    const enter = kernel32Export('EnterCriticalSection');
                    const leave = kernel32Export('LeaveCriticalSection');
                    return address === 0 || enter === 0 || leave === 0
                        ? null
                        : { address, enter, leave };
                },
            });
            /**
             * A thread ending itself, by ExitThread, by FreeLibraryAndExitThread
             * or by returning: each library is told DLL_THREAD_DETACH on it
             * first. The last one's end
             * is the process's, with its code, as on Windows -- the libraries
             * are told DLL_PROCESS_DETACH instead, as ExitProcess tells them.
             *
             * @param {any} thread @param {number} code
             * @returns {Promise<number> | null} null once it has ended, else the
             *     promise of telling the libraries and then ending it
             */
            const endThread = (thread, code)=>{
                const others = kernel.threads().some((/** @type {any} */ other)=>
                    other !== thread && other.state !== 'terminated');
                if (!others && exitCode === null)
                {
                    // On this thread, which goes on standing while they are told.
                    const told = detachAndEnd(code);
                    if (told === null)
                    {
                        kernel.exitThread(thread, code, true);
                    }
                    return told;
                }
                const walk = others && threadCalls.pending() ? threadCalls.walk() : 0;
                if (walk === 0)
                {
                    threadEnded(thread, code);
                    return null;
                }
                // Once its call is suspended, so that the loader's frame goes
                // below where the call left the stack.
                return Promise.resolve().then(()=>callGuarded({
                    entry: walk, args: [DLL_THREAD_DETACH], thread, failed: 0,
                    report: exception=>config?.divergence?.('DllMain', `exception 0x${exception}`
                        + ' telling the libraries of a thread\'s end, taken by the loader'),
                })).then(()=>{
                    threadEnded(thread, code);
                    return 0;
                });
            };
            /**
             * The thread gone. Two ending at once each saw the other standing
             * and told the libraries of their own end, so the second gone
             * ends the process: no thread is left to tell them of it.
             *
             * @param {any} thread @param {number} code
             */
            const threadEnded = (thread, code)=>{
                // Said outright rather than read off the processor: ended once
                // its detach has run, or FreeLibraryAndExitThread's library's,
                // when any thread may be there, a thread that ended itself
                // gives its stack back whoever is running.
                kernel.exitThread(thread, code, true);
                if (exitCode === null && kernel.threads().every(
                    (/** @type {any} */ other)=>other.state === 'terminated'))
                {
                    exitCode = code;
                    processEnded();
                }
            };
            const threadReturnAddress = ()=>{
                threadReturnStub ??= bridge.register('<thread-returned>', {
                    argBytes: 0,
                    // Reached by a `ret`, so the answer is already in EAX and the
                    // trap needs EAX for itself; the stub moves it to ECX first.
                    preserveResult: true,
                    handler: ()=>{
                        const thread = kernel.currentThread();
                        return endThread(thread, cpuRegisters.read('ecx') >>> 0)
                            ?? bridge.park(thread);
                    },
                });
                return threadReturnStub ?? 0;
            };
            const com = createComRegistry();
            /** @type {import('./msacm32/functions.js').AcmCodec[]} */
            const acmCodecs = [];

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
                // A renderer the program wrote is fed from a thread of its own,
                // as quartz feeds one from its streaming thread; made on the
                // first sample, so a program with no such filter has none.
                stream: {
                    readU32: address=>memory.readU32(address),
                    writeMemory,
                    readWideString: (address, maxLength)=>readWideString(address, maxLength),
                    allocate: bytes=>heap.allocate(bytes),
                    free: address=>heap.free(address),
                    callGuest: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    currentThread: ()=>kernel.currentThread(),
                    publish: (object, iid)=>bridge.publishInterface(object, iid),
                    objectAt: pointer=>bridge.interfaceObject(pointer),
                    notices: {
                        deliver: (entry, args, done, tag)=>
                            streamNotices.deliver(entry, args, done, tag),
                        drop: tag=>streamNotices.drop(tag),
                    },
                },
            });

            // One allocator over the whole arena. Everything the guest is handed
            // memory from -- the heap it asks for, the bits of a DIB section, COM
            // task memory, a vtable -- comes out of the same free list, because
            // carving it up in advance is guessing at proportions nobody knows.
            //
            // A heap's small blocks are the guest's own (`guest-heap.js`): what
            // every host path is handed is the arena's allocator with those
            // found, sized and freed where they are.
            const guestHeap = createGuestHeap({
                allocator: createHeapAllocator(arena),
                arena,
                memory: {
                    readU16: address=>memory.readU16(address),
                    readU32: address=>memory.readU32(address),
                    writeU16: (address, value)=>memory.writeU16(address, value),
                    writeU32: (address, value)=>memory.writeU32(address, value),
                    readBytes: (address, length)=>memory.readBytes(address, length),
                    writeBytes: (address, bytes)=>memory.writeBytes(address, bytes),
                    fillBytes: (address, value, length)=>memory.fillBytes(address, value, length),
                    compareExchangeU32: (address, expected, value)=>
                        memory.compareExchangeU32(address, expected, value),
                },
            });
            const allocator = guestHeap.wrap();
            // Counted by the mapping calls as they go.
            const mappings = { views: 0, waited: 0, failed: 0 };
            /**
             * The last opens refused (`refusedOpens`).
             *
             * @type {{ path: string, error: number, access: number, share: number,
             *     disposition: number }[]}
             */
            const refusedOpens = [];
            // The guest code the engine writes itself, on pages nothing else is
            // handed (`code-arena.js`).
            const placeCode = createCodeArena(bytes=>allocator.allocate(bytes));
            const heap = {
                /** @param {number} bytes @param {any} [options] */
                allocate: (bytes, options)=>allocator.allocate(bytes, options),
                /** @param {number} bytes */
                allocateCode: bytes=>placeCode(bytes),
                /** @param {number} address */
                free: address=>allocator.free(address),
                /** @param {number} address */
                block: address=>allocator.block(address),
                /**
                 * A block at exactly that address, when all of it is free: the
                 * span of a library that cannot move, given up by the arena.
                 *
                 * @param {number} address @param {number} bytes @param {any} [options]
                 */
                allocateAt: (address, bytes, options)=>
                    allocator.allocateAt(address, bytes, options),
                /** @param {number} address @param {number} bytes */
                resize: (address, bytes)=>allocator.resize(address, bytes),
                // What is left of it. A program sizes its own caches from this
                // through GlobalMemoryStatus, so anything that takes from the arena
                // and does not give back changes how the program behaves.
                diagnostics: ()=>allocator.diagnostics(),
                // Where the arena has never been handed out: the memory above
                // it is still zero, for a process that takes this one's memory.
                handedTo: ()=>allocator.handedTo(),
            };
            bridge.useHeap(heap);

            // Built here rather than with the other tables because two things need
            // it: the library a program links against, and the drawing layer, which
            // asks it for a device context over pixels GDI did not allocate.
            /**
             * Whether the guest may write there: what a call that fills in a
             * caller's structure checks first, to answer ERROR_NOACCESS for a
             * bad pointer rather than stop the machine.
             *
             * @param {number} address @param {number} length
             */
            const canWrite = (address, length)=>{
                // A memory layer that cannot say takes every write it is given.
                if (typeof memory.assert !== 'function')
                {
                    return true;
                }
                try
                {
                    memory.assert(address >>> 0, Math.max(1, length), 'write');
                    return true;
                }
                catch (e){
                    void e;
                    return false;
                }
            };
            const gdi = createGdiFunctions({
                readMemory,
                writeMemory,
                fillMemory,
                readCString,
                windowContextCurrent: hdc=>windowService.refreshContext?.(hdc),
                canWrite,
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
                // configuration is read. A draw into a window shows the
                // desktop, except in the middle of a paint pass, which shows it
                // once it is over (user32's present below).
                graphics: config?.graphics && Object.assign(Object.create(config.graphics), {
                    presentDesktop: (/** @type {any} */ dc)=>{
                        if (!windowService.painting())
                        {
                            config.graphics?.presentDesktop?.(dc);
                        }
                    },
                }),
                // A font enumeration's callback is the program's own code.
                call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                callerThread: ()=>bridge.callerThread(),
                setLastError: setError,
            });

            // The transport is injected, as the GPU device and the block store are.
            // Without one this is a machine with a network card and no cable: every
            // call behaves, and nothing reaches anywhere.
            const sockets = createSocketRegistry({
                adapter: config?.network ?? createLoopbackAdapter(),
            });
            const winsock = createWinsockFunctions({
                readMemory,
                // The WSA events are kernel32's events, and TransmitFile reads
                // its file through ReadFile: kernel32's own exports, looked up
                // when called, as the table is built below.
                /** @param {string} name */
                kernel32: name=>libraries['KERNEL32.dll']?.[name]?.handler,
                divergence: config?.divergence,
                writeMemory,
                readCString,
                heap,
                currentThread: ()=>kernel.currentThread(),
                registry: sockets,
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
                    threadMade(thread);
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

            // The thread a filter graph calls a program's own filters on: the
            // samples it feeds a renderer the program wrote, and the flushes and
            // releases it owes that renderer.
            const streamNotices = createNoticeThread({
                name: 'quartz',
                reason: 'a filter graph sample',
                trap: '<quartz-stream>',
                /** @param {number} bytes */
                allocate: bytes=>heap.allocate(bytes),
                writeMemory,
                register: (name, fn)=>bridge.register(name, fn),
                /** @param {{ entry: number, name: string }} options */
                createThread: options=>{
                    const thread = kernel.createThread(options);
                    threadMade(thread);
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
                    threadMade(thread);
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
                // A film MCI opens is played as a filter graph plays one: the
                // same decoder, clock, window and presenter.
                film: ()=>quartz.film(),
                // The key a film's `break ... on` names, held now or pressed
                // since the last look, read as MCI reads it: GetAsyncKeyState,
                // whose low bit a tap between two looks leaves set.
                keyDown: key=>((config?.asyncKeyState?.(key) ?? 0) & 0x8001) !== 0,
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
            /** The handler of the dispatch's own frame: ExceptionContinueSearch. */
            let dispatcherFrameTrap = 0;
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
                answerWith: (value, registers)=>bridge.answerWith(value, registers),
                /** @param {any} call */
                callGuest: call=>bridge.callGuest(call),
                dispatcherHandler: ()=>(dispatcherFrameTrap ||= bridge.register(
                    '<exception dispatcher frame>', { argBytes: 0, handler: ()=>1 })),
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

            /**
             * Bytes put in guest memory for as long as `use` runs, a call it
             * parks on included: what a call that takes a pointer is handed
             * from the host.
             *
             * @param {Uint8Array} bytes @param {(address: number) => any} use
             * @returns {number | Promise<number>}
             */
            const lent = (bytes, use)=>{
                const at = heap.allocate(Math.max(bytes.length, 4));
                if (at === 0)
                {
                    return 0;
                }
                writeMemory(at, bytes);
                const answer = use(at);
                if (typeof answer?.then === 'function')
                {
                    return answer.then((/** @type {number} */ value)=>{
                        heap.free(at);
                        return value >>> 0;
                    });
                }
                heap.free(at);
                return answer >>> 0;
            };

            /**
             * ole32's maker and reader of OBJREFs, which the NDR runtime's
             * interface pointers cross as: offered by ole32 as it is built.
             *
             * @type {import('./rpcrt4/runtime.js').ObjrefMarshaler | null}
             */
            let objrefMarshaler = null;

            /**
             * RpcRaiseException: the status raised on the calling thread,
             * noncontinuable, as the generated code's exception blocks expect.
             *
             * @param {number} code
             */
            const raiseRpc = code=>libraries['KERNEL32.dll'].RaiseException.handler(
                [code >>> 0, EXCEPTION_NONCONTINUABLE, 0, 0]);
            let rpcRaiseTrap = 0;
            /**
             * The same from a handler that has awaited something, and is no
             * longer where its thread's registers are: the thread is sent from
             * where the call would have returned into a routine that raises,
             * as though the call had ended by calling RpcRaiseException -- so
             * the exception carries that thread's own stack and frames.
             *
             * @param {number} code @param {any} thread
             */
            const raiseRpcLater = (code, thread)=>{
                const call = thread?.hostCalls?.at(-1);
                if (!call)
                {
                    return Promise.resolve(raiseRpc(code));
                }
                rpcRaiseTrap ||= bridge.register('<RpcRaiseException>', {
                    argBytes: 4,
                    /** @param {number[]} args */
                    handler: ([status])=>raiseRpc(status),
                });
                const esp = (call.restingStack - 8) >>> 0;
                memory.writeU32(esp, call.hostReturn >>> 0);
                memory.writeU32(esp + 4, code >>> 0);
                return Promise.resolve(bridge.continueAt({ eip: rpcRaiseTrap, esp },
                    { below: call.restingStack >>> 0 }));
            };

            /**
             * Where a module was loaded from, as GetModuleFileName answers.
             *
             * @param {number} module
             * @returns {string | null}
             */
            const modulePath = module=>{
                const buffer = heap.allocate(MAX_PATH_BYTES);
                if (buffer === 0)
                {
                    return null;
                }
                const length = libraries['KERNEL32.dll'].GetModuleFileNameA.handler(
                    [module >>> 0, buffer, MAX_PATH_BYTES]) >>> 0;
                const path = length > 0 ? readCString(buffer, MAX_PATH_BYTES) : null;
                heap.free(buffer);
                return path;
            };

            /** Each apartment window's procedure, by window. */
            /** @type {Map<number, (message: number) => number | Promise<number>>} */
            const apartmentProcedures = new Map();
            let apartmentClass = 0;
            /**
             * A hidden window on the calling thread whose messages go to
             * `handler`: "OleMainThreadWndClass", as ole32 names its own.
             *
             * @param {(message: number) => number | Promise<number>} handler
             * @returns {number | Promise<number>}
             */
            const apartmentWindow = handler=>{
                const user32 = libraries['USER32.dll'];
                const name = encodeAnsi('OleMainThreadWndClass\0');
                if (apartmentClass === 0)
                {
                    const procedure = bridge.register('<OleMainThreadWndProc>', {
                        argBytes: 16,
                        /** @param {number[]} args */
                        handler: ([hwnd, message, wParam, lParam])=>{
                            const own = apartmentProcedures.get(hwnd >>> 0);
                            return own && (message >>> 0) === 0x0400
                                ? own(message >>> 0)
                                : user32.DefWindowProcA.handler([hwnd, message, wParam, lParam]);
                        },
                    });
                    const wndclass = new Uint8Array(40 + name.length);
                    const view = new DataView(wndclass.buffer);
                    view.setUint32(4, procedure >>> 0, true);
                    apartmentClass = /** @type {number} */ (lent(wndclass, at=>{
                        writeMemory(at + 40, name);
                        view.setUint32(36, at + 40, true);
                        writeMemory(at, wndclass.subarray(0, 40));
                        return user32.RegisterClassA.handler([at]);
                    }));
                }
                // Known by its procedure before it exists: the messages that
                // make a window arrive while it is being made.
                const made = lent(name, at=>user32.CreateWindowExA.handler(
                    [0, at, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
                /** @param {number} hwnd */
                const keep = hwnd=>{
                    if (hwnd !== 0)
                    {
                        apartmentProcedures.set(hwnd, handler);
                    }
                    return hwnd;
                };
                return typeof made === 'number' ? keep(made) : made.then(keep);
            };

            // The one IMalloc, shared by ole32 and shell32: a block the shell
            // hands out is freed through the allocator COM hands out.
            const comVtables = {
                /** @param {any} object @param {string} interfaceId */
                publish: (object, interfaceId)=>bridge.publishInterface(object, interfaceId),
                /** @param {any} object @param {string} interfaceId */
                unpublish: (object, interfaceId)=>bridge.unpublishInterface(object, interfaceId),
            };
            const taskAllocator = createTaskAllocator({
                heap, registry: com, vtables: comVtables, readMemory, writeMemory,
            });

            // shell32's COM class, registered beside the shell's own table because
            // an installer reaches it through CoCreateInstance rather than an
            // export. It saves onto the same volume every file call uses and hands
            // back strings from the same task heap CoTaskMemAlloc does.
            /** @type {Parameters<typeof registerShellLinkClasses>[1]} */
            const shortcutHost = {
                readMemory,
                writeMemory,
                readCString,
                readWideString,
                /** @param {number} bytes */
                allocate: bytes=>heap.allocate(bytes),
                files: volume,
                divergence: config?.divergence,
            };
            registerShellLinkClasses(com, shortcutHost);
            // The `.url` beside it: a setup's link to its publisher's site.
            registerInternetShortcutClass(com, /** @type {any} */ (shortcutHost));

            // WMI's locator, which a program asks about its video memory and its
            // machine.
            registerWbemClasses({
                registry: com, vtables: comVtables, heap, readMemory, writeMemory, readWideString,
                physicalMemory: arena.size, processors: processors.count(), windows: reported,
                divergence: config?.divergence, processorMhz: config?.processorMhz,
            });

            // DxDiag's provider, which an installer asks which DirectX this is
            // and a configuration tool how much video memory there is.
            registerDxDiagClasses({
                registry: com, vtables: comVtables, heap, readMemory, writeMemory, readWideString,
                windows, directx, screen: config?.screen, physicalMemory: arena.size,
                divergence: config?.divergence,
            });

            // DirectPlay's session and lobby objects, which a program makes
            // through COM as often as through dplayx's exports.
            /** @type {import('./dplayx/session.js').SessionHost} */
            const dplayHost = {
                writeMemory, readMemory,
                allocate: bytes=>heap.allocate(bytes),
                callGuest: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                callerThread: ()=>bridge.callerThread(),
            };
            registerDplayClasses(com, dplayHost);

            // JScript and VBScript, the Active Scripting engines a host -- an
            // installer's script, a page, a configuration tool -- asks COM for,
            // both on one host of the scripting interfaces.
            /** @type {Parameters<typeof registerJScriptClass>[0]} */
            const scriptHost = {
                registry: com,
                publish: (object, iid)=>bridge.publishInterface(object, iid),
                com: {
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                    readMemory, writeMemory,
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                    /** @param {number} address */
                    free: address=>heap.free(address),
                    /** @param {string} name @param {number[]} args */
                    oleaut32: (name, args)=>libraries['OLEAUT32.dll'][name].handler(args),
                },
                /**
                 * @param {string} library @param {string} name @param {number[]} args
                 * @param {unknown} [thread]
                 */
                system: (library, name, args, thread)=>{
                    const entry = libraries[library]?.[name];
                    if (!entry)
                    {
                        return null;
                    }
                    return thread ? bridge.answering(thread, ()=>entry.handler(args))
                        : entry.handler(args);
                },
                threadId: ()=>kernel.currentThread().id >>> 0,
                now: ()=>kernel.clock.wallClock(),
                divergence: config?.divergence,
            };
            registerJScriptClass(scriptHost);
            registerVBScriptClass(scriptHost);

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
                currentDirectory: ()=>filesystem.currentDirectory(),
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

            /**
             * Where a thread whose call has suspended left its stack: the
             * guarded callers' frames go below it.
             *
             * @param {any} thread
             */
            const restingStack = thread=>Math.min(
                thread?.callbackFrames?.at(-1)?.frameBase ?? Infinity,
                thread?.hostCalls?.at(-1)?.restingStack ?? Infinity,
                Infinity) >>> 0 || cpuRegisters.read('esp') >>> 0;

            // Every DllMain and TLS callback this layer or the loader calls
            // with DLL_PROCESS_DETACH goes through the loader's own frame, so
            // an exception out of one ends it rather than reaching the
            // program's handlers.
            const callEntryPoint = createEntryPointCaller({
                register: (name, fn)=>bridge.register(name, fn),
                callGuest: call=>bridge.callGuest(call),
                continueAt: (registers, options)=>bridge.continueAt(registers, options),
                unwind: (frame, address, options)=>seh.unwind(frame, address, options),
                readU32: address=>memory.readU32(address),
                writeU32: (address, value)=>memory.writeU32(address, value),
                stackPointer: restingStack,
                teb: thread=>(thread?.tebAddress ?? kernel.currentThread()?.tebAddress ?? 0) >>> 0,
                divergence: detail=>config?.divergence?.('DllMain', detail),
            });

            // And every method a COM stub runs for another process, whose
            // exception is answered to the caller as RPC_E_SERVERFAULT rather
            // than ending the server. The stub has awaited by then, so the
            // thread's stack is where its suspended calls left it.
            const callGuarded = createGuardedCaller({
                register: (name, fn)=>bridge.register(name, fn),
                callGuest: call=>bridge.callGuest(call),
                continueAt: (registers, options)=>bridge.continueAt(registers, options),
                unwind: (frame, address, options)=>seh.unwind(frame, address, options),
                readU32: address=>memory.readU32(address),
                writeU32: (address, value)=>memory.writeU32(address, value),
                stackPointer: restingStack,
                teb: thread=>(thread?.tebAddress ?? kernel.currentThread()?.tebAddress ?? 0) >>> 0,
            });

            /** Set once the process has begun to end, so that it ends only once. */
            let ending = false;
            /**
             * ExitProcess, and the C runtime's exits that end in it: every other
             * thread ends, each image still attached is told DLL_PROCESS_DETACH
             * on this thread -- the last attached first, its TLS callbacks before
             * its entry point, and lpvReserved non-NULL because the process is
             * ending -- and only then is the code recorded, which is what stops
             * the machine. With nothing to tell, nothing else would run, so the
             * code is recorded at once. An ExitProcess from inside one of those
             * calls ends it there.
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
                /** @type {{ base: number, routines: number[] }[]} */
                const attached = ending ? [] : (modules.processDetach?.() ?? []);
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
                for (const image of attached)
                {
                    told = told.then(()=>callEntryPoint({
                        routines: image.routines, base: image.base,
                        reason: DLL_PROCESS_DETACH, reserved: 1, thread: self,
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
                user32: name=>libraries['USER32.dll']?.[name],
                bitmapSize: bitmap=>gdi.bitmapSize(bitmap),
            });

            /** The runtime's heap: HeapCreate's, the first time malloc needs it. */
            let crtHeapHandle = 0;
            const crtHeap = ()=>{
                if (crtHeapHandle === 0)
                {
                    crtHeapHandle = libraries['KERNEL32.dll'].HeapCreate.handler([0, 0, 0]);
                }
                return crtHeapHandle;
            };

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
                        // MB_OK | MB_SYSTEMMODAL, the box a hard error raises.
                        messageBox: text=>libraries['USER32.dll']?.MessageBoxA
                            ?.handler([0, text, 0, 0x1000]) ?? 0,
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
                        threadStart: ()=>threadCalls.start(),
                        endThread,
                        processId,
                        imagePath: ()=>modules.imagePath(),
                        modules: ()=>modules.list?.() ?? [],
                        divergence: config?.divergence,
                        handleWords: config?.handleWords,
                        threadBlock: threadMade,
                        /** @param {number} handle */
                        handleType: handle=>kernel.handles.typeOf(handle),
                        /** @param {any} node */
                        retainNode: node=>volume.retain(node),
                        queueApc: (thread, routine, args)=>apcs.queue(thread, routine, args),
                        /** @param {number} bytes */
                        allocate: bytes=>heap.allocate(bytes),
                        /** @param {number} bytes */
                        allocateCode: bytes=>heap.allocateCode(bytes),
                    }),
                    ...createFiberFunctions({
                        readU32: address=>memory.readU32(address),
                        writeU32: (address, value)=>memory.writeU32(address, value >>> 0),
                        registers: ()=>Object.fromEntries(
                            registerNames.map(name=>[name, cpuRegisters.read(name) >>> 0])),
                        setRegisters,
                        currentThread: ()=>kernel.currentThread(),
                        teb: ()=>kernel.currentThread()?.tebAddress ?? 0,
                        allocate: bytes=>heap.allocate(bytes),
                        free: address=>heap.free(address),
                        allocateStack: asked=>kernel.allocateStack?.(asked) ?? null,
                        releaseStack: stack=>kernel.releaseStack?.(stack),
                        threadReturn: ()=>threadReturnAddress(),
                        exitThread: code=>libraries['KERNEL32.dll'].ExitThread.handler([code]),
                        setLastError: setError,
                    }),
                    ...apcs.table,
                    ...createThreadPool({
                        kernel,
                        register: (name, fn)=>bridge.register(name, fn),
                        /** @param {number} bytes */
                        allocate: bytes=>heap.allocate(bytes),
                        /** @param {number} bytes */
                        allocateCode: bytes=>heap.allocateCode(bytes),
                        /** @param {number} address */
                        free: address=>heap.free(address),
                        writeMemory,
                        threadBlock: threadMade,
                        park: (/** @type {any} */ thread)=>bridge.park(thread),
                        setLastError: setError,
                        waitFor: (handle, milliseconds)=>libraries['KERNEL32.dll']
                            .WaitForSingleObject.handler([handle, milliseconds]),
                        threadReturn: ()=>threadReturnAddress(),
                        threadStart: ()=>threadCalls.start(),
                    }).table,
                    ...createDebugFunctions({
                        readCString,
                        readWideString: (address, maxLength)=>
                            memory.readWideString(address, maxLength),
                        say: text=>trace(text),
                    }),
                    ...createHeapFunctions({
                        arena, allocator, readMemory, writeMemory, fillMemory,
                        guestHeap,
                        /** @param {number} bytes */
                        allocateCode: bytes=>heap.allocateCode(bytes),
                        setLastError: setError,
                        divergence: config?.divergence,
                        /** @param {number} address */
                        regionAt: address=>memory.find(address),
                        /** @param {number} address */
                        nextRegionAfter: address=>memory.nextRegionAfter(address) ?? null,
                        /** @param {number} address @param {number} length @param {boolean} open */
                        pageAccess: (address, length, open)=>
                            memory.pageAccess?.(address, length, open) === true,
                        systemCounts: ()=>({
                            processes: Math.max(1, (kernel.processes?.all() ?? []).length),
                            threads: Math.max(1, kernel.threads().length),
                        }),
                    }),
                    ...createProcessFunctions({
                        processors,
                        performanceFrequency: config?.performanceFrequency,
                        readMemory,
                        processId,
                        writeMemory,
                        compareExchangeU64: (address, expected, value)=>
                            memory.compareExchangeU64(address, expected, value),
                        wordsOver: (address, length)=>memory.wordsOver?.(address, length) ?? null,
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
                        /** @param {number} address */
                        moduleContaining: address=>modules.containing?.(address)?.base ?? 0,
                        /** @param {number} base @param {boolean} pin */
                        holdModule: (base, pin)=>{
                            const held = modules.byBase(base);
                            if (held)
                            {
                                held.references = (held.references ?? 0) + 1;
                                if (pin)
                                {
                                    held.pinned = true;
                                }
                            }
                        },
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
                        // The caller gives up its turn and is woken at once with
                        // `result`: the scheduler chooses its processor again.
                        /** @param {string} reason @param {number} result */
                        reschedule: (reason, result)=>kernel.block(kernel.currentThread(), reason,
                            { deadline: kernel.clock.virtualTime(), result }),
                        // Sleep(0): the rest of the turn to another thread ready to
                        // run at the caller's priority or above, the caller behind
                        // it; false, and nothing given, when there is none. The
                        // caller sits out a millisecond of guest time, as
                        // SwitchToThread does beside lower threads: the guest's
                        // clock moves with what runs, and two threads handing
                        // each other turns of a few instructions would move it
                        // not at all -- every timed wait of theirs stood still.
                        // Where Sleep's guest code reads how many threads wait
                        // to run: the kernel keeps the word (`mirrorReady`).
                        readyWord: typeof kernel.mirrorReady === 'function'
                            ? (/** @type {number} */ address)=>kernel.mirrorReady(address)
                            : undefined,
                        yieldTurn: ()=>{
                            const self = kernel.currentThread();
                            const mine = self?.priority ?? 0;
                            const other = kernel.threads().some((/** @type {any} */ thread)=>
                                thread !== self && thread.state === 'ready'
                                && !thread.awaitingHost && (thread.priority ?? 0) >= mine);
                            if (!other || !self)
                            {
                                return false;
                            }
                            kernel.block(self, 'Sleep', {
                                deadline: kernel.clock.virtualTime() + SLEEP_ZERO_ASIDE_MS,
                                result: 0 });
                            return true;
                        },
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
                        processors,
                        // A change notification watches a directory on the
                        // same volume every file call writes through.
                        volume,
                        readMemory,
                        writeMemory,
                        compareExchangeU32: (address, expected, value)=>
                            memory.compareExchangeU32(address, expected, value),
                        compareExchangeU64: (address, expected, value)=>
                            memory.compareExchangeU64(address, expected, value),
                        currentThread: ()=>kernel.currentThread(),
                        park: (/** @type {any} */ thread)=>bridge.park(thread),
                        critical,
                        /** @param {number} bytes */
                        allocate: bytes=>heap.allocate(bytes),
                        /** @param {number} bytes */
                        allocateCode: bytes=>heap.allocateCode(bytes),
                        advanceClock: (/** @type {number} */ ms)=>kernel.clock.advance(ms),
                        setLastError: setError,
                        registers: ()=>Object.fromEntries([...registerNames, 'eflags']
                            .map(name=>[name, cpuRegisters.read(name)])),
                        divergence: config?.divergence,
                    }),
                    ...createLocaleFunctions({
                        readMemory, writeMemory, stringLength,
                        setLastError: setError,
                        divergence: config?.divergence,
                        systemTimeMs: ()=>kernel.clock.wallClock(),
                        /** @param {number} entry @param {number[]} args @param {unknown} [thread] */
                        call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                        callerThread: ()=>bridge.callerThread(),
                        /** @param {number} bytes */
                        allocate: bytes=>heap.allocate(bytes),
                        /** @param {number} address */
                        free: address=>heap.free(address),
                    }),
                    ...createResourceFunctions({
                        readCString,
                        readWideString,
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
                        writeMemory,
                        /** @param {number} bytes */
                        allocate: bytes=>heap.allocate(bytes),
                        /** @param {number} address */
                        free: address=>heap.free(address),
                    }),
                    ...createProfileFunctions({
                        readMemory,
                        writeMemory,
                        readCString,
                        readWideString,
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
                        divergence: config?.divergence,
                        writeMemory,
                        readCString,
                        readWideString,
                        setLastError: setError,
                        namedObjects,
                        metrics: mappings,
                        /** @param {number} bytes @param {{ alignment?: number }} [options] */
                        allocate: (bytes, options)=>allocator.allocate(bytes, options),
                        /** @param {number} address @param {number} bytes */
                        allocateAt: (address, bytes)=>allocator.allocateAt(address, bytes),
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
                        divergence: config?.divergence,
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
                        environment: startingEnvironment,
                    }),
                    ...createSystemFunctions({
                        processors,
                        // TerminateProcess wakes whoever waits on the child it ends.
                        wake: (/** @type {any} */ thread, /** @type {number} */ result)=>
                            kernel.wake(thread, result),
                        // And ends one running beside this process where it runs.
                        terminateChild: (/** @type {any} */ child, /** @type {number} */ code)=>
                            config?.terminate?.(child, code) === true,
                        readMemory,
                        writeMemory,
                        setLastError: setError,
                        divergence: config?.divergence,
                        ramTop: arena.size > 0 ? arena.base + arena.size : 0,
                        systemTimeMs: ()=>kernel.clock.wallClock(),
                        /** @param {number} address */
                        regionAt: address=>memory.find(address) ?? null,
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
                        readWideString,
                        setLastError: setError,
                    }),
                    ...createSpawnFunctions({
                        kernel,
                        processId,
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
                        patchMemory: (address, bytes)=>
                            writeThroughProtection(/** @type {any} */ (memory), address, bytes),
                    }),
                    ...seh.table,
                    ...createModuleFunctions({
                        readCString,
                        readWideString,
                        writeMemory,
                        readMemory,
                        find: name=>modules.find(name),
                        byBase: base=>modules.byBase(base),
                        setLastError: setError,
                        imagePath: ()=>modules.imagePath(),
                        list: ()=>modules.list?.() ?? [],
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
                        exitThread: code=>libraries['KERNEL32.dll'].ExitThread.handler([code]),
                        currentThread: ()=>kernel.currentThread(),
                        endThread,
                        /** @param {number} base */
                        disableThreadCalls: base=>modules.disableThreadCalls?.(base),
                    }),
                    // Last, deliberately: writing and closing a handle are the same
                    // entry points for a file as for a console or an event, and the
                    // one that knows about files answers for all of them.
                    ...createFileFunctions({
                        divergence: config?.divergence,
                        openRefused: record=>{
                            refusedOpens.push(record);
                            if (refusedOpens.length > REFUSED_OPENS_KEPT)
                            {
                                refusedOpens.shift();
                            }
                        },
                        readMemory,
                        windowMemory: typeof memory.window === 'function'
                            ? (address, length)=>memory.window(address, length)
                            : undefined,
                        writeMemory,
                        readCString,
                        readWideString,
                        files: volume,
                        // The libraries this build implements, standing in the
                        // system folder for a setup that looks before it loads.
                        // Every layer's, not only this one's: DDRAW.dll stands
                        // there as much as KERNEL32.dll does, and VERSION
                        // already answers for both.
                        systemLibraries: ()=>(/** @type {string[]} */ (
                            modules.systemLibraries?.() ?? Object.keys(libraries)))
                            .filter(name=>name !== PROGRAMS_LIBRARY && /\.(dll|drv|ocx)$/i.test(name)),
                        directories: shellFolderDirectories(windows),
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
                        // allocated with `malloc`, and Windows lets it. The
                        // runtime's blocks are a heap of its own, as msvcrt's
                        // are, made the first time it is asked for one.
                        allocate: bytes=>allocator.allocate(bytes, { owner: crtHeap() }),
                        free: address=>allocator.free(address),
                        block: address=>allocator.block(address),
                        resize: (address, bytes)=>allocator.resize(address, bytes),
                        guestHeap,
                        heapHandle: ()=>crtHeap(),
                        allocateCode: bytes=>heap.allocateCode(bytes),
                        systemTimeMs: ()=>kernel.clock.wallClock(),
                        now: ()=>kernel.clock.virtualTime(),
                        // The same command line GetCommandLineA reports, because a
                        // program is free to read either and compare them.
                        commandLine: ()=>config?.commandLine ?? `"${modules.imagePath()}"`,
                        // `exit` does not come back, so like ExitProcess it records
                        // the code and parks the calling thread rather than
                        // returning to a caller that no longer exists.
                        processId,
                        exitProcess: (/** @type {number} */ code)=>endProcess(code),
                        // _spawn starts what CreateProcess starts.
                        launch: (named, line, flags)=>spawner.launch(named, line, flags),
                        /** @param {number} handle */
                        closeHandle: handle=>kernel.handles.close(handle),
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
                        iob: ()=>crtImage()?.addressOf?.('_iob') ?? 0,
                        // And the tables a program reads in place -- `_mbctype`,
                        // `_environ`, the time zone's -- are rewritten where the
                        // loader placed them.
                        addressOf: name=>crtImage()?.addressOf?.(name) ?? 0,
                        // The runtime's copy of the environment starts as the
                        // variables kernel32 starts the process with.
                        environment: startingEnvironment,
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
                // With the extensions it forwards to mswsock.
                'WSOCK32.dll': { ...winsock.sockets,
                    AcceptEx: winsock.extensions.AcceptEx,
                    GetAcceptExSockaddrs: winsock.extensions.GetAcceptExSockaddrs },

                // The adapters behind the sockets: one, on the network they reach.
                'IPHLPAPI.dll': createIphlpapiFunctions({
                    readMemory, writeMemory, localAddress: ()=>sockets.localAddress(),
                }),
                // TransmitFile is wsock32's and mswsock's, never ws2_32's.
                'WS2_32.dll': Object.fromEntries(Object.entries(winsock.sockets)
                    .filter(([name])=>name !== 'TransmitFile')),
                'MSWSOCK.dll': { ...winsock.extensions,
                    TransmitFile: winsock.sockets.TransmitFile },

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
                    // CreateMappedBitmap reads and writes a bitmap's bits
                    // through gdi32's own calls, looked up when called.
                    gdi32: name=>libraries['GDI32.dll']?.[name],
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
                    // ExtractIcon hands out an icon of pixels read from another
                    // file: the object user32's CreateIcon makes.
                    icon: picture=>handles.open('icon', {
                        hotSpot: picture.hotSpot, width: picture.width,
                        height: picture.height, picture,
                    }),
                    // CommandLineToArgvW answers an empty line with this.
                    imagePath: ()=>modules.imagePath(),
                    setLastError: setError,
                    // FindExecutable resolves an executable against the current
                    // directory the file calls use, which is the filesystem's.
                    resolve: path=>filesystem.resolve(path).path,
                    // And a launch starts the program kernel32 would have started.
                    launcher: spawner,
                    /** @param {string} url */
                    openUrl: url=>config?.openUrl?.(url) ?? false,
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
                    setLastErrorFor: setErrorOn,
                    currentThread: ()=>kernel.currentThread(),
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
                    directx: directx?.version,
                }),

                'LZ32.dll': createLzFunctions({
                    readCString, readWideString, writeMemory, files: volume }),

                // The Patch API's applying half: the delta patches a Windows
                // Installer patch's PatchFiles action and setups apply.
                'MSPATCHA.dll': createMspatchaFunctions({
                    readMemory, writeMemory, readCString, readWideString,
                    setLastError: setError,
                    setLastErrorFor: setErrorOn,
                    files: volume,
                    handles: {
                        /** @param {number} handle */
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
                    },
                    // ApplyPatchToFileByBuffers' own buffer, which the program
                    // frees with VirtualFree.
                    /** @param {number} bytes */
                    virtualAlloc: bytes=>libraries['KERNEL32.dll'].VirtualAlloc
                        .handler([0, bytes, 0x3000, 0x04]) >>> 0,
                    /** @param {number} entry @param {number[]} args @param {unknown} [thread] */
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                    divergence: config?.divergence,
                }),

                'COMDLG32.dll': createCommonDialogFunctions({
                    readMemory, readCString, writeMemory,
                    // Whether a dialog's owner is a window, asked when it is
                    // called: user32's table is built after this one.
                    /** @param {number} hwnd */
                    isWindow: hwnd=>libraries['USER32.dll'].IsWindow.handler([hwnd]) === 1,
                    divergence: config?.divergence,
                }),

                'IMM32.dll': createImmFunctions({
                    writeMemory, setLastError: setError,
                    // ImmIsUIMessage hands an IME message to the window named,
                    // through user32's SendMessageA, looked up when called.
                    /**
                     * @param {number} hwnd @param {number} message
                     * @param {number} wParam @param {number} lParam
                     */
                    sendMessage: (hwnd, message, wParam, lParam)=>
                        libraries['USER32.dll'].SendMessageA
                            .handler([hwnd, message, wParam, lParam]),
                }),

                'SHLWAPI.dll': createShlwapiFunctions({
                    readCString, readWideString, readMemory, writeMemory,
                    setLastError: setError,
                    files: volume,
                    /** @param {string} path */
                    fullPath: path=>filesystem.resolve(path).path,
                    // Read when called: the table is still being built here.
                    advapi32: ()=>libraries['ADVAPI32.dll'],
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                    /** @param {number} address */
                    free: address=>heap.free(address),
                    // The exports that are another library's function, as it is
                    // when they are called: the table is still being built here.
                    /** @param {string} name */
                    library: name=>libraries[name],
                    /**
                     * Through GetTextExtentPoint32W, on the screen's context
                     * for a null one, as the program's own call would measure.
                     *
                     * @param {number} hdc @param {string} text
                     */
                    textWidth: (hdc, text)=>{
                        const user = libraries['USER32.dll'];
                        const dc = hdc !== 0 ? hdc : user.GetDC.handler([0]);
                        const bytes = new Uint8Array(text.length * 2 + 8);
                        for (let at = 0; at < text.length; at++)
                        {
                            bytes[at * 2] = text.charCodeAt(at) & 0xff;
                            bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
                        }
                        const block = heap.allocate(bytes.length);
                        try
                        {
                            writeMemory(block, bytes);
                            const size = block + text.length * 2;
                            libraries['GDI32.dll'].GetTextExtentPoint32W.handler(
                                [dc, block, text.length, size]);
                            return new DataView(readMemory(size, 4).slice().buffer)
                                .getInt32(0, true);
                        }
                        finally
                        {
                            heap.free(block);
                            if (hdc === 0)
                            {
                                user.ReleaseDC.handler([0, dc]);
                            }
                        }
                    },
                    divergence: config?.divergence,
                }),

                'ADVPACK.dll': createAdvpackFunctions({
                    isAdministrator: ()=>isTokenMember(ADMINISTRATORS_SID),
                    hive,
                    folders,
                    /** @param {number} instance @param {any} type @param {any} name */
                    findResource: (instance, type, name)=>
                        modules.findResource?.(instance, type, name) ?? null,
                    moduleBase: instance=>modules.moduleBase?.(instance) ?? 0,
                    modulePath,
                    readMemory,
                    readCString,
                    readWideString,
                    divergence: config?.divergence,
                }),

                // The process status library: kernel32's K32 entries under
                // their original names.
                'PSAPI.DLL': {
                    EnumProcesses: { argBytes: 12, handler: (/** @type {number[]} */ args)=>
                        libraries['KERNEL32.dll'].K32EnumProcesses.handler(args) },
                    EmptyWorkingSet: { argBytes: 4, handler: (/** @type {number[]} */ args)=>
                        libraries['KERNEL32.dll'].K32EmptyWorkingSet.handler(args) },
                    GetProcessMemoryInfo: { argBytes: 12, handler: (/** @type {number[]} */ args)=>
                        libraries['KERNEL32.dll'].K32GetProcessMemoryInfo.handler(args) },
                    GetPerformanceInfo: { argBytes: 8, handler: (/** @type {number[]} */ args)=>
                        libraries['KERNEL32.dll'].K32GetPerformanceInfo.handler(args) },
                    ...Object.fromEntries(['EnumProcessModules', 'GetModuleFileNameExA',
                        'GetModuleFileNameExW', 'GetModuleBaseNameA', 'GetModuleBaseNameW',
                        'GetModuleInformation'].map(name=>[name, {
                        // Four arguments, each of them.
                        argBytes: 16,
                        handler: (/** @type {number[]} */ args)=>
                            libraries['KERNEL32.dll'][`K32${name}`].handler(args),
                    }])),
                },

                // The debug help library with no symbol files: what a crash
                // reporter walks the faulting stack with.
                'DBGHELP.dll': createDbghelpFunctions({
                    writeMemory, readMemory, files: volume, setRegisters,
                    readCString: (/** @type {number} */ address)=>readCString(address, 260),
                    modules: ()=>modules.list?.() ?? [],
                    setLastError: setError,
                }),

                'CRYPT32.dll': createCrypt32Functions({
                    readMemory, writeMemory, readWideString, setLastError: setError,
                    // LPTR: fixed and zeroed, as the caller's LocalFree expects.
                    localAlloc: bytes=>libraries['KERNEL32.dll'].LocalAlloc
                        .handler([0x40, bytes]) >>> 0,
                }),

                'POWRPROF.dll': createPowrprofFunctions({ writeMemory, setLastError: setError,
                    processors: processors.count(), mhz: config?.processorMhz ?? PROCESSOR.mhz }),
                'pdh.dll': createPdhFunctions({ writeMemory }),

                'SFC.dll': createSfcFunctions({ writeMemory, readCString, files: volume }),
                'HID.DLL': createHidFunctions({ writeMemory, setLastError: setError }),

                // The ODBC Driver Manager, with no driver and no data source set up.
                'ODBC32.dll': createOdbcFunctions({ writeMemory }),

                // XP's registry of OS components, which DirectX's setup
                // registers its exception package with.
                'SYSSETUP.dll': createSyssetupFunctions({ readMemory, writeMemory,
                    setLastError: setError }),

                // What MFC links of Active Accessibility, which nothing here asks for.
                'OLEACC.dll': createOleaccFunctions({ writeMemory,
                    divergence: config?.divergence }),

                // The device tree: its root alone, with no bus resources.
                'CFGMGR32.dll': createCfgmgrFunctions({ writeMemory, readCString }),

                // Video for Windows with no compressors and no MCI video device.
                'MSVFW32.dll': createMsvfwFunctions({ writeMemory }),

                // The AVIFile library with no file handlers registered.
                'AVIFIL32.dll': createAvifilFunctions({ writeMemory }),

                // DirectPlay with no service provider, and a lobby that did
                // not launch the program.
                'DPLAYX.dll': createDplayFunctions({ ...dplayHost, vtables: comVtables }),

                // The rich edit classes are always registered; these are the
                // libraries a program loads before it makes one.
                ...createRichedLibraries({ writeMemory }),

                // The old iostream library: its objects live in the program's
                // memory and its methods run over the C runtime's heap, locks
                // and descriptors, calling the program's own overrides through
                // their vtables.
                'MSVCIRT.dll': createIostreamFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    addressOf: name=>modules.find('msvcirt.dll')?.addressOf?.(name) ?? 0,
                    allocate: bytes=>libraries['msvcrt.dll'].malloc.handler([bytes]) >>> 0,
                    release: address=>void libraries['msvcrt.dll'].free.handler([address]),
                    locks: {
                        init: cs=>libraries['KERNEL32.dll'].InitializeCriticalSection.handler([cs]),
                        remove: cs=>libraries['KERNEL32.dll'].DeleteCriticalSection.handler([cs]),
                        enter: (cs, thread)=>bridge.callGuest({ thread, args: [cs],
                            entry: kernel32Export('EnterCriticalSection') }),
                        leave: (cs, thread)=>bridge.callGuest({ thread, args: [cs],
                            entry: kernel32Export('LeaveCriticalSection') }),
                    },
                    crt: {
                        open: (path, flags, prot)=>
                            libraries['msvcrt.dll']._open.handler([path, flags, prot]),
                        close: fd=>libraries['msvcrt.dll']._close.handler([fd]),
                        read: (fd, buffer, count)=>
                            libraries['msvcrt.dll']._read.handler([fd, buffer, count]),
                        write: (fd, buffer, count)=>
                            libraries['msvcrt.dll']._write.handler([fd, buffer, count]),
                        seek: (fd, offset, origin)=>
                            libraries['msvcrt.dll']._lseek.handler([fd, offset, origin]),
                        setmode: (fd, mode)=>libraries['msvcrt.dll']._setmode.handler([fd, mode]),
                    },
                    call: ({ entry, args, ecx, thread })=>
                        bridge.callGuest({ entry, args, thread, registers: { ecx } }),
                    callerThread: ()=>bridge.callerThread(),
                    format: (format, words)=>formatToString(format, words, ()=>''),
                }),

                // The DirectX setup library a game's autorun asks for the
                // installed runtime's version before it decides to install one.
                'DSETUP.dll': createDsetupFunctions({ writeMemory, directx: directx?.version,
                    divergence: config?.divergence, setLastError: setError,
                    brought: ()=>modules.broughtLibrary?.('DSETUP.dll') ?? null,
                    readFile: path=>modules.readFile?.(path) ?? Promise.resolve(null) }),

                // DirectX 8.1's DirectPlay NAT helper: a version check finds
                // DirectX 8.1 by this library being there beside d3d8.dll.
                'DPNHPAST.dll': createDpnhpastFunctions({ writeMemory,
                    divergence: config?.divergence }),

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

                // The File Decompression Interface a setup unpacks its own
                // cabinets with, over the program's callbacks.
                'CABINET.dll': createCabinetFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                    /** @param {number} address */
                    free: address=>heap.free(address),
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                    divergence: config?.divergence,
                }),

                // The Windows Installer: packages read where they lie and
                // installed from their own tables, in this process.
                'MSI.dll': createMsiFunctions({
                    readMemory,
                    writeMemory,
                    readCString,
                    readWideString,
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                    /** @param {number} address */
                    free: address=>heap.free(address),
                    files: volume,
                    /** @param {string} path */
                    fullPath: path=>filesystem.resolve(path).path,
                    hive,
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                    answering: (thread, fn)=>bridge.answering(thread, fn),
                    libraries: {
                        /** @param {number} name */
                        loadAnsi: name=>libraries['KERNEL32.dll'].LoadLibraryA.handler([name]),
                        /** @param {number} module @param {number} name */
                        procAddress: (module, name)=>
                            libraries['KERNEL32.dll'].GetProcAddress.handler([module, name]),
                        /** @param {number} module */
                        free: module=>libraries['KERNEL32.dll'].FreeLibrary.handler([module]),
                    },
                    // A library action that runs beside the installation is a
                    // thread of the process, as Windows Installer makes one.
                    threads: {
                        /** @param {number} entry @param {number} argument */
                        start: (entry, argument)=>
                            libraries['KERNEL32.dll'].CreateThread.handler(
                                [0, 0, entry, argument, 0, 0]) >>> 0,
                        /** @param {number} thread */
                        exitCode: thread=>{
                            const slot = heap.allocate(4);
                            libraries['KERNEL32.dll'].GetExitCodeThread.handler([thread, slot]);
                            const code = memory.readU32(slot);
                            heap.free(slot);
                            return code;
                        },
                        /** @param {number} thread */
                        terminate: thread=>
                            libraries['KERNEL32.dll'].TerminateThread.handler([thread, 0]),
                        /** @param {number} thread */
                        close: thread=>libraries['KERNEL32.dll'].CloseHandle.handler([thread]),
                    },
                    machine: ()=>({
                        windows,
                        computerName: COMPUTER_NAME,
                        userName: USER_NAME,
                        userSid: USER_SID_TEXT,
                        language: 0x0409,
                        screenWidth: config?.screen?.width ?? 1024,
                        screenHeight: config?.screen?.height ?? 768,
                        colorBits: config?.screen?.bitsPerPixel ?? 32,
                        memoryMegabytes: Math.floor(arena.size / (1024 * 1024)),
                        tempFolder: 'C:\\WINDOWS\\TEMP\\',
                        environment: (/** @type {string} */ name)=>{
                            const variables = startingEnvironment();
                            const key = Object.keys(variables)
                                .find(candidate=>candidate.toLowerCase() === name.toLowerCase());
                            return key === undefined ? null : variables[key];
                        },
                        now: ()=>new Date(kernel.clock.wallClock()),
                    }),
                    /** @param {string} path */
                    versionInfo: path=>modules.versionInfo?.(path) ?? null,
                    divergence: config?.divergence,
                    // The installer's own log, where a failed installation says why.
                    /** @param {string} text */
                    log: text=>config?.divergence?.('MSI', text),
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
                ...d3dxLibraries(createD3dxFunctions({ readMemory, writeMemory,
                    // A word read and written in place: an effect's commit reads
                    // a version word for every constant of its pass.
                    readU32: (/** @type {number} */ at)=>memory.readU32(at),
                    writeU32: (/** @type {number} */ at, /** @type {number} */ value)=>
                        memory.writeU32(at, value),
                    divergence: config?.divergence, vtables: comVtables, heap,
                    shaderCompiled: config?.shaderCompiled,
                    // The font engine GDI draws with, for D3DX's font.
                    fontMetrics: (/** @type {any} */ font)=>
                        config?.graphics?.fontMetrics?.(font) ?? null,
                    glyph: (/** @type {number} */ code, /** @type {any} */ font)=>
                        config?.graphics?.glyph?.(code, font) ?? null,
                    callGuest: call=>bridge.callGuest(call),
                    drive: steps=>bridge.drive(steps),
                    currentThread: ()=>kernel.currentThread(),
                    // The FromFile and FromResource functions read the same
                    // volume and modules the program does; SaveToFile writes it.
                    readFile: async path=>{
                        const entry = volume.stat(path);
                        const node = entry && !entry.isDirectory
                            ? volume.open(path, { read: true }) : null;
                        if (!entry || !node)
                        {
                            return null;
                        }
                        try
                        {
                            return await volume.read(node, 0, entry.size);
                        }
                        finally
                        {
                            volume.close(node);
                        }
                    },
                    writeFile: (path, bytes)=>{
                        const node = volume.open(path,
                            { read: false, write: true, create: true, truncate: true });
                        if (!node)
                        {
                            return false;
                        }
                        try
                        {
                            return volume.write(node, 0, bytes) === bytes.length;
                        }
                        finally
                        {
                            volume.close(node);
                        }
                    },
                    resource: (module, name, type)=>{
                        const entry = modules.findResource?.(module, type, name) ?? null;
                        const base = modules.moduleBase?.(module) ?? 0;
                        return entry ? readMemory(base + entry.rva, entry.size) : null;
                    } })),

                'WINSPOOL.DRV': createSpoolerFunctions({ setLastError: setError, readMemory,
                    writeMemory }),

                'MPR.dll': createNetworkFunctions({ setLastError: setError, writeMemory }),

                // Network adapters, modems and connectivity a game asks about
                // for its online modes: none of them on this machine.
                'NETAPI32.dll': createNetbiosFunctions({ readMemory, writeMemory }),
                'TAPI32.dll': createTelephonyFunctions({ readMemory, writeMemory }),
                'WTSAPI32.dll': createSessionNotificationFunctions(),
                'USERENV.dll': createUserenvFunctions({
                    block: ()=>libraries['KERNEL32.dll'].GetEnvironmentStringsW.handler([]),
                    free: block=>libraries['KERNEL32.dll'].FreeEnvironmentStringsW
                        .handler([block]),
                    writeMemory, setLastError: setError,
                }),
                'SensApi.dll': createSensFunctions({ readMemory, writeMemory,
                    setLastError: setError }),

                'UXTHEME.dll': createThemeFunctions({
                    setLastError: setError, readMemory, writeMemory,
                    // A null theme means the system's own value, which user32
                    // answers; read when called, as the tables are still being
                    // built here.
                    user32: name=>libraries['USER32.dll']?.[name],
                    gdi32: name=>libraries['GDI32.dll']?.[name],
                    allocate: bytes=>heap.allocate(bytes),
                    release: address=>heap.free(address),
                }),

                // The codec manager, with the drivers Windows installs: a sound
                // engine that keeps its effects ADPCM finds its decoder here.
                'MSACM32.dll': createAcmFunctions({
                    readMemory, writeMemory,
                    /** @param {number} entry @param {number[]} args @param {any} [thread] */
                    callGuest: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    currentThread: ()=>kernel.currentThread(),
                    divergence: config?.divergence,
                    codecs: ()=>acmCodecs,
                }),

                // The transport is the assembling caller's to supply and is absent
                // by default: this build has no network, and the entry points say
                // so rather than pretending a request failed for some other reason.
                // The library is published either way, because a program that
                // imports it and never uses it -- which is the common case -- must
                // still be able to load.
                'WININET.dll': createWininetFunctions({
                    readMemory, writeMemory, readCString, setLastError: setError,
                    request: config?.http ?? null,
                    // The guest's wall clock, which a cookie's expiry is read
                    // against: the host's would disagree with what the
                    // program's own GetSystemTime says.
                    now: ()=>kernel.clock.wallClock(),
                    divergence: config?.divergence,
                }),

                'USER32.dll': createWindowFunctions({
                    readMemory,
                    canWrite,
                    processId,
                    directory: windowDirectory,
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
                    // The desktop's background where no window is, when the
                    // embedder gave it a picture rather than its colour.
                    desktopPicture: config?.desktop?.picture ?? null,
                    // The desktop's clock: what a window left is painted on the
                    // guest's clock, whatever the program's threads are doing.
                    later: (/** @type {number} */ delay, /** @type {() => void} */ fire)=>{
                        desktopClock ??= kernel.createTimer({ name: 'desktop' });
                        return desktopClock !== null && kernel.armTimer(desktopClock,
                            kernel.clock.virtualTime() + delay, 0, ()=>fire()) === true;
                    },
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
                    answering: (thread, fn)=>bridge.answering(thread, fn),
                    divergence: config?.divergence,
                    /** @param {number} id */
                    threadExists: id=>kernel.threads().some(
                        (/** @type {{ id: number }} */ thread)=>(thread.id >>> 0) === id),
                    // The processes OpenProcess finds, for AllowSetForegroundWindow.
                    /** @param {number} id */
                    processExists: id=>(kernel.processes?.all() ?? []).some(
                        (/** @type {any} */ made)=>made.id === id),
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
                    // Where LoadImage reads a bitmap a program names by its file.
                    files: volume,
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
                        /** A context on the desktop's own background, under every window. */
                        background: ()=>gdi.windowContext(0, null, true),
                        /**
                         * @param {number} hdc
                         * @param {{ left: number, top: number, right: number,
                         *     bottom: number }} bounds
                         */
                        rebind: (hdc, bounds)=>gdi.rebindWindowContext(hdc, bounds),
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
                    /** @param {number} region */
                    deleteRegion: region=>void gdi.table.DeleteObject.handler([region]),
                    // A bitmap's size, for a caret drawn in it and an icon made from it.
                    /** @param {number} bitmap */
                    bitmapSize: bitmap=>gdi.bitmapSize(bitmap),
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
                        for (const definition of [
                            ...createCommonControls(controlHost, toolkit, imageLists, {
                                loadBitmap: (instance, id)=>libraries['USER32.dll']
                                    ?.LoadBitmapA?.handler([instance, id]) ?? 0,
                            }),
                            ...createRichEditControls(controlHost, toolkit)])
                        {
                            register(definition);
                        }
                    },
                    // A message box is a dialog on the program's own desktop;
                    // unattended, nobody is at it, and the box is put to
                    // whoever answers for the run instead.
                    /** @param {any} notice */
                    messageBox: notice=>(config?.unattended === true
                        ? answerUnattended({
                            kind: 'messagebox', title: notice.caption, text: notice.text,
                            buttons: notice.buttons.map((/** @type {any} */ button)=>
                                ({ ...button, default: button.id === notice.defaultButton })),
                        })
                        : null),
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
                        // Where RegSaveKey writes a hive and RegLoadKey reads one.
                        files: volume,
                        divergence: config?.divergence,
                        // The events a change notification signals: kernel32's own.
                        events: {
                            /** @param {number} handle */
                            set: handle=>libraries['KERNEL32.dll'].SetEvent.handler([handle]) !== 0,
                            /** @param {number} handle */
                            reset: handle=>
                                libraries['KERNEL32.dll'].ResetEvent.handler([handle]) !== 0,
                        },
                        // A SID has to live where a program can compare it byte by byte.
                        /** @param {number} bytes */
                        allocate: bytes=>heap.allocate(bytes),
                    }),
                    ...createEventLogFunctions({
                        readCString,
                        readWideString,
                        setLastError: setError,
                        handles,
                    }),
                    ...createTokenFunctions({
                        readMemory,
                        // Impersonation is the thread's, not the process's.
                        currentThread: ()=>kernel.currentThread(),
                        writeMemory,
                        readCString,
                        setLastError: setError,
                        handles,
                        allocate: bytes=>heap.allocate(bytes),
                    }),
                    ...createServiceFunctions({
                        readCString,
                        readMemory,
                        writeMemory,
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
                    // There is one user, so a child started as whichever user a
                    // token names is started as that one: CreateProcess, the token
                    // dropped from the front of the arguments.
                    CreateProcessAsUserA: {
                        argBytes: 44,
                        /** @param {number[]} args */
                        handler: ([, ...args])=>
                            libraries['KERNEL32.dll'].CreateProcessA.handler(args),
                    },
                    CreateProcessAsUserW: {
                        argBytes: 44,
                        /** @param {number[]} args */
                        handler: ([, ...args])=>
                            libraries['KERNEL32.dll'].CreateProcessW.handler(args),
                    },
                },

                'GDI32.dll': gdi.table,

                'ole32.dll': createOleFunctions({
                    readMemory,
                    writeMemory,
                    // Another library's export, as it is when called -- the
                    // clipboard, accelerators and the GDI deletions a medium's
                    // release makes are user32's, gdi32's and kernel32's. The
                    // table is still being built here.
                    /** @param {string} library @param {string} name @param {number[]} args @param {any} [thread] */
                    system: (library, name, args, thread)=>{
                        const entry = libraries[library]?.[name];
                        if (!entry)
                        {
                            return null;
                        }
                        return thread ? bridge.answering(thread, ()=>entry.handler(args))
                            : entry.handler(args);
                    },
                    fillMemory,
                    currentThread: ()=>kernel.currentThread(),
                    heap,
                    registry: com,
                    taskAllocator,
                    divergence: config?.divergence,
                    vtables: comVtables,
                    hive,
                    // A server's path written REG_EXPAND_SZ names %SystemRoot% and
                    // the like, expanded against the process's variables.
                    environment: startingEnvironment,
                    // A docfile is a file on the volume, and an object a program
                    // saves into one answers GetClassID and Save on its own side.
                    files: volume,
                    /** @param {number} entry @param {number[]} args @param {unknown} [thread] */
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    /** @param {number} entry @param {number[]} args @param {unknown} thread */
                    guardedCall: (entry, args, thread)=>callGuarded({
                        entry, args, thread, failed: 0x80010105,
                        report: (code, at)=>config?.divergence?.('COM',
                            `exception 0x${code} at 0x${at} in a method called by another`
                            + ' process, answered RPC_E_SERVERFAULT'),
                    }),
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
                    // The run's class objects served out of process, and the
                    // hidden window each apartment takes other processes'
                    // calls through, as ole32's own does.
                    com: comHost,
                    // What a thread waiting on a call into another apartment
                    // runs meanwhile: what other threads sent it, and its paints.
                    modalPump: (/** @type {unknown} */ thread)=>bridge.answering(thread,
                        ()=>windowService.modalPump?.(thread) ?? 0),
                    apartmentWindow: {
                        create: handler=>apartmentWindow(handler),
                        /** @param {number} window @param {number} message */
                        post: (window, message)=>
                            libraries['USER32.dll'].PostMessageA.handler([window, message, 0, 0]),
                    },
                    offerMarshaler: marshaler=>{
                        objrefMarshaler = marshaler;
                    },
                    // What a failed call between processes said of itself
                    // crosses back through oleaut32's error-information slot.
                    // The thread is named, not asked of the bridge: these run
                    // after an await, when the call on the processor is
                    // another thread's.
                    errors: {
                        take: (/** @type {unknown} */ thread)=>{
                            const taken = errorSlots.get(thread) ?? 0;
                            errorSlots.delete(thread);
                            return taken;
                        },
                        set: (/** @type {number} */ pointer, /** @type {unknown} */ thread)=>
                            errorSlots.set(thread, pointer >>> 0),
                        create: out=>libraries['OLEAUT32.dll'].CreateErrorInfo.handler([out]),
                    },
                    // A user-marshal routine that cannot carry what it is handed
                    // raises the way the generated code it is called from expects.
                    raise: code=>raiseRpc(code),
                    raiseLater: (code, thread)=>raiseRpcLater(code, thread),
                    // A wait that serves the apartment while it waits: user32's
                    // and kernel32's own calls, read when made.
                    waits: {
                        messages: (thread, count, list, timeout, wakeMask, waitAll)=>
                            bridge.answering(thread, ()=>libraries['USER32.dll']
                                .MsgWaitForMultipleObjects.handler(
                                    [count, list, waitAll, timeout, wakeMask])),
                        objects: (thread, count, list, waitAll, timeout)=>
                            bridge.answering(thread, ()=>libraries['KERNEL32.dll']
                                .WaitForMultipleObjects.handler(
                                    [count, list, waitAll, timeout])),
                        peek: (thread, message)=>bridge.answering(thread, ()=>
                            libraries['USER32.dll'].PeekMessageW.handler([message, 0, 0, 0, 1])),
                        translate: (thread, message)=>bridge.answering(thread, ()=>
                            libraries['USER32.dll'].TranslateMessage.handler([message])),
                        dispatch: (thread, message)=>bridge.answering(thread, ()=>
                            libraries['USER32.dll'].DispatchMessageW.handler([message])),
                        postQuit: (thread, code)=>bridge.answering(thread, ()=>
                            libraries['USER32.dll'].PostQuitMessage.handler([code])),
                        tickCount: ()=>libraries['KERNEL32.dll'].GetTickCount.handler([]),
                        lastError: thread=>bridge.answering(thread, ()=>
                            libraries['KERNEL32.dll'].GetLastError.handler([])),
                    },
                    strings: {
                        allocate: bytes=>/** @type {number} */ (lent(bytes, at=>
                            libraries['OLEAUT32.dll'].SysAllocStringByteLen.handler(
                                [at, bytes.length]))),
                    },
                    createSafeArray: (vt, bounds)=>/** @type {number} */ (lent(
                        new Uint8Array(Uint32Array.from(bounds.flatMap(bound=>
                            [bound.elements, bound.lower >>> 0])).buffer),
                        at=>libraries['OLEAUT32.dll'].SafeArrayCreate.handler(
                            [vt, bounds.length, at]))),
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
                    writeMemory, readCString, readMemory,
                    readWideString: address=>readWideString(address, 1024),
                    divergence: config?.divergence,
                    /** @param {number} bytes */
                    allocate: bytes=>heap.allocate(bytes),
                    /** @param {number} address */
                    free: address=>{
                        heap.free(address);
                    },
                    // A MIDL proxy/stub DLL's runtime: its generated code is
                    // called and calls back, raises through the guest's own
                    // exception chain, registers in the hive every library
                    // writes, and sends interface pointers as ole32's OBJREFs.
                    runtime: {
                        call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                        callerThread: ()=>bridge.callerThread(),
                        register: (name, fn)=>bridge.register(name, { ...fn, lastError: false }),
                        raise: code=>raiseRpc(code),
                        raiseLater: (code, thread)=>raiseRpcLater(code, thread),
                        hive,
                        modulePath,
                        marshaler: ()=>objrefMarshaler,
                    },
                    // An interface of MIDL's generated stubs, served and
                    // called between processes through the run's table: the
                    // stub runs on the thread that listens, and a call that
                    // fails is raised on the thread that made it.
                    midl: {
                        call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                        guardedCall: (entry, args, thread)=>callGuarded({
                            entry, args, thread, failed: 0x80010105,
                            report: (code, at)=>config?.divergence?.('RPC',
                                `exception 0x${code} at 0x${at} in a stub called by another`
                                + ' process, answered RPC_S_CALL_FAILED'),
                        }),
                        callerThread: ()=>bridge.callerThread(),
                        raise: code=>raiseRpc(code),
                        raiseLater: (code, thread)=>raiseRpcLater(code, thread),
                        table: comHost.table,
                        process: comHost.process,
                    },
                }),

                'OLEAUT32.dll': createAutomationFunctions({
                    errorSlots,
                    readMemory,
                    writeMemory,
                    fillMemory,
                    heap,
                    // A date written without a year is in this one.
                    systemTimeMs: ()=>kernel.clock.wallClock(),
                    divergence: config?.divergence,
                    // A type library is a file a program loads and an object it
                    // registers, so automation reads the volume, publishes through
                    // the same vtables COM uses and writes the same hive.
                    files: volume,
                    vtables: comVtables,
                    hive,
                    /** @param {number} entry @param {number[]} args @param {unknown} [thread] */
                    call: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                }),
            };

            // shfolder.dll is a forwarder and nothing else: the two exports it
            // has are shell32's folder calls under another library's name, so a
            // program that linked against this small library gets the same answers
            // as one that linked against shell32 directly.
            libraries['USER32.dll'].MsgWaitForMultipleObjectsEx =
                apcs.user32.MsgWaitForMultipleObjectsEx;

            // ole32 answers the error-information calls oleaut32 does, the
            // same calls on the same per-thread state: either library's
            // SetErrorInfo is the other's GetErrorInfo.
            for (const name of ['CreateErrorInfo', 'GetErrorInfo', 'SetErrorInfo'])
            {
                libraries['ole32.dll'][name] = libraries['OLEAUT32.dll'][name];
            }
            // The active-object calls are oleaut32's exports, and ole32 has
            // none of them; they live with ole32's running object table,
            // which is what they register in.
            for (const name of ['RegisterActiveObject', 'RevokeActiveObject', 'GetActiveObject'])
            {
                libraries['OLEAUT32.dll'][name] = libraries['ole32.dll'][name];
                delete libraries['ole32.dll'][name];
            }

            // The programs the system folder holds and this engine provides,
            // each a routine of one library of its own (`programs/table.js`).
            libraries[PROGRAMS_LIBRARY] = createProgramFunctions({
                /** @param {string} library */
                exports: library=>libraries[library],
                callerThread: ()=>bridge.callerThread(),
                answering: (thread, fn)=>bridge.answering(thread, fn),
                callGuest: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                /** @param {number} bytes */
                allocate: bytes=>heap.allocate(bytes),
                /** @param {number} address */
                free: address=>heap.free(address),
                writeMemory,
                readWideString,
                readMemory,
            });

            libraries['SHFOLDER.dll'] = {
                SHGetFolderPathA: libraries['SHELL32.dll'].SHGetFolderPathA,
                SHGetFolderPathW: libraries['SHELL32.dll'].SHGetFolderPathW,
            };

            // msimg32.dll is gdi32's blending under another name, its exports
            // forwarded there as Windows forwards them: a program that linked
            // AlphaBlend from it draws with gdi32's GdiAlphaBlend.
            libraries['MSIMG32.dll'] = {
                AlphaBlend: libraries['GDI32.dll'].GdiAlphaBlend,
                GradientFill: libraries['GDI32.dll'].GdiGradientFill,
                TransparentBlt: libraries['GDI32.dll'].GdiTransparentBlt,
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
            // Visual C++ 2005's, likewise, with the names that runtime added.
            // imagehlp, the older library dbghelp grew out of: the same
            // functions under the names it had then.
            libraries['IMAGEHLP.dll'] = Object.fromEntries(Object.entries(libraries['DBGHELP.dll'])
                .filter(([name])=>IMAGEHLP_EXPORTS.has(name)));
            libraries['MSVCR80.dll'] = createMsvcr80Functions(libraries['msvcrt.dll'],
                { readMemory, writeMemory });
            // And its C++ library, over that runtime's operator new and delete.
            libraries['MSVCP80.dll'] = createMsvcp80Functions(libraries['MSVCR80.dll'],
                { readMemory, writeMemory, fillMemory });
            // Visual C++ 2003's: msvcrt's functions and the filter its DLLs
            // start under, and the C++ library's strings, laid out as 2005's.
            // The universal runtime of Visual C++ 2015 on, over 2005's: the same
            // functions, reached through the entries its headers call instead.
            libraries['ucrtbase.dll'] = createUcrtbaseFunctions(libraries['MSVCR80.dll'], {
                readMemory,
                writeMemory,
                callGuest: (entry, args, thread)=>bridge.callGuest({ entry, args, thread }),
                currentThread: ()=>kernel.currentThread(),
            });
            libraries['MSVCR71.dll'] = { ...libraries['msvcrt.dll'],
                __CppXcptFilter: libraries['msvcrt.dll']._XcptFilter };
            libraries['MSVCP71.dll'] = createMsvcp80Functions(libraries['MSVCR71.dll'],
                { readMemory, writeMemory, fillMemory });

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
                handleType: (/** @type {number} */ handle)=>kernel.handles.typeOf(handle),
                // The processes a Toolhelp snapshot lists: this one and the
                // children it started that are still running.
                processes: ()=>[
                    {
                        id: processId, parent: 0, path: modules.imagePath(),
                        threads: (kernel.threads?.() ?? [])
                            .filter((/** @type {any} */ thread)=>thread.state !== 'terminated')
                            .map((/** @type {any} */ thread)=>thread.id >>> 0),
                    },
                    ...(kernel.processes?.all() ?? [])
                        .filter((/** @type {any} */ child)=>!child.completed
                            && child.exitCode === kernel.processes.STILL_ACTIVE)
                        .map((/** @type {any} */ child)=>({
                            id: child.id >>> 0, parent: processId,
                            path: String(child.imagePath ?? ''), threads: [child.threadId >>> 0],
                        })),
                ],
                divergence: config?.divergence,
                advapi32: libraries['ADVAPI32.dll'],
                processors,
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
                 * The libraries answered from this table even where the
                 * program brought its own: DirectX's setup library, which a
                 * disc carries beside its redistributable and an installer
                 * loads from there -- the copy installs DirectX over the
                 * system's and asks for a restart, where this one answers
                 * that everything is in place; and the Visual C++ 2005
                 * runtime, whose calls the engine's own copy serves as guest
                 * code where a program's copy is one more runtime for the
                 * translator to carry. The C++ libraries are not among them
                 * until they export all a program's own copy does: a copy the
                 * program brought answers what this one does not have.
                 *
                 * @returns {string[]}
                 */
                runtimes: ()=>['DSETUP.dll', 'MSVCR80.dll'],

                /**
                 * The libraries with a table here that are not Windows' own but a
                 * redistributable a setup installs -- the D3DX helpers -- so a
                 * bottle may carry them where it carries no copy of Windows' own.
                 * A copy beside the program's executable is loaded in place of the
                 * table; one an installation put in system32 is not, as for every
                 * name with a table (`libraryCandidates`): two of one library in a
                 * process -- the installed D3DX compiling an effect the engine's is
                 * then asked to read -- is a format neither side shares.
                 *
                 * @returns {string[]}
                 */
                redistributables: ()=>Object.keys(d3dxLibraries({})),

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
                 * Tells an image as the loader does: each routine -- its TLS
                 * callbacks, then its entry point -- in turn on `thread`, once
                 * the call that asked has suspended, each inside a frame of the
                 * loader's that takes whatever it raises and ends that routine
                 * with 0.
                 *
                 * @param {{ routines: number[], base: number, reason: number,
                 *     reserved: number, thread: any }} image
                 * @returns {Promise<number>}
                 */
                callEntryPoint: image=>callEntryPoint(image),

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
                    'ODBC32.dll': ODBC32_ORDINALS,
                    'MSI.dll': MSI_ORDINALS,
                    // A program of the 9x era imports shlwapi's wide-character
                    // wrappers by number alone.
                    'SHLWAPI.dll': SHLWAPI_ORDINALS,
                    'SHELL32.dll': SHELL32_ORDINALS,
                    'DPLAYX.dll': DPLAYX_ORDINALS,
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

                /**
                 * Whether the registry came from a process before this one,
                 * filled already: what a save or an installation would put
                 * into a fresh hive is in it, and newer.
                 */
                registryInherited: ()=>inheritedHive !== null,

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
                 * Installs a driver in the Audio Compression Manager: a codec another
                 * layer implements, found by a program that enumerates the drivers as
                 * it finds Windows' own.
                 *
                 * @param {import('./msacm32/functions.js').AcmCodec} codec
                 */
                installAcmCodec: codec=>{
                    acmCodecs.push(codec);
                },

                /**
                 * The one allocator the whole process draws from.
                 *
                 * Handed out because a layer that puts bytes where a guest will
                 * read them -- a sound buffer it locks and writes through -- has to
                 * take them from the same free list as everything else, or two
                 * allocators hand out the same address.
                 */
                heap: ()=>heap,
                /**
                 * A block of the process heap, as HeapAlloc(GetProcessHeap())
                 * gives one: what a system library hands a program to free with
                 * HeapFree. Zero when there is no room.
                 *
                 * @param {number} bytes
                 */
                processHeapAllocate: bytes=>{
                    const kernel32 = libraries['KERNEL32.dll'];
                    return kernel32.HeapAlloc.handler(
                        [kernel32.GetProcessHeap.handler([]), 0, bytes >>> 0]) >>> 0;
                },
                /**
                 * Sets the calling thread's last error, as SetLastError does:
                 * for a layer outside win32 whose calls a program checks with
                 * GetLastError, as it does WGL's.
                 *
                 * @param {number} code
                 */
                setLastError: code=>setError(code),
                /** Views of files: how many were mapped, waited for their bytes, or failed. */
                mappings: ()=>mappings,
                /**
                 * The last files CreateFile and NtCreateFile would not open, each
                 * with the error and what was asked: a program that goes silent or
                 * blank where a file of its own failed to open says nothing else.
                 */
                refusedOpens: ()=>refusedOpens.map(({ path, error, access, share, disposition })=>
                    `${path}: error ${error}, access 0x${(access >>> 0).toString(16)}, share `
                    + `${share >>> 0}, disposition ${disposition >>> 0}`),

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
                /** The multimedia timers: each one's period and how far behind it is. */
                multimediaTimers: ()=>mmTimers.diagnostics(),
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
                /** The top-level window a window draws into, for its surface. @param {number} hwnd */
                windowSurfaceOf: hwnd=>windowService.surfaceOf?.(hwnd) ?? null,
                /** The top-level windows bottom to top, for the screen to be composed of. */
                windowSurfaces: ()=>windowService.surfaces?.() ?? [],
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
                 * Whether a child this process started runs beside it, the
                 * parent going on once the child is done: whenever the parent
                 * has not exited, as a process on Windows lives until it ends
                 * itself however it waits for its child -- blocked on the
                 * handle, polling its exit code between sleeps, or idle in its
                 * message loop. Only a parent that has exited is replaced, and
                 * one blocked on a wait for all of a set the child's exit alone
                 * cannot answer, which the child is marked for.
                 *
                 * @param {any} child  The child's process record.
                 */
                childWaitedOn: (/** @type {any} */ child)=>exitCode === null
                    && child?.handsOver !== true,

                /**
                 * Ends this process from outside, as TerminateProcess does: with
                 * the code, its threads stopped where they are, and no library
                 * told. The run sees the code at its next turn.
                 *
                 * @param {number} code
                 */
                terminate(code){
                    if (exitCode !== null)
                    {
                        return;
                    }
                    ending = true;
                    exitCode = code >>> 0;
                    processEnded();
                },

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
                    // A thread whose timed wait ran out has gone on, to
                    // whatever it waits on now.
                    const waiters = (child.waiters ?? []).filter(
                        (/** @type {any} */ waiter)=>waiter.live?.() ?? true);
                    child.waiters = [];
                    for (const { thread, result, settle } of waiters)
                    {
                        kernel.wake(thread, settle ? settle() : result);
                    }
                },

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

                /**
                 * Where a thread's start routine returns to, the main thread's
                 * included: its answer ends the thread as ExitThread would.
                 */
                threadReturn: ()=>threadReturnAddress(),

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
                    multimediaTimers: current ? current.multimediaTimers() : null,
                    criticalSections: current ? current.criticalSections() : null,
                    messages: current ? current.messages() : {},
                    // What is left of the one arena everything the guest is handed
                    // comes out of. A program sizes its own caches from this, so a
                    // layer that takes from it and never gives back does not merely
                    // leak -- it tells the program to stop keeping things.
                    heap: current ? current.heap().diagnostics() : null,
                    mappings: current ? current.mappings() : null,
                    refusedOpens: current ? current.refusedOpens() : [],
                    windows: current ? current.windows() : [],
                    windowProcedures: current ? current.windowProcedures() : [],
                    exitCode: current ? current.exitCode() : null,
                },
            };
        },

        async dispose(){
            leaveWindows();
            leaveWindows = ()=>{};
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const win32Module = createWin32Module();
