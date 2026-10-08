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

/** CreateProcess's flags: the first thread waits, the environment is wide. */
const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
/** STARTUPINFOW's size, the one field a caller must fill. */
const STARTUPINFO_SIZE = 68;

/** The kernel32 failures CreateProcess and FindResource leave, and the statuses they are. */
const ERROR_TO_STATUS = new Map([
    [2, STATUS.OBJECT_NAME_NOT_FOUND],
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
 */

/** @param {string} text @returns {Uint8Array} UTF-16, unterminated. */
const utf16 = text=>new Uint8Array(Uint16Array.from(text, c=>c.charCodeAt(0)).buffer);

/**
 * @param {ProcessHost} host
 */
export function createProcessFunctions(host){
    const { kernel32 } = host;

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
            handler: ([out, image, dllPath, directory, commandLine, environment, title,
                desktop, shell, runtime])=>{
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
                view.setUint32(PARAMETERS.Environment, (environment >>> 0) !== 0 ? environment
                    : own ? readU32(own + PARAMETERS.Environment) : 0, true);
                let cursor = PARAMETERS.SIZE;
                for (const [field, text, least] of strings)
                {
                    const room = roomOf(text, least);
                    view.setUint16(field, text.length * 2, true);
                    view.setUint16(field + 2, room, true);
                    view.setUint32(field + 4, cursor, true);
                    bytes.set(utf16(text), cursor);
                    cursor += room;
                }
                host.writeMemory(block, bytes);
                writeU32(out, block);
                return STATUS.SUCCESS;
            },
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
                if (!kernel32.CreateProcessW)
                {
                    return STATUS.NOT_IMPLEMENTED;
                }
                const named = counted(image) ?? '';
                const path = named.startsWith(DOS_DEVICES)
                    ? named.slice(DOS_DEVICES.length) : named;
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
                    return STATUS.NO_MEMORY;
                }
                const startup = new Uint8Array(STARTUPINFO_SIZE + 16);
                new DataView(startup.buffer).setUint32(0, STARTUPINFO_SIZE, true);
                host.writeMemory(scratch, startup);
                const before = kernel32.GetLastError?.handler([]) ?? 0;
                const created = kernel32.CreateProcessW.handler([application, line, 0, 0,
                    (inherit & 0xff) !== 0 ? 1 : 0,
                    CREATE_SUSPENDED | (environment !== 0 ? CREATE_UNICODE_ENVIRONMENT : 0),
                    environment, folder, scratch, scratch + STARTUPINFO_SIZE]);
                const settle = (/** @type {number} */ result)=>{
                    const processInformation = scratch + STARTUPINFO_SIZE;
                    const error = kernel32.GetLastError?.handler([]) ?? 0;
                    kernel32.SetLastError?.handler([before]);
                    if ((result >>> 0) === 0)
                    {
                        release();
                        return ERROR_TO_STATUS.get(error) ?? STATUS.UNSUCCESSFUL;
                    }
                    const answer = new Uint8Array(PROCESS_INFORMATION.SIZE);
                    const view = new DataView(answer.buffer);
                    view.setUint32(PROCESS_INFORMATION.Size, PROCESS_INFORMATION.SIZE, true);
                    view.setUint32(PROCESS_INFORMATION.ProcessHandle,
                        readU32(processInformation), true);
                    view.setUint32(PROCESS_INFORMATION.ThreadHandle,
                        readU32(processInformation + 4), true);
                    view.setUint32(PROCESS_INFORMATION.UniqueProcess,
                        readU32(processInformation + 8), true);
                    view.setUint32(PROCESS_INFORMATION.UniqueThread,
                        readU32(processInformation + 12), true);
                    host.writeMemory(information >>> 0, answer);
                    release();
                    return STATUS.SUCCESS;
                };
                return created instanceof Promise ? created.then(settle) : settle(created);
            },
        },
    };
}
