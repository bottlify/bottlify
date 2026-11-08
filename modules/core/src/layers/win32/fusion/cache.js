/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The global assembly cache as folders on the volume, laid out as Windows
 * lays it: under `<windows>\assembly` for the runtimes before 4 and under
 * `<windows>\Microsoft.NET\assembly` for 4, a folder for each processor kind
 * (GAC_32, GAC_64, GAC_Arm64, GAC_MSIL, and GAC for the first runtimes), in
 * it a folder for each simple name, in that one a folder for each version,
 * `1.0.0.0_<culture>_<token>` (`v4.0_` before it in the second cache), and in
 * that the files. What a cached assembly is - its name, version, culture and
 * token - is read from those folder names, as the cache's own lookups and
 * Wine's test of them read it; nothing is kept beside the folders, so what a
 * program or a setup put there by hand is in the cache too.
 */

import { emptyFields, hexOf, namesAgree, versionParts } from './names.js';

/** The kinds of folder in each cache, in the order they are looked in. */
const KINDS = ['GAC_32', 'GAC_64', 'GAC_Arm64', 'GAC_MSIL', 'GAC'];
/** The name of a version folder in the cache of runtime 4 starts with this. */
const V4_PREFIX = 'v4.0_';

/** IL_ALL less nothing: every field a query names is matched. */
const MATCH_ALL = 0x7f;

/**
 * @typedef {Object} CachedAssembly
 * @property {import('./names.js').AssemblyFields} fields  as the cache names it
 * @property {string} folder  its version folder
 * @property {string} file    its manifest, `<name>.dll` or `<name>.exe`
 */

/**
 * @typedef {Object} CacheVolume  The parts of a FileSystem the cache reads and writes.
 * @property {(path: string) => { isDirectory: boolean, size: number } | null} stat
 * @property {(path: string, pattern: string) => { name: string, isDirectory: boolean,
 *     size: number }[]} list
 * @property {(path: string) => boolean} mkdir
 * @property {(path: string) => boolean} remove
 */

/** @param {string} windows  the Windows folder, `C:\WINDOWS` */
export const cacheRoots = windows=>({
    legacy: `${windows}\\assembly`,
    v4: `${windows}\\Microsoft.NET\\assembly`,
});

/**
 * The name, version, culture and token a version folder's name holds, or
 * null for a folder that is not one.
 *
 * @param {string} simple  the name folder's name @param {string} folder
 */
export function folderFields(simple, folder){
    const rest = folder.startsWith(V4_PREFIX) ? folder.slice(V4_PREFIX.length) : folder;
    const [version, culture, token, ...more] = rest.split('_');
    const parts = versionParts(version);
    if (!parts || token === undefined || more.length > 0
        || !(token === '' || /^[0-9a-f]{16}$/i.test(token)))
    {
        return null;
    }
    return { ...emptyFields(), name: simple, version: parts, culture,
        token: token === '' ? null : Uint8Array.from(token.match(/../g) ?? [],
            pair=>parseInt(pair, 16)) };
}

/**
 * A version folder's name for an assembly's fields.
 *
 * @param {import('./names.js').AssemblyFields} fields @param {boolean} v4
 */
export const folderName = (fields, v4)=>`${v4 ? V4_PREFIX : ''}${fields.version.join('.')}_`
    + `${fields.culture ?? ''}_${fields.token ? hexOf(fields.token) : ''}`;

/**
 * @param {CacheVolume} volume @param {string} windows
 */
export function createCache(volume, windows){
    const roots = cacheRoots(windows);
    /** @param {string} path */
    const directories = path=>volume.list(path, '*')
        .filter(entry=>entry.isDirectory && entry.name !== '.' && entry.name !== '..');
    /** @param {string} path */
    const isFile = path=>{
        const found = volume.stat(path);
        return Boolean(found && !found.isDirectory);
    };

    /**
     * Every cached assembly a query's fields allow, in the order the caches
     * and their kinds are looked in and, within a name, by folder name. The
     * fields given back carry the query's spelling of the name, as Windows
     * answers a lookup by name.
     *
     * @param {import('./names.js').AssemblyFields | null} query
     * @returns {CachedAssembly[]}
     */
    const find = query=>{
        /** @type {CachedAssembly[]} */
        const found = [];
        for (const root of [roots.legacy, roots.v4])
        {
            for (const kind of KINDS)
            {
                const base = `${root}\\${kind}`;
                for (const simple of directories(base))
                {
                    if (query?.name && simple.name.toLowerCase() !== query.name.toLowerCase())
                    {
                        continue;
                    }
                    const versions = directories(`${base}\\${simple.name}`)
                        .sort((a, b)=>(a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
                    for (const version of versions)
                    {
                        const fields = folderFields(simple.name, version.name);
                        if (!fields || (query && !namesAgree(query, fields, MATCH_ALL)))
                        {
                            continue;
                        }
                        const folder = `${base}\\${simple.name}\\${version.name}`;
                        const file = ['dll', 'exe'].map(extension=>
                            `${folder}\\${simple.name}.${extension}`).find(isFile);
                        if (file)
                        {
                            fields.name = query?.name ?? simple.name;
                            found.push({ fields, folder, file });
                        }
                    }
                }
            }
        }
        return found;
    };

    /**
     * Makes a folder and the ones above it that are not there.
     *
     * @param {string} path
     */
    const makeFolders = path=>{
        const parts = path.split('\\');
        for (let depth = 2; depth <= parts.length; depth++)
        {
            const prefix = parts.slice(0, depth).join('\\');
            if (!volume.stat(prefix))
            {
                volume.mkdir(prefix);
            }
        }
        return Boolean(volume.stat(path)?.isDirectory);
    };

    /**
     * Takes an assembly out of the cache: its files, its version folder, and
     * its name folder once nothing else is in it.
     *
     * @param {CachedAssembly} assembly
     */
    const remove = assembly=>{
        for (const entry of volume.list(assembly.folder, '*'))
        {
            if (!entry.isDirectory)
            {
                volume.remove(`${assembly.folder}\\${entry.name}`);
            }
        }
        volume.remove(assembly.folder);
        const parent = assembly.folder.slice(0, assembly.folder.lastIndexOf('\\'));
        if (volume.list(parent, '*').every(entry=>entry.name === '.' || entry.name === '..'))
        {
            volume.remove(parent);
        }
    };

    /**
     * The folder an assembly goes in.
     *
     * @param {import('./names.js').AssemblyFields} fields
     * @param {{ runtime: string, kind: string }} where
     *     `kind` is one of KINDS; `runtime` the version the metadata names
     */
    const folderFor = (fields, where)=>{
        const v4 = /^v4\./.test(where.runtime);
        return `${v4 ? roots.v4 : roots.legacy}\\${where.kind}\\${fields.name}\\`
            + folderName(fields, v4);
    };

    /**
     * The size of an assembly's files in kilobytes, each taking whole 4 KB
     * clusters as the volume's allocation does.
     *
     * @param {CachedAssembly} assembly
     */
    const sizeInKb = assembly=>volume.list(assembly.folder, '*')
        .filter(entry=>!entry.isDirectory)
        .reduce((sum, entry)=>sum + Math.ceil(entry.size / 4096) * 4, 0);

    return { roots, find, makeFolders, remove, folderFor, sizeInKb };
}
