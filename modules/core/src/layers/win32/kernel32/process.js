/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

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
 * The version reported to the guest: Windows XP, build 2600.
 *
 * A single answer has to be chosen, and this is the one an application of the
 * era both understands and is willing to run on -- old enough that nothing
 * demands a feature we do not have, new enough that an NT check passes.
 */
const VERSION_MAJOR = 5;
const VERSION_MINOR = 1;
const VERSION_BUILD = 2600;
const VER_PLATFORM_WIN32_NT = 2;
const VER_NT_WORKSTATION = 1;

/** sizeof(OSVERSIONINFOA) and sizeof(OSVERSIONINFOEXA). */
const OSVERSIONINFOA_SIZE = 148;
const OSVERSIONINFOEXA_SIZE = 156;

/** The pseudo-handle GetCurrentProcess returns; it is -1 on every Windows. */
const CURRENT_PROCESS = 0xffffffff;

/**
 * Ticks per second for the performance counter. One megahertz: fine enough to
 * time a frame, coarse enough that the counter stays exact in a double for
 * longer than any process runs.
 */
const PERFORMANCE_FREQUENCY = 1_000_000n;

/** Milliseconds between the FILETIME epoch (1601-01-01) and the Unix one. */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;

/** Nothing sensible names a module beyond MAX_PATH. */
const MAX_MODULE_NAME = 260;

/**
 * @typedef {Object} ProcessHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
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
 * @property {number} [processId]
 */

/**
 * The per-thread kernel32 state: the last-error slot and the TLS values.
 *
 * Extracted so everything that writes an error code writes the same record.
 * Two places building this shape independently is how one of them ends up
 * setting an error nothing ever reads.
 *
 * @param {() => any} currentThread
 */
export function createThreadState(currentThread){
    const stateOf = ()=>{
        const thread = currentThread();
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

    return {
        stateOf,
        /** @param {number} code */
        setError: code=>{
            stateOf().lastError = code >>> 0;
        },
    };
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

    const { stateOf, setError } = createThreadState(host.currentThread);

    /**
     * Mirrors a slot into the block the compiler reads.
     *
     * Silent when there is no block -- a build with no process blocks assembled
     * still has working Tls* calls, which is what the tests drive.
     *
     * @param {number} slot @param {number} value
     */
    const publishSlot = (slot, value)=>{
        if (slot >= TLS_SLOTS_IN_BLOCK || !host.tlsBlock)
        {
            return;
        }
        const block = host.tlsBlock();
        if (block === 0)
        {
            return;
        }
        host.writeMemory(block + slot * 4, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @param {number} index */
    const validSlot = index=>index >= 0 && index < TLS_SLOTS && slots[index] !== null;

    /** @param {number} address @param {bigint} value */
    const writeU64 = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, value, true);
        host.writeMemory(address, bytes);
    };

    /** @param {number} address */
    const readU32 = address=>new DataView(
        host.readMemory(address, 4).slice().buffer).getUint32(0, true);

    // Named, because the fibre-local entry points below are the thread-local
    // ones under different names and call them rather than repeating them.
    /** @type {Record<string, { argBytes: number, handler: Function }>} */
    const table = {
        /** VOID SetLastError(DWORD dwErrCode) */
        SetLastError: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                setError(code);
                return 0;
            },
        },

        /** DWORD GetLastError(VOID) */
        GetLastError: {
            argBytes: 0,
            handler: ()=>stateOf().lastError,
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

        /** HMODULE GetModuleHandleA(LPCSTR lpModuleName) */
        GetModuleHandleA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const name = pointer === 0
                    ? null
                    : host.readCString(pointer >>> 0, MAX_MODULE_NAME);
                const handle = host.moduleHandle(name) >>> 0;
                if (handle === 0)
                {
                    setError(ERROR_MOD_NOT_FOUND);
                }
                return handle;
            },
        },

        /** DWORD GetVersion(VOID) */
        GetVersion: {
            argBytes: 0,
            // Major in the low byte, minor in the next, build in the high word.
            // The top bit stays clear: set, it means Windows 9x, and code that
            // sees it takes a different path entirely.
            handler: ()=>(VERSION_MAJOR
                | (VERSION_MINOR << 8)
                | ((VERSION_BUILD & 0x7fff) << 16)) >>> 0,
        },

        /** BOOL GetVersionExA(LPOSVERSIONINFOA lpVersionInformation) */
        GetVersionExA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const address = pointer >>> 0;
                const declared = readU32(address);
                // The size field is how the caller says which of the two
                // structures it allocated. An unrecognised one means we would be
                // writing past the end of something, so nothing is written.
                if (declared !== OSVERSIONINFOA_SIZE && declared !== OSVERSIONINFOEXA_SIZE)
                {
                    setError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }

                // Built whole and written from the second field on, so the
                // caller's own size field survives untouched.
                const struct = new Uint8Array(declared);
                const view = new DataView(struct.buffer);
                view.setUint32(4, VERSION_MAJOR, true);
                view.setUint32(8, VERSION_MINOR, true);
                view.setUint32(12, VERSION_BUILD, true);
                view.setUint32(16, VER_PLATFORM_WIN32_NT, true);
                // szCSDVersion stays zeroed: no service pack is installed, and
                // the string has to be empty rather than whatever was there.
                if (declared === OSVERSIONINFOEXA_SIZE)
                {
                    struct[154] = VER_NT_WORKSTATION;
                }
                host.writeMemory(address + 4, struct.subarray(4));
                return 1;
            },
        },

        /** DWORD GetTickCount(VOID) */
        GetTickCount: {
            argBytes: 0,
            // Wraps after 49.7 days exactly as Windows does; code that subtracts
            // two readings gets the right answer across the wrap, code that
            // compares them does not, and that is the behaviour it was written
            // against.
            handler: ()=>Math.floor(host.now()) >>> 0,
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
                const ticks = BigInt(Math.round(host.now() * Number(PERFORMANCE_FREQUENCY) / 1000));
                writeU64(pointer >>> 0, ticks);
                return 1;
            },
        },

        /** BOOL QueryPerformanceFrequency(LARGE_INTEGER *lpFrequency) */
        QueryPerformanceFrequency: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                writeU64(pointer >>> 0, PERFORMANCE_FREQUENCY);
                return 1;
            },
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
                const entry = stateOf().tls.get(slot);
                return entry && entry.generation === slots[slot] ? entry.value : 0;
            },
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
                stateOf().tls.set(slot, {
                    generation: /** @type {number} */ (slots[slot]),
                    value: value >>> 0,
                });
                publishSlot(slot, value >>> 0);
                return 1;
            },
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
        },
        /** BOOL FlsSetValue(DWORD dwFlsIndex, PVOID lpFlsData) */
        FlsSetValue: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>table.TlsSetValue.handler(args),
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
