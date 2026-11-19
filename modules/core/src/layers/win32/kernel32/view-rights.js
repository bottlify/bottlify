/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a view of a section may be: the FILE_MAP_* a section's protection
 * allows (MapViewOfFile asks within them), the protection a view starts with
 * from its access, and what VirtualProtect may give its pages later - no
 * access its view was not mapped with, an image's writes its own copies.
 * mapping.js maps views by it, heap.js protects their pages by it.
 */

const PAGE_MASK = 0xff;
const FILE_MAP_COPY = 0x0001;
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_READ = 0x0004;
const SECTION_MAP_EXECUTE = 0x0008;
const FILE_MAP_EXECUTE = 0x0020;

/**
 * What a section's protection lets a view of it, and a page of one, be:
 * reading always, writing where it is read-write, executing where it is
 * executable (MapViewOfFile's and VirtualProtect's contract: a view's
 * access, and a protection given to its pages later, are within the
 * section's).
 *
 * @param {number} page  the section's PAGE_* protection
 * @returns {number} FILE_MAP_* rights
 */
export function sectionRights(page){
    const read = FILE_MAP_READ | FILE_MAP_COPY;
    const execute = SECTION_MAP_EXECUTE | FILE_MAP_EXECUTE;
    switch (page & PAGE_MASK)
    {
        case 0x04: return read | FILE_MAP_WRITE;
        case 0x40: return read | FILE_MAP_WRITE | execute;
        case 0x02: case 0x08: return read;
        case 0x10: case 0x20: case 0x80: return read | execute;
        default: return 0;
    }
}

/**
 * The protection a view mapped with `access` starts with: written through
 * where it may write, read where it may read, its own copy where it asked for
 * that and nothing else, no access otherwise; each executable with
 * FILE_MAP_EXECUTE.
 *
 * @param {number} access  FILE_MAP_*
 * @returns {number} PAGE_*
 */
export function viewProtection(access){
    const execute = (access & FILE_MAP_EXECUTE) !== 0;
    return (access & FILE_MAP_WRITE) !== 0 ? execute ? 0x40 : 0x04
        : (access & FILE_MAP_READ) !== 0 ? execute ? 0x20 : 0x02
            : (access & ~FILE_MAP_EXECUTE) === FILE_MAP_COPY ? execute ? 0x80 : 0x08 : 0x01;
}

/**
 * What a page protection lets the processor do, as bits: 1 reading, 2
 * writing, 4 executing. A copy-on-write page reads (its writes are its own
 * copy's); PAGE_NOACCESS does nothing.
 *
 * @param {number} page  PAGE_*
 * @returns {number}
 */
export function pageAccess(page){
    switch (page & PAGE_MASK)
    {
        case 0x02: case 0x08: return 1;
        case 0x04: return 3;
        case 0x10: case 0x20: case 0x80: return 5;
        case 0x40: return 7;
        default: return 0;
    }
}

/**
 * Whether a view's page may take `page`, given the protection the view was
 * mapped with (its AllocationProtect): VirtualProtect, and a commit over a
 * page-file section's view, give a page no access its view does not have.
 *
 * @param {number} allocation  the view's PAGE_* AllocationProtect
 * @param {number} page  the PAGE_* asked for
 * @returns {boolean}
 */
export function protectionWithin(allocation, page){
    return (pageAccess(allocation) & pageAccess(page)) === pageAccess(page);
}

/**
 * The protection an image's page takes when `page` is asked of it: an image
 * is never written through, so a writable protection is its copy-on-write
 * form, as Windows protects a SEC_IMAGE view's pages.
 *
 * @param {number} page  PAGE_*
 * @returns {number}
 */
export function imageWriteCopy(page){
    const base = page & PAGE_MASK;
    const copied = base === 0x04 ? 0x08 : base === 0x40 ? 0x80 : base;
    return (page & ~PAGE_MASK) | copied;
}

/**
 * Whether `page` is copy-on-write: PAGE_WRITECOPY or PAGE_EXECUTE_WRITECOPY,
 * whose first write gives the process a page of its own.
 *
 * @param {number} page  PAGE_*
 * @returns {boolean}
 */
export function copyOnWrite(page){
    const base = page & PAGE_MASK;
    return base === 0x08 || base === 0x80;
}

/**
 * The protection a copy-on-write page has once it is written: the copy is
 * the process's own, read-write (or executable read-write), as VirtualQuery
 * then answers on Windows; any other protection is left as it is.
 *
 * @param {number} page  PAGE_*
 * @returns {number}
 */
export function writtenCopy(page){
    const base = page & PAGE_MASK;
    const written = base === 0x08 ? 0x04 : base === 0x80 ? 0x40 : base;
    return (page & ~PAGE_MASK) | written;
}
