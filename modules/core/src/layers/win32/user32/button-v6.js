/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * The messages only Common Controls 6's button answers (BCM_*): its image
 * list, text margin, split-button part, command-link note and ideal size.
 * One button serves both versions (decisions.md A257): a window of user32's
 * class (`controlsVersion` 5) hands these to DefWindowProc, as user32's own
 * button does, and answers 0.
 *
 * What a message stores and reads back follows Wine's button test, which
 * says what Windows answers; the ideal size is the room the content needs:
 * the text in the window's font, the image beside it or above it as the
 * alignment says, the button's frame round them and the split part beside.
 */

export const BCM_GETIDEALSIZE = 0x1601;
export const BCM_SETIMAGELIST = 0x1602;
export const BCM_GETIMAGELIST = 0x1603;
export const BCM_SETTEXTMARGIN = 0x1604;
export const BCM_GETTEXTMARGIN = 0x1605;
const BCM_SETDROPDOWNSTATE = 0x1606;
export const BCM_SETSPLITINFO = 0x1607;
export const BCM_GETSPLITINFO = 0x1608;
export const BCM_SETNOTE = 0x1609;
export const BCM_GETNOTE = 0x160a;
export const BCM_GETNOTELENGTH = 0x160b;

export const BS_SPLITBUTTON = 0x0c;
const BS_DEFSPLITBUTTON = 0x0d;
export const BS_COMMANDLINK = 0x0e;
const BS_DEFCOMMANDLINK = 0x0f;

const BS_TYPEMASK = 0x0f;
const BS_PUSHBUTTON = 0x00;
const BS_DEFPUSHBUTTON = 0x01;
const BS_3STATE = 0x05;
const BS_AUTO3STATE = 0x06;
const BS_GROUPBOX = 0x07;
const BS_PUSHBOX = 0x0a;
const BS_OWNERDRAW = 0x0b;
const BS_ICON = 0x40;
const BS_BITMAP = 0x80;
const BS_CENTER = 0x0300;
const BS_TOP = 0x0400;
const BS_BOTTOM = 0x0800;
const BS_VCENTER = 0x0c00;
const BS_MULTILINE = 0x2000;

const BUTTON_IMAGELIST_ALIGN_LEFT = 0;
const BUTTON_IMAGELIST_ALIGN_RIGHT = 1;
const BUTTON_IMAGELIST_ALIGN_TOP = 2;
const BUTTON_IMAGELIST_ALIGN_BOTTOM = 3;

const BCSIF_GLYPH = 0x1;
const BCSIF_IMAGE = 0x2;
const BCSIF_STYLE = 0x4;
const BCSIF_SIZE = 0x8;
const BCSS_STRETCH = 0x2;
const BCSS_IMAGE = 0x8;

/** The split part's glyph: Marlett's down arrow, a character, not a list. */
const DEFAULT_GLYPH = 0x36;
/** SM_CYMENUCHECK and SM_CXEDGE, as user32's metrics answer them (system.js). */
const MENU_CHECK = 13;
const EDGE = 2;
/** The room round a push button's content: its frame and the focus ring's. */
const PUSH_MARGIN = 2 * EDGE + 4;
/** A check box's box and the gap after it (controls.js draws them so). */
const CHECK_ROOM = 13 + 4;
/** A command link's arrow and the gaps round it and its two lines. */
const LINK_GLYPH = 16;
const LINK_MARGIN = 8;

const NO_ERROR = 0;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

const PUSH_KINDS = new Set([BS_PUSHBUTTON, BS_DEFPUSHBUTTON, BS_SPLITBUTTON, BS_DEFSPLITBUTTON]);
const SPLIT_KINDS = new Set([BS_SPLITBUTTON, BS_DEFSPLITBUTTON]);
const LINK_KINDS = new Set([BS_COMMANDLINK, BS_DEFCOMMANDLINK]);
/** The kinds whose ideal size is the size they have. */
const UNSIZED_KINDS = new Set([BS_3STATE, BS_AUTO3STATE, BS_GROUPBOX, BS_PUSHBOX, BS_OWNERDRAW]);

/**
 * @typedef {Object} ButtonEnvironment
 * @property {import('../common/guest.js').Guest} guest
 *           Its pointer width a handle's in a structure: 8 in a 64-bit process.
 * @property {(himl: number) => ({ cx: number, cy: number } | null)} imageListSize
 * @property {(image: number) => ({ width: number, height: number } | null)} imageSize
 *           A bitmap's or icon's size, for BM_SETIMAGE's image.
 * @property {(record: any, text: string, wrapAt?: number)
 *     => { width: number, height: number }} textExtent
 *           The text in the window's font: each line as wide as its own
 *           characters, as many lines as its line breaks make, and with
 *           `wrapAt` broken between words to fit that width.
 * @property {(record: any) => { width: number, height: number }} clientSize
 * @property {(code: number) => void} [setLastError]
 */

/**
 * @typedef {Object} SixState
 * @property {{ himl: number, margin: number[], align: number }} imageList
 * @property {number[]} textMargin  left, top, right, bottom
 * @property {{ glyph: number, style: number, cx: number, cy: number }} split
 * @property {string | null} note  null until a note is set
 * @property {boolean} dropDown
 */

/**
 * The state the version 6 messages keep, on the button's own state.
 *
 * @param {any} state
 * @returns {SixState}
 */
const sixOf = state=>{
    state.six ??= {
        imageList: { himl: 0, margin: [0, 0, 0, 0], align: 0 },
        textMargin: [0, 0, 0, 0],
        split: { glyph: DEFAULT_GLYPH, style: BCSS_STRETCH, cx: MENU_CHECK, cy: 0 },
        note: null,
        dropDown: false,
    };
    return state.six;
};

/**
 * @param {ButtonEnvironment} env
 */
export function createButtonV6(env){
    const { guest } = env;
    const handleSize = guest.pointerSize;
    // BUTTON_IMAGELIST: the list, its margin (a RECT) and its alignment.
    const LIST_MARGIN = handleSize;
    const LIST_ALIGN = handleSize + 16;
    // BUTTON_SPLITINFO: mask, the glyph or list, its style and its SIZE.
    const SPLIT_GLYPH = handleSize;
    const SPLIT_STYLE = handleSize * 2;
    const SPLIT_SIZE = SPLIT_STYLE + 4;

    /**
     * The split part's width when nothing set it: the glyph's, or the
     * list's image and its border when the part shows an image.
     *
     * @param {SixState['split']} split
     */
    const splitWidth = split=>((split.style & BCSS_IMAGE) !== 0
        ? (env.imageListSize(split.glyph)?.cx ?? 0) + 2 * EDGE : MENU_CHECK);

    /**
     * @param {SixState} six @param {number} info
     */
    const setSplit = (six, info)=>{
        if (info === 0)
        {
            return 1;
        }
        const at = info >>> 0;
        const mask = guest.u32(at);
        const split = six.split;
        if ((mask & BCSIF_GLYPH) !== 0)
        {
            split.glyph = guest.ptr(at + SPLIT_GLYPH);
            split.style &= ~BCSS_IMAGE;
        }
        else if ((mask & BCSIF_IMAGE) !== 0)
        {
            split.glyph = guest.ptr(at + SPLIT_GLYPH);
            split.style |= BCSS_IMAGE;
        }
        if ((mask & BCSIF_STYLE) !== 0)
        {
            split.style = guest.u32(at + SPLIT_STYLE);
        }
        if ((mask & BCSIF_SIZE) !== 0)
        {
            const cx = guest.i32(at + SPLIT_SIZE);
            split.cx = cx > 0 ? cx : splitWidth(split);
            split.cy = guest.i32(at + SPLIT_SIZE + 4);
        }
        else if ((mask & (BCSIF_GLYPH | BCSIF_IMAGE | BCSIF_STYLE)) !== 0)
        {
            split.cx = splitWidth(split);
            split.cy = 0;
        }
        return 1;
    };

    /**
     * @param {SixState} six @param {number} info
     */
    const getSplit = (six, info)=>{
        if (info === 0)
        {
            return 0;
        }
        const at = info >>> 0;
        const mask = guest.u32(at);
        if ((mask & (BCSIF_GLYPH | BCSIF_IMAGE)) !== 0)
        {
            guest.setPtr(at + SPLIT_GLYPH, six.split.glyph);
        }
        if ((mask & BCSIF_STYLE) !== 0)
        {
            guest.set32(at + SPLIT_STYLE, six.split.style);
        }
        if ((mask & BCSIF_SIZE) !== 0)
        {
            guest.set32s(at + SPLIT_SIZE, [six.split.cx, six.split.cy]);
        }
        return 1;
    };

    /**
     * The image the button shows and how it stands to the text: an image
     * list's first image by its alignment, else BM_SETIMAGE's - shown only by
     * a push button, a command link or one styled BS_BITMAP or BS_ICON -
     * beside the text, or above or below it.
     *
     * @param {any} record @param {any} state
     * @returns {{ width: number, height: number, place: 'side' | 'stacked' | 'alone' } | null}
     */
    const imageOf = (record, state)=>{
        const six = sixOf(state);
        const listed = six.imageList.himl ? env.imageListSize(six.imageList.himl) : null;
        if (listed)
        {
            const align = six.imageList.align;
            const place = align === BUTTON_IMAGELIST_ALIGN_TOP
                || align === BUTTON_IMAGELIST_ALIGN_BOTTOM ? 'stacked'
                : align === BUTTON_IMAGELIST_ALIGN_LEFT || align === BUTTON_IMAGELIST_ALIGN_RIGHT
                    ? 'side' : 'alone';
            return { width: listed.cx, height: listed.cy, place };
        }
        const kind = record.style & BS_TYPEMASK;
        const shown = PUSH_KINDS.has(kind) || LINK_KINDS.has(kind)
            || (record.style & (BS_BITMAP | BS_ICON)) !== 0;
        const size = shown && state.image ? env.imageSize(state.image.handle) : null;
        if (!size)
        {
            return null;
        }
        // Above or below the text when the style puts it at the top or the
        // bottom and does not push it to a side (Wine's button test,
        // test_bcm_get_ideal_size): left or right alone keeps it beside.
        const vertical = record.style & BS_VCENTER;
        const horizontal = record.style & BS_CENTER;
        const stacked = (vertical === BS_TOP || vertical === BS_BOTTOM)
            && (horizontal === 0 || horizontal === BS_CENTER);
        return { width: size.width, height: size.height, place: stacked ? 'stacked' : 'side' };
    };

    /**
     * BCM_GETIDEALSIZE's answer for a command link: its arrow or image,
     * then the text over the note, the note broken between words to fit the
     * width the caller gave when one is given and leaves room for it.
     *
     * @param {any} record @param {any} state @param {number} givenWidth
     */
    const linkSize = (record, state, givenWidth)=>{
        const six = sixOf(state);
        const image = imageOf(record, state);
        const imageWidth = image ? image.width : LINK_GLYPH;
        const imageHeight = image ? image.height : LINK_GLYPH;
        const lead = imageWidth + 2 * LINK_MARGIN;
        const text = env.textExtent(record, record.title ?? '');
        const room = givenWidth - lead;
        const wraps = givenWidth > 0 && room > 0;
        const note = six.note ? env.textExtent(record, six.note, wraps ? room : undefined)
            : { width: 0, height: 0 };
        const height = Math.max(imageHeight, text.height + note.height) + 2 * LINK_MARGIN;
        if (givenWidth <= 0 || room <= 0)
        {
            return { cx: givenWidth, cy: height };
        }
        return { cx: Math.min(givenWidth, lead + Math.max(text.width, note.width)), cy: height };
    };

    /**
     * @param {any} record @param {any} state @param {number} out
     */
    const idealSize = (record, state, out)=>{
        if (out === 0)
        {
            return 0;
        }
        const kind = record.style & BS_TYPEMASK;
        const client = env.clientSize(record);
        /** @param {number} cx @param {number} cy */
        const answer = (cx, cy)=>{
            guest.set32s(out >>> 0, [cx, cy]);
            return 1;
        };
        if (LINK_KINDS.has(kind))
        {
            const size = linkSize(record, state, guest.i32(out >>> 0));
            return answer(size.cx, size.cy);
        }
        const title = record.title ?? '';
        const image = imageOf(record, state);
        if (UNSIZED_KINDS.has(kind) || (title === '' && !image))
        {
            return answer(client.width, client.height);
        }
        const text = title === '' ? { width: 0, height: 0 }
            : env.textExtent(record, (record.style & BS_MULTILINE) !== 0 ? title
                : title.replace(/\r?\n/g, ' '));
        const margin = sixOf(state).textMargin;
        const textWidth = text.width + margin[0] + margin[2];
        const textHeight = text.height + margin[1] + margin[3];
        let width = textWidth;
        let height = textHeight;
        if (image?.place === 'side')
        {
            width = image.width + textWidth;
            height = Math.max(image.height, textHeight);
        }
        else if (image?.place === 'stacked')
        {
            width = Math.max(image.width, textWidth);
            height = image.height + textHeight;
        }
        else if (image)
        {
            width = image.width;
            height = image.height;
        }
        if (PUSH_KINDS.has(kind))
        {
            width += 2 * PUSH_MARGIN;
            height += 2 * PUSH_MARGIN;
            if (SPLIT_KINDS.has(kind))
            {
                // The part on the right and the line between it and the face.
                width += 2 * sixOf(state).split.cx + EDGE;
            }
        }
        else
        {
            width += CHECK_ROOM;
        }
        return answer(width, height);
    };

    /** @param {number} at @returns {number[]} */
    const rectAt = at=>[0, 4, 8, 12].map(offset=>guest.i32((at >>> 0) + offset));

    /** @param {number} code @returns {0} */
    const fail = code=>{
        env.setLastError?.(code);
        return 0;
    };

    /**
     * BCM_GETNOTE: the note into the caller's buffer, *size characters with
     * the terminator; one too long is cut to fit, the size it needs written
     * back and ERROR_INSUFFICIENT_BUFFER left. A note never set, a null size
     * or buffer is ERROR_INVALID_PARAMETER and writes nothing.
     *
     * @param {number} kind @param {SixState} six @param {number} size @param {number} buffer
     */
    const getNote = (kind, six, size, buffer)=>{
        if (!LINK_KINDS.has(kind))
        {
            return fail(ERROR_NOT_SUPPORTED);
        }
        if (six.note === null || size === 0 || buffer === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const room = guest.u32(size >>> 0);
        const needed = six.note.length + 1;
        guest.writeWide(buffer >>> 0, six.note, room);
        if (room < needed)
        {
            guest.set32(size >>> 0, needed);
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        env.setLastError?.(NO_ERROR);
        return 1;
    };

    /**
     * A BCM_* message's answer, or undefined for one that is not a version 6
     * button's.
     *
     * @param {any} record @param {any} state
     * @param {{ message: number, wParam: number, lParam: number }} message
     * @returns {number | undefined}
     */
    const answer = (record, state, message)=>{
        if ((record.controlsVersion ?? 5) < 6)
        {
            return undefined;
        }
        const six = sixOf(state);
        const kind = record.style & BS_TYPEMASK;
        const { wParam, lParam } = message;
        switch (message.message){
            case BCM_GETIDEALSIZE:
                return idealSize(record, state, lParam);
            case BCM_SETIMAGELIST: {
                if (lParam === 0)
                {
                    return 0;
                }
                const at = lParam >>> 0;
                six.imageList = { himl: guest.ptr(at), margin: rectAt(at + LIST_MARGIN),
                    align: guest.u32(at + LIST_ALIGN) };
                return 1;
            }
            case BCM_GETIMAGELIST: {
                if (lParam === 0)
                {
                    return 0;
                }
                const at = lParam >>> 0;
                guest.setPtr(at, six.imageList.himl);
                guest.set32s(at + LIST_MARGIN, six.imageList.margin);
                guest.set32(at + LIST_ALIGN, six.imageList.align);
                return 1;
            }
            case BCM_SETTEXTMARGIN:
                if (lParam === 0)
                {
                    return 0;
                }
                six.textMargin = rectAt(lParam);
                return 1;
            case BCM_GETTEXTMARGIN:
                if (lParam === 0)
                {
                    return 0;
                }
                guest.set32s(lParam >>> 0, six.textMargin);
                return 1;
            case BCM_SETSPLITINFO:
                return setSplit(six, lParam);
            case BCM_GETSPLITINFO:
                return getSplit(six, lParam);
            case BCM_SETDROPDOWNSTATE:
                six.dropDown = wParam !== 0;
                return SPLIT_KINDS.has(kind) ? 1 : 0;
            // A note is a command link's alone; another button says the
            // message is not supported. A null note empties it.
            case BCM_SETNOTE:
                if (!LINK_KINDS.has(kind))
                {
                    return fail(ERROR_NOT_SUPPORTED);
                }
                six.note = lParam === 0 ? '' : guest.wstr(wholeAddress(lParam), 0x20000);
                env.setLastError?.(NO_ERROR);
                return 1;
            case BCM_GETNOTELENGTH:
                return LINK_KINDS.has(kind) ? six.note?.length ?? 0 : 0;
            case BCM_GETNOTE:
                return getNote(kind, six, wParam, lParam);
            default:
                return undefined;
        }
    };

    return { answer };
}
