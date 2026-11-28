/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One control's window procedure in a 64-bit process, with no window
 * manager around it: its guest reaches every address (past 4 GiB too), the
 * blocks it allocates are past 4 GiB so every pointer it hands its parent
 * has a high dword, and the parent's answers are the test's. What it asks of
 * its host or toolkit beyond that answers nothing, as a control that cannot
 * draw: a test of what a 64-bit structure carries, not of how it looks.
 */

import { recordingGuest } from '../common/guest.fixture.js';

/** Where the control's own blocks begin: past 4 GiB. */
export const HIGH = 0x3_0000_0000;

/**
 * @param {(host: any, tk: any) => (record: any, message: any, thread?: unknown) => any} build
 * @param {(hwnd: number, message: number, wParam: number, lParam: number) => number | undefined}
 *     [answer]  the parent's answer to what the control sends it
 * @param {Record<string, unknown>} [more]  what else the host does, for this control
 */
export function wideControl(build, answer = ()=>undefined, more = {}){
    const { guest, plant } = recordingGuest({ pointerSize: 8 });
    let next = HIGH + 0x10_0000;
    /** @type {{ hwnd: number, message: number, wParam: number, lParam: number }[]} */
    const sent = [];
    const host = {
        guest,
        draw: null,
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += (size + 15) & ~15;
            return at;
        },
        release: ()=>{},
        /** @param {number} hwnd @param {number} message @param {number} wParam @param {number} lParam */
        send: (hwnd, message, wParam, lParam)=>{
            sent.push({ hwnd, message, wParam, lParam });
            return answer(hwnd, message, wParam, lParam) ?? 0;
        },
        live: ()=>null,
        windowOf: ()=>null,
        clientSize: ()=>({ width: 200, height: 30 }),
        invalidate: ()=>{},
        children: ()=>[],
        sysColor: ()=>0,
        ...more,
    };
    const tk = {
        stateOf: (/** @type {any} */ record)=>(record.held ??= {}),
        common: ()=>0,
        painting: ()=>0,
        clientRect: ()=>({ left: 0, top: 0, right: 200, bottom: 30 }),
        color: ()=>0,
    };
    const procedure = build(host, tk);
    const record = { hwnd: 0x10010, parent: 0x10020, id: 7, style: 0, held: undefined };
    /** @param {number} message @param {number} wParam @param {number} lParam */
    const send = (message, wParam, lParam)=>procedure(record, { hwnd: record.hwnd, message,
        wParam, lParam });
    /** A wide string at an address. @param {number} address @param {string} text */
    const putWide = (address, text)=>plant(address,
        [...`${text}\0`].flatMap(unit=>[unit.charCodeAt(0) & 0xff, unit.charCodeAt(0) >>> 8]));
    return { guest, plant, putWide, sent, send, record, host };
}
