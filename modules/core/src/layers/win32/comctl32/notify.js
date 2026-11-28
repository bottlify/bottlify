/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { after } from '../user32/controls.js';
import { struct, write } from '../../../system/layout.js';

/**
 * The window a common control tells what happened: the hWndParent it was
 * made with. For a child that is its parent; for a control made as an owned
 * window -- comctl32's tests make their controls so -- the window manager
 * keeps it as the owner, and the parent is none.
 *
 * @param {{ parent?: number, owner?: number }} record
 * @returns {number}  Zero for a control that has nobody to tell.
 */
export const notifyWindow = record=>(record.parent || record.owner || 0) >>> 0;

/** commctrl.h's NMHDR: whom a notification is from, its id, and its code. */
export const NMHDR = struct([['hwndFrom', 'handle'], ['idFrom', 'ptr'], ['code', 'i32']]);

const WM_NOTIFY = 0x004e;

/**
 * Tells `to` with WM_NOTIFY: `size` bytes in guest memory, zeroed, that
 * start with the control's NMHDR at the process's width and that `fill`
 * fills, there while it is answered and handed to `read` before they go.
 * Nothing is sent, and 0 answered, with nobody to tell or no memory.
 *
 * @param {{ guest: import('../common/guest.js').Guest,
 *     allocate?: (size: number) => number, release?: (address: number) => void,
 *     send: import('../user32/controls.js').ControlHost['send'] }} host
 * @param {{ hwnd: number, id: number }} record @param {number} to
 * @param {number} code @param {number} size @param {unknown} thread
 * @param {(block: number) => void} [fill] @param {(block: number) => void} [read]
 * @returns {number | Promise<number>}
 */
export function sendNotify(host, record, to, code, size, thread, fill, read){
    const { guest } = host;
    const block = to !== 0 ? host.allocate?.(size) ?? 0 : 0;
    if (block === 0)
    {
        return 0;
    }
    const header = NMHDR.at(guest.pointerSize);
    guest.fill(block, 0, size);
    write(guest, block, header, 'hwndFrom', record.hwnd);
    write(guest, block, header, 'idFrom', record.id);
    write(guest, block, header, 'code', code);
    fill?.(block);
    return after(host.send(to, WM_NOTIFY, record.id, block, thread), answer=>{
        read?.(block);
        host.release?.(block);
        return answer;
    });
}
