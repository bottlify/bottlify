/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Synthesis of an in-guest system module: a real PE32 image with a real export
 * directory, whose exported addresses are JMP trampolines into host trap stubs.
 *
 * Patching an import table binds the calls a program makes through its own IAT.
 * It does nothing for a program that resolves a name at runtime, walks an export
 * directory itself, or copies the first bytes of an exported function -- all of
 * which need the module to actually exist in guest memory. This emitter is the
 * mirror image of pe.js: the same structures at the same offsets, written rather
 * than read. It is pure, so an image can be built and checked without a guest.
 */

const DOS_MAGIC = 0x5a4d; // "MZ"
const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const MACHINE_I386 = 0x014c;
const PE32_MAGIC = 0x010b;
const PE_OFFSET = 0x40;

const COFF_EXECUTABLE_IMAGE = 0x0002;
const COFF_32BIT_MACHINE = 0x0100;
const COFF_DLL = 0x2000;

const OPTIONAL_HEADER_SIZE = 0xe0;
const SUBSYSTEM_CONSOLE = 3;

const SECTION_CNT_CODE = 0x00000020;
const SECTION_MEM_EXECUTE = 0x20000000;
const SECTION_MEM_READ = 0x40000000;

/**
 * Section and file alignment are both a page, which makes every raw offset equal
 * its RVA: the emitted bytes are simultaneously the file and the mapping, so the
 * caller writes them to `base` in one shot and a parser reads them unchanged.
 */
const PAGE = 0x1000;
const SECTION_RVA = PAGE;
const HEADERS_SIZE = PAGE;

/** Each export gets a whole slot, so code that reads past the JMP finds int3, not the next export. */
const TRAMPOLINE_STRIDE = 0x10;
const JMP_REL32 = 0xe9;
const INT3 = 0xcc;

const EXPORT_DIRECTORY_SIZE = 40;
const DEFAULT_ORDINAL_BASE = 1;

const encoder = new TextEncoder();

/**
 * @typedef {Object} SynthExport
 * @property {string} name
 * @property {number} [ordinal]  Given for all exports or for none; defaults to a dense table.
 * @property {number} target     Guest address of the host trap stub this export jumps to.
 */

/**
 * @typedef {Object} SynthesisedModule
 * @property {Uint8Array} bytes            The whole image, ready to be written at `base`.
 * @property {number} size                 SizeOfImage; equals bytes.length.
 * @property {number} exportDirectoryRva
 * @property {number} entryPointRva      Zero when the module has nothing to initialise.
 * @property {(name: string) => number | null} addressOf  Guest address of the trampoline.
 * @property {(name: string) => number | null} ordinalOf
 */

/**
 * @param {Object} options
 * @param {string} options.name    Module name as it appears in an import descriptor.
 * @param {number} options.base    Guest address the image will be mapped at.
 * @param {SynthExport[]} options.exports
 * @param {string} [options.entryPoint]
 *   The export that is the module's DllMain. A library a program loads at
 *   run time is initialised through its entry point, and a system module
 *   that has to announce itself to another library on being loaded needs one.
 * @returns {SynthesisedModule}
 */
export function synthesiseModule({ name, base, exports, entryPoint }){
    requireAscii(name, 'module name');
    const entryIndex = entryPoint === undefined ? -1
        : exports.findIndex(entry=>entry.name === entryPoint);
    if (entryPoint !== undefined && entryIndex < 0)
    {
        throw new Error(`entry point "${entryPoint}" is not among the exports`);
    }
    const ordinals = assignOrdinals(exports);
    const ordinalBase = ordinals.length === 0 ? DEFAULT_ORDINAL_BASE : Math.min(...ordinals);
    const functionCount = ordinals.length === 0 ? 0 : Math.max(...ordinals) - ordinalBase + 1;

    // Trampolines come first, before the export directory: a function RVA that
    // fell inside the directory's own address range would be read as a forwarder
    // string rather than as code.
    const trampolinesRva = SECTION_RVA;
    const exportDirectoryRva = trampolinesRva + exports.length * TRAMPOLINE_STRIDE;
    const functionsRva = exportDirectoryRva + EXPORT_DIRECTORY_SIZE;
    const namesRva = functionsRva + functionCount * 4;
    const nameOrdinalsRva = namesRva + exports.length * 4;

    const strings = [name, ...exports.map(entry=>entry.name)];
    /** @type {number[]} */
    const stringRvas = [];
    let cursor = nameOrdinalsRva + exports.length * 2;
    for (const text of strings)
    {
        stringRvas.push(cursor);
        cursor += text.length + 1;
    }

    // The directory's size spans everything it owns, which is what tells a loader
    // whether an exported address is code or a forwarder.
    const exportDirectorySize = cursor - exportDirectoryRva;
    const sectionSize = cursor - SECTION_RVA;
    const size = SECTION_RVA + align(sectionSize, PAGE);

    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    const entryPointRva = entryIndex < 0 ? 0 : trampolinesRva + entryIndex * TRAMPOLINE_STRIDE;

    writeHeaders(bytes, view, {
        base, size, sectionSize, exportDirectoryRva, exportDirectorySize, entryPointRva,
    });

    exports.forEach((entry, index)=>{
        const rva = trampolinesRva + index * TRAMPOLINE_STRIDE;
        bytes.fill(INT3, rva, rva + TRAMPOLINE_STRIDE);
        bytes[rva] = JMP_REL32;
        // Relative to the instruction after the jump; 32-bit EIP arithmetic wraps,
        // so any pair of guest addresses is reachable regardless of sign.
        view.setUint32(rva + 1, (entry.target - (base + rva + 5)) >>> 0, true);
        view.setUint32(functionsRva + (ordinals[index] - ordinalBase) * 4, rva, true);
    });

    view.setUint32(exportDirectoryRva + 12, stringRvas[0], true); // Name
    view.setUint32(exportDirectoryRva + 16, ordinalBase, true); // Base
    view.setUint32(exportDirectoryRva + 20, functionCount, true); // NumberOfFunctions
    view.setUint32(exportDirectoryRva + 24, exports.length, true); // NumberOfNames
    view.setUint32(exportDirectoryRva + 28, functionsRva, true); // AddressOfFunctions
    view.setUint32(exportDirectoryRva + 32, namesRva, true); // AddressOfNames
    view.setUint32(exportDirectoryRva + 36, nameOrdinalsRva, true); // AddressOfNameOrdinals

    // The name table must be sorted: the binary search a loader performs over it
    // is only correct on sorted input, and an unsorted table fails per-name in a
    // way that looks random. ASCII names make this comparison the byte-wise one
    // that search assumes.
    const sorted = exports
        .map((entry, index)=>index)
        .sort((a, b)=>exports[a].name < exports[b].name ? -1 : 1);

    sorted.forEach((index, slot)=>{
        view.setUint32(namesRva + slot * 4, stringRvas[index + 1], true);
        view.setUint16(nameOrdinalsRva + slot * 2, ordinals[index] - ordinalBase, true);
    });

    strings.forEach((text, index)=>bytes.set(encoder.encode(text), stringRvas[index]));

    const table = new Map(exports.map((entry, index)=>[entry.name, {
        address: base + trampolinesRva + index * TRAMPOLINE_STRIDE,
        ordinal: ordinals[index],
    }]));

    return {
        bytes,
        size,
        exportDirectoryRva,
        entryPointRva,
        addressOf: exported=>table.get(exported)?.address ?? null,
        ordinalOf: exported=>table.get(exported)?.ordinal ?? null,
    };
}

/**
 * @param {SynthExport[]} exports
 * @returns {number[]} the ordinal of each export, in declaration order
 */
function assignOrdinals(exports){
    /** @type {Set<string>} */
    const names = new Set();
    for (const entry of exports)
    {
        requireAscii(entry.name, 'export name');
        if (names.has(entry.name))
        {
            throw new Error(`duplicate export "${entry.name}"`);
        }
        names.add(entry.name);
    }

    // A declared ordinal is a fact about what a program compiled against and is
    // honoured exactly; the rest are ours to hand out. A mixed set is the
    // ordinary case, not an error: a real library pins the numbers its callers
    // import by and lets its linker assign the others.
    /** @type {Set<number>} */
    const taken = new Set();
    for (const entry of exports)
    {
        if (entry.ordinal === undefined)
        {
            continue;
        }
        const ordinal = entry.ordinal;
        if (!Number.isInteger(ordinal) || ordinal < 1)
        {
            throw new Error(`export "${entry.name}" has an invalid ordinal ${ordinal}`);
        }
        if (taken.has(ordinal))
        {
            throw new Error(`two exports claim ordinal ${ordinal}`);
        }
        taken.add(ordinal);
    }

    // Above everything claimed, so an assigned number can never collide with a
    // declared one and the two sets stay legible when something goes wrong.
    let next = Math.max(DEFAULT_ORDINAL_BASE - 1, ...taken) + 1;
    return exports.map(entry=>{
        if (entry.ordinal !== undefined)
        {
            return entry.ordinal;
        }
        return next++;
    });
}

/**
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @param {Object} layout
 * @param {number} layout.base
 * @param {number} layout.size
 * @param {number} layout.sectionSize
 * @param {number} layout.exportDirectoryRva
 * @param {number} layout.exportDirectorySize
 * @param {number} layout.entryPointRva
 */
function writeHeaders(bytes, view, layout){
    const rawSize = align(layout.sectionSize, PAGE);

    view.setUint16(0, DOS_MAGIC, true);
    view.setUint32(0x3c, PE_OFFSET, true);
    view.setUint32(PE_OFFSET, PE_SIGNATURE, true);

    const coff = PE_OFFSET + 4;
    view.setUint16(coff, MACHINE_I386, true);
    view.setUint16(coff + 2, 1, true); // one section
    view.setUint16(coff + 16, OPTIONAL_HEADER_SIZE, true);
    view.setUint16(coff + 18, COFF_EXECUTABLE_IMAGE | COFF_32BIT_MACHINE | COFF_DLL, true);

    const optional = coff + 20;
    view.setUint16(optional, PE32_MAGIC, true);
    view.setUint32(optional + 4, rawSize, true); // SizeOfCode
    view.setUint32(optional + 16, layout.entryPointRva, true); // AddressOfEntryPoint
    view.setUint32(optional + 20, SECTION_RVA, true); // BaseOfCode
    view.setUint32(optional + 28, layout.base, true); // ImageBase
    view.setUint32(optional + 32, PAGE, true); // SectionAlignment
    view.setUint32(optional + 36, PAGE, true); // FileAlignment
    view.setUint16(optional + 40, 4, true); // MajorOperatingSystemVersion
    view.setUint16(optional + 48, 4, true); // MajorSubsystemVersion
    view.setUint32(optional + 56, layout.size, true); // SizeOfImage
    view.setUint32(optional + 60, HEADERS_SIZE, true); // SizeOfHeaders
    view.setUint16(optional + 68, SUBSYSTEM_CONSOLE, true);
    view.setUint32(optional + 92, 16, true); // NumberOfRvaAndSizes
    view.setUint32(optional + 96, layout.exportDirectoryRva, true);
    view.setUint32(optional + 100, layout.exportDirectorySize, true);

    const section = optional + OPTIONAL_HEADER_SIZE;
    bytes.set(encoder.encode('.text'), section);
    view.setUint32(section + 8, layout.sectionSize, true); // VirtualSize
    view.setUint32(section + 12, SECTION_RVA, true);
    view.setUint32(section + 16, rawSize, true); // SizeOfRawData
    view.setUint32(section + 20, SECTION_RVA, true); // PointerToRawData
    view.setUint32(section + 36, SECTION_CNT_CODE | SECTION_MEM_EXECUTE | SECTION_MEM_READ, true);
}

/**
 * @param {string} text
 * @param {string} what
 */
function requireAscii(text, what){
    if (text.length === 0 || !/^[\x20-\x7e]+$/.test(text))
    {
        throw new Error(`${what} must be a non-empty ASCII string: "${text}"`);
    }
}

/**
 * @param {number} value
 * @param {number} to
 * @returns {number}
 */
function align(value, to){
    return Math.ceil(value / to) * to;
}
