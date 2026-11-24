/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Reading and writing a process's memory: NtReadVirtualMemory and
 * NtWriteVirtualMemory, and kernel32's ReadProcessMemory and
 * WriteProcessMemory over them, on this process or a child where it runs
 * (`cross-process.js`). One copy serves all four, and it goes through the
 * pages' protection as VirtualQuery answers it on both sides: a page that is
 * not committed, PAGE_NOACCESS or a guard page cannot be read, and only a
 * writable or copy-on-write page can be written.
 *
 * A copy goes as far as the first page that refuses it and says how much
 * (STATUS_PARTIAL_COPY), except that a write whose source cannot all be read
 * writes nothing: the source is taken whole first. WriteProcessMemory is
 * the native write with what kernel32 adds around it: memory that is only
 * executable is made writable for the write and put back, so a patcher
 * writes over code, while read-only or inaccessible memory is refused with
 * ERROR_NOACCESS and the count left as it was.
 */

import { PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE }
    from './process-target.js';
import { VIRTUAL_READ, VIRTUAL_WRITE, askChild } from './cross-process.js';
import { wholeAddress } from '../common/pointers.js';

const STATUS_SUCCESS = 0;
const STATUS_PARTIAL_COPY = 0x8000000d;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_ACCESS_DENIED = 0xc0000022;

const ERROR_SUCCESS = 0;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_PARTIAL_COPY = 299;
const ERROR_NOACCESS = 998;

const PAGE_SIZE = 0x1000;
const MEM_COMMIT = 0x1000;
const PAGE_NOACCESS = 0x01;
const PAGE_READONLY = 0x02;
const PAGE_GUARD = 0x100;
/** PAGE_READWRITE, PAGE_WRITECOPY, PAGE_EXECUTE_READWRITE, PAGE_EXECUTE_WRITECOPY. */
const WRITABLE = 0x04 | 0x08 | 0x40 | 0x80;

/**
 * The native pair on kernel32's table for ntdll, which exports them: each
 * answers an NTSTATUS, now or once the child has. Carried under a symbol, so
 * no export is made of it.
 */
export const VIRTUAL_MEMORY = Symbol('virtual memory');

/**
 * @typedef {(address: number) => { state: number, protect: number, end?: number }} PageState
 */

/**
 * How many bytes from `address`, up to `length`, a copy may read - or, with
 * `write`, write - before a page refuses it, as VirtualQuery answers the
 * pages (`end`: where the run of pages with the same answer stops).
 *
 * @param {PageState} pageState
 * @param {number} address @param {number} length @param {boolean} write
 */
export function accessibleSpan(pageState, address, length, write){
    const end = address + length;
    let at = address;
    while (at < end)
    {
        const page = at - at % PAGE_SIZE;
        /** @type {ReturnType<PageState>} */
        let answer;
        try
        {
            answer = pageState(page);
        }
        catch (e){
            // Past the address space: nothing there to copy.
            void e;
            break;
        }
        const { state, protect, end: runEnd } = answer;
        const base = protect & 0xff;
        if (state !== MEM_COMMIT || (protect & PAGE_GUARD) !== 0 || base === 0
            || base === PAGE_NOACCESS || write && (protect & WRITABLE) === 0)
        {
            break;
        }
        at = Math.max(page + PAGE_SIZE, runEnd ?? 0);
    }
    return Math.min(at, end) - address;
}

/**
 * @typedef {Object} ProcessMemoryHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, bytes: Uint8Array) => boolean} [patchMemory]  A write
 *           through the memory layer's own protection (`writeThroughProtection`).
 * @property {number} [pointerSize]  8 in a 64-bit process, whose counts are eight bytes
 * @property {PageState} pageState  VirtualQuery's answer for a page (heap.js PAGE_STATE).
 * @property {(handle: number, right: number) => import('./process-target.js').ProcessTarget}
 *     processTarget
 * @property {(code: number) => void} setLastError
 * @property {import('./cross-process.js').AskHost['askChild']} [askChild]
 * @property {() => any} [currentThread]
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 */

/**
 * @param {ProcessMemoryHost} host
 */
export function createProcessMemory(host){
    /**
     * A count out: a SIZE_T, eight bytes in a 64-bit process. Written as a
     * dword there, its upper half stayed whatever the caller's variable held
     * and a reader comparing the count with what it asked saw no read at all.
     *
     * @param {number} address @param {number} value
     */
    const writeCount = (address, value)=>{
        if (address !== 0)
        {
            const bytes = new Uint8Array(host.pointerSize === 8 ? 8 : 4);
            new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
            host.writeMemory(address, bytes);
        }
    };

    /** @param {number} address @param {number} length @returns {Uint8Array} */
    const readable = (address, length)=>{
        const span = length === 0 ? 0 : accessibleSpan(host.pageState, address, length, false);
        try
        {
            return span === 0 ? new Uint8Array(0) : host.readMemory(address, span);
        }
        catch (e){
            void e;
            return new Uint8Array(0);
        }
    };

    /** @param {number} address @param {Uint8Array} bytes */
    const store = (address, bytes)=>{
        if (bytes.length === 0)
        {
            return true;
        }
        if (host.patchMemory)
        {
            return host.patchMemory(address, bytes);
        }
        host.writeMemory(address, bytes);
        return true;
    };

    /**
     * The read in this process: from `base` into `buffer`, as far as both
     * sides' pages allow, the count written to `read`.
     *
     * @param {number} base @param {number} buffer @param {number} count @param {number} read
     */
    const readHere = (base, buffer, count, read)=>{
        const bytes = readable(base, count);
        const room = bytes.length === 0 ? 0
            : accessibleSpan(host.pageState, buffer, bytes.length, true);
        if (room > 0)
        {
            host.writeMemory(buffer, bytes.subarray(0, room));
        }
        writeCount(read, room);
        return room === count ? STATUS_SUCCESS : STATUS_PARTIAL_COPY;
    };

    /**
     * The write in this process: `have` bytes of `count` were readable where
     * they came from. `lift` is WriteProcessMemory's: memory only executable
     * is written through its protection, read-only or none refused
     * (STATUS_ACCESS_VIOLATION) before anything is counted.
     *
     * @param {number} base @param {number} buffer @param {number} have
     * @param {number} count @param {number} lift @param {number} written
     */
    const writeHere = (base, buffer, have, count, lift, written)=>{
        if (count === 0)
        {
            writeCount(written, 0);
            return STATUS_SUCCESS;
        }
        const { state, protect } = host.pageState(base - base % PAGE_SIZE);
        const kind = protect & 0xff;
        const open = state === MEM_COMMIT && (protect & WRITABLE) !== 0;
        if (lift && (state !== MEM_COMMIT || kind === PAGE_NOACCESS || kind === PAGE_READONLY))
        {
            return STATUS_ACCESS_VIOLATION;
        }
        if (have < count)
        {
            writeCount(written, 0);
            return STATUS_PARTIAL_COPY;
        }
        // Up to the first page that cannot be written, unless the first page
        // is code WriteProcessMemory makes writable for the write.
        const room = lift && !open ? count : accessibleSpan(host.pageState, base, count, true);
        if (room > 0 && !store(base, host.readMemory(buffer, room)))
        {
            writeCount(written, 0);
            return STATUS_PARTIAL_COPY;
        }
        if (room < count)
        {
            writeCount(written, room);
            return STATUS_PARTIAL_COPY;
        }
        writeCount(written, count);
        return STATUS_SUCCESS;
    };

    /** @param {number} error */
    const statusOf = error=>(error === ERROR_INVALID_HANDLE ? STATUS_INVALID_HANDLE
        : STATUS_ACCESS_DENIED);

    /**
     * A copy on the process a handle names: here, or the call made in the
     * child where it runs and its answer taken by `then`. A child that
     * cannot be asked, or that answered no count, is refused.
     *
     * @param {number} handle @param {number} right
     * @param {() => number} here
     * @param {import('./cross-process.js').CrossCall} call
     * @param {(answer: import('./cross-process.js').CrossAnswer) => number} then
     * @returns {number | Promise<number>}
     */
    const onTarget = (handle, right, here, call, then)=>{
        const target = host.processTarget(handle, right);
        if ('error' in target)
        {
            return statusOf(target.error);
        }
        if ('here' in target)
        {
            return here();
        }
        const asked = host.currentThread && host.setLastErrorFor ? askChild({
            askChild: host.askChild, writeMemory: host.writeMemory,
            currentThread: host.currentThread, setLastErrorFor: host.setLastErrorFor,
        }, target.child, call, [], answer=>(answer.outs.at(-1) ? then(answer)
            : STATUS_ACCESS_DENIED)) : null;
        return asked ?? STATUS_ACCESS_DENIED;
    };

    /**
     * NtReadVirtualMemory's work.
     *
     * @param {number[]} args
     */
    const nativeRead = ([handle, base, buffer, size, read])=>{
        const count = size >>> 0;
        const to = wholeAddress(buffer);
        // No more is asked of a child than the caller has room for.
        const room = count === 0 ? 0 : accessibleSpan(host.pageState, to, count, true);
        return onTarget(handle, PROCESS_VM_READ, ()=>readHere(base >>> 0, to, count, read >>> 0),
            { call: VIRTUAL_READ, args: [base >>> 0, { out: room }, room, { out: 4 }] },
            answer=>{
                const got = new DataView(/** @type {Uint8Array} */ (answer.outs[3])
                    .slice().buffer).getUint32(0, true);
                if (got > 0)
                {
                    host.writeMemory(to, /** @type {Uint8Array} */ (answer.outs[1])
                        .subarray(0, got));
                }
                writeCount(read >>> 0, got);
                return got === count ? STATUS_SUCCESS : STATUS_PARTIAL_COPY;
            });
    };

    /**
     * The write on a target: the caller's bytes as far as they can be read,
     * sent whole.
     *
     * @param {number[]} args @param {number} lift
     */
    const write = ([handle, base, buffer, size, written], lift)=>{
        const count = size >>> 0;
        const bytes = readable(buffer >>> 0, count);
        return onTarget(handle, lift ? PROCESS_VM_WRITE | PROCESS_VM_OPERATION : PROCESS_VM_WRITE,
            ()=>writeHere(base >>> 0, buffer >>> 0, bytes.length, count, lift, written >>> 0),
            { call: VIRTUAL_WRITE, args: [base >>> 0, { in: bytes }, bytes.length, count, lift,
                { out: 4 }] },
            answer=>{
                const status = answer.result >>> 0;
                if (status !== STATUS_ACCESS_VIOLATION)
                {
                    writeCount(written >>> 0, new DataView(/** @type {Uint8Array} */ (
                        answer.outs[5]).slice().buffer).getUint32(0, true));
                }
                return status;
            });
    };

    /**
     * A kernel32 call's answer made of the native's status: TRUE, or FALSE
     * with the error the status is, set on the calling thread whenever the
     * answer comes.
     *
     * @param {number | Promise<number>} status
     */
    const asBool = status=>{
        const thread = host.currentThread?.();
        /** @param {number} value */
        const settle = value=>{
            const code = value === STATUS_SUCCESS ? ERROR_SUCCESS
                : value === STATUS_PARTIAL_COPY ? ERROR_PARTIAL_COPY
                    : value === STATUS_ACCESS_VIOLATION ? ERROR_NOACCESS
                        : value === STATUS_INVALID_HANDLE ? ERROR_INVALID_HANDLE
                            : ERROR_ACCESS_DENIED;
            if (code !== ERROR_SUCCESS)
            {
                if (thread && host.setLastErrorFor && typeof status !== 'number')
                {
                    host.setLastErrorFor(thread, code);
                }
                else
                {
                    host.setLastError(code);
                }
            }
            return code === ERROR_SUCCESS ? 1 : 0;
        };
        return typeof status === 'number' ? settle(status >>> 0)
            : status.then(value=>settle(value >>> 0));
    };

    return {
        /**
         * BOOL ReadProcessMemory(HANDLE hProcess, LPCVOID lpBaseAddress,
         *   LPVOID lpBuffer, SIZE_T nSize, SIZE_T *lpNumberOfBytesRead)
         *
         * The native read; the count it got is written whether or not all of
         * it came (ERROR_PARTIAL_COPY), as a crash handler walking a stack
         * through here needs.
         */
        ReadProcessMemory: {
            argBytes: 20,
            sizes: [3],
            /** @param {number[]} args */
            handler: args=>{
                // Told 0 before anything is tried: a refused handle leaves it
                // so (Wine's process.c test_process_security_attributes).
                writeCount(wholeAddress(args[4]), 0);
                return asBool(nativeRead(args));
            },
        },

        /**
         * BOOL WriteProcessMemory(HANDLE hProcess, LPVOID lpBaseAddress,
         *   LPCVOID lpBuffer, SIZE_T nSize, SIZE_T *lpNumberOfBytesWritten)
         */
        WriteProcessMemory: {
            argBytes: 20,
            sizes: [3],
            /** @param {number[]} args */
            handler: args=>asBool(write(args, 1)),
        },

        [VIRTUAL_MEMORY]: {
            /** @param {number[]} args */
            read: args=>nativeRead(args),
            /** @param {number[]} args */
            write: args=>write(args, 0),
            /**
             * The calls a parent makes in this process (`VIRTUAL_READ`,
             * `VIRTUAL_WRITE`), over its own pages, the buffers in its scratch.
             */
            served: {
                [VIRTUAL_READ]: {
                    /** @param {number[]} args */
                    handler: ([base, buffer, count, read])=>readHere(base >>> 0, buffer >>> 0,
                        count >>> 0, read >>> 0),
                },
                [VIRTUAL_WRITE]: {
                    /** @param {number[]} args */
                    handler: ([base, buffer, have, count, lift, written])=>writeHere(base >>> 0,
                        buffer >>> 0, have >>> 0, count >>> 0, lift, written >>> 0),
                },
            },
        },
    };
}
