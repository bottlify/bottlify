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
 * Nothing here can start a process. There is no command interpreter on this
 * machine, so `system` answers as the runtime does when COMSPEC names
 * nothing it can run, and `_spawnl` -- whose `_P_WAIT` waits for an exit
 * code no child here ever reports -- fails the same way, its arguments
 * checked first as the runtime checks them. Both are documented failures a
 * C program tests for, said once as a divergence.
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

/** _spawn's modes: _P_WAIT, _P_NOWAIT, _P_OVERLAY, _P_NOWAITO, _P_DETACH. */
const SPAWN_MODES = 5;

/**
 * @typedef {Object} ProcessHost
 * @property {(code: number) => void} errno
 * @property {(api: string, detail: string) => void} [divergence]
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

    const noProcess = refuse('_spawnl', {
        argBytes: 8 + VARIADIC_SLOTS * 4,
        answer: 0xffffffff,
        lastError: ENOENT,
        why: 'no second process can be started from the runtime',
    });

    return {
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
         * runtime checks them; anything else is -1 and ENOENT -- no process
         * is started.
         */
        _spawnl: {
            convention: 'cdecl',
            argBytes: 8 + VARIADIC_SLOTS * 4,
            /** @param {number[]} args */
            handler: ([mode, name])=>{
                if ((mode >>> 0) >= SPAWN_MODES || (name >>> 0) === 0)
                {
                    host.errno(EINVAL);
                    return 0xffffffff;
                }
                return noProcess.handler();
            },
        },
    };
}
