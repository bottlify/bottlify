/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * Walking a PE image's headers in guest memory, as the Rtl image helpers do.
 *
 * The image is read where the caller says it is, never looked up among the
 * loaded modules: a program hands these a module it mapped as data just as
 * often as one the loader placed, and the headers in memory are the truth
 * either way.
 */

/** Where the headers keep what the walk needs. */
/** IMAGE_REL_BASED_*: the base relocation types a block holds. */
const REL_ABSOLUTE = 0;
const REL_HIGH = 1;
const REL_LOW = 2;
const REL_HIGHLOW = 3;
const REL_DIR64 = 10;

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
 * @property {import('../common/guest.js').Guest} guest
 */

/** @param {ImageHost} host */
export function createImageFunctions(host){
    const { guest } = host;

    /**
     * The address of one data directory's contents, or 0.
     *
     * @param {number} base @param {boolean} mapped @param {number} entry @param {number} sizeOut
     */
    const directoryData = (base, mapped, entry, sizeOut)=>{
        if (base === 0 || guest.u16(base) !== DOS_MAGIC)
        {
            return 0;
        }
        const nt = base + guest.u32(base + LFANEW);
        if (guest.u32(nt) !== NT_SIGNATURE)
        {
            return 0;
        }
        const optional = nt + OPTIONAL_AT;
        const countAt = DIRECTORY_COUNT[guest.u16(optional)];
        if (countAt === undefined || entry >= guest.u32(optional + countAt))
        {
            return 0;
        }
        const directory = optional + countAt + 4 + entry * 8;
        const rva = guest.u32(directory);
        if (sizeOut !== 0)
        {
            guest.set32(sizeOut, guest.u32(directory + 4));
        }
        if (rva === 0)
        {
            return 0;
        }
        if (mapped || rva < guest.u32(optional + OPTIONAL_SIZE_OF_HEADERS))
        {
            return (base + rva) >>> 0;
        }
        // A file laid out as on disk: the RVA is found through the section
        // that holds it, and the answer is where that section's bytes sit.
        const sections = optional + guest.u16(nt + FILE_OPTIONAL_SIZE);
        for (let index = 0; index < guest.u16(nt + FILE_SECTION_COUNT); index++)
        {
            const section = sections + index * SECTION_SIZE;
            const start = guest.u32(section + SECTION_VIRTUAL_ADDRESS);
            const span = Math.max(guest.u32(section + SECTION_VIRTUAL_SIZE),
                guest.u32(section + SECTION_RAW_SIZE));
            if (rva >= start && rva < start + span)
            {
                return (base + guest.u32(section + SECTION_RAW_POINTER) + rva - start) >>> 0;
            }
        }
        return 0;
    };

    /**
     * One base relocation of a block applied at `at`, `delta` the distance the
     * image moved: a dword, a word's high or low half, a qword, or nothing.
     * Answers whether the type was one the block may hold.
     *
     * @param {number} type @param {number} at @param {number} delta
     */
    const relocate = (type, at, delta)=>{
        switch (type)
        {
            case REL_ABSOLUTE:
                return true;
            case REL_HIGH:
                guest.set16(at, guest.u16(at) + (delta >>> 16));
                return true;
            case REL_LOW:
                guest.set16(at, guest.u16(at) + delta);
                return true;
            case REL_HIGHLOW:
                guest.set32(at, guest.u32(at) + delta);
                return true;
            case REL_DIR64:
                guest.set64(at, guest.u64(at) + BigInt(delta | 0));
                return true;
            default:
                return false;
        }
    };

    return {
        /**
         * PIMAGE_BASE_RELOCATION LdrProcessRelocationBlock(ULONG_PTR Page,
         *   UINT Count, PUSHORT TypeOffset, LONG_PTR Delta)
         *
         * A base relocation block's entries applied to the page they name,
         * each a type in its top four bits and an offset in the rest; the
         * answer is where the next block starts, or NULL at a type no image
         * holds, where the walk stops.
         */
        LdrProcessRelocationBlock: {
            returns: 'pointer',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([page, count, entries, delta])=>{
                const list = new DataView(guest.snapshot(wholeAddress(entries),
                    (count >>> 0) * 2).buffer);
                for (let i = 0; i < (count >>> 0); i++)
                {
                    const entry = list.getUint16(i * 2, true);
                    if (!relocate(entry >>> 12, (page + (entry & 0xfff)) >>> 0, delta | 0))
                    {
                        return 0;
                    }
                }
                return wholeAddress(entries + (count >>> 0) * 2);
            },
        },

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
            returns: 'pointer',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([base, mappedAsImage, entry, size])=>{
                const address = wholeAddress(base);
                const asData = (address & 1) !== 0;
                try
                {
                    return directoryData((address & ~1) >>> 0,
                        !asData && (mappedAsImage & 0xff) !== 0, entry & 0xffff,
                        wholeAddress(size));
                }
                catch {
                    return 0;
                }
            },
        },
    };
}
