/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MessageBox: a modal dialog on the program's own desktop.
 *
 * On Windows the box is a dialog user32 makes for itself -- a template of a
 * static for the text and a push button per answer, run by DialogBox with a
 * dialog procedure of user32's own that sizes it to its text and ends it on a
 * button. It is made the same way here, out of the same calls, so it is a
 * window like any other: drawn on the desktop the program draws on, above its
 * owner, which it disables while it is up, answering Enter, Escape and Tab as
 * the dialog manager does, and a program that looks for it -- FindWindow on
 * `#32770`, a CBT hook that renames its buttons -- finds it there.
 *
 * Nobody at the screen (`unattended`), there is no window: the box is put to
 * whoever answers for the run, as its dialogs are, and without an answerer its
 * default button is the answer.
 */

import { readText } from './unicode.js';
import { after } from './controls.js';

const WM_INITDIALOG = 0x0110;
const WM_COMMAND = 0x0111;
const BN_CLICKED = 0;

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CAPTION = 0x00c00000;
const WS_SYSMENU = 0x00080000;
const WS_GROUP = 0x00020000;
const WS_TABSTOP = 0x00010000;
const WS_EX_TOPMOST = 0x00000008;
const DS_MODALFRAME = 0x0080;
const DS_SETFONT = 0x0040;
const DS_NOIDLEMSG = 0x0100;
const BS_PUSHBUTTON = 0;
const BS_DEFPUSHBUTTON = 1;
const SS_LEFT = 0;
const SS_RIGHT = 2;
const SS_NOPREFIX = 0x80;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;

const MB_TYPEMASK = 0x000f;
const MB_DEFMASK = 0x0300;
const MB_HELP = 0x4000;
const MB_SYSTEMMODAL = 0x1000;
const MB_TOPMOST = 0x40000;
const MB_RIGHT = 0x80000;

/** The template's class atoms for the two system classes it names. */
const BUTTON_ATOM = 0x0080;
const STATIC_ATOM = 0x0082;

/** The message text's control, as Windows' own template numbers it. */
const TEXT_ID = 0xffff;

/** The button identifiers a message box answers with, as Windows numbers them. */
const IDOK = 1, IDCANCEL = 2, IDABORT = 3, IDRETRY = 4, IDIGNORE = 5;
const IDYES = 6, IDNO = 7, IDTRYAGAIN = 10, IDCONTINUE = 11;

/**
 * The buttons each message-box type asks for, by `uType & 0xf`, in the order
 * Windows lays them out -- which is also the order MB_DEFBUTTON counts in --
 * with the labels it puts on them. The seventh entry is MB_CANCELTRYCONTINUE,
 * whose identifiers sit at 2, 10 and 11 rather than in a run.
 */
const MESSAGE_BOX_SETS = [
    [{ id: IDOK, label: 'OK' }],
    [{ id: IDOK, label: 'OK' }, { id: IDCANCEL, label: 'Cancel' }],
    [{ id: IDABORT, label: '&Abort' }, { id: IDRETRY, label: '&Retry' },
        { id: IDIGNORE, label: '&Ignore' }],
    [{ id: IDYES, label: '&Yes' }, { id: IDNO, label: '&No' },
        { id: IDCANCEL, label: 'Cancel' }],
    [{ id: IDYES, label: '&Yes' }, { id: IDNO, label: '&No' }],
    [{ id: IDRETRY, label: '&Retry' }, { id: IDCANCEL, label: 'Cancel' }],
    [{ id: IDCANCEL, label: 'Cancel' }, { id: IDTRYAGAIN, label: '&Try Again' },
        { id: IDCONTINUE, label: '&Continue' }],
];

/**
 * The buttons a box of this type shows, as a fresh list.
 *
 * @param {number} type
 */
export const messageBoxButtons = type=>(MESSAGE_BOX_SETS[type & MB_TYPEMASK]
    ?? MESSAGE_BOX_SETS[0]).map(button=>({ id: button.id, label: button.label }));

/**
 * The button a box presses for Enter: the first of its set unless MB_DEFBUTTON2,
 * 3 or 4 moves it along. It has to be a button the box shows -- a value outside
 * the set is one the caller's own switch has no arm for.
 *
 * @param {number} type
 */
export const messageBoxDefault = type=>{
    const buttons = MESSAGE_BOX_SETS[type & MB_TYPEMASK] ?? MESSAGE_BOX_SETS[0];
    return buttons[Math.min((type & MB_DEFMASK) >> 8, buttons.length - 1)].id;
};

/**
 * The layout in dialog units, scaled by the dialog's own font: the margin
 * round the contents and between the text and the buttons, a push button's
 * least size, and the gap between two buttons -- the dialog-layout metrics
 * Windows' own dialogs are drawn to.
 */
const MARGIN = 7;
const BUTTON_WIDTH = 50;
const BUTTON_HEIGHT = 14;
const BUTTON_GAP = 4;
/** Room either side of a label wider than a button's least width. */
const LABEL_PADDING = 8;

/**
 * The widest the text runs before it wraps, as a share of the screen: a
 * sentence runs across a box, not across the display.
 */
const TEXT_SHARE = 5 / 8;

/**
 * @typedef {Object} MessageBoxHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [release]
 * @property {{ width: number, height: number }} [screen]
 * @property {boolean} [unattended]
 * @property {(notice: any) => number | Promise<number> | undefined | null} [messageBox]
 *           Who answers a box when nobody is at the screen.
 * @property {(text: string) => void} [say]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(instance: number, id: number) => string | null} [loadString]
 *           A string out of a module's table: MessageBoxIndirect's text and
 *           caption may be named by id.
 */

/**
 * @param {Object} options
 * @param {MessageBoxHost} options.host
 * @param {(name: string, args: number[], thread?: unknown) => any} options.call
 *        One of user32's own entry points, called as a program calls it --
 *        from `thread`, when named: past an await the thread on the processor
 *        is another, and the box is its caller's.
 * @param {(name: string, handler: (record: any, message: { hwnd: number, message: number,
 *     wParam: number, lParam: number }, thread?: unknown) => number | Promise<number>)
 *     => number} options.procedure
 *        An address the dialog manager calls a procedure on this side through.
 * @param {(hwnd: number, text: string, width: number) => { width: number, height: number }}
 *        options.measure  The text as DrawText lays it out in the window's
 *        own font, words wrapped within `width` pixels.
 * @param {(hwnd: number) => { width: number, height: number }} options.frame
 *        What a window's frame adds to its client area.
 */
export function createMessageBoxFunctions({ host, call, procedure, measure, frame }){
    /**
     * The boxes being made, by the key WM_INITDIALOG carries in its lParam.
     *
     * @type {Map<number, { text: string, caption: string, type: number,
     *     buttons: { id: number, label: string }[] }>}
     */
    const pending = new Map();
    /** @type {Map<number, { buttons: { id: number }[] }>} */
    const standing = new Map();
    let nextKey = 1;
    let nextId = 1;
    let boxProcedure = 0;

    /**
     * Pixels for a width and height in the dialog's units.
     *
     * @param {number} hwnd @param {unknown} thread
     */
    const unitsOf = (hwnd, thread)=>{
        const rect = host.allocate?.(16) ?? 0;
        const words = new Uint8Array(16);
        const view = new DataView(words.buffer);
        view.setInt32(8, 4000, true);
        view.setInt32(12, 8000, true);
        host.writeMemory(rect, words);
        call('MapDialogRect', [hwnd, rect], thread);
        const mapped = new DataView(host.readMemory(rect, 16).slice().buffer);
        host.release?.(rect);
        const across = mapped.getInt32(8, true) / 4000;
        const down = mapped.getInt32(12, true) / 8000;
        return {
            /** @param {number} units */
            x: units=>Math.round(units * across),
            /** @param {number} units */
            y: units=>Math.round(units * down),
        };
    };

    /**
     * Sizes the box to what it says, as the dialog procedure of Windows' own
     * box does on WM_INITDIALOG: the text wrapped within a share of the
     * screen, the buttons one width -- the widest label's or the least a push
     * button has -- in a row centred under it, the box wide enough for its
     * caption too, and centred on the screen.
     *
     * @param {number} hwnd
     * @param {{ text: string, caption: string, type: number,
     *     buttons: { id: number, label: string }[] }} box
     * @param {unknown} thread  The box's: the one whose call raised it.
     */
    const layOut = async(hwnd, box, thread)=>{
        const units = unitsOf(hwnd, thread);
        const screen = host.screen ?? { width: 640, height: 480 };
        const margin = { x: units.x(MARGIN), y: units.y(MARGIN) };
        const textHwnd = await call('GetDlgItem', [hwnd, TEXT_ID], thread);
        const text = measure(textHwnd, box.text, Math.floor(screen.width * TEXT_SHARE));
        const widest = Math.max(...box.buttons.map(button=>
            measure(hwnd, button.label.replace('&', ''), 0x7fff).width));
        const button = {
            width: Math.max(units.x(BUTTON_WIDTH), widest + units.x(LABEL_PADDING)),
            height: units.y(BUTTON_HEIGHT),
        };
        const gap = units.x(BUTTON_GAP);
        const row = box.buttons.length * button.width + (box.buttons.length - 1) * gap;
        const edges = frame(hwnd);
        // The caption is the dialog's title bar; the close box sits beside it
        // as wide as the bar is tall.
        const captionWidth = measure(hwnd, box.caption, 0x7fff).width + margin.x * 2
            + Math.max(edges.height - edges.width, 0);
        const width = Math.max(text.width + margin.x * 2, row + margin.x * 2, captionWidth);
        const buttonsTop = margin.y + text.height + margin.y;
        const height = buttonsTop + button.height + margin.y;
        const move = (/** @type {number} */ target, /** @type {number} */ x,
            /** @type {number} */ y, /** @type {number} */ across, /** @type {number} */ down)=>
            call('SetWindowPos', [target, 0, x, y, across, down, SWP_NOZORDER | SWP_NOACTIVATE],
                thread);
        await move(textHwnd, (box.type & MB_RIGHT) !== 0 ? width - margin.x - text.width : margin.x,
            margin.y, text.width, text.height);
        const left = Math.floor((width - row) / 2);
        for (const [index, { id }] of box.buttons.entries())
        {
            await move(await call('GetDlgItem', [hwnd, id], thread),
                left + index * (button.width + gap),
                buttonsTop, button.width, button.height);
        }
        const outer = { width: width + edges.width, height: height + edges.height };
        await move(hwnd, Math.max(0, Math.floor((screen.width - outer.width) / 2)),
            Math.max(0, Math.floor((screen.height - outer.height) / 2)),
            outer.width, outer.height);
        // The focus is the default button's, whatever the tab order says,
        // which is why WM_INITDIALOG answers FALSE: the dialog manager would
        // give it to the first tab stop.
        await call('SetFocus',
            [await call('GetDlgItem', [hwnd, messageBoxDefault(box.type)], thread)], thread);
        return 0;
    };

    /**
     * The box's dialog procedure: sized when it starts, and ended by a button.
     * Escape and the close box reach it as IDCANCEL, which ends a box that has
     * a Cancel button -- or, as Windows has it, a box whose only button is OK,
     * with IDOK -- and nothing else: a question has to be answered.
     *
     * @param {any} record
     * @param {{ hwnd: number, message: number, wParam: number, lParam: number }} message
     * @param {unknown} [thread]  Whose call delivered the message.
     */
    const dialogProcedure = (record, message, thread)=>{
        if (message.message === WM_INITDIALOG)
        {
            const box = pending.get(message.lParam >>> 0);
            if (!box)
            {
                return 1;
            }
            standing.set(message.hwnd >>> 0, box);
            return layOut(message.hwnd >>> 0, box, thread);
        }
        if (message.message !== WM_COMMAND || message.wParam >>> 16 !== BN_CLICKED)
        {
            return 0;
        }
        const box = standing.get(message.hwnd >>> 0);
        const id = message.wParam & 0xffff;
        if (!box)
        {
            return 0;
        }
        const answer = box.buttons.some(button=>button.id === id) ? id
            : id === IDCANCEL && box.buttons.length === 1 && box.buttons[0].id === IDOK ? IDOK
                : 0;
        if (answer !== 0)
        {
            standing.delete(message.hwnd >>> 0);
            return after(call('EndDialog', [message.hwnd, answer], thread), ()=>1);
        }
        return 1;
    };

    /**
     * The template Windows' own box is made from, in memory the dialog manager
     * reads: a caption, the text's static, and a push button per answer, all
     * at nought until the procedure sizes them.
     *
     * @param {string} text @param {string} caption @param {number} type
     * @param {{ id: number, label: string }[]} buttons
     */
    const template = (text, caption, type, buttons)=>{
        /** @type {number[]} */
        const bytes = [];
        const u16 = (/** @type {number} */ value)=>bytes.push(value & 0xff, value >>> 8 & 0xff);
        const u32 = (/** @type {number} */ value)=>{
            u16(value & 0xffff);
            u16(value >>> 16);
        };
        const wide = (/** @type {string} */ value)=>{
            for (let index = 0; index < value.length; index++)
            {
                u16(value.charCodeAt(index));
            }
            u16(0);
        };
        const align = ()=>{
            while (bytes.length % 4 !== 0)
            {
                bytes.push(0);
            }
        };
        const topmost = (type & (MB_TOPMOST | MB_SYSTEMMODAL)) !== 0;
        u32(WS_POPUP | WS_CAPTION | WS_SYSMENU | DS_MODALFRAME | DS_SETFONT | DS_NOIDLEMSG);
        u32(topmost ? WS_EX_TOPMOST : 0);
        u16(1 + buttons.length);
        for (let index = 0; index < 4; index++)
        {
            u16(0);
        }
        u16(0);
        u16(0);
        wide(caption);
        u16(8);
        wide('MS Shell Dlg');
        /** @param {number} style @param {number} id @param {number} atom @param {string} title */
        const item = (style, id, atom, title)=>{
            align();
            u32((WS_CHILD | WS_VISIBLE | style) >>> 0);
            u32(0);
            for (let index = 0; index < 4; index++)
            {
                u16(0);
            }
            u16(id);
            u16(0xffff);
            u16(atom);
            wide(title);
            u16(0);
        };
        item(WS_GROUP | SS_NOPREFIX | ((type & MB_RIGHT) !== 0 ? SS_RIGHT : SS_LEFT), TEXT_ID,
            STATIC_ATOM, text);
        const pressed = messageBoxDefault(type);
        for (const [index, button] of buttons.entries())
        {
            item(WS_TABSTOP | (index === 0 ? WS_GROUP : 0)
                | (button.id === pressed ? BS_DEFPUSHBUTTON : BS_PUSHBUTTON),
            button.id, BUTTON_ATOM, button.label);
        }
        return Uint8Array.from(bytes);
    };

    /**
     * @param {number} owner @param {string} text @param {string} title
     * @param {number} type @param {boolean} wide
     * @returns {number | Promise<number>}
     */
    const messageBox = (owner, text, title, type, wide)=>{
        const buttons = messageBoxButtons(type);
        host.say?.(title.length > 0 ? `${title}: ${text}` : text);
        if ((type & MB_HELP) !== 0)
        {
            host.divergence?.('MessageBox', 'MB_HELP: the Help button is not shown');
        }
        if (host.unattended)
        {
            const answer = host.messageBox?.({
                id: nextId++, text, caption: title, type,
                buttons: buttons.map(button=>({ id: button.id,
                    label: button.label.replace('&', '') })),
                defaultButton: messageBoxDefault(type),
            });
            return answer === undefined || answer === null ? messageBoxDefault(type) : answer;
        }
        const bytes = template(text, title, type, buttons);
        const at = host.allocate?.(bytes.length) ?? 0;
        if (at === 0)
        {
            host.divergence?.('MessageBox', 'no memory to make the box in; answered by default');
            return messageBoxDefault(type);
        }
        host.writeMemory(at, bytes);
        boxProcedure ||= procedure('MessageBoxProc', dialogProcedure);
        const key = nextKey++;
        pending.set(key, { text, caption: title, type, buttons });
        /** @param {number} answer */
        const ended = answer=>{
            pending.delete(key);
            host.release?.(at);
            return answer;
        };
        const result = call(wide ? 'DialogBoxIndirectParamW' : 'DialogBoxIndirectParamA',
            [0, at, owner >>> 0, boxProcedure, key]);
        return result instanceof Promise ? result.then(ended) : ended(result);
    };

    /** @param {number} at @param {boolean} wide */
    const textAt = (at, wide)=>((at >>> 0) === 0 ? ''
        : readText(host, at >>> 0, wide, 0x10000));
    /**
     * A null caption is "Error", as documented.
     *
     * @param {number} at @param {boolean} wide
     */
    const captionAt = (at, wide)=>((at >>> 0) === 0 ? 'Error'
        : readText(host, at >>> 0, wide, 0x1000));

    /**
     * A string a MSGBOXPARAMS names: a pointer to one, or the id of one in
     * the instance's string table when its high word is zero.
     *
     * @param {number} instance @param {number} at @param {boolean} wide
     * @returns {string | null} null for no string at all
     */
    const paramText = (instance, at, wide)=>{
        if ((at >>> 0) === 0)
        {
            return null;
        }
        return (at >>> 0) <= 0xffff
            ? host.loadString?.(instance >>> 0, at & 0xffff) ?? ''
            : readText(host, at >>> 0, wide, 0x10000);
    };

    /**
     * MessageBoxIndirectA or W: the box a MSGBOXPARAMS describes. Its text
     * and caption may be string ids in the instance given; its icon, help
     * id and help callback describe what this box does not draw or call --
     * a box with MB_HELP has no Help to press here.
     *
     * @param {number} params @param {boolean} wide
     */
    const indirect = (params, wide)=>{
        const bytes = host.readMemory(params >>> 0, 24);
        /** @param {number} at */
        const field = at=>(bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
            | bytes[at + 3] << 24) >>> 0;
        const instance = field(8);
        return messageBox(field(4), paramText(instance, field(12), wide) ?? '',
            paramText(instance, field(16), wide) ?? 'Error', field(20), wide);
    };

    return {
        /**
         * int MessageBoxIndirectA(const MSGBOXPARAMSA *lpmbp)
         * int MessageBoxIndirectW(const MSGBOXPARAMSW *lpmbp)
         */
        MessageBoxIndirectA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([params])=>indirect(params, false),
        },
        MessageBoxIndirectW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([params])=>indirect(params, true),
        },

        /**
         * int MessageBoxA(HWND hWnd, LPCSTR lpText, LPCSTR lpCaption, UINT uType)
         *
         * Modal: the identifier of the button pressed, and not before.
         */
        MessageBoxA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([owner, text, caption, type])=>
                messageBox(owner, textAt(text, false), captionAt(caption, false), type >>> 0,
                    false),
        },

        /** int MessageBoxW(HWND, LPCWSTR lpText, LPCWSTR lpCaption, UINT uType) */
        MessageBoxW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([owner, text, caption, type])=>
                messageBox(owner, textAt(text, true), captionAt(caption, true), type >>> 0, true),
        },

        /**
         * int MessageBoxExA(HWND, LPCSTR, LPCSTR, UINT uType, WORD wLanguageId)
         *
         * The labels are the system's whatever language is asked for.
         */
        MessageBoxExA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([owner, text, caption, type])=>
                messageBox(owner, textAt(text, false), captionAt(caption, false), type >>> 0,
                    false),
        },

        /** int MessageBoxExW(HWND, LPCWSTR, LPCWSTR, UINT uType, WORD wLanguageId) */
        MessageBoxExW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([owner, text, caption, type])=>
                messageBox(owner, textAt(text, true), captionAt(caption, true), type >>> 0, true),
        },
    };
}
