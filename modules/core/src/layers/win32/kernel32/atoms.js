/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The atom table: strings a program interns to compare by number.
 *
 * An installer registers a name -- a window class, a shared identifier -- and
 * hands the resulting ATOM around instead of the string; another part of the
 * same process finds the atom back by the same name and the two agree without
 * carrying the text. So the whole of what this has to get right is that a name
 * added and a name found return the same atom, that the count of adds is
 * matched by deletes before the entry goes, and that a name-that-is-really-an-
 * integer (`#1234`, or a MAKEINTATOM value) is that integer and not a string.
 *
 * One table, not the local/global split Windows draws: there is one process
 * here, so the two are the same table, and Add/Global-Add reach it alike.
 * Names are compared case-insensitively, as Windows compares them.
 */

import { encodeAnsi } from './locale.js';

/** Atoms a caller allocates start here; below it are the integer atoms. */
const FIRST_ATOM = 0xc000;
/** The top of the string-atom range; above it a value is not an atom. */
const LAST_ATOM = 0xffff;
/** A value below this, passed as a name, is an integer atom, not a pointer. */
const MAX_INTEGER_ATOM = 0x10000;
/** ERROR_SUCCESS, cleared on the calls that report through the error slot. */
const ERROR_SUCCESS = 0;
/** A name longer than this is a pointer that is not a string. */
const MAX_ATOM_NAME = 255;

/**
 * @typedef {Object} AtomHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(code: number) => void} [setLastError]
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against; all
 * of these are stdcall, the bridge's default.
 *
 * @param {AtomHost} host
 */
export function createAtomFunctions(host){
    /** @type {Map<string, { atom: number, count: number }>} */
    const byName = new Map();
    /** @type {Map<number, string>} */
    const byAtom = new Map();
    let next = FIRST_ATOM;

    /**
     * A name argument: below 64 KiB it is an integer atom passed by value, so
     * it is returned as itself; otherwise it is a pointer to a string.
     *
     * @param {number} pointer @param {boolean} [wide]
     * @returns {{ integer: number } | { text: string }}
     */
    const nameOf = (pointer, wide = false)=>{
        const raw = pointer >>> 0;
        if (raw < MAX_INTEGER_ATOM)
        {
            return { integer: raw };
        }
        return { text: wide ? host.readWideString?.(raw, MAX_ATOM_NAME) ?? ''
            : host.readCString(raw, MAX_ATOM_NAME) };
    };

    /** @param {number} pointer @param {boolean} [wide] @returns {number} */
    const add = (pointer, wide = false)=>{
        const name = nameOf(pointer, wide);
        if ('integer' in name)
        {
            return name.integer;
        }
        const key = name.text.toLowerCase();
        const known = byName.get(key);
        if (known)
        {
            known.count++;
            return known.atom;
        }
        if (next > LAST_ATOM)
        {
            return 0;
        }
        const atom = next++;
        byName.set(key, { atom, count: 1 });
        byAtom.set(atom, name.text);
        host.setLastError?.(ERROR_SUCCESS);
        return atom;
    };

    /** @param {number} pointer @param {boolean} [wide] @returns {number} */
    const find = (pointer, wide = false)=>{
        const name = nameOf(pointer, wide);
        if ('integer' in name)
        {
            return name.integer;
        }
        return byName.get(name.text.toLowerCase())?.atom ?? 0;
    };

    /** @param {number} atom @returns {number} zero on success, the atom on failure */
    const remove = atom=>{
        const value = atom >>> 0;
        if (value < FIRST_ATOM)
        {
            // An integer atom is not reference counted and cannot be deleted.
            return 0;
        }
        const text = byAtom.get(value);
        if (text === undefined)
        {
            return value;
        }
        const key = text.toLowerCase();
        const entry = /** @type {{ atom: number, count: number }} */ (byName.get(key));
        entry.count--;
        if (entry.count <= 0)
        {
            byName.delete(key);
            byAtom.delete(value);
        }
        return 0;
    };

    /** @param {string} text @returns {Uint8Array} UTF-16LE */
    const encodeWide = text=>{
        const out = new Uint8Array(text.length * 2);
        for (let at = 0; at < text.length; at++)
        {
            out[at * 2] = text.charCodeAt(at) & 0xff;
            out[at * 2 + 1] = text.charCodeAt(at) >>> 8;
        }
        return out;
    };

    /**
     * The name, in the ANSI page it was read in or in UTF-16; the size is in
     * characters of the form asked for.
     *
     * @param {number} atom @param {number} buffer @param {number} size
     * @param {boolean} [wide]
     * @returns {number} the length written, without the terminator
     */
    const name = (atom, buffer, size, wide = false)=>{
        const value = atom >>> 0;
        const text = value < FIRST_ATOM ? `#${value}` : byAtom.get(value);
        if (text === undefined || (size >>> 0) === 0)
        {
            return 0;
        }
        const kept = text.slice(0, (size >>> 0) - 1);
        host.writeMemory(buffer >>> 0, wide ? encodeWide(`${kept}\0`) : encodeAnsi(`${kept}\0`));
        return kept.length;
    };

    return {
        /** ATOM AddAtomA(LPCSTR lpString) -- and the global spelling, one table. */
        AddAtomA: { argBytes: 4, handler: (/** @type {number[]} */ [p])=>add(p) },
        GlobalAddAtomA: { argBytes: 4, handler: (/** @type {number[]} */ [p])=>add(p) },

        /** ATOM FindAtomA(LPCSTR lpString) */
        FindAtomA: { argBytes: 4, handler: (/** @type {number[]} */ [p])=>find(p) },
        GlobalFindAtomA: { argBytes: 4, handler: (/** @type {number[]} */ [p])=>find(p) },

        /** ATOM AddAtomW(LPCWSTR lpString), FindAtomW and the global spellings: one table */
        AddAtomW: { argBytes: 4, handler: (/** @type {number[]} */ [p])=>add(p, true) },
        GlobalAddAtomW: { argBytes: 4, handler: (/** @type {number[]} */ [p])=>add(p, true) },
        FindAtomW: { argBytes: 4, handler: (/** @type {number[]} */ [p])=>find(p, true) },
        GlobalFindAtomW: { argBytes: 4, handler: (/** @type {number[]} */ [p])=>find(p, true) },

        /** ATOM DeleteAtom(ATOM nAtom) -- zero on success, the atom back on failure. */
        DeleteAtom: { argBytes: 4, handler: (/** @type {number[]} */ [a])=>remove(a) },
        GlobalDeleteAtom: { argBytes: 4, handler: (/** @type {number[]} */ [a])=>remove(a) },

        /** UINT GetAtomNameA(ATOM nAtom, LPSTR lpBuffer, int nSize) */
        GetAtomNameA: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [atom, buffer, size])=>name(atom, buffer, size),
        },
        GlobalGetAtomNameA: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [atom, buffer, size])=>name(atom, buffer, size),
        },

        /** UINT GetAtomNameW(ATOM nAtom, LPWSTR lpBuffer, int nSize) -- the same table */
        GetAtomNameW: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [atom, buffer, size])=>name(atom, buffer, size, true),
        },
        GlobalGetAtomNameW: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [atom, buffer, size])=>name(atom, buffer, size, true),
        },
    };
}
