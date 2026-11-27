/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The STARTUPINFO a parent hands CreateProcess and its child reads back with
 * GetStartupInfo: one layout, read on one side and written on the other, and
 * between them a record of plain values, since the child may be built on
 * another thread from what crossed to it.
 */

/** Field offsets of STARTUPINFOA and STARTUPINFOW, which differ only in their strings' width. */
export const STARTUPINFO = Object.freeze({
    CB: 0,
    DESKTOP: 8,
    TITLE: 12,
    X: 16,
    Y: 20,
    X_SIZE: 24,
    Y_SIZE: 28,
    X_COUNT_CHARS: 32,
    Y_COUNT_CHARS: 36,
    FILL_ATTRIBUTE: 40,
    FLAGS: 44,
    SHOW_WINDOW: 48,
    STD_INPUT: 56,
    STD_OUTPUT: 60,
    STD_ERROR: 64,
    SIZE: 68,
});

/** The flag that says the three standard handles are the child's. */
export const STARTF_USESTDHANDLES = 0x100;

/**
 * @typedef {Object} StartupRecord
 * @property {number} flags @property {number} showWindow
 * @property {number} x @property {number} y @property {number} xSize @property {number} ySize
 * @property {number} xCountChars @property {number} yCountChars @property {number} fillAttribute
 * @property {string | null} desktop  null where the parent named none.
 * @property {string | null} title
 * @property {number} stdInput @property {number} stdOutput @property {number} stdError
 *           Zero unless STARTF_USESTDHANDLES says they are the child's.
 */

/** The four dwords from dwX on, in their order, as the record names them. */
const DWORDS = /** @type {const} */ ([
    ['x', STARTUPINFO.X], ['y', STARTUPINFO.Y], ['xSize', STARTUPINFO.X_SIZE],
    ['ySize', STARTUPINFO.Y_SIZE], ['xCountChars', STARTUPINFO.X_COUNT_CHARS],
    ['yCountChars', STARTUPINFO.Y_COUNT_CHARS], ['fillAttribute', STARTUPINFO.FILL_ATTRIBUTE],
    ['flags', STARTUPINFO.FLAGS],
]);

/**
 * What a parent's STARTUPINFO says, as values. A NULL desktop is the
 * parent's own, which a child inherits; a NULL title stays unnamed.
 *
 * @param {Uint8Array} bytes  The structure, STARTUPINFO.SIZE of it.
 * @param {(address: number) => string} readText  In the call's width.
 * @param {string | null} parentDesktop
 * @returns {StartupRecord}
 */
export function readStartupInfo(bytes, readText, parentDesktop){
    const view = new DataView(bytes.buffer, bytes.byteOffset, STARTUPINFO.SIZE);
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {number} at */
    const text = at=>(u32(at) === 0 ? null : readText(u32(at)));
    const handles = (u32(STARTUPINFO.FLAGS) & STARTF_USESTDHANDLES) !== 0;
    return {
        flags: u32(STARTUPINFO.FLAGS),
        x: u32(STARTUPINFO.X),
        y: u32(STARTUPINFO.Y),
        xSize: u32(STARTUPINFO.X_SIZE),
        ySize: u32(STARTUPINFO.Y_SIZE),
        xCountChars: u32(STARTUPINFO.X_COUNT_CHARS),
        yCountChars: u32(STARTUPINFO.Y_COUNT_CHARS),
        fillAttribute: u32(STARTUPINFO.FILL_ATTRIBUTE),
        showWindow: view.getUint16(STARTUPINFO.SHOW_WINDOW, true),
        desktop: text(STARTUPINFO.DESKTOP) ?? parentDesktop,
        title: text(STARTUPINFO.TITLE),
        stdInput: handles ? u32(STARTUPINFO.STD_INPUT) : 0,
        stdOutput: handles ? u32(STARTUPINFO.STD_OUTPUT) : 0,
        stdError: handles ? u32(STARTUPINFO.STD_ERROR) : 0,
    };
}

/**
 * The structure a child's GetStartupInfo fills in from its record, with
 * its strings at the addresses given.
 *
 * @param {StartupRecord | null} record  null for a process no parent described.
 * @param {{ desktop: number, title: number }} strings  Where each string is, 0 for none.
 * @returns {Uint8Array}
 */
export function startupInfoBytes(record, strings){
    const bytes = new Uint8Array(STARTUPINFO.SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint32(STARTUPINFO.CB, STARTUPINFO.SIZE, true);
    if (record === null)
    {
        return bytes;
    }
    for (const [name, at] of DWORDS)
    {
        view.setUint32(at, record[name] >>> 0, true);
    }
    view.setUint16(STARTUPINFO.SHOW_WINDOW, record.showWindow & 0xffff, true);
    view.setUint32(STARTUPINFO.DESKTOP, strings.desktop >>> 0, true);
    view.setUint32(STARTUPINFO.TITLE, strings.title >>> 0, true);
    view.setUint32(STARTUPINFO.STD_INPUT, record.stdInput >>> 0, true);
    view.setUint32(STARTUPINFO.STD_OUTPUT, record.stdOutput >>> 0, true);
    view.setUint32(STARTUPINFO.STD_ERROR, record.stdError >>> 0, true);
    return bytes;
}
