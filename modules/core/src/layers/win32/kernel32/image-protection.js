/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The protection each page of a mapped image has, as Windows' loader gives
 * it: the headers read-only, each section by its characteristics, a page no
 * section covers closed. Read from the image's own headers where it lies in
 * memory, so what a program finds there is what VirtualQuery answers.
 */

const PAGE_SIZE = 4096;

const PAGE_NOACCESS = 0x01;
const PAGE_READONLY = 0x02;
const PAGE_READWRITE = 0x04;
const PAGE_WRITECOPY = 0x08;
const PAGE_EXECUTE = 0x10;
const PAGE_EXECUTE_READ = 0x20;
const PAGE_EXECUTE_READWRITE = 0x40;
const PAGE_EXECUTE_WRITECOPY = 0x80;

/** What a whole image is mapped with, VirtualQuery's AllocationProtect for it. */
export const IMAGE_ALLOCATION_PROTECT = PAGE_EXECUTE_WRITECOPY;

const IMAGE_SCN_MEM_SHARED = 0x10000000;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
const IMAGE_SCN_MEM_READ = 0x40000000;
const IMAGE_SCN_MEM_WRITE = 0x80000000;

/** A section header: VirtualSize at 8, VirtualAddress at 12, Characteristics at 36. */
const SECTION_HEADER_SIZE = 40;

/**
 * The page protection a section's characteristics give it. A writable
 * section is copy-on-write unless it is shared: the image's pages belong to
 * every process that maps it until one writes.
 *
 * @param {number} characteristics
 */
export function sectionProtection(characteristics){
    const execute = (characteristics & IMAGE_SCN_MEM_EXECUTE) !== 0;
    const read = (characteristics & IMAGE_SCN_MEM_READ) !== 0;
    const write = (characteristics & IMAGE_SCN_MEM_WRITE) !== 0;
    const shared = (characteristics & IMAGE_SCN_MEM_SHARED) !== 0;
    if (write)
    {
        return execute ? (shared ? PAGE_EXECUTE_READWRITE : PAGE_EXECUTE_WRITECOPY)
            : (shared ? PAGE_READWRITE : PAGE_WRITECOPY);
    }
    if (execute)
    {
        return read ? PAGE_EXECUTE_READ : PAGE_EXECUTE;
    }
    return read ? PAGE_READONLY : PAGE_NOACCESS;
}

/**
 * The image at `base` as runs of pages and their protections, in order from
 * the base to the end of its SizeOfImage; null where the bytes there are no
 * image's headers (a packer that wiped its own, a block not yet filled).
 *
 * @param {(address: number, length: number) => Uint8Array} read
 * @param {number} base
 * @returns {{ size: number, runs: { from: number, to: number, protect: number }[] } | null}
 */
export function imageLayout(read, base){
    const dos = read(base, 64);
    const dosView = new DataView(dos.buffer, dos.byteOffset, dos.byteLength);
    if (dos.byteLength < 64 || dosView.getUint16(0, true) !== 0x5a4d)
    {
        return null;
    }
    const nt = base + dosView.getUint32(0x3c, true);
    const header = read(nt, 24 + 0x40);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (header.byteLength < 24 + 0x40 || view.getUint32(0, true) !== 0x00004550)
    {
        return null;
    }
    const sections = view.getUint16(6, true);
    const optionalSize = view.getUint16(20, true);
    // SizeOfImage and SizeOfHeaders sit at the same offsets in both widths.
    const sizeOfImage = view.getUint32(24 + 56, true);
    const sizeOfHeaders = view.getUint32(24 + 60, true);
    const size = roundUp(sizeOfImage);
    const table = read(nt + 24 + optionalSize, sections * SECTION_HEADER_SIZE);
    const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
    if (table.byteLength < sections * SECTION_HEADER_SIZE || size === 0)
    {
        return null;
    }
    /** @type {number[]} */
    const pages = new Array(size / PAGE_SIZE).fill(PAGE_NOACCESS);
    const headerPages = Math.min(pages.length, roundUp(Math.max(sizeOfHeaders, 1)) / PAGE_SIZE);
    pages.fill(PAGE_READONLY, 0, headerPages);
    for (let index = 0; index < sections; index++)
    {
        const at = index * SECTION_HEADER_SIZE;
        const virtualSize = tableView.getUint32(at + 8, true);
        const address = tableView.getUint32(at + 12, true);
        const rawSize = tableView.getUint32(at + 16, true);
        const characteristics = tableView.getUint32(at + 36, true);
        const length = roundUp(virtualSize || rawSize);
        const first = Math.floor(address / PAGE_SIZE);
        const last = Math.min(pages.length, first + length / PAGE_SIZE);
        pages.fill(sectionProtection(characteristics), first, last);
    }
    /** @type {{ from: number, to: number, protect: number }[]} */
    const runs = [];
    for (let page = 0; page < pages.length; page++)
    {
        const last = runs.at(-1);
        if (last && last.protect === pages[page])
        {
            last.to += PAGE_SIZE;
        }
        else
        {
            runs.push({ from: page * PAGE_SIZE, to: (page + 1) * PAGE_SIZE, protect: pages[page] });
        }
    }
    return { size, runs };
}

/** @param {number} value */
function roundUp(value){
    return Math.ceil(value / PAGE_SIZE) * PAGE_SIZE;
}
