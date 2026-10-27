/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { decodeFolder, folderOf, readCabinet } from '../cabinet/cabinet.js';

/**
 * A file queue: the copies, deletions and renames an install section asks
 * for, and committing them through the program's callback.
 *
 * Committing is SetupCommitFileQueue's sequence: STARTQUEUE, then for the
 * deletions, the renames and the copies in that order a STARTSUBQUEUE,
 * each operation's START, error and END notifications, and an ENDSUBQUEUE,
 * then ENDQUEUE. A copy's source media -- its root, description and tag
 * file -- is announced with NEEDMEDIA before the first file taken from it;
 * a path the callback answers with places the media for the files after.
 * A source whose disk has a cabinet for its tag file is found inside that
 * cabinet when it is not beside it.
 */

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_DATA = 13;

const SPFILENOTIFY_STARTQUEUE = 0x01;
const SPFILENOTIFY_ENDQUEUE = 0x02;
const SPFILENOTIFY_STARTSUBQUEUE = 0x03;
const SPFILENOTIFY_ENDSUBQUEUE = 0x04;
const SPFILENOTIFY_STARTDELETE = 0x05;
const SPFILENOTIFY_ENDDELETE = 0x06;
const SPFILENOTIFY_STARTRENAME = 0x08;
const SPFILENOTIFY_ENDRENAME = 0x09;
const SPFILENOTIFY_RENAMEERROR = 0x0a;
const SPFILENOTIFY_STARTCOPY = 0x0b;
const SPFILENOTIFY_ENDCOPY = 0x0c;
const SPFILENOTIFY_COPYERROR = 0x0d;
const SPFILENOTIFY_NEEDMEDIA = 0x0e;

const FILEOP_COPY = 0;
const FILEOP_RENAME = 1;
const FILEOP_DELETE = 2;

const FILEOP_ABORT = 0;
const FILEOP_DOIT = 1;
const FILEOP_SKIP = 2;
const FILEOP_NEWPATH = 4;

/** The copy flags a caller passes. */
const SP_COPY_REPLACEONLY = 0x2;
const SP_COPY_NOOVERWRITE = 0x8;
const SP_COPY_NODECOMP = 0x10;
const SP_COPY_FORCE_IN_USE = 0x200;
const SP_COPY_NOSKIP = 0x400;
const SP_COPY_WARNIFSKIP = 0x4000;

/** The copy flags a NEEDMEDIA notification's SOURCE_MEDIA carries: those about the media. */
const MEDIA_FLAGS = SP_COPY_NOSKIP | 0x800 /* SP_FLAG_CABINETCONTINUATION */
    | SP_COPY_WARNIFSKIP | 0x8000 /* SP_COPY_NOBROWSE */;

/**
 * A CopyFiles line's flags as the copy flags they stand for: the two sets
 * share bits that mean different things.
 */
const LINE_FLAGS = Object.freeze([
    [0x1, SP_COPY_WARNIFSKIP], [0x2, SP_COPY_NOSKIP], [0x8, SP_COPY_FORCE_IN_USE],
    [0x10, SP_COPY_NOOVERWRITE], [0x400, SP_COPY_REPLACEONLY], [0x800, SP_COPY_NODECOMP],
]);

/** @param {number} line  A CopyFiles line's flags. */
const copyFlagsOf = line=>LINE_FLAGS.reduce((flags, [from, to])=>(
    (line & from) !== 0 ? flags | to : flags), 0);

/** The platform decoration this machine's sections may carry. */
const PLATFORM = '.x86';

/** The default destination when DestinationDirs names none: the system directory. */
const DIRID_DEFAULT = 11;

/**
 * @typedef {Object} CopyEntry
 * @property {string} sourceRoot     The root plus the disk's path: where its tag file is.
 * @property {string} subdirectory   The file's own directory under the root.
 * @property {string} sourcePath     Where the file itself is expected: the two joined.
 * @property {string} sourceFile
 * @property {string | null} description @property {string | null} tagfile
 * @property {string} targetDirectory @property {string} targetFile
 * @property {number} flags
 *
 * @typedef {{ targetDirectory: string, targetFile: string }} DeleteEntry
 * @typedef {{ sourceDirectory: string, sourceFile: string, targetDirectory: string,
 *     targetFile: string }} RenameEntry
 *
 * @typedef {{ copies: CopyEntry[], deletes: DeleteEntry[], renames: RenameEntry[] }} FileQueue
 */

/** @param {...string} parts */
const join = (...parts)=>parts.filter(part=>part !== '').reduce((path, part)=>(
    path === '' ? part : `${path.replace(/[\\/]+$/, '')}\\${part.replace(/^[\\/]+/, '')}`), '');

/**
 * The line of a section that has the key, trying the platform-decorated
 * section first.
 *
 * @param {import('./inf.js').Inf} inf @param {string} section @param {string} key
 */
export const lookup = (inf, section, key)=>{
    const lower = key.toLowerCase();
    for (const name of [section + PLATFORM, section])
    {
        const found = inf.section(name)?.lines.find(line=>line.key?.toLowerCase() === lower);
        if (found)
        {
            return found;
        }
    }
    return null;
};

/**
 * Where a file list's files go: its DestinationDirs entry, else the INF's
 * DefaultDestDir, else the system directory -- a DIRID and a subdirectory
 * under it, or with DIRID -1 the subdirectory as an absolute path.
 *
 * @param {import('./inf.js').Inf} inf @param {string} list
 * @param {(id: number) => string | null} dirid
 */
export function targetDirectory(inf, list, dirid){
    const line = lookup(inf, 'DestinationDirs', list)
        ?? lookup(inf, 'DestinationDirs', 'DefaultDestDir');
    const id = line ? Number.parseInt(line.fields[0], 10) : DIRID_DEFAULT;
    const subdirectory = line?.fields[1] ?? '';
    if (id === -1)
    {
        return subdirectory;
    }
    return join(dirid(id) ?? '', subdirectory);
}

/**
 * Adds a copy to a queue, unless the queue has the same one: the same file
 * from the same place to the same place is copied once.
 *
 * @param {FileQueue} queue @param {CopyEntry} entry
 */
export function pushCopy(queue, entry){
    /** @param {CopyEntry} copy */
    const key = copy=>[copy.sourcePath, copy.sourceFile, copy.targetDirectory, copy.targetFile]
        .join('|').toLowerCase();
    const wanted = key(entry);
    if (!queue.copies.some(copy=>key(copy) === wanted))
    {
        queue.copies.push(entry);
    }
}

/**
 * Queues one file of an INF's, from where its [SourceDisksFiles] and
 * [SourceDisksNames] lines say under the root: the disk's path is part of
 * the media's root, the file's own subdirectory is not.
 *
 * @param {FileQueue} queue @param {import('./inf.js').Inf} layout  The INF with the source disks.
 * @param {{ root: string, source: string, targetDirectory: string, targetFile: string,
 *     flags: number }} copy
 */
export function queueInfCopy(queue, layout, copy){
    const disk = lookup(layout, 'SourceDisksFiles', copy.source);
    const media = disk ? lookup(layout, 'SourceDisksNames', disk.fields[0]) : null;
    const sourceRoot = join(copy.root, media?.fields[3] ?? '');
    const subdirectory = disk?.fields[1] ?? '';
    pushCopy(queue, {
        sourceRoot,
        subdirectory,
        sourcePath: join(sourceRoot, subdirectory),
        sourceFile: copy.source,
        description: media?.fields[0] || null,
        tagfile: media?.fields[1] || null,
        targetDirectory: copy.targetDirectory,
        targetFile: copy.targetFile,
        flags: copy.flags,
    });
}

/**
 * @typedef {Object} QueueHow
 * @property {string} root  Where the sources are.
 * @property {number} copyFlags
 * @property {(id: number) => string | null} dirid
 * @property {import('./inf.js').Inf} [layout]  The INF with the source disks, if not the list's.
 */

/**
 * Queues a file list section: a CopyFiles list's copies, a DelFiles list's
 * deletes or a RenFiles list's renames, each to the directory
 * DestinationDirs gives the list.
 *
 * @param {FileQueue} queue @param {import('./inf.js').Inf} inf  The INF the list is in.
 * @param {string} list @param {'copyfiles' | 'delfiles' | 'renfiles'} directive
 * @param {QueueHow} how
 */
export function queueFileList(queue, inf, list, directive, how){
    const directory = targetDirectory(inf, list, how.dirid);
    for (const entry of inf.section(list)?.lines ?? [])
    {
        const [target = '', source = ''] = entry.fields;
        if (directive === 'copyfiles')
        {
            const flags = Number.parseInt(entry.fields[3] ?? '', 0) || 0;
            queueInfCopy(queue, how.layout ?? inf, { root: how.root, source: source || target,
                targetDirectory: directory, targetFile: target,
                flags: how.copyFlags | copyFlagsOf(flags) });
        }
        else if (directive === 'delfiles')
        {
            queue.deletes.push({ targetDirectory: directory, targetFile: target });
        }
        else
        {
            queue.renames.push({ sourceDirectory: directory, sourceFile: source,
                targetDirectory: directory, targetFile: target });
        }
    }
}

/**
 * Queues an install section's CopyFiles, DelFiles and RenFiles: each a
 * list section, or for CopyFiles a single file its name after an at sign.
 *
 * @param {FileQueue} queue @param {import('./inf.js').Inf} inf
 * @param {import('./inf.js').InfSection} section @param {QueueHow} how
 */
export function queueInstallSection(queue, inf, section, how){
    for (const line of section.lines)
    {
        const directive = line.key?.toLowerCase();
        if (directive !== 'copyfiles' && directive !== 'delfiles' && directive !== 'renfiles')
        {
            continue;
        }
        for (const value of line.fields)
        {
            if (value === '')
            {
                continue;
            }
            if (directive === 'copyfiles' && value.startsWith('@'))
            {
                const name = value.slice(1);
                queueInfCopy(queue, how.layout ?? inf, { root: how.root, source: name,
                    targetDirectory: targetDirectory(inf, section.name, how.dirid),
                    targetFile: name, flags: how.copyFlags });
                continue;
            }
            queueFileList(queue, inf, value, directive, how);
        }
    }
}

/**
 * @typedef {{ kind: 'paths', target: string | null, source: string | null, error?: number }
 *     | { kind: 'media', tagfile: string | null, description: string | null, path: string,
 *         file: string, flags: number }
 *     | { kind: 'value', value: number }} Notice
 *
 * @typedef {Object} CommitHost  Paths as the queue has them, relative ones too.
 * @property {(path: string) => boolean} exists
 * @property {(path: string) => void} remove  Nothing to remove is no error.
 * @property {(from: string, to: string) => boolean} rename
 * @property {(path: string) => Uint8Array | Promise<Uint8Array> | null} readWhole
 * @property {(path: string, bytes: Uint8Array) => number} writeWhole
 * @property {(directory: string) => void} makeDirectories
 * @property {(message: number, first: Notice, second: number)
 *     => Promise<{ answer: number, path: string }>} notify
 *           Sends one notification to the callback; `path` is what it left in
 *           the path buffer an error or NEEDMEDIA notification carries.
 */

/**
 * A media's root from the directory a callback gave for a file in it: that
 * directory with the file's subdirectory taken off its end, when its last
 * element is the subdirectory exactly, else the directory itself.
 *
 * @param {string} directory @param {string} subdirectory
 */
const rootOf = (directory, subdirectory)=>{
    const last = directory.split(/[\\/]/).at(-1);
    return subdirectory !== '' && last === subdirectory
        ? directory.slice(0, -subdirectory.length).replace(/[\\/]$/, '') : directory;
};

/**
 * The bytes of one queued copy: the file in its directory, or else inside
 * the cabinet its disk's tag file names, where the media's cabinet is.
 *
 * @param {CommitHost} host @param {CopyEntry} entry
 * @param {string} directory @param {string} cabinetDirectory
 * @returns {Promise<Uint8Array | number>} the bytes, or the error
 */
async function sourceBytes(host, entry, directory, cabinetDirectory){
    const plain = host.readWhole(join(directory, entry.sourceFile));
    if (plain !== null)
    {
        return await plain;
    }
    if (!entry.tagfile || !/\.cab$/i.test(entry.tagfile))
    {
        return ERROR_FILE_NOT_FOUND;
    }
    const packed = host.readWhole(join(cabinetDirectory, entry.tagfile));
    if (packed === null)
    {
        return ERROR_FILE_NOT_FOUND;
    }
    try
    {
        const cabinet = readCabinet(await packed);
        const wanted = entry.sourceFile.toLowerCase();
        const file = cabinet.files.find(candidate=>
            candidate.name.split(/[\\/]/).pop()?.toLowerCase() === wanted);
        const folder = file ? folderOf(cabinet, file) : null;
        if (!file || !folder)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        return decodeFolder(cabinet, file.folder).slice(file.offset, file.offset + file.size);
    }
    catch {
        return ERROR_INVALID_DATA;
    }
}

/**
 * Commits a queue, answering ERROR_SUCCESS or the error that ended it --
 * null when the callback ended it, the last error then the callback's own.
 *
 * @param {FileQueue} queue @param {CommitHost} host
 * @returns {Promise<number | null>}
 */
export async function commitQueue(queue, host){
    /** @param {number} message @param {Notice} first @param {number} [second] */
    const say = (message, first, second = 0)=>host.notify(message, first, second);
    /** @param {number} number */
    const value = number=>/** @type {Notice} */ ({ kind: 'value', value: number });

    if ((await say(SPFILENOTIFY_STARTQUEUE, value(0))).answer === 0)
    {
        await say(SPFILENOTIFY_ENDQUEUE, value(0));
        return null;
    }

    /** @param {number | null} code */
    const abort = async code=>{
        await say(SPFILENOTIFY_ENDQUEUE, value(0));
        return code;
    };

    if (queue.deletes.length > 0)
    {
        if ((await say(SPFILENOTIFY_STARTSUBQUEUE, value(FILEOP_DELETE),
            queue.deletes.length)).answer === 0)
        {
            return abort(null);
        }
        for (const entry of queue.deletes)
        {
            const target = join(entry.targetDirectory, entry.targetFile);
            const start = (await say(SPFILENOTIFY_STARTDELETE,
                { kind: 'paths', target, source: null }, FILEOP_DELETE)).answer;
            if (start === FILEOP_ABORT)
            {
                return abort(null);
            }
            if (start !== FILEOP_DOIT)
            {
                continue;
            }
            // A file that is not there to delete is already gone.
            host.remove(target);
            const end = (await say(SPFILENOTIFY_ENDDELETE,
                { kind: 'paths', target, source: null, error: ERROR_SUCCESS })).answer;
            if (end !== ERROR_SUCCESS)
            {
                return abort(end);
            }
        }
        await say(SPFILENOTIFY_ENDSUBQUEUE, value(FILEOP_DELETE));
    }

    if (queue.renames.length > 0)
    {
        if ((await say(SPFILENOTIFY_STARTSUBQUEUE, value(FILEOP_RENAME),
            queue.renames.length)).answer === 0)
        {
            return abort(null);
        }
        for (const entry of queue.renames)
        {
            const source = join(entry.sourceDirectory, entry.sourceFile);
            const target = join(entry.targetDirectory, entry.targetFile);
            const start = (await say(SPFILENOTIFY_STARTRENAME,
                { kind: 'paths', target, source }, FILEOP_RENAME)).answer;
            if (start === FILEOP_ABORT)
            {
                return abort(null);
            }
            if (start !== FILEOP_DOIT)
            {
                continue;
            }
            let error = host.rename(source, target) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
            if (error !== ERROR_SUCCESS)
            {
                const decision = (await say(SPFILENOTIFY_RENAMEERROR,
                    { kind: 'paths', target, source, error })).answer;
                if (decision === FILEOP_ABORT)
                {
                    return abort(error);
                }
                if (decision !== FILEOP_DOIT)
                {
                    continue;
                }
                error = host.rename(source, target) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
            }
            const end = (await say(SPFILENOTIFY_ENDRENAME,
                { kind: 'paths', target, source, error })).answer;
            if (end !== ERROR_SUCCESS)
            {
                return abort(end);
            }
        }
        await say(SPFILENOTIFY_ENDSUBQUEUE, value(FILEOP_RENAME));
    }

    if (queue.copies.length > 0)
    {
        if ((await say(SPFILENOTIFY_STARTSUBQUEUE, value(FILEOP_COPY),
            queue.copies.length)).answer === 0)
        {
            return abort(null);
        }
        /**
         * Each media once placed: its root, the files after the first found
         * under it, and where its cabinet is -- the first file's directory,
         * whatever the later files' own subdirectories.
         *
         * @type {Map<string, { root: string, cabinet: string }>}
         */
        const media = new Map();
        for (const entry of queue.copies)
        {
            const mediaKey = `${entry.description}|${entry.tagfile}|${entry.sourceRoot}`
                .toLowerCase();
            /** @type {Uint8Array | number | null} */
            let bytes = null;
            const placed = media.get(mediaKey);
            let directory = placed === undefined ? entry.sourcePath
                : join(placed.root, entry.subdirectory);
            let root = placed?.root ?? entry.sourceRoot;
            let cabinet = placed?.cabinet ?? directory;
            if (placed === undefined)
            {
                // A path the callback gives is the first file's directory,
                // the media's root that with the file's subdirectory taken
                // off its end; it is asked again until the file is there. A
                // skip passes this file and asks again for the next.
                let answer;
                for (;;)
                {
                    const asked = await say(SPFILENOTIFY_NEEDMEDIA, {
                        kind: 'media', tagfile: entry.tagfile, description: entry.description,
                        path: directory, file: entry.sourceFile, flags: entry.flags & MEDIA_FLAGS,
                    }, 0);
                    answer = asked.answer;
                    if (answer !== FILEOP_NEWPATH)
                    {
                        break;
                    }
                    directory = asked.path;
                    cabinet = asked.path;
                    bytes = await sourceBytes(host, entry, directory, cabinet);
                    if (bytes !== ERROR_FILE_NOT_FOUND)
                    {
                        root = rootOf(directory, entry.subdirectory);
                        break;
                    }
                }
                if (answer === FILEOP_ABORT)
                {
                    return abort(null);
                }
                if (answer === FILEOP_SKIP)
                {
                    continue;
                }
                media.set(mediaKey, { root, cabinet });
            }
            const target = join(entry.targetDirectory, entry.targetFile);
            const exists = host.exists(target);
            if (exists && (entry.flags & SP_COPY_NOOVERWRITE))
            {
                continue;
            }
            if (!exists && (entry.flags & SP_COPY_REPLACEONLY))
            {
                continue;
            }
            const source = join(directory, entry.sourceFile);
            const start = (await say(SPFILENOTIFY_STARTCOPY,
                { kind: 'paths', target, source }, FILEOP_COPY)).answer;
            if (start === FILEOP_ABORT)
            {
                return abort(null);
            }
            if (start !== FILEOP_DOIT)
            {
                continue;
            }
            let error;
            let skipped = false;
            for (;;)
            {
                bytes ??= await sourceBytes(host, entry, directory, cabinet);
                if (bytes instanceof Uint8Array)
                {
                    host.makeDirectories(entry.targetDirectory);
                    error = host.writeWhole(target, bytes);
                }
                else
                {
                    error = bytes;
                }
                if (error === ERROR_SUCCESS)
                {
                    break;
                }
                const decision = await say(SPFILENOTIFY_COPYERROR,
                    { kind: 'paths', target, source: join(directory, entry.sourceFile), error },
                    0);
                if (decision.answer === FILEOP_ABORT)
                {
                    return abort(error);
                }
                if (decision.answer === FILEOP_NEWPATH)
                {
                    // The new path stands for the media's root from here on.
                    directory = decision.path;
                    cabinet = decision.path;
                    media.set(mediaKey, { root: rootOf(decision.path, entry.subdirectory),
                        cabinet });
                    bytes = null;
                    continue;
                }
                if (decision.answer !== FILEOP_DOIT)
                {
                    skipped = true;
                    break;
                }
                bytes = null;
            }
            if (skipped)
            {
                continue;
            }
            const end = (await say(SPFILENOTIFY_ENDCOPY,
                { kind: 'paths', target, source, error: ERROR_SUCCESS })).answer;
            if (end !== ERROR_SUCCESS)
            {
                return abort(end);
            }
        }
        await say(SPFILENOTIFY_ENDSUBQUEUE, value(FILEOP_COPY));
    }

    await say(SPFILENOTIFY_ENDQUEUE, value(1));
    return ERROR_SUCCESS;
}
