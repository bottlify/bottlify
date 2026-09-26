/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The prefix an installer runs in, and what is left of it afterwards.
 *
 * Wine's model rather than a capture step. A bottle is built by giving the
 * program a volume with nothing beneath it -- no bundle, no baseline -- and
 * then keeping the writable layer whole. Nothing has to diff anything: by
 * construction, everything in that layer is what the installer put there.
 *
 * The one thing that is there before the installer runs is the install media
 * itself, because a distribution reads its own files (an appended archive, an
 * overlay, a resource, the archives and file lists beside it on a disc) and so
 * has to be somewhere the guest can open. It is seeded into the writable layer
 * and subtracted again by path when the prefix is collected, which is the same
 * answer as mounting it read-only beside the prefix and one the engine can give
 * today.
 *
 * What comes out is a tree relative to a root, because a bundle is mounted at
 * one directory and a prefix is a whole volume. The rule that picks that root
 * is a rule about layouts, never about titles: the shallowest directory holding
 * an executable, ignoring the places the system itself lives. It is reported so
 * a caller can disagree, and overridden by naming one.
 */

import { windowsChoice } from './windows.js';

/** Where the distribution is put so the guest can read its own file. */
export const MEDIA_DIRECTORY = 'C:\\Install';

/**
 * Where the registry travels inside the tree.
 *
 * A file rather than a field of the container's index: an unpacked prefix is
 * then self-describing, and the packed form has nothing the unpacked form
 * lacks. The engine does not read it back on mount yet.
 */
export const REGISTRY_PATH = '.bottlify\\registry.json';

/**
 * Directories a program is entitled to write to that are not part of what was
 * installed. The system's own tree is recreated by the engine, not carried.
 */
const SYSTEM_ROOTS = ['windows', 'temp', 'tmp', 'program files\\common files'];

/**
 * @typedef {Object} MediaFile
 * @property {string} name    Path relative to the media root, backslash-separated.
 * @property {Uint8Array} bytes
 */

/**
 * A directory of files, one of which is the program to start. A disc is the
 * usual case: the entry reads its archives and lists from beside itself.
 *
 * @typedef {Object} InstallMedia
 * @property {string} name          The entry, as the guest will see it, relative to the media root.
 * @property {Uint8Array} bytes
 * @property {MediaFile[]} [files]  The rest of the media, the entry itself included or not.
 */

/**
 * @typedef {Object} PrefixFile
 * @property {string} path    Backslash-separated, relative to the chosen root.
 * @property {Uint8Array} bytes
 */

/**
 * @typedef {Object} Prefix
 * @property {string} root          Absolute guest path the tree was taken from.
 * @property {PrefixFile[]} files   Everything under it, the registry included.
 * @property {string[]} outside     Absolute paths the root does not cover.
 * @property {string | null} entry  Best guess at the program to start.
 */

/** @param {string} path */
const fold = path=>path.toLowerCase();

/** @param {string} path @returns {string} */
const directoryOf = path=>{
    const cut = path.lastIndexOf('\\');
    return cut < 0 ? '' : path.slice(0, cut);
};

/**
 * The options `createApp` needs to run a distribution in a prefix of its own.
 *
 * Merged into the caller's own options rather than replacing them: everything
 * about how the engine is built -- the emulator, the device, the audio -- is
 * the caller's business and none of it is this module's.
 *
 * @param {InstallMedia} media
 * @param {{ windows?: import('./windows.js').WindowsChoice }} [under]
 *        The Windows the bottle will run under, which the install runs under
 *        too: an installer acts on the Windows it finds. Absent, the engine's
 *        default.
 * @returns {{ executable: Uint8Array, imagePath: string,
 *             storage: { load: () => Promise<PrefixFile[]> }, seeded: string[],
 *             windows?: import('./windows.js').WindowsChoice }}
 */
export function prefixOptions(media, under = {}){
    const windows = windowsChoice(under.windows);
    const path = `${MEDIA_DIRECTORY}\\${media.name}`;
    const files = [{ path, bytes: media.bytes }];
    for (const file of media.files ?? [])
    {
        if (fold(file.name) !== fold(media.name))
        {
            files.push({ path: `${MEDIA_DIRECTORY}\\${file.name}`, bytes: file.bytes });
        }
    }
    return {
        executable: media.bytes,
        imagePath: path,
        // No bundle is mounted, so the volume is the writable layer and nothing
        // else. `storage` is how something gets in there before the first
        // instruction, which is exactly when the distribution has to be there.
        storage: { load: async()=>files },
        seeded: files.map(file=>file.path),
        ...windows === undefined ? {} : { windows },
    };
}

/**
 * Picks the directory that is the installation.
 *
 * Shallowest wins, and among equals the one holding the most files, because an
 * installer that writes a shortcut into one directory and the game into another
 * has put the game in the larger. A tree with no executable anywhere has no
 * installation in it and the volume root is the honest answer.
 *
 * @param {{ path: string }[]} entries  Absolute guest paths.
 * @returns {string}
 */
export function chooseRoot(entries){
    /** @type {Map<string, number>} */
    const weight = new Map();
    for (const entry of entries)
    {
        const directory = directoryOf(entry.path);
        const rest = fold(directory).replace(/^[a-z]:\\/, '');
        if (SYSTEM_ROOTS.some(root=>rest === root || rest.startsWith(`${root}\\`)))
        {
            continue;
        }
        if (!fold(entry.path).endsWith('.exe'))
        {
            continue;
        }
        weight.set(directory, (weight.get(directory) ?? 0) + 1);
    }
    if (weight.size === 0)
    {
        return entries.length > 0 ? `${entries[0].path.slice(0, 2)}\\` : 'C:\\';
    }

    const depth = (/** @type {string} */ path)=>path.split('\\').length;
    return [...weight.entries()].sort((a, b)=>
        depth(a[0]) - depth(b[0]) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

/**
 * The entry point a bundle will be started from: the largest executable that
 * does not name itself a setup program.
 *
 * A guess, corrected in the manifest by hand, which is why the manifest is a
 * separate file. The words matched are what such programs are called, not what
 * any particular one is called.
 *
 * @param {PrefixFile[]} files
 * @returns {string | null}
 */
export function guessEntry(files){
    const executables = files
        .filter(file=>fold(file.path).endsWith('.exe'))
        .filter(file=>!/(unins|setup|install|patch|repair|launcher)/i.test(file.path))
        .sort((a, b)=>b.bytes.length - a.bytes.length);
    return executables[0]?.path ?? null;
}

/**
 * Everything the install produced, as a tree ready to be packed.
 *
 * @param {Object} options
 * @param {PrefixFile[]} options.files  The writable layer, absolute guest paths.
 * @param {any} [options.registry]      The hive, as `toJSON` gives it.
 * @param {string[]} [options.seeded]   Paths put there before the run.
 * @param {string} [options.root]       Overrides the chosen root.
 * @returns {Prefix}
 */
export function collect({ files, registry, seeded = [], root }){
    const planted = new Set(seeded.map(fold));
    const produced = files.filter(file=>!planted.has(fold(file.path)));

    const chosen = root ?? chooseRoot(produced);
    const under = fold(chosen.endsWith('\\') ? chosen : `${chosen}\\`);

    /** @type {PrefixFile[]} */
    const inside = [];
    /** @type {string[]} */
    const outside = [];
    for (const file of produced)
    {
        if (fold(file.path).startsWith(under))
        {
            inside.push({ path: file.path.slice(under.length), bytes: file.bytes });
        }
        else
        {
            outside.push(file.path);
        }
    }

    const entry = guessEntry(inside);
    if (registry !== undefined)
    {
        inside.push({
            path: REGISTRY_PATH,
            bytes: new TextEncoder().encode(JSON.stringify(registry)),
        });
    }
    return { root: chosen, files: inside, outside, entry };
}
