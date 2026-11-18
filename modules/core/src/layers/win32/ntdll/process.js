/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The native calls over processes, threads and a module's messages: what
 * kernel32's OpenProcess, ResumeThread, FindResource and CreateProcess do,
 * answered as statuses.
 *
 * Each is the kernel32 call it underlies on Windows, made the other way
 * round: one handle table and one set of processes, so a handle opened here
 * is one CloseHandle closes and a child made here is the child CreateProcess
 * would have made. A kernel32 call leaves a last error where a native one
 * leaves none, so the thread's last error is put back as it was.
 *
 * The process parameters are the block a new process starts with: built
 * here as the system builds it, in the process heap, its strings after the
 * fixed part and -- as RtlCreateProcessParameters hands it back -- their
 * pointers as offsets from the block's start.
 */

import { STATUS } from './status.js';
import { SKIP_THREAD_ATTACH, TEB } from '../kernel32/teb.js';

/** RT_MESSAGETABLE's resource name: a module has one table, and it is number one. */
const MESSAGE_TABLE_NAME = 1;

/** RTL_USER_PROCESS_PARAMETERS on 32-bit Windows 7, as far as these calls read and write it. */
const PARAMETERS = Object.freeze({
    MaximumLength: 0x00,
    Length: 0x04,
    Flags: 0x08,
    CurrentDirectory: 0x24,
    DllPath: 0x30,
    ImagePathName: 0x38,
    CommandLine: 0x40,
    Environment: 0x48,
    WindowTitle: 0x70,
    DesktopInfo: 0x78,
    ShellInfo: 0x80,
    RuntimeData: 0x88,
    EnvironmentSize: 0x290,
    EnvironmentVersion: 0x294,
    SIZE: 0x298,
});

/** The block's pointers are pointers, not offsets from its start. */
const PROCESS_PARAMS_FLAG_NORMALIZED = 0x1;

/** The most an environment block is read for, in UTF-16 units. */
const ENVIRONMENT_LIMIT = 0x100000;

/** The room a current directory is given, whatever its length: MAX_PATH characters. */
const CURRENT_DIRECTORY_ROOM = 260 * 2;

/** Where the thread block keeps the process block, and that the process's parameters. */
const TEB_PEB = 0x30;
const PEB_PROCESS_PARAMETERS = 0x10;

/** RTL_USER_PROCESS_INFORMATION: its size, the two handles, the client id, the image's. */
const PROCESS_INFORMATION = Object.freeze({
    Size: 0, ProcessHandle: 4, ThreadHandle: 8, UniqueProcess: 12, UniqueThread: 16,
    SIZE: 0x44,
});

/**
 * A child made, or the status that refused it.
 *
 * @typedef {{ process: number, thread: number, processId: number, threadId: number }
 *     | { status: number }} Spawned
 */

/** PS_ATTRIBUTE_LIST on 32-bit: TotalLength, then PS_ATTRIBUTEs of four dwords each. */
const ATTRIBUTE_LIST_HEADER = 4;
const ATTRIBUTE_SIZE = 16;
/** The attributes read: the image's name, by pointer; where the client id goes. */
const PS_ATTRIBUTE_IMAGE_NAME = 0x20005;
const PS_ATTRIBUTE_CLIENT_ID = 0x10003;
/** PS_CREATE_INFO's State, and the state that says the process was made. */
const CREATE_INFO_STATE = 4;
const PS_CREATE_SUCCESS = 6;
/** NtCreateUserProcess's flags this reads. */
const PROCESS_CREATE_FLAGS_INHERIT_HANDLES = 0x4;
const THREAD_CREATE_FLAGS_CREATE_SUSPENDED = 0x1;
const THREAD_CREATE_FLAGS_HIDE_FROM_DEBUGGER = 0x4;

/** GetCurrentProcess's and GetCurrentThread's pseudo-handles; OpenThread's rights. */
const CURRENT_PROCESS = 0xffffffff;
const CURRENT_THREAD = 0xfffffffe;
const THREAD_TERMINATE = 0x1;
const THREAD_SUSPEND_RESUME = 0x2;

/** NtCreateThreadEx's flags this honours, and the ones it does not. */
const THREAD_CREATE_FLAGS_SKIP_THREAD_ATTACH = 0x2;
const THREAD_CREATE_FLAGS_SKIP_LOADER_INIT = 0x20;
const THREAD_CREATE_FLAGS_BYPASS_PROCESS_FREEZE = 0x40;
/** CreateThread's: the size given is the stack's reserve. */
const STACK_SIZE_PARAM_IS_A_RESERVATION = 0x10000;
/** THREADINFOCLASS ThreadHideFromDebugger. */
const THREAD_HIDE_FROM_DEBUGGER = 17;
/** ThreadBasicInformation: THREAD_BASIC_INFORMATION, TebBaseAddress after ExitStatus. */
const THREAD_BASIC_INFORMATION = 0;
const THREAD_BASIC_INFORMATION_BYTES = 28;
const THREAD_BASIC_TEB = 4;
/** The pseudo-handle for the calling process. */
const OWN_PROCESS = 0xffffffff;

/** CreateProcess's flags: the first thread waits, the environment is wide. */
const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
/** STARTUPINFOW's size, the one field a caller must fill. */
const STARTUPINFO_SIZE = 68;

/**
 * The kernel32 failures CreateProcess, FindResource and the thread calls
 * leave, and the statuses they are made from.
 */
const ERROR_TO_STATUS = new Map([
    [2, STATUS.OBJECT_NAME_NOT_FOUND],
    [5, STATUS.ACCESS_DENIED],
    [6, STATUS.INVALID_HANDLE],
    [3, STATUS.OBJECT_PATH_NOT_FOUND],
    [193, STATUS.INVALID_IMAGE_NOT_MZ],
    [1812, STATUS.RESOURCE_DATA_NOT_FOUND],
    [1813, STATUS.RESOURCE_TYPE_NOT_FOUND],
    [1814, STATUS.RESOURCE_NAME_NOT_FOUND],
    [1815, STATUS.RESOURCE_LANG_NOT_FOUND],
]);

/** The object-name prefix a DOS path carries in the native calls. */
const DOS_DEVICES = '\\??\\';

/**
 * @typedef {Object} ProcessHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {Record<string, { handler: Function } | undefined>} kernel32
 * @property {() => number} teb
 * @property {(bytes: number) => number} allocate  The process heap.
 * @property {(address: number) => boolean} free
 * @property {() => { id: number, threads: number[] }[]} [processes]
 *           This process first, its threads by id: the ones NtTerminateProcess
 *           with no handle ends and NtSuspendProcess stops.
 * @property {(name: string) => ({ handler: Function } | undefined)} [native]
 *           Another native call by name, made over kernel32's state
 *           (NtSetInformationThread, which marks a thread hidden;
 *           NtQueryInformationThread, which names its block).
 * @property {number} [pointerSize]  8 in a 64-bit process; absent, 4.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {string} text @returns {Uint8Array} UTF-16, unterminated. */
const utf16 = text=>new Uint8Array(Uint16Array.from(text, c=>c.charCodeAt(0)).buffer);

/**
 * @param {ProcessHost} host
 */
export function createProcessFunctions(host){
    const { kernel32 } = host;
    /** The exit code an earlier NtTerminateProcess with no handle kept, or null. */
    /** @type {number | null} */
    let ending = null;
    /** Threads made with THREAD_CREATE_FLAGS_BYPASS_PROCESS_FREEZE, by id. */
    /** @type {Set<number>} */
    const unfrozen = new Set();
    /** The flags NtCreateThreadEx was handed and does not honour, each said once. */
    /** @type {Set<number>} */
    const unhonoured = new Set();

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address */
    const readU16 = address=>{
        const bytes = host.readMemory(address >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * A kernel32 call made for a native one: its answer, with the thread's
     * last error put back as it was -- and the error it left, for the status.
     *
     * @param {string} name @param {number[]} args
     * @returns {{ result: any, error: number }}
     */
    const quietly = (name, args)=>{
        const before = kernel32.GetLastError?.handler([]) ?? 0;
        const result = /** @type {{ handler: Function }} */ (kernel32[name]).handler(args);
        const error = kernel32.GetLastError?.handler([]) ?? 0;
        kernel32.SetLastError?.handler([before]);
        return { result, error };
    };

    /**
     * Get- or SetThreadContext answered as the status its failure is made
     * from: the handle that is no thread, the registers refused, the thread
     * that has ended (ERROR_GEN_FAILURE, which STATUS_UNSUCCESSFUL becomes).
     *
     * @param {string} name @param {number} handle @param {number} context
     */
    const threadContextStatus = (name, handle, context)=>{
        const { result, error } = quietly(name, [handle, context]);
        /** @param {number} done */
        const settle = done=>(done !== 0 ? STATUS.SUCCESS
            : ERROR_TO_STATUS.get(error) ?? STATUS.UNSUCCESSFUL);
        return result instanceof Promise ? result.then(settle) : settle(result);
    };

    /**
     * A UNICODE_STRING's text: at `pointer`, its buffer either an address or,
     * in a block not yet normalised, an offset from `base`.
     *
     * @param {number} pointer @param {number} [base]
     */
    const counted = (pointer, base = 0)=>{
        if ((pointer >>> 0) === 0)
        {
            return null;
        }
        const length = readU16(pointer);
        const buffer = readU32(pointer + 4);
        if (length === 0 || buffer === 0)
        {
            return '';
        }
        const units = host.readMemory((base + buffer) >>> 0, length & ~1).slice();
        return String.fromCharCode(...new Uint16Array(units.buffer, 0, units.length >> 1));
    };

    /** A terminated wide copy in the process heap, or 0. @param {string} text */
    const heapString = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        bytes.set(utf16(text));
        const at = host.allocate(bytes.length) >>> 0;
        if (at !== 0)
        {
            host.writeMemory(at, bytes);
        }
        return at;
    };

    /** The running process's own parameters block, or 0. */
    const ownParameters = ()=>{
        const teb = host.teb();
        const peb = teb === 0 ? 0 : readU32(teb + TEB_PEB);
        return peb === 0 ? 0 : readU32(peb + PEB_PROCESS_PARAMETERS);
    };

    /**
     * One of a parameters block's strings, whichever form the block is in.
     *
     * @param {number} block @param {number} field
     */
    const parameter = (block, field)=>{
        const flags = readU32(block + PARAMETERS.Flags);
        return counted(block + field,
            (flags & PROCESS_PARAMS_FLAG_NORMALIZED) !== 0 ? 0 : block);
    };

    /**
     * A UNICODE_STRING as a string to copy: its text and the room it was
     * given (MaximumLength), or null for none passed.
     *
     * @param {number} pointer @param {number} [base]
     * @returns {{ text: string, room: number } | null}
     */
    const source = (pointer, base = 0)=>{
        const text = counted(pointer, base);
        return text === null ? null : { text, room: readU16(pointer + 2) };
    };

    /**
     * An environment block's bytes, its closing empty entry included: the
     * one at `block`, or where it is NULL the process's own - kernel32's,
     * which holds the variables as they are now, else the block its
     * parameters name.
     *
     * @param {number} block @param {number} own  the process's parameters, or 0
     */
    const environmentBytes = (block, own)=>{
        const current = block === 0 && kernel32.GetEnvironmentStringsW
            ? kernel32.GetEnvironmentStringsW.handler([]) >>> 0 : 0;
        const from = block !== 0 ? block
            : current !== 0 ? current : own !== 0 ? readU32(own + PARAMETERS.Environment) : 0;
        if (from === 0)
        {
            return Uint8Array.of(0, 0, 0, 0);
        }
        let units = 0;
        for (let previous = 1; units < ENVIRONMENT_LIMIT; units++)
        {
            const unit = readU16(from + units * 2);
            if (unit === 0 && previous === 0)
            {
                units++;
                break;
            }
            previous = unit;
        }
        const bytes = host.readMemory(from, Math.max(units, 2) * 2).slice();
        if (current !== 0)
        {
            kernel32.FreeEnvironmentStringsW?.handler([current]);
        }
        return bytes;
    };

    /**
     * RtlCreateProcessParameters' and RtlCreateProcessParametersEx's block: one
     * allocation in the process heap, as Windows lays it out. The fixed part,
     * then each string at the next four-byte boundary in the room its source
     * was given (its MaximumLength, terminated when there is room for it; a
     * string with no room has no buffer); the current directory's room is
     * always MAX_PATH characters. The current directory and the DLL path, not
     * passed, are this process's; the command line the image; the
     * window title, desktop and shell information an empty string with room
     * for its terminator; the runtime data none. Size is where the strings
     * end; the environment, the one passed or this process's, is copied
     * after them in the same allocation, and EnvironmentSize is what the
     * allocation holds from there. Its pointers are offsets from the block -
     * the form the system hands back - unless `normalized` asks for them as
     * addresses.
     *
     * @param {number[]} args @param {boolean} normalized
     */
    const createParameters = (args, normalized)=>{
        const [out, image, dllPath, directory, commandLine, environment, title, desktop, shell,
            runtime] = args;
        if ((out >>> 0) === 0 || (image >>> 0) === 0)
        {
            return STATUS.INVALID_PARAMETER;
        }
        const own = ownParameters();
        const flags = own ? readU32(own + PARAMETERS.Flags) : 0;
        const ownBase = (flags & PROCESS_PARAMS_FLAG_NORMALIZED) !== 0 ? 0 : own;
        /** @param {number} field */
        const inherited = field=>(own ? source(own + field, ownBase) : null);
        const imagePath = source(image) ?? { text: '', room: 2 };
        const empty = { text: '', room: 2 };
        const ownDirectory = inherited(PARAMETERS.CurrentDirectory);
        /** @type {[number, { text: string, room: number }][]} */
        const strings = [
            [PARAMETERS.CurrentDirectory, { text: (source(directory) ?? ownDirectory)?.text ?? '',
                room: CURRENT_DIRECTORY_ROOM }],
            [PARAMETERS.DllPath, source(dllPath) ?? inherited(PARAMETERS.DllPath)
                ?? { text: '', room: 0 }],
            [PARAMETERS.ImagePathName, imagePath],
            [PARAMETERS.CommandLine, source(commandLine) ?? imagePath],
            [PARAMETERS.WindowTitle, source(title) ?? empty],
            [PARAMETERS.DesktopInfo, source(desktop) ?? empty],
            [PARAMETERS.ShellInfo, source(shell) ?? empty],
            [PARAMETERS.RuntimeData, source(runtime) ?? { text: '', room: 0 }],
        ];
        /** @type {number[]} */
        const places = [];
        /** @type {number} */
        let cursor = PARAMETERS.SIZE;
        for (const [, { text, room }] of strings)
        {
            const fitted = Math.max(room, text.length * 2);
            cursor = (cursor + 3) & ~3;
            places.push(cursor);
            cursor += fitted;
        }
        const size = (cursor + 3) & ~3;
        const environmentCopy = environmentBytes(environment >>> 0, own);
        const total = (size + environmentCopy.length + 3) & ~3;
        const block = host.allocate(total) >>> 0;
        if (block === 0)
        {
            return STATUS.NO_MEMORY;
        }
        const bytes = new Uint8Array(total);
        const view = new DataView(bytes.buffer);
        view.setUint32(PARAMETERS.MaximumLength, size, true);
        view.setUint32(PARAMETERS.Length, size, true);
        view.setUint32(PARAMETERS.Flags, normalized ? PROCESS_PARAMS_FLAG_NORMALIZED : 0, true);
        strings.forEach(([field, { text, room }], index)=>{
            const fitted = Math.max(room, text.length * 2);
            view.setUint16(field, text.length * 2, true);
            view.setUint16(field + 2, fitted, true);
            if (fitted === 0)
            {
                return;
            }
            view.setUint32(field + 4, normalized ? block + places[index] : places[index], true);
            bytes.set(utf16(text), places[index]);
        });
        bytes.set(environmentCopy, size);
        view.setUint32(PARAMETERS.Environment, block + size, true);
        view.setUint32(PARAMETERS.EnvironmentSize, total - size, true);
        host.writeMemory(block, bytes);
        writeU32(out, block);
        return STATUS.SUCCESS;
    };

    /**
     * A PS_ATTRIBUTE_LIST's attributes by kind: each one's size and value
     * (an address for the attributes passed by pointer). The list's
     * TotalLength says how many there are.
     *
     * @param {number} list
     * @returns {Map<number, { size: number, value: number }>}
     */
    const attributeList = list=>{
        const total = readU32(list);
        /** @type {Map<number, { size: number, value: number }>} */
        const found = new Map();
        for (let at = ATTRIBUTE_LIST_HEADER; at + ATTRIBUTE_SIZE <= total; at += ATTRIBUTE_SIZE)
        {
            found.set(readU32(list + at), {
                size: readU32(list + at + 4), value: readU32(list + at + 8) });
        }
        return found;
    };

    /**
     * The child CreateProcessW makes of an image and a parameters block -
     * its command line, directory and environment - with its first thread
     * suspended: its handles and client id, or the status its refusal is
     * made from. The image information is left to the child, whose image is
     * not mapped until it takes this process's place.
     *
     * @param {string} named  the image, a DOS path with or without `\??\`
     * @param {number} parameters @param {boolean} inherit
     * @returns {Spawned | Promise<Spawned>}
     */
    const spawn = (named, parameters, inherit)=>{
        const create = kernel32.CreateProcessW;
        if (!create)
        {
            return { status: STATUS.NOT_IMPLEMENTED };
        }
        const path = named.startsWith(DOS_DEVICES) ? named.slice(DOS_DEVICES.length) : named;
        const commandLine = parameter(parameters, PARAMETERS.CommandLine) ?? '';
        const directory = parameter(parameters, PARAMETERS.CurrentDirectory) ?? '';
        const environment = readU32(parameters + PARAMETERS.Environment);

        const application = heapString(path);
        const line = heapString(commandLine);
        const folder = directory === '' ? 0 : heapString(directory);
        const scratch = host.allocate(STARTUPINFO_SIZE + 16) >>> 0;
        const held = [application, line, folder, scratch].filter(at=>at !== 0);
        const release = ()=>held.forEach(at=>host.free(at));
        if (application === 0 || line === 0 || scratch === 0)
        {
            release();
            return { status: STATUS.NO_MEMORY };
        }
        const startup = new Uint8Array(STARTUPINFO_SIZE + 16);
        new DataView(startup.buffer).setUint32(0, STARTUPINFO_SIZE, true);
        host.writeMemory(scratch, startup);
        const before = kernel32.GetLastError?.handler([]) ?? 0;
        const created = create.handler([application, line, 0, 0,
            inherit ? 1 : 0,
            CREATE_SUSPENDED | (environment !== 0 ? CREATE_UNICODE_ENVIRONMENT : 0),
            environment, folder, scratch, scratch + STARTUPINFO_SIZE]);
        /** @param {number} result @returns {Spawned} */
        const settle = result=>{
            const information = scratch + STARTUPINFO_SIZE;
            const error = kernel32.GetLastError?.handler([]) ?? 0;
            kernel32.SetLastError?.handler([before]);
            if ((result >>> 0) === 0)
            {
                release();
                return { status: ERROR_TO_STATUS.get(error) ?? STATUS.UNSUCCESSFUL };
            }
            const child = { process: readU32(information), thread: readU32(information + 4),
                processId: readU32(information + 8), threadId: readU32(information + 12) };
            release();
            return child;
        };
        return created instanceof Promise ? created.then(settle) : settle(created);
    };

    /**
     * A thread CreateRemoteThreadEx makes, in this process or a child, its
     * handle and id, or the status its refusal is made from; hidden from a
     * debugger where asked, which the thread then says when asked.
     *
     * @param {{ process: number, start: number, argument: number, suspended: boolean,
     *     commit: number, reserve: number, hidden?: boolean }} asked
     * @returns {any}  `{ handle, id }` or `{ status }`, or a promise of one
     */
    const makeThread = asked=>{
        const scratch = host.allocate(4) >>> 0;
        if (scratch === 0)
        {
            return { status: STATUS.NO_MEMORY };
        }
        const reserve = asked.reserve >>> 0;
        const flags = (asked.suspended ? CREATE_SUSPENDED : 0)
            | (reserve !== 0 ? STACK_SIZE_PARAM_IS_A_RESERVATION : 0);
        const { result, error } = quietly('CreateRemoteThreadEx', [asked.process, 0,
            reserve !== 0 ? reserve : asked.commit, asked.start, asked.argument, flags, 0,
            scratch]);
        /** @param {number} handle */
        const settle = handle=>{
            const id = readU32(scratch);
            host.free(scratch);
            if ((handle >>> 0) === 0)
            {
                return { status: ERROR_TO_STATUS.get(error) ?? STATUS.UNSUCCESSFUL };
            }
            if (asked.hidden)
            {
                host.native?.('NtSetInformationThread')?.handler(
                    [handle, THREAD_HIDE_FROM_DEBUGGER, 0, 0]);
            }
            return { handle: handle >>> 0, id };
        };
        return result instanceof Promise ? result.then(settle) : settle(result);
    };

    /**
     * Marks a stopped thread of this process as made with
     * THREAD_CREATE_FLAGS_SKIP_THREAD_ATTACH, in its block, where Windows
     * keeps it and the loader reads it: SameTebFlags' SkipThreadAttach set,
     * and no thread-local storage array, which only the libraries' attach
     * would have filled. Another process's thread, or a 64-bit one, is told
     * of as any thread, and that is said.
     *
     * @param {number} process @param {number} handle
     */
    const markSkipThreadAttach = (process, handle)=>{
        const scratch = (process >>> 0) === OWN_PROCESS && (host.pointerSize ?? 4) === 4
            ? host.allocate(THREAD_BASIC_INFORMATION_BYTES) >>> 0 : 0;
        const asked = scratch === 0 ? null : host.native?.('NtQueryInformationThread')
            ?.handler([handle, THREAD_BASIC_INFORMATION, scratch, THREAD_BASIC_INFORMATION_BYTES,
                0]);
        const teb = asked === STATUS.SUCCESS ? readU32(scratch + THREAD_BASIC_TEB) : 0;
        if (scratch !== 0)
        {
            host.free(scratch);
        }
        if (teb === 0)
        {
            host.divergence?.('NtCreateThreadEx', 'THREAD_CREATE_FLAGS_SKIP_THREAD_ATTACH:'
                + ' the libraries are told of the thread all the same');
            return;
        }
        const word = readU16(teb + TEB.SAME_TEB_FLAGS) | SKIP_THREAD_ATTACH;
        host.writeMemory(teb + TEB.SAME_TEB_FLAGS, Uint8Array.of(word & 0xff, word >>> 8));
        writeU32(teb + TEB.TLS_POINTER, 0);
    };

    /**
     * Every thread of this process but those that bypass a freeze, each
     * handed to SuspendThread or ResumeThread; the caller last, since
     * suspending itself does not return until another resumes it.
     *
     * @param {'SuspendThread' | 'ResumeThread'} call
     */
    const everyThread = call=>{
        const caller = quietly('GetCurrentThreadId', []).result >>> 0;
        for (const id of host.processes?.()[0]?.threads ?? [])
        {
            if ((id >>> 0) === caller || unfrozen.has(id >>> 0))
            {
                continue;
            }
            const thread = quietly('OpenThread', [THREAD_SUSPEND_RESUME, 0, id]).result >>> 0;
            if (thread !== 0)
            {
                quietly(call, [thread]);
                quietly('CloseHandle', [thread]);
            }
        }
        if (call === 'SuspendThread' && !unfrozen.has(caller))
        {
            const parked = quietly(call, [CURRENT_THREAD]).result;
            return typeof parked === 'number' ? STATUS.SUCCESS : parked;
        }
        return STATUS.SUCCESS;
    };

    /**
     * NtSuspendProcess and NtResumeProcess: this process's threads; a child's
     * are not reached from here yet, and saying so is all that is done.
     *
     * @param {string} api @param {number} handle @param {'SuspendThread' | 'ResumeThread'} call
     */
    const wholeProcess = (api, handle, call)=>{
        if ((handle >>> 0) !== CURRENT_PROCESS)
        {
            host.divergence?.(api, 'another process\'s threads are not reached; nothing done');
            return STATUS.NOT_IMPLEMENTED;
        }
        return everyThread(call);
    };

    return {
        /**
         * NTSTATUS NtResumeThread(HANDLE ThreadHandle, PULONG SuspendCount)
         *
         * ResumeThread: the count before, through the pointer when there is
         * one; a handle that is no thread is STATUS_INVALID_HANDLE.
         */
        NtResumeThread: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, count])=>{
                const { result } = quietly('ResumeThread', [handle]);
                const settle = (/** @type {number} */ previous)=>{
                    if ((previous >>> 0) === 0xffffffff)
                    {
                        return STATUS.INVALID_HANDLE;
                    }
                    if ((count >>> 0) !== 0)
                    {
                        writeU32(count, previous);
                    }
                    return STATUS.SUCCESS;
                };
                return result instanceof Promise ? result.then(settle) : settle(result);
            },
        },

        /**
         * NTSTATUS NtSuspendThread(HANDLE ThreadHandle, PULONG PreviousSuspendCount)
         *
         * SuspendThread, as NtResumeThread is ResumeThread: the count before,
         * through the pointer when there is one.
         */
        NtSuspendThread: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, count])=>{
                const { result } = quietly('SuspendThread', [handle]);
                const settle = (/** @type {number} */ previous)=>{
                    if ((previous >>> 0) === 0xffffffff)
                    {
                        return STATUS.INVALID_HANDLE;
                    }
                    if ((count >>> 0) !== 0)
                    {
                        writeU32(count, previous);
                    }
                    return STATUS.SUCCESS;
                };
                return result instanceof Promise ? result.then(settle) : settle(result);
            },
        },

        /**
         * NTSTATUS NtTerminateProcess(HANDLE ProcessHandle, NTSTATUS ExitStatus)
         *
         * A process handle is TerminateProcess's, as a status. No handle at
         * all is the first half of a process ending itself, as ExitProcess
         * does before the libraries are told: every thread but the caller
         * ends, and the call returns, the status kept as the process's exit
         * code. Asked again with no handle, the caller is the last thread
         * and the process ends with the status kept the first time; with its
         * own handle, it ends with the status given then.
         */
        NtTerminateProcess: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                if ((handle >>> 0) !== 0)
                {
                    const { result, error } = quietly('TerminateProcess', [handle, code]);
                    if (typeof result !== 'number')
                    {
                        // This process, ended: nothing returns.
                        return result;
                    }
                    return (result >>> 0) !== 0 ? STATUS.SUCCESS
                        : ERROR_TO_STATUS.get(error) ?? STATUS.UNSUCCESSFUL;
                }
                if (ending !== null)
                {
                    return quietly('TerminateProcess', [CURRENT_PROCESS, ending]).result;
                }
                ending = code >>> 0;
                const caller = quietly('GetCurrentThreadId', []).result >>> 0;
                for (const id of host.processes?.()[0]?.threads ?? [])
                {
                    if ((id >>> 0) === caller)
                    {
                        continue;
                    }
                    const thread = quietly('OpenThread', [THREAD_TERMINATE, 0, id]).result >>> 0;
                    if (thread !== 0)
                    {
                        quietly('TerminateThread', [thread, ending]);
                        quietly('CloseHandle', [thread]);
                    }
                }
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtCreateThreadEx(PHANDLE ThreadHandle, ACCESS_MASK DesiredAccess,
         *   POBJECT_ATTRIBUTES ObjectAttributes, HANDLE ProcessHandle,
         *   PUSER_THREAD_START_ROUTINE StartRoutine, PVOID Argument, ULONG CreateFlags,
         *   SIZE_T ZeroBits, SIZE_T StackSize, SIZE_T MaximumStackSize,
         *   PPS_ATTRIBUTE_LIST AttributeList)
         *
         * CreateRemoteThreadEx's thread: suspended with
         * THREAD_CREATE_FLAGS_CREATE_SUSPENDED, hidden from a debugger with
         * THREAD_CREATE_FLAGS_HIDE_FROM_DEBUGGER, left running by
         * NtSuspendProcess with THREAD_CREATE_FLAGS_BYPASS_PROCESS_FREEZE. A
         * maximum stack size is its reserve, a stack size its commit. With
         * THREAD_CREATE_FLAGS_SKIP_THREAD_ATTACH its block says SkipThreadAttach
         * before it runs, and the loader, which reads that, tells no library
         * of its start or end and it has no thread-local storage array
         * (`markSkipThreadAttach`). _SKIP_LOADER_INIT is not done, and said.
         */
        NtCreateThreadEx: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([out, , , process, start, argument, flags, , commit, reserve])=>{
                if ((out >>> 0) === 0 || (start >>> 0) === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const suspended = ((flags >>> 0) & THREAD_CREATE_FLAGS_CREATE_SUSPENDED) !== 0;
                const skipAttach = ((flags >>> 0) & THREAD_CREATE_FLAGS_SKIP_THREAD_ATTACH) !== 0;
                if (((flags >>> 0) & THREAD_CREATE_FLAGS_SKIP_LOADER_INIT) !== 0
                    && !unhonoured.has(THREAD_CREATE_FLAGS_SKIP_LOADER_INIT))
                {
                    unhonoured.add(THREAD_CREATE_FLAGS_SKIP_LOADER_INIT);
                    host.divergence?.('NtCreateThreadEx', 'THREAD_CREATE_FLAGS_SKIP_LOADER_INIT:'
                        + ' the loader starts the thread all the same');
                }
                // Made stopped, so that its block says so before it runs.
                const made = makeThread({ process, start, argument,
                    suspended: suspended || skipAttach,
                    hidden: ((flags >>> 0) & THREAD_CREATE_FLAGS_HIDE_FROM_DEBUGGER) !== 0,
                    commit, reserve });
                /** @param {any} thread */
                const settle = thread=>{
                    if ('status' in thread)
                    {
                        return thread.status;
                    }
                    if (((flags >>> 0) & THREAD_CREATE_FLAGS_BYPASS_PROCESS_FREEZE) !== 0)
                    {
                        unfrozen.add(thread.id);
                    }
                    if (skipAttach)
                    {
                        markSkipThreadAttach(process, thread.handle);
                        if (!suspended)
                        {
                            quietly('ResumeThread', [thread.handle]);
                        }
                    }
                    writeU32(out, thread.handle);
                    return STATUS.SUCCESS;
                };
                return made instanceof Promise ? made.then(settle) : settle(made);
            },
        },

        /**
         * NTSTATUS RtlCreateUserThread(HANDLE Process, PSECURITY_DESCRIPTOR,
         *   BOOLEAN CreateSuspended, ULONG StackZeroBits, SIZE_T StackReserve,
         *   SIZE_T StackCommit, PUSER_THREAD_START_ROUTINE StartAddress, PVOID Parameter,
         *   PHANDLE Thread, PCLIENT_ID ClientId)
         *
         * The same thread, its handle and client id where asked for.
         */
        RtlCreateUserThread: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([process, , suspended, , reserve, commit, start, argument, out,
                client])=>{
                if ((start >>> 0) === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const made = makeThread({ process, start, argument,
                    suspended: (suspended & 0xff) !== 0, commit, reserve });
                /** @param {any} thread */
                const settle = thread=>{
                    if ('status' in thread)
                    {
                        return thread.status;
                    }
                    if ((out >>> 0) !== 0)
                    {
                        writeU32(out, thread.handle);
                    }
                    else
                    {
                        quietly('CloseHandle', [thread.handle]);
                    }
                    if ((client >>> 0) !== 0)
                    {
                        writeU32(client, quietly('GetProcessIdOfThread', [thread.handle]).result);
                        writeU32(client + 4, thread.id);
                    }
                    return STATUS.SUCCESS;
                };
                return made instanceof Promise ? made.then(settle) : settle(made);
            },
        },

        /**
         * NTSTATUS NtSuspendProcess(HANDLE ProcessHandle)
         * NTSTATUS NtResumeProcess(HANDLE ProcessHandle)
         *
         * Every thread of the process suspended, or resumed, once - but
         * those made to bypass a freeze.
         */
        NtSuspendProcess: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>wholeProcess('NtSuspendProcess', handle, 'SuspendThread'),
        },
        NtResumeProcess: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>wholeProcess('NtResumeProcess', handle, 'ResumeThread'),
        },

        /**
         * NTSTATUS NtGetContextThread(HANDLE ThreadHandle, PCONTEXT Context)
         *
         * GetThreadContext as a status, the groups the context's flags ask
         * for filled in place.
         */
        NtGetContextThread: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, context])=>threadContextStatus('GetThreadContext', handle, context),
        },

        /**
         * NTSTATUS NtSetContextThread(HANDLE ThreadHandle, PCONTEXT Context)
         *
         * SetThreadContext as a status: what it refuses is refused here the
         * same way, as the status its last error is made from.
         */
        NtSetContextThread: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, context])=>threadContextStatus('SetThreadContext', handle, context),
        },

        /**
         * NTSTATUS NtOpenProcess(PHANDLE ProcessHandle, ACCESS_MASK DesiredAccess,
         *   POBJECT_ATTRIBUTES ObjectAttributes, PCLIENT_ID ClientId)
         *
         * OpenProcess by the client id's process: a process has no name to be
         * opened by, so without an id the call names nothing it can take.
         * An id that is no process is STATUS_INVALID_CID.
         */
        NtOpenProcess: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out, access, attributes, client])=>{
                void attributes;
                if ((out >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                if ((client >>> 0) === 0)
                {
                    return STATUS.INVALID_PARAMETER_MIX;
                }
                const { result } = quietly('OpenProcess', [access, 0, readU32(client)]);
                if ((result >>> 0) === 0)
                {
                    return STATUS.INVALID_CID;
                }
                writeU32(out, result);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlFindMessage(PVOID BaseAddress, ULONG Type, ULONG Language,
         *   ULONG MessageId, PMESSAGE_RESOURCE_ENTRY *MessageResourceEntry)
         *
         * The module's message table -- the resource of that type named one,
         * in that language or any for a neutral one -- read as the system
         * reads it: the block whose range holds the id, then its entries in
         * turn, each as long as its own length says. The answer points at the
         * entry in the module's own image.
         */
        RtlFindMessage: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([base, type, language, id, out])=>{
                const found = quietly('FindResourceExW',
                    [base, type, MESSAGE_TABLE_NAME, language & 0xffff]);
                if ((found.result >>> 0) === 0)
                {
                    return ERROR_TO_STATUS.get(found.error) ?? STATUS.RESOURCE_DATA_NOT_FOUND;
                }
                const table = quietly('LoadResource', [base, found.result]).result >>> 0;
                const size = quietly('SizeofResource', [base, found.result]).result >>> 0;
                if (table === 0 || size < 4)
                {
                    return STATUS.RESOURCE_DATA_NOT_FOUND;
                }
                const wanted = id >>> 0;
                const blocks = readU32(table);
                for (let block = 0; block < blocks && 4 + (block + 1) * 12 <= size; block++)
                {
                    const at = table + 4 + block * 12;
                    const low = readU32(at);
                    const high = readU32(at + 4);
                    if (wanted < low || wanted > high)
                    {
                        continue;
                    }
                    let entry = table + readU32(at + 8);
                    for (let skip = low; skip < wanted; skip++)
                    {
                        const length = readU16(entry);
                        if (length === 0 || entry + length > table + size)
                        {
                            return STATUS.MESSAGE_NOT_FOUND;
                        }
                        entry += length;
                    }
                    if ((out >>> 0) !== 0)
                    {
                        writeU32(out, entry);
                    }
                    return STATUS.SUCCESS;
                }
                return STATUS.MESSAGE_NOT_FOUND;
            },
        },

        /**
         * NTSTATUS RtlCreateProcessParameters(PRTL_USER_PROCESS_PARAMETERS *pProcessParameters,
         *   PUNICODE_STRING ImagePathName, PUNICODE_STRING DllPath,
         *   PUNICODE_STRING CurrentDirectory, PUNICODE_STRING CommandLine,
         *   PWSTR Environment, PUNICODE_STRING WindowTitle, PUNICODE_STRING DesktopInfo,
         *   PUNICODE_STRING ShellInfo, PUNICODE_STRING RuntimeData)
         *
         * One block in the process heap: the fixed part, then each string
         * terminated and four-aligned, its pointer an offset from the block
         * -- the form the system hands back, normalised by whoever starts
         * the process with it. The DLL path, the directory and the
         * environment are the running process's when none is given; the
         * command line is the image's path; the rest are empty.
         */
        RtlCreateProcessParameters: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: args=>createParameters(args, false),
        },

        /**
         * NTSTATUS RtlCreateProcessParametersEx(PRTL_USER_PROCESS_PARAMETERS *pProcessParameters,
         *   ..., PUNICODE_STRING RuntimeData, ULONG Flags)
         *
         * RtlCreateProcessParameters' block; with RTL_USER_PROC_PARAMS_NORMALIZED
         * its strings are pointers and its Flags say so, as a running
         * process's are.
         */
        RtlCreateProcessParametersEx: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: args=>createParameters(args.slice(0, 10),
                ((args[10] >>> 0) & PROCESS_PARAMS_FLAG_NORMALIZED) !== 0),
        },

        /**
         * NTSTATUS RtlDestroyProcessParameters(PRTL_USER_PROCESS_PARAMETERS)
         *
         * The block back to the process heap it came from.
         */
        RtlDestroyProcessParameters: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                if ((block >>> 0) !== 0)
                {
                    host.free(block >>> 0);
                }
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlCreateUserProcess(PUNICODE_STRING ImageFileName, ULONG Attributes,
         *   PRTL_USER_PROCESS_PARAMETERS ProcessParameters,
         *   PSECURITY_DESCRIPTOR ProcessSecurityDescriptor,
         *   PSECURITY_DESCRIPTOR ThreadSecurityDescriptor, HANDLE ParentProcess,
         *   BOOLEAN InheritHandles, HANDLE DebugPort, HANDLE ExceptionPort,
         *   PRTL_USER_PROCESS_INFORMATION ProcessInformation)
         *
         * CreateProcessW over the image the object name points at and the
         * command line, directory and environment of the parameters, with
         * its first thread suspended as this call leaves it: the child is
         * the one CreateProcess makes, and starts when NtResumeThread lets
         * it. The image information is left zero -- the image is not mapped
         * until the child takes this process's place.
         */
        RtlCreateUserProcess: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([image, , parameters, , , , inherit, , , information])=>{
                if ((image >>> 0) === 0 || (parameters >>> 0) === 0 || (information >>> 0) === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const made = spawn(counted(image) ?? '', parameters, (inherit & 0xff) !== 0);
                /** @param {Spawned} child */
                const settle = child=>{
                    if ('status' in child)
                    {
                        return child.status;
                    }
                    const answer = new Uint8Array(PROCESS_INFORMATION.SIZE);
                    const view = new DataView(answer.buffer);
                    view.setUint32(PROCESS_INFORMATION.Size, PROCESS_INFORMATION.SIZE, true);
                    view.setUint32(PROCESS_INFORMATION.ProcessHandle, child.process, true);
                    view.setUint32(PROCESS_INFORMATION.ThreadHandle, child.thread, true);
                    view.setUint32(PROCESS_INFORMATION.UniqueProcess, child.processId, true);
                    view.setUint32(PROCESS_INFORMATION.UniqueThread, child.threadId, true);
                    host.writeMemory(information >>> 0, answer);
                    return STATUS.SUCCESS;
                };
                return made instanceof Promise ? made.then(settle) : settle(made);
            },
        },

        /**
         * NTSTATUS NtCreateUserProcess(PHANDLE ProcessHandle, PHANDLE ThreadHandle,
         *   ACCESS_MASK ProcessDesiredAccess, ACCESS_MASK ThreadDesiredAccess,
         *   POBJECT_ATTRIBUTES ProcessObjectAttributes,
         *   POBJECT_ATTRIBUTES ThreadObjectAttributes, ULONG ProcessFlags,
         *   ULONG ThreadFlags, PRTL_USER_PROCESS_PARAMETERS ProcessParameters,
         *   PPS_CREATE_INFO CreateInfo, PPS_ATTRIBUTE_LIST AttributeList)
         *
         * The process RtlCreateUserProcess makes, its image named by the
         * attribute list's PS_ATTRIBUTE_IMAGE_NAME, its first thread left
         * suspended only when THREAD_CREATE_FLAGS_CREATE_SUSPENDED asks. A
         * new process's first thread cannot be hidden from a debugger:
         * THREAD_CREATE_FLAGS_HIDE_FROM_DEBUGGER is refused. The client id is
         * written where PS_ATTRIBUTE_CLIENT_ID asks for it, and the create
         * info says the creation succeeded; the other attributes, and the
         * access asked for, are the system's to honour and change nothing
         * here (the handles carry every right).
         */
        NtCreateUserProcess: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([processOut, threadOut, , , , , processFlags, threadFlags, parameters,
                createInfo, attributes])=>{
                if ((processOut >>> 0) === 0 || (threadOut >>> 0) === 0
                    || (parameters >>> 0) === 0 || (attributes >>> 0) === 0
                    || ((threadFlags >>> 0) & THREAD_CREATE_FLAGS_HIDE_FROM_DEBUGGER) !== 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const list = attributeList(attributes >>> 0);
                const imageName = list.get(PS_ATTRIBUTE_IMAGE_NAME);
                if (!imageName)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const units = host.readMemory(imageName.value, imageName.size & ~1).slice();
                const image = String.fromCharCode(
                    ...new Uint16Array(units.buffer, 0, units.length >> 1));
                const made = spawn(image, parameters >>> 0,
                    ((processFlags >>> 0) & PROCESS_CREATE_FLAGS_INHERIT_HANDLES) !== 0);
                /** @param {Spawned} child */
                const settle = child=>{
                    if ('status' in child)
                    {
                        return child.status;
                    }
                    writeU32(processOut, child.process);
                    writeU32(threadOut, child.thread);
                    const client = list.get(PS_ATTRIBUTE_CLIENT_ID);
                    if (client && client.size >= 8)
                    {
                        writeU32(client.value, child.processId);
                        writeU32(client.value + 4, child.threadId);
                    }
                    if ((createInfo >>> 0) !== 0)
                    {
                        writeU32(createInfo + CREATE_INFO_STATE, PS_CREATE_SUCCESS);
                    }
                    if (((threadFlags >>> 0) & THREAD_CREATE_FLAGS_CREATE_SUSPENDED) === 0)
                    {
                        const resumed = quietly('ResumeThread', [child.thread]).result;
                        if (resumed instanceof Promise)
                        {
                            return resumed.then(()=>STATUS.SUCCESS);
                        }
                    }
                    return STATUS.SUCCESS;
                };
                return made instanceof Promise ? made.then(settle) : settle(made);
            },
        },
    };
}
