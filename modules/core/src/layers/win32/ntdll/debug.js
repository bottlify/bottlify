/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The debugging interface, for a process no debugger can attach to.
 *
 * There is no debug object here and no second process to hold one, so the
 * calls that make, wait on or continue through a debug object answer the
 * way the system answers a handle that is none, attaching is denied, and
 * the system's own debug channel is not implemented. A program asks these
 * to find out whether it is being debugged, or to debug a child; the
 * answers say no, and say it as statuses it tests for.
 *
 * Two calls are real. DbgBreakPoint is the processor's breakpoint -- an
 * `int3` in the library's own code, raised through the same fault path any
 * `int3` in the program takes, so a handler the program installed sees
 * EXCEPTION_BREAKPOINT at an address with a `ret` after it. DbgPrint is
 * formatted and goes where OutputDebugString goes: the run's log.
 */

import { STATUS } from './status.js';
import { createRefusals } from '../common/refusal.js';

/** The processor's breakpoint, as DbgBreakPoint raises it. */
const STATUS_BREAKPOINT = 0x80000003;

/** A process with no debugger attached, asked to have it removed. */
const STATUS_PORT_NOT_SET = 0xc0000353;

/** `int3; ret`: DbgBreakPoint as the system's own library has it. */
const BREAK_CODE = Uint8Array.of(0xcc, 0xc3);

/** The most DbgPrint formats: the system's own buffer. */
const DBG_PRINT_LIMIT = 512;

/** Where the thread block keeps the thread's debug object: DbgSsReserved[1]. */
const TEB_DEBUG_OBJECT = 0xf24;

/** How many argument slots DbgPrint's format is read for. */
const VARIADIC_SLOTS = 32;

/**
 * @typedef {Object} DebugHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {Record<string, { handler: Function } | undefined>} kernel32
 *           RaiseException, OutputDebugStringA.
 * @property {Record<string, { handler: Function } | undefined>} crt  _snprintf.
 * @property {() => number} teb
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => boolean} free
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * @param {DebugHost} host
 */
export function createDebugFunctions(host){
    const refuse = createRefusals({ divergence: host.divergence });
    const why = 'no debugger can attach to this process';

    const refusedCreate = refuse('NtCreateDebugObject',
        { argBytes: 16, answer: STATUS.NOT_IMPLEMENTED, why: 'no debug object can be made' });

    /** The debug object a thread keeps with no thread block to keep it in. */
    let detached = 0;

    /** @param {number} pointer @param {number} value */
    const writeU32 = (pointer, value)=>host.writeMemory(pointer >>> 0, dword(value));

    return {
        /**
         * VOID DbgBreakPoint(void)
         *
         * The handler stands in only where the code is not run: a direct
         * call from the host raises the same exception through
         * RaiseException.
         */
        DbgBreakPoint: {
            argBytes: 0,
            code: ()=>BREAK_CODE,
            handler: ()=>host.kernel32.RaiseException?.handler([STATUS_BREAKPOINT, 0, 0, 0]) ?? 0,
        },

        /**
         * ULONG DbgPrint(PCSTR Format, ...)
         *
         * Formatted as the C runtime formats, cut at the system's 512 bytes,
         * and handed to OutputDebugStringA -- nothing shows, the log has it.
         */
        DbgPrint: {
            convention: 'cdecl',
            argBytes: 4 + VARIADIC_SLOTS * 4,
            /** @param {number[]} args */
            handler: args=>{
                const format = args[0] >>> 0;
                if (format === 0)
                {
                    return STATUS.SUCCESS;
                }
                const print = host.crt._snprintf;
                const say = host.kernel32.OutputDebugStringA;
                const buffer = host.allocate(DBG_PRINT_LIMIT + 1);
                if (!print || !say || buffer === 0)
                {
                    say?.handler([format]);
                    return STATUS.SUCCESS;
                }
                print.handler([buffer, DBG_PRINT_LIMIT, ...args]);
                host.writeMemory(buffer + DBG_PRINT_LIMIT, new Uint8Array(1));
                say.handler([buffer]);
                host.free(buffer);
                return STATUS.SUCCESS;
            },
        },

        /**
         * HANDLE DbgUiGetThreadDebugObject(void)
         * VOID DbgUiSetThreadDebugObject(HANDLE DebugObject)
         *
         * The handle the calling thread keeps in its thread block, where the
         * system keeps it: whatever was set, NULL before anything was.
         */
        DbgUiGetThreadDebugObject: {
            argBytes: 0,
            handler: ()=>{
                const teb = host.teb();
                if (teb === 0)
                {
                    return detached;
                }
                const bytes = host.readMemory(teb + TEB_DEBUG_OBJECT, 4);
                return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
            },
        },

        DbgUiSetThreadDebugObject: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const teb = host.teb();
                if (teb === 0)
                {
                    detached = handle >>> 0;
                }
                else
                {
                    writeU32(teb + TEB_DEBUG_OBJECT, handle);
                }
                return 0;
            },
        },

        /** NTSTATUS DbgUiIssueRemoteBreakin(HANDLE Process) */
        DbgUiIssueRemoteBreakin: refuse('DbgUiIssueRemoteBreakin',
            { argBytes: 4, answer: STATUS.NOT_IMPLEMENTED, why }),

        /**
         * NTSTATUS DbgUiConvertStateChangeStructure(PDBGUI_WAIT_STATE_CHANGE,
         *                                           LPDEBUG_EVENT)
         *
         * Nothing here ever hands out a state change, so whatever is passed
         * is not one: the system's answer for a state it does not know.
         */
        DbgUiConvertStateChangeStructure: refuse('DbgUiConvertStateChangeStructure',
            { argBytes: 8, answer: STATUS.UNSUCCESSFUL, why }),

        /**
         * NTSTATUS NtCreateDebugObject(PHANDLE DebugObjectHandle, ACCESS_MASK,
         *                              POBJECT_ATTRIBUTES, ULONG Flags)
         *
         * No debug object type exists to make one of. The handle is left
         * NULL, so a caller that closes it closes nothing.
         */
        NtCreateDebugObject: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) !== 0)
                {
                    writeU32(out, 0);
                }
                return refusedCreate.handler();
            },
        },

        /** NTSTATUS NtDebugActiveProcess(HANDLE Process, HANDLE DebugObject) */
        NtDebugActiveProcess: refuse('NtDebugActiveProcess',
            { argBytes: 8, answer: STATUS.ACCESS_DENIED, why }),

        /**
         * NTSTATUS NtRemoveProcessDebug(HANDLE Process, HANDLE DebugObject)
         *
         * No process has a debugger to remove: the status for a process
         * with no debug port.
         */
        NtRemoveProcessDebug: refuse('NtRemoveProcessDebug',
            { argBytes: 8, answer: STATUS_PORT_NOT_SET, why }),

        // The calls on a debug object: none can exist, so the handle is none.

        /** NTSTATUS NtDebugContinue(HANDLE DebugObject, PCLIENT_ID, NTSTATUS) */
        NtDebugContinue: refuse('NtDebugContinue',
            { argBytes: 12, answer: STATUS.INVALID_HANDLE, why }),

        /**
         * NTSTATUS NtSetInformationDebugObject(HANDLE DebugObject,
         *   DEBUGOBJECTINFOCLASS, PVOID, ULONG, PULONG)
         */
        NtSetInformationDebugObject: refuse('NtSetInformationDebugObject',
            { argBytes: 20, answer: STATUS.INVALID_HANDLE, why }),

        /**
         * NTSTATUS NtWaitForDebugEvent(HANDLE DebugObject, BOOLEAN Alertable,
         *   PLARGE_INTEGER Timeout, PDBGUI_WAIT_STATE_CHANGE StateChange)
         */
        NtWaitForDebugEvent: refuse('NtWaitForDebugEvent',
            { argBytes: 16, answer: STATUS.INVALID_HANDLE, why }),

        /**
         * NTSTATUS NtSystemDebugControl(SYSDBG_COMMAND, PVOID, ULONG, PVOID, ULONG,
         *                               PULONG)
         *
         * The kernel debugger's own channel, of which there is none.
         */
        NtSystemDebugControl: refuse('NtSystemDebugControl',
            { argBytes: 24, answer: STATUS.NOT_IMPLEMENTED, why: 'there is no kernel debugger' }),
    };
}
