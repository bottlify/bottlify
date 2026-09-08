/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C runtime's start-up, which runs before `main` and decides whether there
 * is a `main` to reach.
 *
 * A program compiled with MSVC does not begin at `main`. It begins at
 * `mainCRTStartup`, which asks the runtime for its arguments, initialises the
 * floating-point environment, runs every static constructor the linker
 * collected, and only then calls the program's own entry point. None of that is
 * optional: a program whose start-up cannot complete never reaches a line
 * anybody wrote, and what it looks like from outside is a process that maps,
 * resolves every import, and exits.
 *
 * Two of these are more than bookkeeping:
 *
 * - **`_initterm` runs guest code.** It walks a table of function pointers the
 *   linker built and calls each one, and those are the static constructors of
 *   every C++ object with global lifetime. Skipping them leaves a program whose
 *   globals are all zero -- which is not a crash, it is a program that behaves
 *   as though nothing was ever configured.
 * - **`__getmainargs` decides what the program thinks it was asked to do.** An
 *   installer branches on its arguments; a launcher passes its own along. The
 *   vector it fills is the program's `argv`, and its lifetime is the process's,
 *   so it is allocated from the same heap everything else uses rather than
 *   pointed at a buffer that will be reused.
 */

/** What `_controlfp` reports when nothing has changed it: the MSVC default. */
const DEFAULT_CONTROL_WORD = 0x0009001f;

/** Bits `_controlfp` will let a program set, so a mask cannot invent one. */
const CONTROL_MASK = 0x000fffff;

/** `_XcptFilter`'s answer: this filter handles nothing and passes it on. */
const EXCEPTION_CONTINUE_SEARCH = 0;

/**
 * Splits a Windows command line the way the C runtime does.
 *
 * The quoting rule is the runtime's own and is not the shell's: a run of
 * backslashes before a quote is halved and the quote is taken literally when
 * the run was even; otherwise the quote toggles whether spaces separate. A
 * program that reads a path with a space in it depends on exactly this, and
 * getting it wrong splits its own installation directory into two arguments.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitCommandLine(line){
    /** @type {string[]} */
    const argv = [];
    let current = '';
    let quoted = false;
    let started = false;
    let slashes = 0;

    const flush = ()=>{
        if (started)
        {
            argv.push(current);
        }
        current = '';
        started = false;
    };

    for (const character of line)
    {
        if (character === '\\')
        {
            slashes++;
            continue;
        }
        if (character === '"')
        {
            current += '\\'.repeat(slashes >> 1);
            if ((slashes & 1) === 1)
            {
                current += '"';
            }
            else
            {
                quoted = !quoted;
            }
            slashes = 0;
            started = true;
            continue;
        }
        current += '\\'.repeat(slashes);
        slashes = 0;
        if (!quoted && (character === ' ' || character === '\t'))
        {
            flush();
            continue;
        }
        current += character;
        started = true;
    }
    current += '\\'.repeat(slashes);
    flush();
    return argv;
}

/**
 * @typedef {Object} StartupHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(bytes: number) => number} allocate
 * @property {() => string} commandLine
 *           What the process was started with, exactly as GetCommandLineA
 *           reports it -- the two must agree, because a program is free to read
 *           either and compare.
 * @property {(entry: number, args: number[]) => Promise<number>} callGuest
 * @property {(code: number) => any} exitProcess
 *           Ends the process. Returns whatever the caller must return to stop
 *           the calling thread, since `exit` does not come back.
 */

/**
 * @param {StartupHost} host
 * @returns {Record<string, any>}
 */
export function createStartupFunctions(host){
    let controlWord = DEFAULT_CONTROL_WORD;

    /**
     * A C string in guest memory that outlives this call.
     *
     * @param {string} text
     * @returns {number}
     */
    const publish = text=>{
        const bytes = new TextEncoder().encode(text);
        const address = host.allocate(bytes.length + 1);
        if (address === 0)
        {
            return 0;
        }
        const buffer = new Uint8Array(bytes.length + 1);
        buffer.set(bytes);
        host.writeMemory(address, buffer);
        return address;
    };

    /**
     * A null-terminated array of pointers, and the pointer to it.
     *
     * @param {number[]} pointers
     * @returns {number}
     */
    const publishVector = pointers=>{
        const address = host.allocate((pointers.length + 1) * 4);
        if (address === 0)
        {
            return 0;
        }
        const bytes = new Uint8Array((pointers.length + 1) * 4);
        const view = new DataView(bytes.buffer);
        pointers.forEach((pointer, index)=>view.setUint32(index * 4, pointer >>> 0, true));
        host.writeMemory(address, bytes);
        return address;
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) === 0)
        {
            return;
        }
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };

    /**
     * The argument vector, built once.
     *
     * Once, because a program may call `__getmainargs` again -- some runtimes do
     * it from more than one start-up path -- and two vectors would leave it
     * comparing pointers that are both its own and never equal.
     *
     * @type {{ argc: number, argv: number, env: number } | null}
     */
    let mainArgs = null;

    const buildMainArgs = ()=>{
        if (mainArgs)
        {
            return mainArgs;
        }
        const argv = splitCommandLine(host.commandLine());
        const pointers = argv.map(argument=>publish(argument));
        mainArgs = {
            argc: argv.length,
            argv: publishVector(pointers),
            // An empty environment block, not a null one: a program that walks
            // it expects to reach a terminator, and a null pointer is what it
            // checks for to decide the runtime failed.
            env: publishVector([]),
        };
        return mainArgs;
    };

    /** An int in guest memory that a `__p__*` accessor can hand out. */
    /** @type {Map<string, number>} */
    const cells = new Map();

    /** @param {string} name @param {number} initial */
    const cell = (name, initial)=>{
        const held = cells.get(name);
        if (held !== undefined)
        {
            return held;
        }
        const address = host.allocate(4);
        if (address !== 0)
        {
            writeU32(address, initial);
        }
        cells.set(name, address);
        return address;
    };

    return {
        /**
         * int __getmainargs(int *argc, char ***argv, char ***env,
         *                   int doWildCard, _startupinfo *startInfo)
         *
         * Zero for success. The wildcard expansion is deliberately not done:
         * Windows does not expand wildcards for a program, the runtime does, and
         * only when the program asked -- a program that did not ask and gets an
         * expanded vector sees files it never named.
         */
        __getmainargs: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([argc, argv, env])=>{
                const built = buildMainArgs();
                writeU32(argc, built.argc);
                writeU32(argv, built.argv);
                writeU32(env, built.env);
                return 0;
            },
        },

        /**
         * void _initterm(_PVFV *start, _PVFV *end)
         *
         * Every static constructor the linker collected, in the order it
         * collected them. Null entries are skipped rather than called: the
         * linker leaves gaps where a section was padded, and calling one is a
         * jump to address zero.
         *
         * This runs guest code, so it answers with a promise and the bridge
         * parks the caller until the last constructor returns.
         */
        _initterm: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([start, end])=>{
                const first = start >>> 0;
                const last = end >>> 0;
                if (first === 0 || last <= first)
                {
                    return 0;
                }
                const entries = [];
                for (let at = first; at < last; at += 4)
                {
                    const entry = readU32(at);
                    if (entry !== 0)
                    {
                        entries.push(entry);
                    }
                }
                return entries.reduce(
                    (waiting, entry)=>waiting.then(()=>host.callGuest(entry, [])),
                    Promise.resolve(0)).then(()=>0);
            },
        },

        /**
         * int _initterm_e(_PIFV *start, _PIFV *end)
         *
         * The same walk, except that each initialiser returns a code and a
         * non-zero one stops the rest. A runtime that ignored the code would run
         * initialisers that depend on one that has already failed.
         */
        _initterm_e: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([start, end])=>{
                const first = start >>> 0;
                const last = end >>> 0;
                if (first === 0 || last <= first)
                {
                    return 0;
                }
                const entries = [];
                for (let at = first; at < last; at += 4)
                {
                    const entry = readU32(at);
                    if (entry !== 0)
                    {
                        entries.push(entry);
                    }
                }
                return entries.reduce(
                    (waiting, entry)=>waiting.then(
                        code=>(code !== 0 ? code : host.callGuest(entry, []))),
                    /** @type {Promise<number>} */ (Promise.resolve(0)));
            },
        },

        /**
         * unsigned int _controlfp(unsigned int newControl, unsigned int mask)
         *
         * The floating-point control word, remembered rather than applied. A
         * program sets it to make its own arithmetic reproducible and then reads
         * it back to check; answering with what it asked for is what keeps that
         * check from failing. Applying it is the emulator's business and it
         * already runs at the precision the guest selected.
         */
        _controlfp: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([wanted, mask])=>{
                const bits = mask >>> 0 & CONTROL_MASK;
                controlWord = (controlWord & ~bits | wanted >>> 0 & bits) >>> 0;
                return controlWord;
            },
        },

        /** unsigned int _clearfp(void) -- no exception is ever pending here. */
        _clearfp: { convention: 'cdecl', argBytes: 0, handler: ()=>0 },

        /** unsigned int _statusfp(void) */
        _statusfp: { convention: 'cdecl', argBytes: 0, handler: ()=>0 },

        /**
         * void __set_app_type(int type)
         *
         * Console or windows, which the runtime uses to decide how to report a
         * fatal error. Accepted and not acted on: nothing here reports a fatal
         * error the way either kind of program would, and the call exists so
         * that a start-up which makes it can continue.
         */
        __set_app_type: { convention: 'cdecl', argBytes: 4, handler: ()=>0 },

        /**
         * int *__p__commode(void) / int *__p__fmode(void)
         *
         * The runtime's own globals, reached through an accessor because they
         * live in the runtime's data segment and a program linked against the
         * DLL cannot name them. Each has to be an address the program can write
         * through, and the same address every time.
         */
        __p__commode: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>cell('commode', 0),
        },

        __p__fmode: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>cell('fmode', 0),
        },

        /** int *__p___argc(void) */
        __p___argc: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                const built = buildMainArgs();
                return cell('argc', built.argc);
            },
        },

        /** char ***__p___argv(void) */
        __p___argv: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                const built = buildMainArgs();
                return cell('argv', built.argv);
            },
        },

        /**
         * LONG _XcptFilter(ULONG code, PEXCEPTION_POINTERS pointers)
         *
         * The runtime's own filter around `main`. It handles nothing here and
         * says so, which lets the exception reach whatever the program itself
         * installed rather than being swallowed by a filter that would then have
         * to decide how to end the process.
         */
        _XcptFilter: {
            convention: 'cdecl',
            argBytes: 8,
            handler: ()=>EXCEPTION_CONTINUE_SEARCH,
        },

        /**
         * void __setusermatherr(void (*handler)())
         *
         * Where the runtime reports a domain error. Accepted and not called:
         * nothing here produces one, and a handler invoked for an error that did
         * not happen is worse than a handler that never runs.
         */
        __setusermatherr: { convention: 'cdecl', argBytes: 4, handler: ()=>0 },

        /** void exit(int code) / void _exit(int code) */
        exit: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>host.exitProcess(code >>> 0),
        },

        _exit: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>host.exitProcess(code >>> 0),
        },

        /**
         * void _cexit(void) / void _c_exit(void)
         *
         * Run the runtime's own teardown and return, which is not the same as
         * ending the process: a program calls these when it means to keep going
         * afterwards, and ending here would take away the rest of its shutdown.
         */
        _cexit: { convention: 'cdecl', argBytes: 0, handler: ()=>0 },
        _c_exit: { convention: 'cdecl', argBytes: 0, handler: ()=>0 },

        /**
         * void _amsg_exit(int code)
         *
         * The runtime giving up before `main`, which it does only for a failure
         * it cannot describe any other way. Ending the process is the whole
         * behaviour, and the code is what the program's own start-up decided.
         */
        _amsg_exit: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>host.exitProcess(code >>> 0),
        },
    };
}
