/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A managed image read as the runtime reads it (ECMA-335, partition II): the
 * CLI header the PE's fifteenth data directory points at, the metadata root
 * with its runtime version, and from the `#~` stream the Assembly table's one
 * row and the File table's names. One reader for every library that asks
 * what an assembly is: mscoree's GetVersionFromFile and fusion's cache, which
 * files an assembly by its name, version, culture and key.
 */

/** COMIMAGE_FLAGS: IL only, needs a 32-bit process, prefers one. */
export const COMIMAGE_FLAGS_ILONLY = 0x1;
export const COMIMAGE_FLAGS_32BITREQUIRED = 0x2;
export const COMIMAGE_FLAGS_32BITPREFERRED = 0x20000;

/** The metadata tables this reader names. */
const TABLE = Object.freeze({ ASSEMBLY: 0x20, FILE: 0x26 });

/**
 * The coded indexes (II.24.2.6): how many tag bits, and the tables a value
 * can point into, whose largest row count decides the column's width.
 */
const CODED = Object.freeze({
    typeDefOrRef: [2, [0x02, 0x01, 0x1b]],
    hasConstant: [2, [0x04, 0x08, 0x17]],
    hasCustomAttribute: [5, [0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17,
        0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b]],
    hasFieldMarshal: [1, [0x04, 0x08]],
    hasDeclSecurity: [2, [0x02, 0x06, 0x20]],
    memberRefParent: [3, [0x02, 0x01, 0x1a, 0x06, 0x1b]],
    hasSemantics: [1, [0x14, 0x17]],
    methodDefOrRef: [1, [0x06, 0x0a]],
    memberForwarded: [1, [0x04, 0x06]],
    implementation: [2, [0x26, 0x23, 0x27]],
    customAttributeType: [3, [0x06, 0x0a]],
    resolutionScope: [2, [0x00, 0x1a, 0x23, 0x01]],
});

/**
 * The columns of every table up to File (II.22), in order: a number is a
 * fixed width in bytes, 'S', 'G' and 'B' an index into the strings, GUID and
 * blob heaps, `t:` an index into one table, and a name a coded index.
 *
 * @type {Record<number, (number | 'S' | 'G' | 'B' | { t: number } | keyof typeof CODED)[]>}
 */
const COLUMNS = {
    0x00: [2, 'S', 'G', 'G', 'G'],
    0x01: ['resolutionScope', 'S', 'S'],
    0x02: [4, 'S', 'S', 'typeDefOrRef', { t: 0x04 }, { t: 0x06 }],
    0x03: [{ t: 0x04 }],
    0x04: [2, 'S', 'B'],
    0x05: [{ t: 0x06 }],
    0x06: [4, 2, 2, 'S', 'B', { t: 0x08 }],
    0x07: [{ t: 0x08 }],
    0x08: [2, 2, 'S'],
    0x09: [{ t: 0x02 }, 'typeDefOrRef'],
    0x0a: ['memberRefParent', 'S', 'B'],
    0x0b: [1, 1, 'hasConstant', 'B'],
    0x0c: ['hasCustomAttribute', 'customAttributeType', 'B'],
    0x0d: ['hasFieldMarshal', 'B'],
    0x0e: [2, 'hasDeclSecurity', 'B'],
    0x0f: [2, 4, { t: 0x02 }],
    0x10: [4, { t: 0x04 }],
    0x11: ['B'],
    0x12: [{ t: 0x02 }, { t: 0x14 }],
    0x13: [{ t: 0x14 }],
    0x14: [2, 'S', 'typeDefOrRef'],
    0x15: [{ t: 0x02 }, { t: 0x17 }],
    0x16: [{ t: 0x17 }],
    0x17: [2, 'S', 'B'],
    0x18: [2, { t: 0x06 }, 'hasSemantics'],
    0x19: [{ t: 0x02 }, 'methodDefOrRef', 'methodDefOrRef'],
    0x1a: ['S'],
    0x1b: ['B'],
    0x1c: [2, 'memberForwarded', 'S', { t: 0x1a }],
    0x1d: [4, { t: 0x04 }],
    0x1e: [4, 4],
    0x1f: [4],
    0x20: [4, 2, 2, 2, 2, 4, 'B', 'S', 'S'],
    0x21: [4],
    0x22: [4, 4, 4],
    0x23: [2, 2, 2, 2, 4, 'B', 'S', 'S', 'B'],
    0x24: [4, { t: 0x23 }],
    0x25: [4, 4, 4, { t: 0x23 }],
    0x26: [4, 'S', 'B'],
};

/**
 * @typedef {Object} AssemblyIdentity  The Assembly table's row.
 * @property {string} name
 * @property {[number, number, number, number]} version
 * @property {string} culture  Empty for a neutral one.
 * @property {Uint8Array} publicKey  Empty for an assembly without a strong name.
 * @property {number} flags
 * @property {number} hashAlgorithm
 */

/**
 * @typedef {Object} ClrImage
 * @property {string} version   The runtime the metadata was built for, "v4.0.30319".
 * @property {number} flags     The CLI header's COMIMAGE_FLAGS.
 * @property {number} machine   The COFF header's machine.
 * @property {AssemblyIdentity | null} assembly  Null for a module that is no assembly.
 * @property {string[]} files   The other files of the assembly (its File table).
 */

/**
 * @param {Uint8Array} file
 * @returns {ClrImage | null}  null for a file that is not a managed image
 */
export function readClrImage(file){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const inside = (/** @type {number} */ at, /** @type {number} */ length)=>
        at >= 0 && at + length <= file.length;
    if (!inside(0, 0x40) || view.getUint16(0, true) !== 0x5a4d)
    {
        return null;
    }
    const pe = view.getUint32(0x3c, true);
    if (!inside(pe, 24) || view.getUint32(pe, true) !== 0x4550)
    {
        return null;
    }
    const machine = view.getUint16(pe + 4, true);
    const sections = view.getUint16(pe + 6, true);
    const optional = pe + 24;
    const optionalSize = view.getUint16(pe + 20, true);
    if (!inside(optional, 2))
    {
        return null;
    }
    const wide = view.getUint16(optional, true) === 0x20b;
    // Data directory 14, the CLI header.
    const directory = optional + (wide ? 112 : 96) + 14 * 8;
    if (directory + 8 > optional + optionalSize || !inside(directory, 8))
    {
        return null;
    }
    /** @param {number} rva */
    const offsetOf = rva=>{
        for (let i = 0; i < sections; i++)
        {
            const at = optional + optionalSize + i * 40;
            if (!inside(at, 40))
            {
                return -1;
            }
            const address = view.getUint32(at + 12, true);
            const size = Math.max(view.getUint32(at + 8, true), view.getUint32(at + 16, true));
            if (rva >= address && rva < address + size)
            {
                return rva - address + view.getUint32(at + 20, true);
            }
        }
        return -1;
    };
    const cli = offsetOf(view.getUint32(directory, true));
    if (!inside(cli, 20))
    {
        return null;
    }
    const root = offsetOf(view.getUint32(cli + 8, true));
    if (!inside(root, 16) || view.getUint32(root, true) !== 0x424a5342)
    {
        return null;
    }
    const length = view.getUint32(root + 12, true);
    const versionBytes = file.subarray(root + 16, Math.min(file.length, root + 16 + length));
    const end = versionBytes.indexOf(0);
    const version = new TextDecoder().decode(end < 0 ? versionBytes
        : versionBytes.subarray(0, end));
    const flags = view.getUint32(cli + 16, true);
    const tables = readTables(file, view, root, root + 16 + ((length + 3) & ~3));
    return { version, flags, machine, assembly: tables?.assembly ?? null,
        files: tables?.files ?? [] };
}

/**
 * The Assembly row and the File names out of the root's streams; null when
 * the root has no `#~` stream or it runs past the file.
 *
 * @param {Uint8Array} file @param {DataView} view
 * @param {number} root @param {number} after  where the stream headers begin
 */
function readTables(file, view, root, after){
    if (after + 4 > file.length)
    {
        return null;
    }
    const count = view.getUint16(after + 2, true);
    /** @type {Map<string, { at: number, size: number }>} */
    const streams = new Map();
    let at = after + 4;
    for (let i = 0; i < count && at + 8 < file.length; i++)
    {
        const offset = view.getUint32(at, true);
        const size = view.getUint32(at + 4, true);
        const nameEnd = file.indexOf(0, at + 8);
        if (nameEnd < 0)
        {
            return null;
        }
        const name = new TextDecoder().decode(file.subarray(at + 8, nameEnd));
        streams.set(name, { at: root + offset, size });
        at = at + 8 + ((nameEnd - (at + 8) + 4) & ~3);
    }
    const stream = streams.get('#~') ?? streams.get('#-');
    if (!stream || stream.at + 24 > file.length)
    {
        return null;
    }
    const heapSizes = file[stream.at + 6];
    const valid = view.getBigUint64(stream.at + 8, true);
    /** @type {number[]} */
    const rows = new Array(64).fill(0);
    let cursor = stream.at + 24;
    for (let table = 0; table < 64; table++)
    {
        if ((valid >> BigInt(table)) & 1n)
        {
            if (cursor + 4 > file.length)
            {
                return null;
            }
            rows[table] = view.getUint32(cursor, true);
            cursor += 4;
        }
    }
    // The uncompressed stream's extra word.
    if (heapSizes & 0x40)
    {
        cursor += 4;
    }
    const heapWidth = (/** @type {number} */ bit)=>((heapSizes & bit) !== 0 ? 4 : 2);
    /** @type {Record<string, number>} */
    const HEAP_BITS = { S: 1, G: 2, B: 4 };
    /**
     * @param {number | 'S' | 'G' | 'B' | { t: number } | keyof typeof CODED} column
     * @returns {number}
     */
    const widthOf = column=>{
        if (typeof column === 'number')
        {
            return column;
        }
        if (typeof column === 'object')
        {
            return rows[column.t] < 0x10000 ? 2 : 4;
        }
        if (column in HEAP_BITS)
        {
            return heapWidth(HEAP_BITS[column]);
        }
        const [bits, targets] = /** @type {[number, number[]]} */ (
            CODED[/** @type {keyof typeof CODED} */ (column)]);
        const most = Math.max(...targets.map(table=>rows[table]));
        return most < 2 ** (16 - bits) ? 2 : 4;
    };
    /** @type {Map<number, { at: number, width: number, columns: number[] }>} */
    const layout = new Map();
    for (let table = 0; table <= TABLE.FILE; table++)
    {
        const columns = (COLUMNS[table] ?? []).map(widthOf);
        const width = columns.reduce((sum, each)=>sum + each, 0);
        layout.set(table, { at: cursor, width, columns });
        cursor += width * rows[table];
    }
    /** @param {number} table @param {number} row */
    const cells = (table, row)=>{
        const { at: start, width, columns } = /** @type {{ at: number, width: number,
            columns: number[] }} */ (layout.get(table));
        let place = start + row * width;
        return columns.map((/** @type {number} */ size)=>{
            const value = size === 1 ? file[place] : size === 2 ? view.getUint16(place, true)
                : view.getUint32(place, true);
            place += size;
            return value;
        });
    };
    const strings = streams.get('#Strings');
    const blobs = streams.get('#Blob');
    /** @param {number} index */
    const stringAt = index=>{
        if (!strings || index >= strings.size)
        {
            return '';
        }
        const begin = strings.at + index;
        const stop = file.indexOf(0, begin);
        return new TextDecoder().decode(file.subarray(begin, stop < 0 ? file.length : stop));
    };
    /** @param {number} index */
    const blobAt = index=>{
        if (!blobs || index >= blobs.size || index === 0)
        {
            return new Uint8Array(0);
        }
        let place = blobs.at + index;
        const first = file[place];
        let size;
        if ((first & 0x80) === 0)
        {
            size = first;
            place += 1;
        }
        else if ((first & 0xc0) === 0x80)
        {
            size = (first & 0x3f) << 8 | file[place + 1];
            place += 2;
        }
        else
        {
            size = ((first & 0x1f) << 24 | file[place + 1] << 16 | file[place + 2] << 8
                | file[place + 3]) >>> 0;
            place += 4;
        }
        return file.slice(place, Math.min(file.length, place + size));
    };
    const fileTable = layout.get(TABLE.FILE);
    if (!fileTable || fileTable.at + fileTable.width * rows[TABLE.FILE] > file.length)
    {
        return null;
    }
    /** @type {AssemblyIdentity | null} */
    let assembly = null;
    if (rows[TABLE.ASSEMBLY] > 0)
    {
        const [hashAlgorithm, major, minor, build, revision, assemblyFlags, key, name, culture]
            = cells(TABLE.ASSEMBLY, 0);
        assembly = { name: stringAt(name), version: [major, minor, build, revision],
            culture: stringAt(culture), publicKey: blobAt(key), flags: assemblyFlags,
            hashAlgorithm };
    }
    const files = Array.from({ length: rows[TABLE.FILE] },
        (_, row)=>stringAt(cells(TABLE.FILE, row)[1]));
    return { assembly, files };
}
