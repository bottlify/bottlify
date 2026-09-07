/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
 * - **There is no modal loop and no keyboard navigation.** DialogBox is not
 *   here; IsDialogMessageA reports that a message is not a dialog message, so
 *   the caller goes on to translate and dispatch it, which is the behaviour
 *   that loses nothing.
 * - **WM_INITDIALOG is posted rather than sent.** Sending means running the
 *   dialog procedure before this call returns, and a program that creates a
 *   dialog and then pumps sees no difference. One that creates a dialog and
 *   immediately reads a control the procedure was to fill in does, and that is
 *   the ceiling on this.
 */

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
 * the two cannot share a reader and one read as the other is nonsense.
 */
const DLGVER_EX = 1;
const SIGNATURE_EX = 0xffff;

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

/**
 * @param {Object} options
 * @param {any} options.host
 * @param {(hwnd: number) => any | null} options.live
 * @param {Map<number, any>} options.windows
 * @param {(fields: any) => any} options.makeWindow
 * @param {(hwnd: number) => number} options.destroyWindow
 */
export function createDialogFunctions({ host, live, windows, makeWindow, destroyWindow }){
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
        if (template.u16(DLGTEMPLATE.style) === DLGVER_EX
            && template.u16(DLGTEMPLATE.style + 2) === SIGNATURE_EX)
        {
            // An extended template. Every field past the signature sits
            // somewhere else, so reading it with this layout would produce a
            // dialog of plausible nonsense rather than a refusal.
            return null;
        }

        const style = template.u32(DLGTEMPLATE.style);
        const dialog = {
            style,
            exStyle: template.u32(DLGTEMPLATE.dwExtendedStyle),
            x: acrossFor(template.i16(DLGTEMPLATE.x)),
            y: downFor(template.i16(DLGTEMPLATE.y)),
            width: acrossFor(template.i16(DLGTEMPLATE.cx)),
            height: downFor(template.i16(DLGTEMPLATE.cy)),
            title: '',
            /** @type {any[]} */
            controls: [],
        };
        const count = template.u16(DLGTEMPLATE.cdit);

        template.at = DLGTEMPLATE.SIZE;
        template.nameOrOrdinal(); // menu
        template.nameOrOrdinal(); // window class
        dialog.title = template.nameOrOrdinal().name ?? '';
        if ((style & DS_SETFONT) !== 0)
        {
            template.at += 2; // point size
            template.nameOrOrdinal(); // typeface
        }

        for (let index = 0; index < count; index++)
        {
            template.align();
            const item = template.at;
            const control = {
                style: template.u32(item + DLGITEMTEMPLATE.style),
                exStyle: template.u32(item + DLGITEMTEMPLATE.dwExtendedStyle),
                x: acrossFor(template.i16(item + DLGITEMTEMPLATE.x)),
                y: downFor(template.i16(item + DLGITEMTEMPLATE.y)),
                width: acrossFor(template.i16(item + DLGITEMTEMPLATE.cx)),
                height: downFor(template.i16(item + DLGITEMTEMPLATE.cy)),
                id: template.u16(item + DLGITEMTEMPLATE.id),
                className: '',
                title: '',
            };
            template.at = item + DLGITEMTEMPLATE.SIZE;
            const cls = template.nameOrOrdinal();
            control.className = cls.name ?? `#${cls.ordinal}`;
            control.title = template.nameOrOrdinal().name ?? '';

            // The creation data begins with its own size in bytes, and that word
            // counts itself. A zero means there is only the word.
            const extra = template.u16(template.at);
            template.at += extra === 0 ? 2 : extra;
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

    return {
        /**
         * HWND CreateDialogIndirectParamA(HINSTANCE hInstance,
         *   LPCDLGTEMPLATEA lpTemplate, HWND hWndParent, DLGPROC lpDialogFunc,
         *   LPARAM dwInitParam)
         */
        CreateDialogIndirectParamA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([instance, template, parent, dialogFunc, initParam])=>{
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
         * The result is remembered on the window even though nothing can return
         * it: DialogBox is what hands it back, and DialogBox needs a modal loop
         * that does not exist here. Keeping it is what makes adding one later a
         * change to the loop rather than to this.
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
         * Reports that the message is not a dialog message, so the caller goes
         * on to translate and dispatch it. That is the answer that loses
         * nothing: claiming a message was handled would swallow every keystroke
         * a dialog is open for, and there is no focus to move between controls
         * that have no procedures.
         */
        IsDialogMessageA: {
            argBytes: 8,
            handler: ()=>0,
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
