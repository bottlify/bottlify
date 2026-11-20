/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WOW64's registry redirection: what a 32-bit process on a 64-bit Windows
 * reaches when it names HKEY_LOCAL_MACHINE\SOFTWARE and the COM classes.
 *
 * Under HKLM\SOFTWARE a 32-bit view has its keys under `Wow6432Node`, but for
 * the keys both widths share; in the classes (HKLM\SOFTWARE\Classes,
 * HKCU\Software\Classes and HKEY_CLASSES_ROOT, which merges them) only CLSID,
 * DirectShow, Interface, Media Type and MediaFoundation have a 32-bit view,
 * under `Classes\Wow6432Node`. Everything else is one key for both. The lists
 * are Windows 7's ("Registry Keys Affected by WOW64", Microsoft's WOW64
 * documentation). A call names a view with KEY_WOW64_32KEY or
 * KEY_WOW64_64KEY; without either a process has its own width's, and a key
 * reached through one view keeps it for the keys opened under it.
 */

import { HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE } from './registry.js';

/**
 * A hive as a process reaches it: its calls, with open, create and remove
 * taking the call's REGSAM, whose KEY_WOW64_* names a view (a hive of one
 * view, a 32-bit Windows', takes no such word and ignores it).
 *
 * @template {Record<string, any>} H
 * @typedef {Omit<H, 'open' | 'create' | 'remove'> & {
 *     open: (key: any, path?: string | null, sam?: number) => any,
 *     create: (key: any, path?: string | null, keyClass?: string, sam?: number)
 *         => { key: any, created: boolean },
 *     remove: (key: any, path?: string | null, sam?: number)
 *         => 'deleted' | 'missing' | 'has-subkeys' }} ProcessRegistry
 */

/** REGSAM's view bits. */
export const KEY_WOW64_64KEY = 0x0100;
export const KEY_WOW64_32KEY = 0x0200;

const NODE = 'Wow6432Node';

/** Under HKLM\SOFTWARE, the keys both views share, lower case. */
const SHARED = [
    'Classes',
    'Microsoft\\COM3',
    'Microsoft\\Cryptography\\Calais\\Current',
    'Microsoft\\Cryptography\\Calais\\Readers',
    'Microsoft\\Cryptography\\Services',
    'Microsoft\\CTF\\SystemShared',
    'Microsoft\\CTF\\TIP',
    'Microsoft\\DFS',
    'Microsoft\\Driver Signing',
    'Microsoft\\EnterpriseCertificates',
    'Microsoft\\EventSystem',
    'Microsoft\\MSMQ',
    'Microsoft\\Non-Driver Signing',
    'Microsoft\\Notepad\\DefaultFonts',
    'Microsoft\\OLE',
    'Microsoft\\RAS',
    'Microsoft\\RPC',
    'Microsoft\\SOFTWARE\\Microsoft\\Shared Tools\\MSInfo',
    'Microsoft\\SystemCertificates',
    'Microsoft\\TermServLicensing',
    'Microsoft\\Transaction Server',
    'Microsoft\\Windows\\CurrentVersion\\App Paths',
    'Microsoft\\Windows\\CurrentVersion\\Control Panel\\Cursors\\Schemes',
    'Microsoft\\Windows\\CurrentVersion\\Explorer\\AutoplayHandlers',
    'Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons',
    'Microsoft\\Windows\\CurrentVersion\\Explorer\\KindMap',
    'Microsoft\\Windows\\CurrentVersion\\Group Policy',
    'Microsoft\\Windows\\CurrentVersion\\Policies',
    'Microsoft\\Windows\\CurrentVersion\\PreviewHandlers',
    'Microsoft\\Windows\\CurrentVersion\\Setup',
    'Microsoft\\Windows\\CurrentVersion\\Telephony\\Locations',
    'Microsoft\\Windows NT\\CurrentVersion\\Console',
    'Microsoft\\Windows NT\\CurrentVersion\\FontDpi',
    'Microsoft\\Windows NT\\CurrentVersion\\FontLink',
    'Microsoft\\Windows NT\\CurrentVersion\\FontMapper',
    'Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'Microsoft\\Windows NT\\CurrentVersion\\FontSubstitutes',
    'Microsoft\\Windows NT\\CurrentVersion\\Gre_Initialize',
    'Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options',
    'Microsoft\\Windows NT\\CurrentVersion\\LanguagePack',
    'Microsoft\\Windows NT\\CurrentVersion\\NetworkCards',
    'Microsoft\\Windows NT\\CurrentVersion\\Perflib',
    'Microsoft\\Windows NT\\CurrentVersion\\Ports',
    'Microsoft\\Windows NT\\CurrentVersion\\Print',
    'Microsoft\\Windows NT\\CurrentVersion\\ProfileList',
    'Microsoft\\Windows NT\\CurrentVersion\\Time Zones',
    'Policies',
    'RegisteredApplications',
].map(path=>path.toLowerCase().split('\\'));

/** The classes' keys a 32-bit view has its own of, lower case. */
const CLASSES_OWN = new Set(['clsid', 'directshow', 'interface', 'media type', 'mediafoundation']);

/** @param {string[]} parts @param {string[]} prefix */
const startsWith = (parts, prefix)=>prefix.length <= parts.length
    && prefix.every((part, at)=>parts[at].toLowerCase() === part);

/**
 * A path in a classes tree with its view's node taken out, and then put where
 * the view has one.
 *
 * @param {string[]} parts  below the classes root
 * @param {32 | 64} view
 */
const classesIn = (parts, view)=>{
    const plain = parts[0]?.toLowerCase() === NODE.toLowerCase() ? parts.slice(1) : parts;
    return view === 32 && plain.length > 0 && CLASSES_OWN.has(plain[0].toLowerCase())
        ? [NODE, ...plain] : plain;
};

/**
 * Where a key is in a view: its path below `root` as that view reaches it.
 * Paths outside what WOW64 redirects come back as they are.
 *
 * @param {number} root  a predefined key
 * @param {string[]} parts
 * @param {32 | 64} view
 * @returns {string[]}
 */
export function inView(root, parts, view){
    const id = root >>> 0;
    if (id === HKEY_CLASSES_ROOT)
    {
        return classesIn(parts, view);
    }
    const lower = parts.map(part=>part.toLowerCase());
    if (id === HKEY_CURRENT_USER && startsWith(lower, ['software', 'classes']))
    {
        return [...parts.slice(0, 2), ...classesIn(parts.slice(2), view)];
    }
    if (id !== HKEY_LOCAL_MACHINE || lower[0] !== 'software')
    {
        return parts;
    }
    const plain = lower[1] === NODE.toLowerCase() ? [parts[0], ...parts.slice(2)] : parts;
    const rest = plain.slice(1);
    if (rest[0]?.toLowerCase() === 'classes')
    {
        return [plain[0], plain[1], ...classesIn(rest.slice(1), view)];
    }
    const shared = SHARED.some(prefix=>startsWith(rest, prefix));
    return view === 32 && !shared ? [plain[0], NODE, ...rest] : plain;
}

/**
 * A process's view of the run's registry: `hive` as a process of `width`
 * reaches it on a 64-bit Windows. Every key it hands out keeps where it is,
 * so a key opened under it is put in the view its holder's is; `open` and
 * `create` take the view a call names (KEY_WOW64_*). The rest of the hive's
 * calls work on the keys and are the hive's own.
 *
 * @template {Record<string, any>} H
 * @param {H} hive
 * @param {32 | 64} width
 * @returns {ProcessRegistry<H>}
 */
export function wow64Hive(hive, width){
    // Keys are what the hive names them by: a number of the run's registry
    // service, an object of a bare hive. One entry a key the process reached.
    /** @type {Map<any, { root: number, parts: string[], view: 32 | 64 }>} */
    const places = new Map();
    /** @param {any} key @param {number} root @param {string[]} parts @param {32 | 64} view */
    const kept = (key, root, parts, view)=>{
        if (key !== null && key !== undefined)
        {
            places.set(key, { root, parts, view });
        }
        return key;
    };
    /** @param {string | null | undefined} path */
    const split = path=>(path ?? '').split('\\').filter(Boolean);
    /**
     * The root, the path in the view and the view, for a subkey path of `key`
     * - or null for a key whose place is not known here.
     *
     * @param {any} key @param {string | null | undefined} path @param {number} [sam]
     */
    const placed = (key, path, sam = 0)=>{
        const place = places.get(key);
        if (!place)
        {
            return null;
        }
        const view = (sam & KEY_WOW64_64KEY) !== 0 ? 64 : (sam & KEY_WOW64_32KEY) !== 0 ? 32
            : place.view;
        return { root: place.root, parts: inView(place.root, [...place.parts, ...split(path)],
            view), view: /** @type {32 | 64} */ (view) };
    };
    /** @type {Record<string, (...args: any[]) => any>} */
    const own = {
        /** @param {number} id */
        root: id=>kept(hive.root(id), id >>> 0, [], width),
        /**
         * @param {any} key @param {string | null} [path]
         * @param {number} [sam]  the call's REGSAM, whose KEY_WOW64_* names a view
         */
        open: (key, path, sam)=>{
            const at = placed(key, path, sam);
            if (!at)
            {
                return hive.open(key, path);
            }
            const found = hive.open(hive.root(at.root), at.parts.join('\\'));
            return kept(found, at.root, at.parts, at.view);
        },
        /**
         * @param {any} key @param {string | null} [path] @param {string} [keyClass]
         * @param {number} [sam]
         */
        create: (key, path, keyClass = '', sam = 0)=>{
            const at = placed(key, path, sam);
            if (!at)
            {
                return hive.create(key, path, keyClass);
            }
            const made = hive.create(hive.root(at.root), at.parts.join('\\'), keyClass);
            kept(made?.key, at.root, at.parts, at.view);
            return made;
        },
        /** @param {any} key @param {string | null} [path] @param {number} [sam] */
        remove: (key, path, sam)=>{
            const at = split(path).length > 0 ? placed(key, path, sam) : null;
            return at ? hive.remove(hive.root(at.root), at.parts.join('\\'))
                : hive.remove(key, path);
        },
    };
    return /** @type {ProcessRegistry<H>} */ (/** @type {unknown} */ (new Proxy(hive, {
        get: (target, name)=>{
            if (typeof name === 'string' && Object.hasOwn(own, name))
            {
                return own[name];
            }
            /** @type {any} */
            const value = Reflect.get(target, name);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    })));
}
