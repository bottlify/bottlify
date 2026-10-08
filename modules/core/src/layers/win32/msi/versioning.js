/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether InstallFiles copies a file over one already there: Windows
 * Installer's file versioning rules, as REINSTALLMODE's letters choose them.
 * A missing file is always put down; `a` puts every file down again. A file
 * with a version is replaced by an older one never, by the same one with `e`,
 * by any other with `d`, and by a newer one with `o` -- the default, as
 * "omus" is. A file with no version -- or one whose version a companion
 * file stands for -- is kept when the MsiFileHash table's hash matches what
 * is there, and otherwise replaced, as an unchanged file of the product's
 * own would be.
 */

/**
 * A version's four parts, or null for text that is not a version (a
 * companion file's key, or nothing).
 *
 * @param {string | null} text @returns {number[] | null}
 */
export function versionParts(text){
    if (text === null || !/^\d+(\.\d+){0,3}$/.test(text.trim()))
    {
        return null;
    }
    const parts = text.trim().split('.').map(Number);
    while (parts.length < 4)
    {
        parts.push(0);
    }
    return parts;
}

/** @param {number[]} left @param {number[]} right @returns {number} */
export const compareVersions = (left, right)=>{
    for (let at = 0; at < 4; at++)
    {
        if (left[at] !== right[at])
        {
            return left[at] < right[at] ? -1 : 1;
        }
    }
    return 0;
};

/**
 * @typedef {Object} ExistingFile
 * @property {string | null} version  Its version resource's, null for none.
 * @property {(() => Promise<Uint8Array | null>)} md5  Its MD5, read only when asked.
 */

/**
 * Whether the package's file replaces the one already at its target.
 *
 * @param {{ version: string | null, hash: Uint8Array | null }} incoming
 *     The package's version for it, and MsiFileHash's MD5 when the table has one.
 * @param {ExistingFile | null} existing  Null when nothing is there.
 * @param {string} mode  REINSTALLMODE.
 * @returns {Promise<boolean>}
 */
export async function replaces(incoming, existing, mode){
    if (!existing)
    {
        return true;
    }
    const letters = mode.toLowerCase();
    if (letters.includes('a'))
    {
        return true;
    }
    const ours = versionParts(incoming.version);
    if (ours)
    {
        const theirs = versionParts(existing.version);
        if (!theirs)
        {
            // A versioned file over one without a version.
            return true;
        }
        const order = compareVersions(theirs, ours);
        return (letters.includes('d') && order !== 0) || (letters.includes('e') && order <= 0)
            || (letters.includes('o') && order < 0);
    }
    if (incoming.hash)
    {
        const md5 = await existing.md5();
        if (md5 && md5.length === incoming.hash.length
            && md5.every((byte, index)=>byte === incoming.hash?.[index]))
        {
            return false;
        }
    }
    return letters.includes('o') || letters.includes('e') || letters.includes('d');
}
