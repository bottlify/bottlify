/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * imm32 — the input method, which this build does not have and does not need.
 *
 * A program calls these to turn the input method *off* over its own window,
 * because a game wants raw keystrokes rather than composed text. Answering
 * "there is no input method here" is therefore not a refusal but the state it
 * was asking for, and every one of these succeeds by having nothing to do.
 *
 * The one thing to get right is which of them reports a handle and which
 * reports a boolean. ImmAssociateContext answers with the *previous* context,
 * so zero means "there was none", while ImmAssociateContextEx answers TRUE or
 * FALSE -- a caller that tests the first as a boolean concludes it failed, and
 * one that tests the second as a handle concludes it succeeded and kept
 * something.
 */

/**
 * @typedef {Object} ImmHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {ImmHost} host
 */
export function createImmFunctions(host){
    return {
        /**
         * HIMC ImmAssociateContext(HWND hWnd, HIMC hIMC)
         *
         * The previous context, of which there is never one.
         */
        ImmAssociateContext: { argBytes: 8, handler: ()=>0 },

        /** BOOL ImmAssociateContextEx(HWND hWnd, HIMC hIMC, DWORD dwFlags) */
        ImmAssociateContextEx: { argBytes: 12, handler: ()=>1 },

        /**
         * HIMC ImmGetContext(HWND hWnd)
         *
         * Null, which a caller checks before doing anything else with it -- so
         * the rest of this surface is reached only by a program that did not.
         */
        ImmGetContext: { argBytes: 4, handler: ()=>0 },

        /** BOOL ImmReleaseContext(HWND hWnd, HIMC hIMC) */
        ImmReleaseContext: { argBytes: 8, handler: ()=>1 },

        /** LONG ImmGetCompositionStringA(HIMC, DWORD, LPVOID, DWORD) */
        ImmGetCompositionStringA: { argBytes: 16, handler: ()=>0 },

        /** DWORD ImmGetCandidateListA(HIMC, DWORD, LPCANDIDATELIST, DWORD) */
        ImmGetCandidateListA: { argBytes: 16, handler: ()=>0 },

        /**
         * BOOL ImmGetConversionStatus(HIMC, LPDWORD lpfdwConversion,
         *                             LPDWORD lpfdwSentence)
         *
         * Both modes are written as zero rather than left alone: a caller reads
         * them whatever the return says, and unwritten they hold its own stack.
         */
        ImmGetConversionStatus: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, conversion, sentence])=>{
                for (const out of [conversion, sentence])
                {
                    if ((out >>> 0) !== 0)
                    {
                        host.writeMemory(out >>> 0, new Uint8Array(4));
                    }
                }
                return 1;
            },
        },

        /**
         * BOOL ImmGetOpenStatus(HIMC hIMC)
         *
         * Whether the input method is composing, which it never is: FALSE is
         * the state a program checking this is hoping for, since an open IME is
         * what makes it stop treating keystrokes as its own.
         */
        ImmGetOpenStatus: { argBytes: 4, handler: ()=>0 },

        /** BOOL ImmSetConversionStatus(HIMC, DWORD, DWORD) */
        ImmSetConversionStatus: { argBytes: 12, handler: ()=>1 },

        /** BOOL ImmNotifyIME(HIMC, DWORD, DWORD, DWORD) */
        ImmNotifyIME: { argBytes: 16, handler: ()=>1 },

        /**
         * BOOL ImmDisableIME(DWORD idThread)
         *
         * No input method runs here for any thread, so turning it off for one,
         * for the process (-1) or for the caller (0) is already done.
         */
        ImmDisableIME: { argBytes: 4, handler: ()=>1 },

        /**
         * BOOL ImmIsIME(HKL hKL)
         *
         * Whether a keyboard layout is an input method editor. None is: every
         * layout here is a plain keyboard.
         */
        ImmIsIME: { argBytes: 4, handler: ()=>0 },

        /**
         * DWORD ImmGetCandidateListCountA(HIMC hIMC, LPDWORD lpdwListCount)
         *
         * The bytes the candidate lists take, and through the pointer how many
         * there are: none of either, with nothing composing. The count is written
         * rather than left, as a caller reads it whatever the size says.
         */
        ImmGetCandidateListCountA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, count])=>{
                if ((count >>> 0) !== 0)
                {
                    host.writeMemory(count >>> 0, new Uint8Array(4));
                }
                return 0;
            },
        },

        /**
         * BOOL ImmSetOpenStatus(HIMC hIMC, BOOL fOpen)
         *
         * Opening or closing a context's input method. There is no context to
         * open one on -- ImmGetContext is null -- so, as on Windows for a null or
         * foreign handle, it fails.
         */
        ImmSetOpenStatus: { argBytes: 8, handler: ()=>0 },

        /**
         * BOOL ImmSimulateHotKey(HWND hWnd, DWORD dwHotKeyID)
         *
         * Runs an input method's hot key, of which there are none.
         */
        ImmSimulateHotKey: { argBytes: 8, handler: ()=>0 },

        /**
         * HIMC ImmCreateContext(void)
         *
         * A new input context, which needs an input method to own it. Without
         * one Windows answers NULL, and a program that asked for its own context
         * -- a window driver that wants composition of its own -- goes on without.
         */
        ImmCreateContext: { argBytes: 0, handler: ()=>0 },

        /**
         * BOOL ImmDestroyContext(HIMC hIMC)
         *
         * No context was ever handed out, so any handle given is not one.
         */
        ImmDestroyContext: { argBytes: 4, handler: ()=>0 },
    };
}
