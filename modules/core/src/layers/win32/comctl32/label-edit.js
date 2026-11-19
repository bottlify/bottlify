/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Editing an item's label in place: one mechanism for every control that has
 * it (a tree view's TVM_EDITLABEL, a list view's LVM_EDITLABEL).
 *
 * The edit is a Unicode Edit window, a child of the control over the label,
 * holding at most MAX_PATH - 1 characters as it is typed. The control's
 * "begin" notification goes to the parent once the edit exists - a parent may
 * reach it through the control's GETEDITCONTROL and change its text - and a
 * parent that answers it nonzero refuses the edit, which is destroyed. The
 * edit then takes the focus with its text selected.
 *
 * The edit ends on Enter (kept) or Escape (dropped), through the subclass
 * comctl32 hangs on it, and on the focus leaving it: the control is told so
 * by the edit's EN_KILLFOCUS and keeps the text. The "end" notification sees
 * the edit still alive; it is destroyed after, and the focus it held goes
 * back to the control.
 */

import {
    WM_KEYDOWN, WM_GETDLGCODE, WM_SETTEXT, after,
} from '../user32/controls.js';
import { encodeAnsi } from '../kernel32/locale.js';

/** The most a label is: MAX_PATH with its terminator. */
export const LABEL_ROOM = 260;

const WM_NCDESTROY = 0x0082;
const EM_SETSEL = 0x00b1;
const EM_LIMITTEXT = 0x00c5;
const EN_KILLFOCUS = 0x0200;
const VK_RETURN = 0x0d;
const VK_ESCAPE = 0x1b;
const DLGC_WANTARROWS = 0x0001;
const DLGC_WANTALLKEYS = 0x0004;

const SW_SHOW = 5;

const WS_CHILD = 0x40000000;
const WS_BORDER = 0x00800000;
const ES_AUTOHSCROLL = 0x0080;

/** The id the label edit's subclass is installed under. */
const LABEL_SUBCLASS = 0x4c45;

/**
 * @typedef {Object} LabelEditStart
 * @property {string} text  The label as it stands.
 * @property {{ x: number, y: number, width: number, height: number }} rect
 *     Where the edit goes, in the control's client coordinates.
 * @property {(edit: number) => number | Promise<number>} begin
 *     The control's begin notification; nonzero refuses the edit.
 * @property {(text: string | null) => unknown} end
 *     The control's end notification and what follows it: the text typed,
 *     or null for an edit dropped.
 */

/**
 * @param {import('../user32/controls.js').ControlHost} host
 * @param {any} tk  The drawing helpers: a control's state lives in them.
 * @param {import('./updown.js').Subclassing} [subclassing]  Absent, Enter and
 *     Escape are the edit's own and only the focus leaving it ends it.
 */
export function createLabelEditing(host, tk, subclassing){
    /** @param {any} record */
    const held = record=>tk.stateOf(record);

    /** @type {number} */
    let labelProc = 0;

    /** The edit a control has open, or 0. @param {any} record */
    const editOf = record=>{
        const edit = held(record).labelEdit;
        return edit && host.live(edit.hwnd) ? edit.hwnd : 0;
    };

    /**
     * Ends the edit a control has open, keeping its text or not.
     *
     * @param {any} record @param {boolean} keep @param {unknown} [thread]
     * @returns {unknown}
     */
    const finish = (record, keep, thread)=>{
        const state = held(record);
        const edit = state.labelEdit;
        if (!edit || edit.ending)
        {
            return 0;
        }
        edit.ending = true;
        const text = keep
            ? String(host.live(edit.hwnd)?.title ?? '').slice(0, LABEL_ROOM - 1) : null;
        return after(/** @type {any} */ (edit.end(text)), ()=>{
            const focused = host.focus() === edit.hwnd;
            return after(focused ? host.setFocus(record.hwnd, thread) : 0, ()=>{
                state.labelEdit = null;
                return after(host.destroy?.(edit.hwnd) ?? 0, ()=>0);
            });
        });
    };

    /**
     * The edit's subclass: Enter keeps the text, Escape drops it, and it
     * asks for every key so a dialog does not take them.
     *
     * @param {number[]} args  The SUBCLASSPROC's: hwnd, message, wParam, lParam, id, data.
     */
    const labelMessage = ([hwnd, message, wParam, lParam, id, data])=>{
        const { call, callerThread } = /** @type {import('./updown.js').Subclassing} */ (
            subclassing);
        const control = host.live(data);
        switch (message >>> 0){
            case WM_KEYDOWN: {
                const key = wParam >>> 0;
                if (control && (key === VK_RETURN || key === VK_ESCAPE))
                {
                    return after(finish(control, key === VK_RETURN, callerThread?.()),
                        ()=>0);
                }
                break;
            }
            case WM_GETDLGCODE:
                return DLGC_WANTARROWS | DLGC_WANTALLKEYS;
            case WM_NCDESTROY:
                call('RemoveWindowSubclass', [hwnd, labelProc, id]);
                break;
            default:
                break;
        }
        return call('DefSubclassProc', [hwnd, message, wParam, lParam]);
    };

    /**
     * Opens an edit over a label, ending one already open first.
     *
     * @param {any} record @param {LabelEditStart} start @param {unknown} [thread]
     * @returns {number | Promise<number>} the edit, 0 when refused
     */
    const begin = (record, start, thread)=>after(/** @type {any} */ (finish(record, true,
        thread)), ()=>{
        if (!host.popup)
        {
            return 0;
        }
        const style = WS_CHILD | WS_BORDER | ES_AUTOHSCROLL;
        return after(host.popup('Edit', start.rect, record.hwnd, 0, style, thread, 0, true),
            hwnd=>{
                const edit = hwnd >>> 0;
                if (edit === 0)
                {
                    return 0;
                }
                const state = held(record);
                state.labelEdit = { hwnd: edit, end: start.end, ending: false };
                return after(setText(edit, start.text, thread), ()=>after(
                    host.send(edit, EM_LIMITTEXT, LABEL_ROOM - 1, 0, thread), ()=>{
                        if (subclassing)
                        {
                            labelProc ||= subclassing.procedure('label edit', labelMessage);
                            subclassing.call('SetWindowSubclass', [edit, labelProc,
                                LABEL_SUBCLASS, record.hwnd]);
                        }
                        return after(start.begin(edit), refused=>{
                            if (refused !== 0)
                            {
                                state.labelEdit = null;
                                return after(host.destroy?.(edit) ?? 0, ()=>0);
                            }
                            return after(host.show?.(edit, SW_SHOW) ?? 0, ()=>after(
                                host.setFocus(edit, thread), ()=>after(
                                    host.send(edit, EM_SETSEL, 0, -1, thread), ()=>edit)));
                        });
                    }));
            });
    });

    /**
     * Hands the edit its first text, as a program would.
     *
     * @param {number} edit @param {string} text @param {unknown} [thread]
     */
    const setText = (edit, text, thread)=>{
        const bytes = encodeAnsi(`${text}\0`);
        const at = host.allocate?.(bytes.length) ?? 0;
        if (at === 0)
        {
            host.divergence?.('label edit', 'no memory to hand the edit the label\'s text');
            return 0;
        }
        host.writeMemory(at, bytes);
        return after(host.send(edit, WM_SETTEXT, 0, at, thread), ()=>{
            host.release?.(at);
            return 0;
        });
    };

    /**
     * A WM_COMMAND the control was sent: its edit losing the focus ends the
     * edit with the text kept; any other is not the edit's.
     *
     * @param {any} record @param {number} wParam @param {number} lParam
     * @param {unknown} [thread]
     * @returns {unknown}
     */
    const command = (record, wParam, lParam, thread)=>{
        const edit = held(record).labelEdit;
        if (edit && (wParam >>> 16) === EN_KILLFOCUS && (lParam >>> 0) === edit.hwnd)
        {
            return after(/** @type {any} */ (finish(record, true, thread)), ()=>0);
        }
        return 0;
    };

    return { begin, finish, command, editOf };
}
