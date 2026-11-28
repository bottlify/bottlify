/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { encodeAnsi } from './locale.js';
import { FILE_OBJECT_KINDS, isStandardHandle, untagged } from './handle-tags.js';
import { TAKEN } from './named-objects.js';
import { askChild, childThread, threadEnd } from './cross-process.js';
import { MODIFY_STATE, SYNCHRONIZE, allows, duplicateAccess, grantedAccess } from './access.js';
import { STATUS, toDosError } from '../ntdll/status.js';
import { FILETIME_EPOCH_MS, dueInMs } from './due-time.js';
import { createSyncNatives } from './sync-natives.js';
import { createDirectoryNatives } from './object-directories.js';
import { overlappedLayout } from '../common/overlapped.js';
import { wholeAddress } from '../common/pointers.js';
import { readSecurityAttributes } from '../common/security-attributes.js';
import { EVENT_SLOTS, EVENT_WORD_SLOTS, MUTEX_SLOTS, SEMAPHORE_SLOTS, eventStateCode,
    releaseMutexCode, waitOneCode } from './wait-one.js';
import { COMPILED as SEMAPHORE_CODE } from './semaphore-guest.x86.js';
import { COMPILED as SEMAPHORE_LONG } from './semaphore-guest.x64.js';
import { HANDLE_STDERR, HANDLE_STDIN, HANDLE_STDOUT } from './console.js';

/**
 * The kernel32 surface a threaded program calls.
 *
 * These translate between the guest's vocabulary -- handles, milliseconds,
 * return codes -- and the kernel's objects. The scheduling itself is the
 * kernel's; nothing here decides who runs next.
 *
 * A call that has to wait cannot simply return: the guest thread must stop
 * where it is and the CPU must go elsewhere. So a blocking function reports
 * that it blocked, and the caller parks the thread -- the same mechanism that
 * ends a process, reused rather than reinvented.
 */

/**
 * What the export binding hands WaitForSingleObject's guest code (sync.js's
 * GuestBuilder, which this module cannot name: sync.js imports it).
 *
 * @typedef {{ register: (name: string, fn: { argBytes: number, handler: Function }) => number }}
 *     PollBuilder
 */

/** The console's own handles (`console.js`), which duplicate as themselves. */
const CONSOLE_HANDLES = new Set([HANDLE_STDIN, HANDLE_STDOUT, HANDLE_STDERR]);

/** Waits with this timeout never give up. */
const INFINITE = 0xffffffff;

/** What the guest gets back when a handle is not what it claims to be. */
const WAIT_FAILED = 0xffffffff;
/** The wait ran out of time; the object was never signalled. */
const WAIT_TIMEOUT = 0x102;
/** The object was signalled: the first of a set, or the one. */
const WAIT_OBJECT_0 = 0;

/** The pseudo-handle for the running process; -1 on every Windows. */
const CURRENT_PROCESS = 0xffffffff;
/** GetCurrentThread hands out this, and it is -2 on every Windows. */
const CURRENT_THREAD = 0xfffffffe;

/** Codes this surface reports. */
const ERROR_FILE_NOT_FOUND = 2;

/** A name is at most this long; longer is a pointer that is not a string. */
const MAX_NAME = 260;
/**
 * An object's name is read whole, as Windows reads it, up to what a name may
 * hold: two longer names that share their first 259 characters are two objects.
 */
const WHOLE_NAME = 32767;
const ERROR_FILENAME_EXCED_RANGE = 206;
/** What reading an ANSI name of MAX_PATH characters or more throws, to refuse the call. */
const TOO_LONG = Symbol('a name too long');
const ERROR_INVALID_HANDLE = 6;
const ERROR_ACCESS_DENIED = 5;
const ERROR_NOT_OWNER = 288;
const ERROR_INVALID_PARAMETER = 87;
/** ReleaseSemaphore past the semaphore's maximum. */
const ERROR_TOO_MANY_POSTS = 298;
const ERROR_NOT_ENOUGH_MEMORY = 8;

/** GetOverlappedResult on an operation still in progress, asked not to wait. */
const ERROR_IO_INCOMPLETE = 996;

/** OVERLAPPED: the operation's status, its byte count, and the event it signals. */

/**
 * How long SwitchToThread stands aside when only threads of lower priority are
 * ready, in guest milliseconds: without it the scheduler, which runs the
 * highest priority ready, would hand the caller its turn straight back.
 */
const SWITCH_ASIDE_MS = 1;

/** The Ex creators' flags. */
const CREATE_EVENT_MANUAL_RESET = 0x1;
const CREATE_EVENT_INITIAL_SET = 0x2;
const CREATE_MUTEX_INITIAL_OWNER = 0x1;

/** CreateThread's flag that makes dwStackSize the stack's reserve, not its commit. */
const STACK_SIZE_PARAM_IS_A_RESERVATION = 0x00010000;
/** CreateThread's flag for a thread that waits for ResumeThread before it first runs. */
const CREATE_SUSPENDED = 0x4;

/**
 * DuplicateHandle's options: close the source, give the copy the source's
 * rights, and its flags (NtDuplicateObject's, which kernel32 passes on).
 */
const DUPLICATE_CLOSE_SOURCE = 0x00000001;
const DUPLICATE_SAME_ACCESS = 0x00000002;
const DUPLICATE_SAME_ATTRIBUTES = 0x00000004;
/** NtSetInformationObject's and NtQueryObject's class of a handle's two flags. */
const OBJECT_HANDLE_FLAG_INFORMATION = 4;
/** HandleAttributes: the duplicate is inherited by a child. */
const OBJ_INHERIT = 0x02;
/** The status a refusal of the rights asked stands for (`duplicateAccess`). */
const STATUS_OF_RIGHTS = /** @type {Record<number, number>} */ ({
    5: STATUS.ACCESS_DENIED, 1314: STATUS.PRIVILEGE_NOT_HELD });

/**
 * @typedef {Object} ThreadingHost
 * @property {number} [pointerSize]  8 in a 64-bit process, whose OVERLAPPED is
 *     laid out wider (`overlappedLayout`); absent, 4.
 * @property {any} kernel                       The kernel layer's API.
 * @property {import('../common/guest.js').Guest} guest
 * @property {() => any} currentThread
 * @property {(thread?: any) => any} park       Stops a thread; returns the parked token.
 * @property {import('./cross-process.js').AskHost['askChild']} [askChild]
 *           A call made in a child, for a thread made or waited on there.
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 * @property {(thread: any, code: number) => Promise<number> | null} [endThread]
 *           Ends a thread that ended itself, and the process with it when it
 *           was the last: null once it has, or the promise of telling the
 *           libraries of its detach first. Absent, the kernel's exitThread alone.
 * @property {() => number} [threadStart]
 *           Where a new thread begins: the libraries told of it, then its start
 *           routine. Zero, or absent, and it begins in its start routine.
 * @property {() => boolean} [terminating]  Whether the process has begun to end,
 *           after which CreateThread makes no thread (ERROR_ACCESS_DENIED).
 * @property {(code: number) => void} setLastError
 * @property {(object: object, sd: number) => void} [recordObjectSecurity]
 *           Keeps the SECURITY_ATTRIBUTES' descriptor a freshly created sync
 *           object was given, so GetKernelObjectSecurity hands it back.
 * @property {ReturnType<typeof import('./named-objects.js').createNamedObjects>} namedObjects
 *           The one table every named sync object and file mapping shares --
 *           constructed once outside this process so a name a parent gave an
 *           object still finds it after a replacement rebuilds this layer.
 * @property {() => number} [threadReturn]
 * @property {(thread: any) => void} [threadBlock]
 *           Gives a thread just made its own environment block -- the thing FS
 *           points at, with its id, its stack bounds and its thread-local
 *           slots. Without one a thread reads all of those at linear address
 *           zero and up, which is nobody's.
 *           Where a start routine returns to. A thread that returns has ended,
 *           and if nothing notices it stays runnable for ever, is picked every
 *           turn, retires nothing, and keeps whatever it was holding.
 * @property {number} [processId]      What the running process is numbered.
 * @property {number} [parentProcessId]  The process that started it, 0 for none.
 * @property {() => import('../ntdll/query.js').SystemProcess[]} [processes]
 *           The run's processes as a snapshot lists them, this one first and
 *           its threads in the order they were made: the list
 *           SystemProcessInformation answers from. Without it, `listProcesses`
 *           of the kernel given.
 * @property {() => string} [imagePath]  Where its image is, for a snapshot's entry.
 * @property {() => { name: string, base: number, size?: number, path?: string }[]} [modules]
 *           The modules the process has loaded, the image first, for a snapshot's
 *           module list.
 * @property {(handle: number) => string | null} [handleType]
 * @property {(process: number) => ({ typeOf: (handle: number) => string | null,
 *     resolve: (handle: number) => any,
 *     open: (type: string, object: any, access?: number | null, flags?: number) => number,
 *     access?: (handle: number) => number | null,
 *     flags: (handle: number) => number | null,
 *     close: (handle: number) => number } | null)} [processTable]
 *     The handle table of another process of the run on this thread, by its
 *     id: where DuplicateHandle puts a duplicate for it, or takes one from it;
 *     its close is that process's NtClose.
 * @property {(handle: number) => number} close  NtClose of this process's handle,
 *     the one close every kind of handle goes through (`files.js`): its NTSTATUS.
 * @property {(node: any) => void} [retainNode]
 *           One more hold on an open file's node, given back when the handle
 *           that holds it is closed: what a duplicate of a file or mapping
 *           handle takes, so closing its source leaves the file open.
 * @property {(bytes: number) => number} [allocate]
 * @property {(bytes: number) => number} [allocateCode]
 *           Guest memory for the table of event words and for code: without
 *           them every wait is the host's.
 * @property {boolean} [handleWords]  false: no table of handle words, so every
 *           wait, mutex release and event set or reset is the host's -- the
 *           second path the guest's answers are gated against.
 * @property {(thread: any, routine: number, args: number[]) => void} [queueApc]
 *           Queues a routine to a thread, to run when it next waits alertably:
 *           what a waitable timer's completion routine becomes at each expiry.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call that does less than the real one says so.
 *           What kind of object a handle names. The kernel's handle table
 *           knows; it is not forwarded through the kernel API yet, and
 *           without it DuplicateHandle refuses rather than guessing.
 * @property {{ waitable?: (handle: number) => any }} [pipes]
 *           What a wait on a pipe handle waits for.
 */

/** PROCESSENTRY32, as a caller of the era declares it: 296 bytes. */
const PROCESSENTRY32 = Object.freeze({
    dwSize: 0,
    th32ProcessID: 8,
    cntThreads: 20,
    th32ParentProcessID: 24,
    pcPriClassBase: 28,
    szExeFile: 36,
    SIZE: 296,
});
/** THREADENTRY32: the size, a use count, the thread, its process and its priority. */
const THREADENTRY32 = Object.freeze({
    dwSize: 0,
    th32ThreadID: 8,
    th32OwnerProcessID: 12,
    tpBasePri: 16,
    SIZE: 28,
});
/**
 * MODULEENTRY32 and MODULEENTRY32W: eight DWORDs, then the module's name in
 * 256 characters and its path in 260, of a byte or of two.
 */
const MODULEENTRY32 = Object.freeze({
    th32ModuleID: 4,
    th32ProcessID: 8,
    GlblcntUsage: 12,
    ProccntUsage: 16,
    modBaseAddr: 20,
    modBaseSize: 24,
    hModule: 28,
    szModule: 32,
    NAME: 256,
});
const MAX_PATH = 260;
const TH32CS_SNAPPROCESS = 0x2;
const TH32CS_SNAPTHREAD = 0x4;
const TH32CS_SNAPHEAPLIST = 0x1;
const TH32CS_SNAPMODULE = 0x8;
const HANDLE_FLAG_INHERIT = 0x1;
const HANDLE_FLAG_PROTECT_FROM_CLOSE = 0x2;
const NORMAL_PRIORITY_BASE = 8;
const ERROR_NO_MORE_FILES = 18;
const ERROR_INSUFFICIENT_BUFFER = 122;
/** CreateWaitableTimerEx's flags. */
const CREATE_WAITABLE_TIMER_MANUAL_RESET = 0x1;
const CREATE_WAITABLE_TIMER_HIGH_RESOLUTION = 0x2;

/**
 * @typedef {{ id: number, parent: number, threads: number, path: string }} SnapshotProcess
 * @typedef {{ id: number, owner: number }} SnapshotThread
 * @typedef {{ base: number, size: number, path: string }} SnapshotModule
 */

/**
 * Whether a thread is still an object of its process: running, or ended and
 * held by a handle, as Windows keeps a thread's object - in its process's
 * list, to be opened by id - until its last reference goes.
 *
 * @param {any} kernel @param {any} thread
 */
const threadObjectLives = (kernel, thread)=>thread.state !== 'terminated'
    || kernel.handles.holds(thread);

/**
 * The run's processes as a snapshot lists them: this one, its threads in the
 * order they were made (ids are taken in that order; the scheduler's own list
 * is rotated as threads take turns) while each is an object
 * (`threadObjectLives`), then the children it started that are
 * still running, each with the first thread it was told of.
 *
 * @param {any} kernel
 * @param {{ id: number, parent: number, path: string }} self
 * @returns {import('../ntdll/query.js').SystemProcess[]}
 */
export function listProcesses(kernel, self){
    const own = kernel.processes.all();
    // This process's children, then every other process of the run its
    // directory holds: a grandchild is in a snapshot of the run as on Windows.
    const others = kernel.processes.run().filter((/** @type {any} */ record)=>
        (record.id >>> 0) !== (self.id >>> 0) && !own.includes(record));
    return [
        { ...self, threads: kernel.threads()
            .filter((/** @type {any} */ thread)=>threadObjectLives(kernel, thread))
            .map((/** @type {any} */ thread)=>thread.id >>> 0)
            .sort((/** @type {number} */ a, /** @type {number} */ b)=>a - b) },
        ...[...own, ...others]
            .filter((/** @type {any} */ child)=>!child.completed
                && child.exitCode === kernel.processes.STILL_ACTIVE)
            .map((/** @type {any} */ child)=>({
                id: child.id >>> 0, parent: own.includes(child) ? self.id : child.parentId >>> 0,
                path: String(child.imagePath ?? ''), threads: [child.threadId >>> 0],
            })),
    ];
}

/** @param {Uint8Array} bytes @param {number} at */
const readU32 = (bytes, at)=>
    (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against; every
 * one of these is stdcall, the bridge's default, so none of them says so.
 *
 * @param {ThreadingHost} host
 */
export function createThreadingFunctions(host){
    const { guest } = host;
    const overlappedFields = overlappedLayout(host.pointerSize);
    /**
     * @param {number} handle
     * @returns {{ flags: number, processes: SnapshotProcess[], threads: SnapshotThread[],
     *     modules: SnapshotModule[], process: number, thread: number, module: number } | null}
     */
    const snapshotOf = handle=>{
        try
        {
            return host.kernel.handles.resolve(handle >>> 0, 'snapshot');
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * One step of a snapshot's walk: the first entry, or the next, written
     * into the caller's PROCESSENTRY32 or THREADENTRY32. The wide process
     * entry is the same structure with the image name in UTF-16, which makes
     * it longer, and its dwSize is checked against that length.
     *
     * @param {number} handle @param {number} entry
     * @param {boolean} processes @param {boolean} first @param {boolean} [wide]
     */
    const walkSnapshot = (handle, entry, processes, first, wide = false)=>{
        const snapshot = snapshotOf(handle);
        if (!snapshot)
        {
            host.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        const layout = processes ? PROCESSENTRY32 : THREADENTRY32;
        const size = processes && wide
            ? PROCESSENTRY32.szExeFile + MAX_PATH * 2 : layout.SIZE;
        const list = processes ? snapshot.processes : snapshot.threads;
        const at = first ? 0 : (processes ? snapshot.process : snapshot.thread);
        if ((snapshot.flags & (processes ? TH32CS_SNAPPROCESS : TH32CS_SNAPTHREAD)) === 0
            || (entry >>> 0) === 0 || at >= list.length)
        {
            host.setLastError(ERROR_NO_MORE_FILES);
            return 0;
        }
        if (readU32(guest.snapshot(wholeAddress(entry), 4), 0) < size)
        {
            host.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, size, true);
        if (processes)
        {
            const process = snapshot.processes[at];
            view.setUint32(PROCESSENTRY32.th32ProcessID, process.id, true);
            view.setUint32(PROCESSENTRY32.cntThreads, process.threads, true);
            view.setUint32(PROCESSENTRY32.th32ParentProcessID, process.parent, true);
            view.setUint32(PROCESSENTRY32.pcPriClassBase, NORMAL_PRIORITY_BASE, true);
            const name = process.path.slice(process.path.lastIndexOf('\\') + 1)
                .slice(0, MAX_PATH - 1);
            if (wide)
            {
                for (let i = 0; i < name.length; i++)
                {
                    view.setUint16(PROCESSENTRY32.szExeFile + i * 2, name.charCodeAt(i), true);
                }
            }
            else
            {
                bytes.set(encodeAnsi(name), PROCESSENTRY32.szExeFile);
            }
            snapshot.process = at + 1;
        }
        else
        {
            const thread = snapshot.threads[at];
            view.setUint32(THREADENTRY32.th32ThreadID, thread.id, true);
            view.setUint32(THREADENTRY32.th32OwnerProcessID, thread.owner, true);
            view.setUint32(THREADENTRY32.tpBasePri, NORMAL_PRIORITY_BASE, true);
            snapshot.thread = at + 1;
        }
        guest.setBytes(wholeAddress(entry), bytes);
        return 1;
    };

    /**
     * One step of a walk of the snapshot's modules, written into the caller's
     * MODULEENTRY32 or MODULEENTRY32W. The module id is always one, as the
     * structure's documentation says it now is, and a module the process
     * loaded is counted as loaded for good, 0xFFFF, as Windows counts the
     * ones an image imports.
     *
     * @param {number} handle @param {number} entry
     * @param {boolean} wide @param {boolean} first
     */
    const walkModules = (handle, entry, wide, first)=>{
        const snapshot = snapshotOf(handle);
        if (!snapshot)
        {
            host.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        const at = first ? 0 : snapshot.module;
        if ((entry >>> 0) === 0 || at >= snapshot.modules.length)
        {
            host.setLastError(ERROR_NO_MORE_FILES);
            return 0;
        }
        const unit = wide ? 2 : 1;
        const size = MODULEENTRY32.szModule + (MODULEENTRY32.NAME + MAX_PATH) * unit;
        if (readU32(guest.snapshot(wholeAddress(entry), 4), 0) < size)
        {
            host.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
        const module = snapshot.modules[at];
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, size, true);
        view.setUint32(MODULEENTRY32.th32ModuleID, 1, true);
        view.setUint32(MODULEENTRY32.th32ProcessID, (host.processId ?? 0x1000) >>> 0, true);
        view.setUint32(MODULEENTRY32.GlblcntUsage, 0xffff, true);
        view.setUint32(MODULEENTRY32.ProccntUsage, 0xffff, true);
        view.setUint32(MODULEENTRY32.modBaseAddr, module.base, true);
        view.setUint32(MODULEENTRY32.modBaseSize, module.size, true);
        view.setUint32(MODULEENTRY32.hModule, module.base, true);
        /** @param {string} text @param {number} offset @param {number} room */
        const put = (text, offset, room)=>{
            const kept = text.slice(0, room - 1);
            if (!wide)
            {
                bytes.set(encodeAnsi(kept), offset);
                return;
            }
            for (let i = 0; i < kept.length; i++)
            {
                view.setUint16(offset + i * 2, kept.charCodeAt(i), true);
            }
        };
        put(module.path.slice(module.path.lastIndexOf('\\') + 1), MODULEENTRY32.szModule,
            MODULEENTRY32.NAME);
        put(module.path, MODULEENTRY32.szModule + MODULEENTRY32.NAME * unit, MAX_PATH);
        snapshot.module = at + 1;
        guest.setBytes(wholeAddress(entry), bytes);
        return 1;
    };

    /**
     * The heap walk of a snapshot, which this one does not hold: heaps are
     * not listed, so every walk ends at once, as one over a snapshot taken
     * without them does, and a snapshot that asked for them says so.
     *
     * @param {number} handle
     */
    const noHeaps = handle=>{
        const snapshot = snapshotOf(handle);
        if (snapshot && (snapshot.flags & TH32CS_SNAPHEAPLIST) !== 0)
        {
            host.divergence?.('Heap32ListFirst', 'a snapshot holds no heap list');
        }
        host.setLastError(snapshot ? ERROR_NO_MORE_FILES : ERROR_INVALID_HANDLE);
        return 0;
    };
    const { kernel } = host;

    /**
     * The running program, as the object the (HANDLE)-1 pseudo-handle names.
     *
     * It is a process object but not a child: a child takes this process's
     * place rather than running beside it, so a wait on it is a handover,
     * while a wait on this one is a wait on something that can only be
     * signalled when the waiter itself has stopped.
     */
    const currentProcess = {
        kind: 'process',
        current: true,
        /** @returns {string} */
        get imagePath(){
            return host.imagePath?.() ?? '';
        },
    };

    /**
     * The two pseudo-handles Windows accepts wherever a handle is taken:
     * (HANDLE)-1 is the current process, (HANDLE)-2 the current thread. They
     * are not entries in the handle table -- that is what makes them always
     * valid -- so a lookup has to map them before it misses.
     *
     * @param {number} handle
     * @returns {{ type: string, object: any } | null}
     */
    const pseudo = handle=>{
        if ((handle >>> 0) === CURRENT_THREAD)
        {
            return { type: 'thread', object: host.currentThread() };
        }
        if ((handle >>> 0) === CURRENT_PROCESS)
        {
            return { type: 'process', object: currentProcess };
        }
        return null;
    };

    /**
     * Resolves a handle to a kernel object, or null if the guest passed
     * something that is not one. A bad handle is a return code, not a crash:
     * programs do pass stale handles, and Windows answers with a failure.
     *
     * @param {number} handle
     * @param {string} [type]
     */
    const object = (handle, type)=>{
        const special = pseudo(handle);
        if (special)
        {
            return !type || type === special.type ? special.object : null;
        }
        try
        {
            return kernel.handles.resolve(untagged(handle), type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * A handle made inheritable, as SECURITY_ATTRIBUTES' bInheritHandle or an
     * open's bInheritHandle asks, in the kernel's table. Answers the handle.
     *
     * @param {number} handle @param {boolean} inherit
     */
    const inheritIf = (handle, inherit)=>{
        if (inherit && handle !== 0)
        {
            kernel.handles.setFlags(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        }
        return handle;
    };
    /** @param {number} attributes  SECURITY_ATTRIBUTES, or 0 */
    const securityOf = attributes=>readSecurityAttributes(guest,
        wholeAddress(attributes), host.pointerSize);
    /** @param {number} attributes  SECURITY_ATTRIBUTES, or 0 */
    const inherits = attributes=>securityOf(attributes)?.inherit ?? false;

    /** A handle's HANDLE_FLAG_* flags, null for a pseudo-handle or none. @param {number} handle */
    const flagsOf = handle=>(pseudo(handle) ? null : kernel.handles.flags(untagged(handle >>> 0)));
    /**
     * NtSetInformationObject's ObjectHandleFlagInformation, which
     * SetHandleInformation answers from: both flags as given. Its NTSTATUS.
     *
     * @param {number} handle @param {number} flags
     */
    const setFlags = (handle, flags)=>(flagsOf(handle) !== null && kernel.handles.setFlags(
        untagged(handle >>> 0), HANDLE_FLAG_INHERIT | HANDLE_FLAG_PROTECT_FROM_CLOSE, flags)
        ? STATUS.SUCCESS : STATUS.INVALID_HANDLE);

    /**
     * What kind of object a handle names, the pseudo-handles included.
     *
     * @param {number} handle
     * @returns {string | null}
     */
    const kindOf = handle=>{
        const special = pseudo(handle);
        if (special)
        {
            return special.type;
        }
        return host.handleType ? host.handleType(untagged(handle)) : null;
    };

    /**
     * Applies a wait's outcome. When the object was not available there is no
     * outcome yet, so the caller is parked and the token that says so is what
     * goes back -- the real result reaches the thread when it next runs.
     *
     * @param {number | null} result
     * @returns {number | any}
     */
    const settle = result=>result === null ? host.park() : result;

    /** @type {any} */
    let never = null;
    /** An event nothing ever sets, made the first time it is needed. */
    const neverSignalled = ()=>{
        never ??= kernel.createEvent({ manualReset: true, signalled: false,
            name: 'GetOverlappedResult' });
        return never;
    };

    /**
     * One entry point, in both spellings. A name is the only thing that ever
     * differs between an ANSI create/open and its wide sibling, so the body
     * takes which form to read it in rather than being written twice.
     *
     * @param {number} argBytes
     * @param {(args: number[], wide: boolean) => number} body
     */
    const bothNamedForms = (argBytes, body)=>{
        /** @param {number[]} args @param {boolean} wide */
        const call = (args, wide)=>{
            try
            {
                return body(args, wide);
            }
            catch (e){
                if (e !== TOO_LONG)
                {
                    throw e;
                }
                host.setLastError(ERROR_FILENAME_EXCED_RANGE);
                return 0;
            }
        };
        return {
            ansi: { argBytes, handler: (/** @type {number[]} */ args)=>call(args, false) },
            wide: { argBytes, handler: (/** @type {number[]} */ args)=>call(args, true) },
        };
    };

    /**
     * @param {number} pointer @param {boolean} [wide] @returns {string | null}
     */
    const nameOf = (pointer, wide)=>{
        if ((pointer >>> 0) === 0)
        {
            return null;
        }
        const name = wide ? guest.wstr(wholeAddress(pointer), WHOLE_NAME * 2)
            : guest.cstr(wholeAddress(pointer), WHOLE_NAME);
        // The ANSI forms take a name shorter than MAX_PATH, as Windows' do.
        if (!wide && name.length >= MAX_NAME)
        {
            throw TOO_LONG;
        }
        return name || null;
    };

    // The table itself is shared with the file-mapping surface and lives
    // outside this call -- see named-objects.js for why one namespace covers
    // every kind. This closure only needs its two operations.
    const { existing } = host.namedObjects;
    /** @param {string | null} name @param {string} kind @param {any} made @param {boolean} reused */
    const remember = (name, kind, made, reused)=>
        host.namedObjects.remember(name, kind, made, reused, host.setLastError);

    /**
     * What an Open* call reports for a name: no name at all is a bad
     * parameter, nothing by that name is "no such thing", a different kind
     * holding it is a bad handle rather than a silent conversion between
     * kinds, and rights the kind does not have -- or none at all -- are
     * refused. The handle carries what it was granted.
     * @param {string} kind @param {string | null} name @param {number} desired
     */
    const namedOpen = (kind, name, desired)=>{
        if (name === null)
        {
            host.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const found = existing(name, kind);
        if (!found || found === TAKEN)
        {
            host.setLastError(found === TAKEN ? ERROR_INVALID_HANDLE : ERROR_FILE_NOT_FOUND);
            return 0;
        }
        const access = grantedAccess(kind, desired);
        if ('error' in access)
        {
            host.setLastError(access.error);
            return 0;
        }
        host.namedObjects.reference(found);
        return kernel.handles.open(kind, found, access.granted);
    };

    /**
     * Whether a handle may do what needs `right`, set as refused where not.
     *
     * @param {number} handle @param {number} right
     */
    const permitted = (handle, right)=>{
        if (allows(kernel.handles.access(untagged(handle >>> 0)), right))
        {
            return true;
        }
        host.setLastError(ERROR_ACCESS_DENIED);
        return false;
    };

    const openMutex = bothNamedForms(12, ([access, inherit, namePointer], wide)=>
        inheritIf(namedOpen('mutex', nameOf(namePointer, wide), access), inherit !== 0));

    /**
     * Unlike the mutex form this can succeed, and routinely does: one process
     * names an event in one library and opens it by name in another, which is
     * how two parts of the same program that do not know about each other
     * agree on a signal.
     */
    const openEvent = bothNamedForms(12, ([access, inherit, namePointer], wide)=>
        inheritIf(namedOpen('event', nameOf(namePointer, wide), access), inherit !== 0));

    const openSemaphore = bothNamedForms(12, ([access, inherit, namePointer], wide)=>
        inheritIf(namedOpen('semaphore', nameOf(namePointer, wide), access), inherit !== 0));

    const openWaitableTimer = bothNamedForms(12, ([access, inherit, namePointer], wide)=>
        inheritIf(namedOpen('timer', nameOf(namePointer, wide), access), inherit !== 0));

    /**
     * A fresh object's security descriptor, by its address, recorded so a
     * label set at creation is handed back; one found by its name keeps what
     * it was made with.
     *
     * @param {number} sd @param {object} made @param {any} found
     */
    const keepDescriptor = (sd, made, found)=>{
        if (found === null && sd !== 0)
        {
            host.recordObjectSecurity?.(made, sd);
        }
    };

    /**
     * The creates of the four kinds, each over a name already read: the Win32
     * forms read it from the caller's string, the native ones from an
     * OBJECT_ATTRIBUTES (`sync-natives.js`). Each answers the handle, or 0 with
     * the last error said; a name that held one already is opened again, as
     * Windows does, with ERROR_ALREADY_EXISTS.
     */
    const creates = {
        /** @param {string | null} name @param {boolean} owned @param {number} sd @param {boolean} inherit */
        mutex: (name, owned, sd, inherit)=>{
            const found = existing(name, 'mutex');
            if (found === TAKEN)
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const mutex = found ?? kernel.createMutex({ name: name ?? 'mutex' });
            if (owned && found === null)
            {
                kernel.wait(mutex, host.currentThread());
            }
            keepDescriptor(sd, mutex, found);
            remember(name, 'mutex', mutex, found !== null);
            const handle = inheritIf(kernel.handles.open('mutex', mutex), inherit);
            if (name === null)
            {
                mutex.name = `#${handle.toString(16)}`;
            }
            return handle;
        },
        /**
         * @param {string | null} name @param {boolean} manual @param {boolean} initial
         * @param {number} sd @param {boolean} inherit
         */
        event: (name, manual, initial, sd, inherit)=>{
            const found = existing(name, 'event');
            if (found === TAKEN)
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const event = found ?? kernel.createEvent({
                manualReset: manual,
                signalled: initial,
                name: name ?? 'event',
            });
            keepDescriptor(sd, event, found);
            remember(name, 'event', event, found !== null);
            const handle = inheritIf(kernel.handles.open('event', event), inherit);
            // An unnamed object is most of them, and "event" tells a reader
            // nothing when three threads are blocked on three of them. The
            // handle is what the trace shows at every other call, so it is
            // what ties a blocked thread to the code that made the object.
            if (name === null)
            {
                event.name = `#${handle.toString(16)}`;
            }
            return handle;
        },
        /**
         * The counts are signed and both are checked, because the failure they
         * guard against is silent: a maximum of zero or an initial count above
         * it makes every later wait behave in a way the caller cannot explain.
         * They are only checked on a fresh create -- the documented contract is
         * that they are ignored, like a mutex's initial owner, when the name
         * already names one.
         *
         * @param {string | null} name @param {number} initial @param {number} maximum
         * @param {number} sd @param {boolean} inherit
         */
        semaphore: (name, initial, maximum, sd, inherit)=>{
            const found = existing(name, 'semaphore');
            if (found === TAKEN)
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            if (found === null && (maximum <= 0 || initial < 0 || initial > maximum))
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const semaphore = found ?? kernel.createSemaphore({
                initial, maximum, name: name ?? 'semaphore',
            });
            keepDescriptor(sd, semaphore, found);
            remember(name, 'semaphore', semaphore, found !== null);
            const handle = inheritIf(kernel.handles.open('semaphore', semaphore), inherit);
            if (name === null)
            {
                semaphore.name = `#${handle.toString(16)}`;
            }
            return handle;
        },
        /**
         * A keyed event: always signalled to a wait on its handle, its pairings
         * of waiters and releasers by key kept beside it (`sync-natives.js`).
         *
         * @param {string | null} name @param {number} sd @param {boolean} inherit
         * @param {number | null} granted
         */
        keyedEvent: (name, sd, inherit, granted)=>{
            const found = existing(name, 'keyedevent');
            if (found === TAKEN)
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const keyed = found ?? Object.assign(kernel.createEvent({
                manualReset: true, signalled: true, name: name ?? 'keyed event',
            }), { keyed: { waiting: [], releasing: [] } });
            keepDescriptor(sd, keyed, found);
            remember(name, 'keyedevent', keyed, found !== null);
            const handle = inheritIf(kernel.handles.open('keyedevent', keyed, granted), inherit);
            if (name === null)
            {
                keyed.name = `#${handle.toString(16)}`;
            }
            return handle;
        },
        /** @param {string | null} name @param {boolean} manual @param {number} sd @param {boolean} inherit */
        timer: (name, manual, sd, inherit)=>{
            const found = existing(name, 'timer');
            if (found === TAKEN)
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const timer = found ?? kernel.createTimer({
                manualReset: manual,
                name: name ?? 'timer',
            });
            keepDescriptor(sd, timer, found);
            remember(name, 'timer', timer, found !== null);
            const handle = inheritIf(kernel.handles.open('timer', timer), inherit);
            if (name === null)
            {
                timer.name = `#${handle.toString(16)}`;
            }
            return handle;
        },
    };
    /**
     * A SECURITY_ATTRIBUTES' lpSecurityDescriptor, or 0: recorded as a fresh
     * object's security, so a label set at creation is handed back; an
     * object opened by an existing name keeps the security it was made with,
     * as Windows ignores the attributes on an open.
     *
     * @param {number} attributes  SECURITY_ATTRIBUTES, or 0
     */
    const descriptorOf = attributes=>securityOf(attributes)?.descriptor ?? 0;

    const createMutex = bothNamedForms(12, ([security, initialOwner, namePointer], wide)=>
        creates.mutex(nameOf(namePointer, wide), Boolean(initialOwner), descriptorOf(security),
            inherits(security)));

    const createEvent = bothNamedForms(16, ([security, manual, initial, namePointer], wide)=>
        creates.event(nameOf(namePointer, wide), Boolean(manual), Boolean(initial),
            descriptorOf(security), inherits(security)));

    const createSemaphore = bothNamedForms(16, ([security, initial, maximum, namePointer], wide)=>
        creates.semaphore(nameOf(namePointer, wide), initial | 0, maximum | 0,
            descriptorOf(security), inherits(security)));

    // The Ex forms: what the plain ones take as BOOLs arrives as flags, and an
    // access mask follows that nothing here checks, since every handle here
    // can do everything.
    const createEventEx = bothNamedForms(16, ([security, namePointer, flags], wide)=>
        (wide ? createEvent.wide : createEvent.ansi).handler([security,
            flags & CREATE_EVENT_MANUAL_RESET, flags & CREATE_EVENT_INITIAL_SET, namePointer]));
    const createMutexEx = bothNamedForms(16, ([security, namePointer, flags], wide)=>
        (wide ? createMutex.wide : createMutex.ansi).handler(
            [security, flags & CREATE_MUTEX_INITIAL_OWNER, namePointer]));
    const createSemaphoreEx = bothNamedForms(24, ([security, initial, maximum, namePointer], wide)=>
        (wide ? createSemaphore.wide : createSemaphore.ansi).handler(
            [security, initial, maximum, namePointer]));

    const createWaitableTimer = bothNamedForms(12, ([security, manualReset, namePointer], wide)=>
        creates.timer(nameOf(namePointer, wide), Boolean(manualReset), descriptorOf(security),
            inherits(security)));

    /**
     * The Ex form: the manual-reset BOOL arrives as a flag, beside the
     * high-resolution one, which asks for a timer the guest's clock already
     * keeps to the millisecond. Any other flag is refused.
     */
    const createWaitableTimerEx = bothNamedForms(16, ([security, namePointer, flags], wide)=>{
        if (((flags >>> 0) & ~(CREATE_WAITABLE_TIMER_MANUAL_RESET
            | CREATE_WAITABLE_TIMER_HIGH_RESOLUTION)) !== 0)
        {
            host.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        return (wide ? createWaitableTimer.wide : createWaitableTimer.ansi).handler(
            [security, flags & CREATE_WAITABLE_TIMER_MANUAL_RESET, namePointer]);
    });

    /**
     * The kernel's table of handle words and its mutexes' and events' own
     * words (`wait-one.js`), placed once, on the first bind of a routine that
     * reads them; null where there is no guest memory to place them in.
     *
     * @type {number | null | undefined}
     */
    let handleWords;
    /** What the kernel's words say, for the routines that read them. */
    const wordValues = ()=>({ clear: kernel.EventMirror.CLEAR, set: kernel.EventMirror.SET,
        invalid: kernel.EventMirror.INVALID, mutexTag: kernel.MUTEX_TAG,
        eventTag: kernel.EVENT_TAG });
    const placedTable = ()=>{
        if (handleWords !== undefined)
        {
            return handleWords;
        }
        if (host.handleWords === false || !host.allocate
            || typeof kernel.mirrorEvents !== 'function')
        {
            handleWords = null;
            return null;
        }
        const words = host.allocate(EVENT_SLOTS * 4);
        const mutexes = host.allocate(MUTEX_SLOTS * 4);
        const events = host.allocate(EVENT_WORD_SLOTS * 4);
        // A machine out of memory hands none out: the waits stay the host's,
        // as where the table is switched off.
        if (words === 0 || mutexes === 0 || events === 0)
        {
            handleWords = null;
            return null;
        }
        guest.setBytes(words, new Uint8Array(EVENT_SLOTS * 4));
        guest.setBytes(mutexes, new Uint8Array(MUTEX_SLOTS * 4));
        guest.setBytes(events, new Uint8Array(EVENT_WORD_SLOTS * 4));
        // The semaphores' two words each at the table's end (`wait-one.js`).
        const eventWords = EVENT_WORD_SLOTS - SEMAPHORE_SLOTS * 2;
        kernel.mirrorEvents(words, EVENT_SLOTS, mutexes, MUTEX_SLOTS, events, eventWords,
            events + eventWords * 4, SEMAPHORE_SLOTS);
        handleWords = words;
        return words;
    };

    /**
     * A compiled routine (`semaphore-guest.js`) as it runs at `at`: its
     * hand-over jumping to the trap, its HANDLE_WORDS the table.
     *
     * @param {{ code: Uint8Array, host: number, tables: { HANDLE_WORDS: number } }} compiled
     * @param {number} at @param {number} trap @param {number} words
     */
    const boundRoutine = (compiled, at, trap, words)=>{
        const bytes = compiled.code.slice();
        const view = new DataView(bytes.buffer);
        // A `jmp rel32`'s displacement, from the end of the instruction.
        view.setInt32(compiled.host, (trap - (at + compiled.host + 4)) | 0, true);
        view.setUint32(compiled.tables.HANDLE_WORDS, words >>> 0, true);
        return bytes;
    };
    /** Where the wait on a semaphore went, once placed. @type {number | undefined} */
    let semaphoreWait;
    /**
     * The wait on a semaphore, placed once: WaitForSingleObject's routine goes
     * there for a semaphore's word, and it hands over to the same trap.
     *
     * @param {number} trap @param {number} words
     */
    const placedSemaphoreWait = (trap, words)=>{
        if (semaphoreWait === undefined)
        {
            const allocate = host.allocateCode ?? host.allocate;
            if (!allocate)
            {
                return trap;
            }
            const at = allocate(SEMAPHORE_CODE.waitSemaphore.code.length);
            guest.setBytes(at, boundRoutine(SEMAPHORE_CODE.waitSemaphore, at, trap, words));
            semaphoreWait = at;
        }
        return semaphoreWait;
    };

    /** Where each routine reading the table went, once placed. @type {Map<string, number>} */
    const placedRoutines = new Map();
    /**
     * A routine reading the table, or the trap alone where there is no table.
     *
     * @param {PollBuilder} builder
     * @param {'WaitForSingleObject' | 'ReleaseMutex' | 'SetEvent' | 'ResetEvent'
     *     | 'ReleaseSemaphore'} name
     * @param {(at: number, trap: number, words: number) => Uint8Array} code
     */
    const placedRoutine = (builder, name, code)=>{
        const done = placedRoutines.get(name);
        if (done !== undefined)
        {
            return done;
        }
        const trap = builder.register(`KERNEL32.dll!${name}`, {
            argBytes: table[name].argBytes,
            /** @param {number[]} args */
            handler: args=>table[name].handler(args),
        });
        const words = placedTable();
        const allocate = host.allocateCode ?? host.allocate;
        let at = trap;
        if (words !== null && allocate)
        {
            at = allocate(code(0, trap, words).length);
            guest.setBytes(at, code(at, trap, words));
        }
        placedRoutines.set(name, at);
        return at;
    };

    /**
     * NtDuplicateObject, which DuplicateHandle answers from: a second handle
     * onto the same object, which is what a duplicate is -- not a copy of the
     * object. Closing either leaves the other usable, which is the property a
     * caller duplicates a handle to get.
     *
     * Either process may be another of the run's on this thread: a server
     * hands its client the handles of the events it signals by duplicating
     * them into the client, and the client uses the number it is sent. The
     * duplicate is then in that process's table, under a number of its own. A
     * process the run cannot reach (in a worker of its own) is taken for this
     * one.
     *
     * The copy carries the source's rights with DUPLICATE_SAME_ACCESS and what
     * was asked without it - nothing at all for 0 (`duplicateAccess`); the
     * source's flags with DUPLICATE_SAME_ATTRIBUTES, else inheritable as
     * OBJ_INHERIT asks. DUPLICATE_CLOSE_SOURCE closes the source as NtClose
     * does, so one protected from close stays, as on Windows; with no target
     * it only closes it.
     *
     * @param {number[]} args
     * @returns {number} the NTSTATUS
     */
    const duplicate = args=>{
        const [sourceProcess, source, targetProcess, target, desired, attributes, options] = args;
        const same = (options >>> 0 & DUPLICATE_SAME_ACCESS) !== 0;
        const closing = (options >>> 0 & DUPLICATE_CLOSE_SOURCE) !== 0;
        /** @param {number | null} sourceFlags  null for a pseudo-handle */
        const flagsFor = sourceFlags=>((options >>> 0 & DUPLICATE_SAME_ATTRIBUTES) !== 0
            ? sourceFlags ?? 0 : (attributes & OBJ_INHERIT) !== 0 ? HANDLE_FLAG_INHERIT : 0);
        /** @param {number} handle @param {number} made */
        const written = (handle, made)=>{
            guest.setBytes(wholeAddress(handle), new Uint8Array([made & 0xff, made >>> 8 & 0xff,
                made >>> 16 & 0xff, made >>> 24 & 0xff]));
            return STATUS.SUCCESS;
        };
        /** The table a process handle names, or null for this process's own. */
        const tableOf = (/** @type {number} */ process)=>{
            const record = (process >>> 0) === CURRENT_PROCESS ? null
                : object(process >>> 0, 'process');
            return record && !record.current && typeof record.id === 'number'
                ? host.processTable?.(record.id) ?? null : null;
        };
        const from = tableOf(sourceProcess);
        const into = tableOf(targetProcess);
        if (target === 0 && closing)
        {
            return from ? from.close(source >>> 0) : host.close(source >>> 0);
        }
        if (from)
        {
            const foreign = from.resolve(source >>> 0);
            const foreignKind = from.typeOf(source >>> 0);
            if (!foreign || foreignKind === null || target === 0)
            {
                return STATUS.INVALID_HANDLE;
            }
            const rights = duplicateAccess(foreignKind, desired,
                from.access?.(source >>> 0) ?? null, same);
            if ('error' in rights)
            {
                return STATUS_OF_RIGHTS[rights.error];
            }
            host.namedObjects.reference(foreign);
            const taken = (into ?? kernel.handles).open(foreignKind, foreign, rights.granted,
                flagsFor(from.flags(source >>> 0)));
            if (closing)
            {
                from.close(source >>> 0);
            }
            return written(target, taken);
        }
        // The console's own handles are the console wherever they are held: a
        // duplicate is the same handle, as Windows 7 hands a console handle (a
        // pseudo value) back.
        if (CONSOLE_HANDLES.has(source >>> 0) && target !== 0)
        {
            return written(target, source >>> 0);
        }
        const held = object(source >>> 0);
        const kind = kindOf(source >>> 0);
        if (!held || target === 0 || kind === null)
        {
            // Without the source handle's type there is nothing to reopen the
            // object under, and a duplicate filed under the wrong type fails
            // every later typed lookup -- a slower, stranger failure than
            // refusing here.
            return kind === null && held ? STATUS.NOT_SUPPORTED : STATUS.INVALID_HANDLE;
        }
        const rights = duplicateAccess(kind, desired,
            pseudo(source) ? null : kernel.handles.access(untagged(source >>> 0)), same);
        if ('error' in rights)
        {
            return STATUS_OF_RIGHTS[rights.error];
        }
        const flags = flagsFor(flagsOf(source));
        // Within the process, a duplicate that closes its source takes the
        // source's slot, the first free one, as Windows hands it: the entry
        // is the duplicate's from then on, with what it held. The table
        // refuses a source protected from close, and a pseudo-handle is none.
        const moved = closing && !into && !pseudo(source) && (()=>{
            try
            {
                kernel.handles.close(source >>> 0);
                return kernel.handles.adopt(source >>> 0, kind, held, rights.granted, flags);
            }
            catch {
                return false;
            }
        })();
        if (moved)
        {
            return written(target, source >>> 0);
        }
        // A no-op on anything unnamed, and on a named object this is the
        // reference a close will one day take back off -- a duplicate onto a
        // mutex is a real handle onto it, the same as the one it was given.
        host.namedObjects.reference(held);
        // Into another process, an open file is that process's own open of it,
        // which its table makes (`adoptFile`); here, one more hold. A pipe end
        // counts its handles in every process: it breaks with the last of them.
        if (held.node && (kind === 'mapping' || (kind === 'file' && !into)))
        {
            host.retainNode?.(held.node);
        }
        if (kind === 'pipe')
        {
            held.retain();
        }
        const made = (into ?? kernel.handles).open(kind, held, rights.granted, flags);
        // A file the other process could not open as its own.
        if (made === 0)
        {
            return STATUS.INVALID_HANDLE;
        }
        if (closing && !pseudo(source))
        {
            host.close(source >>> 0);
        }
        return written(target, made);
    };

    const table = {
        /** HANDLE CreateThread(LPSECURITY_ATTRIBUTES, SIZE_T, LPTHREAD_START_ROUTINE, LPVOID, DWORD, LPDWORD) */
        CreateThread: {
            argBytes: 24,
            sizes: [1],
            addresses: [2, 3],
            /** @param {number[]} args */
            handler: ([, stackSize, start, parameter, flags, threadIdOut])=>{
                // A process that has begun to end takes no new thread, as
                // Windows refuses one from NtTerminateProcess on.
                if (host.terminating?.())
                {
                    host.setLastError(ERROR_ACCESS_DENIED);
                    return 0;
                }
                // The size is the stack's commit unless the caller says it is
                // the reserve; the kernel turns either into the reserve by the
                // rules CreateThread documents.
                const reservation = ((flags >>> 0) & STACK_SIZE_PARAM_IS_A_RESERVATION) !== 0;
                // Every library is told of the thread on the thread, before
                // its start routine runs.
                const begin = host.threadStart?.() ?? 0;
                const thread = kernel.createThread({
                    entry: begin || wholeAddress(start),
                    ...begin === 0 ? {} : { start: wholeAddress(start) },
                    ...reservation
                        ? { stackReserve: stackSize >>> 0 }
                        : { stackSize: stackSize >>> 0 },
                    parameter: wholeAddress(parameter),
                    // Returning from the start routine is how most threads end,
                    // and it means exactly what calling ExitThread with the
                    // same value means. Somewhere has to notice; this is where
                    // it returns to.
                    returnTo: host.threadReturn?.(),
                });
                if (!thread)
                {
                    host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                    return 0;
                }
                host.threadBlock?.(thread);
                if (((flags >>> 0) & CREATE_SUSPENDED) !== 0)
                {
                    kernel.suspendThread(thread);
                }
                if (threadIdOut !== 0)
                {
                    kernel.writeThreadId(threadIdOut, thread.id);
                }
                // Deliberately no switch: the creator has not necessarily
                // finished setting up what the new thread is about to read.
                return thread.handle;
            },
        },

        /**
         * BOOL SwitchToThread(void)
         *
         * Gives the rest of the caller's turn to another thread ready to run
         * and answers whether there was one: zero, at once, when there was
         * not. Unlike Sleep(0) it yields to a thread of lower priority too, so
         * with only such threads ready the caller sits out a moment of guest
         * time; with one of its own priority or higher ready, going behind it
         * is enough.
         */
        SwitchToThread: {
            argBytes: 0,
            handler: ()=>{
                const self = host.currentThread();
                const ready = kernel.threads().filter((/** @type {any} */ thread)=>
                    thread !== self && thread.state === 'ready' && !thread.awaitingHost);
                if (ready.length === 0)
                {
                    return 0;
                }
                const mine = self?.priority ?? 0;
                const lowerOnly = ready.every((/** @type {any} */ thread)=>
                    (thread.priority ?? 0) < mine);
                kernel.block(self, 'SwitchToThread', {
                    deadline: kernel.clock.virtualTime() + (lowerOnly ? SWITCH_ASIDE_MS : 0),
                    result: 1,
                });
                return host.park();
            },
        },

        /**
         * BOOL GetOverlappedResult(HANDLE hFile, LPOVERLAPPED lpOverlapped,
         *     LPDWORD lpNumberOfBytesTransferred, BOOL bWait)
         *
         * Reads the operation's outcome where the I/O left it, in the
         * OVERLAPPED: InternalHigh is the byte count, and Internal the status,
         * an error status answering FALSE with its Win32 error. One still
         * pending is ERROR_IO_INCOMPLETE without bWait, the count left
         * unwritten; with it, the call waits for the OVERLAPPED's event (its
         * low bit is a flag, not part of the handle), or the file's handle
         * when there is none, and then answers TRUE with the count even if
         * Internal still says pending (Wine's kernel32 file tests,
         * test_overlapped); a wait that parks reads the count and the
         * status as it ends.
         */
        GetOverlappedResult: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([file, overlapped, transferred, wait])=>{
                /** @param {number} offset */
                const field = offset=>{
                    const bytes = guest.snapshot((overlapped + offset) >>> 0, 4);
                    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
                };
                const count = ()=>{
                    const bytes = new Uint8Array(4);
                    new DataView(bytes.buffer).setUint32(0, field(overlappedFields.internalHigh),
                        true);
                    guest.setBytes(wholeAddress(transferred), bytes);
                };
                let status = field(overlappedFields.internal);
                if (status === STATUS.PENDING)
                {
                    if (wait === 0)
                    {
                        host.setLastError(ERROR_IO_INCOMPLETE);
                        return 0;
                    }
                    const eventHandle = (field(overlappedFields.event) & ~1) >>> 0;
                    const target = object(eventHandle !== 0 ? eventHandle : file >>> 0);
                    if (!target)
                    {
                        host.setLastError(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    // A thread woken from a wait on a set resumes answering the
                    // index of the object that came. Putting the one awaited
                    // second, behind an event nothing signals, makes that
                    // answer TRUE -- the answer this call owes once it ends.
                    const answered = kernel.waitAny([neverSignalled(), target],
                        host.currentThread());
                    if (answered === null)
                    {
                        // The count and the answer are the ones the I/O
                        // leaves when the wait ends, not the ones there now:
                        // an operation that ended in an error (a message
                        // longer than the buffer, a cancel, a broken pipe)
                        // answers FALSE with its error.
                        const thread = host.currentThread();
                        kernel.whenResumed(thread, (/** @type {number | bigint} */ answer)=>{
                            count();
                            const ended = field(overlappedFields.internal);
                            if (ended === STATUS.SUCCESS || ended === STATUS.PENDING)
                            {
                                return answer;
                            }
                            host.setLastErrorFor?.(thread, toDosError(ended));
                            return 0;
                        });
                        return host.park();
                    }
                    status = field(overlappedFields.internal);
                    if (status === STATUS.PENDING)
                    {
                        count();
                        return 1;
                    }
                }
                count();
                if (status !== STATUS.SUCCESS)
                {
                    host.setLastError(toDosError(status));
                    return 0;
                }
                return 1;
            },
        },

        /**
         * DWORD WaitForSingleObject(HANDLE, DWORD dwMilliseconds)
         *
         * Guest code first: a signalled event the host does not keep is
         * taken there, a poll of an event that is not signalled times out
         * there, a free mutex or one the caller owns is taken there
         * (`wait-one.js`), and a count of a semaphore nobody waits on, or a
         * poll of one at zero (`semaphore-guest.js`); everything else comes here.
         */
        WaitForSingleObject: {
            argBytes: 8,
            /** @param {PollBuilder} builder */
            guest: builder=>placedRoutine(builder, 'WaitForSingleObject',
                (at, trap, words)=>waitOneCode(at, trap, words, wordValues(),
                    placedSemaphoreWait(trap, words))),
            /** @param {number[]} args */
            handler: ([handle, timeout])=>{
                // A standard stream is always ready to be written, and one
                // read here never has input to wait for: the call that reads
                // it answers at once.
                if (isStandardHandle(handle))
                {
                    return WAIT_OBJECT_0;
                }
                const target = object(handle >>> 0);
                if (!target)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return WAIT_FAILED;
                }
                // A handle opened without SYNCHRONIZE cannot be waited on.
                if (!permitted(handle, SYNCHRONIZE))
                {
                    return WAIT_FAILED;
                }
                const wait = wholeAddress(timeout);
                const thread = host.currentThread();

                if (kindOf(handle >>> 0) === 'process')
                {
                    // The running process is signalled only when it ends, and
                    // that cannot happen while the waiter is still running: a
                    // poll or a timeout answers WAIT_TIMEOUT, and an infinite
                    // wait parks until a moment that never comes. Asked before
                    // the kernel's records, which are children's and would
                    // read this one, which carries no exit code, as finished.
                    if (target.current)
                    {
                        if (wait === 0)
                        {
                            return WAIT_TIMEOUT;
                        }
                        kernel.block(thread, `the current process "${target.imagePath}"`,
                            wait === INFINITE ? undefined : {
                                deadline: kernel.clock.virtualTime() + wait,
                                result: WAIT_TIMEOUT,
                            });
                        return host.park(thread);
                    }
                    // A child's exit is an event of its own: set when it
                    // ends, set already for one the engine answered for -- a
                    // redistributable installer it stands in for -- and waited
                    // on as any other object is, timed or not.
                    if (wait === 0)
                    {
                        return kernel.poll(target.exited, thread) ?? WAIT_TIMEOUT;
                    }
                    return settle(kernel.wait(target.exited, thread, wait === INFINITE
                        ? undefined
                        : { deadline: kernel.clock.virtualTime() + wait, result: WAIT_TIMEOUT }));
                }

                // A child's thread ends where the child runs; the wait is on
                // the event this process sets once the child says it has.
                if (kindOf(handle >>> 0) === 'process-thread')
                {
                    const ended = threadEnd({ kernel, askChild: host.askChild }, target);
                    if (wait === 0)
                    {
                        return kernel.poll(ended, thread) ?? WAIT_TIMEOUT;
                    }
                    return settle(kernel.wait(ended, thread, wait === INFINITE
                        ? undefined
                        : { deadline: kernel.clock.virtualTime() + wait, result: WAIT_TIMEOUT }));
                }

                // A timer is ordinary here. Its signal is a property of the
                // object and the kernel's clock, not of this wait: the clock
                // sets it when the due time arrives whether this call came
                // before or after it was armed, so there is nothing left to
                // special-case.
                //
                // Zero is a poll, not a wait: it asks whether the object is
                // available now and never blocks or queues. A wait with a zero
                // deadline answered at once too, but left the thread queued on
                // the object, and a later signal woke it out of whatever it
                // was waiting on by then with an answer naming the wrong thing.
                if (FILE_OBJECT_KINDS.has(kindOf(handle >>> 0) ?? ''))
                {
                    return WAIT_OBJECT_0;
                }
                // A pipe end is waited on as a file object is: through the
                // event its pending operations hold down.
                if (kindOf(handle >>> 0) === 'pipe')
                {
                    const signal = host.pipes?.waitable?.(handle >>> 0) ?? null;
                    if (!signal)
                    {
                        host.setLastError(ERROR_INVALID_HANDLE);
                        return WAIT_FAILED;
                    }
                    if (wait === 0)
                    {
                        return kernel.poll(signal, thread) ?? WAIT_TIMEOUT;
                    }
                    return settle(kernel.wait(signal, thread, wait === INFINITE
                        ? undefined
                        : { deadline: kernel.clock.virtualTime() + wait, result: WAIT_TIMEOUT }));
                }
                // An object the kernel does not wait on itself - a job - is
                // waited on as the event it carries.
                const signal = target.waitable ?? target;
                if (wait === 0)
                {
                    return kernel.poll(signal, thread) ?? WAIT_TIMEOUT;
                }
                return settle(kernel.wait(signal, thread, wait === INFINITE
                    ? undefined
                    : { deadline: kernel.clock.virtualTime() + wait, result: WAIT_TIMEOUT }));
            },
        },

        /**
         * HANDLE CreateSemaphoreA/W(LPSECURITY_ATTRIBUTES, LONG lInitialCount,
         *                           LONG lMaximumCount, LPCSTR/LPCWSTR lpName)
         */
        CreateSemaphoreA: createSemaphore.ansi,
        CreateSemaphoreW: createSemaphore.wide,

        /**
         * HANDLE CreateSemaphoreExA/W(LPSECURITY_ATTRIBUTES, LONG lInitialCount,
         *     LONG lMaximumCount, LPCSTR/LPCWSTR lpName, DWORD dwFlags,
         *     DWORD dwDesiredAccess)
         */
        CreateSemaphoreExA: createSemaphoreEx.ansi,
        CreateSemaphoreExW: createSemaphoreEx.wide,

        /**
         * BOOL ReleaseSemaphore(HANDLE, LONG lReleaseCount, LPLONG lpPreviousCount)
         *
         * Releasing past the maximum fails and releases nothing -- it does not
         * clamp. A caller uses exactly that to detect its own double release,
         * and the previous count is written only on success, which is what makes
         * the check meaningful. Each refusal says why: no semaphore, a count
         * that is not positive, or ERROR_TOO_MANY_POSTS past the maximum.
         * Guest code first: a semaphore nobody waits on is released there
         * (`semaphore-guest.js`); everything else comes here.
         */
        ReleaseSemaphore: {
            argBytes: 12,
            /** @param {PollBuilder} builder */
            guest: builder=>placedRoutine(builder, 'ReleaseSemaphore',
                (at, trap, words)=>boundRoutine(host.pointerSize === 8
                    ? SEMAPHORE_LONG.ReleaseSemaphore : SEMAPHORE_CODE.ReleaseSemaphore,
                at, trap, words)),
            // Its x86-64 in a 64-bit process (`semaphore-guest.js` compiled for
            // it), placed the same way: the hand-over and the table where the
            // build left their places.
            guestLong: true,
            /** @param {number[]} args */
            handler: ([handle, count, previous])=>{
                const semaphore = object(handle >>> 0, 'semaphore');
                if (!semaphore)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                if (!permitted(handle, MODIFY_STATE))
                {
                    return 0;
                }
                if ((count | 0) <= 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                try
                {
                    const before = kernel.releaseSemaphore(semaphore, count | 0);
                    if (previous !== 0)
                    {
                        guest.setBytes(wholeAddress(previous), new Uint8Array([
                            before & 0xff, before >>> 8 & 0xff,
                            before >>> 16 & 0xff, before >>> 24 & 0xff,
                        ]));
                    }
                    return 1;
                }
                catch (e){
                    void e;
                    host.setLastError(ERROR_TOO_MANY_POSTS);
                    return 0;
                }
            },
        },

        /**
         * HANDLE OpenMutexA/W(DWORD dwDesiredAccess, BOOL bInheritHandle, LPCSTR lpName)
         *
         * Finds a mutex a create in this same process already named; a name
         * nothing here made is "no such thing" -- not an error a caller cannot
         * tell apart from a failure to open one that exists.
         */
        OpenMutexA: openMutex.ansi,
        OpenMutexW: openMutex.wide,

        /**
         * HANDLE OpenEventA/W(DWORD dwDesiredAccess, BOOL bInheritHandle, LPCSTR lpName)
         *
         * Routinely succeeds: one process names an event in one library and
         * opens it by name in another, which is how two parts of the same
         * program that do not know about each other agree on a signal.
         */
        OpenEventA: openEvent.ansi,
        OpenEventW: openEvent.wide,

        /** HANDLE OpenSemaphoreA/W(DWORD dwDesiredAccess, BOOL bInheritHandle, LPCSTR lpName) */
        OpenSemaphoreA: openSemaphore.ansi,
        OpenSemaphoreW: openSemaphore.wide,

        /** HANDLE OpenWaitableTimerA/W(DWORD dwDesiredAccess, BOOL bInheritHandle, LPCSTR lpTimerName) */
        OpenWaitableTimerA: openWaitableTimer.ansi,
        OpenWaitableTimerW: openWaitableTimer.wide,

        /**
         * BOOL CompareObjectHandles(HANDLE hFirstObjectHandle, HANDLE hSecondObjectHandle)
         *
         * Whether two handles name one kernel object; a handle that names
         * none is not the same as anything.
         */
        CompareObjectHandles: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                const one = object(first >>> 0);
                return one && one === object(second >>> 0) ? 1 : 0;
            },
        },

        /**
         * BOOL DuplicateHandle(HANDLE hSourceProcessHandle, HANDLE hSourceHandle,
         *   HANDLE hTargetProcessHandle, LPHANDLE lpTargetHandle,
         *   DWORD dwDesiredAccess, BOOL bInheritHandle, DWORD dwOptions)
         *
         * NtDuplicateObject's answer as a Win32 one, bInheritHandle its
         * OBJ_INHERIT.
         */
        DuplicateHandle: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([sourceProcess, source, targetProcess, target, desired, inherit, options])=>{
                const status = duplicate([sourceProcess, source, targetProcess, target, desired,
                    inherit !== 0 ? OBJ_INHERIT : 0, options]);
                if (status !== STATUS.SUCCESS)
                {
                    host.setLastError(toDosError(status));
                    return 0;
                }
                return 1;
            },
            natives: {
                /**
                 * NTSTATUS NtDuplicateObject(HANDLE SourceProcess, HANDLE SourceHandle,
                 *   HANDLE TargetProcess, PHANDLE TargetHandle, ACCESS_MASK DesiredAccess,
                 *   ULONG HandleAttributes, ULONG Options)
                 */
                NtDuplicateObject: { argBytes: 28, handler: duplicate },
            },
        },

        /**
         * BOOL GetHandleInformation(HANDLE hObject, LPDWORD lpdwFlags) and
         * BOOL SetHandleInformation(HANDLE hObject, DWORD dwMask, DWORD dwFlags):
         * a handle's inheritance and protection flags, the handle's own in the
         * kernel's table: a child started with bInheritHandles takes the
         * inheritable ones, CloseHandle refuses a protected one. A socket is
         * a handle there too, as on Windows, where a program keeps its
         * sockets from children by clearing their inherit flag.
         */
        GetHandleInformation: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const flags = flagsOf(handle);
                if (flags === null || wholeAddress(out) === 0)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                guest.setBytes(wholeAddress(out), new Uint8Array([flags, 0, 0, 0]));
                return 1;
            },
        },
        SetHandleInformation: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, mask, flags])=>{
                const now = flagsOf(handle);
                const status = now === null ? STATUS.INVALID_HANDLE
                    : setFlags(handle, (now & ~mask) | (flags & mask));
                if (status !== STATUS.SUCCESS)
                {
                    host.setLastError(toDosError(status));
                    return 0;
                }
                return 1;
            },
            natives: {
                /**
                 * NTSTATUS NtSetInformationObject(HANDLE, OBJECT_INFORMATION_CLASS,
                 *   PVOID Information, ULONG Length): ObjectHandleFlagInformation,
                 *   OBJECT_HANDLE_FLAG_INFORMATION's two BOOLEANs, Inherit and
                 *   ProtectFromClose. Another class is refused, and said.
                 */
                NtSetInformationObject: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([handle, infoClass, information, length])=>{
                        if ((infoClass >>> 0) !== OBJECT_HANDLE_FLAG_INFORMATION)
                        {
                            host.divergence?.('NtSetInformationObject',
                                `information class ${infoClass >>> 0} is refused`);
                            return STATUS.INVALID_INFO_CLASS;
                        }
                        if ((length >>> 0) < 2)
                        {
                            return STATUS.INFO_LENGTH_MISMATCH;
                        }
                        const [inheritable, protect] =
                            guest.snapshot(wholeAddress(information), 2);
                        return setFlags(handle, (inheritable ? HANDLE_FLAG_INHERIT : 0)
                            | (protect ? HANDLE_FLAG_PROTECT_FROM_CLOSE : 0));
                    },
                },
            },
        },

        /** HANDLE CreateMutexA/W(LPSECURITY_ATTRIBUTES, BOOL bInitialOwner, LPCSTR/LPCWSTR) */
        CreateMutexA: createMutex.ansi,
        CreateMutexW: createMutex.wide,

        /** HANDLE CreateMutexExA/W(LPSECURITY_ATTRIBUTES, LPCSTR/LPCWSTR, DWORD dwFlags, DWORD) */
        CreateMutexExA: createMutexEx.ansi,
        CreateMutexExW: createMutexEx.wide,

        /**
         * BOOL ReleaseMutex(HANDLE)
         *
         * Guest code first: a mutex the caller owns, which the host does not
         * keep, is given back there (`wait-one.js`); everything else comes here.
         */
        ReleaseMutex: {
            argBytes: 4,
            /** @param {PollBuilder} builder */
            guest: builder=>placedRoutine(builder, 'ReleaseMutex',
                (at, trap, words)=>releaseMutexCode(at, trap, words, wordValues())),
            /** @param {number[]} args */
            handler: ([handle])=>{
                const mutex = object(handle >>> 0, 'mutex');
                if (!mutex)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                if (!kernel.releaseMutex(mutex, host.currentThread()))
                {
                    // Wine's kernel32 sync.c test_mutex: a mutex the caller
                    // does not own, as Windows says.
                    host.setLastError(ERROR_NOT_OWNER);
                    return 0;
                }
                return 1;
            },
        },

        /**
         * HANDLE CreateEventA/W(LPSECURITY_ATTRIBUTES, BOOL bManualReset,
         *                       BOOL bInitialState, LPCSTR/LPCWSTR)
         */
        CreateEventA: createEvent.ansi,
        CreateEventW: createEvent.wide,

        /** HANDLE CreateEventExA/W(LPSECURITY_ATTRIBUTES, LPCSTR/LPCWSTR, DWORD dwFlags, DWORD) */
        CreateEventExA: createEventEx.ansi,
        CreateEventExW: createEventEx.wide,

        /**
         * BOOL SetEvent(HANDLE)
         *
         * Guest code first: an event nobody is queued on is signalled there,
         * and one signalled already is left so (`wait-one.js`); everything
         * else comes here.
         */
        SetEvent: {
            argBytes: 4,
            /** @param {PollBuilder} builder */
            guest: builder=>placedRoutine(builder, 'SetEvent',
                (at, trap, words)=>eventStateCode(at, trap, words, wordValues(), true)),
            /** @param {number[]} args */
            handler: ([handle])=>{
                const event = object(handle >>> 0, 'event');
                if (!event || !permitted(handle, MODIFY_STATE))
                {
                    return 0;
                }
                kernel.setEvent(event);
                return 1;
            },
        },

        /**
         * BOOL PulseEvent(HANDLE)
         *
         * Signalled and reset in one step: the waiters it can release go --
         * every one of them for a manual-reset event, one for an auto-reset
         * one -- and the event is left unsignalled whether anyone was waiting
         * or not.
         */
        PulseEvent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const event = object(handle >>> 0, 'event');
                if (!event || !permitted(handle, MODIFY_STATE))
                {
                    return 0;
                }
                kernel.setEvent(event);
                kernel.resetEvent(event);
                return 1;
            },
        },

        /**
         * BOOL ResetEvent(HANDLE)
         *
         * Guest code first: an event the host does not keep is cleared there,
         * and one not signalled is left so (`wait-one.js`); everything else
         * comes here.
         */
        ResetEvent: {
            argBytes: 4,
            /** @param {PollBuilder} builder */
            guest: builder=>placedRoutine(builder, 'ResetEvent',
                (at, trap, words)=>eventStateCode(at, trap, words, wordValues(), false)),
            /** @param {number[]} args */
            handler: ([handle])=>{
                const event = object(handle >>> 0, 'event');
                if (!event || !permitted(handle, MODIFY_STATE))
                {
                    return 0;
                }
                kernel.resetEvent(event);
                return 1;
            },
        },

        /**
         * The waitable timer, which a frame limiter arms and then waits on.
         *
         * A kernel object whose due time the scheduler's clock honours: when
         * the due time arrives the object is signalled, releasing whoever is
         * waiting on it -- all of them for a manual-reset timer, one for a
         * synchronisation timer, which is reset by the wait that takes it --
         * whether the wait began before or after the arm. A periodic timer
         * re-arms itself on the same clock with no thread present. Declared
         * for the stack it pops as much as for what it does: these are stdcall
         * and exported undecorated, so a stub popping nothing walks the
         * caller's stack off -- which for a limiter called every frame
         * exhausts the stack.
         *
         * The completion routine a caller passes is not modelled: there are no
         * APCs here, so it is ignored and never runs. A program that arms a
         * timer and waits on it, which is what a limiter does, is unaffected.
         *
         * HANDLE CreateWaitableTimerA/W(LPSECURITY_ATTRIBUTES, BOOL bManualReset, LPCSTR/LPCWSTR)
         * BOOL SetWaitableTimer(HANDLE, const LARGE_INTEGER* pDueTime, LONG lPeriod,
         *     PTIMERAPCROUTINE, LPVOID, BOOL fResume)
         * BOOL CancelWaitableTimer(HANDLE)
         */
        CreateWaitableTimerA: createWaitableTimer.ansi,
        CreateWaitableTimerW: createWaitableTimer.wide,
        /**
         * HANDLE CreateWaitableTimerExA/W(LPSECURITY_ATTRIBUTES, LPCSTR/LPCWSTR,
         *     DWORD dwFlags, DWORD dwDesiredAccess)
         */
        CreateWaitableTimerExA: createWaitableTimerEx.ansi,
        CreateWaitableTimerExW: createWaitableTimerEx.wide,

        SetWaitableTimer: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, dueTime, period, routine, argument])=>{
                const timer = object(handle >>> 0, 'timer');
                if (!timer || (dueTime >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const due = kernel.clock.virtualTime() + dueInMs(
                    guest.i64(wholeAddress(dueTime)), kernel.clock.wallClock());
                // A completion routine is queued to the thread that set the
                // timer, once per expiry, with the time it expired as a
                // FILETIME; it runs when that thread next waits alertably.
                const thread = host.currentThread();
                const fired = wholeAddress(routine) === 0 || !host.queueApc
                    ? null
                    : ()=>{
                        const filetime = BigInt(Math.floor(
                            kernel.clock.wallClock() + FILETIME_EPOCH_MS)) * 10000n;
                        host.queueApc?.(thread, wholeAddress(routine), [
                            wholeAddress(argument),
                            Number(filetime & 0xffffffffn),
                            Number(filetime >> 32n & 0xffffffffn),
                        ]);
                    };
                kernel.armTimer(timer, due, Math.max(0, period | 0), fired);
                return 1;
            },
        },

        CancelWaitableTimer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const timer = object(handle >>> 0, 'timer');
                if (!timer)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                kernel.cancelTimer(timer);
                return 1;
            },
        },

        /** VOID ExitThread(DWORD dwExitCode) — does not return */
        ExitThread: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                // Hold the thread before ending it: terminating clears the
                // kernel's notion of a current thread, and the parking that
                // follows still has to happen to the thread that called.
                const thread = host.currentThread();
                if (!host.endThread)
                {
                    kernel.exitThread(thread, code >>> 0);
                    return host.park(thread);
                }
                return host.endThread(thread, code >>> 0) ?? host.park(thread);
            },
        },

        /**
         * The Toolhelp snapshot, which a program walks to see whether another
         * copy of itself is running: this process and the children it started
         * that are still running, and their threads, as they stood when it was
         * taken. A walk ends with the error the end of a real walk carries.
         *
         * HANDLE CreateToolhelp32Snapshot(DWORD dwFlags, DWORD th32ProcessID)
         */
        CreateToolhelp32Snapshot: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([flags])=>{
                const listed = host.processes?.() ?? listProcesses(kernel, {
                    id: (host.processId ?? 0x1000) >>> 0,
                    parent: (host.parentProcessId ?? 0) >>> 0, path: host.imagePath?.() ?? '' });
                return kernel.handles.open('snapshot', {
                    flags: flags >>> 0,
                    processes: listed.map(process=>({ id: process.id, parent: process.parent,
                        threads: Math.max(process.threads.length, 1), path: process.path })),
                    threads: listed.flatMap(process=>process.threads
                        .map(id=>({ id, owner: process.id }))),
                    modules: (flags & TH32CS_SNAPMODULE) === 0 ? [] : (host.modules?.() ?? [])
                        .map(module=>({
                            base: module.base >>> 0,
                            size: (module.size ?? 0) >>> 0,
                            path: module.path ?? `C:\\WINDOWS\\system32\\${module.name}`,
                        })),
                    process: 0,
                    thread: 0,
                    module: 0,
                });
            },
        },

        /**
         * BOOL K32EnumProcesses(DWORD *lpidProcess, DWORD cb, LPDWORD lpcbNeeded),
         * psapi's EnumProcesses: the ids a process snapshot lists, as many as
         * fit in cb bytes, and the bytes written. A list that filled the
         * buffer may have been cut short; the caller grows it and asks again.
         */
        K32EnumProcesses: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([ids, size, needed])=>{
                if (wholeAddress(needed) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const all = [(host.processId ?? 0x1000) >>> 0,
                    ...kernel.processes.all()
                        .filter((/** @type {any} */ child)=>!child.completed
                            && child.exitCode === kernel.processes.STILL_ACTIVE)
                        .map((/** @type {any} */ child)=>child.id >>> 0)];
                const count = wholeAddress(ids) === 0
                    ? 0 : Math.min(all.length, Math.floor((size >>> 0) / 4));
                const bytes = new Uint8Array(count * 4);
                const view = new DataView(bytes.buffer);
                all.slice(0, count).forEach((id, i)=>view.setUint32(i * 4, id, true));
                if (count > 0)
                {
                    guest.setBytes(wholeAddress(ids), bytes);
                }
                const written = new Uint8Array(4);
                new DataView(written.buffer).setUint32(0, count * 4, true);
                guest.setBytes(wholeAddress(needed), written);
                return 1;
            },
        },

        /**
         * HANDLE OpenThread(DWORD dwDesiredAccess, BOOL bInheritHandle, DWORD dwThreadId)
         *
         * A new handle to a thread of this process that is still an object -
         * running, or ended and held (`threadObjectLives`) - or to
         * a thread of a child it started that it knows the id of -- the first,
         * or one it made there; any other id is refused.
         */
        OpenThread: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([desired, inherit, id])=>{
                const wanted = id >>> 0;
                const own = kernel.threads().find((/** @type {any} */ thread)=>
                    (thread.id >>> 0) === wanted && threadObjectLives(kernel, thread));
                if (own)
                {
                    // The handle carries the rights asked for: a wait on it
                    // needs SYNCHRONIZE, a query of its information
                    // THREAD_QUERY_INFORMATION or the limited form.
                    const access = grantedAccess('thread', desired);
                    if ('error' in access)
                    {
                        host.setLastError(access.error);
                        return 0;
                    }
                    return inheritIf(kernel.handles.open('thread', own, access.granted),
                        inherit !== 0);
                }
                // A child's thread, or one of any process of the run (a
                // grandchild's first thread, found in a snapshot of the run).
                const child = [...kernel.processes.all(), ...kernel.processes.run()]
                    .find((/** @type {any} */ made)=>
                        (made.threadId >>> 0) === wanted || made.threads?.has(wanted));
                if (child)
                {
                    return kernel.handles.open('process-thread', childThread(child, wanted));
                }
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            },
        },

        /**
         * DWORD GetProcessId(HANDLE Process)
         *
         * The id of the process a handle names: this one's for its own
         * pseudo-handle, a child's as CreateProcess reported it. A handle to
         * no process is zero and ERROR_INVALID_HANDLE.
         */
        GetProcessId: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const found = object(handle >>> 0, 'process');
                if (!found)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                return (found.current ? host.processId ?? 0x1000 : found.id) >>> 0;
            },
        },

        /**
         * DWORD GetThreadId(HANDLE Thread) and DWORD GetProcessIdOfThread(HANDLE Thread)
         *
         * A thread's id, and the id of the process it runs in: a thread of
         * this process, or a child's first thread through the handle
         * CreateProcess gave for it.
         */
        GetThreadId: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const own = object(handle >>> 0, 'thread');
                const child = own ? null : object(handle >>> 0, 'process-thread');
                if (!own && !child)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                return (own ? own.id : child.threadId) >>> 0;
            },
        },
        GetProcessIdOfThread: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const own = object(handle >>> 0, 'thread');
                const child = own ? null : object(handle >>> 0, 'process-thread');
                if (!own && !child)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                return (own ? host.processId ?? 0x1000 : child.process.id) >>> 0;
            },
        },

        /**
         * BOOL Process32First(HANDLE, LPPROCESSENTRY32) and Process32Next: the
         * snapshot's processes in turn.
         */
        Process32First: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkSnapshot(handle, entry, true, true),
        },
        Process32Next: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkSnapshot(handle, entry, true, false),
        },
        /** Process32FirstW and Process32NextW: the same, into a PROCESSENTRY32W. */
        Process32FirstW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkSnapshot(handle, entry, true, true, true),
        },
        Process32NextW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkSnapshot(handle, entry, true, false, true),
        },

        /**
         * BOOL Thread32First(HANDLE, LPTHREADENTRY32) and Thread32Next: the
         * snapshot's threads in turn.
         */
        Thread32First: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkSnapshot(handle, entry, false, true),
        },
        Thread32Next: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkSnapshot(handle, entry, false, false),
        },

        /**
         * BOOL Module32First/Module32FirstW(HANDLE, LPMODULEENTRY32) and
         * Module32Next/Module32NextW: the modules of a snapshot taken with
         * TH32CS_SNAPMODULE in turn, the image first.
         */
        Module32First: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkModules(handle, entry, false, true),
        },
        Module32Next: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkModules(handle, entry, false, false),
        },
        Module32FirstW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkModules(handle, entry, true, true),
        },
        Module32NextW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>walkModules(handle, entry, true, false),
        },

        /**
         * BOOL Heap32ListFirst/Heap32ListNext(HANDLE, LPHEAPLIST32),
         * BOOL Heap32First(LPHEAPENTRY32, DWORD th32ProcessID, ULONG_PTR th32HeapID)
         * and BOOL Heap32Next(LPHEAPENTRY32): no heap is listed (`noHeaps`).
         */
        Heap32ListFirst: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>noHeaps(handle),
        },
        Heap32ListNext: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>noHeaps(handle),
        },
        Heap32First: {
            argBytes: 12,
            handler: ()=>{
                host.setLastError(ERROR_NO_MORE_FILES);
                return 0;
            },
        },
        Heap32Next: {
            argBytes: 4,
            handler: ()=>{
                host.setLastError(ERROR_NO_MORE_FILES);
                return 0;
            },
        },
    };

    /**
     * HANDLE CreateRemoteThread(HANDLE hProcess, LPSECURITY_ATTRIBUTES, SIZE_T,
     *                           LPTHREAD_START_ROUTINE, LPVOID, DWORD, LPDWORD)
     * HANDLE CreateRemoteThreadEx(..., LPPROC_THREAD_ATTRIBUTE_LIST, LPDWORD)
     *
     * A thread in this process is CreateThread's. One in a child is the
     * child's CreateThread, made where the child runs, at an address in its
     * memory; this process gets a handle of its own to it, and its id.
     *
     * @param {number} process @param {number[]} rest  CreateThread's six arguments.
     */
    const remoteThread = (process, rest)=>{
        const target = object(process >>> 0, 'process');
        if (!target)
        {
            host.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        if (target.current)
        {
            return table.CreateThread.handler(rest);
        }
        const [, stack, start, parameter, flags, idOut] = rest;
        const asked = host.setLastErrorFor ? askChild({ askChild: host.askChild,
            guest, currentThread: host.currentThread,
            setLastErrorFor: host.setLastErrorFor }, target,
        { call: 'CreateThread', args: [0, stack >>> 0, start >>> 0, parameter >>> 0,
            flags >>> 0, { out: 4 }] }, [null, null, null, null, null, idOut >>> 0],
        (answer, made)=>{
            const bytes = answer.outs[5];
            if (made === 0 || !bytes)
            {
                return 0;
            }
            const id = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
            return kernel.handles.open('process-thread', childThread(target, id, made));
        }) : null;
        if (asked === null)
        {
            host.setLastError(ERROR_ACCESS_DENIED);
            return 0;
        }
        return asked;
    };

    // The native calls over the same objects, which ntdll publishes: they ride
    // on CreateEventW's entry, whose state they share (`sync-natives.js`).
    const natives = createSyncNatives({
        guest,
        kernel, creates,
        existing, keyOf: (given, kind)=>host.namedObjects.keyOf(given, kind),
        reference: found=>host.namedObjects.reference(found), object,
        currentThread: host.currentThread, park: host.park, queueApc: host.queueApc,
        divergence: host.divergence,
    });

    return {
        ...table,
        CreateEventW: { ...table.CreateEventW, natives: { ...natives,
            ...createDirectoryNatives({ guest,
                kernel, namedObjects: host.namedObjects }) } },
        CreateRemoteThread: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([process, ...rest])=>remoteThread(process, rest),
        },
        CreateRemoteThreadEx: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([process, attributes, stack, start, parameter, flags, , threadId])=>
                remoteThread(process, [attributes, stack, start, parameter, flags, threadId]),
        },
    };
}
