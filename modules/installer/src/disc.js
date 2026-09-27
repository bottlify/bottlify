/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Installing from a disc image.
 *
 * The image is never unpacked and never copied into the prefix. The engine
 * mounts it as a drive of its own -- D:, a CD-ROM, read-only, with the disc's
 * label and serial number -- and the program the disc starts with runs from
 * there, as it would from a disc in a drive: it finds its archives beside
 * itself, the drive it was started from answers as a CD, and nothing of the
 * disc is ever in what the install produced, so nothing has to be subtracted.
 *
 * Which program that is, is the disc's own answer, the one AutoPlay reads:
 * the `open` line of `[autorun]` in `autorun.inf` at its root, a command line
 * relative to the root; `shellexecute`, which names a document as often as a
 * program, when it names a program and `open` names none; and `setup.exe` at
 * the root when the disc says nothing. The command line is taken apart the
 * way CreateProcess takes apart an unquoted one: the shortest run of words
 * that names a file on the disc is the program, and the rest its arguments.
 *
 * The installer then runs as any other does, its own windows on the screen.
 * Its silent mode is still only asked for, and is read off the program the
 * disc starts and the files beside it.
 */

import { isIsoImage, openIso, rangeReader } from '@bottlify/core/iso';
import { silentOptions } from './silent.js';
import { windowsChoice } from './windows.js';

/** The drive a disc is mounted as: the first letter after the machine's own disk. */
export const DISC_LETTER = 'D';

/** What a disc starts when `autorun.inf` names nothing on it. */
const FALLBACK_ENTRY = 'setup.exe';

/**
 * A disc image the person chose.
 *
 * @typedef {Object} DiscMedia
 * @property {string} name  The image's file name.
 * @property {Blob | Uint8Array | { size: number, read: (offset: number, length: number)
 *     => Uint8Array }} disc
 *     The image: a chosen file, which is read a range at a time; bytes; or a
 *     synchronous reader of a host's own, for a caller that holds the engine
 *     directly.
 */

/**
 * @typedef {Object} DiscEntry
 * @property {string} path       Relative to the disc's root, as the disc spells it.
 * @property {string} arguments  What follows the program on its command line.
 * @property {'autorun' | 'setup' | 'asked'} from  What named it.
 */

/**
 * @param {unknown} media
 * @returns {media is DiscMedia}
 */
export const isDiscMedia = media=>typeof media === 'object' && media !== null
    && 'disc' in media && (/** @type {any} */ (media)).disc != null;

/**
 * Whether a file the person chose is a disc image, by its contents: a volume
 * descriptor at sector 16, where every ISO 9660 image has one.
 *
 * @param {DiscMedia['disc']} image
 * @returns {Promise<boolean>}
 */
export async function isDiscImage(image){
    return isIsoImage(rangeReader(image));
}

/**
 * `autorun.inf`'s text: UTF-16 where it begins with that byte order mark,
 * the ANSI page otherwise.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function autorunText(bytes){
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
    {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    {
        return new TextDecoder().decode(bytes.subarray(3));
    }
    return new TextDecoder('windows-1252').decode(bytes);
}

/**
 * The `[autorun]` section's `open` and `shellexecute`, first of each, the
 * section and the keys named without regard to case.
 *
 * @param {string} text
 * @returns {{ open: string | null, shellexecute: string | null }}
 */
export function readAutorun(text){
    /** @type {{ open: string | null, shellexecute: string | null }} */
    const found = { open: null, shellexecute: null };
    let inside = false;
    for (const line of text.split(/\r\n|\r|\n/))
    {
        const heading = /^\s*\[([^\]]*)\]/.exec(line);
        if (heading)
        {
            inside = heading[1].trim().toLowerCase() === 'autorun';
            continue;
        }
        const pair = inside ? /^\s*([^=;]+?)\s*=\s*(.*?)\s*$/.exec(line) : null;
        const key = pair?.[1].toLowerCase();
        if (pair && (key === 'open' || key === 'shellexecute') && found[key] === null
            && pair[2] !== '')
        {
            found[key] = pair[2];
        }
    }
    return found;
}

/**
 * A path the way the disc's directories spell it: relative to the root, with
 * backslashes, no drive and no leading `.\`.
 *
 * @param {string} path
 */
const onDisc = path=>path.replace(/\//g, '\\').replace(/^[A-Za-z]:/, '')
    .replace(/^(\.\\)+/, '').replace(/^\\+/, '');

/**
 * A command line taken apart into the program and its arguments.
 *
 * A quoted program ends at its closing quote. An unquoted one is found the way
 * CreateProcess finds one: word by word, the shortest run that names a file --
 * with `.exe` added to a name that has no extension -- is the program. When
 * none does, the first word is, and the caller finds it missing.
 *
 * @param {string} line
 * @param {(path: string) => string | null} exists  The disc's own spelling of a file, or null.
 * @returns {{ path: string, arguments: string }}
 */
export function splitCommand(line, exists){
    const text = line.trim();
    if (text.startsWith('"'))
    {
        const close = text.indexOf('"', 1);
        const path = close < 0 ? text.slice(1) : text.slice(1, close);
        return {
            path: exists(onDisc(path)) ?? onDisc(path),
            arguments: close < 0 ? '' : text.slice(close + 1).trim(),
        };
    }
    const words = text.split(/\s+/).filter(Boolean);
    for (let count = 1; count <= words.length; count++)
    {
        const candidate = onDisc(words.slice(0, count).join(' '));
        const last = candidate.slice(candidate.lastIndexOf('\\') + 1);
        const named = exists(candidate)
            ?? (last.includes('.') ? null : exists(`${candidate}.exe`));
        if (named)
        {
            return { path: named, arguments: words.slice(count).join(' ') };
        }
    }
    return { path: onDisc(words[0] ?? ''), arguments: words.slice(1).join(' ') };
}

/**
 * The program a disc starts with, by the disc's own answer.
 *
 * @param {import('@bottlify/core/iso').IsoImage} iso
 * @param {Uint8Array | null} autorun  `autorun.inf`'s bytes, when the disc has one.
 * @returns {DiscEntry | null}
 */
export function discEntry(iso, autorun){
    /** @param {string} path */
    const exists = path=>{
        const entry = iso.find(path);
        return entry && !entry.directory ? entry.path : null;
    };
    if (autorun)
    {
        const lines = readAutorun(autorunText(autorun));
        for (const line of [lines.open, lines.shellexecute])
        {
            if (line === null)
            {
                continue;
            }
            const command = splitCommand(line, exists);
            // A document is started by whatever program opens it, which is not
            // something a disc can be installed with.
            if (exists(command.path) && /\.exe$/i.test(command.path))
            {
                return { path: command.path, arguments: command.arguments, from: 'autorun' };
            }
        }
    }
    const setup = exists(FALLBACK_ENTRY);
    return setup ? { path: setup, arguments: '', from: 'setup' } : null;
}

/**
 * Everything `createApp` needs to install from a disc image: the program the
 * disc starts, read off it, started from the disc's own drive with the
 * arguments the disc gives it, and the image itself, mounted.
 *
 * @param {DiscMedia} media
 * @param {Object} [under]
 * @param {import('./windows.js').WindowsChoice} [under.windows]
 *        The Windows the bottle will run under, which the install runs under too.
 * @param {string} [under.entry]    A program on the disc to start instead of the
 *        one it names, relative to its root.
 * @param {boolean} [under.silent]  Ask for the installer's silent mode, for a run
 *        with no screen (`silent.js`); nothing gets it without asking.
 * @param {string[]} [under.dialogs]  An InstallShield 5 script's dialog order, as
 *        far as earlier runs found it.
 * @returns {Promise<{ executable: Uint8Array, imagePath: string, commandLine: string,
 *     discs: { image: DiscMedia['disc'], letter: string }[],
 *     storage: { load: () => Promise<{ path: string, bytes: Uint8Array }[]> },
 *     seeded: string[], label: string, entry: DiscEntry,
 *     unattended: import('./silent.js').SilentOptions | null,
 *     windows?: import('./windows.js').WindowsChoice }>}
 */
export async function discOptions(media, under = {}){
    const windows = windowsChoice(under.windows);
    const read = rangeReader(media.disc);
    const iso = await openIso(read);
    /** @param {import('@bottlify/core/iso').IsoEntry} entry @returns {Promise<Uint8Array>} */
    const bytesOf = async entry=>iso.read(entry, 0, entry.size);

    const autorun = iso.find('autorun.inf');
    const entry = under.entry
        ? { path: iso.find(under.entry)?.path ?? under.entry, arguments: '',
            from: /** @type {const} */ ('asked') }
        : discEntry(iso, autorun && !autorun.directory ? await bytesOf(autorun) : null);
    const program = entry ? iso.find(entry.path) : null;
    if (!entry || !program || program.directory)
    {
        throw new Error(under.entry
            ? `${media.name} has no ${under.entry}`
            : `${media.name} names no program to start: autorun.inf's open= names nothing `
                + 'on the disc, and there is no setup.exe at its root');
    }

    const executable = await bytesOf(program);
    const imagePath = `${DISC_LETTER}:\\${program.path}`;
    const commandLine = entry.arguments === ''
        ? `"${imagePath}"` : `"${imagePath}" ${entry.arguments}`;

    /** @type {import('./silent.js').SilentOptions | null} */
    let unattended = null;
    if (under.silent === true)
    {
        // What an installer's engine is recognised by beside its entry: the
        // names of the files there, and the bytes of the one it reads its
        // product from.
        const directory = program.path.includes('\\')
            ? program.path.slice(0, program.path.lastIndexOf('\\') + 1) : '';
        const beside = iso.entries.filter(item=>!item.directory
            && item.path.toLowerCase().startsWith(directory.toLowerCase())
            && !item.path.slice(directory.length).includes('\\'));
        const files = await Promise.all(beside.map(async item=>({
            name: item.name,
            bytes: item.name.toLowerCase() === 'setup.ini'
                ? await bytesOf(item) : new Uint8Array(0),
        })));
        unattended = silentOptions({ name: program.name, path: imagePath, bytes: executable,
            files }, { silent: true, dialogs: under.dialogs });
    }

    return {
        executable,
        imagePath,
        commandLine,
        discs: [{ image: media.disc, letter: DISC_LETTER }],
        // Nothing is seeded: the disc is its own drive, and the prefix beneath
        // the program starts empty. An unattended run's answers are
        // `unattended.seeded`, put on the volume by whoever runs it, as
        // `silentOptions`'s are.
        storage: { load: async()=>[] },
        seeded: [],
        label: iso.volume.label,
        entry,
        unattended,
        ...windows === undefined ? {} : { windows },
    };
}
