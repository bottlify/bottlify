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
 * What comes out is everything the installation wrote on C:, by its path from
 * the drive's root, and the bottle is mounted back at that root: no directory
 * is guessed to be "the" installation, so nothing a setup spread elsewhere --
 * a shared runtime, the data beside a Bin directory, a settings file in the
 * Windows directory -- is left behind. Only the run's scratch stays out: the
 * temporary directories, and the distribution unpacked beside itself when the
 * installation went somewhere else. A system library it put in system32 is
 * carried too; the engine's own answers that name there all the same.
 */

import { launcherPlan } from './is5stub.js';
import { windowsChoice } from './windows.js';
import { atPath, sizeOf } from './chunks.js';

/** Where the distribution is put so the guest can read its own file. */
export const MEDIA_DIRECTORY = 'C:\\Install';

/**
 * Where the registry travels inside the tree.
 *
 * A file rather than a field of the container's index: an unpacked prefix is
 * then self-describing, and the packed form has nothing the unpacked form
 * lacks. The engine reads it when it mounts the bottle (core's
 * `BOTTLE_REGISTRY_PATH`, the same path), beneath what a session saved since.
 */
export const REGISTRY_PATH = '.bottlify\\registry.json';

/** Where every bottle is taken from, and mounted back at. */
export const DRIVE_ROOT = 'C:\\';

/**
 * The places a run leaves what nothing reads again, folded: Windows' and each
 * user's temporary directories, where a setup unpacks itself; and what a
 * setup keeps of itself for a later repair or removal -- InstallShield's copy
 * of the whole package, Windows Installer's cache, the maintenance engine and
 * its script, the copies a DirectX setup leaves for File Protection and its
 * component packages -- which only Add or Remove Programs or Windows itself
 * ever reads, and which ran to nearly half a bottle.
 */
const SCRATCH = new RegExp('^c:\\\\(windows\\\\temp|temp'
    + '|documents and settings\\\\[^\\\\]+\\\\local settings\\\\temp'
    + '|windows\\\\downloaded installations|windows\\\\installer'
    + '|windows\\\\system32\\\\dllcache|windows\\\\registeredpackages'
    + '|program files\\\\installshield installation information'
    + '|program files\\\\common files\\\\installshield)\\\\');

/** A shortcut: what a setup leaves on the desktop and in the Start menu. */
const SHORTCUT = /\.(lnk|pif|url)$/;

/** Where the engine mounts a bundle that says nothing of where it belongs. */
const DEFAULT_PLACE = 'App';

/**
 * Where a bottle is mounted and its program started from: the directory the
 * manifest records as `root` -- the drive's root for every bottle made now,
 * one installation directory for one made before -- so what the installation
 * wrote about its places is true of the bottle. A bottle made by hand has
 * none, and neither has one installed on a drive other than C: -- the drive a
 * bundle is mounted on -- and those go where the engine puts a bundle by
 * default.
 *
 * @param {{ entry: string, root?: unknown }} manifest
 * @returns {{ prefix: string, imagePath: string }}  `prefix` is the directory
 *     on C: the bundle appears in, as createApp's `bundle.prefix` takes it.
 */
export function placementOf(manifest){
    const root = typeof manifest.root === 'string' ? manifest.root : '';
    const onC = /^c:\\(.*)$/i.exec(root);
    const prefix = onC ? onC[1].replace(/\\+$/, '') : DEFAULT_PLACE;
    return { prefix, imagePath: `C:\\${prefix ? `${prefix}\\` : ''}${manifest.entry}` };
}

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
 * @property {string} [path]        Where the guest finds the entry when it is not put in
 *                                  `MEDIA_DIRECTORY`: on a disc's own drive (`disc.js`).
 */

/**
 * @typedef {Object} PrefixFile
 * @property {string} path    Backslash-separated, relative to the root.
 * @property {Uint8Array} bytes   Whole; a getter for a file of `pieces`.
 * @property {number} [size]
 * @property {(Uint8Array | null | undefined)[]} [pieces]  As the volume kept it (`chunks.js`).
 */

/**
 * @typedef {Object} Prefix
 * @property {string} root          Where the tree was taken from: `DRIVE_ROOT`.
 * @property {PrefixFile[]} files   Everything under it, the registry included.
 * @property {string[]} outside     Absolute paths the bottle leaves: the temporary
 *                                  directories, the unpacked distribution, other drives.
 * @property {string[]} [directories]  The empty directories the install made, relative
 *                                  to the root, which a list of files cannot carry.
 * @property {string | null} entry  Best guess at the program to start.
 */

/** @param {string} path */
const fold = path=>path.toLowerCase();

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
    // A 16-bit launcher is not run: what it would leave and start is put
    // there instead, and its engine is the program started.
    const directory = path.slice(0, path.lastIndexOf('\\'));
    const launcher = launcherPlan(media.bytes, directory, (media.files ?? []).map(file=>({
        name: file.name.slice(file.name.lastIndexOf('\\') + 1), bytes: file.bytes })));
    files.push(...launcher?.files ?? []);
    return {
        executable: launcher?.executable ?? media.bytes,
        imagePath: launcher?.imagePath ?? path,
        // No bundle is mounted, so the volume is the writable layer and nothing
        // else. `storage` is how something gets in there before the first
        // instruction, which is exactly when the distribution has to be there.
        storage: { load: async()=>files },
        seeded: files.map(file=>file.path),
        ...windows === undefined ? {} : { windows },
    };
}

/**
 * The entry point a bundle will be started from: the largest executable that
 * does not name itself a setup program, outside the Windows directory.
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
        .filter(file=>fold(file.path).endsWith('.exe') && !fold(file.path).startsWith('windows\\'))
        .filter(file=>!/(unins|setup|install|patch|repair|launcher)/i.test(file.path))
        .sort((a, b)=>sizeOf(b) - sizeOf(a));
    return executables[0]?.path ?? null;
}

/**
 * Everything the install produced on C:, as a tree ready to be packed.
 *
 * @param {Object} options
 * @param {PrefixFile[]} options.files  The writable layer, absolute guest paths.
 * @param {any} [options.registry]      The hive, as `toJSON` gives it.
 * @param {string[]} [options.seeded]   Paths put there before the run.
 * @param {string[]} [options.directories]  The empty directories the run left,
 *        absolute guest paths.
 * @returns {Prefix}
 */
export function collect({ files, directories = [], registry, seeded = [] }){
    const planted = new Set(seeded.map(fold));
    const produced = files.filter(file=>!planted.has(fold(file.path)));
    const media = fold(`${MEDIA_DIRECTORY}\\`);
    /** @param {string} path  a file's, or a directory's with its separator */
    const onC = path=>fold(path).startsWith('c:\\') && !SCRATCH.test(fold(path))
        && !SHORTCUT.test(fold(path));
    // What a self-extractor unpacked beside itself is the distribution, not
    // the installation -- unless no program went anywhere else, as for an
    // archive that unpacks the game itself.
    const elsewhere = produced.some(file=>onC(file.path) && !fold(file.path).startsWith(media)
        && !fold(file.path).startsWith('c:\\windows\\') && fold(file.path).endsWith('.exe'));
    /** @param {string} path */
    const carried = path=>onC(path) && !(elsewhere && fold(path).startsWith(media));

    /** @type {PrefixFile[]} */
    const inside = [];
    /** @type {string[]} */
    const outside = [];
    for (const file of produced)
    {
        if (carried(file.path))
        {
            inside.push(atPath(file, file.path.slice(DRIVE_ROOT.length)));
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
    const empty = directories.filter(path=>carried(`${path}\\`))
        .map(path=>path.slice(DRIVE_ROOT.length));
    return { root: DRIVE_ROOT, files: inside, directories: empty, outside, entry };
}
