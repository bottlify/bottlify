/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Property sets: the summary information a document carries, kept in a
 * stream of its storage named after the set's FMTID.
 *
 * A set's stream or storage is named for its format: the two summary sets
 * by their documented names, every other by the FMTID itself written in 26
 * characters of five bits each ([MS-OLEPS] 2.23), the stream's name taking
 * the 0x05 that marks a property set in front.
 */

import { formatGuid, parseGuid } from './guid.js';
import { ANSI_PAGE, decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { publishEnumerator } from './enumerator.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const STG_E_INVALIDNAME = 0x800300fc | 0;

export const FMTID_SUMMARY_INFORMATION = '{F29F85E0-4FF9-1068-AB91-08002B27B3D9}';
export const FMTID_DOC_SUMMARY_INFORMATION = '{D5CDD502-2E9C-101B-9397-08002B2CF9AE}';
export const FMTID_USER_DEFINED_PROPERTIES = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';

/** What marks an element of a storage as a property set. */
const PROPERTY_SET_MARK = '\x05';
const SUMMARY_NAME = `${PROPERTY_SET_MARK}SummaryInformation`;
const DOC_SUMMARY_NAME = `${PROPERTY_SET_MARK}DocumentSummaryInformation`;

/** The 32 characters a name is written in, a 5-bit value each. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz012345';
/** Characters in a name made of an FMTID: 128 bits, five at a time. */
const ENCODED_LENGTH = 26;
/** CCH_MAX_PROPSTG_NAME, the longest name a caller's buffer is sized for. */
export const MAX_NAME_LENGTH = 31;

/**
 * The name a property set of `fmtid` is stored under, the 0x05 included.
 *
 * A character that starts a byte is a capital when it is a letter, so the
 * name says where each byte begins.
 *
 * @param {string} fmtid
 * @returns {string}
 */
export function nameOfFormat(fmtid){
    const key = fmtid.toUpperCase();
    if (key === FMTID_SUMMARY_INFORMATION)
    {
        return SUMMARY_NAME;
    }
    if (key === FMTID_DOC_SUMMARY_INFORMATION || key === FMTID_USER_DEFINED_PROPERTIES)
    {
        return DOC_SUMMARY_NAME;
    }
    const bytes = /** @type {Uint8Array} */ (parseGuid(fmtid));
    let bits = 0n;
    for (let index = bytes.length - 1; index >= 0; index--)
    {
        bits = (bits << 8n) | BigInt(bytes[index]);
    }
    let name = PROPERTY_SET_MARK;
    for (let at = 0; at < ENCODED_LENGTH; at++)
    {
        const character = ALPHABET[Number((bits >> BigInt(at * 5)) & 31n)];
        name += (at * 5) % 8 === 0 ? character.toUpperCase() : character;
    }
    return name;
}

/**
 * The FMTID a stored name stands for, letters of either case; null when it
 * names none.
 *
 * @param {string} name  With or without its 0x05.
 * @returns {string | null}
 */
export function formatOfName(name){
    const lower = name.toLowerCase();
    if (lower === SUMMARY_NAME.toLowerCase())
    {
        return FMTID_SUMMARY_INFORMATION;
    }
    if (lower === DOC_SUMMARY_NAME.toLowerCase())
    {
        return FMTID_DOC_SUMMARY_INFORMATION;
    }
    const text = lower.startsWith(PROPERTY_SET_MARK) ? lower.slice(1) : lower;
    if (text.length !== ENCODED_LENGTH)
    {
        return null;
    }
    let bits = 0n;
    for (let at = 0; at < ENCODED_LENGTH; at++)
    {
        const value = ALPHABET.indexOf(text[at]);
        if (value < 0)
        {
            return null;
        }
        bits |= BigInt(value) << BigInt(at * 5);
    }
    // The last character carries three bits; more than that is no FMTID.
    if (bits >> 128n !== 0n)
    {
        return null;
    }
    const bytes = new Uint8Array(16);
    for (let index = 0; index < bytes.length; index++)
    {
        bytes[index] = Number((bits >> BigInt(index * 8)) & 0xffn);
    }
    return formatGuid(bytes);
}


/** PROPVARIANT types a property set holds, as [MS-OLEPS] 2.15 lists them. */
export const VT = Object.freeze({
    EMPTY: 0, NULL: 1, I2: 2, I4: 3, R4: 4, R8: 5, CY: 6, DATE: 7, BSTR: 8, ERROR: 10, BOOL: 11,
    I1: 16, UI1: 17, UI2: 18, UI4: 19, I8: 20, UI8: 21, INT: 22, UINT: 23, LPSTR: 30, LPWSTR: 31,
    FILETIME: 64, BLOB: 65, CF: 71, CLSID: 72,
});

/**
 * The fixed-size types: how many bytes their value takes.
 *
 * @type {Map<number, number>}
 */
const FIXED_SIZE = new Map([
    [VT.I2, 2], [VT.BOOL, 2], [VT.UI2, 2], [VT.I1, 1], [VT.UI1, 1], [VT.I4, 4], [VT.UI4, 4],
    [VT.INT, 4], [VT.UINT, 4], [VT.ERROR, 4], [VT.R4, 4], [VT.R8, 8], [VT.DATE, 8], [VT.CY, 8],
    [VT.I8, 8], [VT.UI8, 8], [VT.FILETIME, 8], [VT.CLSID, 16],
]);
/** @type {Set<number>} */
const STRING_TYPES = new Set([VT.LPSTR, VT.BSTR, VT.LPWSTR]);

export const PID_DICTIONARY = 0;
export const PID_CODEPAGE = 1;
export const PID_FIRST_USABLE = 2;
export const PID_LOCALE = 0x80000000;
export const PID_BEHAVIOR = 0x80000003;
/** From here up the identifiers are the set's own, written by no caller. */
const PID_MIN_READONLY = 0x80000000;

export const CP_UNICODE = 1200;

/**
 * One property's value: a number for the small types, the eight raw bytes
 * of a 64-bit one, a string, the bytes of a blob or a CLSID, a clipboard
 * format and its data.
 *
 * @typedef {{ vt: number, value: any }} PropertyValue
 */

/**
 * A section of a property set, read.
 *
 * @typedef {Object} Section
 * @property {string} fmtid
 * @property {number} codepage
 * @property {number | null} locale
 * @property {boolean} caseSensitive
 * @property {Map<number, PropertyValue>} properties
 * @property {Map<number, string>} names  The dictionary.
 */

/**
 * A property set stream, read: its class, the version it was written
 * under, and its sections in order.
 *
 * @typedef {Object} PropertySet
 * @property {string} clsid
 * @property {number} osVersion
 * @property {Section[]} sections
 */

/** What a set written here says it was written under: Windows NT, 10.0. */
const OS_VERSION = 0x00020a00;
const BYTE_ORDER = 0xfffe;
const HEADER_BYTES = 28;
const SECTION_ENTRY_BYTES = 20;

/** @param {number} length */
const pad4 = length=>(length + 3) & ~3;

/** @param {string} fmtid @param {number} codepage @returns {Section} */
export const emptySection = (fmtid, codepage)=>({
    fmtid, codepage, locale: null, caseSensitive: false, properties: new Map(), names: new Map(),
});

/**
 * Text as the section's code page writes it, its terminator included.
 *
 * @param {string} text @param {number} codepage
 */
const encodeText = (text, codepage)=>{
    if (codepage === CP_UNICODE)
    {
        return encodeWide(`${text}\0`);
    }
    const bytes = encodeAnsi(`${text}\0`);
    return bytes;
};

/** @param {string} text */
const encodeWide = text=>{
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index++)
    {
        bytes[index * 2] = text.charCodeAt(index) & 0xff;
        bytes[index * 2 + 1] = text.charCodeAt(index) >>> 8;
    }
    return bytes;
};

/** @param {Uint8Array} bytes  UTF-16LE, up to a NUL or its end. */
const decodeWide = bytes=>{
    let text = '';
    for (let at = 0; at + 1 < bytes.length; at += 2)
    {
        const unit = bytes[at] | (bytes[at + 1] << 8);
        if (unit === 0)
        {
            break;
        }
        text += String.fromCharCode(unit);
    }
    return text;
};

/** @param {Uint8Array} bytes @param {number} codepage */
const decodeText = (bytes, codepage)=>{
    if (codepage === CP_UNICODE)
    {
        return decodeWide(bytes);
    }
    const end = bytes.indexOf(0);
    return decodeAnsi(end < 0 ? bytes : bytes.subarray(0, end));
};

/** @param {Uint8Array[]} parts */
const join = parts=>{
    const whole = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
    let at = 0;
    for (const part of parts)
    {
        whole.set(part, at);
        at += part.length;
    }
    return whole;
};

/**
 * A property's bytes in a section: its type, two bytes of padding, the
 * value, padded to four.
 *
 * @param {PropertyValue} property @param {number} codepage
 * @returns {Uint8Array}
 */
export function encodeValue(property, codepage){
    const { vt, value } = property;
    /** @type {Uint8Array} */
    let data;
    const fixed = FIXED_SIZE.get(vt);
    if (fixed !== undefined)
    {
        data = new Uint8Array(fixed);
        const view = new DataView(data.buffer);
        if (value instanceof Uint8Array)
        {
            data.set(value.subarray(0, fixed));
        }
        else if (vt === VT.R4)
        {
            view.setFloat32(0, value, true);
        }
        else if (vt === VT.R8 || vt === VT.DATE)
        {
            view.setFloat64(0, value, true);
        }
        else if (fixed === 1)
        {
            view.setUint8(0, value & 0xff);
        }
        else if (fixed === 2)
        {
            view.setUint16(0, value & 0xffff, true);
        }
        else
        {
            view.setUint32(0, value >>> 0, true);
        }
    }
    else if (vt === VT.LPWSTR)
    {
        const text = encodeWide(`${value}\0`);
        data = join([u32(text.length / 2), text]);
    }
    else if (STRING_TYPES.has(vt))
    {
        const text = encodeText(value, codepage);
        data = join([u32(text.length), text]);
    }
    else if (vt === VT.BLOB)
    {
        data = join([u32(value.length), value]);
    }
    else if (vt === VT.CF)
    {
        data = join([u32(value.data.length + 4), u32(value.format), value.data]);
    }
    else
    {
        data = new Uint8Array(0);
    }
    const whole = new Uint8Array(4 + pad4(data.length));
    new DataView(whole.buffer).setUint32(0, vt, true);
    whole.set(data, 4);
    return whole;
}

/** @param {number} value */
const u32 = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * A property read from a section, or null for a type no set holds.
 *
 * @param {DataView} view @param {number} at @param {number} codepage
 * @returns {PropertyValue | null}
 */
export function decodeValue(view, at, codepage){
    const vt = view.getUint16(at, true);
    const start = at + 4;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const fixed = FIXED_SIZE.get(vt);
    if (fixed !== undefined)
    {
        if (start + fixed > view.byteLength)
        {
            return null;
        }
        switch (vt)
        {
            case VT.R4: return { vt, value: view.getFloat32(start, true) };
            case VT.R8: case VT.DATE: return { vt, value: view.getFloat64(start, true) };
            case VT.I1: return { vt, value: view.getInt8(start) };
            case VT.UI1: return { vt, value: view.getUint8(start) };
            case VT.I2: case VT.BOOL: return { vt, value: view.getInt16(start, true) };
            case VT.UI2: return { vt, value: view.getUint16(start, true) };
            case VT.I4: case VT.INT: case VT.ERROR:
                return { vt, value: view.getInt32(start, true) };
            case VT.UI4: case VT.UINT: return { vt, value: view.getUint32(start, true) };
            default: return { vt, value: bytes.slice(start, start + fixed) };
        }
    }
    if (start + 4 > view.byteLength)
    {
        return null;
    }
    const count = view.getUint32(start, true);
    const body = start + 4;
    if (vt === VT.LPWSTR)
    {
        return body + count * 2 <= view.byteLength
            ? { vt, value: decodeWide(bytes.subarray(body, body + count * 2)) } : null;
    }
    if (body + count > view.byteLength)
    {
        return null;
    }
    if (STRING_TYPES.has(vt))
    {
        return { vt, value: decodeText(bytes.subarray(body, body + count), codepage) };
    }
    if (vt === VT.BLOB)
    {
        return { vt, value: bytes.slice(body, body + count) };
    }
    if (vt === VT.CF && count >= 4)
    {
        return { vt, value: { format: view.getInt32(body, true),
            data: bytes.slice(body + 4, body + count) } };
    }
    return null;
}

/**
 * A section's bytes: its size and count, the identifiers and offsets, then
 * the code page first, the locale and behaviour when set, the dictionary
 * when there are names, and the properties in identifier order.
 *
 * @param {Section} section
 * @returns {Uint8Array}
 */
export function encodeSection(section){
    /** @type {[number, Uint8Array][]} */
    const entries = [[PID_CODEPAGE, encodeValue({ vt: VT.I2, value: section.codepage },
        section.codepage)]];
    if (section.names.size > 0)
    {
        entries.push([PID_DICTIONARY, encodeDictionary(section)]);
    }
    for (const id of [...section.properties.keys()].sort((a, b)=>a - b))
    {
        entries.push([id, encodeValue(/** @type {PropertyValue} */ (
            section.properties.get(id)), section.codepage)]);
    }
    if (section.locale !== null)
    {
        entries.push([PID_LOCALE, encodeValue({ vt: VT.UI4, value: section.locale },
            section.codepage)]);
    }
    if (section.caseSensitive)
    {
        entries.push([PID_BEHAVIOR, encodeValue({ vt: VT.UI4, value: 1 }, section.codepage)]);
    }
    const tableBytes = 8 + entries.length * 8;
    const size = tableBytes + entries.reduce((sum, [, bytes])=>sum + bytes.length, 0);
    const whole = new Uint8Array(size);
    const view = new DataView(whole.buffer);
    view.setUint32(0, size, true);
    view.setUint32(4, entries.length, true);
    let offset = tableBytes;
    entries.forEach(([id, bytes], index)=>{
        view.setUint32(8 + index * 8, id >>> 0, true);
        view.setUint32(12 + index * 8, offset, true);
        whole.set(bytes, offset);
        offset += bytes.length;
    });
    return whole;
}

/**
 * The dictionary: its count, then each name's identifier, length in
 * characters with the terminator, and text in the section's code page --
 * padded to four after each in a Unicode set, after the whole otherwise.
 *
 * @param {Section} section
 */
const encodeDictionary = section=>{
    /** @type {Uint8Array[]} */
    const parts = [u32(section.names.size)];
    for (const [id, name] of section.names)
    {
        const text = encodeText(name, section.codepage);
        const characters = section.codepage === CP_UNICODE ? text.length / 2 : text.length;
        const entry = join([u32(id), u32(characters), text]);
        parts.push(section.codepage === CP_UNICODE
            ? join([entry, new Uint8Array(pad4(entry.length) - entry.length)]) : entry);
    }
    const whole = join(parts);
    return join([whole, new Uint8Array(pad4(whole.length) - whole.length)]);
};

/**
 * A section read from its bytes, or null when they are not one.
 *
 * @param {Uint8Array} bytes  The stream, whole.
 * @param {number} at  Where the section starts.
 * @param {string} fmtid
 * @returns {Section | null}
 */
export function decodeSection(bytes, at, fmtid){
    if (at + 8 > bytes.length)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + at,
        Math.min(bytes.length - at, new DataView(bytes.buffer, bytes.byteOffset)
            .getUint32(at, true) || bytes.length - at));
    const count = view.getUint32(4, true);
    if (8 + count * 8 > view.byteLength)
    {
        return null;
    }
    /** @type {[number, number][]} */
    const entries = [];
    for (let index = 0; index < count; index++)
    {
        entries.push([view.getUint32(8 + index * 8, true), view.getUint32(12 + index * 8, true)]);
    }
    const codepageEntry = entries.find(([id])=>id === PID_CODEPAGE);
    const codepage = codepageEntry && codepageEntry[1] + 6 <= view.byteLength
        ? view.getUint16(codepageEntry[1] + 4, true) : CP_UNICODE;
    const section = emptySection(fmtid, codepage);
    for (const [id, offset] of entries)
    {
        if (offset + 4 > view.byteLength || id === PID_CODEPAGE)
        {
            continue;
        }
        if (id === PID_DICTIONARY)
        {
            decodeDictionary(view, offset, section);
            continue;
        }
        const value = decodeValue(view, offset, codepage);
        if (!value)
        {
            continue;
        }
        if (id === PID_LOCALE)
        {
            section.locale = value.value >>> 0;
        }
        else if (id === PID_BEHAVIOR)
        {
            section.caseSensitive = (value.value & 1) !== 0;
        }
        else
        {
            section.properties.set(id, value);
        }
    }
    return section;
}

/** @param {DataView} view @param {number} at @param {Section} section */
const decodeDictionary = (view, at, section)=>{
    const count = view.getUint32(at, true);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let cursor = at + 4;
    for (let index = 0; index < count && cursor + 8 <= view.byteLength; index++)
    {
        const id = view.getUint32(cursor, true);
        const characters = view.getUint32(cursor + 4, true);
        const length = section.codepage === CP_UNICODE ? characters * 2 : characters;
        const text = bytes.subarray(cursor + 8, Math.min(cursor + 8 + length, view.byteLength));
        section.names.set(id, decodeText(text, section.codepage));
        cursor += 8 + length;
        if (section.codepage === CP_UNICODE)
        {
            cursor = at + pad4(cursor - at);
        }
    }
};

/**
 * A property set stream's bytes: the header, its class, then each section
 * with its FMTID and where it starts.
 *
 * @param {PropertySet} set
 * @returns {Uint8Array}
 */
export function encodePropertySet(set){
    const sections = set.sections.map(encodeSection);
    const header = new Uint8Array(HEADER_BYTES + sections.length * SECTION_ENTRY_BYTES);
    const view = new DataView(header.buffer);
    view.setUint16(0, BYTE_ORDER, true);
    view.setUint16(2, 0, true);
    view.setUint32(4, set.osVersion >>> 0, true);
    header.set(/** @type {Uint8Array} */ (parseGuid(set.clsid)), 8);
    view.setUint32(24, sections.length, true);
    let offset = header.length;
    set.sections.forEach((section, index)=>{
        header.set(/** @type {Uint8Array} */ (parseGuid(section.fmtid)),
            HEADER_BYTES + index * SECTION_ENTRY_BYTES);
        view.setUint32(HEADER_BYTES + index * SECTION_ENTRY_BYTES + 16, offset, true);
        offset += sections[index].length;
    });
    return join([header, ...sections]);
}

/**
 * A property set stream read, or null when its bytes are not one.
 *
 * @param {Uint8Array} bytes
 * @returns {PropertySet | null}
 */
export function decodePropertySet(bytes){
    if (bytes.length < HEADER_BYTES)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const count = view.getUint32(24, true);
    if (view.getUint16(0, true) !== BYTE_ORDER
        || HEADER_BYTES + count * SECTION_ENTRY_BYTES > bytes.length)
    {
        return null;
    }
    /** @type {Section[]} */
    const sections = [];
    for (let index = 0; index < count; index++)
    {
        const entry = HEADER_BYTES + index * SECTION_ENTRY_BYTES;
        const fmtid = formatGuid(bytes.subarray(entry, entry + 16));
        const section = decodeSection(bytes, view.getUint32(entry + 16, true), fmtid);
        if (!section)
        {
            return null;
        }
        sections.push(section);
    }
    return { clsid: formatGuid(bytes.subarray(8, 24)), osVersion: view.getUint32(4, true),
        sections };
}

const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
const STG_E_ACCESSDENIED = 0x80030005 | 0;
const STG_E_INVALIDPARAMETER = 0x80030057 | 0;
const STG_E_INVALIDFLAG = 0x800300ff | 0;
const STG_E_INVALIDHEADER = 0x800300fb | 0;

export const IID_IPROPERTYSTORAGE = '{00000138-0000-0000-C000-000000000046}';
export const IID_IPROPERTYSETSTORAGE = '{0000013A-0000-0000-C000-000000000046}';
const IID_IENUMSTATPROPSTG = '{00000139-0000-0000-C000-000000000046}';
const IID_IENUMSTATPROPSETSTG = '{0000013B-0000-0000-C000-000000000046}';
const IID_ISTREAM = '{0000000C-0000-0000-C000-000000000046}';
const IID_ISTORAGE = '{0000000B-0000-0000-C000-000000000046}';
const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';

/** This layer's classes of the objects here. */
const CLSID_PROPERTY_STORAGE = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0038}';
const CLSID_PROPERTY_SET_STORAGE = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0039}';
const CLSID_PROPERTY_ENUMERATOR = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b003a}';
const CLSID_PROPERTY_SET_ENUMERATOR = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b003b}';

const PROPSETFLAG_NONSIMPLE = 1;
const PROPSETFLAG_ANSI = 2;
const PROPSETFLAG_CASE_SENSITIVE = 8;

const STGM_READ = 0;
const STGM_READWRITE = 2;
const STGM_ACCESS = 3;
const STGM_SHARE_EXCLUSIVE = 0x10;
const STGM_SHARING = 0x70;
const STGM_CREATE = 0x1000;
const STGM_TRANSACTED = 0x10000;
const STGTY_STREAM = 2;
const STREAM_SEEK_SET = 0;
const STREAM_SEEK_END = 2;

/** PROPSPEC: ulKind, then a name's pointer or an identifier. */
const PROPSPEC_BYTES = 8;
const PRSPEC_LPWSTR = 0;
const PRSPEC_PROPID = 1;
const PROPVARIANT_BYTES = 16;
/** STATPROPSTG: lpwstrName, propid, vt (a WORD, padded). */
const STATPROPSTG_BYTES = 12;
/** STATPROPSETSTG: fmtid, clsid, grfFlags, mtime, ctime, atime, dwOSVersion. */
const STATPROPSETSTG_BYTES = 64;
const STATSTG_BYTES = 72;
/** The longest name or string read from the program's memory, in characters. */
const MAX_TEXT = 1 << 16;

/** IStream's slots called here, and IStorage's. */
const SLOT = Object.freeze({
    RELEASE: 2, READ: 3, WRITE: 4, SEEK: 5, SET_SIZE: 6, COMMIT: 8,
    CREATE_STREAM: 3, OPEN_STREAM: 4, ENUM_ELEMENTS: 11, DESTROY_ELEMENT: 12, NEXT: 3,
});

/**
 * @typedef {Object} PropertySetEnv
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => unknown }} heap
 *     Task memory, as CoTaskMemAlloc hands it out.
 * @property {(object: number, slot: number, args: number[], thread?: unknown)
 *     => number | Promise<number>} callMethod
 * @property {(object: number, iid: string, thread: unknown) => Promise<number>} queryPointer
 * @property {() => unknown} callerThread
 * @property {(clsid: string, definition: import('./objects.js').ComClassDefinition)
 *     => import('./objects.js').ComObject | null} makeObject
 * @property {(object: import('./objects.js').ComObject, iid: string) => number} publish
 * @property {(bytes: Uint8Array) => number} [allocateBstr]  A BSTR of these UTF-16 bytes.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * An open property set: the stream it is kept in, what it holds as last
 * committed and as changed since, and how it was opened.
 *
 * @typedef {Object} PropertyStorageState
 * @property {number} stream    Its IStream, held.
 * @property {string} clsid
 * @property {number} flags     PROPSETFLAG_*.
 * @property {boolean} writable
 * @property {number} index     Which of the stream's sections is this set's.
 * @property {PropertySet} set  The stream as last read or committed.
 * @property {Section} section  This set's section as changed.
 * @property {boolean} dirty
 * @property {Uint8Array} times  mtime, ctime, atime, as SetTimes left them.
 */

/** @param {PropertySetEnv} env */
export function createPropertySetFunctions(env){
    /** @param {number} address */
    const readU32 = address=>new DataView(env.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>env.writeMemory(address >>> 0, u32(value));
    /** @param {number} address @param {string} text */
    const writeWideAt = (address, text)=>env.writeMemory(address >>> 0, encodeWide(`${text}\0`));
    /** @param {number} address @returns {string} */
    const readWideAt = address=>{
        let text = '';
        for (let at = address >>> 0; text.length < MAX_TEXT; at += 2)
        {
            const bytes = env.readMemory(at, 2);
            const unit = bytes[0] | (bytes[1] << 8);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };
    /** @param {number} address @returns {string} */
    const readAnsiAt = address=>{
        /** @type {number[]} */
        const bytes = [];
        for (let at = address >>> 0; bytes.length < MAX_TEXT; at++)
        {
            const byte = env.readMemory(at, 1)[0];
            if (byte === 0)
            {
                break;
            }
            bytes.push(byte);
        }
        return decodeAnsi(Uint8Array.from(bytes));
    };
    /** @param {Uint8Array} bytes @returns {number} task memory holding them, or 0 */
    const taskCopy = bytes=>{
        const block = env.heap.allocate(Math.max(bytes.length, 1));
        if (block !== 0)
        {
            env.writeMemory(block, bytes);
        }
        return block;
    };
    /** @param {number} pointer @param {number} slot @param {number[]} args @param {unknown} thread */
    const call = async(pointer, slot, args, thread)=>
        (await env.callMethod(pointer, slot, args, thread)) | 0;
    /** @param {number} pointer @param {unknown} thread */
    const release = (pointer, thread)=>call(pointer, SLOT.RELEASE, [], thread);
    /**
     * Task memory for the length of `use`, zeroed.
     *
     * @template T
     * @param {number} bytes @param {(at: number) => Promise<T>} use @param {T} failed
     * @returns {Promise<T>}
     */
    const lend = async(bytes, use, failed)=>{
        const block = env.heap.allocate(Math.max(bytes, 4));
        if (block === 0)
        {
            return failed;
        }
        env.writeMemory(block, new Uint8Array(Math.max(bytes, 4)));
        try
        {
            return await use(block);
        }
        finally
        {
            env.heap.free(block);
        }
    };

    /**
     * A stream's whole contents, read from its start.
     *
     * @param {number} stream @param {unknown} thread
     * @returns {Promise<Uint8Array | null>}
     */
    const readStream = (stream, thread)=>lend(8, async position=>{
        if (await call(stream, SLOT.SEEK, [0, 0, STREAM_SEEK_END, position], thread) < 0)
        {
            return null;
        }
        const size = Math.min(readU32(position), 1 << 24);
        await call(stream, SLOT.SEEK, [0, 0, STREAM_SEEK_SET, 0], thread);
        return lend(size + 4, async buffer=>{
            const hr = await call(stream, SLOT.READ, [buffer, size, buffer + size], thread);
            return hr < 0 ? null : env.readMemory(buffer, readU32(buffer + size)).slice();
        }, null);
    }, null);

    /**
     * A stream's contents replaced with `bytes`.
     *
     * @param {number} stream @param {Uint8Array} bytes @param {unknown} thread
     */
    const writeStream = async(stream, bytes, thread)=>{
        await call(stream, SLOT.SEEK, [0, 0, STREAM_SEEK_SET, 0], thread);
        const sized = await call(stream, SLOT.SET_SIZE, [bytes.length, 0], thread);
        if (sized < 0)
        {
            return sized;
        }
        return lend(bytes.length, async buffer=>{
            env.writeMemory(buffer, bytes);
            return call(stream, SLOT.WRITE, [buffer, bytes.length, 0], thread);
        }, E_OUTOFMEMORY);
    };

    /** @param {Section} section */
    const cloneSection = section=>({ ...section, properties: new Map(section.properties),
        names: new Map(section.names) });

    /**
     * The identifier a PROPSPEC names, or null for a name the set has none of.
     *
     * @param {Section} section @param {number} spec
     */
    const resolve = (section, spec)=>{
        if (readU32(spec) === PRSPEC_PROPID)
        {
            return readU32(spec + 4);
        }
        const name = readWideAt(readU32(spec + 4));
        const folded = section.caseSensitive ? name : name.toLowerCase();
        for (const [id, known] of section.names)
        {
            if ((section.caseSensitive ? known : known.toLowerCase()) === folded)
            {
                return id;
            }
        }
        return null;
    };

    /**
     * A PROPVARIANT of the program's, as a property set holds it; null for
     * a type no set holds.
     *
     * @param {number} at
     * @returns {PropertyValue | null}
     */
    const readVariant = at=>{
        const bytes = env.readMemory(at, PROPVARIANT_BYTES).slice();
        const view = new DataView(bytes.buffer);
        const vt = view.getUint16(0, true);
        const pointer = view.getUint32(8, true);
        const fixed = FIXED_SIZE.get(vt);
        if (vt === VT.CLSID)
        {
            return pointer === 0 ? null : { vt, value: env.readMemory(pointer, 16).slice() };
        }
        if (fixed !== undefined)
        {
            return decodeValue(new DataView(join([u32(vt), bytes.subarray(8, 16)]).buffer), 0,
                CP_UNICODE);
        }
        switch (vt)
        {
            case VT.EMPTY:
            case VT.NULL:
                return { vt, value: 0 };
            case VT.LPSTR:
                return { vt, value: pointer === 0 ? '' : readAnsiAt(pointer) };
            case VT.LPWSTR:
                return { vt, value: pointer === 0 ? '' : readWideAt(pointer) };
            case VT.BSTR:
                return { vt, value: pointer === 0 ? ''
                    : decodeWide(env.readMemory(pointer, Math.min(readU32(pointer - 4), MAX_TEXT))
                        .slice()) };
            case VT.BLOB:
                return { vt, value: env.readMemory(view.getUint32(12, true),
                    view.getUint32(8, true)).slice() };
            case VT.CF: {
                if (pointer === 0)
                {
                    return null;
                }
                const size = readU32(pointer);
                return { vt, value: { format: readU32(pointer + 4) | 0,
                    data: size > 4 ? env.readMemory(readU32(pointer + 8), size - 4).slice()
                        : new Uint8Array(0) } };
            }
            default:
                return null;
        }
    };

    /**
     * A property laid down in the program's PROPVARIANT, what it points at
     * in task memory of its own; false when that cannot be had.
     *
     * @param {number} at @param {PropertyValue} property
     */
    const writeVariant = (at, property)=>{
        const record = new Uint8Array(PROPVARIANT_BYTES);
        const view = new DataView(record.buffer);
        const { vt, value } = property;
        view.setUint16(0, vt, true);
        /** @param {number} pointer */
        const point = pointer=>{
            view.setUint32(8, pointer, true);
            return pointer !== 0;
        };
        let made = true;
        if (vt === VT.CLSID)
        {
            made = point(taskCopy(value));
        }
        else if (FIXED_SIZE.has(vt))
        {
            record.set(encodeValue(property, CP_UNICODE).subarray(4, 12), 8);
        }
        else if (vt === VT.LPSTR)
        {
            made = point(taskCopy(encodeAnsi(`${value}\0`)));
        }
        else if (vt === VT.LPWSTR)
        {
            made = point(taskCopy(encodeWide(`${value}\0`)));
        }
        else if (vt === VT.BSTR)
        {
            made = point(env.allocateBstr?.(encodeWide(value)) ?? 0);
        }
        else if (vt === VT.BLOB)
        {
            view.setUint32(8, value.length, true);
            const block = taskCopy(value);
            view.setUint32(12, block, true);
            made = block !== 0;
        }
        else if (vt === VT.CF)
        {
            const data = value.data.length > 0 ? taskCopy(value.data) : 0;
            const clip = taskCopy(join([u32(value.data.length + 4), u32(value.format), u32(data)]));
            made = point(clip) && (value.data.length === 0 || data !== 0);
        }
        env.writeMemory(at, record);
        return made;
    };

    /** The set's code page when it is made: the ANSI page for an ANSI set. @param {number} flags */
    const codepageFor = flags=>((flags & PROPSETFLAG_ANSI) !== 0 ? ANSI_PAGE : CP_UNICODE);

    /**
     * Writes the set's stream as it now stands, and takes it as committed.
     *
     * @param {PropertyStorageState} state @param {unknown} thread
     */
    const commit = async(state, thread)=>{
        const sections = [...state.set.sections];
        sections[state.index] = state.section;
        const set = { ...state.set, clsid: state.clsid, sections };
        const hr = await writeStream(state.stream, encodePropertySet(set), thread);
        if (hr >= 0)
        {
            state.set = set;
            state.section = cloneSection(state.section);
            state.dirty = false;
            await call(state.stream, SLOT.COMMIT, [0], thread);
        }
        return hr < 0 ? hr : S_OK;
    };

    /** @param {any} object @returns {PropertyStorageState} */
    const stateOf = object=>object.state;

    /** @type {import('./objects.js').ComMethod[]} */
    const PROPERTY_STORAGE_METHODS = [
        { name: 'ReadMultiple', argBytes: 16, invoke: (object, [count, specs, variants])=>{
            if ((count >>> 0) === 0)
            {
                return S_FALSE;
            }
            if ((specs >>> 0) === 0 || (variants >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { section } = stateOf(object);
            let found = false;
            for (let index = 0; index < (count >>> 0); index++)
            {
                const at = (variants >>> 0) + index * PROPVARIANT_BYTES;
                const id = resolve(section, (specs >>> 0) + index * PROPSPEC_BYTES);
                const property = id === null ? undefined
                    : id === PID_CODEPAGE ? { vt: VT.I2, value: section.codepage }
                        : id === PID_LOCALE && section.locale !== null
                            ? { vt: VT.UI4, value: section.locale }
                            : section.properties.get(id);
                if (!property)
                {
                    env.writeMemory(at, new Uint8Array(PROPVARIANT_BYTES));
                    continue;
                }
                if (!writeVariant(at, property))
                {
                    return E_OUTOFMEMORY;
                }
                found = true;
            }
            return found ? S_OK : S_FALSE;
        } },
        { name: 'WriteMultiple', argBytes: 20, invoke: (object, [count, specs, variants, first])=>{
            const state = stateOf(object);
            if ((count >>> 0) === 0)
            {
                return S_OK;
            }
            if ((specs >>> 0) === 0 || (variants >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if (!state.writable)
            {
                return STG_E_ACCESSDENIED;
            }
            const { section } = state;
            for (let index = 0; index < (count >>> 0); index++)
            {
                const spec = (specs >>> 0) + index * PROPSPEC_BYTES;
                const property = readVariant((variants >>> 0) + index * PROPVARIANT_BYTES);
                if (!property)
                {
                    env.divergence?.('IPropertyStorage::WriteMultiple',
                        'a property of a type the set does not keep is refused');
                    return STG_E_INVALIDPARAMETER;
                }
                let id = resolve(section, spec);
                if (readU32(spec) === PRSPEC_LPWSTR && id === null)
                {
                    // A new name takes the first free identifier from the
                    // one the caller names, which may not be a special one.
                    if ((first >>> 0) < PID_FIRST_USABLE || (first >>> 0) >= PID_MIN_READONLY)
                    {
                        return STG_E_INVALIDPARAMETER;
                    }
                    id = first >>> 0;
                    while (section.properties.has(id) || section.names.has(id))
                    {
                        id++;
                    }
                    section.names.set(id, readWideAt(readU32(spec + 4)));
                }
                const hr = put(section, /** @type {number} */ (id), property);
                if (hr < 0)
                {
                    return hr;
                }
                state.dirty = true;
            }
            return S_OK;
        } },
        { name: 'DeleteMultiple', argBytes: 12, invoke: (object, [count, specs])=>{
            const state = stateOf(object);
            if ((count >>> 0) === 0)
            {
                return S_OK;
            }
            if ((specs >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if (!state.writable)
            {
                return STG_E_ACCESSDENIED;
            }
            for (let index = 0; index < (count >>> 0); index++)
            {
                const spec = (specs >>> 0) + index * PROPSPEC_BYTES;
                const id = resolve(state.section, spec);
                if (id === PID_DICTIONARY || id === PID_CODEPAGE)
                {
                    return STG_E_INVALIDPARAMETER;
                }
                if (id === null)
                {
                    continue;
                }
                state.section.properties.delete(id);
                if (readU32(spec) === PRSPEC_LPWSTR)
                {
                    state.section.names.delete(id);
                }
                state.dirty = true;
            }
            return S_OK;
        } },
        { name: 'ReadPropertyNames', argBytes: 16, invoke: (object, [count, ids, names])=>{
            if ((count >>> 0) === 0)
            {
                return S_FALSE;
            }
            if ((ids >>> 0) === 0 || (names >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { section } = stateOf(object);
            let found = false;
            for (let index = 0; index < (count >>> 0); index++)
            {
                const name = section.names.get(readU32((ids >>> 0) + index * 4));
                const block = name === undefined ? 0 : taskCopy(encodeWide(`${name}\0`));
                writeU32((names >>> 0) + index * 4, block);
                found ||= block !== 0;
            }
            return found ? S_OK : S_FALSE;
        } },
        { name: 'WritePropertyNames', argBytes: 16, invoke: (object, [count, ids, names])=>{
            const state = stateOf(object);
            if ((count >>> 0) !== 0 && ((ids >>> 0) === 0 || (names >>> 0) === 0))
            {
                return E_INVALIDARG;
            }
            if (!state.writable)
            {
                return STG_E_ACCESSDENIED;
            }
            for (let index = 0; index < (count >>> 0); index++)
            {
                const id = readU32((ids >>> 0) + index * 4);
                if (id === PID_DICTIONARY || id === PID_CODEPAGE)
                {
                    return STG_E_INVALIDPARAMETER;
                }
                state.section.names.set(id, readWideAt(readU32((names >>> 0) + index * 4)));
                state.dirty = true;
            }
            return S_OK;
        } },
        { name: 'DeletePropertyNames', argBytes: 12, invoke: (object, [count, ids])=>{
            const state = stateOf(object);
            if ((count >>> 0) !== 0 && (ids >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if (!state.writable)
            {
                return STG_E_ACCESSDENIED;
            }
            for (let index = 0; index < (count >>> 0); index++)
            {
                state.dirty ||= state.section.names.delete(readU32((ids >>> 0) + index * 4));
            }
            return S_OK;
        } },
        { name: 'Commit', argBytes: 8, invoke: object=>{
            const state = stateOf(object);
            return state.writable ? commit(state, env.callerThread()) : S_OK;
        } },
        { name: 'Revert', argBytes: 4, invoke: object=>{
            const state = stateOf(object);
            state.section = cloneSection(state.set.sections[state.index]);
            state.clsid = state.set.clsid;
            state.dirty = false;
            return S_OK;
        } },
        { name: 'Enum', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { section } = stateOf(object);
            const items = [...section.properties].sort(([a], [b])=>a - b)
                .map(([id, property])=>({ id, vt: property.vt, name: section.names.get(id) }));
            return publishEnumerator(env, { clsid: CLSID_PROPERTY_ENUMERATOR,
                iid: IID_IENUMSTATPROPSTG, size: STATPROPSTG_BYTES }, {
                items,
                write: (at, item)=>{
                    const name = item.name === undefined ? 0
                        : taskCopy(encodeWide(`${item.name}\0`));
                    if (item.name !== undefined && name === 0)
                    {
                        return false;
                    }
                    env.writeMemory(at, join([u32(name), u32(item.id), u32(item.vt)]));
                    return true;
                },
            }, out >>> 0);
        } },
        { name: 'SetTimes', argBytes: 16, invoke: (object, [created, accessed, modified])=>{
            const { times } = stateOf(object);
            [modified, created, accessed].forEach((pointer, index)=>{
                if ((pointer >>> 0) !== 0)
                {
                    times.set(env.readMemory(pointer >>> 0, 8), index * 8);
                }
            });
            return S_OK;
        } },
        { name: 'SetClass', argBytes: 8, invoke: (object, [clsid])=>{
            const state = stateOf(object);
            if ((clsid >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if (!state.writable)
            {
                return STG_E_ACCESSDENIED;
            }
            state.clsid = formatGuid(env.readMemory(clsid >>> 0, 16));
            state.dirty = true;
            return S_OK;
        } },
        { name: 'Stat', argBytes: 8, invoke: (object, [out])=>{
            const state = stateOf(object);
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            env.writeMemory(out >>> 0, join([
                /** @type {Uint8Array} */ (parseGuid(state.section.fmtid)),
                /** @type {Uint8Array} */ (parseGuid(state.clsid)),
                u32(state.flags), state.times, u32(state.set.osVersion)]));
            return S_OK;
        } },
    ];

    /**
     * A property written into a section, the special identifiers checked:
     * the dictionary and the behaviour are never written this way, and the
     * code page only as a VT_I2 while nothing else is in the set.
     *
     * @param {Section} section @param {number} id @param {PropertyValue} property
     */
    const put = (section, id, property)=>{
        if (id === PID_DICTIONARY || id === PID_BEHAVIOR)
        {
            return STG_E_INVALIDPARAMETER;
        }
        if (id === PID_CODEPAGE)
        {
            if (property.vt !== VT.I2 || section.properties.size > 0 || section.names.size > 0)
            {
                return STG_E_INVALIDPARAMETER;
            }
            section.codepage = property.value & 0xffff;
            return S_OK;
        }
        if (id === PID_LOCALE)
        {
            if (property.vt !== VT.UI4)
            {
                return STG_E_INVALIDPARAMETER;
            }
            section.locale = property.value >>> 0;
            return S_OK;
        }
        if (id >= PID_MIN_READONLY)
        {
            return STG_E_INVALIDPARAMETER;
        }
        section.properties.set(id, property);
        return S_OK;
    };

    /**
     * An IPropertyStorage over `stream`, which it holds from here on, into
     * `out`. A set is written as soon as it is made, so its stream reads as
     * a property set at once; what changes after waits for Commit or the
     * last Release.
     *
     * @param {PropertyStorageState} state @param {boolean} fresh @param {number} out
     * @param {unknown} thread
     */
    const publishStorage = async(state, fresh, out, thread)=>{
        if (fresh)
        {
            state.dirty = true;
            const hr = await commit(state, thread);
            if (hr < 0)
            {
                await release(state.stream, thread);
                return hr;
            }
        }
        const object = env.makeObject(CLSID_PROPERTY_STORAGE, {
            state,
            interfaces: [{ id: IID_IPROPERTYSTORAGE, methods: PROPERTY_STORAGE_METHODS }],
            lastRelease: async()=>{
                const caller = env.callerThread();
                const stream = state.stream;
                state.stream = 0;
                if (stream === 0)
                {
                    return;
                }
                if (state.dirty && state.writable)
                {
                    state.stream = stream;
                    await commit(state, caller);
                    state.stream = 0;
                }
                await release(stream, caller);
            },
            destroy: ()=>{
                if (state.stream !== 0)
                {
                    void release(state.stream, env.callerThread());
                    state.stream = 0;
                }
            },
        });
        const pointer = object ? env.publish(object, IID_IPROPERTYSTORAGE) >>> 0 : 0;
        if (pointer === 0)
        {
            await release(state.stream, thread);
            return E_OUTOFMEMORY;
        }
        writeU32(out, pointer);
        return S_OK;
    };

    /**
     * A new set in `stream`: an empty section of its own, beside the
     * document summary's when it is the user-defined set.
     *
     * @param {string} fmtid @param {string} clsid @param {number} flags
     * @param {PropertySet | null} existing  The stream's set, for the user-defined one.
     */
    const newSet = (fmtid, clsid, flags, existing)=>{
        const section = emptySection(fmtid, codepageFor(flags));
        section.caseSensitive = (flags & PROPSETFLAG_CASE_SENSITIVE) !== 0;
        if (fmtid !== FMTID_USER_DEFINED_PROPERTIES)
        {
            return { set: { clsid, osVersion: OS_VERSION, sections: [section] }, index: 0 };
        }
        const first = existing?.sections[0]
            ?? emptySection(FMTID_DOC_SUMMARY_INFORMATION, codepageFor(flags));
        return { set: { clsid, osVersion: existing?.osVersion ?? OS_VERSION,
            sections: [first, section] }, index: 1 };
    };

    /**
     * The section of `fmtid` in a set read from its stream: the user-defined
     * one is the document summary stream's second.
     *
     * @param {PropertySet} set @param {string} fmtid
     */
    const sectionIndex = (set, fmtid)=>set.sections
        .findIndex(section=>section.fmtid.toUpperCase() === fmtid.toUpperCase());

    /**
     * IPropertySetStorage over an IStorage: the property sets are its
     * streams named after them.
     *
     * @param {(object: any) => number} storageOf  The IStorage a call is on.
     * @returns {import('./objects.js').ComMethod[]}
     */
    const propertySetMethods = storageOf=>[
        { name: 'Create', argBytes: 24, invoke: async(object, [fmtid, clsid, flags, mode, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out >>> 0, 0);
            if ((fmtid >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            // Made read-write and exclusive, or not at all (storage32.c
            // test_storage_suminfo).
            if ((mode & STGM_ACCESS) !== STGM_READWRITE
                || (mode & STGM_SHARING) !== STGM_SHARE_EXCLUSIVE)
            {
                return STG_E_INVALIDFLAG;
            }
            if ((flags & PROPSETFLAG_NONSIMPLE) !== 0)
            {
                env.divergence?.('IPropertySetStorage::Create',
                    'a non-simple property set (one kept in a storage) is refused');
                return STG_E_INVALIDFLAG;
            }
            const thread = env.callerThread();
            const format = formatGuid(env.readMemory(fmtid >>> 0, 16));
            const klass = (clsid >>> 0) === 0 ? GUID_NULL
                : formatGuid(env.readMemory(clsid >>> 0, 16));
            const storage = storageOf(object);
            const name = nameOfFormat(format);
            let stream = 0;
            /** @type {PropertySet | null} */
            let existing = null;
            if (format === FMTID_USER_DEFINED_PROPERTIES)
            {
                stream = await openStream(storage, name, STGM_READWRITE | STGM_SHARE_EXCLUSIVE,
                    thread);
                existing = stream === 0 ? null : decodePropertySet(await readStream(stream, thread)
                    ?? new Uint8Array(0));
            }
            if (stream === 0)
            {
                const made = await createStream(storage, name, thread);
                if (made.hr < 0)
                {
                    return made.hr;
                }
                stream = made.stream;
            }
            const { set, index } = newSet(format, klass, flags >>> 0, existing);
            return publishStorage({ stream, clsid: klass, flags: flags >>> 0, writable: true,
                index, set, section: cloneSection(set.sections[index]), dirty: false,
                times: new Uint8Array(24) }, true, out >>> 0, thread);
        } },
        { name: 'Open', argBytes: 16, invoke: async(object, [fmtid, mode, out])=>{
            if ((out >>> 0) === 0 || (fmtid >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out >>> 0, 0);
            if ((mode & STGM_CREATE) !== 0)
            {
                return STG_E_INVALIDFLAG;
            }
            const thread = env.callerThread();
            const format = formatGuid(env.readMemory(fmtid >>> 0, 16));
            // A set is not transacted as a stream is: the flag is the set's.
            const stream = await openStream(storageOf(object), nameOfFormat(format),
                mode & ~STGM_TRANSACTED, thread);
            if (stream === 0)
            {
                return STG_E_FILENOTFOUND;
            }
            return openSet(stream, format, (mode & STGM_ACCESS) !== STGM_READ, out >>> 0, thread);
        } },
        { name: 'Delete', argBytes: 8, invoke: async(object, [fmtid])=>{
            if ((fmtid >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const name = nameOfFormat(formatGuid(env.readMemory(fmtid >>> 0, 16)));
            const hr = await withName(name, at=>call(storageOf(object), SLOT.DESTROY_ELEMENT, [at],
                env.callerThread()));
            return hr < 0 ? hr : S_OK;
        } },
        { name: 'Enum', argBytes: 8, invoke: async(object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const formats = await setsIn(storageOf(object), env.callerThread());
            if (formats === null)
            {
                return E_OUTOFMEMORY;
            }
            return publishEnumerator(env, { clsid: CLSID_PROPERTY_SET_ENUMERATOR,
                iid: IID_IENUMSTATPROPSETSTG, size: STATPROPSETSTG_BYTES, skipNothingEnds: true }, {
                items: formats,
                write: (at, format)=>{
                    const record = new Uint8Array(STATPROPSETSTG_BYTES);
                    record.set(/** @type {Uint8Array} */ (parseGuid(format)), 0);
                    env.writeMemory(at, record);
                    return true;
                },
            }, out >>> 0);
        } },
    ];

    /**
     * An open set read from its stream into `out`; the stream is let go of
     * when it holds no set of that format.
     *
     * @param {number} stream @param {string} format @param {boolean} writable
     * @param {number} out @param {unknown} thread
     */
    const openSet = async(stream, format, writable, out, thread)=>{
        const set = decodePropertySet(await readStream(stream, thread) ?? new Uint8Array(0));
        const index = set ? sectionIndex(set, format) : -1;
        if (!set || index < 0)
        {
            await release(stream, thread);
            return set ? STG_E_FILENOTFOUND : STG_E_INVALIDHEADER;
        }
        const section = set.sections[index];
        const flags = (section.codepage === CP_UNICODE ? 0 : PROPSETFLAG_ANSI)
            | (section.caseSensitive ? PROPSETFLAG_CASE_SENSITIVE : 0);
        return publishStorage({ stream, clsid: set.clsid, flags, writable, index, set,
            section: cloneSection(section), dirty: false, times: new Uint8Array(24) }, false, out,
        thread);
    };

    /**
     * A name lent to a call in task memory.
     *
     * @param {string} name @param {(at: number) => Promise<number>} use
     */
    const withName = (name, use)=>lend((name.length + 1) * 2, at=>{
        writeWideAt(at, name);
        return use(at);
    }, E_OUTOFMEMORY);

    /**
     * @param {number} storage @param {string} name @param {number} mode @param {unknown} thread
     * @returns {Promise<number>} the stream, or 0
     */
    const openStream = (storage, name, mode, thread)=>withName(name, at=>lend(4, async slot=>{
        const hr = await call(storage, SLOT.OPEN_STREAM, [at, 0, mode, 0, slot], thread);
        return hr < 0 ? 0 : readU32(slot);
    }, 0));

    /**
     * @param {number} storage @param {string} name @param {unknown} thread
     * @returns {Promise<{ hr: number, stream: number }>}
     */
    const createStream = async(storage, name, thread)=>{
        /** @type {{ hr: number, stream: number }} */
        let made = { hr: E_OUTOFMEMORY, stream: 0 };
        await withName(name, at=>lend(4, async slot=>{
            const hr = await call(storage, SLOT.CREATE_STREAM,
                [at, STGM_CREATE | STGM_READWRITE | STGM_SHARE_EXCLUSIVE, 0, 0, slot], thread);
            made = { hr, stream: hr < 0 ? 0 : readU32(slot) };
            return hr;
        }, E_OUTOFMEMORY));
        return made;
    };

    /**
     * The formats of the property sets a storage holds: its streams whose
     * names are those of a set.
     *
     * @param {number} storage @param {unknown} thread
     * @returns {Promise<string[] | null>}
     */
    const setsIn = (storage, thread)=>lend(4 + STATSTG_BYTES + 4, async slot=>{
        if (await call(storage, SLOT.ENUM_ELEMENTS, [0, 0, 0, slot], thread) < 0)
        {
            return null;
        }
        const enumerator = readU32(slot);
        /** @type {string[]} */
        const formats = [];
        const item = slot + 4;
        while (await call(enumerator, SLOT.NEXT, [1, item, item + STATSTG_BYTES], thread) === S_OK)
        {
            const name = readU32(item);
            const text = name === 0 ? '' : readWideAt(name);
            if (name !== 0)
            {
                env.heap.free(name);
            }
            const format = readU32(item + 4) === STGTY_STREAM && text.startsWith(PROPERTY_SET_MARK)
                ? formatOfName(text) : null;
            if (format !== null)
            {
                formats.push(format);
            }
        }
        await release(enumerator, thread);
        return formats;
    }, null);

    /** IPropertySetStorage as an IStorage of ours answers it: over itself. */
    const ON_STORAGE = propertySetMethods(object=>env.publish(object, IID_ISTORAGE) >>> 0);
    /** IPropertySetStorage as StgCreatePropSetStg makes it: over the storage it holds. */
    const STANDALONE = propertySetMethods(object=>object.state.storage);

    /**
     * The IStream a property set is kept in, from what the caller passed.
     *
     * @param {number} unknown @param {unknown} thread
     */
    const streamOf = (unknown, thread)=>env.queryPointer(unknown, IID_ISTREAM, thread);

    return {
        /** The methods an IStorage of ours answers IPropertySetStorage with. */
        storageMethods: ON_STORAGE,

        /**
         * HRESULT StgCreatePropSetStg(IStorage *pStorage, DWORD dwReserved,
         *     IPropertySetStorage **ppPropSetStg)
         */
        StgCreatePropSetStg: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([storage, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out >>> 0, 0);
                if ((storage >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = env.callerThread();
                const held = await env.queryPointer(storage >>> 0, IID_ISTORAGE, thread);
                if (held === 0)
                {
                    return E_NOINTERFACE;
                }
                const state = { storage: held };
                const object = env.makeObject(CLSID_PROPERTY_SET_STORAGE, {
                    state,
                    interfaces: [{ id: IID_IPROPERTYSETSTORAGE, methods: STANDALONE }],
                    lastRelease: async()=>{
                        const pointer = state.storage;
                        state.storage = 0;
                        if (pointer !== 0)
                        {
                            await release(pointer, env.callerThread());
                        }
                    },
                    destroy: ()=>{
                        if (state.storage !== 0)
                        {
                            void release(state.storage, env.callerThread());
                            state.storage = 0;
                        }
                    },
                });
                const pointer = object ? env.publish(object, IID_IPROPERTYSETSTORAGE) >>> 0 : 0;
                if (pointer === 0)
                {
                    await release(held, thread);
                    return E_OUTOFMEMORY;
                }
                writeU32(out >>> 0, pointer);
                return S_OK;
            },
        },

        /**
         * HRESULT StgCreatePropStg(IUnknown *pUnk, REFFMTID fmtid, const CLSID *pclsid,
         *     DWORD grfFlags, DWORD dwReserved, IPropertyStorage **ppPropStg)
         *
         * A new set written into the caller's stream.
         */
        StgCreatePropStg: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: async([unknown, fmtid, clsid, flags, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out >>> 0, 0);
                if ((unknown >>> 0) === 0 || (fmtid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((flags & PROPSETFLAG_NONSIMPLE) !== 0)
                {
                    env.divergence?.('StgCreatePropStg',
                        'a non-simple property set (one kept in a storage) is refused');
                    return STG_E_INVALIDFLAG;
                }
                const thread = env.callerThread();
                const stream = await streamOf(unknown >>> 0, thread);
                if (stream === 0)
                {
                    return E_NOINTERFACE;
                }
                const format = formatGuid(env.readMemory(fmtid >>> 0, 16));
                const klass = (clsid >>> 0) === 0 ? GUID_NULL
                    : formatGuid(env.readMemory(clsid >>> 0, 16));
                const { set, index } = newSet(format, klass, flags >>> 0, null);
                return publishStorage({ stream, clsid: klass, flags: flags >>> 0, writable: true,
                    index, set, section: cloneSection(set.sections[index]), dirty: false,
                    times: new Uint8Array(24) }, true, out >>> 0, thread);
            },
        },

        /**
         * HRESULT StgOpenPropStg(IUnknown *pUnk, REFFMTID fmtid, DWORD grfFlags,
         *     DWORD dwReserved, IPropertyStorage **ppPropStg)
         */
        StgOpenPropStg: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: async([unknown, fmtid, flags, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out >>> 0, 0);
                if ((unknown >>> 0) === 0 || (fmtid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((flags & PROPSETFLAG_NONSIMPLE) !== 0)
                {
                    return STG_E_INVALIDFLAG;
                }
                const thread = env.callerThread();
                const stream = await streamOf(unknown >>> 0, thread);
                if (stream === 0)
                {
                    return E_NOINTERFACE;
                }
                return openSet(stream, formatGuid(env.readMemory(fmtid >>> 0, 16)), true,
                    out >>> 0, thread);
            },
        },

        FmtIdToPropStgName: {
            argBytes: 8,
            /**
             * HRESULT FmtIdToPropStgName(const FMTID *pfmtid, LPOLESTR oszName)
             *
             * The caller's buffer holds CCH_MAX_PROPSTG_NAME + 1 characters.
             *
             * @param {number[]} args
             */
            handler: ([fmtid, out])=>{
                if ((fmtid >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeWideAt(out >>> 0, nameOfFormat(formatGuid(env.readMemory(fmtid >>> 0, 16))));
                return S_OK;
            },
        },

        PropStgNameToFmtId: {
            argBytes: 8,
            /**
             * HRESULT PropStgNameToFmtId(const LPOLESTR oszName, FMTID *pfmtid)
             *
             * The out-pointer is checked first: a NULL name with somewhere to
             * answer is a bad name (stg_prop.c testFmtId).
             *
             * @param {number[]} args
             */
            handler: ([name, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const text = (name >>> 0) === 0 ? null : readWideAt(name >>> 0);
                const fmtid = text === null || text.length > MAX_NAME_LENGTH ? null
                    : formatOfName(text);
                if (fmtid === null)
                {
                    return STG_E_INVALIDNAME;
                }
                env.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(fmtid)));
                return S_OK;
            },
        },
    };
}
