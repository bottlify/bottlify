/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */


import { TEB } from './teb.js';
import { setCondition, verifyVersion, windowsVersion } from './versions.js';

/**
 * The kernel32 surface a program touches before it does anything interesting:
 * the last-error slot, thread-local storage, and the small queries about the
 * process, the version and the clock.
 *
 * The last error and the TLS slots are per thread. That is not an
 * implementation detail but the entire point of both: one shared slot works
 * perfectly until a second thread exists, and then produces failures that
 * belong to somebody else. Both live on the record the kernel keeps for the
 * running thread, whose lifetime is exactly right for them.
 *
 * Time comes from the host's clock rather than from the wall, because the
 * guest's clock is virtual and somebody else owns how fast it runs.
 */

/** Error codes this file can produce. */
const ERROR_SUCCESS = 0;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_MOD_NOT_FOUND = 126;
const ERROR_BAD_ARGUMENTS = 160;
const ERROR_OLD_WIN_VERSION = 1150;

/** What TlsAlloc returns when every slot is taken. */
const TLS_OUT_OF_INDEXES = 0xffffffff;

/**
 * How many slots exist. Windows 2000 and later publish 1088; the guaranteed
 * minimum is 64, which a program written against TLS_MINIMUM_AVAILABLE may
 * assume but no program can be harmed by exceeding.
 */
export const TLS_SLOTS = 1088;

/**
 * How many of those live in the block a program can reach through FS.
 *
 * The compiler does not call TlsGetValue. `__declspec(thread) x` becomes
 * `mov eax, _tls_index / mov ecx, fs:[0x2c] / mov eax, [ecx+eax*4]` -- it
 * reads the array directly. So a slot in this range has two readers, the API
 * and that sequence, and they have to see the same value; a slot above it has
 * only the API, which is why Windows keeps the rest in an expansion block
 * reached another way.
 */
const TLS_SLOTS_IN_BLOCK = 64;

/**
 * The default Windows's numbers, for what reads a version without a process
 * to ask; a process answers the one its bottle chose (`versions.js`).
 */
const DEFAULT_VERSION = windowsVersion();
export const VERSION_MAJOR = DEFAULT_VERSION.major;
export const VERSION_MINOR = DEFAULT_VERSION.minor;
export const VERSION_BUILD = DEFAULT_VERSION.build;

/**
 * OSVERSIONINFO and OSVERSIONINFOEX in each spelling: the two sizes a caller
 * may declare, and where the extended fields start, past a szCSDVersion of 128
 * characters at offset 20.
 */
const OSVERSIONINFO_A = Object.freeze({ SIZE: 148, EX_SIZE: 156, EXTENDED: 148 });
const OSVERSIONINFO_W = Object.freeze({ SIZE: 276, EX_SIZE: 284, EXTENDED: 276 });
const CSD_VERSION = 20;

/** The pseudo-handle GetCurrentProcess returns; it is -1 on every Windows. */
const CURRENT_PROCESS = 0xffffffff;

/**
 * Ticks per second for the performance counter. One megahertz: fine enough to
 * time a frame, coarse enough that the counter stays exact in a double for
 * longer than any process runs.
 */
const PERFORMANCE_FREQUENCY = 1_000_000n;

/**
 * Byte offsets within the block the clock routines read.
 *
 * A program times its own frames, and it times them by asking the machine
 * what time it is hundreds of times a second -- for a number the engine
 * already knows and nothing in the guest can change. So the number is written
 * where the guest can read it, and reading it is what the clock exports do.
 */
export const CLOCK = {
    /** The performance counter, 64-bit, in PERFORMANCE_FREQUENCY ticks. */
    COUNTER: 0,
    /** Milliseconds since boot, as GetTickCount and timeGetTime answer it. */
    TICKS: 8,
    SIZE: 12,
};

/**
 * The block takes a page of its own, and the reason is the emulator's: the
 * engine writes the block whenever the guest's clock moves, and a write into
 * a page holding compiled code makes the emulator discard everything compiled
 * for that page -- so a block sharing a page with the routines above would
 * have every credit throw them away and run them interpreted after.
 */
const PAGE = 4096;

/** Milliseconds between the FILETIME epoch (1601-01-01) and the Unix one. */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;

/** Nothing sensible names a module beyond MAX_PATH. */
const MAX_MODULE_NAME = 260;
/** The one priority a process runs at here. */
const NORMAL_PRIORITY_CLASS = 0x20;

/**
 * @typedef {Object} ProcessHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {() => any} currentThread     The record per-thread state hangs on.
 * @property {() => number} now            Guest milliseconds since boot.
 * @property {() => number} systemTimeMs   Guest wall clock, milliseconds since 1970.
 * @property {(name: string | null) => number} moduleHandle
 *           The base of a loaded module, or 0; null asks for the running image.
 * @property {(milliseconds: number) => void} sleep
 * @property {() => any} park  The token that says the caller has been stopped.
 * @property {() => number} [tlsBlock]  The running thread's array of TLS slots,
 *           as the compiler reaches it through FS; zero when there is none.
 *           Records that the guest asked to wait. Actually waiting is the scheduler's.
 * @property {() => any[]} [allThreads]  Every thread, for what has to reach all
 *           of their blocks.
 * @property {(bytes: number) => number} [allocate]
 * @property {(bytes: number) => number} [allocateCode]  pages of their own for the fast
 *           paths' code (`code-arena.js`), where a store beside it cannot invalidate it
 *           Guest memory the processor executes, for the fast paths.
 * @property {(refresh: () => void) => void} [publishClock]
 *           Handed a function that copies the guest's clock into a block in
 *           guest memory, to be called whenever that clock moves and before
 *           the guest runs again. Without it the clocks stay traps: a block
 *           nobody refreshes would freeze a program's notion of time.
 * @property {number} [processId]
 * @property {import('./versions.js').WindowsVersion} [version]
 *           The Windows a program is told it runs on, by GetVersion,
 *           GetVersionEx and VerifyVersionInfo alike. Absent, the default.
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *           Where an answer wider than EAX puts its high half. Absent, the
 *           functions that answer 64 bits are not exported.
 */

/**
 * The per-thread kernel32 state: the last-error slot and the TLS values.
 *
 * Extracted so everything that writes an error code writes the same record.
 * Two places building this shape independently is how one of them ends up
 * setting an error nothing ever reads.
 *
 * The last error of a thread with a block lives in the block, at the offset
 * the compiler and the guest-side GetLastError read it from; a thread without
 * one (a test's) keeps it here.
 *
 * @param {() => any} currentThread
 * @param {{ readU32: (address: number) => number,
 *           writeU32: (address: number, value: number) => void } | null} [memory]
 */
export function createThreadState(currentThread, memory = null){
    /**
     * @param {any} [thread]  Whose state. Defaults to the thread that is running.
     *   Naming one is for an answer produced on somebody else's turn: a call
     *   that parked has no turn of its own left in which to record its result.
     */
    const stateOf = (thread = currentThread())=>{
        if (!thread.kernel32)
        {
            thread.kernel32 = {
                lastError: ERROR_SUCCESS,
                /** @type {Map<number, { generation: number, value: number }>} */
                tls: new Map(),
            };
        }
        return thread.kernel32;
    };

    /** @param {any} thread */
    const blockOf = thread=>(memory ? (thread?.tebAddress ?? 0) : 0);

    /** @param {any} thread @param {number} code */
    const setErrorOn = (thread, code)=>{
        const teb = blockOf(thread);
        if (teb !== 0 && memory)
        {
            memory.writeU32(teb + TEB.LAST_ERROR, code >>> 0);
        }
        else
        {
            stateOf(thread).lastError = code >>> 0;
        }
    };

    /** @param {any} [thread] */
    const lastErrorOf = (thread = currentThread())=>{
        const teb = blockOf(thread);
        return teb !== 0 && memory
            ? memory.readU32(teb + TEB.LAST_ERROR)
            : stateOf(thread).lastError;
    };

    return {
        stateOf,
        lastErrorOf,
        setErrorOn,
        /** @param {number} code */
        setError: code=>setErrorOn(currentThread(), code),
    };
}

/** @param {number} value */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * GetLastError as guest code: the block's field, through FS. Measured on a
 * title in a match, it and SetLastError, TlsGetValue and FlsGetValue were
 * four calls in five the program made into the host, each a crossing that
 * cost more than the work.
 */
export function getLastErrorCode(){
    return new Uint8Array([
        0x64, 0xa1, ...dword(TEB.LAST_ERROR),                        // mov eax, fs:[0x34]
        0xc3,                                                        // ret
    ]);
}

/** SetLastError as guest code. */
export function setLastErrorCode(){
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x04,                                      // mov eax, [esp+4]
        0x64, 0xa3, ...dword(TEB.LAST_ERROR),                        // mov fs:[0x34], eax
        0xc2, 0x04, 0x00,                                            // ret 4
    ]);
}

/**
 * TlsGetValue as guest code: a slot of the block's array, and success clears
 * the error, as the host does. An index past the array goes to the host,
 * which answers for it; a slot nobody allocated reads as whatever it holds,
 * as it does on Windows.
 *
 * @param {number} at    Where the code lands, for the jump to the trap.
 * @param {number} trap  The host's TlsGetValue.
 */
export function tlsGetValueCode(at, trap){
    const slow = 33;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x04,                                      // mov eax, [esp+4]
        0x83, 0xf8, TLS_SLOTS_IN_BLOCK,                              // cmp eax, 64
        0x73, slow - 9,                                              // jae slow
        0x64, 0xc7, 0x05, ...dword(TEB.LAST_ERROR), ...dword(0),     // mov dword fs:[0x34], 0
        0x64, 0x8b, 0x0d, ...dword(TEB.TLS_POINTER),                 // mov ecx, fs:[0x2c]
        0x8b, 0x04, 0x81,                                            // mov eax, [ecx+eax*4]
        0xc2, 0x04, 0x00,                                            // ret 4
        // slow:
        0xe9, ...dword(trap - (at + slow + 5)),                      // jmp trap
    ]);
}

/**
 * TlsSetValue as guest code: the value into a slot of the block. An index past
 * the array goes to the host, which keeps the rest.
 *
 * A slot in the array is written whether or not anybody allocated it, and
 * success leaves the last error alone, as on Windows: the array is the
 * thread's own, and what keeps a freed slot's old value -- or one set in it
 * while it was free -- from its next tenant is TlsFree and TlsAlloc clearing
 * that slot in every thread's array.
 *
 * @param {number} at    Where the code lands, for the jump to the trap.
 * @param {number} trap  The host's TlsSetValue.
 */
export function tlsSetValueCode(at, trap){
    const slow = 31;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x04,                                      // mov eax, [esp+4]
        0x83, 0xf8, TLS_SLOTS_IN_BLOCK,                              // cmp eax, 64
        0x73, slow - 9,                                              // jae slow
        0x64, 0x8b, 0x0d, ...dword(TEB.TLS_POINTER),                 // mov ecx, fs:[0x2c]
        0x8b, 0x54, 0x24, 0x08,                                      // mov edx, [esp+8]
        0x89, 0x14, 0x81,                                            // mov [ecx+eax*4], edx
        0xb8, ...dword(1),                                           // mov eax, 1
        0xc2, 0x08, 0x00,                                            // ret 8
        // slow:
        0xe9, ...dword(trap - (at + slow + 5)),                      // jmp trap
    ]);
}

/**
 * QueryPerformanceCounter as guest code: the two words of the block, copied
 * into the caller's LARGE_INTEGER.
 *
 * The answer is the one the host would have given, not an approximation of
 * it: the guest's clock does not move while the guest is running -- it is
 * credited between slices -- so the block holds exactly what a trap taken
 * here would have read.
 *
 *     mov ecx, [esp+4]
 *     test ecx, ecx
 *     jz slow                     ; a null pointer is the host's, as before
 *     mov eax, [block]
 *     mov edx, [block+4]
 *     mov [ecx], eax
 *     mov [ecx+4], edx
 *     mov eax, 1
 *     ret 4
 *   slow:
 *     jmp trap
 *
 * @param {number} at     Where the code lands, for the jump to the trap.
 * @param {number} trap   The host's QueryPerformanceCounter.
 * @param {number} block  The clock block.
 */
export function queryPerformanceCounterCode(at, trap, block){
    const slow = 32;
    return new Uint8Array([
        0x8b, 0x4c, 0x24, 0x04,                                      // mov ecx, [esp+4]
        0x85, 0xc9,                                                  // test ecx, ecx
        0x74, slow - 8,                                              // jz slow
        0xa1, ...dword(block + CLOCK.COUNTER),                       // mov eax, [block]
        0x8b, 0x15, ...dword(block + CLOCK.COUNTER + 4),             // mov edx, [block+4]
        0x89, 0x01,                                                  // mov [ecx], eax
        0x89, 0x51, 0x04,                                            // mov [ecx+4], edx
        0xb8, ...dword(1),                                           // mov eax, 1
        0xc2, 0x04, 0x00,                                            // ret 4
        // slow:
        0xe9, ...dword(trap - (at + slow + 5)),                      // jmp trap
    ]);
}

/**
 * QueryPerformanceFrequency as guest code. The frequency is a constant of
 * this machine, so it is an immediate rather than a word of the block.
 *
 * @param {number} at @param {number} trap
 */
export function queryPerformanceFrequencyCode(at, trap){
    const slow = 29;
    return new Uint8Array([
        0x8b, 0x4c, 0x24, 0x04,                                      // mov ecx, [esp+4]
        0x85, 0xc9,                                                  // test ecx, ecx
        0x74, slow - 8,                                              // jz slow
        0xc7, 0x01, ...dword(Number(PERFORMANCE_FREQUENCY)),         // mov dword [ecx], 1000000
        0xc7, 0x41, 0x04, ...dword(0),                               // mov dword [ecx+4], 0
        0xb8, ...dword(1),                                           // mov eax, 1
        0xc2, 0x04, 0x00,                                            // ret 4
        // slow:
        0xe9, ...dword(trap - (at + slow + 5)),                      // jmp trap
    ]);
}

/**
 * GetTickCount as guest code -- and WINMM's timeGetTime, bound to the same
 * routine (`win32/module.js`), which answers the same milliseconds. Neither
 * takes an argument and neither can fail, so there is no case left for the
 * host and no trap to leave for.
 *
 * @param {number} block
 */
export function tickCountCode(block){
    return new Uint8Array([
        0xa1, ...dword(block + CLOCK.TICKS),                         // mov eax, [block+8]
        0xc3,                                                        // ret
    ]);
}

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * All of these are stdcall, which is the bridge's default, so none of them says
 * so. `argBytes` is the size of the argument list the guest compiled against.
 *
 * @param {ProcessHost} host
 */
export function createProcessFunctions(host){
    /**
     * Slot bookkeeping is process-wide, the values in them are not.
     *
     * A slot holds a generation rather than a boolean: an index is reused after
     * TlsFree, and a thread that never touched the new slot must read zero
     * rather than whatever it left in the old one. Comparing generations makes
     * a stale value unreachable without having to walk every thread on TlsAlloc.
     *
     * @type {(number | null)[]}
     */
    const slots = new Array(TLS_SLOTS).fill(null);
    let generation = 0;

    const memory = {
        /** @param {number} address */
        readU32: address=>{
            const bytes = host.readMemory(address, 4);
            return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
        },
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>host.writeMemory(address, new Uint8Array(dword(value))),
    };
    const { stateOf, setError, lastErrorOf } = createThreadState(host.currentThread, memory);

    /**
     * GetModuleHandle's answer for a name already read, null for the running
     * image; nothing is loaded by asking.
     *
     * @param {string | null} name
     */
    const moduleHandleOf = name=>{
        const handle = host.moduleHandle(name) >>> 0;
        if (handle === 0)
        {
            setError(ERROR_MOD_NOT_FOUND);
        }
        return handle;
    };

    /**
     * The guest-side paths, placed once and shared by the exports that use
     * them: reading and writing the last error, and reading and writing a TLS
     * slot.
     *
     * @type {{ getLastError: number, setLastError: number, tlsGetValue: number,
     *     tlsSetValue: number } | null}
     */
    let fastPaths = null;
    /** @param {import('./sync.js').GuestBuilder} builder */
    const placed = builder=>{
        if (fastPaths)
        {
            return fastPaths;
        }
        if (!host.allocate)
        {
            throw new Error('kernel32: guest-side paths need memory to be placed in');
        }
        const allocate = host.allocateCode ?? host.allocate;
        const getTrap = builder.register('<tls-get>', {
            argBytes: 4,
            /** @param {number[]} args */
            handler: args=>table.TlsGetValue.handler(args),
        });
        const setTrap = builder.register('<tls-set>', {
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>table.TlsSetValue.handler(args),
        });
        /** @param {(at: number) => Uint8Array} code */
        const place = code=>{
            const at = allocate(code(0).length);
            host.writeMemory(at, code(at));
            return at;
        };
        fastPaths = {
            getLastError: place(()=>getLastErrorCode()),
            setLastError: place(()=>setLastErrorCode()),
            tlsGetValue: place(at=>tlsGetValueCode(at, getTrap)),
            tlsSetValue: place(at=>tlsSetValueCode(at, setTrap)),
        };
        return fastPaths;
    };

    /**
     * The clock in guest memory: made on the first bind of a clock export,
     * and kept current by the engine from there on.
     *
     * @type {number}
     */
    let clockAt = 0;
    /** One buffer, because this is written every time the clock moves. */
    const clockBytes = new Uint8Array(CLOCK.SIZE);
    const clockView = new DataView(clockBytes.buffer);
    /** @param {number} milliseconds */
    const ticksOf = milliseconds=>BigInt(
        Math.round(milliseconds * Number(PERFORMANCE_FREQUENCY) / 1000));
    const refreshClock = ()=>{
        if (clockAt === 0)
        {
            return;
        }
        const milliseconds = host.now();
        clockView.setBigUint64(CLOCK.COUNTER, ticksOf(milliseconds), true);
        clockView.setUint32(CLOCK.TICKS, Math.floor(milliseconds) >>> 0, true);
        host.writeMemory(clockAt, clockBytes);
    };
    /**
     * The block, taken once and alone on its page, with the engine told where
     * it is. Zero when this build has nowhere to put it or nobody to keep it
     * current, and then every clock export stays a trap.
     */
    const clockBlock = ()=>{
        if (clockAt !== 0 || !host.allocate || !host.publishClock)
        {
            return clockAt;
        }
        // A page-aligned span out of what the heap hands back, which is
        // aligned to nothing in particular.
        const span = host.allocate(CLOCK.SIZE + PAGE);
        if (span === 0)
        {
            return 0;
        }
        clockAt = (span + PAGE - 1) & ~(PAGE - 1);
        refreshClock();
        host.publishClock(refreshClock);
        return clockAt;
    };
    /**
     * The clock routines, placed once and shared by the exports that read
     * them.
     *
     * @type {{ counter: number, frequency: number, ticks: number } | null}
     */
    let clocks = null;
    /** @param {import('./sync.js').GuestBuilder} builder */
    const placedClocks = builder=>{
        if (clocks)
        {
            return clocks;
        }
        const block = clockBlock();
        const allocate = host.allocateCode ?? host.allocate;
        /**
         * One routine, or the trap it would have fallen back to when there is
         * nowhere to put it: an export whose address is zero is no export.
         *
         * @param {string} label @param {string} name
         * @param {(at: number, trap: number) => Uint8Array} code
         */
        const place = (label, name, code)=>{
            const trap = builder.register(label, {
                argBytes: table[name].argBytes,
                /** @param {number[]} args */
                handler: args=>table[name].handler(args),
            });
            if (block === 0 || !allocate)
            {
                return trap;
            }
            // Sized by a throwaway rendering: every encoding here is a fixed
            // length, so the bytes depend on where they land only through the
            // one relative jump.
            const at = allocate(code(0, trap).length);
            host.writeMemory(at, code(at, trap));
            return at;
        };
        clocks = {
            counter: place('<performance-counter>', 'QueryPerformanceCounter',
                (at, trap)=>queryPerformanceCounterCode(at, trap, block)),
            frequency: place('<performance-frequency>', 'QueryPerformanceFrequency',
                queryPerformanceFrequencyCode),
            ticks: place('<tick-count>', 'GetTickCount', ()=>tickCountCode(block)),
        };
        return clocks;
    };

    /**
     * A clock export's guest routine, where there is one to have.
     *
     * Without an allocator, or without an engine to keep the block current,
     * there is no entry at all rather than an entry that answers with the
     * trap: an export bound the ordinary way carries its own name, and that
     * name is what a profile of the run reads.
     *
     * @param {'counter' | 'frequency' | 'ticks'} which
     */
    const clockGuest = which=>(host.allocate && host.publishClock
        ? {
            /** @param {import('./sync.js').GuestBuilder} builder */
            guest: builder=>placedClocks(builder)[which],
        }
        : {});

    /**
     * The running thread's array, when `slot` is one of the slots it holds:
     * there the array is the value's one record, which the guest-side paths
     * and the compiler's own `fs:[0x2c]` sequence read and write without
     * asking. Zero past the array, or for a thread with no block -- a build
     * with no process blocks assembled keeps every value here, which is what
     * the tests drive.
     *
     * @param {number} slot
     */
    const blockFor = slot=>(slot < TLS_SLOTS_IN_BLOCK && host.tlsBlock ? host.tlsBlock() : 0);

    /** @param {number} index */
    const validSlot = index=>index >= 0 && index < TLS_SLOTS && slots[index] !== null;

    /**
     * Clears a slot of the array in every thread's block, or in the running
     * thread's alone where the host cannot name the others.
     *
     * @param {number} index  Below TLS_SLOTS_IN_BLOCK.
     */
    const zeroInEveryBlock = index=>{
        if (!host.allThreads)
        {
            const block = blockFor(index);
            if (block !== 0)
            {
                memory.writeU32(block + index * 4, 0);
            }
            return;
        }
        for (const thread of host.allThreads())
        {
            const teb = thread.tebAddress ?? 0;
            const block = teb === 0 ? 0 : memory.readU32(teb + TEB.TLS_POINTER);
            if (block !== 0)
            {
                memory.writeU32(block + index * 4, 0);
            }
        }
    };

    /** @param {number} address @param {bigint} value */
    const writeU64 = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, value, true);
        host.writeMemory(address, bytes);
    };

    /** @param {number} address */
    const readU32 = address=>new DataView(
        host.readMemory(address, 4).slice().buffer).getUint32(0, true);

    const told = host.version ?? DEFAULT_VERSION;

    /**
     * GetVersionEx in either spelling. The size field is how the caller says
     * which of the two structures it allocated, and an unrecognised one means
     * writing past the end of something, so nothing is written.
     *
     * @param {number} address @param {boolean} wide
     */
    const versionEx = (address, wide)=>{
        const layout = wide ? OSVERSIONINFO_W : OSVERSIONINFO_A;
        const declared = readU32(address);
        if (declared !== layout.SIZE && declared !== layout.EX_SIZE)
        {
            setError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }

        // Built whole and written from the second field on, so the caller's
        // own size field survives and the rest of szCSDVersion is cleared
        // rather than left as whatever was there.
        const struct = new Uint8Array(declared);
        const view = new DataView(struct.buffer);
        view.setUint32(4, told.major, true);
        view.setUint32(8, told.minor, true);
        view.setUint32(12, told.build, true);
        view.setUint32(16, told.platformId, true);
        for (let at = 0; at < told.csdVersion.length; at++)
        {
            const code = told.csdVersion.charCodeAt(at);
            if (wide)
            {
                view.setUint16(CSD_VERSION + at * 2, code, true);
            }
            else
            {
                struct[CSD_VERSION + at] = code & 0xff;
            }
        }
        if (declared === layout.EX_SIZE)
        {
            view.setUint16(layout.EXTENDED, told.servicePackMajor, true);
            view.setUint16(layout.EXTENDED + 2, told.servicePackMinor, true);
            view.setUint16(layout.EXTENDED + 4, told.suiteMask, true);
            struct[layout.EXTENDED + 6] = told.productType;
        }
        host.writeMemory(address + 4, struct.subarray(4));
        return 1;
    };

    /**
     * VerifyVersionInfo in either spelling: the request's fields, read
     * whatever its size field says, against the version GetVersionEx answers.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const verify = ([pointer, typeMask, maskLow, maskHigh], wide)=>{
        const at = pointer >>> 0;
        const extended = host.readMemory(
            at + (wide ? OSVERSIONINFO_W : OSVERSIONINFO_A).EXTENDED, 8).slice();
        const fields = new DataView(extended.buffer);
        const answer = verifyVersion(told, {
            major: readU32(at + 4),
            minor: readU32(at + 8),
            build: readU32(at + 12),
            platformId: readU32(at + 16),
            servicePackMajor: fields.getUint16(0, true),
            servicePackMinor: fields.getUint16(2, true),
            suiteMask: fields.getUint16(4, true),
            productType: fields.getUint8(6),
        }, typeMask, BigInt(maskLow >>> 0) | BigInt(maskHigh >>> 0) << 32n);
        if (answer === 'met')
        {
            return 1;
        }
        setError(answer === 'invalid' ? ERROR_BAD_ARGUMENTS : ERROR_OLD_WIN_VERSION);
        return 0;
    };
    const { setRegisters } = host;

    // Named, because the fibre-local entry points below are the thread-local
    // ones under different names and call them rather than repeating them.
    /**
     * @type {Record<string, { argBytes: number, handler: Function,
     *     guest?: (builder: import('./sync.js').GuestBuilder) => number }>}
     */
    const table = {
        /** VOID SetLastError(DWORD dwErrCode) */
        SetLastError: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                setError(code);
                return 0;
            },
            /** @param {import('./sync.js').GuestBuilder} builder */
            guest: builder=>placed(builder).setLastError,
        },

        /** DWORD GetLastError(VOID) */
        GetLastError: {
            argBytes: 0,
            handler: ()=>lastErrorOf(),
            /** @param {import('./sync.js').GuestBuilder} builder */
            guest: builder=>placed(builder).getLastError,
        },

        /** DWORD GetCurrentThreadId(VOID) */
        GetCurrentThreadId: {
            argBytes: 0,
            handler: ()=>host.currentThread().id >>> 0,
        },

        /** DWORD GetCurrentProcessId(VOID) */
        GetCurrentProcessId: {
            argBytes: 0,
            // Windows hands out multiples of four; a program that prints it or
            // uses it to name a mutex only needs it stable and non-zero.
            handler: ()=>(host.processId ?? 0x1000) >>> 0,
        },

        /** HANDLE GetCurrentProcess(VOID) */
        GetCurrentProcess: {
            argBytes: 0,
            handler: ()=>CURRENT_PROCESS,
        },

        /**
         * DWORD GetProcessVersion(DWORD ProcessId)
         *
         * The Windows version the process's image says it was built for: the
         * subsystem version in its optional header, major in the high word. Zero
         * names the calling process, as its own id does; another process's
         * image is not this one's to read.
         */
        GetProcessVersion: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([id])=>{
                if ((id >>> 0) !== 0 && (id >>> 0) !== ((host.processId ?? 0x1000) >>> 0))
                {
                    setError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const base = moduleHandleOf(null) >>> 0;
                const optional = base + memory.readU32(base + 0x3c) + 24;
                const words = memory.readU32(optional + 48);
                return ((words & 0xffff) << 16 | words >>> 16) >>> 0;
            },
        },

        /** HMODULE GetModuleHandleA(LPCSTR lpModuleName) */
        GetModuleHandleA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>moduleHandleOf(pointer === 0
                ? null
                : host.readCString(pointer >>> 0, MAX_MODULE_NAME)),
        },

        /** HMODULE GetModuleHandleW(LPCWSTR lpModuleName) */
        GetModuleHandleW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>moduleHandleOf(pointer === 0
                ? null
                : host.readWideString?.(pointer >>> 0, MAX_MODULE_NAME) ?? ''),
        },

        /** DWORD GetVersion(VOID) */
        GetVersion: {
            argBytes: 0,
            // Major in the low byte, minor in the next, build in the high word.
            // The top bit stays clear: set, it means Windows 9x, and code that
            // sees it takes a different path entirely.
            handler: ()=>(told.major
                | (told.minor << 8)
                | ((told.build & 0x7fff) << 16)) >>> 0,
        },

        /** BOOL GetVersionExA(LPOSVERSIONINFOA lpVersionInformation) */
        GetVersionExA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>versionEx(pointer >>> 0, false),
        },

        /** BOOL GetVersionExW(LPOSVERSIONINFOW lpVersionInformation) */
        GetVersionExW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>versionEx(pointer >>> 0, true),
        },

        /**
         * BOOL VerifyVersionInfoA(LPOSVERSIONINFOEXA lpVersionInformation,
         *                         DWORD dwTypeMask, DWORDLONG dwlConditionMask)
         */
        VerifyVersionInfoA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>verify(args, false),
        },

        /**
         * BOOL VerifyVersionInfoW(LPOSVERSIONINFOEXW lpVersionInformation,
         *                         DWORD dwTypeMask, DWORDLONG dwlConditionMask)
         */
        VerifyVersionInfoW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>verify(args, true),
        },

        /**
         * ULONGLONG VerSetConditionMask(ULONGLONG ConditionMask, DWORD TypeMask,
         *                               BYTE Condition)
         */
        ...setRegisters ? {
            VerSetConditionMask: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([low, high, typeMask, condition])=>{
                    const mask = setCondition(BigInt(low >>> 0) | BigInt(high >>> 0) << 32n,
                        typeMask, condition & 0xff);
                    setRegisters({ edx: Number(mask >> 32n) });
                    return Number(mask & 0xffffffffn);
                },
            },
        } : {},

        /** DWORD GetTickCount(VOID) */
        GetTickCount: {
            argBytes: 0,
            // Wraps after 49.7 days exactly as Windows does; code that subtracts
            // two readings gets the right answer across the wrap, code that
            // compares them does not, and that is the behaviour it was written
            // against.
            handler: ()=>Math.floor(host.now()) >>> 0,
            ...clockGuest('ticks'),
        },

        /** VOID GetSystemTimeAsFileTime(LPFILETIME lpSystemTimeAsFileTime) */
        GetSystemTimeAsFileTime: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const units = (BigInt(Math.floor(host.systemTimeMs())) + FILETIME_EPOCH_MS)
                    * 10_000n;
                writeU64(pointer >>> 0, units);
                return 0;
            },
        },

        /** BOOL QueryPerformanceCounter(LARGE_INTEGER *lpPerformanceCount) */
        QueryPerformanceCounter: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                writeU64(pointer >>> 0, ticksOf(host.now()));
                return 1;
            },
            ...clockGuest('counter'),
        },

        /** BOOL QueryPerformanceFrequency(LARGE_INTEGER *lpFrequency) */
        QueryPerformanceFrequency: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                writeU64(pointer >>> 0, PERFORMANCE_FREQUENCY);
                return 1;
            },
            ...clockGuest('frequency'),
        },

        /** VOID Sleep(DWORD dwMilliseconds) */
        Sleep: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([milliseconds])=>{
                // Zero yields rather than waits: it is a program saying another
                // thread may go first, and turning it into a wait of no time
                // would be the same thing more expensively.
                const wait = milliseconds >>> 0;
                if (wait === 0)
                {
                    return 0;
                }
                host.sleep(wait);
                return host.park();
            },
        },

        /**
         * The process priority and processor affinity a program reads and sets
         * to tune itself. There is one processor and one priority here; the
         * settings are accepted and have nothing to act on, and the queries
         * report the single-processor machine honestly.
         *
         * DWORD GetPriorityClass(HANDLE hProcess)
         * BOOL SetPriorityClass(HANDLE hProcess, DWORD dwPriorityClass)
         * BOOL GetProcessAffinityMask(HANDLE, PDWORD_PTR lpProcessAffinityMask,
         *                             PDWORD_PTR lpSystemAffinityMask)
         * BOOL SetProcessAffinityMask(HANDLE, DWORD_PTR dwProcessAffinityMask)
         */
        GetPriorityClass: {
            argBytes: 4,
            handler: ()=>NORMAL_PRIORITY_CLASS,
        },

        SetPriorityClass: {
            argBytes: 8,
            handler: ()=>1,
        },

        GetProcessAffinityMask: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, processMask, systemMask])=>{
                if ((processMask >>> 0) !== 0)
                {
                    memory.writeU32(processMask >>> 0, 1);
                }
                if ((systemMask >>> 0) !== 0)
                {
                    memory.writeU32(systemMask >>> 0, 1);
                }
                return 1;
            },
        },

        SetProcessAffinityMask: {
            argBytes: 8,
            handler: ()=>1,
        },

        /**
         * BOOL SetProcessWorkingSetSize(HANDLE hProcess, SIZE_T dwMinimumWorkingSetSize,
         *                               SIZE_T dwMaximumWorkingSetSize)
         *
         * There is no paging here, so there is no working set to bound; the
         * request is accepted the way it is on a machine with room for it.
         */
        SetProcessWorkingSetSize: {
            argBytes: 12,
            handler: ()=>1,
        },

        /**
         * BOOL GetProcessWorkingSetSize(HANDLE hProcess, PSIZE_T lpMinimumWorkingSetSize,
         *                               PSIZE_T lpMaximumWorkingSetSize)
         *
         * The bounds a fresh process has on Windows, 50 and 345 pages: there is
         * no working set here, and those are what a program would read.
         */
        GetProcessWorkingSetSize: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, minimum, maximum])=>{
                if ((minimum >>> 0) !== 0)
                {
                    memory.writeU32(minimum >>> 0, 50 * 4096);
                }
                if ((maximum >>> 0) !== 0)
                {
                    memory.writeU32(maximum >>> 0, 345 * 4096);
                }
                return 1;
            },
        },

        /** DWORD TlsAlloc(VOID) */
        TlsAlloc: {
            argBytes: 0,
            handler: ()=>{
                const index = slots.indexOf(null);
                if (index < 0)
                {
                    return TLS_OUT_OF_INDEXES;
                }
                generation++;
                slots[index] = generation;
                // The guest-side TlsSetValue writes a slot of the array whether
                // or not it is allocated, as Windows does, so a freed slot may
                // hold something again by now; its new owner reads zero. Every
                // thread's, not only the caller's as Windows clears it: a slot
                // past the array is unreachable in every thread once handed
                // out again (the generation), and the two halves agree.
                if (index < TLS_SLOTS_IN_BLOCK)
                {
                    zeroInEveryBlock(index);
                }
                return index;
            },
        },

        /** BOOL TlsFree(DWORD dwTlsIndex) */
        TlsFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>{
                if (!validSlot(index >>> 0))
                {
                    setError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                slots[index >>> 0] = null;
                // The slot reads as zero in every thread from now on, as it
                // does on Windows, and the guest-side read has no generation
                // to compare: every block is cleared.
                if (index < TLS_SLOTS_IN_BLOCK)
                {
                    zeroInEveryBlock(index);
                }
                return 1;
            },
        },

        /** LPVOID TlsGetValue(DWORD dwTlsIndex) */
        TlsGetValue: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>{
                const slot = index >>> 0;
                if (!validSlot(slot))
                {
                    setError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                // A slot legitimately holding zero is indistinguishable from a
                // failure, so success clears the error -- which is what makes
                // the documented "check GetLastError" idiom work at all.
                setError(ERROR_SUCCESS);
                const block = blockFor(slot);
                if (block !== 0)
                {
                    return memory.readU32(block + slot * 4);
                }
                const entry = stateOf().tls.get(slot);
                return entry && entry.generation === slots[slot] ? entry.value : 0;
            },
            /** @param {import('./sync.js').GuestBuilder} builder */
            guest: builder=>placed(builder).tlsGetValue,
        },

        /** BOOL TlsSetValue(DWORD dwTlsIndex, LPVOID lpTlsValue) */
        TlsSetValue: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([index, value])=>{
                const slot = index >>> 0;
                if (!validSlot(slot))
                {
                    setError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const block = blockFor(slot);
                if (block !== 0)
                {
                    memory.writeU32(block + slot * 4, value >>> 0);
                    return 1;
                }
                stateOf().tls.set(slot, {
                    generation: /** @type {number} */ (slots[slot]),
                    value: value >>> 0,
                });
                return 1;
            },
            /** @param {import('./sync.js').GuestBuilder} builder */
            guest: builder=>placed(builder).tlsSetValue,
        },

        // Fibre-local storage is thread-local storage on a machine with no
        // fibres, which is this one: a fibre is a thread the program schedules
        // itself, and without one there is exactly one fibre per thread. A C
        // runtime looks these up at run time and falls back to the Tls pair
        // when they are absent -- but it looks them up on every start, and a
        // fallback path is a path fewer programs have exercised.
        //
        // The callback FlsAlloc takes is not called. It runs when a fibre ends,
        // and nothing here ends one.
        /** DWORD FlsAlloc(PFLS_CALLBACK_FUNCTION lpCallback) */
        FlsAlloc: { argBytes: 4, handler: ()=>table.TlsAlloc.handler([]) },
        /** BOOL FlsFree(DWORD dwFlsIndex) */
        FlsFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: args=>table.TlsFree.handler(args),
        },
        /** PVOID FlsGetValue(DWORD dwFlsIndex) */
        FlsGetValue: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: args=>table.TlsGetValue.handler(args),
            /** @param {import('./sync.js').GuestBuilder} builder */
            guest: builder=>placed(builder).tlsGetValue,
        },
        /** BOOL FlsSetValue(DWORD dwFlsIndex, PVOID lpFlsData) */
        FlsSetValue: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>table.TlsSetValue.handler(args),
            /** @param {import('./sync.js').GuestBuilder} builder */
            guest: builder=>placed(builder).tlsSetValue,
        },

        /**
         * PVOID EncodePointer(PVOID Ptr) / PVOID DecodePointer(PVOID Ptr)
         *
         * On Windows these obfuscate a pointer against a per-process cookie, so
         * that a pointer sitting in memory is not a usable address to anything
         * that finds it. The pair is a contract with itself and nothing else:
         * what matters is that decoding what was encoded gives the pointer
         * back. Identity satisfies that exactly.
         *
         * They are here because a runtime asks for them by name and calls what
         * it is given. Answering nothing sends it down a fallback path, and one
         * measured run asked twenty-six times.
         */
        EncodePointer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>pointer >>> 0,
        },
        DecodePointer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>pointer >>> 0,
        },
        /** The same pair, under the names a runtime built for a system DLL uses. */
        EncodeSystemPointer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>pointer >>> 0,
        },
        DecodeSystemPointer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>pointer >>> 0,
        },
    };
    return table;
}
