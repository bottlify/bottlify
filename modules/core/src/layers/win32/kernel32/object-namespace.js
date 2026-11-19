/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The object manager's namespace: directories and symbolic links over the
 * run's one table of names (`named-objects.js`), and the walk every native
 * create or open takes through them.
 *
 * A native call names its object by a path from the root, or relative to a
 * directory handle. The walk goes a component at a time: a directory is
 * entered, a symbolic link is replaced by its target and the walk starts
 * again, anything else in the middle of a path is no directory. The last
 * component is the object's own name; a link there is followed too, unless a
 * link is what is opened. Names are compared as they are spelt unless
 * OBJ_CASE_INSENSITIVE asks otherwise, and then the most recently made of the
 * names that differ only in case is the one found, as a directory's hash
 * chain gives it.
 *
 * Win32's names are the objects of the BaseNamedObjects directories, the
 * shared one and the interactive session's, and are kept under the name
 * itself: an event CreateEvent makes is found by NtOpenEvent through
 * \BaseNamedObjects, \Sessions\1\BaseNamedObjects or a handle to either. A
 * kernel32 name is a path below the session's directory, taken by the same
 * walk (`win32`), so `Global\X`, `Local\X` and `Session\1\X` are the one key
 * `X`. Elsewhere in the namespace an object is kept under its whole path,
 * which no Win32 name can be (a Win32 name has no leading backslash). The
 * two BaseNamedObjects directories are one set of names here (decisions.md
 * A271).
 *
 * The directories and links Windows makes at boot are made once in a table
 * and never go; one a program makes lives as long as a handle onto it, as a
 * temporary object does.
 */

import { STATUS } from '../ntdll/status.js';
import { OBJ_CASE_INSENSITIVE, OBJ_OPENLINK } from './object-attributes.js';

/** A name that is not a path where one is wanted, or one where it is not. */
export const STATUS_OBJECT_PATH_SYNTAX_BAD = 0xc000003b;

/** A walk that keeps meeting links ends, as the object manager ends one. */
const MOST_LINKS = 32;

/** The kinds the namespace itself makes. */
export const DIRECTORY = 'objdir';
export const SYMBOLIC_LINK = 'symlink';

/** A directory whose names are Win32's: the shared one and a session's. */
const WIN32_DIRECTORY = /^\\(?:Sessions\\\d+\\)?BaseNamedObjects$/;

/** The session a program runs in, whose BaseNamedObjects Local\ names. */
const SESSION = 1;
/** The directory kernel32's names are relative to. */
const SESSION_OBJECTS = `\\Sessions\\${SESSION}\\BaseNamedObjects`;

/**
 * The directories Windows makes at boot, and the links among them.
 *
 * @type {[string, string | null][]}  a path, and a link's target (null: a directory)
 */
const BOOT = [
    ['\\', null],
    ['\\BaseNamedObjects', null],
    ['\\Sessions', null],
    [`\\Sessions\\${SESSION}`, null],
    [`\\Sessions\\${SESSION}\\BaseNamedObjects`, null],
    ['\\Sessions\\BNOLINKS', null],
    [`\\Sessions\\BNOLINKS\\${SESSION}`, `\\Sessions\\${SESSION}\\BaseNamedObjects`],
    // The links both BaseNamedObjects hold: one set of names here.
    ['Global', '\\BaseNamedObjects'],
    ['Local', `\\Sessions\\${SESSION}\\BaseNamedObjects`],
    ['Session', '\\Sessions\\BNOLINKS'],
    // The DOS devices: \?? is the caller's view of the global ones, and
    // GLOBALROOT in them names the root, its target empty.
    ['\\GLOBAL??', null],
    ['\\GLOBAL??\\GLOBALROOT', ''],
    ['\\??', '\\GLOBAL??'],
    ['\\DosDevices', '\\??'],
    ['\\Device', null],
    ['\\KernelObjects', null],
    ['\\ObjectTypes', null],
    ['\\Windows', null],
    ['\\RPC Control', null],
];

/**
 * The key a name in a directory is kept under in the table.
 *
 * @param {string} directory  the directory's path
 * @param {string} name
 */
export const keyIn = (directory, name)=>(WIN32_DIRECTORY.test(directory) ? name
    : directory === '\\' ? `\\${name}` : `${directory}\\${name}`);

/**
 * The name a key stands for in a directory, keyIn's other way: null for a key
 * of anything else. A Win32 directory's names are the keys with no backslash,
 * less the run's own entries (a pipe's, kept under `pipe:`).
 *
 * @param {string} directory @param {string} key
 * @returns {string | null}
 */
export const nameIn = (directory, key)=>{
    if (WIN32_DIRECTORY.test(directory))
    {
        return key.includes('\\') || key.startsWith('pipe:') ? null : key;
    }
    const prefix = directory === '\\' ? '\\' : `${directory}\\`;
    return key.startsWith(prefix) && key.length > prefix.length
        && !key.slice(prefix.length).includes('\\') ? key.slice(prefix.length) : null;
};

/**
 * Makes the boot namespace in a table that has not got it.
 *
 * @param {Map<string, { kind: string, object: any, refs: number }>} table
 */
export function bootNamespace(table){
    if (table.has('\\'))
    {
        return;
    }
    for (const [path, target] of BOOT)
    {
        const object = target === null ? { path } : { path, target };
        table.set(path, { kind: target === null ? DIRECTORY : SYMBOLIC_LINK, object,
            refs: Infinity });
    }
}

/**
 * What a walk found: where the name is kept and what it holds now. `held` is
 * null for a name nothing holds - free for a create, not found for an open.
 *
 * @typedef {{ key: string, directory: string, name: string,
 *     held: { kind: string, object: any } | null }} Place
 */

/**
 * The namespace over a process's view of the table.
 *
 * @param {Object} host
 * @param {(key: string, insensitive: boolean) => { kind: string, object: any } | null} host.at
 *     what the table keeps under a key, matched in any case where asked
 * @param {(handle: number) => { kind: string | null, object: any }} host.handle
 *     what a handle of this process names: no kind for none
 */
export function createObjectNamespace(host){
    /** The root directory, which the boot namespace always holds. */
    const rootDirectory = ()=>host.at('\\', false)?.object ?? { path: '\\' };
    /**
     * Walks a path from a directory's path to the place its last component
     * names.
     *
     * @param {{ path: string }} start  a directory
     * @param {string[]} parts
     * @param {boolean} insensitive
     * @param {boolean} openLink  a link last is the object, not its target
     * @returns {Place | { status: number }}
     */
    const walk = (start, parts, insensitive, openLink)=>{
        let at = start;
        let directory = start.path;
        let left = parts;
        let links = 0;
        for (;;)
        {
            if (left.length === 0)
            {
                // The path is a directory itself (\, or a link to one).
                return { key: directory, directory, name: '',
                    held: { kind: DIRECTORY, object: at } };
            }
            const [name, ...rest] = left;
            if (name === '')
            {
                return { status: STATUS.OBJECT_NAME_INVALID };
            }
            const key = keyIn(directory, name);
            const held = host.at(key, insensitive);
            if (held?.kind === SYMBOLIC_LINK && (rest.length > 0 || !openLink))
            {
                if (++links > MOST_LINKS)
                {
                    return { status: STATUS.OBJECT_NAME_NOT_FOUND };
                }
                // An empty target is the root (GLOBALROOT's).
                const target = held.object.target === '' ? '\\' : held.object.target;
                if (!target.startsWith('\\'))
                {
                    return { status: STATUS.OBJECT_PATH_NOT_FOUND };
                }
                at = rootDirectory();
                directory = '\\';
                left = [...target.slice(1).split('\\').filter((/** @type {string} */ part)=>part !== ''), ...rest];
                continue;
            }
            if (rest.length === 0)
            {
                return { key, directory, name, held };
            }
            if (held?.kind !== DIRECTORY)
            {
                return { status: STATUS.OBJECT_PATH_NOT_FOUND };
            }
            at = held.object;
            directory = held.object.path;
            left = rest;
        }
    };

    return {
        /**
         * The key a Win32 name stands for. kernel32 makes and opens its
         * objects relative to the session's BaseNamedObjects (Windows'
         * BaseGetNamedObjectDirectory), case sensitive, so `Global\X`
         * follows the link to \BaseNamedObjects, `Local\X` and
         * `Session\1\X` to the session's own, and every spelling of one
         * object is one key - the one a native call naming it reaches. A key
         * already (a bare name, or a whole path) is itself; a name whose path
         * leads nowhere is answered with the walk's status.
         *
         * @param {string} name
         * @returns {string | { status: number }}
         */
        win32(name){
            if (!name.includes('\\') || name.startsWith('\\'))
            {
                return name;
            }
            const found = walk(host.at(SESSION_OBJECTS, false)?.object ?? { path: SESSION_OBJECTS },
                name.split('\\'), false, false);
            return 'status' in found ? found : found.key;
        },

        /**
         * Where an OBJECT_ATTRIBUTES' name is, or the status that refuses it.
         * The name is not empty: a call that makes an unnamed object takes no
         * walk.
         *
         * @param {import('./object-attributes.js').ObjectAttributes} given
         * @param {string} kind  what is made or opened: a link last is the
         *     link itself only when a link is asked for
         * @returns {Place | { status: number }}
         */
        place(given, kind){
            const insensitive = (given.attributes & OBJ_CASE_INSENSITIVE) !== 0;
            const openLink = kind === SYMBOLIC_LINK || (given.attributes & OBJ_OPENLINK) !== 0;
            const name = given.name ?? '';
            if (given.root !== 0)
            {
                const root = host.handle(given.root);
                if (root.kind === null)
                {
                    return { status: STATUS.INVALID_HANDLE };
                }
                if (root.kind !== DIRECTORY)
                {
                    return { status: STATUS.OBJECT_TYPE_MISMATCH };
                }
                if (name.startsWith('\\'))
                {
                    return { status: STATUS_OBJECT_PATH_SYNTAX_BAD };
                }
                return walk(root.object, name === '' ? [] : name.split('\\'), insensitive,
                    openLink);
            }
            if (!name.startsWith('\\'))
            {
                return { status: STATUS_OBJECT_PATH_SYNTAX_BAD };
            }
            return walk(rootDirectory(), name === '\\' ? [] : name.slice(1).split('\\'),
                insensitive, openLink);
        },
    };
}

/** What NtQueryObject's types and NtQueryDirectoryObject call each kind. */
export const TYPE_NAMES = new Map([
    [DIRECTORY, 'Directory'], [SYMBOLIC_LINK, 'SymbolicLink'], ['event', 'Event'],
    ['mutex', 'Mutant'], ['semaphore', 'Semaphore'], ['timer', 'Timer'],
    ['mapping', 'Section'], ['iocp', 'IoCompletion'], ['job', 'Job'],
    ['keyedEvent', 'KeyedEvent'],
]);
