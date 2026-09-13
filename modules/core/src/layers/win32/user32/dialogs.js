/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Dialogs: the template a program hands over, and the windows that come of it.
 *
 * A dialog is a window and a control is a child window with an identifier, so
 * everything that already works for windows works for these -- DestroyWindow
 * destroys them, GetWindowTextA reads their text, the message queue delivers to
 * them. That is the whole design, and it is what makes GetDlgItem answer with a
 * handle rather than with a number that stands for nothing.
 *
 * What is here and what is not, stated plainly because the difference matters:
 *
 * - **The template is walked for real.** Its variable-length parts -- the menu,
 *   class and title of the dialog, then of every control -- are counted
 *   strings, not terminated ones, and each control begins on a four-byte
 *   boundary. Reading any of that wrong yields a plausible number of controls
 *   at plausible positions, which is why it is walked rather than guessed at.
 * - **Coordinates are dialog units, not pixels.** Four horizontal units to a
 *   character width and eight vertical to a character height. Treating them as
 *   pixels puts every control in the top-left eighth of the dialog, which looks
 *   like a layout bug in the program.
 * - **A control has no window procedure**, because its class is a system one
 *   this build does not implement. It holds its text and its identifier and
 *   nothing more, so SendDlgItemMessageA reaches nothing and says so.
 * - **The modal loop pumps, delivers, and knows two keys.** DialogBox
 *   retrieves every message for the thread and hands each to its procedure
 *   until EndDialog, which is the loop a program would have written itself.
 *   Enter and Escape are the dialog manager's: Enter is a click on the default
 *   button, or IDOK when there is none, and Escape is IDCANCEL, each reaching
 *   the dialog procedure as the WM_COMMAND a button would have sent. That is
 *   all IsDialogMessageA does too; there is no focus to move between controls
 *   that have no procedures, so every other message is reported as not a
 *   dialog message and the caller goes on to translate and dispatch it.
 * - **WM_INITDIALOG is posted rather than sent.** Sending means running the
 *   dialog procedure before this call returns, and a program that creates a
 *   dialog and then pumps sees no difference. One that creates a dialog and
 *   immediately reads a control the procedure was to fill in does, and that is
 *   the ceiling on this.
 */

import { ANY_WINDOW, WM_QUIT } from './messages.js';
import { readMessage } from './structs.js';

/** DLGTEMPLATE, the fixed part before the variable-length names. */
const DLGTEMPLATE = Object.freeze({
    style: 0,
    dwExtendedStyle: 4,
    cdit: 8,
    x: 10,
    y: 12,
    cx: 14,
    cy: 16,
    SIZE: 18,
});

/** DLGITEMTEMPLATE, likewise. */
const DLGITEMTEMPLATE = Object.freeze({
    style: 0,
    dwExtendedStyle: 4,
    x: 8,
    y: 10,
    cx: 12,
    cy: 14,
    id: 16,
    SIZE: 18,
});

/** The template says a font follows; without this bit there is none to skip. */
const DS_SETFONT = 0x0040;

/** The style bits a dialog's own window carries. */
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;

/**
 * A DLGTEMPLATEEX begins with a version of 1 and a signature of 0xffff, where
 * an ordinary template has a style DWORD. Every field after that differs, so
 * the two have their own layouts and one read as the other is nonsense.
 */
const DLGVER_EX = 1;
const SIGNATURE_EX = 0xffff;

/** DLGTEMPLATEEX, the fixed part. */
const DLGTEMPLATEEX = Object.freeze({
    helpID: 4,
    exStyle: 8,
    style: 12,
    cDlgItems: 16,
    x: 18,
    y: 20,
    cx: 22,
    cy: 24,
    SIZE: 26,
});

/** DLGITEMTEMPLATEEX, likewise; the id is a DWORD here where it was a WORD. */
const DLGITEMTEMPLATEEX = Object.freeze({
    helpID: 0,
    exStyle: 4,
    style: 8,
    x: 12,
    y: 14,
    cx: 16,
    cy: 18,
    id: 20,
    SIZE: 24,
});

/** The extended font block: point size, weight, italic and charset before the face. */
const FONT_EX_FIXED = 6;

/** What an ordinal, rather than a name, looks like in a counted string. */
const ORDINAL_MARKER = 0xffff;

/**
 * Dialog units are relative to the dialog font: four across to a character
 * width, eight down to a character height. The character cell is the same
 * estimate the rest of this layer measures text with, so a dialog laid out
 * against it is consistent with the text drawn into it.
 */
const CHAR_WIDTH = 8;
const CHAR_HEIGHT = 16;
const DLU_PER_CHAR_X = 4;
const DLU_PER_CHAR_Y = 8;

/** Messages a dialog answers. */
const WM_CLOSE = 0x0010;
const WM_INITDIALOG = 0x0110;
const WM_COMMAND = 0x0111;
const WM_KEYDOWN = 0x0100;

/** The two keys the dialog manager turns into commands, and where they go. */
const VK_RETURN = 0x0d;
const VK_ESCAPE = 0x1b;
const IDOK = 1;
const IDCANCEL = 2;
const BN_CLICKED = 0;

/** A button's kind is the low four bits of its style. */
const BS_TYPEMASK = 0x0f;
const BS_DEFPUSHBUTTON = 0x01;
const BUTTON_CLASSES = new Set(['#128', 'button']);

/** What DialogBox answers when the dialog could not be made. */
const DIALOG_FAILED = -1;

/** RT_DIALOG: the resource type a dialog template is filed under. */
const RT_DIALOG = 5;
/** A resource name below this is an integer id, not a pointer to text. */
const MAX_INTEGER_RESOURCE = 0x10000;
/** The longest resource name read out of guest memory. */
const MAX_RESOURCE_NAME = 256;

/**
 * @param {Object} options
 * @param {any} options.host
 * @param {(hwnd: number) => any | null} options.live
 * @param {Map<number, any>} options.windows
 * @param {(fields: any) => any} options.makeWindow
 * @param {(hwnd: number) => number} options.destroyWindow
 * @param {(message: import('./structs.js').MessageFields, thread?: unknown) => number}
 *     options.deliver  Hands a retrieved message to its procedure.
 */
export function createDialogFunctions({ host, live, windows, makeWindow, destroyWindow, deliver }){
    /**
     * A cursor over the template, so that every read advances it. The parts are
     * variable-length and consecutive, so an offset carried by hand is an
     * offset that eventually drifts.
     *
     * @param {number} base
     */
    const reader = base=>{
        let at = 0;
        const u16 = (/** @type {number} */ offset)=>{
            const bytes = host.readMemory(base + offset, 2);
            return bytes[0] | bytes[1] << 8;
        };
        return {
            get at(){
                return at;
            },
            set at(value){
                at = value;
            },
            u16,
            /** @param {number} offset */
            i16: offset=>u16(offset) << 16 >> 16,
            /** @param {number} offset */
            u32: offset=>{
                const bytes = host.readMemory(base + offset, 4);
                return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
            },
            /** Four-byte alignment, which every item template begins on. */
            align(){
                at = (at + 3) & ~3;
            },
            /**
             * A name, an ordinal, or nothing -- and it advances past whichever
             * it found. The string is UTF-16 and terminated, and the ordinal
             * form is two words rather than one.
             *
             * @returns {{ name: string | null, ordinal: number | null }}
             */
            nameOrOrdinal(){
                const first = u16(at);
                if (first === 0)
                {
                    at += 2;
                    return { name: '', ordinal: null };
                }
                if (first === ORDINAL_MARKER)
                {
                    const ordinal = u16(at + 2);
                    at += 4;
                    return { name: null, ordinal };
                }
                let text = '';
                for (let unit = u16(at); unit !== 0; unit = u16(at))
                {
                    text += String.fromCharCode(unit);
                    at += 2;
                }
                at += 2;
                return { name: text, ordinal: null };
            },
        };
    };

    /** @param {number} units */
    const acrossFor = units=>Math.round(units * CHAR_WIDTH / DLU_PER_CHAR_X);
    /** @param {number} units */
    const downFor = units=>Math.round(units * CHAR_HEIGHT / DLU_PER_CHAR_Y);

    /**
     * Walks a template into the dialog and the controls it describes.
     *
     * @param {number} address
     * @returns {any | null} null when the template is one this cannot read
     */
    const parseTemplate = address=>{
        const template = reader(address);
        // The two layouts, told apart by the signature. A resource compiler
        // writes the extended one for any dialog with a help id or a font
        // weight, which is most dialogs of the era.
        const extended = template.u16(DLGTEMPLATE.style) === DLGVER_EX
            && template.u16(DLGTEMPLATE.style + 2) === SIGNATURE_EX;
        const head = extended
            ? { style: DLGTEMPLATEEX.style, exStyle: DLGTEMPLATEEX.exStyle,
                count: DLGTEMPLATEEX.cDlgItems, x: DLGTEMPLATEEX.x, y: DLGTEMPLATEEX.y,
                cx: DLGTEMPLATEEX.cx, cy: DLGTEMPLATEEX.cy, size: DLGTEMPLATEEX.SIZE }
            : { style: DLGTEMPLATE.style, exStyle: DLGTEMPLATE.dwExtendedStyle,
                count: DLGTEMPLATE.cdit, x: DLGTEMPLATE.x, y: DLGTEMPLATE.y,
                cx: DLGTEMPLATE.cx, cy: DLGTEMPLATE.cy, size: DLGTEMPLATE.SIZE };
        const item = extended
            ? { style: DLGITEMTEMPLATEEX.style, exStyle: DLGITEMTEMPLATEEX.exStyle,
                x: DLGITEMTEMPLATEEX.x, y: DLGITEMTEMPLATEEX.y, cx: DLGITEMTEMPLATEEX.cx,
                cy: DLGITEMTEMPLATEEX.cy, id: DLGITEMTEMPLATEEX.id, size: DLGITEMTEMPLATEEX.SIZE }
            : { style: DLGITEMTEMPLATE.style, exStyle: DLGITEMTEMPLATE.dwExtendedStyle,
                x: DLGITEMTEMPLATE.x, y: DLGITEMTEMPLATE.y, cx: DLGITEMTEMPLATE.cx,
                cy: DLGITEMTEMPLATE.cy, id: DLGITEMTEMPLATE.id, size: DLGITEMTEMPLATE.SIZE };

        const style = template.u32(head.style);
        const dialog = {
            style,
            exStyle: template.u32(head.exStyle),
            x: acrossFor(template.i16(head.x)),
            y: downFor(template.i16(head.y)),
            width: acrossFor(template.i16(head.cx)),
            height: downFor(template.i16(head.cy)),
            title: '',
            /** @type {any[]} */
            controls: [],
        };
        const count = template.u16(head.count);

        template.at = head.size;
        template.nameOrOrdinal(); // menu
        template.nameOrOrdinal(); // window class
        dialog.title = template.nameOrOrdinal().name ?? '';
        if ((style & DS_SETFONT) !== 0)
        {
            // The point size; the extended form adds a weight, an italic
            // flag and a charset before the face name.
            template.at += extended ? FONT_EX_FIXED : 2;
            template.nameOrOrdinal(); // typeface
        }

        for (let index = 0; index < count; index++)
        {
            template.align();
            const at = template.at;
            const control = {
                style: template.u32(at + item.style),
                exStyle: template.u32(at + item.exStyle),
                x: acrossFor(template.i16(at + item.x)),
                y: downFor(template.i16(at + item.y)),
                width: acrossFor(template.i16(at + item.cx)),
                height: downFor(template.i16(at + item.cy)),
                // A WORD in the old layout and a DWORD in the new, and either
                // way the id a program passes to GetDlgItem is 16 bits wide.
                id: extended ? template.u32(at + item.id) & 0xffff : template.u16(at + item.id),
                className: '',
                title: '',
            };
            template.at = at + item.size;
            const cls = template.nameOrOrdinal();
            control.className = cls.name ?? `#${cls.ordinal}`;
            control.title = template.nameOrOrdinal().name ?? '';

            // The creation data begins with its size in bytes. In the old
            // layout that word counts itself, so a zero means there is only
            // the word; in the extended one it counts what follows it.
            const extra = template.u16(template.at);
            template.at += extended ? 2 + extra : (extra === 0 ? 2 : extra);
            dialog.controls.push(control);
        }
        return dialog;
    };

    /** @param {number} hwnd @param {number} id @returns {any | null} */
    const controlOf = (hwnd, id)=>{
        const dialog = live(hwnd);
        if (!dialog)
        {
            return null;
        }
        for (const record of windows.values())
        {
            if (!record.destroyed && record.parent === dialog.hwnd && record.id === (id >>> 0))
            {
                return record;
            }
        }
        return null;
    };

    /** @param {number} address @param {string} text @param {number} limit */
    const writeString = (address, text, limit)=>{
        const clipped = limit > 0 ? text.slice(0, limit - 1) : '';
        const bytes = new Uint8Array(clipped.length + 1);
        for (let index = 0; index < clipped.length; index++)
        {
            bytes[index] = clipped.charCodeAt(index) & 0xff;
        }
        host.writeMemory(address, bytes);
        return clipped.length;
    };

    /**
     * A dialog from a template already in memory, shared by the two ways a
     * program hands one over: pointed at directly, or named in its resources.
     *
     * @param {number} instance @param {number} template @param {number} parent
     * @param {number} dialogFunc @param {number} initParam
     */
    const createDialog = (instance, template, parent, dialogFunc, initParam)=>{
        const described = (template >>> 0) === 0
            ? null
            : parseTemplate(template >>> 0);
        if (!described)
        {
            return 0;
        }
        const dialog = makeWindow({
            className: '#32770',
            title: described.title,
            style: described.style,
            exStyle: described.exStyle,
            parent: parent >>> 0,
            instance: instance >>> 0,
            wndProc: dialogFunc >>> 0,
            x: described.x,
            y: described.y,
            width: described.width,
            height: described.height,
        });
        for (const control of described.controls)
        {
            makeWindow({
                className: control.className,
                title: control.title,
                style: (control.style | WS_CHILD) >>> 0,
                exStyle: control.exStyle,
                parent: dialog.hwnd,
                instance: instance >>> 0,
                id: control.id,
                // No procedure: the class is a system one this build
                // does not implement, and a control that answered
                // messages from nowhere would be inventing behaviour.
                wndProc: 0,
                x: control.x,
                y: control.y,
                width: control.width,
                height: control.height,
            });
        }
        host.created?.(dialog.hwnd);
        host.queue.post({
            hwnd: dialog.hwnd,
            message: WM_INITDIALOG,
            // The window that would take the focus, of which there is
            // none: no control here can hold it.
            wParam: 0,
            lParam: initParam >>> 0,
        });
        return dialog.hwnd;
    };

    /** @param {number} hwnd @param {number} dialog  Whether hwnd is the dialog or inside it. */
    const within = (hwnd, dialog)=>{
        for (let at = windows.get(hwnd); at; at = windows.get(at.parent))
        {
            if (at.hwnd === dialog)
            {
                return true;
            }
        }
        return false;
    };

    /**
     * What Enter means: the default push button's id, or IDOK when the
     * template marked none.
     *
     * @param {number} dialog
     */
    const defaultButton = dialog=>{
        for (const record of windows.values())
        {
            if (!record.destroyed && record.parent === dialog
                && BUTTON_CLASSES.has(String(record.className).toLowerCase())
                && (record.style & BS_TYPEMASK) === BS_DEFPUSHBUTTON)
            {
                return record.id;
            }
        }
        return IDOK;
    };

    /**
     * The keyboard half of the dialog manager: Enter and Escape, pressed
     * anywhere in the dialog, become the command a button would have sent.
     *
     * @param {number} dialog
     * @param {{ hwnd: number, message: number, wParam: number }} message
     * @param {unknown} [thread]
     * @returns {number | Promise<number> | null}  null when the message is not
     *     one of the two; otherwise what the dialog procedure answered.
     */
    const dialogKey = (dialog, message, thread)=>{
        const record = live(dialog);
        if (!record || message.message !== WM_KEYDOWN || !within(message.hwnd, dialog))
        {
            return null;
        }
        const key = message.wParam >>> 0;
        if (key !== VK_RETURN && key !== VK_ESCAPE)
        {
            return null;
        }
        const id = key === VK_RETURN ? defaultButton(dialog) : IDCANCEL;
        return host.dispatch(record.wndProc, {
            hwnd: dialog,
            message: WM_COMMAND,
            wParam: (BN_CLICKED << 16 | id & 0xffff) >>> 0,
            lParam: controlOf(dialog, id)?.hwnd ?? 0,
        }, thread);
    };

    /**
     * The modal loop: the dialog's thread pumps until EndDialog destroys the
     * window, and what EndDialog was given is the answer.
     *
     * A WM_QUIT retrieved here ends the dialog and is put back, because the
     * quit belongs to the loop outside this one, which has not seen it yet.
     *
     * @param {number} hwnd
     * @returns {Promise<number>}
     */
    const runModal = async hwnd=>{
        // Read before the first await: afterwards the thread on the processor
        // may be another, and every delivery below has to name this one.
        const thread = host.callerThread?.();
        const record = windows.get(hwnd);
        if (!record)
        {
            return 0;
        }
        while (!record.destroyed)
        {
            const entry = host.queue.peek({ hwnd: ANY_WINDOW, first: 0, last: 0, remove: true });
            if (!entry)
            {
                await host.idle();
                continue;
            }
            if (entry.message === WM_QUIT)
            {
                host.queue.postQuit(entry.wParam | 0);
                destroyWindow(hwnd);
                break;
            }
            await (dialogKey(hwnd, entry, thread) ?? deliver(entry, thread));
        }
        return record.dialogResult ?? 0;
    };

    /**
     * The address of a dialog template named in a module's resources, or zero.
     * The bytes are where the loader mapped them, so nothing is copied.
     *
     * @param {number} instance @param {number} name
     */
    const templateAddress = (instance, name)=>{
        const raw = name >>> 0;
        const key = raw < MAX_INTEGER_RESOURCE ? raw : host.readCString(raw, MAX_RESOURCE_NAME);
        const found = /** @type {{ rva: number } | null} */ (
            host.findResource?.(instance >>> 0, RT_DIALOG, key) ?? null);
        const base = host.moduleBase?.(instance >>> 0) ?? 0;
        return found && base !== 0 ? base + found.rva : 0;
    };

    return {
        /**
         * HWND CreateDialogIndirectParamA(HINSTANCE hInstance,
         *   LPCDLGTEMPLATEA lpTemplate, HWND hWndParent, DLGPROC lpDialogFunc,
         *   LPARAM dwInitParam)
         */
        CreateDialogIndirectParamA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([instance, template, parent, dialogFunc, initParam])=>
                createDialog(instance, template, parent, dialogFunc, initParam),
        },

        /**
         * HWND CreateDialogParamA(HINSTANCE hInstance, LPCSTR lpTemplateName,
         *   HWND hWndParent, DLGPROC lpDialogFunc, LPARAM dwInitParam)
         *
         * The same dialog, named in the module's resources rather than
         * pointed at: the template is found where the image was mapped and
         * read in place.
         */
        CreateDialogParamA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([instance, name, parent, dialogFunc, initParam])=>
                createDialog(instance, templateAddress(instance, name), parent, dialogFunc,
                    initParam),
        },

        /**
         * INT_PTR DialogBoxIndirectParamA(HINSTANCE hInstance,
         *   LPCDLGTEMPLATEA hDialogTemplate, HWND hWndParent, DLGPROC lpDialogFunc,
         *   LPARAM dwInitParam)
         *
         * The modal form: the same dialog, and this call does not return until
         * EndDialog has been called on it. The owner is not disabled, because
         * no window here answers input on its own account anyway.
         */
        DialogBoxIndirectParamA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([instance, template, parent, dialogFunc, initParam])=>{
                const hwnd = createDialog(instance, template, parent, dialogFunc, initParam);
                return hwnd === 0 ? DIALOG_FAILED : runModal(hwnd);
            },
        },

        /**
         * INT_PTR DialogBoxParamA(HINSTANCE hInstance, LPCSTR lpTemplateName,
         *   HWND hWndParent, DLGPROC lpDialogFunc, LPARAM dwInitParam)
         */
        DialogBoxParamA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([instance, name, parent, dialogFunc, initParam])=>{
                const hwnd = createDialog(instance, templateAddress(instance, name), parent,
                    dialogFunc, initParam);
                return hwnd === 0 ? DIALOG_FAILED : runModal(hwnd);
            },
        },

        /**
         * LRESULT DefDlgProcA(HWND hDlg, UINT Msg, WPARAM wParam, LPARAM lParam)
         *
         * What a dialog procedure falls through to. The one message it must
         * handle is WM_CLOSE, because a dialog with no other way to end would
         * otherwise stay on screen after the person using it asked for it to go.
         */
        DefDlgProcA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message])=>{
                if ((message >>> 0) === WM_CLOSE)
                {
                    destroyWindow(hwnd >>> 0);
                }
                return 0;
            },
        },

        /**
         * BOOL EndDialog(HWND hDlg, INT_PTR nResult)
         *
         * The result is remembered on the window, where the modal loop reads
         * it back once the window is gone.
         */
        EndDialog: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, result])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                record.dialogResult = result | 0;
                return destroyWindow(hwnd >>> 0);
            },
        },

        /** HWND GetDlgItem(HWND hDlg, int nIDDlgItem) */
        GetDlgItem: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, id])=>controlOf(hwnd, id)?.hwnd ?? 0,
        },

        /** int GetDlgCtrlID(HWND hWnd) */
        GetDlgCtrlID: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>live(hwnd)?.id ?? 0,
        },

        /** BOOL SetDlgItemTextA(HWND hDlg, int nIDDlgItem, LPCSTR lpString) */
        SetDlgItemTextA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, id, text])=>{
                const control = controlOf(hwnd, id);
                if (!control)
                {
                    return 0;
                }
                control.title = (text >>> 0) === 0 ? '' : host.readCString(text >>> 0, 1 << 16);
                return 1;
            },
        },

        /**
         * UINT GetDlgItemTextA(HWND hDlg, int nIDDlgItem, LPSTR lpString,
         *                     int cchMax)
         *
         * The buffer is terminated even when there is no control, because the
         * documented failure is a length of zero and a caller that then reads
         * the buffer must find an empty string rather than what was there.
         */
        GetDlgItemTextA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, id, out, max])=>{
                const room = max | 0;
                if ((out >>> 0) === 0 || room <= 0)
                {
                    return 0;
                }
                const control = controlOf(hwnd, id);
                return writeString(out >>> 0, control?.title ?? '', room);
            },
        },

        /**
         * LRESULT SendDlgItemMessageA(HWND hDlg, int nIDDlgItem, UINT Msg,
         *                            WPARAM wParam, LPARAM lParam)
         *
         * A control has no procedure here, so there is nothing to send to. Zero
         * is what a control that ignored the message would answer, and a
         * program reading a value out of one gets nothing rather than something
         * invented.
         */
        SendDlgItemMessageA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([hwnd, id, message, wParam, lParam])=>{
                const control = controlOf(hwnd, id);
                if (!control || control.wndProc === 0)
                {
                    return 0;
                }
                return host.dispatch(control.wndProc, {
                    hwnd: control.hwnd,
                    message: message >>> 0,
                    wParam: wParam >>> 0,
                    lParam: lParam >>> 0,
                });
            },
        },

        /**
         * BOOL IsDialogMessageA(HWND hDlg, LPMSG lpMsg)
         *
         * Enter and Escape are taken and turned into commands; everything else
         * is reported as not a dialog message, so the caller goes on to
         * translate and dispatch it. That is the answer that loses nothing:
         * claiming a message was handled would swallow every keystroke a
         * dialog is open for.
         */
        IsDialogMessageA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([dialog, msg])=>{
                const answered = dialogKey(dialog >>> 0, readMessage(host, msg >>> 0));
                if (answered === null)
                {
                    return 0;
                }
                return answered instanceof Promise ? answered.then(()=>1) : 1;
            },
        },
    };
}

/** The layouts a test asserts against, so a change to one is visible. */
export const DIALOG_LAYOUT = Object.freeze({
    DLGTEMPLATE,
    DLGITEMTEMPLATE,
    DS_SETFONT,
    WS_VISIBLE,
    CHAR_WIDTH,
    CHAR_HEIGHT,
    DLU_PER_CHAR_X,
    DLU_PER_CHAR_Y,
    WM_INITDIALOG,
});
