/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Text between the two kinds of window procedure.
 *
 * A window procedure is ANSI or Unicode, and which one is fixed by how it
 * reached the window: a class registered through RegisterClassW, or a
 * procedure set through SetWindowLongW, is Unicode. A message carries its
 * text in the encoding of whoever sent it -- SendMessageA a byte string,
 * SendMessageW a wide one -- and Windows converts it on the way when the two
 * differ, so a procedure only ever reads text in its own encoding. The
 * messages that carry text are few and each carries it its own way: a pointer
 * to a string in the lParam, a buffer to fill and a count of characters, a
 * structure holding two string pointers, a character code in the wParam.
 * Everything else crosses as it came.
 *
 * The procedures that live on this side -- the default one and the system
 * classes' -- read and write the ANSI page, so a wide message to one of them
 * is converted as it would be for an ANSI procedure of the program's.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

const WM_CREATE = 0x0001;
const WM_SETTEXT = 0x000c;
const WM_GETTEXT = 0x000d;
const WM_NCCREATE = 0x0081;
const WM_CHAR = 0x0102;
const WM_DEADCHAR = 0x0103;
const WM_SYSCHAR = 0x0106;
const WM_SYSDEADCHAR = 0x0107;

/** CREATESTRUCT: the two string pointers in it, and its size. */
const CREATESTRUCT_NAME = 36;
const CREATESTRUCT_CLASS = 40;
const CREATESTRUCT_SIZE = 48;
const CREATESTRUCT_PARAMS = 0;
const CREATESTRUCT_EXSTYLE = 44;
const WS_EX_MDICHILD = 0x00000040;
/** MDICREATESTRUCT: the class and title first, nine dwords in all. */
const MDICREATESTRUCT_SIZE = 36;

/** A pointer whose high word is zero is an atom, and names no string. */
const LAST_ATOM = 0xffff;

/** The longest text read out of a message, in characters. */
const MAX_TEXT = 0x8000;

/**
 * @typedef {Object} TextMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [release]
 */

/**
 * A terminated UTF-16 string, read a piece at a time: the text may end close
 * to the end of what is mapped, and reading past its terminator must not fault.
 *
 * @param {TextMemory} memory @param {number} address @param {number} [limit]  in characters
 * @returns {string}
 */
export function readWideString(memory, address, limit = MAX_TEXT){
    const STEP = 128;
    let text = '';
    for (let at = address >>> 0; text.length < limit; at += STEP)
    {
        const piece = memory.readMemory(at, STEP);
        for (let i = 0; i + 1 < piece.length; i += 2)
        {
            const code = piece[i] | piece[i + 1] << 8;
            if (code === 0 || text.length >= limit)
            {
                return text;
            }
            text += String.fromCharCode(code);
        }
        if (piece.length < STEP)
        {
            break;
        }
    }
    return text;
}

/**
 * A string as the guest stores it, terminator included.
 *
 * @param {string} text @param {boolean} unicode
 * @returns {Uint8Array}
 */
export function textBytes(text, unicode){
    if (!unicode)
    {
        const bytes = new Uint8Array(text.length * 2 + 1);
        const encoded = encodeAnsi(text);
        bytes.set(encoded);
        return bytes.subarray(0, encoded.length + 1);
    }
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let index = 0; index < text.length; index++)
    {
        const code = text.charCodeAt(index);
        bytes[index * 2] = code & 0xff;
        bytes[index * 2 + 1] = code >>> 8;
    }
    return bytes;
}

/**
 * Reads a string in either encoding.
 *
 * @param {TextMemory} memory @param {number} address @param {boolean} unicode
 * @param {number} [limit]
 * @returns {string}
 */
export function readText(memory, address, unicode, limit = MAX_TEXT){
    return unicode ? readWideString(memory, address, limit) : memory.readCString(address, limit);
}

/**
 * Writes a string into a buffer of `room` characters, cut to fit with its
 * terminator, and answers how many characters it wrote before it.
 *
 * @param {TextMemory} memory @param {number} address @param {string} text
 * @param {number} room @param {boolean} unicode
 * @returns {number}
 */
export function writeText(memory, address, text, room, unicode){
    if (room <= 0)
    {
        return 0;
    }
    const clipped = text.slice(0, room - 1);
    memory.writeMemory(address >>> 0, textBytes(clipped, unicode));
    return clipped.length;
}

/**
 * A character code as the other kind of procedure reads it: the ANSI page's
 * byte for a UTF-16 unit and the other way round. A character the page has no
 * byte for is `?`, as the conversion Windows makes answers it.
 *
 * @param {number} code @param {boolean} toUnicode
 * @returns {number}
 */
export function convertCharacter(code, toUnicode){
    if (toUnicode)
    {
        return decodeAnsi(Uint8Array.of(code & 0xff)).charCodeAt(0);
    }
    const encoded = encodeAnsi(String.fromCharCode(code & 0xffff));
    return encoded.length > 0 ? encoded[0] : 0x3f;
}

/** @param {any} value @param {(answer: any) => any} then */
const andThen = (value, then)=>(typeof value?.then === 'function'
    ? value.then(then)
    : then(value));

/**
 * @typedef {Object} TextMessage
 * @property {number} hwnd
 * @property {number} message
 * @property {number} wParam
 * @property {number} lParam
 * @property {boolean} [unicode]  whether its text is wide; ANSI when absent
 */

/**
 * Calls a procedure with a message converted to its encoding, and converts
 * back what it answers through the caller's buffer.
 *
 * The converted text lives in memory the process heap lends for the length of
 * the call. Without a heap there is nowhere to put it: a text to set or fill
 * fails, as a conversion that cannot be made fails on Windows, and a window
 * being created still hears of it, its names unconverted, since a creation
 * refused for want of a copy would be a window that silently never existed.
 *
 * @template {TextMessage} M
 * @param {TextMemory} memory
 * @param {M} message
 * @param {boolean} toUnicode  the encoding of the procedure called
 * @param {(message: M) => number | Promise<number>} call
 * @returns {number | Promise<number>}
 */
export function translated(memory, message, toUnicode, call){
    const fromUnicode = message.unicode === true;
    /** @type {M} */
    const converted = { ...message, unicode: toUnicode };
    if (fromUnicode === toUnicode)
    {
        return call(message);
    }
    switch (message.message >>> 0){
        case WM_CHAR:
        case WM_DEADCHAR:
        case WM_SYSCHAR:
        case WM_SYSDEADCHAR:
            return call({ ...converted, wParam: convertCharacter(message.wParam, toUnicode) });
        case WM_SETTEXT:
        {
            if ((message.lParam >>> 0) === 0)
            {
                return call(converted);
            }
            if (!memory.allocate)
            {
                return 0;
            }
            const bytes = textBytes(readText(memory, message.lParam, fromUnicode), toUnicode);
            return lending(memory, bytes.length, ()=>bytes,
                text=>call({ ...converted, lParam: text }));
        }
        case WM_GETTEXT:
        {
            const room = message.wParam | 0;
            if ((message.lParam >>> 0) === 0 || room <= 0)
            {
                return call(converted);
            }
            if (!memory.allocate)
            {
                return 0;
            }
            // Room for the characters in the procedure's encoding; a character
            // of the ANSI page is never more than two bytes. What it wrote is
            // read back up to its terminator, and the answer is the count of
            // characters the caller's buffer took.
            const size = room * 2 + 2;
            return lending(memory, size, ()=>new Uint8Array(size),
                into=>andThen(call({ ...converted, lParam: into }), ()=>writeText(memory,
                    message.lParam, readText(memory, into, toUnicode, room), room, fromUnicode)));
        }
        case WM_NCCREATE:
        case WM_CREATE:
        {
            if ((message.lParam >>> 0) === 0 || !memory.allocate)
            {
                return call(converted);
            }
            const copy = createStruct(memory, message.lParam, fromUnicode, toUnicode);
            return lending(memory, copy.size, copy.build,
                address=>call({ ...converted, lParam: address }));
        }
        default:
            return call(converted);
    }
}

/**
 * A copy of a CREATESTRUCT with its two strings in the other encoding, laid
 * out behind it in one block. An atom where the class name would be stays an
 * atom, and a null name stays null. An MDI child's creation parameter is an
 * MDICREATESTRUCT, copied into the block the same way with its two names.
 *
 * @param {TextMemory} memory @param {number} address
 * @param {boolean} fromUnicode @param {boolean} toUnicode
 * @returns {{ size: number, build: (base: number) => Uint8Array }}
 */
function createStruct(memory, address, fromUnicode, toUnicode){
    const header = memory.readMemory(address >>> 0, CREATESTRUCT_SIZE);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const name = view.getUint32(CREATESTRUCT_NAME, true);
    const cls = view.getUint32(CREATESTRUCT_CLASS, true);
    const nameBytes = name === 0 ? null : textBytes(readText(memory, name, fromUnicode), toUnicode);
    const classBytes = cls <= LAST_ATOM
        ? null : textBytes(readText(memory, cls, fromUnicode), toUnicode);
    const params = view.getUint32(CREATESTRUCT_PARAMS, true);
    const mdi = (view.getUint32(CREATESTRUCT_EXSTYLE, true) & WS_EX_MDICHILD) !== 0 && params !== 0
        ? memory.readMemory(params, MDICREATESTRUCT_SIZE) : null;
    const mdiView = mdi ? new DataView(mdi.buffer, mdi.byteOffset, mdi.byteLength) : null;
    const mdiClass = mdiView ? mdiView.getUint32(0, true) : 0;
    const mdiTitle = mdiView ? mdiView.getUint32(4, true) : 0;
    const mdiClassBytes = mdiClass <= LAST_ATOM
        ? null : textBytes(readText(memory, mdiClass, fromUnicode), toUnicode);
    const mdiTitleBytes = mdiTitle === 0
        ? null : textBytes(readText(memory, mdiTitle, fromUnicode), toUnicode);
    const size = CREATESTRUCT_SIZE + (nameBytes?.length ?? 0) + (classBytes?.length ?? 0)
        + (mdi ? MDICREATESTRUCT_SIZE + (mdiClassBytes?.length ?? 0)
            + (mdiTitleBytes?.length ?? 0) : 0);
    return {
        size,
        build: base=>{
            const block = new Uint8Array(size);
            block.set(header);
            const out = new DataView(block.buffer);
            let at = CREATESTRUCT_SIZE;
            /** @param {Uint8Array | null} bytes @param {number} field */
            const place = (bytes, field)=>{
                if (bytes)
                {
                    block.set(bytes, at);
                    out.setUint32(field, (base + at) >>> 0, true);
                    at += bytes.length;
                }
            };
            place(nameBytes, CREATESTRUCT_NAME);
            place(classBytes, CREATESTRUCT_CLASS);
            if (mdi)
            {
                const mdiAt = at;
                block.set(mdi, mdiAt);
                out.setUint32(CREATESTRUCT_PARAMS, (base + mdiAt) >>> 0, true);
                at += MDICREATESTRUCT_SIZE;
                place(mdiTitleBytes, mdiAt + 4);
                place(mdiClassBytes, mdiAt);
            }
            return block;
        },
    };
}

/**
 * Lends `size` bytes of guest memory, filled by `build` once their address is
 * known, to `use`, and takes them back when the call it makes has answered.
 *
 * @param {TextMemory} memory @param {number} size
 * @param {(address: number) => Uint8Array} build
 * @param {(address: number) => number | Promise<number>} use
 * @returns {number | Promise<number>}
 */
function lending(memory, size, build, use){
    const address = /** @type {(bytes: number) => number} */ (memory.allocate)(size);
    if (address === 0)
    {
        return 0;
    }
    memory.writeMemory(address, build(address));
    /** @param {any} answer */
    const done = answer=>{
        memory.release?.(address);
        return answer;
    };
    try
    {
        const answer = use(address);
        return typeof (/** @type {any} */ (answer))?.then === 'function'
            ? /** @type {Promise<number>} */ (answer).then(done, e=>{
                done(0);
                throw e;
            })
            : done(answer);
    }
    catch (e){
        done(0);
        throw e;
    }
}
