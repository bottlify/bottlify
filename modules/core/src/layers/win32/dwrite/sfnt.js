/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OpenType files as DirectWrite reads them, and the files it is handed made
 * here: a face's table directory, its tables found by tag, the character map
 * looked up, the metrics, names and style the tables say; and a font file
 * written out of tables, for the faces this engine has no file of.
 *
 * Every number DirectWrite answers about a face is read from its tables the
 * way Windows reads them (Wine's dwrite tests derive their expectations from
 * the same tables), so a face made here and a face read from a file are
 * answered by one path.
 */

/** A tag as the big-endian word a directory holds and TryGetFontTable's little-endian one. */
export const tagOf = (/** @type {string} */ text)=>[...text].reduce((word, c)=>word * 256
    + c.charCodeAt(0), 0) >>> 0;
/** DWRITE_MAKE_OPENTYPE_TAG: the four characters little-endian, as a program passes them. */
export const openTypeTag = (/** @type {string} */ text)=>[...text].reduce((word, c, i)=>word
    | c.charCodeAt(0) << i * 8, 0) >>> 0;
/** A program's little-endian tag as its four characters. @param {number} tag */
export const tagText = tag=>String.fromCharCode(tag & 0xff, tag >>> 8 & 0xff, tag >>> 16 & 0xff,
    tag >>> 24);

/** DWRITE_FONT_FILE_TYPE. */
export const FILE_TYPE = Object.freeze({ UNKNOWN: 0, CFF: 1, TRUETYPE: 2, COLLECTION: 3 });
/** DWRITE_FONT_FACE_TYPE. */
export const FACE_TYPE = Object.freeze({ CFF: 0, TRUETYPE: 1, COLLECTION: 2, UNKNOWN: 6 });

/** A file that is not a font: DWRITE_E_FILEFORMAT, with the reason. */
export class FontFormatError extends Error {}

/**
 * What kind of font file the bytes are, and where each face's directory is.
 *
 * @param {Uint8Array} bytes
 * @returns {{ fileType: number, faceType: number, faces: number[] }}
 */
export function analyzeFile(bytes){
    if (bytes.length < 12)
    {
        return { fileType: FILE_TYPE.UNKNOWN, faceType: FACE_TYPE.UNKNOWN, faces: [] };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const head = view.getUint32(0);
    if (head === tagOf('ttcf'))
    {
        const count = view.getUint32(8);
        if (bytes.length < 12 + count * 4)
        {
            return { fileType: FILE_TYPE.UNKNOWN, faceType: FACE_TYPE.UNKNOWN, faces: [] };
        }
        return { fileType: FILE_TYPE.COLLECTION, faceType: FACE_TYPE.COLLECTION,
            faces: Array.from({ length: count }, (_, i)=>view.getUint32(12 + i * 4)) };
    }
    if (head === tagOf('OTTO'))
    {
        return { fileType: FILE_TYPE.CFF, faceType: FACE_TYPE.CFF, faces: [0] };
    }
    if (head === 0x00010000 || head === tagOf('true'))
    {
        return { fileType: FILE_TYPE.TRUETYPE, faceType: FACE_TYPE.TRUETYPE, faces: [0] };
    }
    return { fileType: FILE_TYPE.UNKNOWN, faceType: FACE_TYPE.UNKNOWN, faces: [] };
}

/**
 * A face's tables, by tag, as views into the file.
 *
 * @param {Uint8Array} bytes @param {number} directory  where the face's table directory is
 * @returns {Map<string, Uint8Array>}
 */
export function tablesOf(bytes, directory){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (directory + 12 > bytes.length)
    {
        throw new FontFormatError('a font whose table directory is past its end');
    }
    const count = view.getUint16(directory + 4);
    /** @type {Map<string, Uint8Array>} */
    const tables = new Map();
    for (let i = 0; i < count; i++)
    {
        const record = directory + 12 + i * 16;
        if (record + 16 > bytes.length)
        {
            throw new FontFormatError('a font whose table directory is cut short');
        }
        const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
        const offset = view.getUint32(record + 8);
        const length = view.getUint32(record + 12);
        if (offset + length <= bytes.length)
        {
            tables.set(tag, bytes.subarray(offset, offset + length));
        }
    }
    return tables;
}

/** @param {Uint8Array | undefined} table */
const viewOf = table=>(table ? new DataView(table.buffer, table.byteOffset, table.byteLength)
    : null);

/**
 * The character map a face is read through: the best Unicode subtable of its
 * 'cmap' (format 12, then 4, then 6 or 0), and whether it is a symbol font's
 * (platform 3, encoding 0), whose characters live at U+F000 and up.
 *
 * @param {Uint8Array | undefined} cmap
 * @returns {{ lookup: (code: number) => number, symbol: boolean }}
 */
export function characterMapOf(cmap){
    const view = viewOf(cmap);
    if (!view || view.byteLength < 4)
    {
        return { lookup: ()=>0, symbol: false };
    }
    const count = view.getUint16(2);
    /** @type {{ rank: number, at: number, symbol: boolean } | null} */
    let best = null;
    for (let i = 0; i < count && 4 + i * 8 + 8 <= view.byteLength; i++)
    {
        const platform = view.getUint16(4 + i * 8);
        const encoding = view.getUint16(6 + i * 8);
        const at = view.getUint32(8 + i * 8);
        const rank = platform === 3 && encoding === 10 ? 5 : platform === 0 && encoding >= 4 ? 4
            : platform === 3 && encoding === 1 ? 3 : platform === 0 ? 2
                : platform === 3 && encoding === 0 ? 1 : 0;
        if (rank && at < view.byteLength && (!best || rank > best.rank))
        {
            best = { rank, at, symbol: platform === 3 && encoding === 0 };
        }
    }
    if (!best)
    {
        return { lookup: ()=>0, symbol: false };
    }
    const at = best.at;
    const format = view.getUint16(at);
    /** @param {number} offset */
    const u16 = offset=>(offset + 2 <= view.byteLength ? view.getUint16(offset) : 0);
    /** @param {number} offset */
    const u32 = offset=>(offset + 4 <= view.byteLength ? view.getUint32(offset) : 0);
    /** @type {(code: number) => number} */
    let lookup = ()=>0;
    if (format === 4)
    {
        const segments = u16(at + 6) >> 1;
        const ends = at + 14;
        const starts = ends + segments * 2 + 2;
        const deltas = starts + segments * 2;
        const ranges = deltas + segments * 2;
        lookup = code=>{
            if (code > 0xffff)
            {
                return 0;
            }
            for (let s = 0; s < segments; s++)
            {
                if (code > u16(ends + s * 2))
                {
                    continue;
                }
                const start = u16(starts + s * 2);
                if (code < start)
                {
                    return 0;
                }
                const delta = u16(deltas + s * 2);
                const range = u16(ranges + s * 2);
                if (range === 0)
                {
                    return (code + delta) & 0xffff;
                }
                const glyph = u16(ranges + s * 2 + range + (code - start) * 2);
                return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
            }
            return 0;
        };
    }
    else if (format === 12)
    {
        const groups = u32(at + 12);
        lookup = code=>{
            for (let g = 0; g < groups; g++)
            {
                const group = at + 16 + g * 12;
                const first = u32(group);
                const last = u32(group + 4);
                if (code >= first && code <= last)
                {
                    return u32(group + 8) + code - first;
                }
            }
            return 0;
        };
    }
    else if (format === 6)
    {
        const first = u16(at + 6);
        const entries = u16(at + 8);
        lookup = code=>(code >= first && code < first + entries
            ? u16(at + 10 + (code - first) * 2) : 0);
    }
    else if (format === 0)
    {
        lookup = code=>(code < 256 && at + 6 + code < view.byteLength
            ? view.getUint8(at + 6 + code) : 0);
    }
    const symbol = best.symbol;
    return { lookup: symbol
        ? code=>lookup(code) || (code < 0x100 ? lookup(code + 0xf000) : 0)
        : lookup, symbol };
}

/** DWRITE_FONT_WEIGHT, STYLE and STRETCH values a face's tables say. */
export const STYLE = Object.freeze({ NORMAL: 0, OBLIQUE: 1, ITALIC: 2 });

/**
 * DWRITE_FONT_METRICS (with DWRITE_FONT_METRICS1's extra fields) as the tables
 * give them, Windows' way: the typographic ascender and descender where
 * OS/2 asks for them, else usWinAscent and usWinDescent with whatever hhea's
 * line spacing adds as the gap; the underline from 'post'; thickness that is
 * zero made 1/14 em.
 *
 * @param {Map<string, Uint8Array>} tables
 */
export function metricsOf(tables){
    const head = viewOf(tables.get('head'));
    const os2 = viewOf(tables.get('OS/2'));
    const hhea = viewOf(tables.get('hhea'));
    const post = viewOf(tables.get('post'));
    const m = { designUnitsPerEm: 0, ascent: 0, descent: 0, lineGap: 0, capHeight: 0, xHeight: 0,
        underlinePosition: 0, underlineThickness: 0, strikethroughPosition: 0,
        strikethroughThickness: 0, glyphBoxLeft: 0, glyphBoxTop: 0, glyphBoxRight: 0,
        glyphBoxBottom: 0, subscriptPositionX: 0, subscriptPositionY: 0, subscriptSizeX: 0,
        subscriptSizeY: 0, superscriptPositionX: 0, superscriptPositionY: 0,
        superscriptSizeX: 0, superscriptSizeY: 0, hasTypographicMetrics: false };
    if (head && head.byteLength >= 54)
    {
        m.designUnitsPerEm = head.getUint16(18);
        m.glyphBoxLeft = head.getInt16(36);
        m.glyphBoxBottom = head.getInt16(38);
        m.glyphBoxRight = head.getInt16(40);
        m.glyphBoxTop = head.getInt16(42);
    }
    if (os2 && os2.byteLength >= 78)
    {
        if (os2.getUint16(62) & 0x80)
        {
            m.ascent = os2.getInt16(68) & 0xffff;
            m.descent = Math.max(0, -os2.getInt16(70));
            m.lineGap = os2.getInt16(72);
            m.hasTypographicMetrics = true;
        }
        else
        {
            m.ascent = os2.getUint16(74);
            m.descent = Math.abs(os2.getInt16(76));
            if (hhea && hhea.byteLength >= 36)
            {
                m.lineGap = Math.max(0, hhea.getUint16(4) + Math.abs(hhea.getInt16(6))
                    + hhea.getUint16(8) - m.ascent - m.descent);
            }
        }
        m.strikethroughThickness = os2.getUint16(26);
        m.strikethroughPosition = os2.getInt16(28);
        m.subscriptSizeX = os2.getInt16(10);
        m.subscriptSizeY = os2.getInt16(12);
        m.subscriptPositionX = os2.getInt16(14);
        m.subscriptPositionY = -os2.getInt16(16);
        m.superscriptSizeX = os2.getInt16(18);
        m.superscriptSizeY = os2.getInt16(20);
        m.superscriptPositionX = os2.getInt16(22);
        m.superscriptPositionY = os2.getInt16(24);
        if (os2.getUint16(0) >= 2 && os2.byteLength >= 90)
        {
            m.xHeight = os2.getInt16(86);
            m.capHeight = os2.getInt16(88);
        }
    }
    else
    {
        m.strikethroughPosition = Math.trunc(m.designUnitsPerEm / 3);
        if (hhea && hhea.byteLength >= 36)
        {
            m.ascent = hhea.getUint16(4);
            m.descent = Math.abs(hhea.getInt16(6));
        }
    }
    if (post && post.byteLength >= 12)
    {
        m.underlinePosition = post.getInt16(8);
        m.underlineThickness = post.getInt16(10);
    }
    if (m.underlineThickness === 0)
    {
        m.underlineThickness = Math.trunc((m.designUnitsPerEm + 7) / 14);
    }
    if (m.strikethroughThickness === 0)
    {
        m.strikethroughThickness = m.underlineThickness;
    }
    // A face without OS/2's heights: the em's proportions Windows assumes.
    if (m.capHeight === 0)
    {
        m.capHeight = Math.round(m.designUnitsPerEm * 0.7);
    }
    if (m.xHeight === 0)
    {
        m.xHeight = Math.round(m.designUnitsPerEm / 2);
    }
    return m;
}

/**
 * The glyph count 'maxp' says, and each glyph's horizontal advance and left
 * side bearing from 'hhea' and 'hmtx' (a glyph past the long metrics taking
 * the last advance), and its box from 'glyf' where the face has one.
 *
 * @param {Map<string, Uint8Array>} tables
 */
export function glyphsOf(tables){
    const maxp = viewOf(tables.get('maxp'));
    const hhea = viewOf(tables.get('hhea'));
    const hmtx = viewOf(tables.get('hmtx'));
    const count = maxp && maxp.byteLength >= 6 ? maxp.getUint16(4) : 0;
    const long = hhea && hhea.byteLength >= 36 ? hhea.getUint16(34) : 0;
    const head = viewOf(tables.get('head'));
    const loca = viewOf(tables.get('loca'));
    const glyf = viewOf(tables.get('glyf'));
    const shortLoca = head && head.byteLength >= 54 ? head.getInt16(50) === 0 : true;
    /** @param {number} glyph */
    const advance = glyph=>{
        if (!hmtx || long === 0)
        {
            return 0;
        }
        const index = Math.min(glyph, long - 1);
        return index * 4 + 2 <= hmtx.byteLength ? hmtx.getUint16(index * 4) : 0;
    };
    /** @param {number} glyph */
    const leftBearing = glyph=>{
        if (!hmtx)
        {
            return 0;
        }
        const at = glyph < long ? glyph * 4 + 2 : long * 4 + (glyph - long) * 2;
        return at + 2 <= hmtx.byteLength ? hmtx.getInt16(at) : 0;
    };
    /**
     * A glyph's box from 'glyf', or null for one with no outline (or no glyf).
     *
     * @param {number} glyph
     * @returns {{ xMin: number, yMin: number, xMax: number, yMax: number } | null}
     */
    const box = glyph=>{
        if (!loca || !glyf || glyph >= count)
        {
            return null;
        }
        const offset = (/** @type {number} */ i)=>(shortLoca ? loca.getUint16(i * 2) * 2
            : loca.getUint32(i * 4));
        const step = shortLoca ? 2 : 4;
        if ((glyph + 2) * step > loca.byteLength)
        {
            return null;
        }
        const from = offset(glyph);
        if (offset(glyph + 1) === from || from + 10 > glyf.byteLength)
        {
            return null;
        }
        return { xMin: glyf.getInt16(from + 2), yMin: glyf.getInt16(from + 4),
            xMax: glyf.getInt16(from + 6), yMax: glyf.getInt16(from + 8) };
    };
    return { count, advance, leftBearing, box };
}

/**
 * The strings of a face's 'name' table: each record's id, language and text
 * (Windows Unicode ones, and Macintosh Roman ones where a name has no other).
 *
 * @param {Uint8Array | undefined} table
 * @returns {{ id: number, language: number, platform: number, text: string }[]}
 */
export function namesOf(table){
    const view = viewOf(table);
    if (!view || view.byteLength < 6)
    {
        return [];
    }
    const count = view.getUint16(2);
    const strings = view.getUint16(4);
    /** @type {{ id: number, language: number, platform: number, text: string }[]} */
    const out = [];
    for (let i = 0; i < count && 6 + i * 12 + 12 <= view.byteLength; i++)
    {
        const at = 6 + i * 12;
        const [platform, encoding, language, id, length, offset] = [0, 2, 4, 6, 8, 10]
            .map(field=>view.getUint16(at + field));
        const from = strings + offset;
        if (from + length > view.byteLength)
        {
            continue;
        }
        if (platform === 3 && (encoding === 1 || encoding === 0 || encoding === 10))
        {
            out.push({ id, language, platform, text: String.fromCharCode(...Array.from(
                { length: length >> 1 }, (_, k)=>view.getUint16(from + k * 2))) });
        }
        else if (platform === 1 && encoding === 0)
        {
            out.push({ id, language: language === 0 ? 0x409 : 0x10000 + language, platform,
                text: String.fromCharCode(...Array.from({ length }, (_, k)=>view.getUint8(from
                    + k))) });
        }
    }
    return out;
}

/**
 * The weight, stretch and style a face's OS/2 and head say.
 *
 * @param {Map<string, Uint8Array>} tables
 */
export function styleOf(tables){
    const os2 = viewOf(tables.get('OS/2'));
    const head = viewOf(tables.get('head'));
    const weight = os2 && os2.byteLength >= 8 ? os2.getUint16(4) || 400 : 400;
    const stretch = os2 && os2.byteLength >= 8 ? Math.min(9, Math.max(1, os2.getUint16(6) || 5))
        : 5;
    const selection = os2 && os2.byteLength >= 64 ? os2.getUint16(62) : 0;
    const macStyle = head && head.byteLength >= 46 ? head.getUint16(44) : 0;
    const style = selection & 0x200 ? STYLE.OBLIQUE
        : (selection & 1) || (macStyle & 2) ? STYLE.ITALIC : STYLE.NORMAL;
    return { weight, stretch, style };
}

/**
 * A font file of tables: the directory sorted by tag, each table on a
 * four-byte boundary with its checksum, as the format asks.
 *
 * @param {Map<string, Uint8Array>} tables
 * @returns {Uint8Array}
 */
export function writeSfnt(tables){
    const tags = [...tables.keys()].sort();
    const count = tags.length;
    let size = 12 + count * 16;
    /** @type {number[]} */
    const offsets = [];
    for (const tag of tags)
    {
        offsets.push(size);
        size += (/** @type {Uint8Array} */ (tables.get(tag)).length + 3) & ~3;
    }
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x00010000);
    view.setUint16(4, count);
    const power = 2 ** Math.floor(Math.log2(Math.max(1, count)));
    view.setUint16(6, power * 16);
    view.setUint16(8, Math.log2(power));
    view.setUint16(10, count * 16 - power * 16);
    tags.forEach((tag, i)=>{
        const table = /** @type {Uint8Array} */ (tables.get(tag));
        const record = 12 + i * 16;
        for (let k = 0; k < 4; k++)
        {
            bytes[record + k] = tag.charCodeAt(k);
        }
        bytes.set(table, offsets[i]);
        let sum = 0;
        for (let at = 0; at < table.length; at += 4)
        {
            sum = (sum + view.getUint32(offsets[i] + at)) >>> 0;
        }
        view.setUint32(record + 4, sum);
        view.setUint32(record + 8, offsets[i]);
        view.setUint32(record + 12, table.length);
    });
    return bytes;
}

/**
 * Big-endian fields written one after another: [kind, value] with kind
 * 'u8', 'u16', 'i16', 'u32', 'i32' or 'bytes'.
 *
 * @param {[string, number | number[]][]} fields
 * @returns {Uint8Array}
 */
export function pack(fields){
    const size = fields.reduce((sum, [kind, value])=>sum + (kind === 'bytes'
        ? /** @type {number[]} */ (value).length : kind === 'u8' ? 1
            : kind === 'u16' || kind === 'i16' ? 2 : 4), 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let at = 0;
    for (const [kind, value] of fields)
    {
        const n = /** @type {number} */ (value);
        if (kind === 'bytes')
        {
            bytes.set(/** @type {number[]} */ (value), at);
            at += /** @type {number[]} */ (value).length;
        }
        else if (kind === 'u8')
        {
            view.setUint8(at++, n);
        }
        else if (kind === 'u16' || kind === 'i16')
        {
            view.setUint16(at, n & 0xffff);
            at += 2;
        }
        else
        {
            view.setUint32(at, n >>> 0);
            at += 4;
        }
    }
    return bytes;
}

/**
 * A 'name' table of Windows Unicode US English records.
 *
 * @param {[number, string][]} names  [name id, text]
 * @returns {Uint8Array}
 */
export function nameTable(names){
    const records = names.map(([id, text])=>({ id, units: [...text].map(c=>c.charCodeAt(0)) }));
    const storage = 6 + records.length * 12;
    /** @type {[string, number | number[]][]} */
    const fields = [['u16', 0], ['u16', records.length], ['u16', storage]];
    let offset = 0;
    for (const { id, units } of records)
    {
        fields.push(['u16', 3], ['u16', 1], ['u16', 0x409], ['u16', id], ['u16', units.length * 2],
            ['u16', offset]);
        offset += units.length * 2;
    }
    for (const { units } of records)
    {
        fields.push(['bytes', units.flatMap(u=>[u >> 8, u & 0xff])]);
    }
    return pack(fields);
}
