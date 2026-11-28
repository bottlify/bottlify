/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The debugging interface's own calls: the thread's debug object in its
 * thread block, the breakpoint and the debug print.
 *
 * The debug objects themselves - made, set, attached through, waited on,
 * continued through, removed, and the state changes DbgUi converts - are
 * kernel32's (`kernel32/debug-events.js`, published as natives), one with
 * its debuggers' and debuggees' records. The system's own debug channel is
 * not implemented.
 *
 * Two calls are real. DbgBreakPoint is the processor's breakpoint -- an
 * `int3` in the library's own code, raised through the same fault path any
 * `int3` in the program takes, so a handler the program installed sees
 * EXCEPTION_BREAKPOINT at an address with a `ret` after it. DbgPrint is
 * formatted and goes where OutputDebugString goes: the run's log.
 */

import { STATUS } from './status.js';
import { createRefusals } from '../common/refusal.js';
import { TEB } from '../kernel32/teb.js';
import { wholeAddress } from '../common/pointers.js';

/** The processor's breakpoint, as DbgBreakPoint raises it. */
const STATUS_BREAKPOINT = 0x80000003;

/** `int3; ret`: DbgBreakPoint as the system's own library has it. */
const BREAK_CODE = Uint8Array.of(0xcc, 0xc3);

/**
 * DbgUiRemoteBreakin in i386: when the process block says the process is
 * debugged, an exception frame is pushed whose handler resumes after the
 * call with the frame's stack, DbgBreakPoint (its address from a trap) is
 * called, the frame comes off, and the routine returns 0 to the thread's
 * start, which ends the thread. The handler declines an unwind and takes
 * every exception: Eip and Esp of the context it is handed set to the
 * resume point and the frame, ExceptionContinueExecution.
 */
const REMOTE_BREAKIN = Uint8Array.of(
    0x64, 0xa1, 0x30, 0x00, 0x00, 0x00,         // 0   mov eax, fs:[30h]
    0x80, 0x78, 0x02, 0x00,                     // 6   cmp byte [eax+2], 0 (BeingDebugged)
    0x74, 0x2e,                                 // 10  je end
    0xe8, 0x00, 0x00, 0x00, 0x00,               // 12  call here
    0x58,                                       // 17  here: pop eax
    0x8d, 0x80, 0x00, 0x00, 0x00, 0x00,         // 18  lea eax, [eax + handler - here]
    0x50,                                       // 24  push eax
    0x64, 0xff, 0x35, 0x00, 0x00, 0x00, 0x00,   // 25  push dword fs:[0]
    0x64, 0x89, 0x25, 0x00, 0x00, 0x00, 0x00,   // 32  mov fs:[0], esp
    0xe8, 0x00, 0x00, 0x00, 0x00,               // 39  call <DbgBreakPoint's address>
    0xff, 0xd0,                                 // 44  call eax
    0x8b, 0x04, 0x24,                           // 46  resume: mov eax, [esp]
    0x64, 0xa3, 0x00, 0x00, 0x00, 0x00,         // 49  mov fs:[0], eax
    0x83, 0xc4, 0x08,                           // 55  add esp, 8
    0x31, 0xc0,                                 // 58  end: xor eax, eax
    0xc2, 0x04, 0x00,                           // 60  ret 4
    0x8b, 0x44, 0x24, 0x04,                     // 63  handler: mov eax, [esp+4] (record)
    0xf6, 0x40, 0x04, 0x06,                     // 67  test byte [eax+4], 6 (unwinding)
    0x75, 0x23,                                 // 71  jnz decline
    0x8b, 0x44, 0x24, 0x0c,                     // 73  mov eax, [esp+12] (context)
    0x8b, 0x4c, 0x24, 0x08,                     // 77  mov ecx, [esp+8] (frame)
    0x89, 0x88, 0xc4, 0x00, 0x00, 0x00,         // 81  mov [eax+Esp], ecx
    0xe8, 0x00, 0x00, 0x00, 0x00,               // 87  call there
    0x5a,                                       // 92  there: pop edx
    0x8d, 0x92, 0x00, 0x00, 0x00, 0x00,         // 93  lea edx, [edx + resume - there]
    0x89, 0x90, 0xb8, 0x00, 0x00, 0x00,         // 99  mov [eax+Eip], edx
    0x31, 0xc0,                                 // 105 xor eax, eax (ContinueExecution)
    0xc3,                                       // 107 ret
    0xb8, 0x01, 0x00, 0x00, 0x00,               // 108 decline: mov eax, 1 (ContinueSearch)
    0xc3);                                      // 113 ret
const REMOTE_BREAKIN_HANDLER_AT = 20;
const REMOTE_BREAKIN_HANDLER_FROM = 63 - 17;
const REMOTE_BREAKIN_CALL_AT = 40;
const REMOTE_BREAKIN_RESUME_AT = 95;
const REMOTE_BREAKIN_RESUME_FROM = 46 - 92;

/** The most DbgPrint formats: the system's own buffer. */
const DBG_PRINT_LIMIT = 512;

/** How many argument slots DbgPrint's format is read for. */
const VARIADIC_SLOTS = 32;

/**
 * @typedef {Object} DebugHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {Record<string, { handler: Function } | undefined>} kernel32
 *           RaiseException, OutputDebugStringA.
 * @property {Record<string, { handler: Function } | undefined>} crt  _snprintf.
 * @property {() => number} teb
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => boolean} free
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {() => number} [breakPoint]  DbgBreakPoint's address, which
 *           DbgUiRemoteBreakin calls.
 */

/**
 * @param {DebugHost} host
 */
export function createDebugFunctions(host){
    const { guest } = host;
    const refuse = createRefusals({ divergence: host.divergence });
    const why = 'no debugger can attach to this process';

    /** The debug object a thread keeps with no thread block to keep it in. */
    let detached = 0;

    /**
     * The argument slots a va_list points at, as many as DbgPrint reads.
     *
     * @param {number} list
     * @returns {number[]}
     */
    const slots = list=>{
        if ((list >>> 0) === 0)
        {
            return [];
        }
        return Array.from({ length: VARIADIC_SLOTS }, (_, at)=>guest.u32(wholeAddress(list)
            + at * 4));
    };

    /** @type {Record<string, any>} */
    const functions = {
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
                const format = wholeAddress(args[0]);
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
                guest.set8(buffer + DBG_PRINT_LIMIT, 0);
                say.handler([buffer]);
                host.free(buffer);
                return STATUS.SUCCESS;
            },
        },

        /**
         * ULONG DbgPrintEx(ULONG ComponentId, ULONG Level, PCSTR Format, ...)
         *
         * DbgPrint's message, whatever component and level it is filed under:
         * the log keeps them all, as a debugger asking for all would.
         */
        DbgPrintEx: {
            convention: 'cdecl',
            argBytes: 12 + VARIADIC_SLOTS * 4,
            /** @param {number[]} args */
            handler: args=>functions.DbgPrint.handler(args.slice(2)),
        },

        /**
         * ULONG vDbgPrintEx(ULONG ComponentId, ULONG Level, PCCH Format, va_list)
         *
         * DbgPrintEx with its arguments where the va_list points.
         */
        vDbgPrintEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, , format, list])=>functions.DbgPrint.handler([format, ...slots(list)]),
        },

        /**
         * ULONG vDbgPrintExWithPrefix(PCCH Prefix, ULONG ComponentId, ULONG Level,
         *   PCCH Format, va_list)
         *
         * The prefix, then the message, as one line.
         */
        vDbgPrintExWithPrefix: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([prefix, , , format, list])=>{
                const lead =
                    wholeAddress(prefix) === 0 ? '' : host.readCString(wholeAddress(prefix),
                        DBG_PRINT_LIMIT);
                const print = host.crt._snprintf;
                const say = host.kernel32.OutputDebugStringA;
                const buffer = host.allocate(DBG_PRINT_LIMIT + 1);
                if (!print || !say || buffer === 0 || wholeAddress(format) === 0)
                {
                    return STATUS.SUCCESS;
                }
                const head = Uint8Array.from([...lead].map(ch=>ch.charCodeAt(0) & 0xff))
                    .subarray(0, DBG_PRINT_LIMIT);
                guest.setBytes(buffer, head);
                print.handler([buffer + head.length, DBG_PRINT_LIMIT - head.length, format,
                    ...slots(list)]);
                guest.set8(buffer + DBG_PRINT_LIMIT, 0);
                say.handler([buffer]);
                host.free(buffer);
                return STATUS.SUCCESS;
            },
        },

        /**
         * ULONG DbgPrompt(PCCH Prompt, PCH Response, ULONG MaximumResponseLength)
         *
         * The prompt said, and no answer: no debugger is attached to type one,
         * so the response is empty and its length 0.
         */
        DbgPrompt: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([prompt, response, most])=>{
                if (wholeAddress(prompt) !== 0)
                {
                    host.kernel32.OutputDebugStringA?.handler([prompt]);
                }
                if (wholeAddress(response) !== 0 && (most >>> 0) !== 0)
                {
                    guest.set8(wholeAddress(response), 0);
                }
                return 0;
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
                return guest.u32(teb + TEB.DEBUG_OBJECT);
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
                    guest.set32(teb + TEB.DEBUG_OBJECT, handle);
                }
                return 0;
            },
        },

        /**
         * VOID DbgUiRemoteBreakin(PVOID Context)
         *
         * The routine a debugger's break-in thread runs: DbgBreakPoint when
         * the process is debugged, inside a frame that takes whatever it
         * raises - so a debugger that declines the breakpoint
         * (DBG_EXCEPTION_NOT_HANDLED) sees the thread end, not the process
         * die of it - then the thread's end (`REMOTE_BREAKIN`). A 64-bit
         * process runs the breakpoint alone.
         */
        DbgUiRemoteBreakin: {
            argBytes: 4,
            code: (/** @type {import('../msvcrt/guest-code.js').CodeBuilder} */ builder)=>{
                const code = REMOTE_BREAKIN.slice();
                const view = new DataView(code.buffer);
                view.setInt32(REMOTE_BREAKIN_HANDLER_AT, REMOTE_BREAKIN_HANDLER_FROM, true);
                view.setInt32(REMOTE_BREAKIN_RESUME_AT, REMOTE_BREAKIN_RESUME_FROM, true);
                builder?.jump(REMOTE_BREAKIN_CALL_AT, builder.register({ convention: 'stdcall',
                    argBytes: 0, handler: ()=>host.breakPoint?.() ?? 0 }));
                return code;
            },
            handler: ()=>host.kernel32.RaiseException?.handler([STATUS_BREAKPOINT, 0, 0, 0]) ?? 0,
        },

        /** NTSTATUS DbgUiIssueRemoteBreakin(HANDLE Process) */
        DbgUiIssueRemoteBreakin: refuse('DbgUiIssueRemoteBreakin',
            { argBytes: 4, answer: STATUS.NOT_IMPLEMENTED, why }),

        /**
         * NTSTATUS NtSystemDebugControl(SYSDBG_COMMAND, PVOID, ULONG, PVOID, ULONG,
         *                               PULONG)
         *
         * The kernel debugger's own channel, of which there is none.
         */
        NtSystemDebugControl: refuse('NtSystemDebugControl',
            { argBytes: 24, answer: STATUS.NOT_IMPLEMENTED, why: 'there is no kernel debugger' }),
    };
    return functions;
}
