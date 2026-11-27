/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The font files a program adds to the system's table: AddFontResource(Ex)
 * and RemoveFontResource(Ex).
 *
 * A game ships its own .ttf and adds it before CreateFont names its family;
 * without it the family is not there, and the text falls back to another
 * face. The file is read from the volume, its families named from its own
 * `name` table, and each handed to the font engine to draw with. Windows
 * counts the adds of one file: as many removes as adds take it out again,
 * and a remove whose flags (FR_PRIVATE, FR_NOT_ENUM) are not the add's
 * fails. A face added without FR_NOT_ENUM is enumerated with the system's.
 * A face added measures by its own em square and cell ('head', 'OS/2').
 * A .fot, the scalable font resource CreateScalableFontResource writes for
 * a TrueType file, is not read: it names no family of its own.
 */

import { fontFaces } from './faces.js';

/** AddFontResourceEx's flags: private to the process, and kept out of enumeration. */
const FR_PRIVATE = 0x10;
const FR_NOT_ENUM = 0x20;

/** Where a bare file name is looked for when it is not where the program stands. */
const FONTS_FOLDER = 'C:\\WINDOWS\\Fonts\\';

/**
 * @typedef {Object} FontResourceHost
 * @property {(path: string) => Promise<Uint8Array | null>} [readFile]
 *           The file's bytes from the volume, null where there is none.
 * @property {(path: string) => string} [fullPath]
 *           A path as the program's current directory makes it absolute.
 * @property {(family: string, bytes: Uint8Array) => Promise<boolean> | boolean} [addFont]
 *           The font engine, to draw a family with; absent where there is none.
 */

/**
 * @typedef {Object} AddedFont
 * @property {string} path
 * @property {number} flags  FR_PRIVATE and FR_NOT_ENUM as added.
 * @property {number} count  The adds not yet removed.
 * @property {string[]} families
 * @property {Map<string, import('./faces.js').OutlineCell>} cells  By lowercase family.
 */

/** @param {FontResourceHost} host */
export function createFontResources(host){
    /** @type {Map<string, AddedFont>} */
    const added = new Map();
    const flagsOf = (/** @type {number} */ flags)=>(flags >>> 0) & (FR_PRIVATE | FR_NOT_ENUM);
    /**
     * Where a name leads; null for one that is no path at all (empty, or a
     * component the file system refuses), which names no font.
     *
     * @param {string} name
     */
    const pathOf = name=>{
        if (name === '')
        {
            return null;
        }
        try
        {
            return host.fullPath?.(name) ?? name;
        }
        catch {
            return null;
        }
    };

    /**
     * Adds a file: the number of faces it holds, zero for a name that is no
     * font file here.
     *
     * @param {string} name @param {number} flags
     * @returns {Promise<number>}
     */
    const add = async(name, flags)=>{
        const path = pathOf(name);
        if (path === null)
        {
            return 0;
        }
        const key = path.toLowerCase();
        const known = added.get(key);
        if (known)
        {
            if (known.flags !== flagsOf(flags))
            {
                return 0;
            }
            known.count++;
            return known.families.length;
        }
        let bytes = await host.readFile?.(path) ?? null;
        if (!bytes && !/[\\/:]/.test(name))
        {
            bytes = await host.readFile?.(FONTS_FOLDER + name) ?? null;
        }
        const faces = bytes ? fontFaces(bytes) : [];
        if (!bytes || faces.length === 0)
        {
            return 0;
        }
        const unique = [...new Set(faces.map(face=>face.family))];
        const cells = new Map(faces.flatMap(face=>(face.cell
            ? [[face.family.toLowerCase(), face.cell]] : [])));
        if (host.addFont)
        {
            await Promise.all(unique.map(family=>host.addFont?.(family, bytes)));
        }
        added.set(key, { path, flags: flagsOf(flags), count: 1, families: unique, cells });
        return faces.length;
    };

    /**
     * Takes back one add of a file: nonzero when it was added with these
     * flags. The face stays drawable; a run keeps the fonts it was given.
     *
     * @param {string} name @param {number} flags
     * @returns {number}
     */
    const remove = (name, flags)=>{
        const key = pathOf(name)?.toLowerCase();
        const known = key === undefined ? undefined : added.get(key);
        if (!known || known.flags !== flagsOf(flags))
        {
            return 0;
        }
        if (--known.count === 0 && key !== undefined)
        {
            added.delete(key);
        }
        return 1;
    };

    /** The families enumerated with the system's faces: those added without FR_NOT_ENUM. */
    const enumerable = ()=>[...new Set([...added.values()]
        .filter(entry=>(entry.flags & FR_NOT_ENUM) === 0)
        .flatMap(entry=>entry.families))];

    /**
     * The cell of a family added and not yet removed, enumerable or not.
     *
     * @param {string} family
     */
    const cellOf = family=>{
        const wanted = family.toLowerCase();
        for (const entry of added.values())
        {
            const cell = entry.cells.get(wanted);
            if (cell)
            {
                return cell;
            }
        }
        return undefined;
    };

    return { add, remove, enumerable, cellOf };
}
