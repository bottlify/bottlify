/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IniFileMapping: the profile sections Windows keeps in the registry rather
 * than in the file they are named by.
 *
 * Under HKLM\Software\Microsoft\Windows NT\CurrentVersion\IniFileMapping a key
 * named for a profile file (its name alone: the directory does not count)
 * says where that file's sections live. In it:
 *
 * - a value named for a section maps the whole section to one key, each
 *   profile key a value there;
 * - the key's default value maps every section it does not name, each to a
 *   key of the section's name beneath the place it gives;
 * - a subkey named for a section maps the section name by name: each of its
 *   values names the place of the profile key of that name, and its default
 *   the place of every other; a name with no place of its own and no default
 *   stays in the file.
 *
 * A place is `USR:` and a path under HKEY_CURRENT_USER, or `SYS:` and a path
 * under HKLM\Software. The flags `!`, `#` and `@` before it (write the file
 * too, seed the registry from the file at logon, never read the file) change
 * what a logon and the file do, not where a value is, and are read past.
 * Only string values are profile strings: any other type reads as absent.
 */

import { decodeAnsi, encodeAnsi } from './locale.js';

/** Where the mappings are. */
export const INI_FILE_MAPPING = 'Software\\Microsoft\\Windows NT\\CurrentVersion\\IniFileMapping';

const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const REG_SZ = 1;

/** @typedef {{ name: string, type: number, data: Uint8Array }} MappingValue */

/**
 * The registry calls the mapping reads and writes through: the run's registry
 * service (`advapi32/registry-service.js`), keys named by number.
 *
 * @typedef {Object} MappingRegistry
 * @property {(root: number) => number | null} root
 * @property {(key: number, path?: string | null) => number | null} open
 * @property {(key: number, path?: string | null) => { key: number, created: boolean }} create
 * @property {(key: number) => string[]} subkeys
 * @property {(key: number) => MappingValue[]} values
 * @property {(key: number, name: string) => MappingValue | null} getValue
 * @property {(key: number, name: string, type: number, data: Uint8Array,
 *     exact?: boolean) => unknown} setValue
 * @property {(key: number, name: string) => boolean} deleteValue
 */

/**
 * A registry place a profile key lives at.
 *
 * @typedef {{ root: number, path: string }} Place
 */

/**
 * Where one section's keys live: one place for all of them, or a place per
 * name with a default place (or the file, for none) for the rest.
 *
 * @typedef {{ whole: Place } | { names: Map<string, { name: string, place: Place }>,
 *     rest: Place | null }} SectionMapping
 */

const sameName = (/** @type {string} */ left, /** @type {string} */ right)=>
    left.toLowerCase() === right.toLowerCase();

/** @param {Uint8Array} data */
const stringOf = data=>decodeAnsi(data).replace(/\0+$/, '');

/**
 * The place a mapping value names, or null for one that names none.
 *
 * @param {{ type: number, data: Uint8Array } | null} value
 * @returns {Place | null}
 */
const placeOf = value=>{
    if (!value || value.type !== REG_SZ)
    {
        return null;
    }
    const match = /^[!#@]*(USR|SYS):(.*)$/i.exec(stringOf(value.data));
    if (!match)
    {
        return null;
    }
    return match[1].toUpperCase() === 'USR'
        ? { root: HKEY_CURRENT_USER, path: match[2] }
        : { root: HKEY_LOCAL_MACHINE, path: `Software\\${match[2]}` };
};

/** @param {MappingRegistry} registry */
export function createIniMapping(registry){
    /**
     * @param {Place} place @param {boolean} [create]
     * @returns {number | null}
     */
    const keyAt = (place, create = false)=>{
        const root = registry.root(place.root);
        if (root === null)
        {
            return null;
        }
        return create ? registry.create(root, place.path).key : registry.open(root, place.path);
    };

    /**
     * The mapping key of the file at `path`, by its name alone.
     *
     * @param {string} path @returns {number | null}
     */
    const fileKey = path=>{
        const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
        const machine = registry.root(HKEY_LOCAL_MACHINE);
        return machine === null || name === ''
            ? null
            : registry.open(machine, `${INI_FILE_MAPPING}\\${name}`);
    };

    /**
     * Where a section of the file lives, or null for the file itself.
     *
     * @param {string} path @param {string} name
     * @returns {SectionMapping | null}
     */
    const section = (path, name)=>{
        const mapping = fileKey(path);
        if (mapping === null)
        {
            return null;
        }
        const named = registry.subkeys(mapping).find(sub=>sameName(sub, name));
        if (named !== undefined)
        {
            const sub = /** @type {number} */ (registry.open(mapping, named));
            /** @type {Map<string, { name: string, place: Place }>} */
            const names = new Map();
            for (const value of registry.values(sub))
            {
                const place = value.name === '' ? null : placeOf(value);
                if (place)
                {
                    names.set(value.name.toLowerCase(), { name: value.name, place });
                }
            }
            return { names, rest: placeOf(registry.getValue(sub, '')) };
        }
        const whole = placeOf(registry.values(mapping)
            .find(value=>value.name !== '' && sameName(value.name, name)) ?? null);
        if (whole)
        {
            return { whole };
        }
        const fallback = placeOf(registry.getValue(mapping, ''));
        return fallback
            ? { whole: { root: fallback.root, path: `${fallback.path}\\${name}` } }
            : null;
    };

    /**
     * The place of one profile key of a mapped section, or null for the file.
     *
     * @param {SectionMapping} mapped @param {string} key
     */
    const placeFor = (mapped, key)=>('whole' in mapped
        ? mapped.whole
        : mapped.names.get(key.toLowerCase())?.place ?? mapped.rest);

    /**
     * A profile key's string at a place, or null when it is not there or is
     * not a string.
     *
     * @param {Place} place @param {string} key
     */
    const read = (place, key)=>{
        const at = keyAt(place);
        const value = at === null ? null : registry.getValue(at, key);
        return value && value.type === REG_SZ ? stringOf(value.data) : null;
    };

    /**
     * The string entries at a place, in the order they were written.
     *
     * @param {Place} place @returns {{ name: string, value: string }[]}
     */
    const entries = place=>{
        const at = keyAt(place);
        return at === null ? [] : registry.values(at)
            .filter(value=>value.name !== '' && value.type === REG_SZ)
            .map(value=>({ name: value.name, value: stringOf(value.data) }));
    };

    return {
        section,

        /**
         * A key's value in a mapped section: the string, null when the
         * registry does not have it, undefined when the key stays in the file.
         *
         * @param {SectionMapping} mapped @param {string} key
         * @returns {string | null | undefined}
         */
        get(mapped, key){
            const place = placeFor(mapped, key);
            return place ? read(place, key) : undefined;
        },

        /**
         * The section's entries the registry holds, in order, and whether the
         * file's entries count too (for names no mapping claims).
         *
         * @param {SectionMapping} mapped
         * @returns {{ entries: { name: string, value: string }[], file: boolean,
         *     claimed: (name: string) => boolean }}
         */
        list(mapped){
            if ('whole' in mapped)
            {
                return { entries: entries(mapped.whole), file: false, claimed: ()=>true };
            }
            /** @type {{ name: string, value: string }[]} */
            const found = [];
            for (const { name, place } of mapped.names.values())
            {
                const value = read(place, name);
                if (value !== null)
                {
                    found.push({ name, value });
                }
            }
            if (mapped.rest)
            {
                found.push(...entries(mapped.rest)
                    .filter(entry=>!mapped.names.has(entry.name.toLowerCase())));
            }
            return { entries: found, file: mapped.rest === null,
                claimed: name=>mapped.rest !== null || mapped.names.has(name.toLowerCase()) };
        },

        /**
         * Writes a key of a mapped section, or removes it for a null value.
         * False when the key stays in the file.
         *
         * @param {SectionMapping} mapped @param {string} key @param {string | null} value
         */
        put(mapped, key, value){
            const place = placeFor(mapped, key);
            if (!place)
            {
                return false;
            }
            if (value === null)
            {
                const at = keyAt(place);
                if (at !== null)
                {
                    registry.deleteValue(at, key);
                }
                return true;
            }
            const at = keyAt(place, true);
            if (at !== null)
            {
                registry.setValue(at, key, REG_SZ, encodeAnsi(`${value}\0`), true);
            }
            return true;
        },

        /**
         * Removes every value a mapped section holds in the registry; its
         * keys stay, and one not there is made, as Windows leaves them (a
         * program deletes the key of a name it never wrote after the section
         * was removed).
         *
         * @param {SectionMapping} mapped
         */
        clear(mapped){
            const places = 'whole' in mapped
                ? [{ place: mapped.whole, only: null }]
                : [...[...mapped.names.values()].map(({ name, place })=>({ place, only: name })),
                    ...mapped.rest ? [{ place: mapped.rest, only: null }] : []];
            for (const { place, only } of places)
            {
                const at = keyAt(place, true);
                if (at === null)
                {
                    continue;
                }
                const names = only === null
                    ? registry.values(at).map(value=>value.name)
                    : [only];
                for (const name of names)
                {
                    registry.deleteValue(at, name);
                }
            }
        },

        /**
         * The names of the file's sections the registry maps, in the order
         * the mapping lists them: named values, then subkeys.
         *
         * @param {string} path @returns {string[]}
         */
        sectionNames(path){
            const mapping = fileKey(path);
            if (mapping === null)
            {
                return [];
            }
            return [...registry.values(mapping).filter(value=>value.name !== '')
                .map(value=>value.name), ...registry.subkeys(mapping)];
        },
    };
}
