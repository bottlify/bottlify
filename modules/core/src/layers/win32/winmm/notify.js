/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How a wave device tells its caller a buffer came back.
 *
 * `waveOutOpen` takes the answer to that question as flags, and the answer is
 * not decoration: a program that asked to be called does not poll, so a build
 * that accepts the request and never honours it leaves the program waiting for
 * something that cannot arrive.
 *
 * The four forms are genuinely different destinations rather than four spellings
 * of one, which is why they are dispatched here and not by the queue that
 * produces the notices: only this file needs to know what a window, a thread, a
 * function pointer and an event each are.
 *
 * The function form is the one that costs. Running guest code from a host
 * handler means parking the thread that called, so this hands back the bridge's
 * promise and the caller -- the winmm entry point that retired the buffer --
 * returns it, which is the only way a handler can wait. The other three forms
 * are host-side bookkeeping and return nothing, so nothing is parked for them.
 */

/** fdwOpen & CALLBACK_TYPEMASK. */
const CALLBACK_NULL = 0x00000000;
const CALLBACK_WINDOW = 0x00010000;
const CALLBACK_THREAD = 0x00020000;
const CALLBACK_FUNCTION = 0x00030000;
const CALLBACK_EVENT = 0x00050000;

/**
 * @typedef {Object} WaveNotice
 * @property {number} kind      Which of the forms above the caller asked for.
 * @property {number} target    A window, a thread, a function or an event.
 * @property {number} instance  dwInstance, the caller's own cookie.
 * @property {number} device    The HWAVEOUT this is about.
 * @property {number} message   MM_WOM_OPEN, MM_WOM_DONE or MM_WOM_CLOSE.
 * @property {number} param     The WAVEHDR for MM_WOM_DONE, zero otherwise.
 */

/**
 * @param {Object} deps
 * @param {(entry: number, args: number[]) => Promise<number>} deps.callGuest
 *        Calls a guest routine and answers when it returns.
 * @param {(message: { hwnd: number, message: number,
 *                     wParam: number, lParam: number }) => void} deps.post
 * @param {(handle: number) => void} deps.signal  Sets an event, by handle.
 * @returns {(notice: WaveNotice) => void | Promise<number>}
 */
export function createWaveNotifier({ callGuest, post, signal }){
    return notice=>{
        switch (notice.kind)
        {
            case CALLBACK_WINDOW:
                post({
                    hwnd: notice.target,
                    message: notice.message,
                    // The window form carries the device and the header in the
                    // two message parameters; the instance is not passed at all,
                    // because a window procedure has nowhere to put it.
                    wParam: notice.device,
                    lParam: notice.param,
                });
                return;

            case CALLBACK_THREAD:
                // A thread message, which is a posted message with no window.
                // The queue here is the process's rather than one per thread, so
                // this reaches whoever is pumping -- which for the programs that
                // use this form is the thread that asked.
                post({
                    hwnd: 0,
                    message: notice.message,
                    wParam: notice.device,
                    lParam: notice.param,
                });
                return;

            case CALLBACK_FUNCTION:
                // void CALLBACK waveOutProc(HWAVEOUT, UINT, DWORD_PTR dwInstance,
                //                           DWORD_PTR dwParam1, DWORD_PTR dwParam2)
                return callGuest(notice.target,
                    [notice.device, notice.message, notice.instance, notice.param, 0]);

            case CALLBACK_EVENT:
                // The event form says nothing about which buffer: a program that
                // uses it is woken and then reads the flags itself.
                signal(notice.target);
                return;

            case CALLBACK_NULL:
            default:
                // Including the forms this build has no destination for. A
                // caller that asked for nothing is not owed anything.
                return;
        }
    };
}
