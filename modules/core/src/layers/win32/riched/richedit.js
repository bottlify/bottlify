/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The rich edit control, as the text it holds.
 *
 * riched32 and riched20 register these classes, and what a program of this
 * era puts in one is almost always a document to be read -- a licence an
 * installer streams in as RTF and asks the person to agree to. So the control
 * is the multi-line edit with what a rich edit adds to its messages: text
 * streamed in through the program's own callback, in RTF or plain, read as the
 * characters it says; the ranges and selections given as CHARRANGE; a
 * background of its own instead of the parent's colour. The formatting -- the
 * fonts, the bold, the colours -- is read past and not shown: every character
 * is in the control's one font.
 */

import { decodeAnsi } from '../kernel32/locale.js';

/** The classes, as riched32 (1.0), riched20 (2.0 and 3.0) and msftedit (4.1) name them. */
export const RICHEDIT_CLASSES = ['RichEdit', 'RichEdit20A', 'RichEdit20W', 'RICHEDIT50W'];

/** Where the atoms the classes are spaced by begin, after comctl32's. */
const RICHEDIT_ATOM = 0x8020;

const WM_USER = 0x0400;
const EM_SETSEL = 0x00b1;
const EM_LINEFROMCHAR = 0x00c9;
const EM_LIMITTEXT = 0x00c5;
const EM_EXGETSEL = WM_USER + 52;
const EM_EXLIMITTEXT = WM_USER + 53;
const EM_EXLINEFROMCHAR = WM_USER + 54;
const EM_EXSETSEL = WM_USER + 55;
const EM_GETCHARFORMAT = WM_USER + 58;
const EM_GETEVENTMASK = WM_USER + 59;
const EM_GETOPTIONS = WM_USER + 78;
const EM_GETPARAFORMAT = WM_USER + 61;
const EM_HIDESELECTION = WM_USER + 63;
const EM_SETBKGNDCOLOR = WM_USER + 67;
const EM_SETCHARFORMAT = WM_USER + 68;
const EM_SETEVENTMASK = WM_USER + 69;
const EM_SETOPTIONS = WM_USER + 77;
const EM_SETPARAFORMAT = WM_USER + 71;
const EM_SETTARGETDEVICE = WM_USER + 72;
const EM_STREAMIN = WM_USER + 73;
const EM_STREAMOUT = WM_USER + 74;
const EM_GETTEXTRANGE = WM_USER + 75;
const EM_AUTOURLDETECT = WM_USER + 91;
const EM_GETTEXTLENGTHEX = WM_USER + 95;
const WM_SETTEXT = 0x000c;
const WM_PAINT = 0x000f;

/** EM_STREAMIN's format flags. */
const SF_TEXT = 0x0001;
const SF_RTF = 0x0002;
const SF_UNICODE = 0x0010;
const SFF_SELECTION = 0x8000;

/** The colour a rich edit's background is until EM_SETBKGNDCOLOR: COLOR_WINDOW. */
const COLOR_WINDOW = 5;

/** EDITSTREAM: the cookie, the error, the callback. */
const EDITSTREAM_ERROR = 4;
const EDITSTREAM_CALLBACK = 8;
/** How much of the stream one call of the callback is offered room for. */
const STREAM_CHUNK = 4096;
/** A stream longer than this is not a document a person reads; the rest is dropped. */
const MAX_STREAM = 1 << 22;

/**
 * Destinations whose text is no part of the document: tables, properties,
 * pictures and the like. A group opening with one of these words, or with
 * `\*`, is read past whole.
 */
const SKIPPED = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'headerl',
    'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'listtable',
    'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping',
    'latentstyles', 'datastore', 'fldinst', 'pntxta', 'pntxtb', 'bkmkstart', 'bkmkend',
    'filetbl', 'revtbl', 'mmathPr', 'pgdsctbl',
]);

/** Control words that stand for a character. */
const CHARACTERS = new Map([
    ['par', '\r\n'], ['line', '\r\n'], ['sect', '\r\n'], ['page', '\r\n'], ['row', '\r\n'],
    ['tab', '\t'], ['cell', '\t'], ['emdash', '—'], ['endash', '–'],
    ['bullet', '•'], ['lquote', '‘'], ['rquote', '’'],
    ['ldblquote', '“'], ['rdblquote', '”'], ['emspace', ' '], ['enspace', ' '],
]);

/**
 * The text of an RTF document: its characters and its paragraph breaks, as
 * CR LF, without what is no part of the text.
 *
 * Bytes `\'hh` names are in the ANSI page; `\u` gives a character by number
 * and is followed by `\ucN` characters for a reader that cannot take it,
 * which are skipped.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function rtfToText(bytes){
    let text = '';
    /** @type {number[]} */
    let pending = [];
    const flush = ()=>{
        if (pending.length > 0)
        {
            text += decodeAnsi(Uint8Array.from(pending));
            pending = [];
        }
    };
    /** What a group knows: whether its text is read past, and \uc's count. */
    let state = { skip: false, uc: 1 };
    /** @type {{ skip: boolean, uc: number }[]} */
    const stack = [];
    /** How many characters after a \u are still to be read past. */
    let owed = 0;
    /** Whether the group just opened, so its first word may name a destination. */
    let opening = false;
    /** @param {string | number} what  A character, or a byte of the ANSI page. */
    const put = what=>{
        if (owed > 0)
        {
            owed--;
            return;
        }
        if (state.skip)
        {
            return;
        }
        if (typeof what === 'number')
        {
            pending.push(what);
            return;
        }
        flush();
        text += what;
    };
    for (let at = 0; at < bytes.length; at++)
    {
        const byte = bytes[at];
        if (byte === 0x7b)
        {
            stack.push(state);
            state = { ...state };
            opening = true;
            owed = 0;
            continue;
        }
        if (byte === 0x7d)
        {
            state = stack.pop() ?? state;
            opening = false;
            owed = 0;
            continue;
        }
        const wasOpening = opening;
        opening = false;
        if (byte === 0x0d || byte === 0x0a || byte === 0)
        {
            continue;
        }
        if (byte !== 0x5c)
        {
            put(byte);
            continue;
        }
        const next = bytes[at + 1];
        if (next === undefined)
        {
            break;
        }
        const letter = (next >= 0x61 && next <= 0x7a) || (next >= 0x41 && next <= 0x5a);
        if (!letter)
        {
            at++;
            switch (next){
                case 0x27: {
                    const value = Number.parseInt(String.fromCharCode(bytes[at + 1] ?? 0,
                        bytes[at + 2] ?? 0), 16);
                    at += 2;
                    if (!Number.isNaN(value))
                    {
                        put(value);
                    }
                    break;
                }
                case 0x2a:
                    // \* -- what follows is a destination a reader may skip.
                    state.skip = true;
                    break;
                case 0x7e:
                    put(' ');
                    break;
                case 0x5f:
                    put('-');
                    break;
                case 0x0d:
                case 0x0a:
                    put('\r\n');
                    break;
                case 0x2d:
                    break;
                default:
                    put(next);
            }
            continue;
        }
        let end = at + 1;
        while (end < bytes.length && (((bytes[end] | 0x20) >= 0x61 && (bytes[end] | 0x20) <= 0x7a)))
        {
            end++;
        }
        const word = String.fromCharCode(...bytes.subarray(at + 1, end));
        let number = '';
        if (bytes[end] === 0x2d)
        {
            number = '-';
            end++;
        }
        while (end < bytes.length && bytes[end] >= 0x30 && bytes[end] <= 0x39)
        {
            number += String.fromCharCode(bytes[end]);
            end++;
        }
        // A space after a control word ends it and is no part of the text.
        at = bytes[end] === 0x20 ? end : end - 1;
        const parameter = number === '' || number === '-' ? null : Number(number);
        if (wasOpening && SKIPPED.has(word))
        {
            state.skip = true;
            continue;
        }
        if (word === 'bin' && parameter !== null)
        {
            at += parameter;
            continue;
        }
        if (word === 'uc' && parameter !== null)
        {
            state.uc = parameter;
            continue;
        }
        if (word === 'u' && parameter !== null)
        {
            put(String.fromCharCode(parameter < 0 ? parameter + 0x10000 : parameter));
            owed = state.uc;
            continue;
        }
        const character = CHARACTERS.get(word);
        if (character !== undefined)
        {
            put(character);
        }
    }
    flush();
    return text;
}

/**
 * The rich edit classes, each the multi-line edit with a rich edit's own
 * messages answered first.
 *
 * @param {import('../user32/controls.js').ControlHost & {
 *     call?: (entry: number, args: number[], thread?: unknown) => number | Promise<number> }} host
 * @param {import('../user32/controls.js').ControlToolkit} toolkit
 * @returns {{ name: string, procedure: any, atom: number }[]}
 */
export function createRichEditControls(host, toolkit){
    const edit = toolkit.editProc;
    const { stateOf, writeU32 } = toolkit;

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {any} value @param {(answer: any) => any} then */
    const after = (value, then)=>(typeof value?.then === 'function'
        ? value.then(then) : then(value));

    /**
     * The text the program's callback hands over, a chunk at a time into a
     * buffer of the guest's, until it answers an error or no bytes.
     *
     * @param {number} stream  The EDITSTREAM.
     * @param {unknown} thread
     * @returns {Uint8Array | null | Promise<Uint8Array | null>}  Null when it failed.
     */
    const readStream = (stream, thread)=>{
        const callback = readU32(stream + EDITSTREAM_CALLBACK);
        const cookie = readU32(stream);
        const buffer = host.allocate?.(STREAM_CHUNK + 4) ?? 0;
        if (callback === 0 || buffer === 0 || !host.call)
        {
            return null;
        }
        const count = buffer + STREAM_CHUNK;
        /** @type {Uint8Array[]} */
        const chunks = [];
        let total = 0;
        /** @param {Uint8Array | null} result */
        const done = result=>{
            host.release?.(buffer);
            return result;
        };
        /** @returns {Uint8Array | null | Promise<Uint8Array | null>} */
        const step = ()=>{
            writeU32(count, 0);
            const call = /** @type {NonNullable<typeof host.call>} */ (host.call);
            return after(call(callback, [cookie, buffer, STREAM_CHUNK, count], thread), error=>{
                const got = Math.min(readU32(count), STREAM_CHUNK);
                if ((error >>> 0) !== 0)
                {
                    writeU32(stream + EDITSTREAM_ERROR, error >>> 0);
                    return done(null);
                }
                if (got === 0 || total >= MAX_STREAM)
                {
                    const all = new Uint8Array(total);
                    let at = 0;
                    for (const chunk of chunks)
                    {
                        all.set(chunk, at);
                        at += chunk.length;
                    }
                    return done(all);
                }
                chunks.push(host.readMemory(buffer, got).slice());
                total += got;
                return step();
            });
        };
        writeU32(stream + EDITSTREAM_ERROR, 0);
        return step();
    };

    /**
     * EM_STREAMIN: the stream's text in place of the control's, or of its
     * selection with SFF_SELECTION; the answer is how many characters came in.
     *
     * @param {any} record @param {number} format @param {number} stream @param {unknown} thread
     */
    const streamIn = (record, format, stream, thread)=>after(readStream(stream, thread), bytes=>{
        if (!bytes)
        {
            return 0;
        }
        const text = (format & SF_RTF) !== 0 ? rtfToText(bytes)
            : (format & SF_UNICODE) !== 0
                ? String.fromCharCode(...new Uint16Array(bytes.slice(0,
                    bytes.length & ~1).buffer))
                : decodeAnsi(bytes);
        const state = stateOf(record);
        if ((format & SFF_SELECTION) !== 0)
        {
            const from = Math.min(state.selStart ?? 0, state.selEnd ?? 0);
            const to = Math.max(state.selStart ?? 0, state.selEnd ?? 0);
            record.title = record.title.slice(0, from) + text + record.title.slice(to);
            state.selStart = state.selEnd = from + text.length;
        }
        else
        {
            record.title = text;
            state.selStart = state.selEnd = 0;
            state.firstLine = 0;
        }
        state.modified = false;
        host.invalidate(record);
        return text.length;
    });

    /**
     * @param {any} record
     * @param {{ hwnd: number, message: number, wParam: number, lParam: number }} message
     * @param {unknown} [thread]
     */
    const procedure = (record, message, thread)=>{
        const state = stateOf(record);
        // Painted in its own background, not one its parent is asked for.
        state.richBackground ??= host.sysColor(COLOR_WINDOW);
        // Its scroll bars show only while there is something to scroll.
        state.rich = true;
        const { wParam, lParam } = message;
        switch (message.message){
            case EM_STREAMIN:
                if ((wParam & (SF_TEXT | SF_RTF)) === 0)
                {
                    return 0;
                }
                return streamIn(record, wParam, lParam >>> 0, thread);
            case EM_STREAMOUT:
                // Nothing is written back out; a reader is told it got nothing.
                return 0;
            case EM_EXLIMITTEXT:
                return edit(record, { ...message, message: EM_LIMITTEXT, wParam: lParam,
                    lParam: 0 }, thread);
            case EM_EXGETSEL:
                writeU32(lParam, Math.min(state.selStart ?? 0, state.selEnd ?? 0));
                writeU32(lParam + 4, Math.max(state.selStart ?? 0, state.selEnd ?? 0));
                return 0;
            case EM_EXSETSEL:
                return after(edit(record, { ...message, message: EM_SETSEL,
                    wParam: readU32(lParam), lParam: readU32(lParam + 4) }, thread),
                ()=>Math.max(state.selStart ?? 0, state.selEnd ?? 0));
            case EM_EXLINEFROMCHAR:
                return edit(record, { ...message, message: EM_LINEFROMCHAR, wParam: lParam,
                    lParam: 0 }, thread);
            case EM_GETTEXTRANGE: {
                const from = readU32(lParam) | 0;
                const to = readU32(lParam + 4) | 0;
                const target = readU32(lParam + 8);
                const slice = record.title.slice(Math.max(0, from), to < 0 ? undefined : to);
                if (target !== 0)
                {
                    toolkit.writeString(target, slice);
                }
                return slice.length;
            }
            case EM_GETTEXTLENGTHEX:
                return record.title.length;
            case EM_SETBKGNDCOLOR: {
                const previous = state.richBackground;
                state.richBackground = wParam !== 0 ? host.sysColor(COLOR_WINDOW) : lParam >>> 0;
                host.invalidate(record);
                return previous;
            }
            case EM_SETEVENTMASK: {
                const previous = state.eventMask ?? 0;
                state.eventMask = lParam >>> 0;
                return previous;
            }
            case EM_GETEVENTMASK:
                return state.eventMask ?? 0;
            case EM_SETOPTIONS:
                state.options = lParam >>> 0;
                return state.options;
            case EM_GETOPTIONS:
                return state.options ?? 0;
            case EM_SETCHARFORMAT:
            case EM_SETPARAFORMAT:
            case EM_SETTARGETDEVICE:
                return 1;
            case EM_GETCHARFORMAT:
            case EM_GETPARAFORMAT:
            case EM_HIDESELECTION:
            case EM_AUTOURLDETECT:
                return 0;
            case WM_SETTEXT:
            case WM_PAINT:
            default:
                return edit(record, message, thread);
        }
    };

    return RICHEDIT_CLASSES.map((name, index)=>({
        name, atom: RICHEDIT_ATOM + index, procedure,
    }));
}
