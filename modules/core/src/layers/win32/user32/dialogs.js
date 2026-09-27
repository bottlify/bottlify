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
 * - **A dialog is a window of the dialog class**, whose procedure hands every
 *   message to the program's dialog procedure first and to DefDlgProc when
 *   that answers FALSE; the controls are windows of the system classes, with
 *   the procedures those classes have.
 * - **The modal loop pumps, delivers, and knows the dialog keys.** DialogBox
 *   retrieves every message for the thread and hands each to its procedure
 *   until EndDialog, which is the loop a program would have written itself.
 *   Enter, Escape and Tab are the dialog manager's: Enter is a click on the
 *   default button, or IDOK when there is none, Escape is IDCANCEL, each
 *   reaching the dialog procedure as the WM_COMMAND a button would have sent,
 *   and Tab moves the focus between the controls that stop it. That is what
 *   IsDialogMessageA does too; every other message is reported as not a
 *   dialog message and the caller goes on to translate and dispatch it.
 * - **WM_INITDIALOG is sent, not posted.** The dialog procedure runs during
 *   `CreateDialogParam`/`DialogBoxParam`, after every control exists and has
 *   set itself up, and before a template's WS_VISIBLE shows the window -- so a
 *   program that creates a dialog and then reads a control the procedure was
 *   to fill in finds it filled.
 */

import { ANY_WINDOW, WM_QUIT } from './messages.js';
import { readMessage, readRect, writeRect } from './structs.js';
import { WS_VISIBLE, frameOf } from './frame.js';
import { createTabWalk } from './tabwalk.js';
import { encodeAnsi } from '../kernel32/locale.js';
import {
    DLGC_BUTTON, DLGC_DEFPUSHBUTTON, DLGC_HASSETSEL, DLGC_WANTALLKEYS,
    DLGC_WANTTAB, DLGWINDOWEXTRA, DWLP_DLGPROC, IDCANCEL, IDOK, WM_GETDLGCODE, WM_SETFONT,
    WM_SETTEXT, after,
} from './controls.js';

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
/** The dialog is made even when one of its controls cannot be, without that one. */
const DS_NOFAILCREATE = 0x0010;
/** What a dialog that names a class nobody has leaves in GetLastError. */
const ERROR_CANNOT_FIND_WND_CLASS = 1407;

/**
 * The classes Windows' own libraries register besides user32's, lower-case:
 * a template naming one that this build has no procedure for still gets its
 * control -- a window answering nothing -- where a class that exists nowhere
 * fails the dialog.
 */
const STANDARD_CLASSES = new Set([
    'mdiclient', 'combolbox', 'sysheader32', 'toolbarwindow32', 'rebarwindow32',
    'tooltips_class32', 'msctls_statusbar32', 'msctls_trackbar32', 'msctls_updown32',
    'msctls_progress32', 'msctls_hotkey32', 'syslistview32', 'systreeview32',
    'comboboxex32', 'systabcontrol32', 'sysanimate32', 'sysmonthcal32', 'sysdatetimepick32',
    'sysipaddress32', 'syspager', 'nativefontctl', 'syslink',
    'richedit', 'richedit20a', 'richedit20w', 'richedit50w',
]);

/**
 * The point size that means "the shell's dialog font" rather than a size,
 * and the font it means: what a DS_SHELLFONT template is compiled to.
 */
const SHELL_FONT_SIZE = 0x7fff;
const SHELL_FONT_POINTS = 8;
const SHELL_FONT_FACE = 'MS Shell Dlg';

/**
 * The font a template names, as the block after the title carries it.
 *
 * @typedef {Object} DialogFont
 * @property {number} pointSize
 * @property {string} faceName
 * @property {number} weight   Zero in the old layout, which carries none.
 * @property {number} italic
 * @property {number} charSet
 */

/**
 * Asked first of each message a modal loop takes, before the dialog manager:
 * true when it took the message, which goes no further. It sends through the
 * `send` it is handed, which names the loop's own thread.
 *
 * @typedef {(message: { hwnd: number, message: number, wParam: number, lParam: number,
 *     time?: number, x?: number, y?: number },
 *     send: (hwnd: number, message: number, wParam: number, lParam: number)
 *         => number | Promise<number>) => boolean | Promise<boolean>} ModalHook
 */

/** The style bits a dialog's own window carries. */
const WS_CHILD = 0x40000000;
const WS_DISABLED = 0x08000000;
/** The dialog styles that decide where it goes and what frame it has. */
const DS_MODALFRAME = 0x0080;
const DS_CENTER = 0x0800;
const WS_EX_DLGMODALFRAME = 0x00000001;

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
 * width, eight down to a character height. The character cell is the system
 * font's as the font engine measures it, and without an engine the same
 * estimate the rest of this layer measures text with, so a dialog laid out
 * against it is consistent with the text drawn into it either way.
 */
const CHAR_WIDTH = 8;
const CHAR_HEIGHT = 16;
const DLU_PER_CHAR_X = 4;
const DLU_PER_CHAR_Y = 8;

/** How a button is told its check state, and the two states a radio has. */
const BM_SETCHECK = 0x00f1;
const BST_UNCHECKED = 0;
const BST_CHECKED = 1;

/** Messages a dialog answers. */
const WM_INITDIALOG = 0x0110;
const WM_COMMAND = 0x0111;
const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const DM_GETDEFID = 0x0400;
/** How many times an unattended modal loop presses Enter before it leaves the dialog be. */
const UNATTENDED_PRESSES = 8;
const DC_HASDEFID = 0x534b;

/** The keys the dialog manager acts on, and what a click is called. */
const VK_TAB = 0x09;
const VK_RETURN = 0x0d;
const VK_SHIFT = 0x10;
const VK_ESCAPE = 0x1b;
const BN_CLICKED = 0;
const BM_CLICK = 0x00f5;
const EM_SETSEL = 0x00b1;

/** A button's kind is the low four bits of its style. */
const BS_TYPEMASK = 0x0f;
const BS_DEFPUSHBUTTON = 0x01;

/** What DialogBox answers when the dialog could not be made. */
const DIALOG_FAILED = -1;

/** RT_DIALOG: the resource type a dialog template is filed under. */
const RT_DIALOG = 5;
/** A resource name below this is an integer id, not a pointer to text. */
const MAX_INTEGER_RESOURCE = 0x10000;
/** The longest resource name read out of guest memory. */
const MAX_RESOURCE_NAME = 256;

/**
 * @typedef {Object} DialogHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {{ open: (type: string, object: any) => number,
 *              close: (handle: number) => any }} handles
 * @property {ReturnType<typeof import('./messages.js').createMessageQueue>} queue
 * @property {{ width: number, height: number, bitsPerPixel: number }} [screen]
 * @property {(hwnd: number, message: number, wParam: number, lParam: number,
 *     thread?: unknown) => number | Promise<number>} send
 * @property {(record: any, message: { hwnd: number, message: number, wParam: number,
 *     lParam: number }, thread?: unknown) => number | Promise<number>} defDlgProc
 *           The dialog class's procedure: DWLP_DLGPROC first, then the default.
 * @property {() => number} focus
 * @property {(hwnd: number, thread?: unknown) => number | Promise<number>} setFocus
 * @property {(hwnd: number) => number | Promise<number>} [show]
 *           Shows a window as ShowWindow(SW_SHOW) would, answering once the
 *           procedures it sent to have.
 * @property {(message: { hwnd: number, message: number, wParam: number, lParam: number })
 *     => number} [translate]  What TranslateMessage does with a key message.
 * @property {(record: any) => any[]} children
 * @property {(dialog: any, focused: number) => void} [markDefault]
 *           Styles the push button Enter would press as the default, as the
 *           dialog manager does when it moves the focus.
 * @property {(key: number) => boolean} keyDown
 * @property {{ clientOrigin: (record: any) => { x: number, y: number } }} geometry
 * @property {{ baseUnits?: () => { width: number, height: number } | null,
 *     fontUnits?: (font: number) => { width: number, height: number } | null,
 *     createFont?: (fields: DialogFont) => number }} [draw]
 *           The window manager's drawing, for the cell the system font --
 *           or a dialog's own -- measures as, and the font a template
 *           names. Absent, or answering null, without a font engine.
 * @property {() => unknown} [callerThread]
 * @property {(thread: unknown) => any} [take]
 *           The next message for the thread, taken as GetMessage takes it:
 *           a mouse message placed where the program's procedures say it
 *           goes, a press having activated its window and the window under
 *           the pointer asked for its cursor. A promise when that runs the
 *           program; null when there is nothing.
 * @property {(code: number) => void} [setLastError]
 * @property {(hwnd: number) => void} [created]
 * @property {() => Promise<void>} idle
 * @property {boolean} [unattended]  Nobody at the screen: a modal loop waiting for
 *     input has it answered rather than wait.
 * @property {(dialog: UnattendedDialog) => number | Promise<number>} [answer]
 *     Who answers it, and without one the default button.
 * @property {(instance: number, type: number, name: number | string) => unknown} [findResource]
 * @property {(instance: number) => number} [moduleBase]
 */

/**
 * A modal dialog or message box put to whoever answers for an unattended run.
 *
 * @typedef {Object} UnattendedDialog
 * @property {'dialog' | 'messagebox'} kind
 * @property {string} title
 * @property {string} text  A message box's text; a dialog's static texts, one a line.
 * @property {{ id: number, label: string, default: boolean }[]} buttons
 */

/**
 * @param {Object} options
 * @param {DialogHost} options.host
 * @param {(hwnd: number) => any | null} options.live
 * @param {Map<number, any>} options.windows
 * @param {(fields: any) => any} options.makeWindow
 * @param {(hwnd: number, thread?: unknown) => number | Promise<number>} options.destroyWindow
 * @param {(message: import('./structs.js').MessageFields, thread?: unknown)
 *     => number | Promise<number>} options.deliver  Hands a retrieved message to its procedure.
 * @param {(name: string) => ({ wndProc: number, windowExtra: number } | null)} options.classNamed
 *     A class the program registered, by the name a template spells it.
 * @param {(name: string) => boolean} [options.classKnown]
 *     Whether a class of that name, or `#atom`, is the program's or the system's.
 * @param {(record: any, args: number[]) => number | Promise<number>} options.announce
 *     Tells a new window's procedure that it exists, as CreateWindowEx does.
 * @param {(run: (hwnd: number, thread: unknown, first?: ModalHook) => Promise<number>)
 *     => void} [options.modalLoop]  Handed the modal loop, for a dialog another
 *     library made to be run the way DialogBox runs one.
 */
export function createDialogFunctions(options){
    const {
        host, live, windows, makeWindow, destroyWindow, deliver, classNamed, classKnown, announce,
    } = options;
    /** @param {string} name */
    const classExists = name=>(classKnown ? classKnown(name) : classNamed(name) !== null)
        || STANDARD_CLASSES.has(name.toLowerCase());
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

    /** @returns {{ width: number, height: number }} */
    const baseUnits = ()=>host.draw?.baseUnits?.() ?? { width: CHAR_WIDTH, height: CHAR_HEIGHT };
    /**
     * The cell a dialog is laid out against: its own font's when the
     * template set one and the engine can measure it, else the system's.
     *
     * @param {number} font  A font handle, or zero.
     * @returns {{ width: number, height: number }}
     */
    const unitsFor = font=>(font !== 0 ? host.draw?.fontUnits?.(font) : null) ?? baseUnits();
    /** @param {number} units @param {{ width: number, height: number }} cell */
    const acrossFor = (units, cell)=>Math.round(units * cell.width / DLU_PER_CHAR_X);
    /** @param {number} units @param {{ width: number, height: number }} cell */
    const downFor = (units, cell)=>Math.round(units * cell.height / DLU_PER_CHAR_Y);

    /**
     * Walks a template into the dialog and the controls it describes, with
     * positions and sizes still in dialog units: the cell they scale by is
     * the font's, which is made once the template has been read.
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
            x: template.i16(head.x),
            y: template.i16(head.y),
            width: template.i16(head.cx),
            height: template.i16(head.cy),
            title: '',
            /** @type {DialogFont | null} */
            font: null,
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
            const pointSize = template.u16(template.at);
            const font = extended
                ? { pointSize, weight: template.u16(template.at + 2),
                    italic: template.u16(template.at + 4) & 0xff,
                    charSet: template.u16(template.at + 4) >>> 8 }
                : { pointSize, weight: 0, italic: 0, charSet: 0 };
            template.at += extended ? FONT_EX_FIXED : 2;
            const face = template.nameOrOrdinal().name ?? '';
            // The size that asks for the shell's own dialog font, which is
            // what a template compiled with DS_SHELLFONT carries.
            dialog.font = pointSize === SHELL_FONT_SIZE
                ? { ...font, pointSize: SHELL_FONT_POINTS, faceName: SHELL_FONT_FACE }
                : { ...font, faceName: face };
        }

        for (let index = 0; index < count; index++)
        {
            template.align();
            const at = template.at;
            const control = {
                style: template.u32(at + item.style),
                exStyle: template.u32(at + item.exStyle),
                x: template.i16(at + item.x),
                y: template.i16(at + item.y),
                width: template.i16(at + item.cx),
                height: template.i16(at + item.cy),
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

    /**
     * A control by identifier: an immediate child first, then any deeper
     * one, which is where a control inside a group or a page lives.
     *
     * @param {number} hwnd @param {number} id @returns {any | null}
     */
    const controlOf = (hwnd, id)=>{
        const dialog = live(hwnd);
        if (!dialog)
        {
            return null;
        }
        /** @param {any} parent @returns {any | null} */
        const search = parent=>{
            const children = host.children(parent);
            const direct = children.find(child=>child.id === (id >>> 0));
            if (direct)
            {
                return direct;
            }
            for (const child of children)
            {
                const deeper = search(child);
                if (deeper)
                {
                    return deeper;
                }
            }
            return null;
        };
        return search(dialog);
    };

    /**
     * A control's text in the ANSI page, as a window's text goes back.
     *
     * @param {number} address @param {string} text @param {number} limit
     */
    const writeString = (address, text, limit)=>{
        const clipped = limit > 0 ? text.slice(0, limit - 1) : '';
        host.writeMemory(address, encodeAnsi(`${clipped}\0`));
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
        // A control whose class exists nowhere fails the dialog, unless the
        // template asked to be made without whatever cannot be: checked
        // before anything is made, so a procedure never hears of it.
        const makeable = described.controls.filter((/** @type {any} */ control)=>
            classExists(control.className));
        if (makeable.length < described.controls.length
            && (described.style & DS_NOFAILCREATE) === 0)
        {
            host.setLastError?.(ERROR_CANNOT_FIND_WND_CLASS);
            return 0;
        }
        // The font the template names is the dialog's for as long as it
        // lives: the cell its units scale by, and what every control is
        // handed to paint in.
        const font = described.font ? host.draw?.createFont?.(described.font) ?? 0 : 0;
        const cell = unitsFor(font);
        // The template's size is the client area; the window is that plus
        // the frame its styles give it. DS_MODALFRAME is the extended style
        // of the same name, as the resource compiler means it.
        const exStyle = (described.exStyle
            | ((described.style & DS_MODALFRAME) !== 0 ? WS_EX_DLGMODALFRAME : 0)) >>> 0;
        const frame = frameOf(described.style, exStyle);
        const width = acrossFor(described.width, cell) + frame.edge * 2;
        const height = downFor(described.height, cell) + frame.edge * 2 + frame.caption;
        // Placed relative to the owner's client area, or centred on the
        // screen when the template asks; a child dialog is placed by its
        // parent like any other child.
        const owner = live(parent);
        const screen = host.screen ?? { width: 640, height: 480 };
        const origin = owner && (described.style & WS_CHILD) === 0
            ? host.geometry.clientOrigin(owner) : { x: 0, y: 0 };
        const centred = (described.style & DS_CENTER) !== 0;
        const x = centred
            ? Math.floor((screen.width - width) / 2) : origin.x + acrossFor(described.x, cell);
        const y = centred
            ? Math.floor((screen.height - height) / 2) : origin.y + downFor(described.y, cell);
        // The dialog class is a system class: its procedure hands every
        // message to the dialog procedure kept in the extra bytes, which is
        // where GetWindowLong(DWLP_DLGPROC) reads it from.
        // Written once the window exists, as CreateDialog sets it after
        // CreateWindowEx returns: the procedure never hears the dialog's own
        // WM_NCCREATE and WM_CREATE.
        const extra = new DataView(new ArrayBuffer(DLGWINDOWEXTRA));
        // A template that says WS_VISIBLE is shown only after WM_INITDIALOG
        // has reached the procedure; until then the window is created without
        // the bit, as Windows creates it, so a procedure that looks at its
        // own window from there sees what Windows would show it.
        const wantsVisible = (described.style & WS_VISIBLE) !== 0;
        const dialog = makeWindow({
            className: '#32770',
            title: described.title,
            style: (described.style & ~WS_VISIBLE) >>> 0,
            exStyle,
            parent: parent >>> 0,
            instance: instance >>> 0,
            wndProc: 0,
            extra,
            x,
            y,
            width,
            height,
        });
        // Answered to WM_GETFONT on the dialog, and deleted with it: the
        // handle is the dialog's own, not the program's.
        dialog.font = font;
        dialog.dialogFont = font;
        // The dialog is a window made the way CreateWindowEx makes one, before
        // any control: a CBT hook hears of it, and a framework that attaches
        // its object there and subclasses the procedure has done so before
        // the first message and the dialog's first control.
        const build = ()=>{
            dialog.extra.setUint32(DWLP_DLGPROC, dialogFunc >>> 0, true);
            /** @type {Promise<number>[]} */
            const creating = [];
            /** @type {any[]} */
            const controls = [];
            for (const control of makeable)
            {
                // A class the program registered is the program's, procedure and
                // all: a template names its own controls this way, and one of
                // them keeps its state in the extra bytes and sets it up in
                // WM_CREATE like a window made any other way. A system class has
                // no procedure here, and a control that answered messages from
                // nowhere would be inventing behaviour.
                const cls = classNamed(control.className);
                const style = (control.style | WS_CHILD) >>> 0;
                const placed = {
                    x: acrossFor(control.x, cell),
                    y: downFor(control.y, cell),
                    width: acrossFor(control.width, cell),
                    height: downFor(control.height, cell),
                };
                const record = makeWindow({
                    className: control.className,
                    title: control.title,
                    style,
                    exStyle: control.exStyle,
                    parent: dialog.hwnd,
                    instance: instance >>> 0,
                    id: control.id,
                    wndProc: cls ? cls.wndProc : 0,
                    ...placed,
                    ...(cls
                        ? { extra: new DataView(new ArrayBuffer(Math.max(cls.windowExtra, 0))) }
                        : {}),
                });
                // The template's default push button is the dialog's default id
                // until DM_SETDEFID names another.
                if (record.className === 'Button'
                    && (record.style & BS_TYPEMASK) === BS_DEFPUSHBUTTON)
                {
                    dialog.defaultId = control.id & 0xffff;
                }
                if (cls)
                {
                    // The class and title are in the template, not in guest
                    // memory, so the CREATESTRUCT names neither: a procedure
                    // that reads them there finds NULL. The ceiling on this.
                    const announced = announce(record, [control.exStyle, 0, 0, style,
                        placed.x, placed.y, placed.width, placed.height,
                        dialog.hwnd, control.id, instance >>> 0, 0]);
                    if (typeof (/** @type {any} */ (announced))?.then === 'function')
                    {
                        creating.push(/** @type {Promise<number>} */ (announced));
                    }
                }
                controls.push(record);
            }
            // Every control is told the dialog's font once it exists and has
            // set itself up, as the dialog manager tells it: before
            // WM_INITDIALOG, and after the program's own WM_CREATE.
            const thread = host.callerThread?.();
            const setFonts = ()=>{
                const told = font === 0
                    ? [] : controls.map(record=>
                        host.send(record.hwnd, WM_SETFONT, font, 0, thread));
                return told.some(answer=>typeof answer !== 'number') ? Promise.all(told) : null;
            };
            const initialise = ()=>{
                host.created?.(dialog.hwnd);
                // Sent, not posted: a program that creates a dialog and then reads
                // a control its procedure was to fill in is entitled to find it
                // filled, so the call does not return until the procedure has run.
                const answered = host.send(dialog.hwnd, WM_INITDIALOG,
                    // The control that takes the focus unless the procedure says
                    // otherwise: the first that stops the Tab key.
                    nextTabStop(dialog, 0, true)?.hwnd ?? 0, initParam >>> 0, thread);
                return after(answered, ()=>{
                    // A template that said WS_VISIBLE is shown only now, after the
                    // procedure has had its say. A procedure that ended the dialog
                    // from WM_INITDIALOG has left nothing to show.
                    if (wantsVisible && live(dialog.hwnd))
                    {
                        return after(host.show?.(dialog.hwnd) ?? 0, ()=>dialog.hwnd);
                    }
                    return dialog.hwnd;
                });
            };
            // WM_INITDIALOG comes after every control exists and has been told
            // so; a procedure that talks to a control from there expects the
            // control to have set itself up.
            const fonts = creating.length === 0 ? setFonts() : Promise.all(creating).then(setFonts);
            return fonts ? fonts.then(initialise) : initialise();
        };
        return after(announce(dialog, [exStyle, 0, 0, dialog.style, x, y, width, height,
            parent >>> 0, 0, instance >>> 0, initParam >>> 0]),
        (/** @type {number} */ made)=>(made === 0 ? 0 : build()));
    };

    /**
     * @param {number | Promise<number>} created
     * @param {(hwnd: number) => any} then
     */
    const once = (created, then)=>(typeof (/** @type {any} */ (created))?.then === 'function'
        ? /** @type {Promise<number>} */ (created).then(then)
        : then(/** @type {number} */ (created)));

    const { nextTabStop, nextGroupItem } = createTabWalk({ children: host.children,
        recordOf: hwnd=>windows.get(hwnd) });

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
     * What Enter means: the id DM_SETDEFID chose, else the default push
     * button's, else IDOK.
     *
     * @param {number} dialog @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const defaultButton = (dialog, thread)=>after(host.send(dialog, DM_GETDEFID, 0, 0, thread),
        answer=>{
            if ((answer >>> 16) === DC_HASDEFID)
            {
                return answer & 0xffff;
            }
            const marked = host.children(live(dialog)).find(record=>
                record.className === 'Button'
                && (record.style & BS_TYPEMASK) === BS_DEFPUSHBUTTON);
            return marked ? marked.id : IDOK;
        });

    /**
     * Sends the dialog the command a button would have sent on a click.
     *
     * @param {number} dialog @param {number} id @param {unknown} [thread]
     */
    const command = (dialog, id, thread)=>host.send(dialog, WM_COMMAND,
        (BN_CLICKED << 16 | id & 0xffff) >>> 0, controlOf(dialog, id)?.hwnd ?? 0, thread);

    /**
     * The keyboard half of the dialog manager, as IsDialogMessage does it:
     * Enter clicks the default button -- or the push button with the focus
     * -- Escape is IDCANCEL, Tab moves the focus, unless the control with
     * the focus asked to see the key itself.
     *
     * @param {number} dialog
     * @param {{ hwnd: number, message: number, wParam: number, lParam: number }} message
     * @param {unknown} [thread]
     * @returns {number | Promise<number> | null}  null when the message is not
     *     the dialog manager's; otherwise what was done with it.
     */
    const dialogKey = (dialog, message, thread)=>{
        const record = live(dialog);
        if (!record || !within(message.hwnd, dialog))
        {
            return null;
        }
        if (message.message !== WM_KEYDOWN && message.message !== WM_CHAR)
        {
            return null;
        }
        const key = message.wParam >>> 0;
        if (key !== VK_RETURN && key !== VK_ESCAPE && key !== VK_TAB)
        {
            return null;
        }
        const focused = host.focus();
        const asked = focused !== 0 && within(focused, dialog)
            ? host.send(focused, WM_GETDLGCODE, key, 0, thread)
            : 0;
        return after(asked, code=>{
            const wants = code >>> 0;
            if ((wants & DLGC_WANTALLKEYS) !== 0
                || (key === VK_TAB && (wants & DLGC_WANTTAB) !== 0))
            {
                return null;
            }
            // The character that follows a key the manager took is taken too,
            // or an edit with the focus would type a tab.
            if (message.message === WM_CHAR)
            {
                return 1;
            }
            if (key === VK_TAB)
            {
                const next = nextTabStop(record, focused, !host.keyDown(VK_SHIFT));
                if (!next)
                {
                    return 1;
                }
                // Tabbing into an edit selects its text, which is what the
                // control asks for with DLGC_HASSETSEL; tabbing onto a push
                // button makes it the one Enter presses.
                return after(host.setFocus(next.hwnd, thread), ()=>{
                    host.markDefault?.(record, next.hwnd);
                    return after(host.send(next.hwnd, WM_GETDLGCODE, 0, 0, thread), asks=>after(
                        ((asks >>> 0) & DLGC_HASSETSEL) !== 0
                            ? host.send(next.hwnd, EM_SETSEL, 0, -1 >>> 0, thread) : 0,
                        ()=>1));
                });
            }
            if (key === VK_ESCAPE)
            {
                return after(command(dialog, IDCANCEL, thread), ()=>1);
            }
            // Enter: the push button with the focus when it is the default --
            // tabbing onto one makes it so -- and the default id otherwise.
            if ((wants & DLGC_BUTTON) !== 0 && (wants & DLGC_DEFPUSHBUTTON) !== 0)
            {
                return after(host.send(focused, BM_CLICK, 0, 0, thread), ()=>1);
            }
            return after(defaultButton(dialog, thread), id=>after(command(dialog, id, thread),
                ()=>1));
        });
    };

    /**
     * The modal loop: the dialog's thread pumps until EndDialog destroys the
     * window, and what EndDialog was given is the answer.
     *
     * A WM_QUIT retrieved here ends the dialog and is put back, because the
     * quit belongs to the loop outside this one, which has not seen it yet.
     *
     * @param {number} hwnd
     * @param {unknown} thread  Whose loop it is, read when its call was made:
     *     afterwards the thread on the processor may be another, and every
     *     delivery below has to name this one.
     * @param {ModalHook} [first]
     * @returns {Promise<number>}
     */
    const runModal = async(hwnd, thread, first)=>{
        const record = windows.get(hwnd);
        if (!record)
        {
            return 0;
        }
        // Destroyed while it was being made, and not by EndDialog: there is
        // no dialog to run, as though it could not be made.
        if (record.destroyed && record.dialogResult === undefined)
        {
            return DIALOG_FAILED;
        }
        // The owner is disabled for as long as the dialog is up, as Windows
        // disables it: a program asking IsWindowEnabled of its own frame
        // meanwhile is told no, and a click on the frame reaches nothing.
        const owner = (record.style & WS_CHILD) === 0 ? live(record.parent) : null;
        const ownerWasEnabled = owner !== null && (owner.style & WS_DISABLED) === 0;
        if (ownerWasEnabled)
        {
            owner.style = (owner.style | WS_DISABLED) >>> 0;
        }
        // A modal dialog is shown by the call whether or not its template
        // says WS_VISIBLE: most templates leave the bit off and rely on this.
        await host.show?.(hwnd);
        // Unattended, a dialog waiting for input is put to whoever answers for
        // the run, and the button chosen is pressed as a click presses it; one
        // that stays up after a few presses is left.
        let presses = 0;
        while (!record.destroyed)
        {
            // The program's own loop would have been GetMessage, and what
            // that does as it takes a message the dialog's loop does too.
            const entry = host.take ? await host.take(thread)
                : host.queue.peek({ hwnd: ANY_WINDOW, first: 0, last: 0, remove: true });
            if (!entry)
            {
                if (host.unattended && presses < UNATTENDED_PRESSES)
                {
                    presses++;
                    const id = await defaultButton(hwnd, thread);
                    const children = host.children(record);
                    const buttons = children.filter(child=>child.className === 'Button'
                        && (child.style & BS_TYPEMASK) <= BS_DEFPUSHBUTTON)
                        .map(child=>({ id: child.id & 0xffff,
                            label: String(child.title).replace('&', ''),
                            default: child.id === id }));
                    const chosen = await (host.answer?.({
                        kind: 'dialog',
                        title: record.title,
                        text: children.filter(child=>child.className === 'Static' && child.title)
                            .map(child=>child.title).join('\n'),
                        buttons: buttons.length > 0
                            ? buttons : [{ id, label: 'OK', default: true }],
                    }) ?? id);
                    await command(hwnd, chosen, thread);
                    continue;
                }
                await host.idle();
                continue;
            }
            if (entry.message === WM_QUIT)
            {
                host.queue.postQuit(entry.wParam | 0);
                await destroyWindow(hwnd, thread);
                break;
            }
            if (first && await first(entry, (target, message, wParam, lParam)=>
                host.send(target, message, wParam, lParam, thread)))
            {
                continue;
            }
            const taken = dialogKey(hwnd, entry, thread);
            if (taken !== null)
            {
                await taken;
                continue;
            }
            // The loop is the program's message loop for as long as the
            // dialog is up, so it translates as one does: a key press the
            // dialog manager left alone becomes the character an edit
            // types.
            host.translate?.(entry);
            await deliver(entry, thread);
        }
        if (ownerWasEnabled)
        {
            owner.style = (owner.style & ~WS_DISABLED) >>> 0;
        }
        return record.dialogResult ?? 0;
    };

    options.modalLoop?.(runModal);

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
                const thread = host.callerThread?.();
                return once(createDialog(instance, template, parent, dialogFunc, initParam),
                    hwnd=>(hwnd === 0 ? DIALOG_FAILED : runModal(hwnd, thread)));
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
                const thread = host.callerThread?.();
                return once(createDialog(instance, templateAddress(instance, name), parent,
                    dialogFunc, initParam),
                hwnd=>(hwnd === 0 ? DIALOG_FAILED : runModal(hwnd, thread)));
            },
        },

        /**
         * LRESULT DefDlgProcA(HWND hDlg, UINT Msg, WPARAM wParam, LPARAM lParam)
         *
         * The dialog class's own procedure, which a program's own dialog
         * class is built on: the message goes to the dialog procedure in
         * DWLP_DLGPROC first, and what that answers FALSE gets the default --
         * the background, the default button, the focus passed to a control,
         * WM_CLOSE as Cancel.
         */
        DefDlgProcA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam])=>{
                const record = windows.get(hwnd >>> 0);
                if (!record)
                {
                    return 0;
                }
                return host.defDlgProc(record, {
                    hwnd: hwnd >>> 0, message: message >>> 0,
                    wParam: wParam >>> 0, lParam: lParam >>> 0,
                }, host.callerThread?.());
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

        /**
         * BOOL CheckDlgButton(HWND hDlg, int nIDButton, UINT uCheck)
         *
         * BM_SETCHECK to the one control, which is all Windows does here. The
         * state is passed through rather than reduced to a boolean, because
         * BST_INDETERMINATE is a third value a three-state button keeps and a
         * program reads back.
         */
        CheckDlgButton: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, id, check])=>{
                const control = controlOf(hwnd, id);
                if (!control)
                {
                    return 0;
                }
                const told = host.send(control.hwnd, BM_SETCHECK, check >>> 0, 0,
                    host.callerThread?.());
                return typeof told === 'number' ? 1 : Promise.resolve(told).then(()=>1);
            },
        },

        /**
         * BOOL CheckRadioButton(HWND hDlg, int nIDFirstButton, int nIDLastButton,
         *                       int nIDCheckButton)
         *
         * What Windows does, literally: BM_SETCHECK to every control whose
         * identifier is in the range, checked for the one named and cleared
         * for the rest.
         */
        CheckRadioButton: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, first, last, check])=>{
                const dialog = live(hwnd);
                if (!dialog)
                {
                    return 0;
                }
                const thread = host.callerThread?.();
                const told = host.children(dialog)
                    .filter(record=>(record.id | 0) >= (first | 0) && (record.id | 0) <= (last | 0))
                    .map(record=>host.send(record.hwnd, BM_SETCHECK,
                        (record.id | 0) === (check | 0) ? BST_CHECKED : BST_UNCHECKED, 0, thread));
                return told.some(answer=>typeof answer !== 'number')
                    ? Promise.all(told).then(()=>1)
                    : 1;
            },
        },

        /**
         * LONG GetDialogBaseUnits(void)
         *
         * The character cell dialogs are laid out against, width in the low
         * word and height in the high: the same cell the templates here are
         * scaled by, so a program doing the arithmetic itself lands where
         * the template did.
         */
        GetDialogBaseUnits: {
            argBytes: 0,
            handler: ()=>{
                const units = baseUnits();
                return ((units.height << 16) | units.width) >>> 0;
            },
        },

        /** BOOL MapDialogRect(HWND hDlg, LPRECT lpRect) */
        MapDialogRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, rect])=>{
                const dialog = live(hwnd);
                if (!dialog || (rect >>> 0) === 0)
                {
                    return 0;
                }
                // The dialog's own font's cell, as its template was scaled
                // by: a program placing a control by hand lands where the
                // template would have put it.
                const cell = unitsFor(dialog.dialogFont ?? 0);
                const units = readRect(host, rect >>> 0);
                writeRect(host, rect >>> 0, {
                    left: acrossFor(units.left, cell),
                    top: downFor(units.top, cell),
                    right: acrossFor(units.right, cell),
                    bottom: downFor(units.bottom, cell),
                });
                return 1;
            },
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
                return after(host.send(control.hwnd, WM_SETTEXT, 0, text >>> 0,
                    host.callerThread?.()), ()=>1);
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
         * SendMessage to the control with that id; nothing for an id no
         * control has, which is what a control that ignored the message
         * would have answered.
         */
        SendDlgItemMessageA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([hwnd, id, message, wParam, lParam])=>{
                const control = controlOf(hwnd, id);
                if (!control)
                {
                    return 0;
                }
                return host.send(control.hwnd, message >>> 0, wParam >>> 0, lParam >>> 0,
                    host.callerThread?.());
            },
        },

        /**
         * HWND GetNextDlgTabItem(HWND hDlg, HWND hCtl, BOOL bPrevious)
         *
         * The control Tab would move to from the one named -- the next with
         * WS_TABSTOP, shown and enabled, wrapping round, inside the children
         * it searches through -- or the first from nothing or the dialog
         * itself, before which there is none.
         */
        GetNextDlgTabItem: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, from, previous])=>{
                const dialog = live(hwnd);
                const start = (from >>> 0) === (hwnd >>> 0) ? 0 : from >>> 0;
                if (!dialog || (start === 0 && (previous >>> 0) !== 0))
                {
                    return 0;
                }
                return nextTabStop(dialog, start, (previous >>> 0) === 0)?.hwnd ?? 0;
            },
        },

        /**
         * HWND GetNextDlgGroupItem(HWND hDlg, HWND hCtl, BOOL bPrevious)
         *
         * The next control in the same group, which is what the arrow keys
         * move between -- inside the children the walk searches through --
         * or the first from nothing or the dialog itself, before which there
         * is none.
         */
        GetNextDlgGroupItem: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, from, previous])=>{
                const dialog = live(hwnd);
                const start = (from >>> 0) === (hwnd >>> 0) ? 0 : from >>> 0;
                if (!dialog || (start === 0 && (previous >>> 0) !== 0))
                {
                    return 0;
                }
                return nextGroupItem(dialog, start, (previous >>> 0) === 0)?.hwnd ?? 0;
            },
        },

        /**
         * BOOL IsDialogMessageA(HWND hDlg, LPMSG lpMsg)
         *
         * Enter, Escape and Tab are taken; everything else is reported as
         * not a dialog message, so the caller goes on to translate and
         * dispatch it. That is the answer that loses nothing: claiming a
         * message was handled would swallow every keystroke a dialog is
         * open for.
         */
        IsDialogMessageA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([dialog, msg])=>{
                const message = readMessage(host, msg >>> 0);
                const answered = dialogKey(dialog >>> 0, message, host.callerThread?.());
                return after(answered, taken=>(taken === null ? 0 : 1));
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
