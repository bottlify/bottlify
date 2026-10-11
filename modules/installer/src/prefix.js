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
 * one directory and a prefix is a whole volume. The root is where the install
 * told Windows it put the application -- the InstallLocation of its uninstall
 * entry -- and, for an install that recorded none, a rule about layouts, never
 * about titles: the shallowest directory holding an executable, ignoring the
 * places the system itself lives. It is reported so a caller can disagree, and
 * overridden by naming one.
 */

import { launcherPlan } from './is5stub.js';
import { windowsChoice } from './windows.js';

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

/**
 * Where what the installation added to `C:\WINDOWS\system32` travels inside
 * the tree -- the libraries its DirectX setup installed, say -- beside the
 * registry. The engine mounts it back in system32 when the bottle runs (core's
 * `BOTTLE_SYSTEM_PATH`, the same path).
 */
export const SYSTEM_PATH = '.bottlify\\system32';

/** The system directory on any drive, folded. */
const SYSTEM32 = /^[a-z]:\\windows\\system32\\/;

/** Where the engine mounts a bundle that says nothing of where it belongs. */
const DEFAULT_PLACE = 'App';

/**
 * Where a bottle is mounted and its program started from: the directory its
 * installation put it in, which the manifest records as `root`, so what the
 * installation wrote about that place -- the install path in the registry, a
 * launcher's working directory -- is true of the bottle. A bottle made by
 * hand, or before the root was recorded, has none, and neither has one
 * installed on a drive other than C: -- the drive a bundle is mounted on --
 * and those go where the engine puts a bundle by default.
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
 * Directories a program is entitled to write to that are not part of what was
 * installed. The system's own tree is recreated by the engine, not carried.
 */
// The system's own directories, and the copy of its setup InstallShield keeps
// for maintenance beside the program it installed.
const SYSTEM_ROOTS = ['windows', 'temp', 'tmp', 'program files\\common files',
    'program files\\installshield installation information'];

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
 * @property {string} path    Backslash-separated, relative to the chosen root.
 * @property {Uint8Array} bytes
 */

/**
 * @typedef {Object} Prefix
 * @property {string} root          Absolute guest path the tree was taken from.
 * @property {PrefixFile[]} files   Everything under it, the registry and what the
 *                                  install added to system32 (`SYSTEM_PATH`) included.
 * @property {string[]} outside     Absolute paths neither the root nor system32 covers.
 * @property {string[]} [directories]  The empty directories the install made under the
 *                                  root, relative to it, which a list of files cannot carry.
 * @property {string[]} [answered]  What the install put in system32 that names a
 *                                  library the engine synthesises itself: not carried.
 * @property {string | null} entry  Best guess at the program to start.
 */

/** @param {string} path */
const fold = path=>path.toLowerCase();

/** A library's file name as the engine keys it: no case, `.dll` optional. @param {string} name */
const libraryKey = name=>fold(name).replace(/\.dll$/, '');

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

    // The media's own directory holds the distribution, and what an installer
    // unpacks beside itself there -- a self-extractor's payload, the setup it
    // then starts -- is the distribution too, however shallow. Only when
    // nothing went anywhere else is it the installation, as for an archive
    // that unpacks the game itself.
    const media = fold(`${MEDIA_DIRECTORY}\\`);
    const elsewhere = [...weight.entries()]
        .filter(([directory])=>!fold(`${directory}\\`).startsWith(media));
    const depth = (/** @type {string} */ path)=>path.split('\\').length;
    return (elsewhere.length > 0 ? elsewhere : [...weight.entries()]).sort((a, b)=>
        depth(a[0]) - depth(b[0]) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

/** The hive's two roots an application's uninstall entry is written under. */
const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
/** Where Add or Remove Programs finds what is installed, one subkey a program. */
const UNINSTALL = ['software', 'microsoft', 'windows', 'currentversion', 'uninstall'];
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;

/**
 * Every InstallLocation the install recorded under an Uninstall entry: the
 * directory an installer tells Windows it put the application in, which is
 * what Add or Remove Programs shows and removes. String data is kept in the
 * ANSI page whichever entry point wrote it, so it is read as that page.
 *
 * @param {any} registry  The hive, as `toJSON` gives it.
 * @returns {string[]}
 */
export function installLocations(registry){
    const ansi = new TextDecoder('windows-1252');
    /** @type {string[]} */
    const found = [];
    for (const { id, key } of registry?.roots ?? [])
    {
        if ((id >>> 0) !== HKEY_LOCAL_MACHINE && (id >>> 0) !== HKEY_CURRENT_USER)
        {
            continue;
        }
        let at = key;
        for (const part of UNINSTALL)
        {
            at = (at?.keys ?? []).find((/** @type {any} */ child)=>fold(child.name) === part);
        }
        for (const entry of at?.keys ?? [])
        {
            const value = (entry.values ?? []).find((/** @type {any} */ one)=>
                fold(one.name) === 'installlocation'
                && (one.type === REG_SZ || one.type === REG_EXPAND_SZ));
            const text = value ? ansi.decode(Uint8Array.from(value.data)).replace(/\0.*$/s, '')
                .trim().replace(/[\\/]+$/, '') : '';
            if (/^[a-z]:\\/i.test(text))
            {
                found.push(text);
            }
        }
    }
    return found;
}

/**
 * The installation the install itself named: of the locations its uninstall
 * entries record, the one holding the most of the executables it produced,
 * spelt as the volume spells it. Null when none holds any -- an entry that
 * names nothing this install wrote is another program's, or a location the
 * program was moved from.
 *
 * @param {{ path: string }[]} produced  Absolute guest paths.
 * @param {any} registry
 * @returns {string | null}
 */
function recordedRoot(produced, registry){
    let best = null;
    let most = 0;
    for (const location of installLocations(registry))
    {
        const under = fold(`${location}\\`);
        const executables = produced.filter(file=>fold(file.path).startsWith(under)
            && fold(file.path).endsWith('.exe'));
        if (executables.length > most)
        {
            most = executables.length;
            best = executables[0].path.slice(0, location.length);
        }
    }
    return best;
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
 * What it added to system32 is kept too, under `SYSTEM_PATH`: a setup puts the
 * runtime its program links against there -- the D3DX libraries a DirectX
 * setup installs -- and the program finds it there and nowhere else. A file
 * there that names a library the engine synthesises as Windows' own is left
 * out, because mounted back it would be mapped in place of the engine's.
 *
 * @param {Object} options
 * @param {PrefixFile[]} options.files  The writable layer, absolute guest paths.
 * @param {any} [options.registry]      The hive, as `toJSON` gives it.
 * @param {string[]} [options.seeded]   Paths put there before the run.
 * @param {string} [options.root]       Overrides the chosen root.
 * @param {string[]} [options.directories]  The empty directories the run left,
 *        absolute guest paths.
 * @param {string[]} [options.synthesised]  The libraries the engine synthesises as
 *        Windows' own, by file name (the app's `systemLibraries()`).
 * @returns {Prefix}
 */
export function collect({ files, directories = [], registry, seeded = [], root, synthesised = [] }){
    const planted = new Set(seeded.map(fold));
    const produced = files.filter(file=>!planted.has(fold(file.path)));

    // Where the install said it put the application, when it said so;
    // otherwise the layout's own answer.
    const chosen = root ?? recordedRoot(produced, registry) ?? chooseRoot(produced);
    const under = fold(chosen.endsWith('\\') ? chosen : `${chosen}\\`);

    const engines = new Set(synthesised.map(libraryKey));
    /** @type {PrefixFile[]} */
    const inside = [];
    /** @type {PrefixFile[]} */
    const system = [];
    /** @type {string[]} */
    const outside = [];
    /** @type {string[]} */
    const answered = [];
    for (const file of produced)
    {
        const folded = fold(file.path);
        const inSystem = SYSTEM32.exec(folded);
        const name = inSystem ? file.path.slice(inSystem[0].length) : '';
        if (inSystem && !name.includes('\\') && engines.has(libraryKey(name)))
        {
            answered.push(file.path);
        }
        else if (folded.startsWith(under))
        {
            inside.push({ path: file.path.slice(under.length), bytes: file.bytes });
        }
        else if (inSystem)
        {
            system.push({ path: `${SYSTEM_PATH}\\${name}`, bytes: file.bytes });
        }
        else
        {
            outside.push(file.path);
        }
    }

    const entry = guessEntry(inside);
    inside.push(...system);
    if (registry !== undefined)
    {
        inside.push({
            path: REGISTRY_PATH,
            bytes: new TextEncoder().encode(JSON.stringify(registry)),
        });
    }
    // Only the installation's own: an empty directory elsewhere is the system's.
    const empty = directories
        .filter(path=>fold(path).startsWith(under))
        .map(path=>path.slice(under.length));
    return { root: chosen, files: inside, directories: empty, outside, answered, entry };
}
