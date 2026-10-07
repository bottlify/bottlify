/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The things a window or a process owns rather than is: the properties hung on
 * a window, its menus and accelerators, its scroll bars, the clipboard, and the
 * cursors and icons a program loads.
 *
 * None of these draw. A menu is a tree of items with identifiers until
 * something paints a menu bar; an accelerator table is a map from a key
 * combination to a command until something translates a key. That much is
 * exactly what a program relies on -- it reads back what it put in, and it acts
 * on the command identifier rather than on the pixels -- so the bookkeeping is
 * useful on its own and is not a stand-in for drawing that will replace it.
 *
 * Two lifetimes are load-bearing and are the reason this is a file rather than
 * a scattering of maps:
 *
 * - **A property dies with its window.** Handles are recycled, so a property
 *   that outlived its window would surface on whatever window is handed that
 *   value next, as a value the new owner never set and cannot account for.
 *   They live on the window record, which is what a destroyed window loses.
 * - **The clipboard is bracketed.** SetClipboardData outside an open clipboard
 *   fails, and EmptyClipboard is what transfers ownership. A program that is
 *   told its write succeeded when the clipboard was never opened has no reason
 *   to open it.
 */

import { ddbToBgra, planesToBgra } from './cursors.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { readText, readWideString, writeText } from './unicode.js';

/** The resource directories a cursor and an icon are named in. */
export const RT_GROUP_CURSOR = 12;
export const RT_GROUP_ICON = 14;

/** The resource directory a menu template is filed under. */
const RT_MENU = 4;
/** And an accelerator table. */
const RT_ACCELERATOR = 9;

/** A resource name is an integer below this and a pointer to a string above. */
const MAX_INTEGER_RESOURCE = 0x10000;
const MAX_RESOURCE_NAME = 256;

/**
 * A cursor or icon as LoadCursor, LoadIcon and LoadImage hand one out.
 *
 * A standard one is named by a small integer on a null instance and exists
 * everywhere, so its number is its handle. One out of a module's own image
 * exists when the module carries the resource -- and then a program is owed a
 * handle it can put in a window class or pass to SetCursor. The bits are
 * decoded when SetCursor first shows it, not here: most loaded cursors are
 * never set. A program that gets null back concludes its own image is short
 * of a resource it was built with.
 *
 * @param {{ handles: { open: (type: string, object: any) => number },
 *           readCString: (address: number, maxLength: number) => string,
 *           readMemory: (address: number, length: number) => Uint8Array,
 *           writeMemory: (address: number, bytes: Uint8Array) => void,
 *           findResource?: (instance: number, type: number,
 *               name: number | string) => unknown }} host
 * @param {string} kind    The handle type opened: 'cursor' or 'icon'.
 * @param {number} type    RT_GROUP_CURSOR or RT_GROUP_ICON.
 * @param {number} instance
 * @param {number} name    An integer id or a pointer to a name.
 * @param {boolean} [wide] Whether a name is a wide string.
 */
export function loadResourceObject(host, kind, type, instance, name, wide = false){
    const module = instance >>> 0;
    const raw = name >>> 0;
    if (module === 0)
    {
        return raw < MAX_INTEGER_RESOURCE ? raw : 0;
    }
    const key = raw < MAX_INTEGER_RESOURCE ? raw : readText(host, raw, wide, MAX_RESOURCE_NAME);
    if (!host.findResource?.(module, type, key))
    {
        return 0;
    }
    return host.handles.open(kind, { instance: module, name: key });
}

/** How a menu item is addressed: by its command id, or by where it sits. */
const MF_BYCOMMAND = 0x0000;
const MF_BYPOSITION = 0x0400;
const MF_GRAYED = 0x0001;
const MF_DISABLED = 0x0002;
const MF_CHECKED = 0x0008;
const MF_HILITE = 0x0080;
const MFT_SEPARATOR = 0x0800;
const MF_BITMAP = 0x0004;
const MF_POPUP = 0x0010;
const MF_END = 0x0080;
const MF_OWNERDRAW = 0x0100;
const MF_SEPARATOR = 0x0800;
/** The check mark of the default menu font, in pixels each way. */
const CHECK_MARK_SIZE = 13;
/** What a call handed a handle that names no menu leaves for GetLastError. */
const ERROR_INVALID_MENU_HANDLE = 1401;

/**
 * The system menu every window has by default: the commands the frame's own
 * box offers, by the identifiers a program addresses them with.
 */
const SYSTEM_MENU_ITEMS = Object.freeze([
    { id: 0xf120, text: '&Restore' },
    { id: 0xf010, text: '&Move' },
    { id: 0xf000, text: '&Size' },
    { id: 0xf020, text: 'Mi&nimize' },
    { id: 0xf030, text: 'Ma&ximize' },
    { id: 0, type: MFT_SEPARATOR, text: '' },
    { id: 0xf060, text: '&Close\tAlt+F4' },
]);

/** MENUITEMINFOA, whose cbSize says which of the two versions was compiled. */
const MENUITEMINFO = Object.freeze({
    cbSize: 0,
    fMask: 4,
    fType: 8,
    fState: 12,
    wID: 16,
    hSubMenu: 20,
    hbmpChecked: 24,
    hbmpUnchecked: 28,
    dwItemData: 32,
    dwTypeData: 36,
    cch: 40,
    hbmpItem: 44,
    /** Before hbmpItem existed; a program compiled against either is served. */
    SIZE_LEGACY: 44,
    SIZE: 48,
});

/** Which members of a MENUITEMINFO the caller filled in, or wants back. */
const MIIM_STATE = 0x0001;
const MIIM_ID = 0x0002;
const MIIM_SUBMENU = 0x0004;
const MIIM_TYPE = 0x0010;
const MIIM_DATA = 0x0020;
const MIIM_STRING = 0x0040;

/** SCROLLINFO. */
const SCROLLINFO = Object.freeze({
    cbSize: 0,
    fMask: 4,
    nMin: 8,
    nMax: 12,
    nPage: 16,
    nPos: 20,
    nTrackPos: 24,
    SIZE: 28,
});

/** Which members of a SCROLLINFO are meant. */
const SIF_RANGE = 0x0001;
const SIF_PAGE = 0x0002;
const SIF_POS = 0x0004;
const SIF_TRACKPOS = 0x0010;

/** Which bar: the two a window has, or a scroll-bar control. */
const SB_HORZ = 0;
const SB_VERT = 1;
const SB_BOTH = 3;

/** EnableScrollBar's wArrows: both arrows usable is the state a bar starts in. */
const ESB_ENABLE_BOTH = 0;

/**
 * ACCEL is six bytes, not eight: a BYTE, a pad byte, then two WORDs. An array
 * of them walked at four-byte stride reads every second entry as rubbish.
 */
const ACCEL_SIZE = 6;
/** An entry of an RT_ACCELERATOR resource, and the flag its last one carries. */
const ACCEL_RESOURCE_SIZE = 8;
const ACCEL_LAST = 0x80;
/** The flags a table keeps of an entry's byte. */
const ACCEL_FLAGS = 0x7f;
const FVIRTKEY = 0x01;
const FSHIFT = 0x04;
const FCONTROL = 0x08;
const FALT = 0x10;

/** The key messages an accelerator may be translated out of. */
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const WM_COMMAND = 0x0111;

/** Virtual keys the modifier flags refer to. */
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;

/** A string longer than this is a pointer that is not one. */
const MAX_TEXT = 1 << 16;

/**
 * The clipboard formats that are text, and the ceiling on how much of one is
 * read out. A program copies a whole error console in one go, which is well
 * past MAX_TEXT and still worth having.
 */
const CF_TEXT = 1;
const CF_OEMTEXT = 7;
const CF_UNICODETEXT = 13;
const MAX_CLIPBOARD_TEXT = 1 << 20;

/**
 * Closes a handle a program handed to a destroy entry point.
 *
 * A shared standard object -- a cursor or icon named by a small integer on a
 * null instance -- is never opened in the table, and an invalid handle is not
 * either; Windows fails the destroy of both rather than performing it. The
 * table's close throws on a handle it does not know, so that a guest whose
 * bookkeeping has gone wrong is diagnosed rather than silently ignored, which
 * makes the throw the failure answer here rather than something to let escape
 * into the guest and stop it.
 *
 * @param {{ handles: { close: (handle: number) => unknown } }} host
 * @param {number} handle
 * @returns {boolean} whether there was an object to destroy
 */
function destroyObjectHandle(host, handle){
    try
    {
        host.handles.close(handle);
        return true;
    }
    catch (e){
        void e;
        return false;
    }
}

/**
 * A parsed menu template: items end to end, a popup's own items nested in it.
 *
 * @typedef {Object} ParsedMenuItem
 * @property {number} id
 * @property {number} type
 * @property {number} state
 * @property {ParsedMenuItem[] | null} popup  The items a popup holds, else null.
 * @property {string} text
 */

/**
 * One entry of an accelerator table: the key -- a virtual key under FVIRTKEY,
 * else a character -- and the command it sends.
 *
 * @typedef {Object} AcceleratorEntry
 * @property {number} flags
 * @property {number} key
 * @property {number} command
 */

/** How deep a menu resource may nest before it is read as damaged. */
const MAX_MENU_DEPTH = 16;

/**
 * The text a menu item carries: UTF-16 up to its terminator, read out of the
 * template's own bytes. Null when the bytes end first, which is a template
 * that was cut rather than a menu with an empty string in it.
 *
 * @param {Uint8Array} bytes @param {number} at
 * @returns {{ text: string, end: number } | null}
 */
const wideText = (bytes, at)=>{
    let text = '';
    for (let index = at; ; index += 2)
    {
        if (index + 1 >= bytes.length)
        {
            return null;
        }
        const unit = bytes[index] | bytes[index + 1] << 8;
        if (unit === 0)
        {
            return { text, end: index + 2 };
        }
        text += String.fromCharCode(unit);
    }
};

/**
 * One menu level of an RT_MENU template, and where the level after it starts.
 *
 * The layout is the resource compiler's own: a WORD of option flags, a WORD id
 * that a popup does not carry, then the item's text. Items sit end to end with
 * no padding between them; a popup's items follow its own text at once, and
 * MF_END closes the level they are in -- which for the last popup on a level
 * closes both, its own flags carrying MF_POPUP and MF_END together. The top
 * level ends at the resource's end whether or not the last item said MF_END,
 * because a bar menu is not required to.
 *
 * @param {Uint8Array} bytes @param {number} start @param {number} depth
 * @param {boolean} topLevel
 * @returns {{ items: ParsedMenuItem[], end: number } | null}
 *     Null when the bytes run out mid-item, or the nesting goes too deep.
 */
const parseMenuLevel = (bytes, start, depth, topLevel)=>{
    if (depth > MAX_MENU_DEPTH)
    {
        return null;
    }
    /** @type {ParsedMenuItem[]} */
    const items = [];
    let at = start;
    for (;;)
    {
        if (at + 2 > bytes.length)
        {
            // Out of bytes. The top level may simply have ended; a popup that
            // ends without MF_END was cut, and guessing where it stopped would
            // invent items.
            return topLevel ? { items, end: at } : null;
        }
        const option = bytes[at] | bytes[at + 1] << 8;
        at += 2;
        const popup = (option & MF_POPUP) !== 0;
        let id = 0;
        if (!popup)
        {
            if (at + 2 > bytes.length)
            {
                return null;
            }
            id = bytes[at] | bytes[at + 1] << 8;
            at += 2;
        }
        const named = wideText(bytes, at);
        if (named === null)
        {
            return null;
        }
        at = named.end;
        // A separator is an item with no id and no text; the compiler spells
        // it with the separator flag or with nothing at all, and either reads
        // the same.
        const separator = (option & MF_SEPARATOR) !== 0
            || (!popup && id === 0 && named.text === '');
        /** @type {ParsedMenuItem} */
        const item = {
            id: popup ? 0 : id,
            type: (separator ? MFT_SEPARATOR : 0) | (option & MF_OWNERDRAW),
            state: option & (MF_GRAYED | MF_DISABLED | MF_CHECKED),
            popup: null,
            text: separator || (option & (MF_BITMAP | MF_OWNERDRAW)) !== 0 ? '' : named.text,
        };
        if (popup)
        {
            const inner = parseMenuLevel(bytes, at, depth + 1, false);
            if (inner === null)
            {
                return null;
            }
            item.popup = inner.items;
            at = inner.end;
        }
        items.push(item);
        if ((option & MF_END) !== 0)
        {
            return { items, end: at };
        }
    }
};

/**
 * A whole RT_MENU resource: the two-word header, then the top level.
 *
 * The header is a version that is always zero and a count of the bytes that
 * come after it before the first item, which is how a resource says where its
 * items start rather than assuming they follow at once.
 *
 * @param {Uint8Array} bytes
 * @returns {ParsedMenuItem[] | null}
 */
const parseMenuTemplate = bytes=>{
    if (bytes.length < 4 || (bytes[0] | bytes[1] << 8) !== 0)
    {
        return null;
    }
    const parsed = parseMenuLevel(bytes, 4 + (bytes[2] | bytes[3] << 8), 0, true);
    return parsed?.items ?? null;
};


/**
 * The clipboard as a control reaches it -- an edit's WM_COPY and WM_PASTE --
 * rather than through the exports a program calls.
 *
 * @typedef {Object} ClipboardService
 * @property {() => string | null} text
 *           The text a paste takes: the program's own, else the host's, and
 *           nothing while a program holds the clipboard open.
 * @property {(text: string) => boolean} copy
 *           Makes text the clipboard's CF_TEXT, as a control that opens,
 *           empties, sets and closes it does; false while a program holds it
 *           open.
 */

/** CopyImage's image types it copies, and the flag that lets the original go. */
const IMAGE_ICON = 1;
const IMAGE_CURSOR = 2;
const LR_COPYDELETEORG = 0x8;
/** What GetIconInfo answers for a handle that is no icon or cursor. */
const ERROR_INVALID_CURSOR_HANDLE = 1402;

/**
 * @param {Object} options
 * @param {any} options.host
 * @param {(hwnd: number) => any | null} options.live
 * @param {(service: ClipboardService) => void} [options.clipboardService]
 *        Handed the clipboard for the controls' own use.
 * @param {(record: any, previous: number) => number | Promise<number>} [options.menuChanged]
 *        Told a window's menu changed, which moves its client area when a bar
 *        comes or goes; answers what SetMenu answers once the window is told.
 */
export function createObjectFunctions({ host, live, clipboardService, menuChanged }){
    /** @type {Map<number, any>} */
    const menus = new Map();
    /** @type {Map<number, any>} */
    const accelerators = new Map();
    /** The tables loaded out of a module, by module and name, to their handles. */
    /** @type {Map<string, number>} */
    const loadedAccelerators = new Map();

    /**
     * The clipboard, and who has it open. Zero is a valid owner -- a program may
     * open the clipboard without naming a window -- so whether it is open is a
     * flag of its own rather than a non-zero owner.
     */
    const clipboard = { open: false, owner: 0, formats: new Map(), changed: false, emptiedAt: 0 };

    /** The text formats a host paste answers for. */
    const TEXT_FORMATS = new Set([CF_TEXT, CF_OEMTEXT, CF_UNICODETEXT]);

    /**
     * The guest copies of the host's pasted text, one per format asked for,
     * kept until the host pastes again: the handle a program is given has
     * to stay readable for as long as it keeps it, and a program that pastes
     * twice reads the same bytes twice.
     */
    const pasted = { version: 0, /** @type {Map<number, number>} */ handles: new Map() };

    /**
     * What the host last pasted, unless the program has emptied the
     * clipboard since: EmptyClipboard makes the program the owner, and what
     * it then puts there is the clipboard until the host pastes again.
     *
     * @returns {{ text: string, version: number } | null}
     */
    const hostText = ()=>{
        const board = host.pasteboard;
        return board && typeof board.text === 'string' && board.version > clipboard.emptiedAt
            ? board
            : null;
    };

    /**
     * The pasted text laid down in guest memory in one format: UTF-16 for
     * CF_UNICODETEXT, the ANSI page for CF_TEXT, one byte per character
     * otherwise with what does not fit a byte as '?', a terminator after it
     * each way.
     *
     * @param {number} format @param {string} text @returns {number}
     */
    const layDown = (format, text)=>{
        const clipped = text.slice(0, MAX_CLIPBOARD_TEXT);
        const wide = format === CF_UNICODETEXT;
        /** @type {Uint8Array} */
        let bytes;
        if (format === CF_TEXT)
        {
            bytes = encodeAnsi(`${clipped}\0`);
        }
        else
        {
            bytes = new Uint8Array((clipped.length + 1) * (wide ? 2 : 1));
            for (let at = 0; at < clipped.length; at++)
            {
                const code = clipped.charCodeAt(at);
                if (wide)
                {
                    bytes[at * 2] = code & 0xff;
                    bytes[at * 2 + 1] = code >>> 8;
                }
                else
                {
                    bytes[at] = code < 0x100 ? code : 0x3f;
                }
            }
        }
        const address = host.allocate(bytes.length);
        host.writeMemory(address, bytes);
        return address;
    };

    /**
     * The handle for a pasted text in one format, made on first request and
     * remade after the next paste, the old copies given back.
     *
     * @param {number} format @returns {number}
     */
    const pastedHandle = format=>{
        const board = hostText();
        if (!board || !TEXT_FORMATS.has(format) || !host.allocate)
        {
            return 0;
        }
        if (pasted.version !== board.version)
        {
            for (const handle of pasted.handles.values())
            {
                host.release?.(handle);
            }
            pasted.handles.clear();
            pasted.version = board.version;
        }
        let handle = pasted.handles.get(format);
        if (handle === undefined)
        {
            handle = layDown(format, board.text);
            pasted.handles.set(format, handle);
        }
        return handle;
    };

    /** Every format the clipboard holds, the program's own first. */
    const clipboardFormats = ()=>[
        ...clipboard.formats.keys(),
        ...(hostText() ? [...TEXT_FORMATS].filter(format=>!clipboard.formats.has(format)) : []),
    ];

    /**
     * A terminated string read a piece at a time, so a short one does not
     * cost the whole ceiling and a long one is not refused at a fixed limit.
     *
     * @param {number} address @param {1 | 2} width Bytes per character.
     */
    const readTerminated = (address, width)=>{
        const STEP = 256;
        let text = '';
        for (let at = 0; at < MAX_CLIPBOARD_TEXT; at += STEP)
        {
            const piece = host.readMemory(address + at, STEP);
            for (let index = 0; index + width <= piece.length; index += width)
            {
                const code = width === 2 ? piece[index] | piece[index + 1] << 8 : piece[index];
                if (code === 0)
                {
                    return text;
                }
                text += String.fromCharCode(code);
            }
        }
        return text;
    };

    /** CF_TEXT's bytes, as the characters they are in the ANSI page. @param {number} address */
    const readAnsiText = address=>decodeAnsi(Uint8Array.from(readTerminated(address, 1),
        character=>character.charCodeAt(0)));

    /**
     * The text the clipboard holds, if it holds any. Unicode is preferred
     * over the byte formats because it is the one that lost nothing; a null
     * handle is delayed rendering, which nothing here asks the owner for.
     *
     * @returns {string | null}
     */
    const clipboardText = ()=>{
        const wide = clipboard.formats.get(CF_UNICODETEXT);
        if (wide)
        {
            return readTerminated(wide, 2);
        }
        const ansi = clipboard.formats.get(CF_TEXT);
        if (ansi)
        {
            return readAnsiText(ansi);
        }
        const oem = clipboard.formats.get(CF_OEMTEXT);
        return oem ? readTerminated(oem, 1) : null;
    };

    /**
     * What a control put on the clipboard is memory of ours, given back when
     * the clipboard is next emptied, as Windows frees what it held.
     *
     * @type {Set<number>}
     */
    const controlCopies = new Set();
    const releaseControlCopies = ()=>{
        for (const handle of controlCopies)
        {
            host.release?.(handle);
        }
        controlCopies.clear();
    };

    clipboardService?.({
        text: ()=>(clipboard.open ? null : clipboardText() ?? hostText()?.text ?? null),
        copy: text=>{
            if (clipboard.open)
            {
                return false;
            }
            releaseControlCopies();
            clipboard.formats.clear();
            clipboard.emptiedAt = host.pasteboard?.version ?? 0;
            if (host.allocate)
            {
                const handle = layDown(CF_TEXT, text);
                clipboard.formats.set(CF_TEXT, handle);
                controlCopies.add(handle);
            }
            host.clipboard?.(text);
            return true;
        },
    });

    /** @param {boolean} wide */
    const menuString = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, id, buffer, room, flags])=>{
            const menu = menuOf(handle);
            const found = menu ? findItem(menu, id, flags) : null;
            const text = found ? String(found.menu.items[found.at].text ?? '') : '';
            if ((buffer >>> 0) === 0)
            {
                return text.length;
            }
            if ((room | 0) <= 0)
            {
                return 0;
            }
            const clipped = text.slice(0, (room | 0) - 1);
            if (!wide)
            {
                return writeString(buffer >>> 0, clipped, room | 0);
            }
            host.writeMemory(buffer >>> 0,
                new Uint8Array(Uint16Array.from(`${clipped} `, c=>c.charCodeAt(0)).buffer));
            return clipped.length;
        },
    });

    /** In the ANSI page. @param {number} address @param {string} text @param {number} limit */
    const writeString = (address, text, limit)=>{
        const clipped = limit > 0 ? text.slice(0, limit - 1) : '';
        host.writeMemory(address, encodeAnsi(`${clipped}\0`));
        return clipped.length;
    };

    /** @param {number} address @returns {number} */
    const readU32 = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} address @param {number[]} values */
    const writeU32s = (address, values)=>{
        const bytes = new Uint8Array(values.length * 4);
        for (let index = 0; index < values.length; index++)
        {
            const value = values[index] >>> 0;
            const at = index * 4;
            bytes[at] = value & 0xff;
            bytes[at + 1] = value >>> 8 & 0xff;
            bytes[at + 2] = value >>> 16 & 0xff;
            bytes[at + 3] = value >>> 24 & 0xff;
        }
        host.writeMemory(address, bytes);
    };

    /**
     * A property is named by a string or by an atom, and the two are told apart
     * the way GetProcAddress tells them apart: a value whose high word is zero
     * is a number rather than a pointer, because no string may live in the first
     * 64 KiB of the address space. A name is an atom underneath, so the case it
     * is spelled in, and the encoding, make no difference.
     *
     * @param {number} value @param {boolean} [wide]
     * @returns {string | number}
     */
    const propertyKey = (value, wide = false)=>((value >>> 0) <= 0xffff
        ? value >>> 0
        : (wide ? readWideString(host, value >>> 0, MAX_TEXT)
            : host.readCString(value >>> 0, MAX_TEXT)).toUpperCase());

    /**
     * SetProp, GetProp and RemoveProp, for either spelling.
     *
     * @param {boolean} wide
     */
    const propertyCalls = wide=>({
        /** @param {number[]} args */
        set: ([hwnd, name, data])=>{
            const record = live(hwnd);
            if (!record)
            {
                return 0;
            }
            propertiesOf(record).set(propertyKey(name, wide), data >>> 0);
            return 1;
        },
        /** @param {number[]} args */
        get: ([hwnd, name])=>{
            const record = live(hwnd);
            return record ? propertiesOf(record).get(propertyKey(name, wide)) ?? 0 : 0;
        },
        /** @param {number[]} args */
        remove: ([hwnd, name])=>{
            const record = live(hwnd);
            if (!record)
            {
                return 0;
            }
            const key = propertyKey(name, wide);
            const held = propertiesOf(record).get(key) ?? 0;
            propertiesOf(record).delete(key);
            return held;
        },
    });
    const ansiProperties = propertyCalls(false);
    const wideProperties = propertyCalls(true);

    /** @param {any} record @returns {Map<string | number, number>} */
    const propertiesOf = record=>{
        record.properties ??= new Map();
        return record.properties;
    };

    /** @param {number} handle @returns {any | null} */
    const menuOf = handle=>menus.get(handle >>> 0) ?? null;

    /**
     * The item a call means. MF_BYPOSITION indexes the list; the default,
     * MF_BYCOMMAND, searches it -- and searches submenus too, which is why a
     * program can delete a nested item without naming the menu it is in.
     *
     * @param {any} menu @param {number} id @param {number} flags
     * @returns {{ menu: any, at: number } | null}
     */
    const findItem = (menu, id, flags)=>{
        if ((flags & MF_BYPOSITION) !== 0)
        {
            const at = id | 0;
            return at >= 0 && at < menu.items.length ? { menu, at } : null;
        }
        for (let at = 0; at < menu.items.length; at++)
        {
            if (menu.items[at].id === (id >>> 0))
            {
                return { menu, at };
            }
            const child = menuOf(menu.items[at].submenu);
            const nested = child ? findItem(child, id, flags) : null;
            if (nested)
            {
                return nested;
            }
        }
        return null;
    };

    /**
     * The item a MENUITEMINFOA or MENUITEMINFOW describes; the two differ only
     * in what dwTypeData points at.
     *
     * Under MIIM_TYPE alone dwTypeData is a string only for a string item:
     * for a bitmap it is the bitmap's handle, for an owner-drawn item the
     * program's own value and for a separator nothing, and reading any of
     * them as a pointer reads wherever it happens to point. Such an item
     * carries no text.
     *
     * @param {number} address @param {boolean} wide
     * @returns {any | null}
     */
    const readItemInfo = (address, wide)=>{
        const declared = readU32(address + MENUITEMINFO.cbSize);
        if (declared !== MENUITEMINFO.SIZE && declared !== MENUITEMINFO.SIZE_LEGACY)
        {
            return null;
        }
        const mask = readU32(address + MENUITEMINFO.fMask);
        const type = readU32(address + MENUITEMINFO.fType);
        const typeData = readU32(address + MENUITEMINFO.dwTypeData);
        const notText = (mask & MIIM_STRING) === 0
            && (type & (MF_BITMAP | MF_OWNERDRAW | MFT_SEPARATOR)) !== 0;
        /** @type {string | null} */
        let text = null;
        if ((mask & (MIIM_STRING | MIIM_TYPE)) !== 0)
        {
            if (notText)
            {
                text = '';
            }
            else if (typeData !== 0)
            {
                text = readText(host, typeData, wide, MAX_TEXT);
            }
        }
        return {
            mask,
            type,
            state: readU32(address + MENUITEMINFO.fState),
            id: readU32(address + MENUITEMINFO.wID),
            submenu: readU32(address + MENUITEMINFO.hSubMenu),
            data: readU32(address + MENUITEMINFO.dwItemData),
            text,
        };
    };

    /**
     * Parsed items made into a live menu, its popups made into live menus of
     * their own first so an item's `submenu` is the handle a program then
     * addresses them by. Every menu is registered as it is made, so a popup
     * this walks past is one GetSubMenu and DestroyMenu already know.
     *
     * @param {ParsedMenuItem[]} parsed @param {boolean} popup
     * @returns {number} the new menu's handle
     */
    const materializeMenu = (parsed, popup)=>{
        /** @type {{ handle: number, popup: boolean, items: any[] }} */
        const record = { handle: 0, popup, items: [] };
        record.handle = host.handles.open('menu', record);
        menus.set(record.handle, record);
        for (const item of parsed)
        {
            record.items.push({
                id: item.id, type: item.type, state: item.state, data: 0, text: item.text,
                submenu: item.popup === null ? 0 : materializeMenu(item.popup, true),
            });
        }
        return record.handle;
    };

    /**
     * A menu out of a module's resources: the template is found where the
     * loader mapped it, read in place, and built into the same records
     * CreateMenu keeps. Null answers zero rather than guessing at a menu a
     * program would then act on commands from.
     *
     * @param {number} instance @param {number} name @param {boolean} wide
     * @returns {number} the loaded menu's handle, or zero
     */
    const loadMenu = (instance, name, wide)=>{
        const module = instance >>> 0;
        const raw = name >>> 0;
        const key = raw < MAX_INTEGER_RESOURCE
            ? raw
            : (wide ? readTerminated(raw, 2) : host.readCString(raw, MAX_RESOURCE_NAME));
        const found = /** @type {{ rva: number, size: number } | null} */ (
            host.findResource?.(module, RT_MENU, key) ?? null);
        const base = host.moduleBase?.(module) ?? 0;
        if (found === null || base === 0)
        {
            return 0;
        }
        const items = parseMenuTemplate(
            host.readMemory((base + found.rva) >>> 0, found.size));
        return items === null ? 0 : materializeMenu(items, false);
    };

    /**
     * The item AppendMenu and InsertMenu describe with flags: the id is a
     * submenu's handle when MF_POPUP is among them, and the last argument is
     * the text unless the item is a separator, a bitmap or owner-drawn --
     * when it is a handle or data the program will read back, not a string.
     *
     * @param {number} uFlags @param {number} id @param {number} newItem
     * @param {boolean} wide
     */
    const flaggedItem = (uFlags, id, newItem, wide)=>{
        const flags = uFlags >>> 0;
        const separator = (flags & MF_SEPARATOR) !== 0;
        const popup = (flags & MF_POPUP) !== 0;
        return {
            id: popup ? 0 : id >>> 0,
            type: (separator ? MFT_SEPARATOR : 0) | (flags & MF_OWNERDRAW),
            state: flags & (MF_GRAYED | MF_DISABLED | MF_CHECKED | MF_HILITE),
            submenu: popup ? id >>> 0 : 0,
            data: (flags & MF_OWNERDRAW) !== 0 ? newItem >>> 0 : 0,
            text: separator || (flags & (MF_BITMAP | MF_OWNERDRAW)) !== 0 || (newItem >>> 0) === 0
                ? ''
                : readText(host, newItem >>> 0, wide, MAX_TEXT),
        };
    };

    /** AppendMenuA or AppendMenuW. @param {boolean} wide */
    const appendMenu = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, flags, id, newItem])=>{
            const menu = menuOf(handle);
            if (!menu)
            {
                return 0;
            }
            menu.items.push(flaggedItem(flags, id, newItem, wide));
            return 1;
        },
    });

    /** InsertMenuA or InsertMenuW. @param {boolean} wide */
    const insertMenu = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, position, flags, id, newItem])=>{
            const menu = menuOf(handle);
            if (!menu)
            {
                return 0;
            }
            const found = findItem(menu, position, flags);
            const into = found?.menu ?? menu;
            into.items.splice(found ? found.at : into.items.length, 0,
                flaggedItem(flags, id, newItem, wide));
            return 1;
        },
    });

    /**
     * InsertMenuItemA or InsertMenuItemW. fByPosition is an argument here
     * rather than a flag inside the structure, which is the one thing that
     * makes this call differ from SetMenuItemInfo in shape as well as in
     * effect.
     *
     * @param {boolean} wide
     */
    const insertMenuItem = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, position, byPosition, info])=>{
            const menu = menuOf(handle);
            const described = (info >>> 0) === 0 ? null : readItemInfo(info, wide);
            if (!menu || !described)
            {
                return 0;
            }
            const at = (byPosition >>> 0) !== 0
                ? Math.min(Math.max(position | 0, 0), menu.items.length)
                : menu.items.findIndex((/** @type {any} */ item)=>item.id === (position >>> 0));
            menu.items.splice(at < 0 ? menu.items.length : at, 0, {
                id: described.id,
                type: described.type,
                state: described.state,
                submenu: described.submenu,
                data: described.data,
                text: described.text ?? '',
            });
            return 1;
        },
    });

    /**
     * The item GetMenuItemInfo or SetMenuItemInfo names, by place or by
     * command.
     *
     * @param {number} handle @param {number} item @param {number} byPosition
     */
    const itemNamed = (handle, item, byPosition)=>{
        const menu = menuOf(handle);
        return menu
            ? findItem(menu, item, (byPosition >>> 0) !== 0 ? MF_BYPOSITION : MF_BYCOMMAND)
            : null;
    };

    /**
     * GetMenuItemInfoA or GetMenuItemInfoW: the two write the same structure,
     * and the text in the caller's encoding with cch counting its characters.
     *
     * @param {boolean} wide
     */
    const getMenuItemInfo = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, item, byPosition, info])=>{
            const found = itemNamed(handle, item, byPosition);
            if (!found || (info >>> 0) === 0)
            {
                return 0;
            }
            const declared = readU32(info + MENUITEMINFO.cbSize);
            if (declared !== MENUITEMINFO.SIZE && declared !== MENUITEMINFO.SIZE_LEGACY)
            {
                return 0;
            }
            const mask = readU32(info + MENUITEMINFO.fMask);
            const held = found.menu.items[found.at];
            /** @type {[number, number, number][]} */
            const members = [
                [MIIM_TYPE, MENUITEMINFO.fType, held.type],
                [MIIM_STATE, MENUITEMINFO.fState, held.state],
                [MIIM_ID, MENUITEMINFO.wID, held.id],
                [MIIM_SUBMENU, MENUITEMINFO.hSubMenu, held.submenu],
                [MIIM_DATA, MENUITEMINFO.dwItemData, held.data],
            ];
            for (const [bit, offset, value] of members)
            {
                if ((mask & bit) !== 0)
                {
                    writeU32s(info + offset, [value]);
                }
            }
            if ((mask & (MIIM_STRING | MIIM_TYPE)) !== 0)
            {
                // cch is the buffer's size going in and the length coming
                // out, and dwTypeData being null means the caller is asking
                // for that length rather than for the text.
                const buffer = readU32(info + MENUITEMINFO.dwTypeData);
                const room = readU32(info + MENUITEMINFO.cch);
                const written = buffer === 0
                    ? held.text.length
                    : writeText(host, buffer, held.text, room, wide);
                writeU32s(info + MENUITEMINFO.cch, [written]);
            }
            return 1;
        },
    });

    /** SetMenuItemInfoA or SetMenuItemInfoW. @param {boolean} wide */
    const setMenuItemInfo = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, item, byPosition, info])=>{
            const found = itemNamed(handle, item, byPosition);
            const described = (info >>> 0) === 0 ? null : readItemInfo(info, wide);
            if (!found || !described)
            {
                return 0;
            }
            const held = found.menu.items[found.at];
            // Only what the mask names is changed. Copying the whole
            // structure would blank every member the caller left alone.
            /** @type {[number, string][]} */
            const members = [
                [MIIM_TYPE, 'type'], [MIIM_STATE, 'state'], [MIIM_ID, 'id'],
                [MIIM_SUBMENU, 'submenu'], [MIIM_DATA, 'data'],
            ];
            for (const [bit, name] of members)
            {
                if ((described.mask & bit) !== 0)
                {
                    held[name] = described[name];
                }
            }
            if (described.text !== null)
            {
                held.text = described.text;
            }
            return 1;
        },
    });

    /**
     * A table made out of its entries and given a handle.
     *
     * @param {AcceleratorEntry[]} entries @param {string | null} [loadedAs]
     *     The module and name a loaded table answers to again.
     */
    const openAccelerators = (entries, loadedAs = null)=>{
        /** @type {{ handle: number, entries: AcceleratorEntry[], loadedAs: string | null }} */
        const record = { handle: 0, entries, loadedAs };
        record.handle = host.handles.open('accelerator', record);
        accelerators.set(record.handle, record);
        return record;
    };

    /** LoadAcceleratorsA or LoadAcceleratorsW. @param {boolean} wide */
    const loadAccelerators = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [instance, name])=>{
            const module = instance >>> 0;
            const raw = name >>> 0;
            const key = raw < MAX_INTEGER_RESOURCE
                ? raw
                : readText(host, raw, wide, MAX_RESOURCE_NAME);
            // A resource name compares without regard to case.
            const loadedAs = `${module}:${typeof key === 'number' ? `#${key}` : key.toUpperCase()}`;
            const held = loadedAccelerators.get(loadedAs);
            if (held !== undefined)
            {
                return held;
            }
            const found = /** @type {{ rva: number, size: number } | null} */ (
                host.findResource?.(module, RT_ACCELERATOR, key) ?? null);
            const base = host.moduleBase?.(module) ?? 0;
            if (found === null || base === 0)
            {
                return 0;
            }
            const bytes = host.readMemory((base + found.rva) >>> 0, found.size);
            /** @type {AcceleratorEntry[]} */
            const entries = [];
            for (let at = 0; at + ACCEL_RESOURCE_SIZE <= bytes.length; at += ACCEL_RESOURCE_SIZE)
            {
                const flags = bytes[at];
                entries.push({
                    flags: flags & ACCEL_FLAGS,
                    key: bytes[at + 2] | bytes[at + 3] << 8,
                    command: bytes[at + 4] | bytes[at + 5] << 8,
                });
                if ((flags & ACCEL_LAST) !== 0)
                {
                    break;
                }
            }
            if (entries.length === 0)
            {
                return 0;
            }
            const record = openAccelerators(entries, loadedAs);
            loadedAccelerators.set(loadedAs, record.handle);
            return record.handle;
        },
    });

    /** CopyAcceleratorTable, either spelling. @param {number[]} args */
    const copyAccelerators = ([handle, out, room])=>{
        const record = accelerators.get(handle >>> 0);
        if (!record)
        {
            return 0;
        }
        if ((out >>> 0) === 0)
        {
            return record.entries.length;
        }
        const count = Math.min(Math.max(room | 0, 0), record.entries.length);
        const bytes = new Uint8Array(count * ACCEL_SIZE);
        for (let index = 0; index < count; index++)
        {
            /** @type {AcceleratorEntry} */
            const entry = record.entries[index];
            const at = index * ACCEL_SIZE;
            bytes[at] = entry.flags;
            bytes[at + 2] = entry.key & 0xff;
            bytes[at + 3] = entry.key >>> 8;
            bytes[at + 4] = entry.command & 0xff;
            bytes[at + 5] = entry.command >>> 8;
        }
        host.writeMemory(out >>> 0, bytes);
        return count;
    };

    /** @param {number[]} args */
    const translateAccelerator = ([hwnd, handle, msg])=>{
        const record = accelerators.get(handle >>> 0);
        const target = live(hwnd);
        if (!record || !target || (msg >>> 0) === 0)
        {
            return 0;
        }
        const message = readU32((msg >>> 0) + 4);
        if (message !== WM_KEYDOWN && message !== WM_SYSKEYDOWN)
        {
            return 0;
        }
        const key = readU32((msg >>> 0) + 8) & 0xffff;
        const match = record.entries.find((/** @type {any} */ entry)=>
            entry.key === key
            && (entry.flags & FVIRTKEY) !== 0
            && (entry.flags & (FSHIFT | FCONTROL | FALT)) === 0);
        if (!match)
        {
            return 0;
        }
        host.queue.post({
            hwnd: target.hwnd,
            message: WM_COMMAND,
            // The high word says an accelerator produced this, not a
            // menu, which is how a handler tells the two apart.
            wParam: (1 << 16 | match.command) >>> 0,
            lParam: 0,
        });
        return 1;
    };

    /** @param {any} record @param {number} bar */
    const scrollOf = (record, bar)=>{
        record.scroll ??= new Map();
        const which = bar | 0;
        if (!record.scroll.has(which))
        {
            record.scroll.set(which,
                { min: 0, max: 100, page: 0, pos: 0, trackPos: 0, arrows: ESB_ENABLE_BOTH });
        }
        return record.scroll.get(which);
    };

    /**
     * Where a thumb can actually sit: the range less the page. The position
     * is clamped there after any change to the range, the page or itself.
     * @param {{ min: number, max: number, page: number, pos: number }} held
     */
    const clampScroll = held=>{
        const ceiling = Math.max(held.min, held.max - Math.max(held.page - 1, 0));
        held.pos = Math.min(Math.max(held.pos, held.min), ceiling);
        return held.pos;
    };

    return {
        /** BOOL SetPropA/W(HWND hWnd, LPCSTR lpString, HANDLE hData) */
        SetPropA: { argBytes: 12, handler: ansiProperties.set },
        SetPropW: { argBytes: 12, handler: wideProperties.set },

        /** HANDLE GetPropA/W(HWND hWnd, LPCSTR lpString) */
        GetPropA: { argBytes: 8, handler: ansiProperties.get },
        GetPropW: { argBytes: 8, handler: wideProperties.get },

        /**
         * HANDLE RemovePropA(HWND hWnd, LPCSTR lpString)
         *
         * Answers with what was removed, because the value is usually a handle
         * the program now has to free -- and a program that gets zero back has
         * nothing to free.
         */
        RemovePropA: { argBytes: 8, handler: ansiProperties.remove },
        RemovePropW: { argBytes: 8, handler: wideProperties.remove },

        /**
         * BOOL SetWindowContextHelpId(HWND hwnd, DWORD dwContextHelpId)
         * DWORD GetWindowContextHelpId(HWND hwnd)
         *
         * A number the program hangs on a window for its own help to find
         * when F1 is pressed over it; it lives on the window record, so it
         * dies with the window as a property does. Zero for no window.
         */
        SetWindowContextHelpId: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, id])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                record.contextHelpId = id >>> 0;
                return 1;
            },
        },
        GetWindowContextHelpId: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>live(hwnd)?.contextHelpId ?? 0,
        },

        /** HMENU CreateMenu(void) */
        CreateMenu: {
            argBytes: 0,
            handler: ()=>{
                const record = { handle: 0, popup: false, items: [] };
                record.handle = host.handles.open('menu', record);
                menus.set(record.handle, record);
                return record.handle;
            },
        },

        /** HMENU CreatePopupMenu(void) */
        CreatePopupMenu: {
            argBytes: 0,
            handler: ()=>{
                const record = { handle: 0, popup: true, items: [] };
                record.handle = host.handles.open('menu', record);
                menus.set(record.handle, record);
                return record.handle;
            },
        },

        /**
         * HMENU LoadMenuA(HINSTANCE hInstance, LPCSTR lpMenuName)
         *
         * A menu the program's own resources carry, built into the records the
         * menu calls above already read. Zero when there is no such resource,
         * which is what a program checks before it puts the menu on a window.
         */
        LoadMenuA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([instance, name])=>loadMenu(instance, name, false),
        },

        /** HMENU LoadMenuW(HINSTANCE, LPCWSTR) -- the same menu, named in wide text. */
        LoadMenuW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([instance, name])=>loadMenu(instance, name, true),
        },

        /**
         * BOOL DestroyMenu(HMENU hMenu)
         *
         * A submenu is destroyed with the menu that holds it: it was handed over
         * at the moment it was inserted, and a program that destroyed it itself
         * would be freeing something twice.
         */
        DestroyMenu: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const menu = menuOf(handle);
                if (!menu)
                {
                    return 0;
                }
                for (const item of menu.items)
                {
                    const child = menuOf(item.submenu);
                    if (child)
                    {
                        menus.delete(child.handle);
                        host.handles.close(child.handle);
                    }
                }
                menus.delete(menu.handle);
                host.handles.close(menu.handle);
                return 1;
            },
        },

        /**
         * BOOL IsMenu(HMENU hMenu)
         *
         * Whether the handle names a menu that has not been destroyed; a
         * handle that does not is refused with the reason, as Windows refuses
         * it.
         */
        IsMenu: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (menuOf(handle))
                {
                    return 1;
                }
                host.setLastError?.(ERROR_INVALID_MENU_HANDLE);
                return 0;
            },
        },

        /** HMENU GetSubMenu(HMENU hMenu, int nPos) */
        GetSubMenu: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, position])=>{
                const menu = menuOf(handle);
                const found = menu ? findItem(menu, position, MF_BYPOSITION) : null;
                return found ? found.menu.items[found.at].submenu >>> 0 : 0;
            },
        },

        /**
         * int GetMenuStringA(HMENU hMenu, UINT uIDItem, LPSTR lpString, int cchMax,
         *                    UINT flags)
         *
         * The item's text, cut to the room given with its terminator, and the
         * count of characters copied; a null buffer asks for the length.
         * An item that is not there answers 0, as a separator does.
         */
        GetMenuStringA: menuString(false),

        /** int GetMenuStringW: the same, in UTF-16 and counted in characters. */
        GetMenuStringW: menuString(true),

        /**
         * UINT GetMenuItemID(HMENU hMenu, int nPos)
         *
         * -1 for an item that opens a submenu, as documented: a submenu has no
         * command of its own.
         */
        GetMenuItemID: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, position])=>{
                const menu = menuOf(handle);
                const found = menu ? findItem(menu, position, MF_BYPOSITION) : null;
                if (!found)
                {
                    return -1;
                }
                const item = found.menu.items[found.at];
                return item.submenu ? -1 : item.id >>> 0;
            },
        },

        /**
         * UINT GetMenuState(HMENU hMenu, UINT uId, UINT uFlags)
         *
         * The item's state and type flags together, which is the shape of the
         * old MF_ bits; for a submenu the low byte is the number of items in
         * it. -1 when there is no such item.
         */
        GetMenuState: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, id, flags])=>{
                const menu = menuOf(handle);
                const found = menu ? findItem(menu, id, flags) : null;
                if (!found)
                {
                    return -1;
                }
                const item = found.menu.items[found.at];
                const child = menuOf(item.submenu);
                const bits = (item.state | item.type) >>> 0;
                return child ? (bits & 0xffffff00) | (child.items.length & 0xff) : bits;
            },
        },

        /**
         * BOOL EnableMenuItem(HMENU, UINT uIDEnableItem, UINT uEnable)
         * DWORD CheckMenuItem(HMENU, UINT uIDCheckItem, UINT uCheck)
         *
         * Each answers the previous state of the bits it sets, or -1 for no
         * such item, which is the documented shape for both.
         */
        EnableMenuItem: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, id, flags])=>{
                const menu = menuOf(handle);
                const found = menu ? findItem(menu, id, flags) : null;
                if (!found)
                {
                    return -1;
                }
                const item = found.menu.items[found.at];
                const previous = item.state & (MF_GRAYED | MF_DISABLED);
                item.state = (item.state & ~(MF_GRAYED | MF_DISABLED))
                    | (flags & (MF_GRAYED | MF_DISABLED));
                return previous;
            },
        },

        CheckMenuItem: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, id, flags])=>{
                const menu = menuOf(handle);
                const found = menu ? findItem(menu, id, flags) : null;
                if (!found)
                {
                    return -1;
                }
                const item = found.menu.items[found.at];
                const previous = item.state & MF_CHECKED;
                item.state = (item.state & ~MF_CHECKED) | (flags & MF_CHECKED);
                return previous;
            },
        },

        /**
         * BOOL ModifyMenuA(HMENU, UINT uPosition, UINT uFlags, UINT_PTR uIDNewItem,
         *                  LPCSTR lpNewItem)
         * BOOL SetMenuItemBitmaps(HMENU, UINT uPosition, UINT uFlags,
         *                         HBITMAP hBitmapUnchecked, HBITMAP hBitmapChecked)
         *
         * The old-style edit and the check-mark pictures. Neither changes a
         * menu here, and each says so once: a program that redraws its menu on
         * every command would otherwise be told, silently, that every one of
         * those redraws failed.
         */
        ModifyMenuA: {
            argBytes: 20,
            handler: ()=>{
                host.divergence?.('ModifyMenuA', 'the item is left as it was');
                return 1;
            },
        },
        ModifyMenuW: {
            argBytes: 20,
            handler: ()=>{
                host.divergence?.('ModifyMenuW', 'the item is left as it was');
                return 1;
            },
        },

        SetMenuItemBitmaps: {
            argBytes: 20,
            handler: ()=>{
                host.divergence?.('SetMenuItemBitmaps', 'a menu draws no check-mark pictures here');
                return 1;
            },
        },

        /**
         * LONG GetMenuCheckMarkDimensions(VOID)
         *
         * The size of the check mark a menu draws, width in the low word. A
         * program sizes its owner-drawn items from it, so it is a metric
         * rather than nothing: the one the display's default menu font gives.
         */
        GetMenuCheckMarkDimensions: {
            argBytes: 0,
            handler: ()=>CHECK_MARK_SIZE | CHECK_MARK_SIZE << 16,
        },

        /** BOOL DeleteMenu(HMENU hMenu, UINT uPosition, UINT uFlags) */
        DeleteMenu: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, position, flags])=>{
                const menu = menuOf(handle);
                const found = menu ? findItem(menu, position, flags) : null;
                if (!found)
                {
                    return 0;
                }
                found.menu.items.splice(found.at, 1);
                return 1;
            },
        },

        /**
         * BOOL RemoveMenu(HMENU hMenu, UINT uPosition, UINT uFlags)
         *
         * DeleteMenu without the destruction: an item that opens a submenu
         * is taken out and the submenu stays the program's, which is what
         * lets it be put back or hung elsewhere.
         */
        RemoveMenu: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, position, flags])=>{
                const menu = menuOf(handle);
                const found = menu ? findItem(menu, position, flags) : null;
                if (!found)
                {
                    return 0;
                }
                found.menu.items.splice(found.at, 1);
                return 1;
            },
        },

        /**
         * HMENU GetSystemMenu(HWND hWnd, BOOL bRevert)
         *
         * A window's system menu is made the first time it is asked for, with
         * the standard commands, and kept: a program asks for it to gray the
         * close command and expects the next ask to find that done. Revert
         * throws the copy away and answers nothing, as documented.
         */
        GetSystemMenu: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, revert])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                if ((revert >>> 0) !== 0)
                {
                    const held = menuOf(record.systemMenu ?? 0);
                    if (held)
                    {
                        menus.delete(held.handle);
                        host.handles.close(held.handle);
                    }
                    record.systemMenu = 0;
                    return 0;
                }
                if (!menuOf(record.systemMenu ?? 0))
                {
                    const menu = { handle: 0, popup: true, items: SYSTEM_MENU_ITEMS.map(item=>({
                        id: item.id, type: item.type ?? 0, state: 0, submenu: 0, data: 0,
                        text: item.text,
                    })) };
                    menu.handle = host.handles.open('menu', menu);
                    menus.set(menu.handle, menu);
                    record.systemMenu = menu.handle;
                }
                return record.systemMenu;
            },
        },

        /** int GetMenuItemCount(HMENU hMenu) */
        GetMenuItemCount: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>menuOf(handle)?.items.length ?? -1,
        },

        /**
         * BOOL InsertMenuItemA(HMENU hmenu, UINT item, BOOL fByPosition,
         *                     LPCMENUITEMINFOA lpmi)
         * BOOL InsertMenuItemW(HMENU hmenu, UINT item, BOOL fByPosition,
         *                     LPCMENUITEMINFOW lpmi)
         */
        InsertMenuItemA: insertMenuItem(false),
        InsertMenuItemW: insertMenuItem(true),

        /**
         * BOOL AppendMenuA(HMENU hMenu, UINT uFlags, UINT_PTR uIDNewItem, LPCSTR lpNewItem)
         * BOOL AppendMenuW(HMENU hMenu, UINT uFlags, UINT_PTR uIDNewItem, LPCWSTR lpNewItem)
         *
         * The older spelling of an insertion at the end, the item described
         * by flags rather than by a MENUITEMINFO (`flaggedItem`).
         */
        AppendMenuA: appendMenu(false),
        AppendMenuW: appendMenu(true),

        /**
         * BOOL InsertMenuA(HMENU hMenu, UINT uPosition, UINT uFlags,
         *                  UINT_PTR uIDNewItem, LPCSTR lpNewItem)
         * BOOL InsertMenuW(HMENU hMenu, UINT uPosition, UINT uFlags,
         *                  UINT_PTR uIDNewItem, LPCWSTR lpNewItem)
         *
         * The new item goes before the one uPosition names. MF_BYPOSITION
         * counts places, and -1 or a place past the last item is the end;
         * by command the item is searched for through the submenus as every
         * by-command call searches, and the new one joins whichever menu
         * holds it. A command no item has puts the new one at the end of the
         * menu named, as a position past the last does.
         */
        InsertMenuA: insertMenu(false),
        InsertMenuW: insertMenu(true),

        /**
         * BOOL GetMenuItemInfoA(HMENU, UINT, BOOL, LPMENUITEMINFOA)
         * BOOL GetMenuItemInfoW(HMENU, UINT, BOOL, LPMENUITEMINFOW)
         */
        GetMenuItemInfoA: getMenuItemInfo(false),
        GetMenuItemInfoW: getMenuItemInfo(true),

        /**
         * BOOL SetMenuItemInfoA(HMENU, UINT, BOOL, LPCMENUITEMINFOA)
         * BOOL SetMenuItemInfoW(HMENU, UINT, BOOL, LPCMENUITEMINFOW)
         */
        SetMenuItemInfoA: setMenuItemInfo(false),
        SetMenuItemInfoW: setMenuItemInfo(true),

        /** HMENU GetMenu(HWND hWnd) */
        GetMenu: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>live(hwnd)?.menu ?? 0,
        },

        /** BOOL SetMenu(HWND hWnd, HMENU hMenu) */
        SetMenu: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, menu])=>{
                const record = live(hwnd);
                if (!record || ((menu >>> 0) !== 0 && !menuOf(menu)))
                {
                    return 0;
                }
                const previous = record.menu;
                record.menu = menu >>> 0;
                return menuChanged?.(record, previous) ?? 1;
            },
        },

        /**
         * BOOL DrawMenuBar(HWND hWnd)
         *
         * Nothing draws a menu bar, and nothing lays one out either -- so there
         * is no cached layout for this to invalidate. It succeeds for a window
         * that exists, which is what a caller checks.
         */
        DrawMenuBar: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(live(hwnd) ? 1 : 0),
        },

        /**
         * BOOL TrackPopupMenu(HMENU hMenu, UINT uFlags, int x, int y,
         *                    int nReserved, HWND hWnd, const RECT *prcRect)
         *
         * A popup menu is shown and waited on until the person using it chooses.
         * There is nobody to choose, so this reports that the menu was dismissed
         * without a selection -- which is zero, and which every caller already
         * handles because dismissing a menu is ordinary.
         */
        TrackPopupMenu: {
            argBytes: 28,
            handler: ()=>0,
        },

        /**
         * HACCEL CreateAcceleratorTableA(LPACCEL paccel, int cAccel)
         *
         * Each entry is six bytes, not eight. Walking the array at four-byte
         * stride reads every second entry out of the middle of its neighbour,
         * which produces a table of plausible-looking rubbish rather than an
         * error.
         */
        CreateAcceleratorTableA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([table, count])=>{
                const entries = count | 0;
                if ((table >>> 0) === 0 || entries <= 0)
                {
                    return 0;
                }
                const bytes = host.readMemory(table >>> 0, entries * ACCEL_SIZE);
                /** @type {AcceleratorEntry[]} */
                const read = [];
                for (let index = 0; index < entries; index++)
                {
                    const at = index * ACCEL_SIZE;
                    read.push({
                        flags: bytes[at] & ACCEL_FLAGS,
                        key: bytes[at + 2] | bytes[at + 3] << 8,
                        command: bytes[at + 4] | bytes[at + 5] << 8,
                    });
                }
                return openAccelerators(read).handle;
            },
        },

        /**
         * HACCEL LoadAcceleratorsA(HINSTANCE hInstance, LPCSTR lpTableName)
         * HACCEL LoadAcceleratorsW(HINSTANCE hInstance, LPCWSTR lpTableName)
         *
         * A table out of a module's RT_ACCELERATOR resource. The resource's
         * entries are eight bytes each, a word apiece for the flags, the key
         * and the command and one of padding, and the last says it is the
         * last with 0x80 in its flags; that bit is the resource's and not
         * the table's. The table belongs to the module: loading the same one
         * again answers the same handle rather than another copy, which is
         * why a program never destroys what it loaded. Null for a module
         * that does not carry the resource.
         */
        LoadAcceleratorsA: loadAccelerators(false),
        LoadAcceleratorsW: loadAccelerators(true),

        /**
         * int CopyAcceleratorTableA(HACCEL hAccelSrc, LPACCEL lpAccelDst, int cAccelEntries)
         * int CopyAcceleratorTableW(HACCEL hAccelSrc, LPACCEL lpAccelDst, int cAccelEntries)
         *
         * A null destination asks how many entries there are, whatever the
         * count says; otherwise as many as fit are written and their number
         * is the answer. The key is written back as it was given, in either
         * spelling, and the flags without their top bit -- user32's
         * resource tests read back 0x7f for a table made with 0xff.
         */
        CopyAcceleratorTableA: { argBytes: 12, handler: copyAccelerators },
        CopyAcceleratorTableW: { argBytes: 12, handler: copyAccelerators },

        /** BOOL DestroyAcceleratorTable(HACCEL hAccel) */
        DestroyAcceleratorTable: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const record = accelerators.get(handle >>> 0);
                if (!record)
                {
                    return 0;
                }
                accelerators.delete(record.handle);
                if (record.loadedAs !== null)
                {
                    loadedAccelerators.delete(record.loadedAs);
                }
                host.handles.close(record.handle);
                return 1;
            },
        },

        /**
         * int TranslateAcceleratorA(HWND hWnd, HACCEL hAccTable, LPMSG lpMsg)
         * int TranslateAcceleratorW(HWND hWnd, HACCEL hAccTable, LPMSG lpMsg)
         *
         * A match turns the key message into WM_COMMAND, and the caller must
         * then *not* translate or dispatch it -- which is what the return value
         * says. Reporting a match without producing the command would swallow
         * the keystroke; producing it without reporting would deliver both.
         *
         * The modifier flags are compared against no keyboard state, because
         * there is none: an accelerator that requires a modifier cannot be
         * matched here, and saying so is better than firing a command on the
         * unmodified key.
         *
         * The two spellings differ only in how a WM_CHAR's character is read,
         * and only virtual-key entries are matched here, so they are one.
         */
        TranslateAcceleratorA: { argBytes: 12, handler: translateAccelerator },
        TranslateAcceleratorW: { argBytes: 12, handler: translateAccelerator },

        /** BOOL OpenClipboard(HWND hWndNewOwner) */
        OpenClipboard: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                if (clipboard.open)
                {
                    return 0;
                }
                clipboard.open = true;
                clipboard.owner = hwnd >>> 0;
                return 1;
            },
        },

        /**
         * BOOL CloseClipboard(void)
         *
         * Closing is when a copy is complete, so this is where the text goes
         * to the host -- and only when the contents changed under this open,
         * because a program that opened the clipboard to paste would
         * otherwise push its stale copy over whatever the person took since.
         */
        CloseClipboard: {
            argBytes: 0,
            handler: ()=>{
                const wasOpen = clipboard.open;
                clipboard.open = false;
                if (wasOpen && clipboard.changed)
                {
                    clipboard.changed = false;
                    const text = clipboardText();
                    if (text !== null)
                    {
                        host.clipboard?.(text);
                    }
                }
                return wasOpen ? 1 : 0;
            },
        },

        /**
         * BOOL EmptyClipboard(void)
         *
         * Only while it is open: this is the call that transfers ownership, and
         * a program that has not opened the clipboard is not the owner to
         * transfer it to.
         */
        EmptyClipboard: {
            argBytes: 0,
            handler: ()=>{
                if (!clipboard.open)
                {
                    return 0;
                }
                releaseControlCopies();
                clipboard.formats.clear();
                clipboard.changed = true;
                clipboard.emptiedAt = host.pasteboard?.version ?? 0;
                return 1;
            },
        },

        /** BOOL IsClipboardFormatAvailable(UINT format) */
        IsClipboardFormatAvailable: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([format])=>(clipboardFormats().includes(format >>> 0) ? 1 : 0),
        },

        /** int CountClipboardFormats(void) */
        CountClipboardFormats: {
            argBytes: 0,
            handler: ()=>clipboardFormats().length,
        },

        /**
         * UINT EnumClipboardFormats(UINT format)
         *
         * The format after the one given, zero for the first, and zero at
         * the end -- which is also the answer with the clipboard closed.
         */
        EnumClipboardFormats: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([format])=>{
                if (!clipboard.open)
                {
                    return 0;
                }
                const formats = clipboardFormats();
                const at = (format >>> 0) === 0 ? -1 : formats.indexOf(format >>> 0);
                return at === -1 && (format >>> 0) !== 0 ? 0 : formats[at + 1] ?? 0;
            },
        },

        /** HANDLE SetClipboardData(UINT uFormat, HANDLE hMem) */
        SetClipboardData: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([format, memory])=>{
                if (!clipboard.open)
                {
                    return 0;
                }
                clipboard.formats.set(format >>> 0, memory >>> 0);
                clipboard.changed = true;
                return memory >>> 0;
            },
        },

        /**
         * HANDLE GetClipboardData(UINT uFormat)
         *
         * A handle a program put there goes back as it came in: what it names
         * is the caller's own global memory, and nothing here reads through
         * it. What the host pasted is laid down in guest memory in the
         * format asked for, as a handle GlobalLock answers with itself.
         */
        GetClipboardData: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([format])=>(clipboard.open
                ? clipboard.formats.get(format >>> 0) ?? pastedHandle(format >>> 0)
                : 0),
        },

        /**
         * HCURSOR CreateCursor(HINSTANCE hInst, int xHotSpot, int yHotSpot,
         *   int nWidth, int nHeight, const VOID *pvANDPlane, const VOID *pvXORPlane)
         *
         * The two planes are read now, as the call documents copying them:
         * the picture is what SetCursor hands the page.
         */
        CreateCursor: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([, x, y, width, height, and, xor])=>{
                const MAX_SIDE = 256;
                const across = width | 0;
                const down = height | 0;
                if (across <= 0 || down <= 0 || across > MAX_SIDE || down > MAX_SIDE)
                {
                    return 0;
                }
                const size = ((across + 15) >>> 4) * 2 * down;
                // A plane not given is a bitmap made without bits: all zero.
                /** @param {number} plane */
                const read = plane=>((plane >>> 0) === 0
                    ? new Uint8Array(size) : host.readMemory(plane >>> 0, size));
                const hotSpot = { x: x | 0, y: y | 0 };
                return host.handles.open('cursor', {
                    hotSpot, width: across, height: down,
                    picture: { width: across, height: down, hotSpot,
                        bgra: planesToBgra(across, down, read(and), read(xor)) },
                });
            },
        },

        /**
         * HICON CreateIcon(HINSTANCE hInstance, int nWidth, int nHeight, BYTE cPlanes,
         *   BYTE cBitsPixel, const BYTE *lpbANDbits, const BYTE *lpbXORbits)
         *
         * The AND plane monochrome as CreateCursor's, the XOR bitmap of the
         * planes times bits per pixel, device-dependent with its rows padded
         * to a WORD; both read now, as the call copies them.
         */
        CreateIcon: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([, width, height, planes, bits, and, xor])=>{
                const MAX_SIDE = 256;
                const across = width | 0;
                const down = height | 0;
                const depth = (planes & 0xff) * (bits & 0xff);
                if (across <= 0 || down <= 0 || across > MAX_SIDE || down > MAX_SIDE
                    || ![1, 4, 8, 16, 24, 32].includes(depth))
                {
                    return 0;
                }
                /** @param {number} plane @param {number} size */
                const read = (plane, size)=>((plane >>> 0) === 0
                    ? new Uint8Array(size) : host.readMemory(plane >>> 0, size));
                const mask = read(and, ((across + 15) >>> 4) * 2 * down);
                const colour = read(xor, ((across * depth + 15) >>> 4) * 2 * down);
                const hotSpot = { x: across >> 1, y: down >> 1 };
                return host.handles.open('icon', {
                    hotSpot, width: across, height: down,
                    picture: { width: across, height: down, hotSpot,
                        bgra: ddbToBgra(across, down, depth, mask, colour) },
                });
            },
        },

        /** BOOL DestroyCursor(HCURSOR hCursor) */
        DestroyCursor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(destroyObjectHandle(host, handle >>> 0) ? 1 : 0),
        },

        /**
         * HANDLE CopyImage(HANDLE h, UINT type, int cx, int cy, UINT flags)
         *
         * An icon or cursor copied as the picture it is, at the size it has:
         * the handle is new, the object behind it the same drawing, and
         * LR_COPYDELETEORG lets the original go. A bitmap is GDI's, and not
         * copied here.
         */
        CopyImage: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, type, , , flags])=>{
                const kind = type >>> 0 === IMAGE_ICON ? 'icon'
                    : type >>> 0 === IMAGE_CURSOR ? 'cursor' : null;
                if (kind === null)
                {
                    host.divergence?.('CopyImage', `image type ${type >>> 0} is not copied`);
                    return 0;
                }
                /** @param {string} which */
                const held = which=>{
                    try
                    {
                        return host.handles.resolve?.(handle >>> 0, which) ?? null;
                    }
                    catch {
                        return null;
                    }
                };
                // LoadIcon and LoadCursor make the same picture; either kind is taken.
                const object = held(kind) ?? held(kind === 'icon' ? 'cursor' : 'icon');
                if (!object)
                {
                    return 0;
                }
                const copy = host.handles.open(kind, { ...object });
                if ((flags & LR_COPYDELETEORG) !== 0)
                {
                    destroyObjectHandle(host, handle >>> 0);
                }
                return copy;
            },
        },

        /**
         * BOOL GetIconInfo(HICON hIcon, PICONINFO piconinfo)
         *
         * Whether it is an icon and where its hot spot is. The mask and
         * colour bitmaps a caller would own are not made: the picture is
         * kept as pixels, not as GDI bitmaps, so both come back empty.
         */
        GetIconInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                /** @param {string} which */
                const held = which=>{
                    try
                    {
                        return host.handles.resolve?.(handle >>> 0, which) ?? null;
                    }
                    catch {
                        return null;
                    }
                };
                const icon = held('icon');
                const object = icon ?? held('cursor');
                if (!object || (out >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_INVALID_CURSOR_HANDLE);
                    return 0;
                }
                host.divergence?.('GetIconInfo', 'the mask and colour bitmaps are not made');
                const hotSpot = object.hotSpot ?? (icon
                    ? { x: (object.width ?? 32) >> 1, y: (object.height ?? 32) >> 1 }
                    : { x: 0, y: 0 });
                const bytes = new Uint8Array(20);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, icon ? 1 : 0, true);
                view.setUint32(4, hotSpot.x >>> 0, true);
                view.setUint32(8, hotSpot.y >>> 0, true);
                host.writeMemory(out >>> 0, bytes);
                return 1;
            },
        },

        /** BOOL DestroyIcon(HICON hIcon) */
        DestroyIcon: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(destroyObjectHandle(host, handle >>> 0) ? 1 : 0),
        },

        /** HICON LoadIconA(HINSTANCE hInstance, LPCSTR lpIconName) */
        LoadIconA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([instance, name])=>
                loadResourceObject(host, 'icon', RT_GROUP_ICON, instance, name),
        },

        /** HICON LoadIconW(HINSTANCE hInstance, LPCWSTR lpIconName) */
        LoadIconW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([instance, name])=>
                loadResourceObject(host, 'icon', RT_GROUP_ICON, instance, name, true),
        },

        /** BOOL GetScrollInfo(HWND hwnd, int nBar, LPSCROLLINFO lpsi) */
        GetScrollInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, bar, info])=>{
                const record = live(hwnd);
                if (!record || (info >>> 0) === 0
                    || readU32(info + SCROLLINFO.cbSize) !== SCROLLINFO.SIZE)
                {
                    return 0;
                }
                const mask = readU32(info + SCROLLINFO.fMask);
                const held = scrollOf(record, bar);
                if ((mask & SIF_RANGE) !== 0)
                {
                    writeU32s(info + SCROLLINFO.nMin, [held.min, held.max]);
                }
                if ((mask & SIF_PAGE) !== 0)
                {
                    writeU32s(info + SCROLLINFO.nPage, [held.page]);
                }
                if ((mask & SIF_POS) !== 0)
                {
                    writeU32s(info + SCROLLINFO.nPos, [held.pos]);
                }
                if ((mask & SIF_TRACKPOS) !== 0)
                {
                    writeU32s(info + SCROLLINFO.nTrackPos, [held.trackPos]);
                }
                return 1;
            },
        },

        /**
         * int SetScrollInfo(HWND hwnd, int nBar, LPCSCROLLINFO lpsi, BOOL redraw)
         *
         * The position is clamped to the range less the page, which is where a
         * thumb can actually sit -- and the return is the position after that
         * clamping rather than the one asked for, because a caller that scrolled
         * past the end needs to know where it ended up.
         */
        SetScrollInfo: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, bar, info])=>{
                const record = live(hwnd);
                if (!record || (info >>> 0) === 0
                    || readU32(info + SCROLLINFO.cbSize) !== SCROLLINFO.SIZE)
                {
                    return 0;
                }
                const mask = readU32(info + SCROLLINFO.fMask);
                const held = scrollOf(record, bar);
                if ((mask & SIF_RANGE) !== 0)
                {
                    held.min = readU32(info + SCROLLINFO.nMin) | 0;
                    held.max = readU32(info + SCROLLINFO.nMax) | 0;
                }
                if ((mask & SIF_PAGE) !== 0)
                {
                    held.page = readU32(info + SCROLLINFO.nPage) | 0;
                }
                if ((mask & SIF_POS) !== 0)
                {
                    held.pos = readU32(info + SCROLLINFO.nPos) | 0;
                }
                return clampScroll(held);
            },
        },

        /** int SetScrollPos(HWND hWnd, int nBar, int nPos, BOOL bRedraw) */
        SetScrollPos: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, bar, position])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const held = scrollOf(record, bar);
                const previous = held.pos;
                held.pos = position | 0;
                clampScroll(held);
                return previous;
            },
        },

        /**
         * The older, pre-SCROLLINFO half of the same state: a range set through
         * one is read through the other, since a program of the era mixes them.
         *
         * BOOL GetScrollRange(HWND hWnd, int nBar, LPINT lpMinPos, LPINT lpMaxPos)
         */
        GetScrollRange: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, bar, minOut, maxOut])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const held = scrollOf(record, bar);
                if ((minOut >>> 0) !== 0)
                {
                    writeU32s(minOut >>> 0, [held.min]);
                }
                if ((maxOut >>> 0) !== 0)
                {
                    writeU32s(maxOut >>> 0, [held.max]);
                }
                return 1;
            },
        },

        /** BOOL SetScrollRange(HWND hWnd, int nBar, int nMinPos, int nMaxPos, BOOL bRedraw) */
        SetScrollRange: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([hwnd, bar, min, max])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const held = scrollOf(record, bar);
                held.min = min | 0;
                held.max = max | 0;
                clampScroll(held);
                return 1;
            },
        },

        /** int GetScrollPos(HWND hWnd, int nBar) */
        GetScrollPos: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, bar])=>{
                const record = live(hwnd);
                return record ? scrollOf(record, bar).pos : 0;
            },
        },

        /**
         * BOOL ShowScrollBar(HWND hWnd, int wBar, BOOL bShow)
         *
         * Nothing here draws a window's own scroll bars, so there is nothing
         * to show or hide; the call succeeds for a live window, which is all
         * a caller checks.
         */
        ShowScrollBar: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd])=>live(hwnd) ? 1 : 0,
        },

        /**
         * BOOL EnableScrollBar(HWND hWnd, UINT wSBflags, UINT wArrows)
         *
         * Zero when the arrows were already in the state asked for: a caller
         * that tracks its own state counts on the answer to say whether
         * anything changed.
         */
        EnableScrollBar: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, bar, arrows])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const bars = (bar | 0) === SB_BOTH ? [SB_HORZ, SB_VERT] : [bar | 0];
                let changed = 0;
                for (const which of bars)
                {
                    const held = scrollOf(record, which);
                    if (held.arrows !== (arrows >>> 0))
                    {
                        held.arrows = arrows >>> 0;
                        changed = 1;
                    }
                }
                return changed;
            },
        },
    };
}

/** The layouts a test asserts against, so a change to one is visible. */
export const OBJECT_LAYOUT = Object.freeze({
    MENUITEMINFO,
    SCROLLINFO,
    ACCEL_SIZE,
    SB_HORZ,
    SB_VERT,
    VK_SHIFT,
    VK_CONTROL,
    VK_MENU,
});
