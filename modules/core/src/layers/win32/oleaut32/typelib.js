/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A reader for the MSFT type-library format: the binary a compiler writes from
 * an IDL file and a program loads back to describe its own interfaces.
 *
 * Pure parsing over a byte array; nothing here knows about guest memory or
 * COM. What comes out is a plain description -- the library, its types, their
 * functions, variables and references -- that the ITypeLib and ITypeInfo
 * objects lay out for a program on request.
 *
 * The file is a header, a directory of segments, and the segments. Every
 * reference between them is a byte offset into one segment or another, and a
 * few are overloaded: a negative type code is a VARTYPE carried inline rather
 * than an offset into the type table, and a reference to a type is either an
 * offset into this library's type table or, with its low bit set, an offset
 * into the import table. Getting either overload wrong reads structure out of
 * an unrelated table, so both are decoded in exactly one place each.
 */

import { GUID_SIZE, formatGuid } from '../ole32/guid.js';
import { decodeAnsi } from '../kernel32/locale.js';

/** 'MSFT', as the first four bytes read as a little-endian word. */
const MAGIC = 0x5446534d;

/** Fixed header words, before the optional help-DLL word and the type offsets. */
const HEADER_WORDS = 21;

/** The header bit that says a help-DLL offset follows the fixed header. */
const HELP_DLL_FLAG = 0x100;

/** The segment directory: fifteen entries of four words. */
const SEGMENTS = 15;
const SEGMENT_BYTES = 16;

/** Segment indices, in directory order. */
const SEG_TYPEINFO = 0;
const SEG_IMPINFO = 1;
const SEG_IMPFILES = 2;
const SEG_REF = 3;
const SEG_GUID = 5;
const SEG_NAME = 7;
const SEG_STRING = 8;
const SEG_TYPEDESC = 9;
const SEG_ARRAYDESC = 10;
const SEG_CUSTDATA = 11;

/** One type-info record, and one import record. */
const TYPEINFO_BYTES = 0x64;
const IMPINFO_BYTES = 12;

/** The fixed part of a function record, and one parameter after it. */
const FUNC_FIXED = 24;
const PARAM_BYTES = 12;

/** Type codes the reader interprets. */
export const VT_I2 = 2;
export const VT_I4 = 3;
export const VT_R4 = 4;
export const VT_R8 = 5;
export const VT_BSTR = 8;
export const VT_BOOL = 11;
export const VT_I1 = 16;
export const VT_UI1 = 17;
export const VT_UI2 = 18;
export const VT_UI4 = 19;
export const VT_PTR = 26;
export const VT_SAFEARRAY = 27;
export const VT_CARRAY = 28;
export const VT_USERDEFINED = 29;
const VT_TYPEMASK = 0xfff;

/** TYPEKIND. */
export const TKIND_ENUM = 0;
export const TKIND_RECORD = 1;
export const TKIND_MODULE = 2;
export const TKIND_INTERFACE = 3;
export const TKIND_DISPATCH = 4;
export const TKIND_COCLASS = 5;
export const TKIND_ALIAS = 6;
export const TKIND_UNION = 7;

/** VARKIND. */
export const VAR_CONST = 2;

/**
 * An import's flags word: the kind of the imported type in the top byte, and
 * one bit saying whether its third word is a GUID offset or a type index.
 */
const IMPORT_GUID_FLAG = 0x10000;

/** The low bits of a reference that mark it as an import. */
const REFERENCE_IMPORT_BITS = 3;

/**
 * @typedef {Object} TypeDescription
 * @property {number} vt
 * @property {TypeDescription | null} element
 *           What a pointer or a safe array points at; null for anything else.
 * @property {number} hreftype
 *           The type referred to, for VT_USERDEFINED; -1 otherwise.
 * @property {ArrayDescription | null} array  The bounds, for VT_CARRAY.
 */

/**
 * @typedef {Object} ArrayDescription
 * @property {TypeDescription} element
 * @property {{ elements: number, lower: number }[]} bounds
 */

/**
 * @typedef {Object} ParameterDescription
 * @property {string | null} name
 * @property {TypeDescription} type
 * @property {number} flags   PARAMFLAG_*.
 */

/**
 * @typedef {Object} FunctionDescription
 * @property {number} memberId
 * @property {string | null} name
 * @property {number} funcKind
 * @property {number} invokeKind
 * @property {number} callingConvention
 * @property {number} vtableOffset  In bytes.
 * @property {number} flags   FUNCFLAG_*.
 * @property {TypeDescription} returns
 * @property {ParameterDescription[]} parameters
 * @property {number} optionalParameters
 * @property {string | null} helpString
 */

/**
 * @typedef {Object} ConstantValue
 * @property {number} vt
 * @property {number | string | null} value  A number, a string, or null when the
 *           value is of a type this reader does not decode.
 */

/**
 * @typedef {Object} VariableDescription
 * @property {number} memberId
 * @property {string | null} name
 * @property {number} varKind
 * @property {TypeDescription} type
 * @property {number} flags   VARFLAG_*.
 * @property {number} offset  Where the member lives in an instance, for a
 *           per-instance variable.
 * @property {ConstantValue | null} constant  For VAR_CONST.
 */

/**
 * @typedef {Object} TypeInfoDescription
 * @property {number} index
 * @property {number} hreftype    How this library refers to the type.
 * @property {string} name
 * @property {number} kind        TKIND_*.
 * @property {string | null} guid
 * @property {number} flags       TYPEFLAG_*.
 * @property {number} majorVersion
 * @property {number} minorVersion
 * @property {string | null} helpString
 * @property {number} instanceSize
 * @property {number} alignment
 * @property {number} vtableSize  In bytes, this type's own methods included.
 * @property {FunctionDescription[]} functions
 * @property {VariableDescription[]} variables
 * @property {{ hreftype: number, flags: number }[]} implementedTypes
 * @property {TypeDescription | null} alias  What an alias stands for.
 */

/**
 * @typedef {Object} ImportedLibrary
 * @property {string | null} guid
 * @property {string} name
 * @property {number} lcid
 * @property {number} majorVersion
 * @property {number} minorVersion
 */

/**
 * @typedef {Object} ImportedType
 * @property {number} hreftype
 * @property {number} kind
 * @property {string | null} guid   Null when the import names the type by index.
 * @property {number} typeIndex     Its index in the other library, or -1.
 * @property {ImportedLibrary} library
 */

/**
 * @typedef {Object} TypeLibrary
 * @property {string} name
 * @property {string | null} guid
 * @property {number} lcid
 * @property {number} sysKind
 * @property {number} majorVersion
 * @property {number} minorVersion
 * @property {number} flags   LIBFLAG_*.
 * @property {string | null} helpString
 * @property {string | null} helpFile
 * @property {TypeInfoDescription[]} typeInfos
 * @property {ImportedType[]} imports
 */

/**
 * Reads one library.
 *
 * @param {Uint8Array} bytes
 * @returns {TypeLibrary}
 * @throws {Error} when the bytes are not an MSFT library, or are cut short.
 */
export function parseTypeLib(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < HEADER_WORDS * 4 || view.getUint32(0, true) !== MAGIC)
    {
        throw new Error('not an MSFT type library');
    }
    /** @param {number} at */
    const word = at=>view.getInt32(at, true);
    /** @param {number} at */
    const half = at=>view.getInt16(at, true);

    const header = {
        guid: word(0x08),
        lcid: word(0x0c),
        varFlags: word(0x14),
        version: word(0x18),
        flags: word(0x1c),
        typeInfos: word(0x20),
        helpString: word(0x24),
        name: word(0x38),
        helpFile: word(0x3c),
    };
    // The directory follows the header, the optional help-DLL word and one
    // word per type.
    let directory = HEADER_WORDS * 4 + header.typeInfos * 4;
    if ((header.varFlags & HELP_DLL_FLAG) !== 0)
    {
        directory += 4;
    }
    /** @type {{ offset: number, length: number }[]} */
    const segments = [];
    for (let index = 0; index < SEGMENTS; index++)
    {
        const entry = directory + index * SEGMENT_BYTES;
        segments.push({ offset: word(entry), length: word(entry + 4) });
    }
    /**
     * @param {number} segment @param {number} offset
     * @returns {number} the file offset of a segment-relative one
     */
    const inSegment = (segment, offset)=>{
        const { offset: base, length } = segments[segment];
        if (base < 0 || offset < 0 || offset >= length)
        {
            throw new Error(`type library: offset ${offset} outside segment ${segment}`);
        }
        return base + offset;
    };

    /** @param {number} offset @returns {string | null} */
    const nameAt = offset=>{
        if (offset < 0)
        {
            return null;
        }
        const at = inSegment(SEG_NAME, offset);
        return pageText(at + 12, word(at + 8) & 0xff);
    };
    /** @param {number} offset @returns {string | null} */
    const stringAt = offset=>{
        if (offset < 0)
        {
            return null;
        }
        const at = inSegment(SEG_STRING, offset);
        return pageText(at + 2, view.getUint16(at, true));
    };
    /** @param {number} offset @returns {string | null} */
    const guidAtOffset = offset=>{
        if (offset < 0)
        {
            return null;
        }
        const at = inSegment(SEG_GUID, offset);
        return formatGuid(bytes.subarray(at, at + GUID_SIZE));
    };
    /**
     * Text is stored in the machine's code page, which is the ANSI one; one
     * byte, one character.
     *
     * @param {number} at @param {number} length
     */
    const pageText = (at, length)=>decodeAnsi(bytes.subarray(at, at + length));

    /** @type {Map<number, TypeDescription>} memoised by offset: the table is a graph */
    const typeDescriptions = new Map();
    /** @param {number} vt @returns {TypeDescription} */
    const inline = vt=>({ vt: vt & VT_TYPEMASK, element: null, hreftype: -1, array: null });

    /**
     * A type code as it appears in a record: an inline VARTYPE when negative,
     * otherwise an offset into the type table.
     *
     * @param {number} code
     * @returns {TypeDescription}
     */
    const typeOf = code=>(code < 0 ? inline(code) : typeAt(code));

    /**
     * One entry of the type table: four halves, the first the VARTYPE and the
     * last two what it refers to, read one way for a pointer and another for a
     * user-defined type.
     *
     * @param {number} offset
     * @returns {TypeDescription}
     */
    const typeAt = offset=>{
        const known = typeDescriptions.get(offset);
        if (known)
        {
            return known;
        }
        const at = inSegment(SEG_TYPEDESC, offset);
        const vt = half(at) & VT_TYPEMASK;
        const low = half(at + 4);
        const high = half(at + 6);
        /** @type {TypeDescription} */
        const description = { vt, element: null, hreftype: -1, array: null };
        typeDescriptions.set(offset, description);
        if (vt === VT_PTR || vt === VT_SAFEARRAY)
        {
            // A negative high half says the low half is a VARTYPE itself,
            // not an offset.
            description.element = high < 0 ? inline(low) : typeAt(low);
        }
        else if (vt === VT_USERDEFINED)
        {
            description.hreftype = ((high & 0xffff) << 16) | (low & 0xffff);
        }
        else if (vt === VT_CARRAY)
        {
            description.array = arrayAt(low);
        }
        return description;
    };

    /**
     * @param {number} offset  Into the array-description segment.
     * @returns {ArrayDescription}
     */
    const arrayAt = offset=>{
        const at = inSegment(SEG_ARRAYDESC, offset);
        const elementCode = half(at);
        const elementIsInline = half(at + 2) < 0;
        const dimensions = half(at + 4);
        const bounds = [];
        for (let index = 0; index < dimensions; index++)
        {
            bounds.push({
                elements: word(at + 8 + index * 8),
                lower: word(at + 12 + index * 8),
            });
        }
        return { element: elementIsInline ? inline(elementCode) : typeAt(elementCode), bounds };
    };

    /**
     * A constant's value: inline in the offset word when that word is
     * negative, otherwise a typed value in the custom-data segment.
     *
     * @param {number} code
     * @returns {ConstantValue}
     */
    const constantOf = code=>{
        if (code < 0)
        {
            return { vt: (code >>> 26) & 0x1f, value: code & 0x3ffffff };
        }
        const at = inSegment(SEG_CUSTDATA, code);
        const vt = view.getUint16(at, true);
        switch (vt)
        {
            case VT_BSTR:
                return { vt, value: pageText(at + 6, word(at + 2)) };
            case VT_I2:
            case VT_BOOL:
                return { vt, value: half(at + 2) };
            case VT_UI2:
                return { vt, value: view.getUint16(at + 2, true) };
            case VT_I1:
                return { vt, value: view.getInt8(at + 2) };
            case VT_UI1:
                return { vt, value: view.getUint8(at + 2) };
            case VT_UI4:
                return { vt, value: view.getUint32(at + 2, true) };
            case VT_R4:
                return { vt, value: view.getFloat32(at + 2, true) };
            case VT_R8:
                return { vt, value: view.getFloat64(at + 2, true) };
            default:
                return { vt, value: vt === VT_I4 ? word(at + 2) : null };
        }
    };

    /**
     * The members of one type: a block of variable-length records, then three
     * tables over them -- member ids, name offsets, record offsets -- each with
     * one word per member, functions first.
     *
     * @param {number} base   File offset of the block.
     * @param {number} functionCount @param {number} variableCount
     */
    const membersAt = (base, functionCount, variableCount)=>{
        const total = functionCount + variableCount;
        const recordsLength = word(base);
        const tables = base + 4 + recordsLength;
        /** @param {number} table @param {number} index */
        const entry = (table, index)=>word(tables + (table * total + index) * 4);
        /** @type {FunctionDescription[]} */
        const functions = [];
        /** @type {VariableDescription[]} */
        const variables = [];
        for (let index = 0; index < total; index++)
        {
            const record = base + 4 + entry(2, index);
            const size = word(record) & 0xffff;
            const memberId = entry(0, index);
            const name = nameAt(entry(1, index));
            const type = typeOf(word(record + 4));
            const flags = word(record + 8) & 0xffff;
            if (index < functionCount)
            {
                const fkccic = word(record + 16);
                const count = half(record + 20);
                const parameters = [];
                for (let parameter = 0; parameter < count; parameter++)
                {
                    // The parameters are the tail of the record, whatever
                    // optional words sit between them and the fixed part.
                    const at = record + size - (count - parameter) * PARAM_BYTES;
                    parameters.push({
                        type: typeOf(word(at)),
                        name: nameAt(word(at + 4)),
                        flags: word(at + 8) & 0xffff,
                    });
                }
                const optional = size - FUNC_FIXED - count * PARAM_BYTES;
                functions.push({
                    memberId,
                    name,
                    funcKind: fkccic & 0x7,
                    invokeKind: (fkccic >> 3) & 0xf,
                    callingConvention: (fkccic >> 8) & 0xf,
                    // The low bit of the offset is a flag, not part of it.
                    vtableOffset: half(record + 12) & ~1,
                    flags,
                    returns: type,
                    parameters,
                    optionalParameters: half(record + 22),
                    helpString: optional >= 8 ? stringAt(word(record + FUNC_FIXED + 4)) : null,
                });
            }
            else
            {
                const varKind = half(record + 12);
                const value = word(record + 16);
                variables.push({
                    memberId,
                    name,
                    varKind,
                    type,
                    flags,
                    offset: varKind === VAR_CONST ? 0 : value,
                    constant: varKind === VAR_CONST ? constantOf(value) : null,
                });
            }
        }
        return { functions, variables };
    };

    /**
     * The chain of implemented types a coclass lists, starting at an offset in
     * the reference segment and linked through each record's last word.
     *
     * @param {number} first
     */
    const implementedFrom = first=>{
        const list = [];
        for (let offset = first; offset >= 0;)
        {
            const at = inSegment(SEG_REF, offset);
            list.push({ hreftype: word(at), flags: word(at + 4) });
            offset = word(at + 12);
        }
        return list;
    };

    /** @type {TypeInfoDescription[]} */
    const typeInfos = [];
    for (let index = 0; index < header.typeInfos; index++)
    {
        const hreftype = index * TYPEINFO_BYTES;
        const at = inSegment(SEG_TYPEINFO, hreftype);
        const kindWord = word(at);
        const kind = kindWord & 0xf;
        const elements = word(at + 24);
        const functionCount = elements & 0xffff;
        const variableCount = elements >>> 16;
        const version = word(at + 56);
        const implTypeCount = half(at + 76);
        const datatype1 = word(at + 84);
        const members = functionCount + variableCount > 0
            ? membersAt(word(at + 4), functionCount, variableCount)
            : { functions: [], variables: [] };
        /** @type {{ hreftype: number, flags: number }[]} */
        let implementedTypes = [];
        if (kind === TKIND_COCLASS)
        {
            implementedTypes = implementedFrom(datatype1);
        }
        else if (implTypeCount > 0 && datatype1 >= 0)
        {
            // An interface names its one base directly rather than through
            // the reference chain a coclass uses.
            implementedTypes = [{ hreftype: datatype1, flags: 0 }];
        }
        typeInfos.push({
            index,
            hreftype,
            name: nameAt(word(at + 52)) ?? '',
            kind,
            guid: guidAtOffset(word(at + 44)),
            flags: word(at + 48) & 0xffff,
            majorVersion: version & 0xffff,
            minorVersion: version >>> 16,
            helpString: stringAt(word(at + 60)),
            instanceSize: word(at + 80),
            alignment: (kindWord >> 11) & 0x1f,
            vtableSize: half(at + 78),
            functions: members.functions,
            variables: members.variables,
            implementedTypes,
            alias: kind === TKIND_ALIAS ? typeOf(datatype1) : null,
        });
    }

    /** @type {Map<number, ImportedLibrary>} by offset in the import-file segment */
    const importedLibraries = new Map();
    /** @param {number} offset */
    const libraryAt = offset=>{
        const known = importedLibraries.get(offset);
        if (known)
        {
            return known;
        }
        const at = inSegment(SEG_IMPFILES, offset);
        // The name's length is stored shifted up two bits; the low bits are
        // flags no reader has needed.
        const length = view.getUint16(at + 12, true) >> 2;
        /** @type {ImportedLibrary} */
        const library = {
            guid: guidAtOffset(word(at)),
            lcid: word(at + 4),
            majorVersion: half(at + 8),
            minorVersion: half(at + 10),
            name: pageText(at + 14, length),
        };
        importedLibraries.set(offset, library);
        return library;
    };
    /** @type {ImportedType[]} */
    const imports = [];
    const importCount = segments[SEG_IMPINFO].offset < 0
        ? 0
        : Math.floor(segments[SEG_IMPINFO].length / IMPINFO_BYTES);
    for (let index = 0; index < importCount; index++)
    {
        const offset = index * IMPINFO_BYTES;
        const at = inSegment(SEG_IMPINFO, offset);
        const flags = word(at);
        const byGuid = (flags & IMPORT_GUID_FLAG) !== 0;
        const third = word(at + 8);
        imports.push({
            hreftype: offset | 1,
            kind: flags >>> 24,
            guid: byGuid ? guidAtOffset(third) : null,
            typeIndex: byGuid ? -1 : third,
            library: libraryAt(word(at + 4)),
        });
    }

    return {
        name: nameAt(header.name) ?? '',
        guid: guidAtOffset(header.guid),
        lcid: header.lcid,
        sysKind: header.varFlags & 0xf,
        majorVersion: header.version & 0xffff,
        minorVersion: header.version >>> 16,
        flags: header.flags & 0xffff,
        helpString: stringAt(header.helpString),
        helpFile: stringAt(header.helpFile),
        typeInfos,
        imports,
    };
}

/**
 * What a reference names: a type of this library, or an import.
 *
 * @param {TypeLibrary} library @param {number} hreftype
 * @returns {TypeInfoDescription | ImportedType | null}
 */
export function resolveReference(library, hreftype){
    if ((hreftype & REFERENCE_IMPORT_BITS) !== 0)
    {
        return library.imports.find(entry=>entry.hreftype === (hreftype | 1)) ?? null;
    }
    if (hreftype % TYPEINFO_BYTES !== 0)
    {
        return null;
    }
    return library.typeInfos[hreftype / TYPEINFO_BYTES] ?? null;
}

/**
 * Whether a resolved reference is an import rather than a type of the library.
 *
 * @param {TypeInfoDescription | ImportedType} reference
 * @returns {reference is ImportedType}
 */
export function isImport(reference){
    return 'library' in reference;
}
