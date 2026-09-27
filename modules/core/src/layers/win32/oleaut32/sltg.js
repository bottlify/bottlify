/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A reader for the SLTG type-library format: the older layout MkTypLib and the
 * 16-bit tools wrote, and the one many a 32-bit program still carries as its
 * TYPELIB resource. It reads into the same description the MSFT reader makes
 * (`typelib.js`), so everything that lays a library out for a program -- the
 * ITypeLib and ITypeInfo objects, registration, the dispatch of calls --
 * does not know which format a library came in.
 *
 * The file is a header, a directory of blocks chained by index, a small
 * magic, one index string per type, and the blocks: one per type in chain
 * order, and last the library block, which holds the library's own fields,
 * one record per type (its name, GUID and kind), and the name table every
 * name in the file is an offset into. Offsets inside a type's block are from
 * the start of its members; types refer to one another through a per-type
 * table of strings, `*\R<library>*#<index>`, which is where the references of
 * this format become the description's hreftypes.
 */

import { GUID_SIZE, formatGuid } from '../ole32/guid.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { parseTypeLib } from './typelib.js';

/** 'SLTG', as the first four bytes read as a little-endian word. */
export const SLTG_MAGIC = 0x47544c53;

/**
 * A type library in either format: SLTG when it says so, MSFT otherwise.
 *
 * @param {Uint8Array} bytes
 * @returns {import('./typelib.js').TypeLibrary}
 * @throws {Error} when the bytes are neither, or are cut short.
 */
export function parseTypeLibrary(bytes){
    const magic = bytes.length >= 4
        ? new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
        : 0;
    return magic === SLTG_MAGIC ? parseSltg(bytes) : parseTypeLib(bytes);
}

const HEADER_BYTES = 0x24;
const BLOCK_ENTRY_BYTES = 8;
const DIRECTORY_MAGIC_BYTES = 13;
const INDEX_STRING_BYTES = 11;
const PAD_BYTES = 9;
const LIBRARY_MAGIC = 0x51cc;
const TYPE_HEADER_MAGIC = 0x0501;
const MEMBER_HEADER_BYTES = 9;
const OTHER_TYPE_BYTES = 36;
const IMPL_MAGIC = 0x004a;
const REF_MAGIC = 0xdf;

/** How the MSFT reader numbers a type of the library, which the rest expects. */
const TYPEINFO_BYTES = 0x64;
/** And an import. */
const IMPINFO_BYTES = 12;

const VT_PTR = 26;
const VT_SAFEARRAY = 27;
const VT_CARRAY = 28;
const VT_USERDEFINED = 29;
const VT_BSTR = 8;
const VT_I4 = 3;
const VT_INT = 22;

const TKIND_RECORD = 1;
const TKIND_INTERFACE = 3;
const TKIND_DISPATCH = 4;
const TKIND_COCLASS = 5;
const TKIND_ALIAS = 6;
const TYPEFLAG_FDUAL = 0x40;
const VAR_PERINSTANCE = 0;
const VAR_CONST = 2;
const VAR_DISPATCH = 3;
const FUNC_PUREVIRTUAL = 1;
const FUNC_STATIC = 3;
const FUNC_DISPATCH = 4;
const PARAMFLAG_FIN = 1;
const PARAMFLAG_FOUT = 2;
const PARAMFLAG_FLCID = 4;
const PARAMFLAG_FRETVAL = 8;
const PARAMFLAG_FOPT = 0x10;
const VARFLAG_FREADONLY = 1;

/** The OLE Automation library every other library imports its basics from. */
export const STDOLE_GUID = '{00020430-0000-0000-C000-000000000046}';

/**
 * Its first types, by index, which is all an SLTG reference says of a type in
 * another library: the same six open stdole32 and stdole2 alike.
 *
 * @type {readonly { name: string, kind: number, guid: string | null }[]}
 */
export const STDOLE_TYPES = Object.freeze([
    { name: 'GUID', kind: TKIND_RECORD, guid: null },
    { name: 'DISPPARAMS', kind: TKIND_RECORD, guid: null },
    { name: 'EXCEPINFO', kind: TKIND_RECORD, guid: null },
    { name: 'IUnknown', kind: TKIND_INTERFACE, guid: '{00000000-0000-0000-C000-000000000046}' },
    { name: 'IDispatch', kind: TKIND_INTERFACE, guid: '{00020400-0000-0000-C000-000000000046}' },
    { name: 'IEnumVARIANT', kind: TKIND_INTERFACE,
        guid: '{00020404-0000-0000-C000-000000000046}' },
]);

/**
 * Reads one SLTG library.
 *
 * @param {Uint8Array} bytes
 * @returns {import('./typelib.js').TypeLibrary}
 * @throws {Error} when the bytes are not an SLTG library, or do not hang together.
 */
export function parseSltg(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < HEADER_BYTES || view.getUint32(0, true) !== SLTG_MAGIC)
    {
        throw new Error('not an SLTG type library');
    }
    /** @param {number} at */
    const u16 = at=>view.getUint16(at, true);
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {number} at @param {number} length */
    const text = (at, length)=>decodeAnsi(bytes.subarray(at, at + length));
    /** A counted string: a length word, 0xffff for none, then the bytes. @param {number} at */
    const counted = at=>{
        const length = u16(at);
        return length === 0xffff
            ? { value: null, size: 2 }
            : { value: text(at + 2, length), size: length + 2 };
    };

    const blockCount = u16(4);
    const firstBlock = u16(10);
    /** @type {{ length: number, index: number, next: number }[]} */
    const entries = [];
    for (let at = HEADER_BYTES, index = 0; index < blockCount - 1; index++, at += BLOCK_ENTRY_BYTES)
    {
        entries.push({ length: u32(at), index: u16(at + 4), next: u16(at + 6) });
    }
    const directory = HEADER_BYTES + (blockCount - 1) * BLOCK_ENTRY_BYTES;
    if (text(directory + 1, 7) !== 'CompObj')
    {
        throw new Error('SLTG type library: no CompObj directory');
    }
    const firstBlockAt = directory + DIRECTORY_MAGIC_BYTES
        + (blockCount - 2) * INDEX_STRING_BYTES + PAD_BYTES;

    // The blocks in chain order; the one whose entry ends the chain is the
    // library block, and every one before it is a type.
    /** @type {{ at: number, entry: number }[]} */
    const typeBlocks = [];
    let at = firstBlockAt;
    let order = firstBlock - 1;
    for (let guard = 0; entries[order] && entries[order].next !== 0; guard++)
    {
        if (guard > entries.length)
        {
            throw new Error('SLTG type library: the block chain loops');
        }
        typeBlocks.push({ at, entry: order });
        at += entries[order].length;
        order = entries[order].next - 1;
    }
    const library = at;
    if (u16(library) !== LIBRARY_MAGIC)
    {
        throw new Error('SLTG type library: no library block where the chain ends');
    }

    // The library block's own fields.
    let cursor = library + 6;
    if (u16(cursor) !== 0xffff)
    {
        cursor += u16(cursor);
    }
    cursor += 2;
    const helpString = counted(cursor);
    cursor += helpString.size;
    const helpFile = counted(cursor);
    cursor += helpFile.size;
    cursor += 4;
    const sysKind = u16(cursor);
    const lcid = u16(cursor + 2);
    const libraryFlags = u16(cursor + 8);
    const majorVersion = u16(cursor + 10);
    const minorVersion = u16(cursor + 12);
    const libraryGuid = formatGuid(bytes.subarray(cursor + 14, cursor + 14 + GUID_SIZE));
    cursor += 14 + GUID_SIZE;

    // Sixty-four bytes of a table nothing reads, the count, then one record
    // per type: its index name, its name, its help, its GUID and its kind.
    cursor += 0x40;
    const typeCount = u16(cursor);
    cursor += 2;
    /** @type {{ indexName: string | null, nameOffset: number, guid: string, kind: number }[]} */
    const others = [];
    for (let index = 0; index < typeCount; index++)
    {
        let extra = 0;
        const indexName = counted(cursor);
        if (indexName.value !== null)
        {
            extra += u16(cursor);
        }
        const otherLength = u16(cursor + 2 + extra);
        if (otherLength !== 0xffff)
        {
            extra += otherLength;
        }
        const nameOffset = u16(cursor + 6 + extra);
        const helpLength = u16(cursor + 8 + extra);
        extra += helpLength;
        const guidAt = cursor + 18 + extra;
        others.push({
            indexName: indexName.value,
            nameOffset,
            guid: formatGuid(bytes.subarray(guidAt, guidAt + GUID_SIZE)),
            kind: u16(guidAt + GUID_SIZE),
        });
        cursor += OTHER_TYPE_BYTES + extra;
    }
    let names = library + u32(cursor);
    if (u16(names) === 0x0200)
    {
        names += 0x20;
    }
    names += 0x216 + 2;
    /** @param {number} offset @returns {string | null} */
    const nameAt = offset=>{
        if (offset === 0xffff || offset === 0xfffe)
        {
            return null;
        }
        const start = names + offset;
        let end = start;
        while (end < bytes.length && bytes[end] !== 0)
        {
            end++;
        }
        return text(start, end - start);
    };
    const libraryName = nameAt(u16(library + 4)) ?? '';

    /** @type {import('./typelib.js').ImportedType[]} */
    const imports = [];
    /** @type {Map<number, import('./typelib.js').ImportedLibrary>} by name-table offset */
    const importedLibraries = new Map();
    /** @param {number} offset */
    const importedLibrary = offset=>{
        const known = importedLibraries.get(offset);
        if (known)
        {
            return known;
        }
        const start = names + offset;
        let end = start;
        while (end < bytes.length && bytes[end] !== 0)
        {
            end++;
        }
        const reference = /\{([0-9a-fA-F-]{36})\}#([0-9a-fA-F]+)\.([0-9a-fA-F]+)#([0-9a-fA-F]+)#([^#]*)#/
            .exec(text(start, end - start));
        /** @type {import('./typelib.js').ImportedLibrary} */
        const imported = {
            guid: reference ? `{${reference[1].toUpperCase()}}` : null,
            majorVersion: reference ? parseInt(reference[2], 16) : 0,
            minorVersion: reference ? parseInt(reference[3], 16) : 0,
            lcid: reference ? parseInt(reference[4], 16) : 0,
            name: reference ? reference[5] : '',
        };
        importedLibraries.set(offset, imported);
        return imported;
    };

    /**
     * A type's reference table: each entry `*\R<library>*#<index>`, the
     * library 0xffff for this one, else a name-table offset to the library's
     * `*\G{guid}#major.minor#lcid#path#`.
     *
     * @param {number} tableAt
     * @returns {number[]} hreftypes, by the index a type word divided by four names
     */
    const referencesAt = tableAt=>{
        if (bytes[tableAt] !== REF_MAGIC)
        {
            throw new Error('SLTG type library: a reference table without its magic');
        }
        const number = u32(tableAt + 0x44);
        let entry = tableAt + 0x4f + number;
        /** @type {number[]} */
        const hreftypes = [];
        for (let index = 0; index < number >> 3; index++)
        {
            const reference = counted(entry);
            entry += reference.size;
            const parsed = /^\*\\R([0-9a-fA-F]+)\*#([0-9a-fA-F]+)/.exec(reference.value ?? '');
            if (!parsed)
            {
                hreftypes.push(-1);
                continue;
            }
            const libraryOffset = parseInt(parsed[1], 16);
            const typeIndex = parseInt(parsed[2], 16);
            if (libraryOffset === 0xffff)
            {
                hreftypes.push(typeIndex * TYPEINFO_BYTES);
                continue;
            }
            const imported = importedLibrary(libraryOffset);
            let found = imports.find(item=>item.library === imported
                && item.typeIndex === typeIndex);
            if (!found)
            {
                // The kind of a type in another library is that library's to
                // say; an interface is what one is referred to as here, unless
                // it is one of stdole's, whose layout is known.
                const known = imported.guid?.toUpperCase() === STDOLE_GUID
                    ? STDOLE_TYPES[typeIndex] : undefined;
                found = {
                    hreftype: (imports.length * IMPINFO_BYTES) | 1,
                    kind: known?.kind ?? TKIND_INTERFACE,
                    guid: known?.guid ?? null,
                    typeIndex,
                    library: imported,
                };
                imports.push(found);
            }
            hreftypes.push(found.hreftype);
        }
        return hreftypes;
    };

    /**
     * A type as the words of a record spell it, and where the words end.
     *
     * @param {number} typeAt  File offset of the first word.
     * @param {number} base    File offset offsets inside the type are from.
     * @param {number[]} references
     * @returns {{ type: import('./typelib.js').TypeDescription, end: number }}
     */
    const typeFrom = (typeAt, base, references)=>{
        /** @type {import('./typelib.js').TypeDescription} */
        const top = { vt: 0, element: null, hreftype: -1, array: null };
        let current = top;
        /** @param {number} vt */
        const deeper = vt=>{
            current.vt = vt;
            current.element = { vt: 0, element: null, hreftype: -1, array: null };
            current = current.element;
        };
        let word = typeAt;
        for (let guard = 0; guard < 64; guard++)
        {
            const code = u16(word);
            if ((code & 0xe00) === 0xe00)
            {
                deeper(VT_PTR);
            }
            const vt = code & 0x3f;
            if (vt === VT_PTR)
            {
                deeper(VT_PTR);
            }
            else if (vt === VT_SAFEARRAY)
            {
                word += 2;
                deeper(VT_SAFEARRAY);
            }
            else if (vt === VT_USERDEFINED)
            {
                word += 2;
                current.vt = VT_USERDEFINED;
                current.hreftype = references[u16(word) >> 2] ?? -1;
                return { type: top, end: word + 2 };
            }
            else if (vt === VT_CARRAY)
            {
                word += 2;
                const array = base + u16(word);
                const dimensions = view.getInt16(array, true);
                const bounds = [];
                for (let dimension = 0; dimension < dimensions; dimension++)
                {
                    bounds.push({
                        elements: u32(array + 16 + dimension * 8),
                        lower: view.getInt32(array + 20 + dimension * 8, true),
                    });
                }
                const element = { vt: 0, element: null, hreftype: -1, array: null };
                current.vt = VT_CARRAY;
                current.array = { element, bounds };
                current = element;
            }
            else
            {
                current.vt = vt;
                return { type: top, end: word + 2 };
            }
            word += 2;
        }
        throw new Error('SLTG type library: a type that does not end');
    };

    /** The parameter flags a type word's top bits carry. @param {number} code */
    const flagsOf = code=>{
        let flags;
        if ((code & 0xc000) === 0xc000)
        {
            flags = 0;
        }
        else if ((code & 0x8000) !== 0)
        {
            flags = PARAMFLAG_FIN | PARAMFLAG_FOUT;
        }
        else if ((code & 0x4000) !== 0)
        {
            flags = PARAMFLAG_FOUT;
        }
        else
        {
            flags = PARAMFLAG_FIN;
        }
        if ((code & 0x2000) !== 0)
        {
            flags |= PARAMFLAG_FLCID;
        }
        if ((code & 0x80) !== 0)
        {
            flags |= PARAMFLAG_FRETVAL;
        }
        return flags;
    };

    /**
     * @param {number} base @param {number} first @param {number} count
     * @param {number[]} references
     * @returns {import('./typelib.js').FunctionDescription[]}
     */
    const functionsAt = (base, first, count, references)=>{
        /** @type {import('./typelib.js').FunctionDescription[]} */
        const functions = [];
        for (let record = first, index = 0; index < count && record !== base + 0xffff; index++)
        {
            const magic = bytes[record] & ~0x20;
            const funcKind = magic === 0xcb ? FUNC_DISPATCH
                : magic === 0x8b ? FUNC_STATIC : FUNC_PUREVIRTUAL;
            const inv = bytes[record + 1];
            const nacc = bytes[record + 16];
            const options = bytes[record + 17];
            const parameterCount = nacc >> 3;
            const optional = (options & 0x7e) >> 1;
            const returnAt = (options & 0x80) !== 0 ? record + 18 : base + u16(record + 18);
            const returns = typeFrom(returnAt, base, references).type;
            /** @type {import('./typelib.js').ParameterDescription[]} */
            const parameters = [];
            let argument = base + u16(record + 14);
            for (let parameter = 0; parameter < parameterCount; parameter++)
            {
                const nameWord = u16(argument);
                const byOffset = (nameWord & 1) === 0;
                const name = (nameWord & ~1) === 0xfffe ? null : nameAt(nameWord & ~1);
                argument += 2;
                const typeAt = byOffset ? base + u16(argument) : argument;
                const read = typeFrom(typeAt, base, references);
                argument = byOffset ? argument + 2 : read.end;
                let flags = flagsOf(u16(typeAt));
                if (parameterCount - parameter <= optional)
                {
                    flags |= PARAMFLAG_FOPT;
                }
                parameters.push({ name, type: read.type, flags });
            }
            functions.push({
                memberId: view.getInt32(record + 6, true),
                name: nameAt(u16(record + 4)),
                funcKind,
                invokeKind: inv >> 4,
                callingConvention: nacc & 7,
                vtableOffset: funcKind === FUNC_DISPATCH ? 0 : u16(record + 20) & ~1,
                flags: (bytes[record] & 0x20) !== 0 ? u16(record + 22) : 0,
                returns,
                parameters,
                optionalParameters: optional,
                helpString: null,
            });
            record = base + u16(record + 2);
        }
        return functions;
    };

    /**
     * @param {number} base @param {number} first @param {number} count
     * @param {number[]} references
     * @returns {import('./typelib.js').VariableDescription[]}
     */
    const variablesAt = (base, first, count, references)=>{
        /** @type {import('./typelib.js').VariableDescription[]} */
        const variables = [];
        /** @type {string | null} */
        let previous = null;
        for (let record = first, index = 0; index < count; index++)
        {
            const magic = bytes[record];
            if (magic !== 0x0a && magic !== 0x2a)
            {
                break;
            }
            const flags = bytes[record + 1];
            const nameWord = u16(record + 4);
            /** @type {string | null} */
            const name = nameWord === 0xfffe ? previous : nameAt(nameWord);
            const where = u16(record + 6);
            const typeAt = (flags & 0x02) !== 0 ? record + 8 : base + u16(record + 8);
            const type = typeFrom(typeAt, base, references).type;
            let varKind = VAR_PERINSTANCE;
            /** @type {import('./typelib.js').ConstantValue | null} */
            let constant = null;
            if ((flags & 0x40) !== 0)
            {
                varKind = VAR_DISPATCH;
            }
            else if ((flags & 0x10) !== 0)
            {
                varKind = VAR_CONST;
                if ((flags & 0x08) !== 0)
                {
                    constant = { vt: VT_INT, value: where };
                }
                else if (type.vt === VT_BSTR || type.vt === 30 || type.vt === 31)
                {
                    const length = u16(base + where);
                    constant = {
                        vt: VT_BSTR,
                        value: length === 0xffff ? null : text(base + where + 2, length),
                    };
                }
                else
                {
                    constant = {
                        vt: type.vt === VT_I4 ? VT_I4 : VT_INT,
                        value: view.getInt32(base + where, true),
                    };
                }
            }
            let varFlags = magic === 0x2a ? u16(record + 18) : 0;
            if ((flags & 0x80) !== 0)
            {
                varFlags |= VARFLAG_FREADONLY;
            }
            variables.push({
                memberId: view.getInt32(record + 10, true),
                name,
                varKind,
                type,
                flags: varFlags,
                offset: varKind === VAR_PERINSTANCE ? where : 0,
                constant,
            });
            previous = name;
            record = base + u16(record + 2);
        }
        return variables;
    };

    /**
     * @param {number} base @param {number} first @param {number[]} references
     * @returns {{ hreftype: number, flags: number }[]}
     */
    const implementedAt = (base, first, references)=>{
        const list = [];
        for (let record = first, guard = 0; guard < 256; guard++)
        {
            list.push({ hreftype: references[u16(record + 10)] ?? -1, flags: bytes[record + 6] });
            if (u16(record + 2) === 0xffff)
            {
                break;
            }
            record = base + u16(record + 2);
        }
        return list;
    };

    /** @type {import('./typelib.js').TypeInfoDescription[]} */
    const typeInfos = typeBlocks.map(({ at: block }, index)=>{
        const other = others[index];
        if (!other || u16(block) !== TYPE_HEADER_MAGIC)
        {
            throw new Error(`SLTG type library: type ${index} has no header`);
        }
        const hrefTable = u32(block + 2);
        const members = block + u32(block + 0x0a);
        const flags1 = bytes[block + 0x1a];
        const flags2 = bytes[block + 0x1b];
        const storedKind = bytes[block + 0x1d];
        const typeFlags = (flags1 >> 3) | (flags2 << 5);
        const base = members + MEMBER_HEADER_BYTES;
        const tail = base + u32(members + 5);
        const references = hrefTable === 0xffffffff ? [] : referencesAt(block + hrefTable);
        const functionCount = u16(tail);
        const variableCount = u16(tail + 2);
        const functionsOffset = u16(tail + 8);
        const variablesOffset = u16(tail + 10);
        const implementedOffset = u16(tail + 12);
        const functions = functionsOffset === 0xffff
            ? [] : functionsAt(base, base + functionsOffset, functionCount, references);
        const variables = variablesOffset === 0xffff
            ? [] : variablesAt(base, base + variablesOffset, variableCount, references);
        /** @type {{ hreftype: number, flags: number }[]} */
        let implementedTypes = [];
        if (storedKind === TKIND_DISPATCH && implementedOffset !== 0xffff)
        {
            implementedTypes = implementedAt(base, base + implementedOffset, references);
        }
        else if ((storedKind === TKIND_INTERFACE || storedKind === TKIND_COCLASS)
            && u16(base) === IMPL_MAGIC)
        {
            implementedTypes = implementedAt(base, base, references);
        }
        /** @type {import('./typelib.js').TypeDescription | null} */
        let alias = null;
        if (storedKind === TKIND_ALIAS)
        {
            alias = u16(tail + 0x1c) !== 0
                ? { vt: u16(tail + 0x14), element: null, hreftype: -1, array: null }
                : typeFrom(base + u16(tail + 0x14), base, references).type;
        }
        // A dual interface is a dispinterface to whoever asks its kind, as
        // the real ITypeInfo answers for one read from this format.
        const kind = (typeFlags & TYPEFLAG_FDUAL) !== 0 ? TKIND_DISPATCH : storedKind;
        return {
            index,
            hreftype: index * TYPEINFO_BYTES,
            name: nameAt(other.nameOffset) ?? '',
            kind,
            guid: other.guid,
            flags: typeFlags,
            majorVersion: u16(block + 0x12),
            minorVersion: u16(block + 0x14),
            helpString: null,
            instanceSize: u16(tail + 0x20),
            alignment: u16(tail + 0x22),
            vtableSize: storedKind === TKIND_DISPATCH ? functions.length * 4 : u16(tail + 0x28),
            functions,
            variables,
            implementedTypes,
            alias,
        };
    });
    if (typeInfos.length !== typeCount)
    {
        throw new Error(`SLTG type library: ${typeInfos.length} type blocks`
            + ` for ${typeCount} types`);
    }

    return {
        name: libraryName,
        guid: libraryGuid,
        lcid,
        sysKind,
        majorVersion,
        minorVersion,
        flags: libraryFlags,
        helpString: helpString.value,
        helpFile: helpFile.value,
        typeInfos,
        imports,
    };
}
