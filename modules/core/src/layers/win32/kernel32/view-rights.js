/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a view of a section may be, as rights: the FILE_MAP_* a section's
 * protection allows (MapViewOfFile asks within them), the protection a view
 * starts with from its access, and what VirtualProtect may give its pages
 * later. mapping.js maps views by it, heap.js protects their pages by it.
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
 * What VirtualProtect may later give a view's pages, as rights
 * (`protectionRights`): what its access asked - reading for FILE_MAP_READ or
 * FILE_MAP_COPY, writing for FILE_MAP_WRITE, executing for FILE_MAP_EXECUTE -
 * within its section's.
 *
 * @param {number} access  FILE_MAP_*
 * @param {number} section  the section's PAGE_* protection
 * @returns {number}
 */
export function viewRights(access, section){
    const asked = ((access & (FILE_MAP_READ | FILE_MAP_COPY | FILE_MAP_WRITE)) !== 0
        ? FILE_MAP_READ : 0)
        | (access & FILE_MAP_WRITE) | ((access & FILE_MAP_EXECUTE) !== 0 ? SECTION_MAP_EXECUTE : 0);
    return asked & sectionRights(section);
}

/**
 * The FILE_MAP_* rights a page protection needs of its section: none for
 * PAGE_NOACCESS, reading for any readable one (a copy-on-write page among
 * them, whose writes are its own), writing for a read-write one.
 *
 * @param {number} page  PAGE_*
 * @returns {number}
 */
export function protectionRights(page){
    const base = page & PAGE_MASK;
    const reads = [0x02, 0x04, 0x08, 0x20, 0x40, 0x80].includes(base) ? FILE_MAP_READ : 0;
    const writes = [0x04, 0x40].includes(base) ? FILE_MAP_WRITE : 0;
    const executes = base >= 0x10 ? SECTION_MAP_EXECUTE : 0;
    return reads | writes | executes;
}
