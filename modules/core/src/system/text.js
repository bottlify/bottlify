/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Text: the codecs every layer decodes and encodes with, made once, and
 * Windows' own case rule for names.
 *
 * A TextDecoder made per call is an object and its native state thrown away
 * per call; the ones here live as long as the module. None of them streams,
 * so one instance serves every caller.
 *
 * Windows compares names - files, registry keys and values, environment
 * variables, window classes, modules - by upper-casing each UTF-16 unit
 * through one table (RtlUpcaseUnicodeChar, l_intl.nls), one unit to one unit.
 * JavaScript's case mapping is not that table: it maps 'ß' to "SS" and the
 * Turkish dotted capital to two units, and it maps characters whose mapping
 * does not round-trip ('ı' to 'I', the Kelvin sign to 'k', 'ς' to 'Σ', 'ǅ' to
 * 'Ǆ'), which Windows' table leaves alone. The table is Unicode's simple case
 * mapping with every mapping that does not come back to where it started
 * removed - the rule Wine's generator writes l_intl.nls by, and what Wine's
 * conformance tests check against Windows (RtlUpcaseUnicodeChar over Latin-1:
 * 'ÿ' to 'Ÿ', 'µ' and 'ß' kept). It is built here from the engine's own
 * Unicode data, a page of 256 units at a time as a page is first met.
 */

/** Whether shared memory exists here: a browser's decoder refuses a view of it. */
const SHARED = typeof SharedArrayBuffer === 'function';

/**
 * Bytes a decoder takes: a view of shared memory is copied out first, as
 * every browser refuses to decode one in place.
 *
 * @param {ArrayBufferView | ArrayBuffer} bytes
 * @returns {ArrayBufferView | ArrayBuffer}
 */
const decodable = bytes=>(SHARED && 'buffer' in bytes && bytes.buffer instanceof SharedArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice() : bytes);

/**
 * A decoder wrapped so it takes bytes wherever they are.
 *
 * @param {TextDecoder} decoder
 */
const decoding = decoder=>Object.freeze({
    /** @param {ArrayBufferView | ArrayBuffer} bytes @returns {string} */
    decode: bytes=>decoder.decode(decodable(bytes)),
});

const encoder = new TextEncoder();

/**
 * UTF-8. Decoding replaces what is malformed with U+FFFD and drops a leading
 * byte order mark, as TextDecoder does by default.
 */
export const utf8 = Object.freeze({
    ...decoding(new TextDecoder('utf-8')),
    /** @param {string} text @returns {Uint8Array<ArrayBuffer>} */
    encode: text=>encoder.encode(text),
    /**
     * Into a destination given, without a buffer of its own; `read` is the
     * units of `text` used, `written` the bytes.
     *
     * @param {string} text @param {Uint8Array} into
     */
    encodeInto: (text, into)=>encoder.encodeInto(text, into),
});

/** UTF-16, low byte first: a wide string's bytes. A leading byte order mark is dropped. */
export const utf16le = decoding(new TextDecoder('utf-16le'));

/** UTF-16, high byte first. A leading byte order mark is dropped. */
export const utf16be = decoding(new TextDecoder('utf-16be'));

/**
 * Windows-1252: what the Encoding Standard means by 'latin1' and 'ascii' -
 * Latin-1, but for 0x80-0x9F, where 1252 has its own characters.
 */
export const windows1252 = decoding(new TextDecoder('windows-1252'));

/** @type {Map<string, Readonly<{ decode: (bytes: ArrayBufferView | ArrayBuffer) => string }>>} */
const byLabel = new Map();

/**
 * A decoder for any Encoding Standard label (a code page's), made the first
 * time it is asked for. `fatal` throws on malformed bytes instead of
 * replacing them. An unknown label throws, as TextDecoder does.
 *
 * @param {string} label @param {{ fatal?: boolean }} [options]
 */
export function decoderFor(label, { fatal = false } = {}){
    const key = `${fatal ? '!' : ''}${label}`;
    let found = byLabel.get(key);
    if (!found)
    {
        found = decoding(new TextDecoder(label, { fatal }));
        byLabel.set(key, found);
    }
    return found;
}

/** Each 256-unit page of the upper-case table, made as it is first used. */
const upperPages = /** @type {(Uint16Array | undefined)[]} */ (new Array(256));
/** And of the lower-case one. */
const lowerPages = /** @type {(Uint16Array | undefined)[]} */ (new Array(256));

/** @type {Map<number, number> | null} */
let titlecaseOf = null;

/**
 * Unicode's simple upper case of a unit, or the unit. Where the engine's
 * (full) mapping is longer than one unit the simple one is either none (ß,
 * the ligatures) or, for a small letter with ypogegrammeni, its titlecase
 * letter: the one titlecase letter whose lower case it is.
 *
 * @param {number} unit @returns {number}
 */
function simpleUpper(unit){
    const upper = String.fromCharCode(unit).toUpperCase();
    if (upper.length === 1)
    {
        return upper.charCodeAt(0);
    }
    if (!titlecaseOf)
    {
        titlecaseOf = new Map();
        const titlecase = /\p{Lt}/u;
        for (let at = 0; at < 0x10000; at++)
        {
            const one = String.fromCharCode(at);
            const lower = titlecase.test(one) ? one.toLowerCase() : '';
            if (lower.length === 1)
            {
                titlecaseOf.set(lower.charCodeAt(0), at);
            }
        }
    }
    return titlecaseOf.get(unit) ?? unit;
}

/** @param {number} unit @returns {number} */
function simpleLower(unit){
    const lower = String.fromCharCode(unit).toLowerCase();
    return lower.length === 1 ? lower.charCodeAt(0) : unit;
}

/** @param {number} page @returns {Uint16Array} */
function upperPage(page){
    const table = new Uint16Array(256);
    for (let at = 0; at < 256; at++)
    {
        const unit = page << 8 | at;
        const upper = simpleUpper(unit);
        table[at] = upper !== unit && simpleLower(upper) === unit ? upper : unit;
    }
    upperPages[page] = table;
    return table;
}

/** @param {number} page @returns {Uint16Array} */
function lowerPage(page){
    const table = new Uint16Array(256);
    for (let at = 0; at < 256; at++)
    {
        const unit = page << 8 | at;
        const lower = simpleLower(unit);
        table[at] = lower !== unit && upcaseUnit(lower) === unit ? lower : unit;
    }
    lowerPages[page] = table;
    return table;
}

/**
 * A UTF-16 unit in upper case by Windows' table (RtlUpcaseUnicodeChar). A
 * surrogate is a unit like any other and has no case.
 *
 * @param {number} unit @returns {number}
 */
export function upcaseUnit(unit){
    if (unit < 0x80)
    {
        return unit >= 0x61 && unit <= 0x7a ? unit - 0x20 : unit;
    }
    return (upperPages[unit >>> 8] ?? upperPage(unit >>> 8))[unit & 0xff];
}

/**
 * A UTF-16 unit in lower case by the same table (RtlDowncaseUnicodeChar):
 * only where upper-casing the result gives the unit back.
 *
 * @param {number} unit @returns {number}
 */
export function downcaseUnit(unit){
    if (unit < 0x80)
    {
        return unit >= 0x41 && unit <= 0x5a ? unit + 0x20 : unit;
    }
    return (lowerPages[unit >>> 8] ?? lowerPage(unit >>> 8))[unit & 0xff];
}

const NON_ASCII = /[^\0-\x7f]/;

/** Units given to String.fromCharCode at once: well under any engine's argument limit. */
const CHUNK = 0x2000;
const scratch = new Uint16Array(CHUNK);

/**
 * Text with each unit mapped, `map` a unit's case by the table.
 *
 * @param {string} text @param {(unit: number) => number} map
 */
function mapUnits(text, map){
    let out = '';
    for (let start = 0; start < text.length; start += CHUNK)
    {
        const end = Math.min(text.length, start + CHUNK);
        for (let at = start; at < end; at++)
        {
            scratch[at - start] = map(text.charCodeAt(at));
        }
        out += String.fromCharCode.apply(null, /** @type {any} */ (scratch.subarray(0, end - start)));
    }
    return out;
}

/**
 * A name as Windows compares it without regard to case: every unit upper-cased
 * by its table, the length never changed. Two names are the same name when
 * their folds are equal; ordering folds as strings orders them as
 * CompareStringOrdinal and NTFS's index do.
 *
 * @param {string} text @returns {string}
 */
export function foldName(text){
    return NON_ASCII.test(text) ? mapUnits(text, upcaseUnit) : text.toUpperCase();
}

/**
 * The lower-case counterpart, for what Windows writes in lower case
 * (RtlDowncaseUnicodeString, CharLower on a wide string).
 *
 * @param {string} text @returns {string}
 */
export function downcaseName(text){
    return NON_ASCII.test(text) ? mapUnits(text, downcaseUnit) : text.toLowerCase();
}

/**
 * Whether two names are one name to Windows.
 *
 * @param {string} a @param {string} b @returns {boolean}
 */
export const sameName = (a, b)=>a.length === b.length && (a === b || foldName(a) === foldName(b));

/**
 * UTF-16 units upper-cased in place, from `start` to `end`.
 *
 * @param {Uint16Array | number[]} units @param {number} [start] @param {number} [end]
 */
export function foldUnits(units, start = 0, end = units.length){
    for (let at = start; at < end; at++)
    {
        units[at] = upcaseUnit(units[at]);
    }
    return units;
}
