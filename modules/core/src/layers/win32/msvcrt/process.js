/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's process calls: the signal table, and the two ways a C
 * program starts another one -- a command through the interpreter, and an
 * image with its arguments.
 *
 * There is no command interpreter on this machine, so `system` answers as
 * the runtime does when COMSPEC names nothing it can run. `_spawnl` and
 * `_spawnv` start the image as CreateProcess does (kernel32's spawner): the
 * runtime's command line is the arguments joined by spaces, as it joins
 * them, and the mode decides what the caller gets -- the process handle for
 * `_P_NOWAIT`, zero for `_P_NOWAITO` and `_P_DETACH`, and for `_P_OVERLAY`
 * the caller ends. `_P_WAIT` waits for the child's exit code, which this
 * call cannot do while the caller is inside it: that mode fails as the
 * runtime fails when the image is not there, said once as a divergence.
 */

import { createRefusals } from '../common/refusal.js';
import { VARIADIC_SLOTS } from './scan.js';
import { EINVAL, ENOENT } from './globals.js';

/** The signals msvcrt.dll keeps a handler for; any other number is EINVAL. */
const SIGNALS = new Set([
    2, // SIGINT
    4, // SIGILL
    8, // SIGFPE
    11, // SIGSEGV
    15, // SIGTERM
    21, // SIGBREAK
    22, // SIGABRT
]);

/** What signal answers when it refuses. */
const SIG_ERR = 0xffffffff;
/** The two actions <signal.h> reserves for the runtime's own use, refused from a program. */
const SIG_SGE = 3;
const SIG_ACK = 4;
/** SIG_IGN: the signal is dropped. */
const SIG_IGN = 1;
/** What a signal's default action exits with, as _exit(3) in the runtime. */
const DEFAULT_ACTION_EXIT = 3;
/** The code a raised SIGFPE's handler is given as its second argument: _FPE_EXPLICITGEN. */
const FPE_EXPLICITGEN = 0x8c;
const SIGFPE = 8;
/** The signals an exception is raised as: SIGILL, SIGFPE and SIGSEGV. */
const EXCEPTION_SIGNALS = new Set([4, 8, 11]);

/** _spawn's modes: _P_WAIT, _P_NOWAIT, _P_OVERLAY, _P_NOWAITO, _P_DETACH. */
const SPAWN_MODES = 5;
const P_WAIT = 0;
const P_NOWAIT = 1;
const P_OVERLAY = 2;
/** The most argument strings read off a list with no NULL in reach. */
const MOST_ARGUMENTS = 1024;

/**
 * @typedef {Object} ProcessHost
 * @property {(code: number) => void} errno
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} [callGuest]
 *           Runs the handler a program set, for raise.
 * @property {() => any} [currentThread]
 * @property {(code: number) => any} [exitProcess]
 *           Ends the process, for the default action raise takes.
 * @property {(named: string, line: string, flags: number) => any} [launch]
 *           Starts an image as CreateProcess does (kernel32's spawner):
 *           the record, with `handle` and `threadHandle` open on it, or null
 *           when the image is not there.
 * @property {(handle: number) => void} [closeHandle]
 * @property {(address: number) => string} [readCString]
 * @property {(address: number) => number} [readU32]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 */

/**
 * @param {ProcessHost} host
 */
export function createProcessFunctions(host){
    /**
     * The handler each signal has, SIG_DFL (zero) until one is set.
     *
     * @type {Map<number, number>}
     */
    const handlers = new Map();

    const refuse = createRefusals({ setLastError: host.errno, divergence: host.divergence });

    const noInterpreter = refuse('system', {
        argBytes: 4,
        answer: 0xffffffff,
        lastError: ENOENT,
        why: 'there is no command interpreter to run a command with',
    });

    const noWait = refuse('_spawnl', {
        argBytes: 8 + VARIADIC_SLOTS * 4,
        answer: 0xffffffff,
        lastError: ENOENT,
        why: '_P_WAIT: a child\'s exit code is not waited for inside the call',
    });

    /**
     * Starts `name` with `args` in `mode`, the arguments already checked.
     *
     * @param {number} mode @param {number} name @param {number[]} args  the
     *     string pointers, argv[0] first, up to the NULL
     */
    const spawn = (mode, name, args)=>{
        const { launch, readCString } = host;
        if (mode === P_WAIT || !launch || !readCString)
        {
            return noWait.handler();
        }
        const line = args.map(at=>readCString(at)).join(' ');
        const made = launch(readCString(name), line, 0);
        if (made === null)
        {
            host.errno(ENOENT);
            return 0xffffffff;
        }
        host.closeHandle?.(made.threadHandle);
        if (mode === P_OVERLAY)
        {
            host.closeHandle?.(made.handle);
            if (!host.exitProcess)
            {
                throw new Error('_spawn: cannot end the process for _P_OVERLAY');
            }
            return host.exitProcess(0);
        }
        if (mode === P_NOWAIT)
        {
            return made.handle >>> 0;
        }
        host.closeHandle?.(made.handle);
        return 0;
    };

    /**
     * The pointers from `at` up to the first NULL, each read by `read`.
     *
     * @param {(index: number) => number} read
     * @param {number} most
     */
    const untilNull = (read, most)=>{
        /** @type {number[]} */
        const found = [];
        for (let index = 0; index < most; index++)
        {
            const value = read(index) >>> 0;
            if (value === 0)
            {
                break;
            }
            found.push(value);
        }
        return found;
    };

    /**
     * Each thread's `_pxcptinfoptrs`, made the first time it is asked for.
     *
     * @type {Map<any, number>}
     */
    const pointerCells = new Map();

    /** The calling thread's cell, zero where no memory can hold one. */
    const exceptionPointers = ()=>{
        const thread = host.currentThread?.() ?? null;
        let cell = pointerCells.get(thread) ?? 0;
        if (cell === 0 && host.allocate && host.writeMemory)
        {
            cell = host.allocate(4);
            if (cell !== 0)
            {
                writeCell(cell, 0);
                pointerCells.set(thread, cell);
            }
        }
        return cell;
    };

    /** @param {number} cell */
    const readCell = cell=>host.readU32?.(cell) ?? 0;

    /** @param {number} cell @param {number} value */
    const writeCell = (cell, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory?.(cell, bytes);
    };

    const table = {
        /**
         * void **__pxcptinfoptrs(void)
         *
         * Where the calling thread's runtime keeps the EXCEPTION_POINTERS of
         * the exception a signal handler was called for: null until one is.
         */
        __pxcptinfoptrs: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>exceptionPointers(),
        },

        /**
         * void (*signal(int sig, void (*func)(int)))(int)
         *
         * The handler the signal had, and the one given kept for it. A
         * signal the runtime does not know, or one of the actions it keeps
         * for itself, is SIG_ERR and EINVAL.
         */
        signal: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([signal, action])=>{
                const number = signal | 0;
                const given = action >>> 0;
                if (!SIGNALS.has(number) || given === SIG_SGE || given === SIG_ACK)
                {
                    host.errno(EINVAL);
                    return SIG_ERR;
                }
                const previous = handlers.get(number) ?? 0;
                handlers.set(number, given);
                return previous >>> 0;
            },
        },

        /**
         * int raise(int sig)
         *
         * A signal the runtime does not know is -1 and EINVAL. SIG_IGN drops
         * it; SIG_DFL ends the process with exit code 3, the runtime's default
         * action; a handler the program set is put back to SIG_DFL first and
         * then called with the signal (SIGFPE also with _FPE_EXPLICITGEN), as
         * the runtime does, and raise answers zero once it returns.
         */
        raise: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([signal])=>{
                const number = signal | 0;
                if (!SIGNALS.has(number))
                {
                    host.errno(EINVAL);
                    return 0xffffffff;
                }
                const action = handlers.get(number) ?? 0;
                if (action === SIG_IGN)
                    return 0;
                if (action === 0)
                {
                    if (!host.exitProcess)
                        throw new Error('raise: cannot end the process for a default action');
                    return host.exitProcess(DEFAULT_ACTION_EXIT);
                }
                if (!host.callGuest)
                    throw new Error('raise: no way into guest code to run a signal handler');
                handlers.set(number, 0);
                const args = number === SIGFPE ? [number, FPE_EXPLICITGEN] : [number];
                // A signal an exception raises sees no exception's pointers
                // while its handler runs: there was none, raise is a call.
                const pointers = EXCEPTION_SIGNALS.has(number) ? exceptionPointers() : 0;
                const kept = pointers === 0 ? 0 : readCell(pointers);
                if (pointers !== 0)
                {
                    writeCell(pointers, 0);
                }
                await host.callGuest(action, args, host.currentThread?.());
                if (pointers !== 0)
                {
                    writeCell(pointers, kept);
                }
                return 0;
            },
        },

        /**
         * int system(const char *command)
         *
         * NULL asks whether an interpreter is there: zero, none is. Any
         * command is -1 with ENOENT, the runtime's answer when the
         * interpreter cannot be found.
         */
        system: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([command])=>((command >>> 0) === 0 ? 0 : noInterpreter.handler()),
        },

        /**
         * intptr_t _spawnl(int mode, const char *cmdname, const char *arg0, ..., NULL)
         *
         * A mode that is none, or no image named, is -1 and EINVAL, as the
         * runtime checks them; an image that is not there is -1 and ENOENT.
         */
        _spawnl: {
            convention: 'cdecl',
            argBytes: 8 + VARIADIC_SLOTS * 4,
            /** @param {number[]} args */
            handler: ([mode, name, ...rest])=>{
                if ((mode >>> 0) >= SPAWN_MODES || (name >>> 0) === 0)
                {
                    host.errno(EINVAL);
                    return 0xffffffff;
                }
                return spawn(mode >>> 0, name, untilNull(index=>rest[index] ?? 0, rest.length));
            },
        },

        /**
         * intptr_t _spawnv(int mode, const char *cmdname, const char *const *argv)
         *
         * _spawnl's answers, the arguments in an array rather than on the stack.
         */
        _spawnv: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([mode, name, argv])=>{
                if ((mode >>> 0) >= SPAWN_MODES || (name >>> 0) === 0)
                {
                    host.errno(EINVAL);
                    return 0xffffffff;
                }
                const { readU32 } = host;
                const list = (argv >>> 0) === 0 || !readU32 ? []
                    : untilNull(index=>readU32((argv >>> 0) + index * 4), MOST_ARGUMENTS);
                return spawn(mode >>> 0, name, list);
            },
        },
    };
    return {
        ...table,
        // The PATH forms. The image is resolved as CreateProcess resolves
        // the name; the runtime's own walk of PATH's directories is not made.
        _spawnlp: table._spawnl,
        _spawnvp: table._spawnv,
    };
}
