/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */


import { TEB } from './teb.js';
import { createProcessors } from './processor.js';
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

/** EncodePointer and DecodePointer's guest code: `mov eax, [esp+4]; ret 4`. */
const POINTER_AS_IS = [0x8b, 0x44, 0x24, 0x04, 0xc2, 0x04, 0x00];

/**
 * Ticks per second for the performance counter unless `config.json` says another: a
 * gigahertz, a tick a nanosecond. Every answer is later than the last by a tick at least, so the
 * counter runs ahead of the clock by the reads a program makes between two
 * moves of it; a tick coarser than a read -- a microsecond is -- lets a spin
 * on the counter outrun time several times over. A guest does not make a
 * thousand million reads a second, so at this rate the counter cannot get
 * ahead by more than a read's worth. It stays exact in a double for about a
 * hundred days of a process's life.
 */
const PERFORMANCE_FREQUENCY = 1_000_000_000n;

/**
 * Byte offsets within the block the clock routines read.
 *
 * A program times its own frames, and it times them by asking the machine
 * what time it is hundreds of times a second -- for a number the engine
 * already knows and nothing in the guest can change. So the number is written
 * where the guest can read it, and reading it is what the clock exports do.
 */
export const CLOCK = {
    /**
     * Odd while the engine writes the block: the counter's two words are read
     * between two looks at it that found it the same and even. A thread on
     * another executor otherwise read the low word before a move and the high
     * after it -- 4.3 seconds ahead at a wrap, kept as the last answer, and
     * the counter stood still that long.
     */
    SEQUENCE: 0,
    /** Milliseconds since boot, as GetTickCount and timeGetTime answer it: one word, read whole. */
    TICKS: 4,
    /** The performance counter, 64-bit, in performance-frequency ticks. */
    COUNTER: 8,
    /**
     * The counter's last answer, 64-bit and 8-aligned: the next is always
     * later, every thread's, moved by `lock cmpxchg8b`.
     */
    LAST: 16,
    /** What the engine writes when the clock moves, the sequence aside: the ticks and the counter. */
    WRITTEN: 12,
    SIZE: 24,
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
 * Where a process stands in the order the system shuts processes down in: the
 * level every process starts at, the highest there is (the system's own first
 * range ends there), and the one flag -- SHUTDOWN_NORETRY -- a process may set.
 */
const SHUTDOWN_DEFAULT_LEVEL = 0x280;
const SHUTDOWN_HIGHEST_LEVEL = 0x4ff;
const SHUTDOWN_NORETRY = 0x1;

/** An out-pointer of NULL: the address cannot be written. */
const ERROR_NOACCESS = 998;

/**
 * @typedef {Object} ProcessHost
 * @property {number} [performanceFrequency]  Ticks a second of the performance counter
 *     (`PERFORMANCE_FREQUENCY` by default); a whole number a 32-bit immediate holds.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, expected: bigint, value: bigint) => bigint} [compareExchangeU64]
 * @property {(address: number, length: number) => Int32Array | null} [wordsOver]
 *     the dwords of a block the engine keeps, over the RAM itself, where it can be had
 *     A quadword swapped only if it holds `expected`, indivisible against the
 *     guest's `lock cmpxchg8b` on the process's other executors; answers what it held.
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {() => any} currentThread     The record per-thread state hangs on.
 * @property {() => number} now            Guest milliseconds since boot.
 * @property {() => number} systemTimeMs   Guest wall clock, milliseconds since 1970.
 * @property {(name: string | null) => number} moduleHandle
 *           The base of a loaded module, or 0; null asks for the running image.
 * @property {(address: number) => number} [moduleContaining]
 *           The base of the module an address lies in, or 0.
 * @property {(base: number, pin: boolean) => void} [holdModule]
 *           One more reference on a loaded module, as LoadLibrary takes; a
 *           pinned one is never let go.
 * @property {(milliseconds: number) => void} sleep
 * @property {() => any} park  The token that says the caller has been stopped.
 * @property {(reason: string, result: number) => void} [reschedule]  The caller gives up
 *           its turn and is woken at once with `result`, its processor chosen again.
 * @property {() => boolean} [yieldTurn]  Puts the caller behind another thread ready to
 *           run at its priority or above, for Sleep(0); false, and nothing done, when
 *           there is none.
 * @property {(address: number) => void} [readyWord]  Has the kernel keep the word at
 *           `address` saying how many threads are ready to run with no executor
 *           running them, which Sleep's guest code reads (`sleepCode`).
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
 * @property {import('./processor.js').Processors} [processors]  The process's
 *           processors and its affinity, which every other interface that
 *           counts or sets them shares. Absent, one processor.
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

/**
 * GetCurrentThreadId as guest code: the block's field, through FS -- the id the host writes
 * there as it makes the block, and answers itself. A C runtime asks it for every lock it
 * takes, and in a title's world load it was three host calls in five.
 */
export function getCurrentThreadIdCode(){
    return new Uint8Array([
        0x64, 0xa1, ...dword(TEB.THREAD_ID),                         // mov eax, fs:[0x24]
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
 * QueryPerformanceCounter as guest code: the counter of the block when it is
 * later than the last answer, else the last answer and one tick more, copied
 * into the caller's LARGE_INTEGER and kept as the last answer.
 *
 * The guest's clock does not move while the guest is running -- it is
 * credited between slices -- so two reads inside one slice found the same
 * counter. On a real machine the counter always moves between two reads, and
 * a program that times a stretch of its own code by two of them counts on
 * it: Diablo II's single-player server times each tick so and takes a zero
 * for a tick that did not happen, and once its tick ran inside one slice its
 * client never drew again. The answers stay what a trap would give, which
 * keeps the same last answer (`nextCount`).
 *
 * With threads on several executors the counter is read between two looks at
 * the block's sequence (`CLOCK.SEQUENCE`), and the last answer is moved by
 * `lock cmpxchg8b`, so every thread's answer is later than every answer
 * before it.
 *
 *     mov ecx, [esp+4]
 *     test ecx, ecx
 *     jz slow                     ; a null pointer is the host's, as before
 *     push ebx / esi / edi / ebp
 *     mov ebp, ecx
 *   read:
 *     mov eax, [sequence]
 *     test al, 1
 *     jnz spin                    ; the engine is writing the block
 *     mov edi, [counter]
 *     mov esi, [counter+4]
 *     cmp eax, [sequence]
 *     jne read
 *     mov eax, [last]
 *     mov edx, [last+4]
 *   next:                         ; ecx:ebx = the counter if later, else last + 1
 *     mov ebx, edi
 *     mov ecx, esi
 *     cmp ecx, edx
 *     ja swap
 *     jb bump
 *     cmp ebx, eax
 *     ja swap
 *   bump:
 *     mov ebx, eax
 *     mov ecx, edx
 *     add ebx, 1
 *     adc ecx, 0
 *   swap:
 *     lock cmpxchg8b [last]       ; edx:eax the last answer another took meanwhile
 *     jne next
 *     mov [ebp], ebx
 *     mov [ebp+4], ecx
 *     pop ebp / edi / esi / ebx
 *     mov eax, 1
 *     ret 4
 *   spin:
 *     pause
 *     jmp read
 *   slow:
 *     jmp trap
 *
 * @param {number} at     Where the code lands, for the jump to the trap.
 * @param {number} trap   The host's QueryPerformanceCounter.
 * @param {number} block  The clock block.
 */
export function queryPerformanceCounterCode(at, trap, block){
    const slow = 114;
    const sequence = block + CLOCK.SEQUENCE;
    const counter = block + CLOCK.COUNTER;
    const last = block + CLOCK.LAST;
    return new Uint8Array([
        0x8b, 0x4c, 0x24, 0x04,                                      // mov ecx, [esp+4]
        0x85, 0xc9,                                                  // test ecx, ecx
        0x0f, 0x84, ...dword(slow - 12),                             // jz slow
        0x53, 0x56, 0x57, 0x55,                                      // push ebx, esi, edi, ebp
        0x89, 0xcd,                                                  // mov ebp, ecx
        // read: (18)
        0xa1, ...dword(sequence),                                    // mov eax, [sequence]
        0xa8, 0x01,                                                  // test al, 1
        0x75, 110 - 27,                                              // jnz spin
        0x8b, 0x3d, ...dword(counter),                               // mov edi, [counter]
        0x8b, 0x35, ...dword(counter + 4),                           // mov esi, [counter+4]
        0x3b, 0x05, ...dword(sequence),                              // cmp eax, [sequence]
        0x75, (18 - 47) & 0xff,                                      // jne read
        0xa1, ...dword(last),                                        // mov eax, [last]
        0x8b, 0x15, ...dword(last + 4),                              // mov edx, [last+4]
        // next: (58)
        0x89, 0xfb,                                                  // mov ebx, edi
        0x89, 0xf1,                                                  // mov ecx, esi
        0x39, 0xd1,                                                  // cmp ecx, edx
        0x77, 82 - 66,                                               // ja swap
        0x72, 72 - 68,                                               // jb bump
        0x39, 0xc3,                                                  // cmp ebx, eax
        0x77, 82 - 72,                                               // ja swap
        // bump: (72)
        0x89, 0xc3,                                                  // mov ebx, eax
        0x89, 0xd1,                                                  // mov ecx, edx
        0x83, 0xc3, 0x01,                                            // add ebx, 1
        0x83, 0xd1, 0x00,                                            // adc ecx, 0
        // swap: (82)
        0xf0, 0x0f, 0xc7, 0x0d, ...dword(last),                      // lock cmpxchg8b [last]
        0x75, (58 - 92) & 0xff,                                      // jne next
        0x89, 0x5d, 0x00,                                            // mov [ebp], ebx
        0x89, 0x4d, 0x04,                                            // mov [ebp+4], ecx
        0x5d, 0x5f, 0x5e, 0x5b,                                      // pop ebp, edi, esi, ebx
        0xb8, ...dword(1),                                           // mov eax, 1
        0xc2, 0x04, 0x00,                                            // ret 4
        // spin: (110)
        0xf3, 0x90,                                                  // pause
        0xeb, (18 - 114) & 0xff,                                     // jmp read
        // slow: (114)
        0xe9, ...dword(trap - (at + slow + 5)),                      // jmp trap
    ]);
}

/**
 * QueryPerformanceFrequency as guest code. The frequency is a constant of
 * this machine, so it is an immediate rather than a word of the block.
 *
 * @param {number} at @param {number} trap
 * @param {number} [frequency]
 */
export function queryPerformanceFrequencyCode(at, trap, frequency = Number(PERFORMANCE_FREQUENCY)){
    const slow = 29;
    return new Uint8Array([
        0x8b, 0x4c, 0x24, 0x04,                                      // mov ecx, [esp+4]
        0x85, 0xc9,                                                  // test ecx, ecx
        0x74, slow - 8,                                              // jz slow
        0xc7, 0x01, ...dword(frequency),                             // mov dword [ecx], frequency
        0xc7, 0x41, 0x04, ...dword(0),                               // mov dword [ecx+4], 0
        0xb8, ...dword(1),                                           // mov eax, 1
        0xc2, 0x04, 0x00,                                            // ret 4
        // slow:
        0xe9, ...dword(trap - (at + slow + 5)),                      // jmp trap
    ]);
}

/**
 * Sleep as guest code: Sleep(0) gives the rest of the turn to a thread ready to
 * run, and returns at once when none is -- which the guest reads in the
 * kernel's word (`readyWord`) and answers by itself, with no crossing. Every
 * other call, a time to sleep or a thread waiting to run, goes to the host.
 * Call of Duty 4's threads waited on each other with Sleep(0) round and round,
 * 16.8 million calls a run, four of every five crossings into the host; on
 * another executor each waited for the process's executor to answer.
 *
 *     mov eax, [esp+4]        ; dwMilliseconds
 *     test eax, eax
 *     jnz slow
 *     cmp dword [word], 0     ; threads ready with no executor
 *     jne slow
 *     ret 4
 *   slow:
 *     jmp trap
 *
 * @param {number} at    Where the code lands, for the jump to the trap.
 * @param {number} trap  The host's Sleep.
 * @param {number} word  The kernel's count of threads waiting to run.
 */
export function sleepCode(at, trap, word){
    const slow = 20;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x04,                                      // mov eax, [esp+4]
        0x85, 0xc0,                                                  // test eax, eax
        0x75, slow - 8,                                              // jnz slow
        0x83, 0x3d, ...dword(word), 0x00,                            // cmp dword [word], 0
        0x75, slow - 17,                                             // jne slow
        0xc2, 0x04, 0x00,                                            // ret 4
        // slow: (20)
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
    const performanceFrequency = host.performanceFrequency ?? Number(PERFORMANCE_FREQUENCY);
    if (!Number.isInteger(performanceFrequency) || performanceFrequency < 1
        || performanceFrequency > 0xffffffff)
    {
        throw new Error(`kernel32: the performance frequency is a whole number of ticks `
            + `from 1 to 4294967295 a second, not ${performanceFrequency}`);
    }
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
    const processors = host.processors ?? createProcessors();

    /** The process's place in the shutdown order, which it may move. */
    const shutdown = { level: SHUTDOWN_DEFAULT_LEVEL, flags: 0 };

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
     * GetModuleHandleEx, reading a name with `read`: GetModuleHandle that
     * takes a reference as LoadLibrary does unless told not to -- or for
     * good, pinned -- and that finds a module by an address inside it too.
     *
     * @param {(pointer: number) => string} read
     */
    const moduleHandleEx = read=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([flags, name, out])=>{
            const PIN = 1;
            const UNCHANGED_REFCOUNT = 2;
            const FROM_ADDRESS = 4;
            const asked = flags >>> 0;
            const both = PIN | UNCHANGED_REFCOUNT;
            if ((out >>> 0) === 0 || (asked & both) === both)
            {
                setError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const base = (asked & FROM_ADDRESS) !== 0
                ? (host.moduleContaining?.(name >>> 0) ?? 0) >>> 0
                : host.moduleHandle((name >>> 0) === 0 ? null : read(name >>> 0)) >>> 0;
            host.writeMemory(out >>> 0, Uint8Array.from(dword(base)));
            if (base === 0)
            {
                setError(ERROR_MOD_NOT_FOUND);
                return 0;
            }
            if ((asked & UNCHANGED_REFCOUNT) === 0)
            {
                host.holdModule?.(base, (asked & PIN) !== 0);
            }
            return 1;
        },
    });

    /**
     * The guest-side paths, placed once and shared by the exports that use
     * them: reading and writing the last error, and reading and writing a TLS
     * slot.
     *
     * @type {{ getLastError: number, setLastError: number, tlsGetValue: number,
     *     tlsSetValue: number, getCurrentThreadId: number } | null}
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
            getCurrentThreadId: place(()=>getCurrentThreadIdCode()),
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
    const clockBytes = new Uint8Array(CLOCK.WRITTEN);
    const clockView = new DataView(clockBytes.buffer);
    /** @param {number} milliseconds */
    const ticksOf = milliseconds=>BigInt(
        Math.round(milliseconds * performanceFrequency / 1000));
    /** The counter's last answer, where there is no block to keep it in. */
    let lastCount = 0n;
    /**
     * The counter's next answer, the host's as the guest routine's: the
     * clock's when it is later than the last answer, else the last answer and
     * one tick more (`queryPerformanceCounterCode`), kept as the last answer
     * where the routine keeps it too.
     */
    const nextCount = ()=>{
        const clock = ticksOf(host.now());
        if (clockAt === 0)
        {
            lastCount = clock > lastCount ? clock : lastCount + 1n;
            return lastCount;
        }
        const at = clockAt + CLOCK.LAST;
        let last = BigInt(memory.readU32(at)) | BigInt(memory.readU32(at + 4)) << 32n;
        for (;;)
        {
            const answer = clock > last ? clock : last + 1n;
            if (host.compareExchangeU64 === undefined)
            {
                writeU64(at, answer);
                return answer;
            }
            // As the routine's `lock cmpxchg8b`: another thread's answer taken
            // meanwhile is the last one to be later than.
            const was = host.compareExchangeU64(at, last, answer);
            if (was === last)
            {
                return answer;
            }
            last = was;
        }
    };
    /** The block's sequence, the engine's alone to move: even, odd while it writes. */
    let sequence = 0;
    /**
     * The block's dwords over the RAM itself, where the memory layer has them:
     * written at every turn, through the memory's checked path that was the
     * largest of a turn's costs when threads took turns on one executor.
     *
     * @type {Int32Array | null}
     */
    let clockWords = null;
    const refreshClock = ()=>{
        if (clockAt === 0)
        {
            return;
        }
        const milliseconds = host.now();
        if (clockWords !== null)
        {
            // In plain numbers, exact to 2^53 ticks: a BigInt here was four
            // allocations wherever guest time moved, thousands of times a second.
            const counter = Math.round(milliseconds * performanceFrequency / 1000);
            // The sequence odd before the words move and even after, every
            // word by Atomics: a plain store may reach a reader on another
            // executor ahead of the odd sequence on a host that reorders
            // stores (arm64), and the reader would take half a counter.
            Atomics.store(clockWords, CLOCK.SEQUENCE >> 2, ++sequence);
            Atomics.store(clockWords, CLOCK.TICKS >> 2, Math.floor(milliseconds));
            Atomics.store(clockWords, CLOCK.COUNTER >> 2, counter % 0x100000000 | 0);
            Atomics.store(clockWords, (CLOCK.COUNTER >> 2) + 1,
                Math.floor(counter / 0x100000000) | 0);
            Atomics.store(clockWords, CLOCK.SEQUENCE >> 2, ++sequence);
            return;
        }
        // The span written runs from the ticks to the counter's end.
        clockView.setUint32(0, Math.floor(milliseconds) >>> 0, true);
        clockView.setBigUint64(CLOCK.COUNTER - CLOCK.TICKS, ticksOf(milliseconds), true);
        memory.writeU32(clockAt + CLOCK.SEQUENCE, ++sequence);
        host.writeMemory(clockAt + CLOCK.TICKS, clockBytes);
        memory.writeU32(clockAt + CLOCK.SEQUENCE, ++sequence);
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
        clockWords = host.wordsOver?.(clockAt, CLOCK.SIZE) ?? null;
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
                (at, trap)=>queryPerformanceFrequencyCode(at, trap, performanceFrequency)),
            ticks: place('<tick-count>', 'GetTickCount', ()=>tickCountCode(block)),
        };
        return clocks;
    };

    /** Where Sleep's guest code went, once placed. @type {number | null} */
    let sleepAt = null;
    /**
     * Sleep's guest code and the word of the kernel's it reads, placed on the
     * first bind (`sleepCode`).
     *
     * @param {import('./sync.js').GuestBuilder} builder
     */
    const placedSleep = builder=>{
        if (sleepAt !== null)
        {
            return sleepAt;
        }
        const trap = builder.register('KERNEL32.dll!Sleep', {
            argBytes: table.Sleep.argBytes,
            /** @param {number[]} args */
            handler: args=>table.Sleep.handler(args),
        });
        const allocate = host.allocateCode ?? host.allocate;
        if (!host.allocate || !allocate || !host.readyWord)
        {
            sleepAt = trap;
            return trap;
        }
        const word = host.allocate(4);
        const at = allocate(sleepCode(0, trap, word).length);
        host.writeMemory(at, sleepCode(at, trap, word));
        host.readyWord(word);
        sleepAt = at;
        return at;
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
     *     guest?: (builder: import('./sync.js').GuestBuilder) => number,
     *     code?: () => Uint8Array }>}
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
            /** @param {import('./sync.js').GuestBuilder} builder */
            guest: builder=>placed(builder).getCurrentThreadId,
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
            code: ()=>Uint8Array.from([0x83, 0xc8, 0xff, 0xc3]),        // or eax, -1; ret
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

        /** BOOL GetModuleHandleExA(DWORD dwFlags, LPCSTR lpModuleName, HMODULE *phModule) */
        GetModuleHandleExA: moduleHandleEx(pointer=>host.readCString(pointer, MAX_MODULE_NAME)),

        /** BOOL GetModuleHandleExW(DWORD dwFlags, LPCWSTR lpModuleName, HMODULE *phModule) */
        GetModuleHandleExW: moduleHandleEx(pointer=>
            host.readWideString?.(pointer, MAX_MODULE_NAME) ?? ''),

        /**
         * BOOL GetSystemPowerStatus(LPSYSTEM_POWER_STATUS lpSystemPowerStatus)
         *
         * A desktop on mains power: online, no system battery, its charge and
         * both lifetimes unknown.
         */
        GetSystemPowerStatus: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([status])=>{
                if ((status >>> 0) === 0)
                {
                    setError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                host.writeMemory(status >>> 0,
                    Uint8Array.of(1, 128, 255, 0, ...dword(0xffffffff), ...dword(0xffffffff)));
                return 1;
            },
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
            // mov eax, version; ret -- one process, one version
            code: ()=>Uint8Array.from([0xb8, ...dword(table.GetVersion.handler()), 0xc3]),
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

        /**
         * BOOL GetSystemTimeAdjustment(PDWORD lpTimeAdjustment, PDWORD lpTimeIncrement,
         *     PBOOL lpTimeAdjustmentDisabled)
         *
         * The system clock here moves a millisecond at a time and nothing
         * adjusts it: an increment of 10 000 hundreds of nanoseconds, the
         * same added at each, and adjustment disabled.
         */
        GetSystemTimeAdjustment: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([adjustment, increment, disabled])=>{
                // Each is a DWORD or a BOOL: four bytes, no more.
                for (const [pointer, value] of [[adjustment, 10000], [increment, 10000],
                    [disabled, 1]])
                {
                    if ((pointer >>> 0) !== 0)
                    {
                        host.writeMemory(pointer >>> 0, Uint8Array.of(value & 0xff,
                            value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24));
                    }
                }
                return 1;
            },
        },

        /** BOOL QueryPerformanceCounter(LARGE_INTEGER *lpPerformanceCount) */
        QueryPerformanceCounter: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                writeU64(pointer >>> 0, nextCount());
                return 1;
            },
            ...clockGuest('counter'),
        },

        /** BOOL QueryPerformanceFrequency(LARGE_INTEGER *lpFrequency) */
        QueryPerformanceFrequency: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                writeU64(pointer >>> 0, BigInt(performanceFrequency));
                return 1;
            },
            ...clockGuest('frequency'),
        },

        /**
         * VOID Sleep(DWORD dwMilliseconds)
         *
         * Guest code first: Sleep(0) with no thread waiting to run returns
         * there (`sleepCode`), and everything else comes here.
         */
        Sleep: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([milliseconds])=>{
                // Zero gives the rest of the turn to another thread ready to
                // run, and returns at once when there is none. Answered at once
                // always, a thread polling for another's work -- WaitForSingle-
                // Object(h, 0) then Sleep(0), round and round -- spun out its
                // whole turn while the thread it waited for stood in the queue:
                // millions of calls a second, and a world loading at a crawl.
                const wait = milliseconds >>> 0;
                if (wait === 0)
                {
                    return host.yieldTurn?.() ? host.park() : 0;
                }
                host.sleep(wait);
                return host.park();
            },
            ...host.allocate && host.readyWord
                ? {
                    /** @param {import('./sync.js').GuestBuilder} builder */
                    guest: builder=>placedSleep(builder),
                }
                : {},
        },

        /**
         * The process priority a program reads and sets to tune itself. There
         * is one priority here; the setting is accepted and has nothing to act
         * on.
         *
         * DWORD GetPriorityClass(HANDLE hProcess)
         * BOOL SetPriorityClass(HANDLE hProcess, DWORD dwPriorityClass)
         */
        GetPriorityClass: {
            argBytes: 4,
            handler: ()=>NORMAL_PRIORITY_CLASS,
        },

        SetPriorityClass: {
            argBytes: 8,
            handler: ()=>1,
        },

        /**
         * BOOL GetProcessAffinityMask(HANDLE hProcess, PDWORD_PTR lpProcessAffinityMask,
         *                             PDWORD_PTR lpSystemAffinityMask)
         *
         * The processors the process may run on, and the machine's. The
         * handle is not looked at, as NtQueryInformationProcess does not look
         * at it: this process's masks are the ones kept here.
         */
        GetProcessAffinityMask: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, processMask, systemMask])=>{
                if ((processMask >>> 0) !== 0)
                {
                    memory.writeU32(processMask >>> 0, processors.processMask());
                }
                if ((systemMask >>> 0) !== 0)
                {
                    memory.writeU32(systemMask >>> 0, processors.systemMask());
                }
                return 1;
            },
        },

        /**
         * BOOL SetProcessAffinityMask(HANDLE hProcess, DWORD_PTR dwProcessAffinityMask)
         *
         * Puts the process, and every thread of it, on the processors the mask
         * names. A mask naming none, or a processor the machine does not have,
         * is ERROR_INVALID_PARAMETER and changes nothing. A caller the mask
         * moves off the processor it is on gives up its turn, as with
         * SetThreadAffinityMask: an engine timing each processor pins its
         * process to each in turn and reads the APIC id next, at a priority
         * no Sleep(0) yields at.
         */
        SetProcessAffinityMask: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, mask])=>{
                if (!processors.setProcessMask(mask))
                {
                    setError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const self = host.currentThread();
                if (self && host.reschedule
                    && ((mask >>> 0) >>> processors.processorOf(self) & 1) === 0)
                {
                    host.reschedule('SetProcessAffinityMask', 1);
                    return host.park();
                }
                return 1;
            },
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
         * BOOL K32EmptyWorkingSet(HANDLE hProcess), psapi's EmptyWorkingSet:
         * accepted as SetProcessWorkingSetSize is, there being no pages to
         * trim.
         */
        K32EmptyWorkingSet: {
            argBytes: 4,
            handler: ()=>1,
        },

        /**
         * BOOL SetProcessShutdownParameters(DWORD dwLevel, DWORD dwFlags)
         * BOOL GetProcessShutdownParameters(LPDWORD lpdwLevel, LPDWORD lpdwFlags)
         *
         * Kept and read back, though nothing here shuts the system down: a
         * program that sets its place in the order may read it back to check,
         * and one that reads it first expects the level every process starts
         * at. A level past the documented ranges or a flag that is not
         * SHUTDOWN_NORETRY is refused, and the setting stays as it was.
         */
        SetProcessShutdownParameters: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([level, flags])=>{
                if ((level >>> 0) > SHUTDOWN_HIGHEST_LEVEL || (flags & ~SHUTDOWN_NORETRY) !== 0)
                {
                    setError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                shutdown.level = level >>> 0;
                shutdown.flags = flags >>> 0;
                return 1;
            },
        },

        GetProcessShutdownParameters: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([level, flags])=>{
                if ((level >>> 0) === 0 || (flags >>> 0) === 0)
                {
                    setError(ERROR_NOACCESS);
                    return 0;
                }
                memory.writeU32(level >>> 0, shutdown.level);
                memory.writeU32(flags >>> 0, shutdown.flags);
                return 1;
            },
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
         * measured run asked twenty-six times; Call of Duty 4's runtime asks
         * for its function pointers through DecodePointer 37 000 times a
         * run, so the identity is guest code, with no crossing.
         */
        EncodePointer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>pointer >>> 0,
            code: ()=>Uint8Array.from(POINTER_AS_IS),
        },
        DecodePointer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>pointer >>> 0,
            code: ()=>Uint8Array.from(POINTER_AS_IS),
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
