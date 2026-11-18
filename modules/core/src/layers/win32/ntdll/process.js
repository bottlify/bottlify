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

/** RT_MESSAGETABLE's resource name: a module has one table, and it is number one. */
const MESSAGE_TABLE_NAME = 1;

/** RTL_USER_PROCESS_PARAMETERS on 32-bit Windows XP, as far as these calls read and write it. */
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
    SIZE: 0x290,
});

/** The block's pointers are pointers, not offsets from its start. */
const PROCESS_PARAMS_FLAG_NORMALIZED = 0x1;

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

/** GetCurrentProcess's pseudo-handle; OpenThread's right to end a thread. */
const CURRENT_PROCESS = 0xffffffff;
const THREAD_TERMINATE = 0x1;

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
 *           with no handle ends.
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
     * RtlCreateProcessParameters' and RtlCreateProcessParametersEx's block: one
     * allocation in the process heap, the fixed part, then each string
     * terminated and four-aligned. Its pointers are offsets from the block -
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
        const imagePath = counted(image) ?? '';
        /** @type {[number, string, number][]} field, text, room */
        const strings = [
            [PARAMETERS.CurrentDirectory, counted(directory)
                ?? (own ? parameter(own, PARAMETERS.CurrentDirectory) : null) ?? '',
            CURRENT_DIRECTORY_ROOM],
            [PARAMETERS.DllPath, counted(dllPath)
                ?? (own ? parameter(own, PARAMETERS.DllPath) : null) ?? '', 0],
            [PARAMETERS.ImagePathName, imagePath, 0],
            [PARAMETERS.CommandLine, counted(commandLine) ?? imagePath, 0],
            [PARAMETERS.WindowTitle, counted(title) ?? '', 0],
            [PARAMETERS.DesktopInfo, counted(desktop) ?? '', 0],
            [PARAMETERS.ShellInfo, counted(shell) ?? '', 0],
            [PARAMETERS.RuntimeData, counted(runtime) ?? '', 0],
        ];
        const roomOf = (/** @type {string} */ text, /** @type {number} */ least)=>
            (Math.max(text.length * 2 + 2, least) + 3) & ~3;
        let total = PARAMETERS.SIZE;
        for (const [, text, least] of strings)
        {
            total += roomOf(text, least);
        }
        const block = host.allocate(total) >>> 0;
        if (block === 0)
        {
            return STATUS.NO_MEMORY;
        }
        const bytes = new Uint8Array(total);
        const view = new DataView(bytes.buffer);
        view.setUint32(PARAMETERS.MaximumLength, total, true);
        view.setUint32(PARAMETERS.Length, total, true);
        view.setUint32(PARAMETERS.Flags, normalized ? PROCESS_PARAMS_FLAG_NORMALIZED : 0, true);
        view.setUint32(PARAMETERS.Environment, (environment >>> 0) !== 0 ? environment
            : own ? readU32(own + PARAMETERS.Environment) : 0, true);
        let cursor = PARAMETERS.SIZE;
        for (const [field, text, least] of strings)
        {
            const room = roomOf(text, least);
            view.setUint16(field, text.length * 2, true);
            view.setUint16(field + 2, room, true);
            view.setUint32(field + 4, normalized ? block + cursor : cursor, true);
            bytes.set(utf16(text), cursor);
            cursor += room;
        }
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
