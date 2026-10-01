/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Walking a PE image's headers in guest memory, as the Rtl image helpers do.
 *
 * The image is read where the caller says it is, never looked up among the
 * loaded modules: a program hands these a module it mapped as data just as
 * often as one the loader placed, and the headers in memory are the truth
 * either way.
 */

/** Where the headers keep what the walk needs. */
const DOS_MAGIC = 0x5a4d;
const NT_SIGNATURE = 0x00004550;
const LFANEW = 0x3c;
const FILE_SECTION_COUNT = 6;
const FILE_OPTIONAL_SIZE = 20;
const OPTIONAL_AT = 24;
const OPTIONAL_SIZE_OF_HEADERS = 60;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
/** NumberOfRvaAndSizes, and the directory array after it, per optional-header kind. */
/** @type {Readonly<Record<number, number>>} */
const DIRECTORY_COUNT = Object.freeze({ [PE32_MAGIC]: 92, [PE32_PLUS_MAGIC]: 108 });
const SECTION_SIZE = 40;
const SECTION_VIRTUAL_SIZE = 8;
const SECTION_VIRTUAL_ADDRESS = 12;
const SECTION_RAW_SIZE = 16;
const SECTION_RAW_POINTER = 20;

/**
 * @typedef {Object} ImageHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/** @param {ImageHost} host */
export function createImageFunctions(host){
    /** @param {number} at */
    const u16 = at=>{
        const bytes = host.readMemory(at, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} at */
    const u32 = at=>{
        const bytes = host.readMemory(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /**
     * The address of one data directory's contents, or 0.
     *
     * @param {number} base @param {boolean} mapped @param {number} entry @param {number} sizeOut
     */
    const directoryData = (base, mapped, entry, sizeOut)=>{
        if (base === 0 || u16(base) !== DOS_MAGIC)
        {
            return 0;
        }
        const nt = base + u32(base + LFANEW);
        if (u32(nt) !== NT_SIGNATURE)
        {
            return 0;
        }
        const optional = nt + OPTIONAL_AT;
        const countAt = DIRECTORY_COUNT[u16(optional)];
        if (countAt === undefined || entry >= u32(optional + countAt))
        {
            return 0;
        }
        const directory = optional + countAt + 4 + entry * 8;
        const rva = u32(directory);
        if (sizeOut !== 0)
        {
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setUint32(0, u32(directory + 4), true);
            host.writeMemory(sizeOut, bytes);
        }
        if (rva === 0)
        {
            return 0;
        }
        if (mapped || rva < u32(optional + OPTIONAL_SIZE_OF_HEADERS))
        {
            return (base + rva) >>> 0;
        }
        // A file laid out as on disk: the RVA is found through the section
        // that holds it, and the answer is where that section's bytes sit.
        const sections = optional + u16(nt + FILE_OPTIONAL_SIZE);
        for (let index = 0; index < u16(nt + FILE_SECTION_COUNT); index++)
        {
            const section = sections + index * SECTION_SIZE;
            const start = u32(section + SECTION_VIRTUAL_ADDRESS);
            const span = Math.max(u32(section + SECTION_VIRTUAL_SIZE),
                u32(section + SECTION_RAW_SIZE));
            if (rva >= start && rva < start + span)
            {
                return (base + u32(section + SECTION_RAW_POINTER) + rva - start) >>> 0;
            }
        }
        return 0;
    };

    return {
        /**
         * PVOID RtlImageDirectoryEntryToData(PVOID BaseOfImage, BOOLEAN MappedAsImage,
         *                                    USHORT DirectoryEntry, PULONG Size)
         *
         * NULL for anything that is not a PE image, a directory the image does
         * not have, or an RVA no section holds. A base with its low bit set is
         * a module loaded as a data file, laid out as on disk whatever the
         * flag says. Headers that cannot be read are NULL rather than a fault,
         * as the real walk is guarded.
         */
        RtlImageDirectoryEntryToData: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([base, mappedAsImage, entry, size])=>{
                const address = base >>> 0;
                const asData = (address & 1) !== 0;
                try
                {
                    return directoryData((address & ~1) >>> 0,
                        !asData && (mappedAsImage & 0xff) !== 0, entry & 0xffff, size >>> 0);
                }
                catch {
                    return 0;
                }
            },
        },
    };
}
