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

import { windowsVersion } from '../kernel32/versions.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { EINVAL, createGlobals } from './globals.js';

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
    return splitCommandLineWords(line).map(word=>word.text);
}

/**
 * splitCommandLine's words, each with whether a quote was part of it: the
 * runtime's wildcard expansion leaves a quoted word as it is.
 *
 * @param {string} line
 * @returns {{ text: string, quoted: boolean }[]}
 */
export function splitCommandLineWords(line){
    /** @type {{ text: string, quoted: boolean }[]} */
    const argv = [];
    let current = '';
    let quoted = false;
    let started = false;
    let hadQuote = false;
    let slashes = 0;

    const flush = ()=>{
        if (started)
        {
            argv.push({ text: current, quoted: hadQuote });
        }
        current = '';
        started = false;
        hadQuote = false;
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
                hadQuote = true;
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
 * @property {() => string} [imagePath]
 *           The program's image, as GetModuleFileName(NULL) names it. Absent,
 *           `_pgmptr`, `_wpgmptr` and their getters stay unexported.
 * @property {(pattern: string) => string[] | null} [expand]
 *           The names in a directory a wildcard pattern matches, null for a
 *           directory that is not there. Absent, no word is expanded.
 *           What the process was started with, exactly as GetCommandLineA
 *           reports it -- the two must agree, because a program is free to read
 *           either and compare.
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} callGuest
 * @property {() => any} [currentThread]
 * @property {(code: number) => any} exitProcess
 *           Ends the process. Returns whatever the caller must return to stop
 *           the calling thread, since `exit` does not come back.
 * @property {(code: number) => Promise<number> | null | void} [exit]
 *           Ends the process without parking, for a call that has already
 *           left the bridge: `exit` after the handlers it ran in the guest.
 *           What ExitProcess tells the libraries is told here too, and the
 *           answer is the promise of that when there is any. The process ends
 *           before the thread runs another instruction, because the run loop
 *           reads the code before it hands out a slice.
 * @property {import('./globals.js').Globals} [globals]
 *           The runtime's variables, shared with the functions that set them:
 *           errno is set by whichever call fails. Absent, these are private.
 * @property {() => string} [errnoName]
 *           Which of them is the calling thread's errno. Absent, one for all.
 * @property {() => void} [closeStreams]
 *           Closes every stream still open, for `_cexit`. Absent, there are
 *           no streams to close.
 * @property {import('../kernel32/versions.js').WindowsVersion} [version]
 *           The Windows GetVersion answers for this process. Absent, the
 *           default one.
 * @property {{ narrow: () => number, wide: () => number }} [environment]
 *           The runtime's environment arrays (`environ.js`), which the main
 *           arguments hand on as they stand. Absent, an empty one.
 */

/**
 * @param {StartupHost} host
 * @returns {Record<string, any>}
 */
export function createStartupFunctions(host){
    const version = host.version ?? windowsVersion();

    /**
     * A C string in guest memory that outlives this call, in the ANSI page
     * GetCommandLineA writes the same text in.
     *
     * @param {string} text
     * @returns {number}
     */
    const publish = text=>{
        const bytes = encodeAnsi(`${text}\0`);
        const address = host.allocate(bytes.length);
        if (address === 0)
        {
            return 0;
        }
        host.writeMemory(address, bytes);
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

    /**
     * The words of the command line, each wildcard word unquoted made the
     * names it matches when the program asks for that (`doWildCard`), as
     * the runtime's own `_setargv` does: a word whose last component has a
     * `*` or `?` and matches something, the directory it names kept as it
     * was typed before each name; a word that matches nothing stays.
     *
     * @param {boolean} wildcards
     */
    const wordsOf = wildcards=>splitCommandLineWords(host.commandLine()).flatMap(word=>{
        if (!wildcards || word.quoted || !host.expand)
        {
            return [word.text];
        }
        const cut = Math.max(word.text.lastIndexOf('\\'), word.text.lastIndexOf('/'));
        if (!/[*?]/.test(word.text.slice(cut + 1)) || /[*?]/.test(word.text.slice(0, cut + 1)))
        {
            return [word.text];
        }
        const names = host.expand(word.text);
        return names && names.length > 0
            ? names.map(name=>`${word.text.slice(0, cut + 1)}${name}`) : [word.text];
    });

    /**
     * The argument vector: built once, and again each time a program asks
     * for the wildcards expanded, which may find what the last one did not.
     *
     * @param {boolean} [wildcards]
     */
    const buildMainArgs = (wildcards = false)=>{
        if (mainArgs && !wildcards)
        {
            return mainArgs;
        }
        const argv = wordsOf(wildcards);
        const pointers = argv.map(argument=>publish(argument));
        mainArgs = {
            argc: argv.length,
            argv: publishVector(pointers),
            // An empty environment block, not a null one: a program that walks
            // it expects to reach a terminator, and a null pointer is what it
            // checks for to decide the runtime failed.
            env: mainArgs?.env ?? publishVector([]),
        };
        globals.set('argc', mainArgs.argc);
        globals.set('argv', mainArgs.argv);
        return mainArgs;
    };

    /**
     * The wide argument vector, built once as the narrow one is.
     *
     * @type {{ argc: number, argv: number } | null}
     */
    let wideMainArgs = null;

    /** A wide string in guest memory that outlives this call. @param {string} text */
    const publishWide = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        const address = host.allocate(bytes.length);
        if (address !== 0)
        {
            host.writeMemory(address, bytes);
        }
        return address;
    };

    /**
     * `_pgmptr` and `_wpgmptr`, the program's path in the runtime's two
     * widths, published once so the variable and its getter hand out the
     * same string; and `_get_pgmptr` and `_get_wpgmptr`, which write that
     * pointer where asked: 0, or EINVAL with nothing written for nowhere.
     *
     * @param {() => string} imagePath
     */
    const programPath = imagePath=>{
        let narrow = 0;
        let wide = 0;
        const narrowPath = ()=>(narrow ||= publish(imagePath()));
        const widePath = ()=>(wide ||= publishWide(imagePath()));
        /** @param {() => number} pointer */
        const getter = pointer=>({
            convention: /** @type {'cdecl'} */ ('cdecl'),
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    globals.set(host.errnoName?.() ?? 'errno', EINVAL);
                    return EINVAL;
                }
                host.writeMemory(out >>> 0, dword(pointer()));
                return 0;
            },
        });
        return {
            _pgmptr: { data: ()=>dword(narrowPath()) },
            _wpgmptr: { data: ()=>dword(widePath()) },
            _get_pgmptr: getter(narrowPath),
            _get_wpgmptr: getter(widePath),
        };
    };

    /** @param {boolean} [wildcards] */
    const buildWideMainArgs = (wildcards = false)=>{
        if (!wideMainArgs || wildcards)
        {
            const words = wordsOf(wildcards);
            wideMainArgs = { argc: words.length,
                argv: publishVector(words.map(word=>publishWide(word))) };
            globals.set('wargv', wideMainArgs.argv);
        }
        return wideMainArgs;
    };

    /** @param {number} value @returns {Uint8Array} a dword, as a data export holds one */
    const dword = value=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        return bytes;
    };

    const globals = host.globals ?? createGlobals(host);

    /**
     * What `_onexit` and `atexit` registered, in the order it was registered.
     * Run backwards by `exit` and `_cexit`, which is the contract `atexit` is
     * built on: a handler may rely on what an earlier one set up still being
     * there.
     *
     * @type {number[]}
     */
    const onExit = [];

    /**
     * Runs the register, last first, and empties it: a handler runs once
     * however many of the exits reach it. A handler is guest code, so this
     * answers with a promise that settles when the last one has returned.
     */
    const runOnExit = ()=>{
        const asked = host.currentThread?.();
        const handlers = onExit.splice(0).reverse();
        return handlers.reduce(
            (waiting, entry)=>waiting.then(()=>host.callGuest(entry, [], asked)),
            Promise.resolve(0));
    };

    /**
     * An int in guest memory that a `__p__*` accessor can hand out.
     *
     * @param {string} name @param {number} initial
     */
    const cell = (name, initial)=>globals.address(name, initial);

    return {
        /**
         * int __getmainargs(int *argc, char ***argv, char ***env,
         *                   int doWildCard, _startupinfo *startInfo)
         *
         * Zero for success. Windows does not expand wildcards for a program,
         * the runtime does, and only when the program asked -- `doWildCard`
         * -- since a program that did not ask and gets an expanded vector
         * sees files it never named.
         */
        __getmainargs: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([argc, argv, env, wildcards])=>{
                const built = buildMainArgs(wildcards !== 0);
                writeU32(argc, built.argc);
                writeU32(argv, built.argv);
                writeU32(env, host.environment?.narrow() ?? built.env);
                return 0;
            },
        },

        /**
         * int __wgetmainargs(int *argc, wchar_t ***argv, wchar_t ***env,
         *                    int doWildCard, _startupinfo *startInfo)
         *
         * __getmainargs in UTF-16: the same arguments, and the wide
         * environment, which this call makes if nothing has yet.
         */
        __wgetmainargs: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([argc, argv, env, wildcards])=>{
                const built = buildWideMainArgs(wildcards !== 0);
                writeU32(argc, built.argc);
                writeU32(argv, built.argv);
                writeU32(env, host.environment?.wide() ?? buildMainArgs().env);
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
                // Whose call this is, read before the walk starts. Only the
                // first initialiser runs while this handler holds the
                // processor; the loop turns between them, and the rest would
                // otherwise be built on whichever thread ran next.
                const asked = host.currentThread?.();
                return entries.reduce(
                    (waiting, entry)=>waiting.then(()=>host.callGuest(entry, [], asked)),
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
                const asked = host.currentThread?.();
                return entries.reduce(
                    (waiting, entry)=>waiting.then(
                        code=>(code !== 0 ? code : host.callGuest(entry, [], asked))),
                    /** @type {Promise<number>} */ (Promise.resolve(0)));
            },
        },

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

        /**
         * int *_errno(void) / unsigned long *__doserrno(void)
         *
         * The runtime's error cells, reached the same way: a library that
         * resolves them by name at load time (a packed one restoring its
         * import table) must get an address, or the call it later makes
         * through the table goes nowhere. errno is a cell per thread, the one
         * the calling thread's own failing calls set.
         */
        _errno: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>cell(host.errnoName?.() ?? 'errno', 0),
        },

        __doserrno: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>cell('doserrno', 0),
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
         * wchar_t ***__p___wargv(void)
         *
         * The wide vector `__wgetmainargs` hands out, made here if nothing
         * has made it yet: a library built for UTF-16 reads the arguments
         * this way whichever start-up the program ran.
         */
        __p___wargv: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>cell('wargv', buildWideMainArgs().argv),
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

        /**
         * char *_acmdln
         *
         * A variable, not a function: the runtime's copy of the command line,
         * which a start-up reads through the address it imported to find where
         * the program name ends. The same text GetCommandLineA reports, because
         * a program is free to read either and compare.
         */
        _acmdln: {
            data: ()=>{
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, publish(host.commandLine()), true);
                return bytes;
            },
        },

        ...host.imagePath ? programPath(/** @type {() => string} */ (host.imagePath)) : {},

        /**
         * int _adjust_fdiv
         *
         * Zero: the processor has no division defect to work around, and a
         * start-up that reads a non-zero here takes the slow path for every
         * division the program does.
         */
        _adjust_fdiv: { data: ()=>new Uint8Array(4) },

        /**
         * unsigned _osver, _winver, _winmajor, _winminor, _osplatform
         *
         * The runtime's copy of the system version, which a start-up and a
         * program's own version check read without calling GetVersion: the
         * build, major and minor in one word, and each part alone, and the
         * platform GetVersionEx names. The same figures GetVersion answers
         * for the Windows the process is told it runs on, since a program may
         * compare the two.
         */
        _osplatform: { data: ()=>dword(version.platformId) },
        _osver: { data: ()=>dword(version.build) },
        _winver: { data: ()=>dword(version.major << 8 | version.minor) },
        _winmajor: { data: ()=>dword(version.major) },
        _winminor: { data: ()=>dword(version.minor) },

        /**
         * double _HUGE
         *
         * What `HUGE_VAL` reads, the value a math function answers on
         * overflow: infinity, not the largest finite double.
         */
        _HUGE: {
            data: ()=>{
                const bytes = new Uint8Array(8);
                new DataView(bytes.buffer).setFloat64(0, Infinity, true);
                return bytes;
            },
        },

        /**
         * char **_environ
         *
         * The environment `__getmainargs` hands `main` as its third argument,
         * the same vector: a program walks whichever it has.
         */
        _environ: { data: ()=>dword(buildMainArgs().env) },

        /**
         * int __mb_cur_max
         *
         * One: the widest multibyte character of the runtime's locale is a
         * single byte, the "C" locale a program starts in.
         */
        __mb_cur_max: { data: ()=>new Uint8Array([1, 0, 0, 0]) },

        /**
         * _onexit_t _onexit(_onexit_t func)
         *
         * The function itself on success, null on failure; `atexit` is this
         * with the answer folded to zero or minus one.
         */
        _onexit: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([fn])=>{
                onExit.push(fn >>> 0);
                return fn >>> 0;
            },
        },

        /** int atexit(void (*func)(void)) -- zero once registered. */
        atexit: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([fn])=>{
                onExit.push(fn >>> 0);
                return 0;
            },
        },

        /**
         * _onexit_t __dllonexit(_onexit_t func, _PVFV **pbegin, _PVFV **pend)
         *
         * A library's own table, kept in the library's variables rather than
         * ours: the runtime grows the array between `*pbegin` and `*pend` by
         * one entry and writes the function at the end, and the library walks
         * that array itself when it is detached. An empty table is null or
         * minus one, which is how a start-up marks one nothing has touched.
         */
        __dllonexit: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([fn, pbegin, pend])=>{
                const begin = readU32(pbegin);
                const empty = begin === 0 || begin === 0xffffffff;
                const count = empty ? 0 : (readU32(pend) - begin) >>> 2;
                // ponytail: a fresh array per entry, the old one left to the
                // library's own free at detach; resize when a table gets long.
                const grown = host.allocate((count + 1) * 4);
                if (grown === 0)
                {
                    return 0;
                }
                if (count > 0)
                {
                    host.writeMemory(grown, host.readMemory(begin, count * 4));
                }
                writeU32(grown + count * 4, fn >>> 0);
                writeU32(pbegin, grown);
                writeU32(pend, grown + (count + 1) * 4);
                return fn >>> 0;
            },
        },

        /**
         * void exit(int code) / void _exit(int code)
         *
         * `exit` runs what `_onexit` registered, last first, before it ends
         * the process; `_exit` ends it without. A handler is guest code, so a
         * process with any is ended once the last of them has returned.
         */
        exit: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                if (onExit.length === 0 || !host.exit)
                {
                    return host.exitProcess(code >>> 0);
                }
                return runOnExit().then(async()=>{
                    await host.exit?.(code >>> 0);
                    return 0;
                });
            },
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
         *
         * `_cexit` is `exit` without the ending: what `atexit` and `_onexit`
         * registered runs, last first, and then every open stream is closed,
         * as it is documented to be -- flushing one is nothing here, every
         * stream writing straight through to the volume. `_c_exit` is `_exit`
         * without the ending, so it runs and closes nothing.
         */
        _cexit: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                const close = ()=>{
                    host.closeStreams?.();
                    return 0;
                };
                return onExit.length === 0 ? close() : runOnExit().then(close);
            },
        },
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
