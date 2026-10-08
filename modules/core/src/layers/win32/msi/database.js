/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An installer database: the tables a package is, read out of its compound
 * file.
 *
 * Every table is a stream of the root storage, its name packed into the
 * private-use code points the format reserves (two name characters to one,
 * behind a marker that says "table"), and its rows are stored a column at a
 * time: every row's first column, then every row's second. Strings are not in
 * the rows at all but in one pool shared by every table -- `_StringPool`
 * gives each string's length, `_StringData` holds them end to end in the
 * database's code page -- and a row holds the string's number. Integers are
 * stored with their sign bit flipped so that zero can mean null. `_Tables`
 * lists the tables and `_Columns` their columns, and both are described by
 * the format itself rather than by a row anywhere.
 *
 * A database is read whole when it is opened, but for its streams: a setup
 * asks for its tables over and over and for a cabinet's bytes once, and the
 * tables of even a large package are small beside the files it carries.
 * What a session changes -- temporary rows, temporary tables, properties --
 * lives here in memory with the rest, and is never written back unless the
 * database was opened to be written.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

/** The bits of a column's type. */
export const MSITYPE = Object.freeze({
    SIZE: 0x00ff, VALID: 0x0100, LOCALIZABLE: 0x0200, STRING: 0x0800, NULLABLE: 0x1000,
    KEY: 0x2000, TEMPORARY: 0x4000, UNKNOWN: 0x8000,
});

/** The first code point of a packed name, and the marker a table's stream starts with. */
const PACKED_BASE = 0x3800;
const SINGLE_BASE = 0x4800;
const TABLE_MARKER = 0x4840;
const PACKED_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._';

/** A stream name is at most this many characters in the directory. */
const MAX_STREAM_NAME = 31;

/**
 * A column as the database describes it.
 *
 * @typedef {Object} Column
 * @property {string} table
 * @property {number} number   From one.
 * @property {string} name
 * @property {number} type     MSITYPE bits and a size.
 */

/** @typedef {(string | number | null)[]} Row */

/**
 * @typedef {Object} Table
 * @property {string} name
 * @property {Column[]} columns
 * @property {Row[]} rows
 * @property {boolean} temporary   Made by a session and never saved.
 * @property {Set<Row>} temporaryRows
 * @property {number} hold         CREATE/ALTER ... HOLD count of a temporary table.
 */

/** @param {number} type */
export const isBinaryType = type=>(type & ~MSITYPE.NULLABLE) === (MSITYPE.STRING | MSITYPE.VALID);
/** @param {number} type */
export const isStringType = type=>(type & MSITYPE.STRING) !== 0 && !isBinaryType(type);
/** @param {Column} column */
export const isKey = column=>(column.type & MSITYPE.KEY) !== 0;

/**
 * A stream's directory name as the database means it: packed pairs and
 * singles spelled out, and whether the marker says it is a table.
 *
 * @param {string} raw @returns {{ name: string, table: boolean }}
 */
export function decodeStreamName(raw){
    let name = '';
    let table = false;
    for (const character of raw)
    {
        const code = character.charCodeAt(0);
        if (code === TABLE_MARKER && name === '' && !table)
        {
            table = true;
            continue;
        }
        if (code >= SINGLE_BASE && code < TABLE_MARKER)
        {
            name += PACKED_ALPHABET[code - SINGLE_BASE];
        }
        else if (code >= PACKED_BASE && code < SINGLE_BASE)
        {
            const pair = code - PACKED_BASE;
            name += PACKED_ALPHABET[pair & 0x3f] + PACKED_ALPHABET[pair >> 6 & 0x3f];
        }
        else
        {
            name += character;
        }
    }
    return { name, table };
}

/**
 * The directory name a stream is stored under: characters of the packed
 * alphabet two to a code point, anything else as it is.
 *
 * @param {string} name @param {boolean} table @returns {string | null}
 *          null when the packed name would not fit in a directory entry
 */
export function encodeStreamName(name, table){
    let out = table ? String.fromCharCode(TABLE_MARKER) : '';
    for (let at = 0; at < name.length; at++)
    {
        const first = PACKED_ALPHABET.indexOf(name[at]);
        if (first < 0)
        {
            out += name[at];
            continue;
        }
        const second = at + 1 < name.length ? PACKED_ALPHABET.indexOf(name[at + 1]) : -1;
        if (second >= 0)
        {
            out += String.fromCharCode(PACKED_BASE + first + (second << 6));
            at++;
        }
        else
        {
            out += String.fromCharCode(SINGLE_BASE + first);
        }
    }
    return out.length > MAX_STREAM_NAME ? null : out;
}

/**
 * Text of a code page: the system's ANSI page for 0, and otherwise the page
 * the Encoding standard names, which covers every page a package declares.
 *
 * @param {number} codepage @returns {(bytes: Uint8Array) => string}
 */
export function decoderFor(codepage){
    if (codepage === 0 || codepage === 1252)
    {
        return decodeAnsi;
    }
    try
    {
        const decoder = new TextDecoder(encodingLabel(codepage));
        return bytes=>decoder.decode(bytes);
    }
    catch {
        return decodeAnsi;
    }
}

/**
 * The Encoding standard's label for a Windows code page: most are
 * "windows-N", but the Japanese and Traditional Chinese pages are known by
 * their own names there.
 *
 * @param {number} codepage
 */
const encodingLabel = codepage=>(codepage === 65001 ? 'utf-8' : codepage === 932 ? 'shift_jis'
    : codepage === 950 ? 'big5' : `windows-${codepage}`);

/**
 * Text into a code page, the inverse of `decoderFor`: a character the page
 * cannot hold becomes "?", as WideCharToMultiByte's default character.
 *
 * The Encoding standard decodes every page but encodes only UTF-8, so a
 * page's table is built once by decoding each of its byte sequences -- every
 * byte, and every lead byte with every trail byte where the page has them.
 *
 * @param {number} codepage @returns {(text: string) => Uint8Array}
 */
export function encoderFor(codepage){
    if (codepage === 0 || codepage === 1252)
    {
        return encodeAnsi;
    }
    if (codepage === 65001)
    {
        const encoder = new TextEncoder();
        return text=>encoder.encode(text);
    }
    let table = encoderTables.get(codepage);
    if (!table)
    {
        let decoder;
        try
        {
            decoder = new TextDecoder(encodingLabel(codepage), { fatal: true });
        }
        catch {
            return encodeAnsi;
        }
        /** @type {Map<string, number[]>} */
        const built = new Map();
        /** @param {number[]} sequence */
        const learn = sequence=>{
            try
            {
                const text = decoder.decode(Uint8Array.from(sequence));
                if (text.length > 0 && !built.has(text))
                {
                    built.set(text, sequence);
                }
                return true;
            }
            catch {
                return false;
            }
        };
        for (let lead = 0; lead < 0x100; lead++)
        {
            if (!learn([lead]) && lead >= 0x80)
            {
                for (let trail = 0x40; trail < 0x100; trail++)
                {
                    learn([lead, trail]);
                }
            }
        }
        table = built;
        encoderTables.set(codepage, table);
    }
    const known = table;
    return text=>{
        /** @type {number[]} */
        const out = [];
        for (const character of text)
        {
            out.push(...(known.get(character) ?? [0x3f]));
        }
        return Uint8Array.from(out);
    };
}

/** @type {Map<number, Map<string, number[]>>} */
const encoderTables = new Map();

/** The tables the format describes itself. */
export const SYSTEM_COLUMNS = Object.freeze({
    _Tables: [{ name: 'Name', type: MSITYPE.VALID | MSITYPE.STRING | MSITYPE.KEY | 64 }],
    _Columns: [
        { name: 'Table', type: MSITYPE.VALID | MSITYPE.STRING | MSITYPE.KEY | 64 },
        { name: 'Number', type: MSITYPE.VALID | MSITYPE.KEY | 2 },
        { name: 'Name', type: MSITYPE.VALID | MSITYPE.STRING | 64 },
        { name: 'Type', type: MSITYPE.VALID | 2 },
    ],
});

/**
 * The string pool: number to string, string 0 being null.
 *
 * @param {Uint8Array} pool @param {Uint8Array} data
 * @returns {{ strings: (string | null)[], codepage: number, longRefs: boolean }}
 */
export function readStringPool(pool, data){
    const word = (/** @type {number} */ index)=>pool[index * 2] | pool[index * 2 + 1] << 8;
    const entries = Math.floor(pool.length / 4);
    // The first entry is no string: the code page, and in the top bit of its
    // high word whether a reference takes three bytes rather than two.
    const longRefs = entries > 0 && (word(1) & 0x8000) !== 0;
    const codepage = entries > 0 ? (word(0) | (word(1) & 0x7fff) << 16) >>> 0 : 0;
    const decode = decoderFor(codepage);
    /** @type {(string | null)[]} */
    const strings = [null];
    let offset = 0;
    for (let index = 1; index < entries;)
    {
        const length = word(index * 2);
        const references = word(index * 2 + 1);
        if (length === 0 && references === 0)
        {
            // An unused number: it still counts.
            strings.push(null);
            index++;
            continue;
        }
        let size = length;
        if (length === 0)
        {
            // Longer than a word can say: the next entry holds the length,
            // low word then high, and the pair is one string.
            size = (word((index + 1) * 2) | word((index + 1) * 2 + 1) << 16) >>> 0;
            index += 2;
        }
        else
        {
            index++;
        }
        if (offset + size > data.length)
        {
            break;
        }
        strings.push(decode(data.subarray(offset, offset + size)));
        offset += size;
    }
    return { strings, codepage, longRefs };
}

/**
 * A string pool written out, the inverse of `readStringPool`: each string
 * numbered by its place in `strings` (0 being null and never written), with
 * the reference count `refs` gives it.
 *
 * @param {(string | null)[]} strings @param {number[]} refs @param {number} codepage
 * @returns {{ pool: Uint8Array, data: Uint8Array, longRefs: boolean }}
 */
export function writeStringPool(strings, refs, codepage){
    const encode = encoderFor(codepage);
    // A number past what two bytes hold makes every reference three bytes.
    const longRefs = strings.length - 1 > 0xffff;
    /** @type {number[]} */
    const words = [codepage & 0xffff, (codepage >>> 16 & 0x7fff) | (longRefs ? 0x8000 : 0)];
    /** @type {Uint8Array[]} */
    const chunks = [];
    let size = 0;
    for (let id = 1; id < strings.length; id++)
    {
        const text = strings[id];
        const bytes = text ? encode(text) : new Uint8Array(0);
        if (bytes.length === 0)
        {
            words.push(0, 0);
            continue;
        }
        const count = Math.min(refs[id] ?? 1, 0xffff);
        if (bytes.length > 0xffff)
        {
            words.push(0, count, bytes.length & 0xffff, bytes.length >>> 16);
        }
        else
        {
            words.push(bytes.length, count);
        }
        chunks.push(bytes);
        size += bytes.length;
    }
    const data = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks)
    {
        data.set(chunk, at);
        at += chunk.length;
    }
    const pool = new Uint8Array(words.length * 2);
    words.forEach((word, index)=>{
        pool[index * 2] = word & 0xff;
        pool[index * 2 + 1] = word >>> 8;
    });
    return { pool, data, longRefs };
}

/**
 * The bytes one value of a column takes in a stored row: a string's number in
 * two bytes or, in a pool that says so, three; a stream's presence in two;
 * an integer in two or four as its size says.
 *
 * @param {number} type @param {boolean} longRefs
 */
export const columnWidth = (type, longRefs)=>(isBinaryType(type) ? 2
    : (type & MSITYPE.STRING) !== 0 ? (longRefs ? 3 : 2) : (type & MSITYPE.SIZE) <= 2 ? 2 : 4);

/**
 * A table's rows out of its stream: column by column, each column's width
 * fixed by its type.
 *
 * @param {Uint8Array} bytes @param {{ type: number }[]} columns
 * @param {(string | null)[]} strings @param {boolean} longRefs
 * @param {string} tableName  For a binary column, which names its stream.
 * @returns {Row[]}
 */
export function readTableRows(bytes, columns, strings, longRefs, tableName){
    /** @param {number} type */
    const widthOf = type=>columnWidth(type, longRefs);
    let rowSize = columns.reduce((sum, column)=>sum + widthOf(column.type), 0);
    let widths = columns.map(column=>widthOf(column.type));
    if (rowSize === 0)
    {
        return [];
    }
    // A transform can leave a table written with two-byte references in a
    // database whose pool says three.
    if (bytes.length % rowSize !== 0 && longRefs)
    {
        const narrow = columns.map(column=>(isStringType(column.type) ? 2 : widthOf(column.type)));
        const narrowSize = narrow.reduce((sum, width)=>sum + width, 0);
        if (bytes.length % narrowSize === 0)
        {
            widths = narrow;
            rowSize = narrowSize;
        }
    }
    const count = Math.floor(bytes.length / rowSize);
    /** @type {Row[]} */
    const rows = Array.from({ length: count }, ()=>new Array(columns.length).fill(null));
    let at = 0;
    columns.forEach((column, index)=>{
        const width = widths[index];
        for (let row = 0; row < count; row++, at += width)
        {
            const raw = width === 2 ? bytes[at] | bytes[at + 1] << 8
                : width === 3 ? bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
                    : (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
                        | bytes[at + 3] << 24) >>> 0;
            if (raw === 0)
            {
                continue;
            }
            if (isBinaryType(column.type))
            {
                // The stream is named for the row's keys, which are not all
                // read yet; marked present, named once the row is whole.
                rows[row][index] = '';
            }
            else if ((column.type & MSITYPE.STRING) !== 0)
            {
                rows[row][index] = strings[raw] ?? null;
            }
            else
            {
                rows[row][index] = width === 2 ? raw - 0x8000 : (raw ^ 0x80000000) | 0;
            }
        }
    });
    const binary = columns.map((column, index)=>(isBinaryType(column.type) ? index : -1))
        .filter(index=>index >= 0);
    if (binary.length > 0)
    {
        for (const row of rows)
        {
            const name = rowStreamName(tableName, columns, row);
            for (const index of binary)
            {
                if (row[index] === '')
                {
                    row[index] = name;
                }
            }
        }
    }
    return rows;
}

/**
 * The stream a binary column of a row is kept in: the table's name and the
 * row's keys, joined by dots.
 *
 * @param {string} tableName @param {{ type: number }[]} columns
 * @param {readonly unknown[]} row
 */
export const rowStreamName = (tableName, columns, row)=>[tableName, ...columns
    .flatMap((column, index)=>((column.type & MSITYPE.KEY) !== 0 ? [String(row[index] ?? '')]
        : []))].join('.');

/**
 * A table's stream, the inverse of `readTableRows`: column by column, a string
 * as its number, an integer biased so that zero is null, a binary column as
 * whether the row has a stream.
 *
 * @param {Row[]} rows @param {{ type: number }[]} columns
 * @param {(text: string) => number} idOf  A string's number in the pool being written.
 * @param {boolean} longRefs
 * @returns {Uint8Array}
 */
export function writeTableRows(rows, columns, idOf, longRefs){
    const widths = columns.map(column=>columnWidth(column.type, longRefs));
    const out = new Uint8Array(rows.length * widths.reduce((sum, width)=>sum + width, 0));
    let at = 0;
    columns.forEach((column, index)=>{
        const width = widths[index];
        for (const row of rows)
        {
            const value = row[index] ?? null;
            const raw = value === null ? 0
                : isBinaryType(column.type) ? 1
                    : (column.type & MSITYPE.STRING) !== 0 ? (value === '' ? 0 : idOf(`${value}`))
                        : width === 2 ? Number(value) + 0x8000 & 0xffff
                            : (Number(value) ^ 0x80000000) >>> 0;
            for (let byte = 0; byte < width; byte++)
            {
                out[at++] = raw >>> byte * 8 & 0xff;
            }
        }
    });
    return out;
}

/**
 * What of a table is saved: its rows but the temporary ones, in its columns
 * but the temporary ones.
 *
 * @param {Table} table @returns {{ columns: Column[], rows: Row[] }}
 */
export const persistentPart = table=>{
    const kept = table.columns.flatMap((column, index)=>
        ((column.type & MSITYPE.TEMPORARY) === 0 ? [index] : []));
    return {
        columns: kept.map(index=>table.columns[index]),
        rows: table.rows.filter(row=>!table.temporaryRows.has(row))
            .map(row=>kept.map(index=>row[index] ?? null)),
    };
};

/**
 * The tables a database saves, but `_Tables` and `_Columns`, which describe
 * the others rather than being listed among them.
 *
 * @param {Database} db @returns {Map<string, Table>}
 */
export const persistentTables = db=>new Map([...db.tables].filter(([name, table])=>
    !table.temporary && name !== '_Tables' && name !== '_Columns'));

/**
 * @typedef {Object} Database
 * @property {number} codepage
 * @property {Map<string, Table>} tables   By name, case-sensitive as the format is.
 * @property {(name: string) => Table | null} table
 * @property {(name: string) => boolean} hasStream
 * @property {(name: string) => Promise<Uint8Array | null>} readStream
 * @property {(name: string, offset: number, length: number) => Promise<Uint8Array | null>}
 *           readStreamRange
 * @property {(name: string) => number | null} streamSize
 * @property {(name: string, bytes: Uint8Array | null) => void} writeStream
 *           Replaces, adds or (with null) removes a stream, in memory.
 * @property {() => string[]} streamNames   Every stream that is not a table's.
 * @property {() => Uint8Array | null} summaryStream
 * @property {(bytes: Uint8Array | null) => void} setSummaryStream
 *           Replaces the summary information stream, in memory.
 * @property {(text: string) => number} stringId
 *           The string's number in the pool, a new one past the last for a
 *           string the pool does not hold: what a stored table orders by.
 * @property {boolean} readOnly  A session's database: only temporary rows change.
 * @property {import('./compound.js').CompoundFile | null} [compound]
 *           The file it was read from, for the storages a package embeds
 *           (transforms named ":name"); none for a database made in memory.
 */

/**
 * Opens an installer database out of a compound file.
 *
 * @param {import('./compound.js').CompoundFile} compound
 * @returns {Promise<Database>}
 */
export async function openDatabase(compound){
    /** @type {Map<string, import('./compound.js').CompoundNode>} */
    const tableStreams = new Map();
    /** @type {Map<string, import('./compound.js').CompoundNode>} */
    const streams = new Map();
    let summary = null;
    for (const node of compound.root.children.values())
    {
        if (node.kind === 'storage')
        {
            continue;
        }
        if (node.name === '\u0005SummaryInformation')
        {
            summary = node;
            continue;
        }
        const { name, table } = decodeStreamName(node.name);
        (table ? tableStreams : streams).set(name, node);
    }

    /** @param {string} name */
    const tableBytes = async name=>{
        const node = tableStreams.get(name);
        return node ? compound.readAll(node) : new Uint8Array(0);
    };
    const { strings, codepage, longRefs } = readStringPool(
        await tableBytes('_StringPool'), await tableBytes('_StringData'));

    /** @param {string} table @param {{ name: string, type: number }[]} columns */
    const describe = (table, columns)=>columns.map((column, index)=>({
        table, number: index + 1, name: column.name, type: column.type,
    }));

    /** @type {Map<string, Table>} */
    const tables = new Map();
    /** @param {string} name @param {Column[]} columns @param {Row[]} rows */
    const add = (name, columns, rows)=>tables.set(name, {
        name, columns, rows, temporary: false, temporaryRows: new Set(), hold: 0,
    });

    const tableNames = readTableRows(await tableBytes('_Tables'), SYSTEM_COLUMNS._Tables,
        strings, longRefs, '_Tables').map(row=>String(row[0]));
    const columnRows = readTableRows(await tableBytes('_Columns'), SYSTEM_COLUMNS._Columns,
        strings, longRefs, '_Columns');
    for (const name of tableNames)
    {
        const columns = columnRows.filter(row=>row[0] === name)
            .sort((left, right)=>Number(left[1]) - Number(right[1]))
            .map(row=>({ table: name, number: Number(row[1]), name: String(row[2]),
                type: Number(row[3]) & 0xffff }));
        add(name, columns, readTableRows(await tableBytes(name), columns, strings, longRefs, name));
    }
    add('_Tables', describe('_Tables', SYSTEM_COLUMNS._Tables), tableNames.map(name=>[name]));
    add('_Columns', describe('_Columns', SYSTEM_COLUMNS._Columns), columnRows);

    /** @type {Map<string, Uint8Array | null>} */
    const written = new Map();
    const stringId = poolIds(strings);
    const summaryNode = summary;
    let summaryBytes = summaryNode ? await compound.readAll(summaryNode) : null;

    return {
        codepage,
        tables,
        table: name=>tables.get(name) ?? null,
        hasStream: name=>(written.has(name) ? written.get(name) !== null : streams.has(name)),
        streamSize: name=>{
            if (written.has(name))
            {
                return written.get(name)?.length ?? null;
            }
            return streams.get(name)?.size ?? null;
        },
        readStream: async name=>{
            if (written.has(name))
            {
                return written.get(name) ?? null;
            }
            const node = streams.get(name);
            return node ? compound.readAll(node) : null;
        },
        readStreamRange: async(name, offset, length)=>{
            if (written.has(name))
            {
                return written.get(name)?.subarray(offset, offset + length) ?? null;
            }
            const node = streams.get(name);
            return node ? compound.read(node, offset, length) : null;
        },
        writeStream: (name, bytes)=>{
            written.set(name, bytes);
        },
        streamNames: ()=>{
            const names = new Set(streams.keys());
            for (const [name, bytes] of written)
            {
                if (bytes === null)
                {
                    names.delete(name);
                }
                else
                {
                    names.add(name);
                }
            }
            return [...names];
        },
        summaryStream: ()=>summaryBytes,
        setSummaryStream: bytes=>{
            summaryBytes = bytes;
        },
        stringId,
        readOnly: false,
        compound,
    };
}

/**
 * Numbers for strings: each string's first place in the pool, and the next
 * free number for one it does not hold, kept from then on.
 *
 * @param {(string | null)[]} strings @returns {(text: string) => number}
 */
function poolIds(strings){
    /** @type {Map<string, number>} */
    const ids = new Map();
    strings.forEach((text, id)=>{
        if (text !== null && !ids.has(text))
        {
            ids.set(text, id);
        }
    });
    let next = strings.length;
    return text=>{
        let id = ids.get(text);
        if (id === undefined)
        {
            id = next++;
            ids.set(text, id);
        }
        return id;
    };
}

/**
 * An empty database, for MsiOpenDatabase with MSIDBOPEN_CREATE: the system
 * tables and nothing else.
 *
 * @returns {Database}
 */
export function createEmptyDatabase(){
    /** @type {Map<string, Table>} */
    const tables = new Map();
    for (const [name, columns] of Object.entries(SYSTEM_COLUMNS))
    {
        tables.set(name, {
            name,
            columns: columns.map((column, index)=>({ table: name, number: index + 1, ...column })),
            rows: [], temporary: false, temporaryRows: new Set(), hold: 0,
        });
    }
    /** @type {Map<string, Uint8Array | null>} */
    const written = new Map();
    /** @type {Uint8Array | null} */
    let summaryBytes = null;
    return {
        codepage: 0,
        tables,
        table: name=>tables.get(name) ?? null,
        hasStream: name=>(written.get(name) ?? null) !== null,
        streamSize: name=>written.get(name)?.length ?? null,
        readStream: async name=>written.get(name) ?? null,
        readStreamRange: async(name, offset, length)=>
            written.get(name)?.subarray(offset, offset + length) ?? null,
        writeStream: (name, bytes)=>{
            written.set(name, bytes);
        },
        streamNames: ()=>[...written].filter(([, bytes])=>bytes !== null).map(([name])=>name),
        summaryStream: ()=>summaryBytes,
        setSummaryStream: bytes=>{
            summaryBytes = bytes;
        },
        stringId: poolIds([null]),
        readOnly: false,
    };
}
