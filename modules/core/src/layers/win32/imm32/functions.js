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
 * @property {(code: number) => void} [setLastError]  Where a refusal says why.
 *           Without it the answers are the same and the thread's last error is
 *           left as it was.
 * @property {(hwnd: number, message: number, wParam: number, lParam: number)
 *           => number | Promise<number>} [sendMessage]
 *           SendMessage, for ImmIsUIMessage handing an IME message on to the
 *           window it names. Absent, the message is only classified.
 */

/** What a call on an input context answers in the last error when it was handed none. */
const ERROR_INVALID_HANDLE = 6;

/**
 * The messages an input method's own window handles: the composition's
 * start, progress and end, and the context, notification, overflow and
 * selection messages, with the system one the IME window is sent besides.
 */
const IME_UI_MESSAGES = new Set([
    0x010d, // WM_IME_STARTCOMPOSITION
    0x010e, // WM_IME_ENDCOMPOSITION
    0x010f, // WM_IME_COMPOSITION
    0x0281, // WM_IME_SETCONTEXT
    0x0282, // WM_IME_NOTIFY
    0x0284, // WM_IME_COMPOSITIONFULL
    0x0285, // WM_IME_SELECT
    0x0287, // WM_IME_SYSTEM
]);

/**
 * @param {ImmHost} host
 */
export function createImmFunctions(host){
    /**
     * A call that changes an input context, refused for the handle it was
     * given: ImmGetContext hands out none, so a null one is no context and any
     * other is not one of ours, and Windows answers FALSE with
     * ERROR_INVALID_HANDLE for both.
     *
     * @param {number} argBytes
     */
    const noContext = argBytes=>({
        argBytes,
        handler: ()=>{
            host.setLastError?.(ERROR_INVALID_HANDLE);
            return 0;
        },
    });

    /**
     * ImmGetCompositionString for either width: nothing is being composed, so
     * every part of the composition is zero bytes long and the buffer is not
     * touched. A null context leaves the last error as it was; a handle that
     * is not one of ours sets ERROR_INVALID_HANDLE, as Windows does.
     */
    const compositionString = {
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([himc])=>{
            if ((himc >>> 0) !== 0)
            {
                host.setLastError?.(ERROR_INVALID_HANDLE);
            }
            return 0;
        },
    };

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

        /**
         * LONG ImmGetCompositionStringA(HIMC hIMC, DWORD dwIndex, LPVOID lpBuf, DWORD dwBufLen)
         * LONG ImmGetCompositionStringW(HIMC, DWORD, LPVOID, DWORD)
         */
        ImmGetCompositionStringA: compositionString,
        ImmGetCompositionStringW: compositionString,

        /**
         * BOOL ImmSetCompositionFontA(HIMC hIMC, LPLOGFONTA lplf)
         * BOOL ImmSetCompositionFontW(HIMC hIMC, LPLOGFONTW lplf)
         *
         * A program sets the font its composition window would draw in; there
         * is no window to draw, and no context to keep the font in.
         */
        ImmSetCompositionFontA: noContext(8),
        ImmSetCompositionFontW: noContext(8),

        /**
         * BOOL ImmSetCompositionWindow(HIMC hIMC, LPCOMPOSITIONFORM lpCompForm)
         *
         * Where the composition window would stand, refused as the font is.
         */
        ImmSetCompositionWindow: noContext(8),

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
        ImmSetOpenStatus: noContext(8),

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

        /**
         * HWND ImmGetDefaultIMEWnd(HWND hWnd)
         *
         * The window an input method draws its composition in. None runs
         * here, so there is none: NULL, as on a Windows with no IME loaded.
         */
        ImmGetDefaultIMEWnd: { argBytes: 4, handler: ()=>0 },

        /**
         * BOOL ImmSetCandidateWindow(HIMC hIMC, LPCANDIDATEFORM lpCandidate)
         *
         * Where the candidate list would stand: refused for the context, as
         * the composition window's place is.
         */
        ImmSetCandidateWindow: noContext(8),

        /**
         * BOOL ImmSetCompositionStringA(HIMC hIMC, DWORD dwIndex, LPVOID lpComp,
         *   DWORD dwCompLen, LPVOID lpRead, DWORD dwReadLen)
         */
        ImmSetCompositionStringA: noContext(24),
        ImmSetCompositionStringW: noContext(24),

        /**
         * BOOL ImmGetCompositionFontA(HIMC hIMC, LPLOGFONTA lplf), and the W form
         *
         * The context's font: no context is handed out, so there is none to
         * read, refused as the other calls on a context are.
         */
        ImmGetCompositionFontA: noContext(8),
        ImmGetCompositionFontW: noContext(8),

        /**
         * UINT ImmGetIMEFileNameA(HKL hKL, LPSTR lpszFileName, UINT uBufLen), and
         * the W form
         *
         * The input method's file. A layout that is none has no file: zero
         * characters, as for its description.
         */
        ImmGetIMEFileNameA: { argBytes: 12, handler: ()=>0 },
        ImmGetIMEFileNameW: { argBytes: 12, handler: ()=>0 },

        /**
         * LRESULT ImmEscapeA(HKL hKL, HIMC hIMC, UINT uEscape, LPVOID lpData)
         *
         * A request to the input method a layout is. No layout is one, so no
         * escape is supported: zero.
         */
        ImmEscapeA: { argBytes: 16, handler: ()=>0 },

        /**
         * DWORD ImmGetCandidateListCountW(HIMC hIMC, LPDWORD lpdwListCount)
         *
         * The A form's answer: no lists, and the count written as zero.
         */
        ImmGetCandidateListCountW: {
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

        /** DWORD ImmGetCandidateListW(HIMC, DWORD, LPCANDIDATELIST, DWORD) */
        ImmGetCandidateListW: { argBytes: 16, handler: ()=>0 },

        /**
         * UINT ImmGetDescriptionA(HKL hKL, LPSTR lpszDescription, UINT uBufLen)
         *
         * The input method's name. A layout that is none has no name: zero
         * characters, and the buffer untouched.
         */
        ImmGetDescriptionA: { argBytes: 12, handler: ()=>0 },

        /**
         * DWORD ImmGetProperty(HKL hKL, DWORD fdwIndex)
         *
         * The input method's properties, version and capabilities: none of
         * any, for a layout that is a plain keyboard.
         */
        ImmGetProperty: { argBytes: 8, handler: ()=>0 },

        /**
         * BOOL ImmIsUIMessageA(HWND hWndIME, UINT msg, WPARAM wParam, LPARAM lParam)
         *
         * Whether a message is one an input method's window handles -- and,
         * given such a window, the message sent on to it. TRUE for the IME
         * messages and FALSE for the rest, whether or not a window was given.
         */
        ImmIsUIMessageA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam])=>{
                if (!IME_UI_MESSAGES.has(message >>> 0))
                {
                    return 0;
                }
                if ((hwnd >>> 0) !== 0 && host.sendMessage)
                {
                    const sent = host.sendMessage(hwnd >>> 0, message >>> 0, wParam >>> 0,
                        lParam >>> 0);
                    return sent instanceof Promise ? sent.then(()=>1) : 1;
                }
                return 1;
            },
        },
    };
}
