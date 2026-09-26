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
 * then ENDQUEUE. A copy's source media is announced with NEEDMEDIA before
 * the first file taken from it. A source whose disk has a cabinet for its tag
 * file is found inside that cabinet when it is not beside it.
 */

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_DATA = 13;
const ERROR_CANCELLED = 1223;

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

/** CopyFiles line flags, and the copy flags a caller passes. */
const COPYFLG_NO_OVERWRITE = 0x10;
const COPYFLG_REPLACEONLY = 0x400;
const SP_COPY_REPLACEONLY = 0x2;
const SP_COPY_NOOVERWRITE = 0x8;

/** The platform decoration this machine's sections may carry. */
const PLATFORM = '.x86';

/** The default destination when DestinationDirs names none: the system directory. */
const DIRID_DEFAULT = 11;

/**
 * @typedef {Object} CopyEntry
 * @property {string} sourceRoot     The root plus the disk's path: where its tag file is.
 * @property {string} sourcePath     Where the file itself is expected.
 * @property {string} sourceFile
 * @property {string | null} description @property {string | null} tagfile
 * @property {string} targetDirectory @property {string} targetFile
 * @property {number} flags
 *
 * @typedef {{ targetDirectory: string, targetFile: string }} DeleteEntry
 * @typedef {{ targetDirectory: string, sourceFile: string, targetFile: string }} RenameEntry
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
const lookup = (inf, section, key)=>{
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
 * Queues an install section's CopyFiles, DelFiles and RenFiles.
 *
 * @param {FileQueue} queue @param {import('./inf.js').Inf} inf
 * @param {import('./inf.js').InfSection} section
 * @param {{ root: string, copyFlags: number, dirid: (id: number) => string | null }} how
 */
export function queueInstallSection(queue, inf, section, how){
    /** @param {string} list  The file list's section, which DestinationDirs is keyed by. */
    const destination = list=>{
        const line = lookup(inf, 'DestinationDirs', list)
            ?? lookup(inf, 'DestinationDirs', 'DefaultDestDir');
        const id = line ? Number.parseInt(line.fields[0], 10) : DIRID_DEFAULT;
        const subdirectory = line?.fields[1] ?? '';
        if (id === -1)
        {
            return subdirectory;
        }
        return join(how.dirid(id) ?? '', subdirectory);
    };

    /**
     * @param {string} name  Its name where it goes.
     * @param {string} source  Its name where it comes from.
     * @param {string} list @param {number} lineFlags
     */
    const copy = (name, source, list, lineFlags)=>{
        const disk = lookup(inf, 'SourceDisksFiles', source);
        const media = disk ? lookup(inf, 'SourceDisksNames', disk.fields[0]) : null;
        const sourceRoot = join(how.root, media?.fields[3] ?? '');
        queue.copies.push({
            sourceRoot,
            sourcePath: join(sourceRoot, disk?.fields[1] ?? ''),
            sourceFile: source,
            description: media?.fields[0] || null,
            tagfile: media?.fields[1] || null,
            targetDirectory: destination(list),
            targetFile: name,
            flags: how.copyFlags | lineFlags,
        });
    };

    for (const line of section.lines)
    {
        const directive = line.key?.toLowerCase();
        for (const value of line.fields)
        {
            if (value === '')
            {
                continue;
            }
            if (directive === 'copyfiles')
            {
                if (value.startsWith('@'))
                {
                    copy(value.slice(1), value.slice(1), section.name, 0);
                    continue;
                }
                for (const entry of inf.section(value)?.lines ?? [])
                {
                    const [target, source] = entry.fields;
                    const flags = Number.parseInt(entry.fields[3] ?? '', 0) || 0;
                    copy(target, source || target, value, flags);
                }
            }
            else if (directive === 'delfiles')
            {
                for (const entry of inf.section(value)?.lines ?? [])
                {
                    queue.deletes.push({
                        targetDirectory: destination(value), targetFile: entry.fields[0],
                    });
                }
            }
            else if (directive === 'renfiles')
            {
                for (const entry of inf.section(value)?.lines ?? [])
                {
                    queue.renames.push({
                        targetDirectory: destination(value),
                        targetFile: entry.fields[0], sourceFile: entry.fields[1] ?? '',
                    });
                }
            }
        }
    }
}

/**
 * @typedef {{ kind: 'paths', target: string | null, source: string | null, error?: number }
 *     | { kind: 'media', tagfile: string | null, description: string | null, path: string,
 *         file: string, flags: number }
 *     | { kind: 'value', value: number }} Notice
 *
 * @typedef {Object} CommitHost
 * @property {import('../kernel32/files.js').FileSystem} files
 * @property {(path: string) => Uint8Array | Promise<Uint8Array> | null} readWhole
 * @property {(path: string, bytes: Uint8Array) => number} writeWhole
 * @property {(directory: string) => void} makeDirectories
 * @property {(message: number, first: Notice, second: number)
 *     => Promise<{ answer: number, path: string }>} notify
 *           Sends one notification to the callback; `path` is what it left in
 *           the path buffer an error or NEEDMEDIA notification carries.
 */

/**
 * The bytes of one queued copy: the file where the queue expects it, or
 * else inside the cabinet its disk's tag file names.
 *
 * @param {CommitHost} host @param {CopyEntry} entry @param {string | null} override
 *        A path the callback gave for the media, in place of the queue's.
 * @returns {Promise<Uint8Array | number>} the bytes, or the error
 */
async function sourceBytes(host, entry, override){
    const sourcePath = override ?? entry.sourcePath;
    const plain = host.readWhole(join(sourcePath, entry.sourceFile));
    if (plain !== null)
    {
        return await plain;
    }
    if (!entry.tagfile || !/\.cab$/i.test(entry.tagfile))
    {
        return ERROR_FILE_NOT_FOUND;
    }
    const packed = host.readWhole(join(override ?? entry.sourceRoot, entry.tagfile));
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
 * Commits a queue, answering ERROR_SUCCESS or the error that ended it.
 *
 * @param {FileQueue} queue @param {CommitHost} host
 * @returns {Promise<number>}
 */
export async function commitQueue(queue, host){
    /** @param {number} message @param {Notice} first @param {number} [second] */
    const say = (message, first, second = 0)=>host.notify(message, first, second);
    /** @param {number} number */
    const value = number=>/** @type {Notice} */ ({ kind: 'value', value: number });

    if ((await say(SPFILENOTIFY_STARTQUEUE, value(0))).answer === 0)
    {
        await say(SPFILENOTIFY_ENDQUEUE, value(0));
        return ERROR_CANCELLED;
    }

    /** @param {number} code */
    const abort = async code=>{
        await say(SPFILENOTIFY_ENDQUEUE, value(0));
        return code;
    };

    if (queue.deletes.length > 0)
    {
        if ((await say(SPFILENOTIFY_STARTSUBQUEUE, value(FILEOP_DELETE),
            queue.deletes.length)).answer === 0)
        {
            return abort(ERROR_CANCELLED);
        }
        for (const entry of queue.deletes)
        {
            const target = join(entry.targetDirectory, entry.targetFile);
            const start = (await say(SPFILENOTIFY_STARTDELETE,
                { kind: 'paths', target, source: null }, FILEOP_DELETE)).answer;
            if (start === FILEOP_ABORT)
            {
                return abort(ERROR_CANCELLED);
            }
            if (start !== FILEOP_DOIT)
            {
                continue;
            }
            // A file that is not there to delete is already gone.
            host.files.remove(target);
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
            return abort(ERROR_CANCELLED);
        }
        for (const entry of queue.renames)
        {
            const source = join(entry.targetDirectory, entry.sourceFile);
            const target = join(entry.targetDirectory, entry.targetFile);
            const start = (await say(SPFILENOTIFY_STARTRENAME,
                { kind: 'paths', target, source }, FILEOP_RENAME)).answer;
            if (start === FILEOP_ABORT)
            {
                return abort(ERROR_CANCELLED);
            }
            if (start !== FILEOP_DOIT)
            {
                continue;
            }
            let error = host.files.rename(source, target) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
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
                error = host.files.rename(source, target) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
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
            return abort(ERROR_CANCELLED);
        }
        /** @type {Map<string, { skip: boolean, path: string | null }>} */
        const media = new Map();
        for (const entry of queue.copies)
        {
            const mediaKey = `${entry.description}|${entry.tagfile}|${entry.sourcePath}`
                .toLowerCase();
            let known = media.get(mediaKey);
            if (!known)
            {
                const asked = await say(SPFILENOTIFY_NEEDMEDIA, {
                    kind: 'media', tagfile: entry.tagfile, description: entry.description,
                    path: entry.sourcePath, file: entry.sourceFile, flags: entry.flags,
                }, 0);
                if (asked.answer === FILEOP_ABORT)
                {
                    return abort(ERROR_CANCELLED);
                }
                known = {
                    skip: asked.answer === FILEOP_SKIP,
                    path: asked.answer === FILEOP_NEWPATH ? asked.path : null,
                };
                media.set(mediaKey, known);
            }
            if (known.skip)
            {
                continue;
            }
            const target = join(entry.targetDirectory, entry.targetFile);
            const exists = host.files.stat(target)?.exists ?? false;
            if (exists && (entry.flags & (COPYFLG_NO_OVERWRITE | SP_COPY_NOOVERWRITE)))
            {
                continue;
            }
            if (!exists && (entry.flags & (COPYFLG_REPLACEONLY | SP_COPY_REPLACEONLY)))
            {
                continue;
            }
            let path = known.path;
            const source = join(path ?? entry.sourcePath, entry.sourceFile);
            const start = (await say(SPFILENOTIFY_STARTCOPY,
                { kind: 'paths', target, source }, FILEOP_COPY)).answer;
            if (start === FILEOP_ABORT)
            {
                return abort(ERROR_CANCELLED);
            }
            if (start !== FILEOP_DOIT)
            {
                continue;
            }
            let error;
            let skipped = false;
            for (;;)
            {
                const bytes = await sourceBytes(host, entry, path);
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
                    { kind: 'paths', target, source: join(path ?? entry.sourcePath,
                        entry.sourceFile), error }, 0);
                if (decision.answer === FILEOP_ABORT)
                {
                    return abort(error);
                }
                if (decision.answer === FILEOP_NEWPATH)
                {
                    path = decision.path;
                    continue;
                }
                if (decision.answer !== FILEOP_DOIT)
                {
                    skipped = true;
                    break;
                }
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
