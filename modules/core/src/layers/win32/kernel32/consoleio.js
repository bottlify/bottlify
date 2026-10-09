/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The console *device*: what a program asks about the standard handles beyond
 * reading and writing them.
 *
 * There is no console here, and the shape of that absence is chosen rather than
 * accidental. The standard handles exist and accept bytes -- WriteFile through
 * them reaches the log -- so this build looks exactly like a program whose
 * output was redirected to a file: a real, ordinary Windows configuration that
 * every C runtime already knows how to handle.
 *
 * That is why GetConsoleMode fails. A runtime calls it to decide whether to
 * line-buffer, and a game calls it to find out whether it was launched from a
 * console with a debugger attached. Answering yes changes both of those, and it
 * would be a claim about a console nobody can type into.
 *
 * Reading is the other half of the same answer: a redirected stream at end of
 * input. ReadConsole reports zero characters and succeeds, the input queue is
 * empty, and a program polling it gets a stable no rather than a wait.
 */

import { decodeAnsi } from './locale.js';
import { createRefusals } from '../common/refusal.js';

/** Codes this surface reports. */
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;

/** The code page a console would report. Ours matches the ANSI one. */
const CONSOLE_CODE_PAGE = 1252;

/**
 * @typedef {Object} ConsoleIoHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {(handle: number, text: string) => void} write  Where output goes.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {ConsoleIoHost} host
 */
export function createConsoleIoFunctions(host){
    /** @param {number} address @param {number} value */
    const writeDwordIf = (address, value)=>{
        if (address !== 0)
        {
            host.writeMemory(address, new Uint8Array([
                value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
            ]));
        }
    };

    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /**
     * The text of a write, however it was spelled. Both forms take a character
     * count rather than a byte count, so the wide one reads twice the bytes for
     * the same number -- reading the count as bytes truncates every wide write
     * to half its length. The ANSI form is in the page the console reports.
     *
     * @param {number} buffer @param {number} count @param {boolean} isWide
     */
    const textOf = (buffer, count, isWide)=>{
        const bytes = host.readMemory(buffer, count * (isWide ? 2 : 1));
        if (!isWide)
        {
            return decodeAnsi(bytes);
        }
        let text = '';
        for (let at = 0; at < count; at++)
        {
            text += String.fromCharCode(bytes[at * 2] | bytes[at * 2 + 1] << 8);
        }
        return text;
    };

    /**
     * Both WriteConsole forms.
     *
     * These succeed, where GetConsoleMode fails, and the two are not in
     * conflict: whether a handle is a console and whether it will take bytes
     * are different questions, and this one is already answered yes by
     * WriteFile through the same handle. Refusing the same bytes through a
     * second entry point would drop what a program chose to say.
     *
     * @param {number[]} args @param {boolean} isWide
     */
    const writeConsole = ([handle, buffer, count, written], isWide)=>{
        if (buffer === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const characters = count >>> 0;
        if (characters > 0)
        {
            host.write(handle >>> 0, textOf(buffer >>> 0, characters, isWide));
        }
        writeDwordIf(written >>> 0, characters);
        return 1;
    };

    /**
     * Both ReadConsole forms, and both ReadConsoleInput forms: end of input.
     *
     * @param {number} read  Where the count of what was read goes.
     */
    const readNothing = read=>{
        writeDwordIf(read >>> 0, 0);
        return 1;
    };

    const refuse = createRefusals(host);
    /**
     * A call on the console's screen buffer or its input queue, which no
     * handle here is: refused as Windows refuses a handle that is not one.
     *
     * @param {string} name @param {number} argBytes
     */
    const noConsole = (name, argBytes)=>refuse(name, {
        argBytes, lastError: ERROR_INVALID_HANDLE,
        why: 'no handle is a console here; the standard handles are redirected streams',
    });

    return {
        /** UINT GetConsoleCP(VOID) */
        GetConsoleCP: { argBytes: 0, handler: ()=>CONSOLE_CODE_PAGE },

        /** UINT GetConsoleOutputCP(VOID) */
        GetConsoleOutputCP: { argBytes: 0, handler: ()=>CONSOLE_CODE_PAGE },

        /**
         * BOOL GetConsoleMode(HANDLE hConsoleHandle, LPDWORD lpMode)
         *
         * Always fails, and the failure is the answer -- see the note at the
         * top. The mode is left untouched: a caller that ignores the return
         * value and reads its variable anyway finds what it put there, not a
         * mode this build invented.
         */
        GetConsoleMode: {
            argBytes: 8,
            handler: ()=>fail(ERROR_INVALID_HANDLE),
        },

        /** BOOL SetConsoleMode(HANDLE hConsoleHandle, DWORD dwMode) */
        SetConsoleMode: {
            argBytes: 8,
            handler: ()=>fail(ERROR_INVALID_HANDLE),
        },

        /**
         * BOOL GetConsoleScreenBufferInfo(HANDLE, PCONSOLE_SCREEN_BUFFER_INFO)
         *
         * No handle is a console's screen buffer, for the reason GetConsoleMode
         * fails.
         */
        GetConsoleScreenBufferInfo: {
            argBytes: 8,
            handler: ()=>fail(ERROR_INVALID_HANDLE),
        },

        /** BOOL SetConsoleCursorPosition(HANDLE, COORD), the COORD by value: the same. */
        SetConsoleCursorPosition: {
            argBytes: 8,
            handler: ()=>fail(ERROR_INVALID_HANDLE),
        },

        /**
         * BOOL SetConsoleCP(UINT wCodePageID) and SetConsoleOutputCP: the one
         * page there is is taken, any other refused.
         */
        SetConsoleCP: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([page])=>((page >>> 0) === CONSOLE_CODE_PAGE ? 1
                : fail(ERROR_INVALID_PARAMETER)),
        },
        SetConsoleOutputCP: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([page])=>((page >>> 0) === CONSOLE_CODE_PAGE ? 1
                : fail(ERROR_INVALID_PARAMETER)),
        },

        /**
         * BOOL AllocConsole(void) and FreeConsole(void): there is no console
         * to make, and none to leave -- leaving it is what the process already
         * has done, so that succeeds.
         */
        AllocConsole: {
            argBytes: 0,
            handler: ()=>{
                host.divergence?.('AllocConsole', 'refused: there is no console to make, '
                    + 'and output stays where the standard handles send it');
                return fail(ERROR_ACCESS_DENIED);
            },
        },
        FreeConsole: { argBytes: 0, handler: ()=>1 },

        /** HWND GetConsoleWindow(void): there is no console, so no window of one */
        GetConsoleWindow: { argBytes: 0, handler: ()=>0 },

        /**
         * BOOL SetConsoleCtrlHandler(PHANDLER_ROUTINE HandlerRoutine, BOOL Add)
         *
         * Accepted and remembered by nobody. The handler runs on Ctrl+C, a
         * close request or a logoff, and none of those three can reach this
         * process; a program installs one defensively and never hears from it,
         * which is exactly what happens here.
         */
        SetConsoleCtrlHandler: {
            argBytes: 8,
            handler: ()=>1,
        },

        /** BOOL WriteConsoleA(HANDLE, const VOID *, DWORD, LPDWORD, LPVOID) */
        WriteConsoleA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>writeConsole(args, false),
        },

        /** BOOL WriteConsoleW(HANDLE, const VOID *, DWORD, LPDWORD, LPVOID) */
        WriteConsoleW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>writeConsole(args, true),
        },

        /** BOOL ReadConsoleA(HANDLE, LPVOID, DWORD, LPDWORD, LPVOID) */
        ReadConsoleA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, , , read])=>readNothing(read),
        },

        /** BOOL ReadConsoleW(HANDLE, LPVOID, DWORD, LPDWORD, LPVOID) */
        ReadConsoleW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, , , read])=>readNothing(read),
        },

        /**
         * BOOL ReadConsoleInputA(HANDLE, PINPUT_RECORD, DWORD, LPDWORD)
         *
         * Zero records read. On Windows this blocks until something arrives;
         * here nothing ever will, so blocking would be a hang and reporting an
         * empty read sends the caller round its loop instead.
         */
        ReadConsoleInputA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, , , read])=>readNothing(read),
        },

        /** BOOL ReadConsoleInputW(HANDLE, PINPUT_RECORD, DWORD, LPDWORD) */
        ReadConsoleInputW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, , , read])=>readNothing(read),
        },

        /** BOOL PeekConsoleInputA(HANDLE, PINPUT_RECORD, DWORD, LPDWORD) */
        PeekConsoleInputA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, , , read])=>readNothing(read),
        },

        /**
         * BOOL FlushConsoleInputBuffer(HANDLE hConsoleInput)
         *
         * The queue the reads above find empty is empty after a flush too,
         * so there is nothing to discard and the call succeeds as they do.
         */
        FlushConsoleInputBuffer: { argBytes: 4, handler: ()=>1 },

        /**
         * BOOL WriteConsoleInputA/W(HANDLE, const INPUT_RECORD *, DWORD, LPDWORD)
         *
         * Refused: records put in a queue no read ever returns would be lost
         * while the caller believed them delivered.
         */
        WriteConsoleInputA: noConsole('WriteConsoleInputA', 16),
        WriteConsoleInputW: noConsole('WriteConsoleInputW', 16),

        /**
         * The screen buffer's own calls, refused as GetConsoleScreenBufferInfo
         * is: BOOL ReadConsoleOutputCharacterA/W(HANDLE, LPSTR, DWORD, COORD,
         * LPDWORD), BOOL SetConsoleScreenBufferSize(HANDLE, COORD), BOOL
         * SetConsoleTextAttribute(HANDLE, WORD), BOOL SetConsoleWindowInfo(
         * HANDLE, BOOL, const SMALL_RECT *) and COORD
         * GetLargestConsoleWindowSize(HANDLE), whose failure is the COORD
         * {0, 0} in EAX. A COORD by value is one stack slot.
         */
        ReadConsoleOutputCharacterA: noConsole('ReadConsoleOutputCharacterA', 20),
        ReadConsoleOutputCharacterW: noConsole('ReadConsoleOutputCharacterW', 20),
        SetConsoleScreenBufferSize: noConsole('SetConsoleScreenBufferSize', 8),
        SetConsoleTextAttribute: noConsole('SetConsoleTextAttribute', 8),
        SetConsoleWindowInfo: noConsole('SetConsoleWindowInfo', 12),
        GetLargestConsoleWindowSize: noConsole('GetLargestConsoleWindowSize', 4),

        /**
         * BOOL SetConsoleTitleA/W(LPCSTR lpConsoleTitle), DWORD GetConsoleTitleA/W(
         * LPSTR lpConsoleTitle, DWORD nSize) -- a length, zero when it fails -- and BOOL
         * WriteConsoleOutputCharacterA/W(HANDLE, LPCSTR, DWORD, COORD, LPDWORD):
         * refused as a process with no console of its own is refused.
         */
        SetConsoleTitleA: noConsole('SetConsoleTitleA', 4),
        SetConsoleTitleW: noConsole('SetConsoleTitleW', 4),
        GetConsoleTitleA: noConsole('GetConsoleTitleA', 8),
        GetConsoleTitleW: noConsole('GetConsoleTitleW', 8),
        WriteConsoleOutputCharacterA: noConsole('WriteConsoleOutputCharacterA', 20),
        WriteConsoleOutputCharacterW: noConsole('WriteConsoleOutputCharacterW', 20),

        /** BOOL GetNumberOfConsoleInputEvents(HANDLE, LPDWORD lpcNumberOfEvents) */
        GetNumberOfConsoleInputEvents: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, count])=>{
                if (count === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDwordIf(count >>> 0, 0);
                return 1;
            },
        },
    };
}
