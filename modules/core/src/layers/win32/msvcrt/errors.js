/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * errno and _doserrno through their functions, and what an errno says.
 *
 * The messages are the runtime's own, at the numbers its errno.h gives them
 * -- a program shows them to a user, compares them, or measures a buffer for
 * one -- and a number without one is "Unknown error", as the runtime answers.
 */

import { EINVAL } from './globals.js';

/**
 * @typedef {Object} ErrorHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {() => number} errno  The calling thread's errno.
 * @property {(code: number) => void} setErrno
 * @property {() => number} doserrno
 * @property {(code: number) => void} setDoserrno
 */

/** The runtime's messages, by errno: `_sys_errlist`. */
const MESSAGES = [
    'No error', 'Operation not permitted', 'No such file or directory', 'No such process',
    'Interrupted function call', 'Input/output error', 'No such device or address',
    'Arg list too long', 'Exec format error', 'Bad file descriptor', 'No child processes',
    'Resource temporarily unavailable', 'Not enough space', 'Permission denied', 'Bad address',
    'Unknown error', 'Resource device', 'File exists', 'Improper link', 'No such device',
    'Not a directory', 'Is a directory', 'Invalid argument', 'Too many open files in system',
    'Too many open files', 'Inappropriate I/O control operation', 'Unknown error',
    'File too large', 'No space left on device', 'Invalid seek', 'Read-only file system',
    'Too many links', 'Broken pipe', 'Domain error', 'Result too large', 'Unknown error',
    'Resource deadlock avoided', 'Unknown error', 'Filename too long', 'No locks available',
    'Function not implemented', 'Directory not empty', 'Illegal byte sequence',
];

/** What an errno says. @param {number} code */
export const messageOf = code=>MESSAGES[code] ?? 'Unknown error';

/** The longest message and its terminator: the one buffer strerror returns. */
const MESSAGE_ROOM = Math.max(...MESSAGES.map(message=>message.length)) + 1;

/**
 * @param {ErrorHost} host
 */
export function createErrorFunctions(host){
    /** @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        host.writeMemory(pointer, Uint8Array.from(`${text}\0`, character=>character
            .charCodeAt(0)));
    };

    /** @param {number} pointer @param {number} value */
    const writeInt = (pointer, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(pointer, bytes);
    };

    /**
     * The buffer strerror answers with, written over by the next call, as
     * its documentation says -- so a caller that copies it out at once,
     * which is all correct code, cannot tell it from the runtime's own.
     */
    let messageBuffer = 0;

    /**
     * errno_t _get_errno(int *value) and _get_doserrno: no pointer is EINVAL,
     * errno left as it was for the caller to read.
     *
     * @param {() => number} read
     */
    const getter = read=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return EINVAL;
            }
            writeInt(pointer, read());
            return 0;
        },
    });

    /**
     * errno_t _set_errno(int value) and _set_doserrno.
     *
     * @param {(code: number) => void} write
     */
    const setter = write=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [value])=>{
            write(value | 0);
            return 0;
        },
    });

    return {
        _get_errno: getter(host.errno),
        _set_errno: setter(host.setErrno),
        _get_doserrno: getter(host.doserrno),
        _set_doserrno: setter(host.setDoserrno),

        /** char *strerror(int errnum) */
        strerror: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                if (messageBuffer === 0)
                {
                    messageBuffer = host.allocate(MESSAGE_ROOM);
                }
                if (messageBuffer !== 0)
                {
                    writeString(messageBuffer, messageOf(code | 0));
                }
                return messageBuffer;
            },
        },

        /**
         * errno_t strerror_s(char *buffer, size_t size, int errnum)
         *
         * The message cut to what the buffer holds, which is no error: no
         * buffer or a size of zero is EINVAL, nothing written.
         */
        strerror_s: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([buffer, size, code])=>{
                const room = size >>> 0;
                if ((buffer >>> 0) === 0 || room === 0)
                {
                    host.setErrno(EINVAL);
                    return EINVAL;
                }
                writeString(buffer, messageOf(code | 0).slice(0, room - 1));
                return 0;
            },
        },
    };
}
