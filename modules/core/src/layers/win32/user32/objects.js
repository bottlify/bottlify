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

/** How a menu item is addressed: by its command id, or by where it sits. */
const MF_BYCOMMAND = 0x0000;
const MF_BYPOSITION = 0x0400;

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

/**
 * ACCEL is six bytes, not eight: a BYTE, a pad byte, then two WORDs. An array
 * of them walked at four-byte stride reads every second entry as rubbish.
 */
const ACCEL_SIZE = 6;
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
 * @param {Object} options
 * @param {any} options.host
 * @param {(hwnd: number) => any | null} options.live
 */
export function createObjectFunctions({ host, live }){
    /** @type {Map<number, any>} */
    const menus = new Map();
    /** @type {Map<number, any>} */
    const accelerators = new Map();

    /**
     * The clipboard, and who has it open. Zero is a valid owner -- a program may
     * open the clipboard without naming a window -- so whether it is open is a
     * flag of its own rather than a non-zero owner.
     */
    const clipboard = { open: false, owner: 0, formats: new Map() };

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
     * 64 KiB of the address space.
     *
     * @param {number} value
     * @returns {string | number}
     */
    const propertyKey = value=>(value >>> 0) <= 0xffff
        ? value >>> 0
        : host.readCString(value >>> 0, MAX_TEXT);

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

    /** @param {number} address @returns {any | null} the item a MENUITEMINFO describes */
    const readItemInfo = address=>{
        const declared = readU32(address + MENUITEMINFO.cbSize);
        if (declared !== MENUITEMINFO.SIZE && declared !== MENUITEMINFO.SIZE_LEGACY)
        {
            return null;
        }
        const mask = readU32(address + MENUITEMINFO.fMask);
        const typeData = readU32(address + MENUITEMINFO.dwTypeData);
        return {
            mask,
            type: readU32(address + MENUITEMINFO.fType),
            state: readU32(address + MENUITEMINFO.fState),
            id: readU32(address + MENUITEMINFO.wID),
            submenu: readU32(address + MENUITEMINFO.hSubMenu),
            data: readU32(address + MENUITEMINFO.dwItemData),
            text: (mask & (MIIM_STRING | MIIM_TYPE)) !== 0 && typeData !== 0
                ? host.readCString(typeData, MAX_TEXT)
                : null,
        };
    };

    /** @param {any} record @param {number} bar */
    const scrollOf = (record, bar)=>{
        record.scroll ??= new Map();
        const which = bar | 0;
        if (!record.scroll.has(which))
        {
            record.scroll.set(which,
                { min: 0, max: 100, page: 0, pos: 0, trackPos: 0 });
        }
        return record.scroll.get(which);
    };

    return {
        /** BOOL SetPropA(HWND hWnd, LPCSTR lpString, HANDLE hData) */
        SetPropA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, name, data])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                propertiesOf(record).set(propertyKey(name), data >>> 0);
                return 1;
            },
        },

        /** HANDLE GetPropA(HWND hWnd, LPCSTR lpString) */
        GetPropA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, name])=>{
                const record = live(hwnd);
                return record ? propertiesOf(record).get(propertyKey(name)) ?? 0 : 0;
            },
        },

        /**
         * HANDLE RemovePropA(HWND hWnd, LPCSTR lpString)
         *
         * Answers with what was removed, because the value is usually a handle
         * the program now has to free -- and a program that gets zero back has
         * nothing to free.
         */
        RemovePropA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, name])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const key = propertyKey(name);
                const held = propertiesOf(record).get(key) ?? 0;
                propertiesOf(record).delete(key);
                return held;
            },
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

        /** int GetMenuItemCount(HMENU hMenu) */
        GetMenuItemCount: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>menuOf(handle)?.items.length ?? -1,
        },

        /**
         * BOOL InsertMenuItemA(HMENU hmenu, UINT item, BOOL fByPosition,
         *                     LPCMENUITEMINFOA lpmi)
         *
         * fByPosition is a separate argument here rather than a flag inside the
         * structure, which is the one thing that makes this call differ from
         * SetMenuItemInfo in shape as well as in effect.
         */
        InsertMenuItemA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, position, byPosition, info])=>{
                const menu = menuOf(handle);
                const described = (info >>> 0) === 0 ? null : readItemInfo(info);
                if (!menu || !described)
                {
                    return 0;
                }
                const at = (byPosition >>> 0) !== 0
                    ? Math.min(Math.max(position | 0, 0), menu.items.length)
                    : menu.items.findIndex((/** @type {any} */ item)=>
                        item.id === (position >>> 0));
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
        },

        /** BOOL GetMenuItemInfoA(HMENU, UINT, BOOL, LPMENUITEMINFOA) */
        GetMenuItemInfoA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, item, byPosition, info])=>{
                const menu = menuOf(handle);
                const found = menu
                    ? findItem(menu, item, (byPosition >>> 0) !== 0 ? MF_BYPOSITION : MF_BYCOMMAND)
                    : null;
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
                if ((mask & MIIM_TYPE) !== 0)
                {
                    writeU32s(info + MENUITEMINFO.fType, [held.type]);
                }
                if ((mask & MIIM_STATE) !== 0)
                {
                    writeU32s(info + MENUITEMINFO.fState, [held.state]);
                }
                if ((mask & MIIM_ID) !== 0)
                {
                    writeU32s(info + MENUITEMINFO.wID, [held.id]);
                }
                if ((mask & MIIM_SUBMENU) !== 0)
                {
                    writeU32s(info + MENUITEMINFO.hSubMenu, [held.submenu]);
                }
                if ((mask & MIIM_DATA) !== 0)
                {
                    writeU32s(info + MENUITEMINFO.dwItemData, [held.data]);
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
                        : writeString(buffer, held.text, room);
                    writeU32s(info + MENUITEMINFO.cch, [written]);
                }
                return 1;
            },
        },

        /** BOOL SetMenuItemInfoA(HMENU, UINT, BOOL, LPCMENUITEMINFOA) */
        SetMenuItemInfoA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, item, byPosition, info])=>{
                const menu = menuOf(handle);
                const found = menu
                    ? findItem(menu, item, (byPosition >>> 0) !== 0 ? MF_BYPOSITION : MF_BYCOMMAND)
                    : null;
                const described = (info >>> 0) === 0 ? null : readItemInfo(info);
                if (!found || !described)
                {
                    return 0;
                }
                const held = found.menu.items[found.at];
                // Only what the mask names is changed. Copying the whole
                // structure would blank every member the caller left alone.
                if ((described.mask & MIIM_TYPE) !== 0)
                {
                    held.type = described.type;
                }
                if ((described.mask & MIIM_STATE) !== 0)
                {
                    held.state = described.state;
                }
                if ((described.mask & MIIM_ID) !== 0)
                {
                    held.id = described.id;
                }
                if ((described.mask & MIIM_SUBMENU) !== 0)
                {
                    held.submenu = described.submenu;
                }
                if ((described.mask & MIIM_DATA) !== 0)
                {
                    held.data = described.data;
                }
                if (described.text !== null)
                {
                    held.text = described.text;
                }
                return 1;
            },
        },

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
                record.menu = menu >>> 0;
                return 1;
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
                /** @type {{ handle: number, entries: any[] }} */
                const record = { handle: 0, entries: [] };
                for (let index = 0; index < entries; index++)
                {
                    const at = index * ACCEL_SIZE;
                    record.entries.push({
                        flags: bytes[at],
                        key: bytes[at + 2] | bytes[at + 3] << 8,
                        command: bytes[at + 4] | bytes[at + 5] << 8,
                    });
                }
                record.handle = host.handles.open('accelerator', record);
                accelerators.set(record.handle, record);
                return record.handle;
            },
        },

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
                host.handles.close(record.handle);
                return 1;
            },
        },

        /**
         * int TranslateAcceleratorA(HWND hWnd, HACCEL hAccTable, LPMSG lpMsg)
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
         */
        TranslateAcceleratorA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, handle, msg])=>{
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
            },
        },

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

        /** BOOL CloseClipboard(void) */
        CloseClipboard: {
            argBytes: 0,
            handler: ()=>{
                const wasOpen = clipboard.open;
                clipboard.open = false;
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
                clipboard.formats.clear();
                return 1;
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
                return memory >>> 0;
            },
        },

        /**
         * HANDLE GetClipboardData(UINT uFormat)
         *
         * The handle goes back as it came in. What it names is the caller's --
         * global memory it allocated -- and nothing here reads through it, so
         * nothing here has to know what a format means.
         */
        GetClipboardData: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([format])=>(clipboard.open
                ? clipboard.formats.get(format >>> 0) ?? 0
                : 0),
        },

        /**
         * HCURSOR CreateCursor(HINSTANCE hInst, int xHotSpot, int yHotSpot,
         *   int nWidth, int nHeight, const VOID *pvANDPlane, const VOID *pvXORPlane)
         *
         * The bits are not read. Nothing draws a cursor, and copying two masks
         * to hold them would be storing pixels that no path consumes; what a
         * program needs back is a handle it can pass to SetCursor and destroy.
         */
        CreateCursor: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([, x, y, width, height])=>{
                if ((width | 0) <= 0 || (height | 0) <= 0)
                {
                    return 0;
                }
                return host.handles.open('cursor', {
                    hotSpot: { x: x | 0, y: y | 0 },
                    width: width | 0,
                    height: height | 0,
                });
            },
        },

        /** BOOL DestroyCursor(HCURSOR hCursor) */
        DestroyCursor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(host.handles.close(handle >>> 0) ? 1 : 0),
        },

        /** BOOL DestroyIcon(HICON hIcon) */
        DestroyIcon: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(host.handles.close(handle >>> 0) ? 1 : 0),
        },

        /**
         * HICON LoadIconA(HINSTANCE hInstance, LPCSTR lpIconName)
         *
         * A standard icon is named by a small integer and exists everywhere; one
         * out of a module's resources needs an icon decoder, which is not here.
         * Answering null for the second is what a program checks, and it goes on
         * without an icon rather than believing it has one.
         */
        LoadIconA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([instance, name])=>((instance >>> 0) === 0
                && (name >>> 0) < 0x10000 ? name >>> 0 : 0),
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
                const ceiling = Math.max(held.min, held.max - Math.max(held.page - 1, 0));
                held.pos = Math.min(Math.max(held.pos, held.min), ceiling);
                return held.pos;
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
                const ceiling = Math.max(held.min, held.max - Math.max(held.page - 1, 0));
                held.pos = Math.min(Math.max(position | 0, held.min), ceiling);
                return previous;
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
