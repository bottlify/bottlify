/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Windows 95 family's own kernel32 calls: flat thunks into 16-bit code,
 * the selectors that carry a pointer across, ring-0 handles for a VxD, and
 * the service and handle tricks of a kernel that had no services.
 *
 * None of those things is on this machine -- there is no 16-bit subsystem,
 * no selector table and no VxD -- so each call answers the way it fails when
 * what it reaches for is absent, through the shared refusals: a thunk that
 * cannot connect, a selector that cannot be made, a ring-0 handle that is not
 * there. A program written for both families takes its NT path on that
 * answer, which is the path this machine can run.
 *
 * Two shapes need more than a refusal. The few calls that ask for nothing
 * absent -- making a critical section or a handle global, in a machine where
 * every thread already shares both -- simply succeed. And the selector and
 * thunk helpers the thunk compiler calls are not stdcall at all: they take
 * and give their values in registers and in the caller's EBP frame, so they
 * are guest code here, which a trap could not be -- a trap's own sequence
 * writes the very registers they answer in. Where such a helper refuses, its
 * code saves every register around the trap that reports the refusal.
 */

import { createRefusals } from '../common/refusal.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_CALL_NOT_IMPLEMENTED = 120;

/** The two pseudo-handles: the running process and the running thread. */
const CURRENT_PROCESS = 0xffffffff;
const CURRENT_THREAD = 0xfffffffe;

/**
 * A 16:16 pointer whose selector is zero is its own offset: a null pointer, or
 * an integer resource name, passes through every mapping unchanged, and that
 * is the one mapping this machine can make.
 */
const SELECTOR_MASK = 0xffff0000;

/** The EBP offsets the thunk compiler's mapping helpers come in, one per argument. */
export const MAPPED_ARGUMENTS = [8, 12, 16, 20, 24, 28, 32, 36, 40];
/** And the argument bytes the FT_Exit helpers pop for the thunk's caller. */
export const THUNK_EXITS = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56];

/** What every refusal here says is missing. */
const NO_16_BIT = 'there is no 16-bit subsystem to thunk to or make a selector in';

/**
 * @typedef {Object} Win9xHost
 * @property {(code: number) => void} setLastError
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(handle: number, type?: string) => any} [resolveHandle]
 *     A handle's object, or null or a throw for one that names nothing.
 */

/**
 * What a guest-code export's builder offers (`msvcrt/guest-code.js`).
 *
 * @typedef {import('../msvcrt/guest-code.js').CodeBuilder} CodeBuilder
 */

/** @param {number} value @returns {number[]} */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * Code that reports a refusal and changes no register: every register saved
 * around a call to the trap, which writes several of them -- pushad; call
 * trap; popad. The call's displacement is REPORT_CALL bytes in.
 */
const REPORT = [0x60, 0xe8, 0, 0, 0, 0, 0x61];
const REPORT_CALL = 2;

/**
 * A register-convention helper as guest code that calls the refusal's trap
 * where it refuses: `make` lays the bytes out around one REPORT and says
 * where it put it, and the builder fills in the call.
 *
 * @param {{ argBytes: number, handler: () => number }} refusal
 * @param {(report: number[]) => { bytes: number[], reportAt: number }} make
 */
const helperCode = (refusal, make)=>({
    argBytes: 0,
    handler: refusal.handler,
    /** @param {CodeBuilder} builder */
    code(builder){
        const trap = builder.register({ convention: 'stdcall', argBytes: 0,
            handler: refusal.handler, lastError: false });
        const { bytes, reportAt } = make(REPORT);
        builder.jump(reportAt + REPORT_CALL, trap);
        return new Uint8Array(bytes);
    },
});

/**
 * SMapLS: the pointer in EAX as a 16:16 pointer in EAX, and in EDX the alias
 * SUnMapLS frees -- none here, so zero. A pointer below 64 KiB is answered as
 * itself; any other needs a selector, and the refusal is a null one.
 *
 * @param {number[]} report
 */
export const smapls = report=>{
    const head = [
        0x31, 0xd2,                                          // xor edx, edx
        0xa9, ...dword(SELECTOR_MASK),                       // test eax, 0xffff0000
        0x74, report.length + 2,                             // jz done
    ];
    return {
        bytes: [...head, ...report, 0x31, 0xc0, 0xc3],       // xor eax, eax; done: ret
        reportAt: head.length,
    };
};

/**
 * SMapLS_IP_EBP_n: the same for the argument at [EBP+n], whose slot is then
 * given the alias -- zero -- for SUnMapLS_IP_EBP_n to free.
 *
 * @param {number} offset @returns {(report: number[]) => { bytes: number[], reportAt: number }}
 */
export const smaplsFrame = offset=>report=>{
    const head = [
        0x8b, 0x45, offset,                                  // mov eax, [ebp + n]
        0x31, 0xd2,                                          // xor edx, edx
        0xa9, ...dword(SELECTOR_MASK),                       // test eax, 0xffff0000
        0x74, report.length + 2,                             // jz done
    ];
    return {
        bytes: [...head, ...report,
            0x31, 0xc0,                                      // xor eax, eax
            0x89, 0x55, offset,                              // done: mov [ebp + n], edx
            0xc3],                                           // ret
        reportAt: head.length,
    };
};

/**
 * FT_Thunk: the call into 16-bit code the thunk's frame describes. There is
 * none to make, and the thunk is told so as the 16-bit side answers -- zero
 * in DX:AX.
 *
 * @param {number[]} report
 */
export const ftThunk = report=>({
    bytes: [...report,
        0x31, 0xc0,                                          // xor eax, eax
        0x31, 0xd2,                                          // xor edx, edx
        0xc3],                                               // ret
    reportAt: 0,
});

/**
 * FT_ExitN: the end of a flat thunk, which refuses nothing. FT_Prolog's frame
 * holds the caller's EBX, ESI and EDI just below EBP, and the thunk has moved
 * its answer into EBX: the answer goes back to EAX, the three are restored,
 * the frame is left, and the thunk's own caller gets control with its N bytes
 * of arguments popped.
 *
 * @param {number} pop
 */
export const ftExitCode = pop=>new Uint8Array([
    0x89, 0xd8,                                              // mov eax, ebx
    0x8b, 0x5d, 0xfc,                                        // mov ebx, [ebp - 4]
    0x8b, 0x75, 0xf8,                                        // mov esi, [ebp - 8]
    0x8b, 0x7d, 0xf4,                                        // mov edi, [ebp - 12]
    0xc9,                                                    // leave
    ...pop === 0 ? [0xc3] : [0xc2, pop & 0xff, pop >>> 8],   // ret | ret N
]);

/**
 * SUnMapLS_IP_EBP_n: the alias in the argument's slot freed and the slot
 * cleared. Nothing was ever mapped, so clearing it is all there is; EAX, the
 * thunk's answer by then, is kept.
 *
 * @param {number} offset
 */
export const sunmaplsFrameCode = offset=>new Uint8Array([
    0xc7, 0x45, offset, 0, 0, 0, 0,                          // mov dword [ebp + n], 0
    0xc3,                                                    // ret
]);

/**
 * @param {Win9xHost} host
 */
export function createWin9xFunctions(host){
    const refuse = createRefusals(host);

    /** The 16-bit side's refusals, which set no error of their own. */
    const selector = (/** @type {string} */ name)=>refuse(name, { argBytes: 0, why: NO_16_BIT });

    /** @param {number} handle */
    const isHandle = handle=>{
        if (handle === CURRENT_PROCESS || handle === CURRENT_THREAD)
        {
            return true;
        }
        try
        {
            return Boolean(host.resolveHandle?.(handle));
        }
        catch (e){
            void e;
            return false;
        }
    };

    /** The stdcall mapping calls; small pointers pass, the rest find no selector. */
    const mapLS = refuse('MapLS', { argBytes: 4, why: NO_16_BIT });
    const mapSL = refuse('MapSL', { argBytes: 4, why: NO_16_BIT });
    const mapSLFix = refuse('MapSLFix', { argBytes: 4, why: NO_16_BIT });

    /** @type {Record<string, any>} */
    const table = {
        /**
         * SEGPTR MapLS(LPCVOID ptr), LPVOID MapSL(SEGPTR sptr) and
         * LPVOID MapSLFix(SEGPTR sptr): a pointer with nothing above its low
         * word is the same in both forms; any other has no selector to be
         * made or read, and the answer is null.
         */
        MapLS: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>(((pointer >>> 0) & SELECTOR_MASK) === 0
                ? pointer >>> 0 : mapLS.handler()),
        },
        MapSL: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>(((pointer >>> 0) & SELECTOR_MASK) === 0
                ? pointer >>> 0 : mapSL.handler()),
        },
        MapSLFix: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>(((pointer >>> 0) & SELECTOR_MASK) === 0
                ? pointer >>> 0 : mapSLFix.handler()),
        },
        /** VOID UnMapLS(SEGPTR sptr): nothing was mapped, so nothing is freed. */
        UnMapLS: { argBytes: 4, handler: ()=>0 },

        /**
         * DWORD ThunkConnect32(PVOID pThunkData, LPSTR pszDll16, LPSTR pszDll32,
         *     HINSTANCE hInst32, DWORD dwReason, ...): no 16-bit library to
         * connect to. A thunk library's DllMain fails its load on the zero,
         * which is how its program learns the 16-bit half is not there.
         */
        ThunkConnect32: refuse('ThunkConnect32', {
            argBytes: 24, lastError: ERROR_CALL_NOT_IMPLEMENTED, why: NO_16_BIT,
        }),

        /**
         * DWORD RegisterServiceProcess(DWORD dwProcessId, DWORD dwType): the
         * Windows 95 way to stay alive past a logoff and out of the task
         * list. There is neither here, and the call is refused.
         */
        RegisterServiceProcess: refuse('RegisterServiceProcess', {
            argBytes: 8, lastError: ERROR_CALL_NOT_IMPLEMENTED,
            why: 'there are no Windows 95 services to register as',
        }),

        /** HANDLE OpenVxDHandle(HANDLE hSource): there is no ring 0 to hand a VxD. */
        OpenVxDHandle: refuse('OpenVxDHandle', {
            argBytes: 4, lastError: ERROR_CALL_NOT_IMPLEMENTED,
            why: 'there is no VxD to hand a ring-0 handle to',
        }),

        /** HANDLE CreateSocketHandle(void): Windows 95's socket provider's own. */
        CreateSocketHandle: refuse('CreateSocketHandle', {
            argBytes: 0, lastError: ERROR_CALL_NOT_IMPLEMENTED,
            why: 'socket handles are not made by kernel32 here',
        }),

        /** BOOL SetHandleContext(HANDLE hnd, DWORD context): the same provider's. */
        SetHandleContext: refuse('SetHandleContext', {
            argBytes: 8, lastError: ERROR_CALL_NOT_IMPLEMENTED,
            why: 'socket handles are not made by kernel32 here',
        }),

        /**
         * HANDLE ConvertToGlobalHandle(HANDLE hSrc)
         *
         * On Windows 95 a handle belonged to the process that made it, and
         * this made one every process could use. Every handle in this machine
         * is in the one table every process and thread reaches, so the handle
         * is already that, and comes back as it went in; a handle that names
         * nothing is refused.
         */
        ConvertToGlobalHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!isHandle(handle >>> 0))
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                return handle >>> 0;
            },
        },

        /**
         * VOID MakeCriticalSectionGlobal(LPCRITICAL_SECTION lpcs): a section in
         * the process's own memory, which every thread here already shares.
         */
        MakeCriticalSectionGlobal: { argBytes: 4, handler: ()=>0 },

        /** SMapLS: register convention, so guest code (`smapls`). */
        SMapLS: helperCode(selector('SMapLS'), smapls),

        /** SUnMapLS: the alias in EAX freed -- there is none -- and EAX kept. */
        SUnMapLS: {
            argBytes: 0,
            handler: ()=>0,
            code: ()=>new Uint8Array([0xc3]),
        },

        /** FT_Thunk: register convention and the caller's frame (`ftThunk`). */
        FT_Thunk: helperCode(selector('FT_Thunk'), ftThunk),
    };

    for (const offset of MAPPED_ARGUMENTS)
    {
        const mapped = `SMapLS_IP_EBP_${offset}`;
        table[mapped] = helperCode(selector(mapped), smaplsFrame(offset));
        table[`SUnMapLS_IP_EBP_${offset}`] = {
            argBytes: 0,
            handler: ()=>0,
            code: ()=>sunmaplsFrameCode(offset),
        };
    }
    for (const pop of THUNK_EXITS)
    {
        // Answered only by its code: the frame it leaves is the guest's, and a
        // handler run from the host has no frame to leave.
        table[`FT_Exit${pop}`] = { argBytes: 0, handler: ()=>0, code: ()=>ftExitCode(pop) };
    }
    return table;
}
