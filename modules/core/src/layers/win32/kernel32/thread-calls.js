/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the loader tells the libraries of a thread: DLL_THREAD_ATTACH before
 * a new thread's start routine runs, DLL_THREAD_DETACH when it ends cleanly.
 *
 * A runtime keeps per-thread state, and this is where it makes and frees it:
 * a C runtime's DllMain allocates the thread's data on the attach and frees it
 * on the detach, and an image's TLS callbacks -- a static runtime's
 * `__dyn_tls_init` -- construct its thread-local objects. A thread nobody was
 * told of runs on state that was never built for it.
 *
 * The calls are made on the thread itself, as Windows makes them, by a few
 * guest instructions every thread shares: a trap answers the list -- each
 * image in load order, its TLS callbacks and then its entry point, the other
 * way round for a detach -- and the routine calls each with (base, reason,
 * NULL). The list is taken when the thread starts, not when it is made: a
 * library loaded between the two is attached to it, as on Windows. Each
 * distinct list is written once into guest memory and kept, so a thread
 * reads one that nobody changes under it.
 *
 * Only one thread is in a library's entry point at a time, the documentation
 * promises, which is the loader lock: the routine holds it across the calls,
 * and the startup stub holds it while it attaches the process's libraries,
 * so a thread made by a DllMain then waits for every library to be attached
 * before it is told of any.
 */

/** DllMain's reasons for a thread. */
export const DLL_THREAD_ATTACH = 2;
export const DLL_THREAD_DETACH = 3;

/** Where the walk starts within the routine; the bytes before it begin a thread. */
export const WALK_OFFSET = 16;
/** The same in an x86-64 process's routine (`longThreadCallsCode`). */
export const LONG_WALK_OFFSET = 48;

/** @param {number} value @returns {number[]} */
const dword = value=>[
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
];

/**
 * @typedef {Object} LoaderLock
 * @property {number} address  The CRITICAL_SECTION.
 * @property {number} enter    EnterCriticalSection, as guest code.
 * @property {number} leave    LeaveCriticalSection.
 */

/**
 * The routine, as x86. A thread begins at `at`, with its stack as the kernel
 * makes it -- the return address, the parameter, and the start routine above
 * them:
 *
 *            push DLL_THREAD_ATTACH
 *            call walk
 *            jmp dword [esp+8]      ; the start routine, its stack as it was made
 *
 *     walk:  push ebx               ; stdcall walk(reason)
 *            push esi
 *            push edi
 *            mov ebx, [esp+16]
 *            push lock
 *            call EnterCriticalSection
 *            push ebx
 *            call calls             ; the trap: EAX = { routine, base }..., 0
 *            mov esi, eax
 *     next:  mov eax, [esi]
 *            test eax, eax
 *            jz done
 *            mov edi, esp
 *            push 0                 ; lpvReserved
 *            push ebx               ; fdwReason
 *            push dword [esi+4]     ; hinstDLL
 *            call eax
 *            mov esp, edi           ; whatever the routine took off
 *            add esi, 8
 *            jmp next
 *     done:  push lock
 *            call LeaveCriticalSection
 *            pop edi
 *            pop esi
 *            pop ebx
 *            ret 4
 *
 * The stack pointer is put back from EDI, which a routine keeps, because a
 * TLS callback or an entry point declared with the wrong convention pops
 * the wrong number of arguments, and one that does must not move every call
 * after it. The lock is left out when there is none to take.
 *
 * @param {{ at: number, trap: number, lock?: LoaderLock | null }} options
 * @returns {Uint8Array}
 */
export function threadCallsCode({ at, trap, lock }){
    const walk = at + WALK_OFFSET;
    const start = [
        0x6a, DLL_THREAD_ATTACH,
        0xe8, ...dword((walk - (at + 7)) | 0),
        0xff, 0x64, 0x24, 0x08,
    ];
    /** @param {number} routine */
    const locked = routine=>(lock
        ? [0x68, ...dword(lock.address), 0xb8, ...dword(routine), 0xff, 0xd0]
        : []);
    const body = [
        0x89, 0xe7,
        0x6a, 0x00,
        0x53,
        0xff, 0x76, 0x04,
        0xff, 0xd0,
        0x89, 0xfc,
        0x83, 0xc6, 0x08,
    ];
    const test = [0x8b, 0x06, 0x85, 0xc0, 0x74, body.length + 2];
    const back = -(test.length + body.length + 2);
    return new Uint8Array([
        ...start,
        ...new Array(WALK_OFFSET - start.length).fill(0xcc),
        0x53, 0x56, 0x57,
        0x8b, 0x5c, 0x24, 0x10,
        ...locked(lock?.enter ?? 0),
        0x53,
        0xb8, ...dword(trap),
        0xff, 0xd0,
        0x89, 0xc6,
        ...test,
        ...body,
        0xeb, back & 0xff,
        ...locked(lock?.leave ?? 0),
        0x5f, 0x5e, 0x5b,
        0xc2, 0x04, 0x00,
    ]);
}

/**
 * The routine for an x86-64 process, in its convention: a thread begins at
 * `at` as a function is entered, RSP eight past a multiple of 16 with the
 * return address there and the 32 bytes of home space above it, its
 * parameter in RCX and its start routine in RDX (the kernel's x64 frame).
 * Each call is made with RSP a multiple of 16 and home space below the
 * callee's return address, and the routines' (base, reason, NULL) go in RCX,
 * EDX and R8. RBX, RSI and RDI are the callee's to keep, so the walk keeps
 * them:
 *
 *            mov [rsp+8], rcx       ; the parameter and the start routine,
 *            mov [rsp+16], rdx      ; into the home space they came with
 *            sub rsp, 40
 *            mov ecx, DLL_THREAD_ATTACH
 *            call walk
 *            add rsp, 40
 *            mov rcx, [rsp+8]
 *            jmp qword [rsp+16]     ; the start routine, as the thread began
 *
 *     walk:  push rbx               ; walk(reason in ECX)
 *            push rsi
 *            push rdi
 *            sub rsp, 32
 *            mov ebx, ecx
 *            mov ecx, lock
 *            call EnterCriticalSection
 *            mov ecx, ebx
 *            call calls             ; the trap: RAX = { routine, base }..., 0
 *            mov rsi, rax
 *     next:  mov eax, [rsi]
 *            test eax, eax
 *            jz done
 *            mov ecx, [rsi+4]       ; hinstDLL
 *            mov edx, ebx           ; fdwReason
 *            xor r8d, r8d           ; lpvReserved
 *            mov rdi, rsp
 *            call rax
 *            mov rsp, rdi
 *            add rsi, 8
 *            jmp next
 *     done:  mov ecx, lock
 *            call LeaveCriticalSection
 *            add rsp, 32
 *            pop rdi
 *            pop rsi
 *            pop rbx
 *            ret
 *
 * Every address lies below 4 GiB, so the list keeps its dwords and a 32-bit
 * move of one zero-extends it whole.
 *
 * @param {{ at: number, trap: number, lock?: LoaderLock | null }} options
 * @returns {Uint8Array}
 */
export function longThreadCallsCode({ at, trap, lock }){
    const walk = at + LONG_WALK_OFFSET;
    const start = [
        0x48, 0x89, 0x4c, 0x24, 0x08,
        0x48, 0x89, 0x54, 0x24, 0x10,
        0x48, 0x83, 0xec, 0x28,
        0xb9, ...dword(DLL_THREAD_ATTACH),
        0xe8, ...dword((walk - (at + 24)) | 0),
        0x48, 0x83, 0xc4, 0x28,
        0x48, 0x8b, 0x4c, 0x24, 0x08,
        0xff, 0x64, 0x24, 0x10,
    ];
    /** @param {number} routine */
    const call = routine=>[0xb8, ...dword(routine), 0xff, 0xd0];
    /** @param {number} routine */
    const locked = routine=>(lock ? [0xb9, ...dword(lock.address), ...call(routine)] : []);
    const body = [
        0x8b, 0x4e, 0x04,
        0x89, 0xda,
        0x45, 0x31, 0xc0,
        0x48, 0x89, 0xe7,
        0xff, 0xd0,
        0x48, 0x89, 0xfc,
        0x48, 0x83, 0xc6, 0x08,
    ];
    const test = [0x8b, 0x06, 0x85, 0xc0, 0x74, body.length + 2];
    const back = -(test.length + body.length + 2);
    return new Uint8Array([
        ...start,
        ...new Array(LONG_WALK_OFFSET - start.length).fill(0xcc),
        0x53, 0x56, 0x57,
        0x48, 0x83, 0xec, 0x20,
        0x89, 0xcb,
        ...locked(lock?.enter ?? 0),
        0x89, 0xd9,
        ...call(trap),
        0x48, 0x89, 0xc6,
        ...test,
        ...body,
        0xeb, back & 0xff,
        ...locked(lock?.leave ?? 0),
        0x48, 0x83, 0xc4, 0x20,
        0x5f, 0x5e, 0x5b,
        0xc3,
    ]);
}

/**
 * An image whose routines a thread's start and end are told of.
 *
 * @typedef {Object} ThreadCallImage
 * @property {number} base
 * @property {number[]} routines  Its TLS callbacks, then its entry point.
 */

/**
 * @typedef {Object} ThreadCallsHost
 * @property {(name: string, fn: any) => number} register
 * @property {(bytes: number) => number} allocateCode
 * @property {(bytes: number) => number} allocate
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => ThreadCallImage[]} images
 *           In load order, only those a thread is told of now.
 * @property {() => LoaderLock | null} [loaderLock]
 * @property {boolean} [long]  The process is an x86-64 one (`longThreadCallsCode`).
 */

/**
 * @param {ThreadCallsHost} host
 */
export function createThreadCalls(host){
    /** Where the routine is, once placed; zero before, and when it could not be. */
    let routine = 0;
    const code = host.long ? longThreadCallsCode : threadCallsCode;
    const walkOffset = host.long ? LONG_WALK_OFFSET : WALK_OFFSET;
    let placing = true;
    /** Every distinct list written, by its routines and bases. @type {Map<string, number>} */
    const tables = new Map();
    const told = { attaches: 0, detaches: 0 };

    /**
     * The list's address in guest memory, written the first time it is asked
     * for; zero when there is no room for it.
     *
     * @param {number[][]} pairs  [routine, base] each.
     */
    const tableOf = pairs=>{
        const key = pairs.flat().join(',');
        let at = tables.get(key);
        if (at === undefined)
        {
            const bytes = new Uint8Array(pairs.length * 8 + 4);
            const view = new DataView(bytes.buffer);
            pairs.forEach(([each, base], index)=>{
                view.setUint32(index * 8, each, true);
                view.setUint32(index * 8 + 4, base, true);
            });
            at = host.allocate(bytes.length);
            if (at === 0)
            {
                return 0;
            }
            host.writeMemory(at, bytes);
            tables.set(key, at);
        }
        return at;
    };

    /** @param {number} reason */
    const calls = reason=>{
        const images = host.images();
        const ordered = reason === DLL_THREAD_DETACH ? [...images].reverse() : images;
        if (reason === DLL_THREAD_DETACH)
        {
            told.detaches++;
        }
        else
        {
            told.attaches++;
        }
        // Nobody told, rather than a list read from address zero.
        return tableOf(ordered.flatMap(image=>
            image.routines.map(each=>[each >>> 0, image.base >>> 0]))) || tableOf([]);
    };

    const place = ()=>{
        if (!placing)
        {
            return routine;
        }
        placing = false;
        const trap = host.register('<thread-calls>', {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([reason])=>calls(reason >>> 0),
        });
        const lock = host.loaderLock?.() ?? null;
        const size = code({ at: 0, trap: 0, lock }).length;
        // The empty list made now, so that a later one with no room has it to fall back on.
        const at = trap === 0 || tableOf([]) === 0 ? 0 : host.allocateCode(size);
        if (at !== 0)
        {
            host.writeMemory(at, code({ at, trap, lock }));
            routine = at;
        }
        return routine;
    };

    return {
        /** Where a thread begins: the libraries told, then its start routine. Zero when there is nowhere. */
        start: ()=>place(),
        /** walk(reason), stdcall, for a thread's end. Zero when there is nowhere. */
        walk: ()=>(place() === 0 ? 0 : routine + walkOffset),
        /** Whether a thread ending now has anybody to tell. */
        pending: ()=>host.images().some(image=>image.routines.length > 0),
        diagnostics: ()=>({ tables: tables.size, ...told }),
    };
}
