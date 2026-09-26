/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shell's file operation: a list of files copied, moved, renamed or
 * deleted in one call, which is how an installer lays out what it unpacked
 * and how an uninstaller takes a whole tree away.
 *
 * The shape of an answer is worth knowing before the code. Sources are a list
 * and may carry wildcards in their last component; destinations are a list
 * too, but only the first counts unless FOF_MULTIDESTFILES says each source
 * has its own. Where there is one source and one destination the destination
 * is the new name -- unless it is an existing directory, which the source goes
 * into. Where there are several, or a wildcard, the destination is a directory
 * they all go into, made if it is not there. An empty destination is the
 * current directory. Errors are the shell's own DE_* codes as well as Win32
 * ones, and the first stops the operation where it stands, which is what a
 * program sees on Windows too.
 *
 * There is no person to ask, so a replacement Windows would have asked about
 * is made, as the question's default answer makes it, and reported. There is
 * no recycle bin either, so a delete that allowed undo is a delete; and there
 * is no dialog to show or suppress, so the flags that shape one change nothing.
 */

export const FO_MOVE = 1;
export const FO_COPY = 2;
export const FO_DELETE = 3;
export const FO_RENAME = 4;

const FOF_MULTIDESTFILES = 0x0001;
const FOF_RENAMEONCOLLISION = 0x0008;
const FOF_NOCONFIRMATION = 0x0010;
const FOF_FILESONLY = 0x0080;

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_FILE_EXISTS = 80;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_NAME = 123;
const ERROR_BAD_PATHNAME = 161;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_FILENAME_EXCED_RANGE = 206;

/** The shell's own answers, from before Win32 error codes. */
const DE_SAMEFILE = 0x71;
const DE_MANYSRC1DEST = 0x72;
const DE_DIFFDIR = 0x73;
const DE_DESTSUBTREE = 0x76;
const DE_INVALIDFILES = 0x7c;
const DE_DESTSAMETREE = 0x7d;
const DE_FLDDESTISFILE = 0x7e;
const DE_FILEDESTISFLD = 0x80;

const MAX_PATH = 260;

/** How much of a file a copy moves at a time. */
const COPY_CHUNK = 1 << 16;

/**
 * What the operation needs of the volume: kernel32's view of it, never
 * throwing, answering a read with bytes or with a promise of them.
 *
 * @typedef {Object} FileOpVolume
 * @property {(path: string) => { exists: boolean, isDirectory: boolean, size: number }
 *            | null} stat
 * @property {(path: string, pattern?: string) =>
 *            { name: string, isDirectory: boolean }[]} list
 * @property {(path: string, mode: any) => any} open
 * @property {(node: any, offset: number, length: number) =>
 *            Uint8Array | Promise<Uint8Array>} read
 * @property {(node: any, offset: number, bytes: Uint8Array) => number} write
 * @property {(node: any) => void} close
 * @property {(path: string) => boolean} remove
 * @property {(path: string) => boolean} mkdir
 * @property {(from: string, to: string) => boolean} rename
 * @property {() => string} currentDirectory
 */

/**
 * @typedef {Object} FileOpDeps
 * @property {FileOpVolume} volume
 * @property {(path: string) => string} [resolve]
 *           A path qualified against the current directory, for telling
 *           whether two spellings name one file.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @typedef {Object} FileOperation
 * @property {number} func
 * @property {string[] | null} from  Null for a NULL pFrom.
 * @property {string[] | null} to    Null for a NULL pTo.
 * @property {number} flags
 */

/**
 * Runs each item in order and stops at the first non-zero answer, without a
 * promise while nothing needs one and without a stack frame per item.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => number | Promise<number>} run
 * @returns {number | Promise<number>}
 */
const sequence = (items, run)=>{
    for (let index = 0; index < items.length; index++)
    {
        const answer = run(items[index]);
        if (typeof (/** @type {any} */ (answer))?.then === 'function')
        {
            return /** @type {Promise<number>} */ (answer).then(code=>(code !== 0
                ? code : sequence(items.slice(index + 1), run)));
        }
        if (answer !== 0)
        {
            return answer;
        }
    }
    return 0;
};

/** @param {string} path */
const nameOf = path=>path.slice(path.lastIndexOf('\\') + 1);

/**
 * The directory a path is in: the drive's root for one directly under it,
 * empty for a bare name.
 *
 * @param {string} path
 */
const parentOf = path=>{
    const at = path.lastIndexOf('\\');
    if (at < 0)
    {
        return '';
    }
    return path.slice(0, at === 0 || (at === 2 && path[1] === ':') ? at + 1 : at);
};

/** @param {string} directory @param {string} name */
const join = (directory, name)=>(directory === '' ? name
    : directory.endsWith('\\') ? directory + name : `${directory}\\${name}`);

/** @param {string} path */
const wild = path=>/[*?]/.test(nameOf(path));

/**
 * @param {FileOpDeps} deps
 */
function createRunner({ volume, resolve, divergence }){
    /** @param {string} path */
    const directoryOr = path=>(path === '' ? volume.currentDirectory() : path);

    /** Two spellings of one file compare equal. @param {string} path */
    const key = path=>{
        const full = resolve ? resolve(directoryOr(path)) : directoryOr(path);
        return full.replace(/\\+$/, '').toLowerCase();
    };

    /**
     * Why a source is not there: its directory is, and it is not in it, or
     * the directory is missing too.
     *
     * @param {string} path
     */
    const missing = path=>(volume.stat(directoryOr(parentOf(path)))?.isDirectory
        ? ERROR_FILE_NOT_FOUND : DE_INVALIDFILES);

    /**
     * Every directory of a path that is not there yet, made; false when one
     * of them is a file or cannot be made.
     *
     * @param {string} path
     */
    const makeDirectories = path=>{
        const parts = path.split('\\');
        let at = '';
        for (const [index, part] of parts.entries())
        {
            at = index === 0 ? part : `${at}\\${part}`;
            if (part === '' || (index === 0 && /^[A-Za-z]:$/.test(part)))
            {
                continue;
            }
            const entry = volume.stat(at);
            if (entry ? !entry.isDirectory : !volume.mkdir(at))
            {
                return false;
            }
        }
        return true;
    };

    /**
     * The files a source names: itself, or what its wildcard matches in its
     * directory -- only files, with FOF_FILESONLY.
     *
     * @param {string} source @param {number} flags
     */
    const expand = (source, flags)=>{
        if (!wild(source))
        {
            return [source];
        }
        const directory = parentOf(source);
        return volume.list(directoryOr(directory), nameOf(source))
            .filter(entry=>(flags & FOF_FILESONLY) === 0 || !entry.isDirectory)
            .map(entry=>join(directory, entry.name));
    };

    /**
     * A name for a copy that would land on an existing file: "Copy of" it,
     * then "Copy (2) of" it, and so on.
     *
     * @param {string} path
     */
    const freeName = path=>{
        const directory = parentOf(path);
        for (let attempt = 1; ; attempt++)
        {
            const prefix = attempt === 1 ? 'Copy of ' : `Copy (${attempt}) of `;
            const candidate = join(directory, prefix + nameOf(path));
            if (!volume.stat(candidate))
            {
                return candidate;
            }
        }
    };

    /** @param {string} from @param {string} to @returns {number | Promise<number>} */
    const copyFile = (from, to)=>{
        const size = volume.stat(from)?.size ?? 0;
        const input = volume.open(from, { read: true });
        const output = input ? volume.open(to, { write: true, create: true, truncate: true })
            : null;
        if (!input || !output)
        {
            if (input)
            {
                volume.close(input);
            }
            return ERROR_ACCESS_DENIED;
        }
        const done = ()=>{
            volume.close(input);
            volume.close(output);
            return ERROR_SUCCESS;
        };
        /** @param {number} at @returns {number | Promise<number>} */
        const step = at=>{
            while (at < size)
            {
                const chunk = volume.read(input, at, Math.min(COPY_CHUNK, size - at));
                if (typeof (/** @type {any} */ (chunk))?.then === 'function')
                {
                    const offset = at;
                    return /** @type {Promise<Uint8Array>} */ (chunk).then(bytes=>{
                        volume.write(output, offset, bytes);
                        return bytes.length === 0 ? done() : step(offset + bytes.length);
                    });
                }
                const bytes = /** @type {Uint8Array} */ (chunk);
                if (bytes.length === 0)
                {
                    break;
                }
                volume.write(output, at, bytes);
                at += bytes.length;
            }
            return done();
        };
        return step(0);
    };

    /**
     * A file or a whole tree, copied; a tree merges into a directory already
     * there.
     *
     * @param {string} from @param {string} to @returns {number | Promise<number>}
     */
    const copyTree = (from, to)=>{
        if (!volume.stat(from)?.isDirectory)
        {
            return copyFile(from, to);
        }
        if (!volume.stat(to) && !volume.mkdir(to))
        {
            return ERROR_ACCESS_DENIED;
        }
        return sequence(volume.list(from), entry=>
            copyTree(join(from, entry.name), join(to, entry.name)));
    };

    /**
     * A file or a tree, moved; a tree merges into a directory already there,
     * and a file replaces one.
     *
     * @param {string} from @param {string} to @returns {number}
     */
    const moveTree = (from, to)=>{
        const target = volume.stat(to);
        if (!target)
        {
            return volume.rename(from, to) ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
        }
        if (!target.isDirectory)
        {
            return volume.remove(to) && volume.rename(from, to)
                ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
        }
        const code = /** @type {number} */ (sequence(volume.list(from), entry=>
            moveTree(join(from, entry.name), join(to, entry.name))));
        return code !== 0 || volume.remove(from) ? code : ERROR_ACCESS_DENIED;
    };

    /** @param {string} path @returns {number} */
    const removeTree = path=>{
        if (volume.stat(path)?.isDirectory)
        {
            const code = /** @type {number} */ (sequence(volume.list(path), entry=>
                removeTree(join(path, entry.name))));
            if (code !== 0)
            {
                return code;
            }
        }
        return volume.remove(path) ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
    };

    let warned = false;

    /**
     * One source to one destination, by name.
     *
     * @param {number} func @param {number} flags
     * @param {string} from @param {string} to
     * @returns {number | Promise<number>}
     */
    const transfer = (func, flags, from, to)=>{
        const source = volume.stat(from);
        if (!source)
        {
            return missing(from);
        }
        const same = key(from);
        const other = key(to);
        if (same === other)
        {
            return source.isDirectory ? DE_DESTSAMETREE : DE_SAMEFILE;
        }
        if (source.isDirectory && other.startsWith(`${same}\\`))
        {
            return DE_DESTSUBTREE;
        }
        const target = volume.stat(to);
        if (target && target.isDirectory !== source.isDirectory)
        {
            return source.isDirectory ? DE_FLDDESTISFILE : DE_FILEDESTISFLD;
        }
        if (!makeDirectories(parentOf(to)))
        {
            return ERROR_ACCESS_DENIED;
        }
        let destination = to;
        if (target && !target.isDirectory)
        {
            if ((flags & FOF_RENAMEONCOLLISION) !== 0)
            {
                destination = freeName(to);
            }
            else if ((flags & FOF_NOCONFIRMATION) === 0 && !warned)
            {
                warned = true;
                divergence?.('SHFileOperation', 'a file is replaced without asking whether '
                    + 'to replace it');
            }
        }
        return func === FO_COPY ? copyTree(from, destination) : moveTree(from, destination);
    };

    /**
     * Copy and move: which source goes to which destination, and whether
     * the destination is a name or a directory to go into.
     *
     * @param {number} func @param {string[]} sources @param {string[]} targets
     * @param {number} flags
     * @returns {number | Promise<number>}
     */
    const copyOrMove = (func, sources, targets, flags)=>{
        const multiple = (flags & FOF_MULTIDESTFILES) !== 0;
        const wildcards = sources.some(wild);
        /** @param {string} directory @param {string} source */
        const into = (directory, source)=>join(directoryOr(directory), nameOf(source));
        /** @type {{ source: string, target: string, into: boolean }[]} */
        let plan;
        if (sources.length === 1 && !wildcards)
        {
            const target = targets[0] ?? '';
            const named = multiple || (target !== '' && !volume.stat(target)?.isDirectory);
            plan = [{ source: sources[0], target, into: !named }];
        }
        else if (multiple && !wildcards && sources.length === targets.length)
        {
            plan = sources.map((source, index)=>({ source, target: targets[index], into: false }));
        }
        else if (multiple)
        {
            plan = sources.map((source, index)=>({
                source, target: targets[index] ?? '', into: true,
            }));
        }
        else
        {
            plan = sources.map(source=>({ source, target: targets[0] ?? '', into: true }));
        }
        if (plan.some(step=>wild(step.target)))
        {
            return ERROR_INVALID_NAME;
        }
        return sequence(plan, step=>{
            if (!step.into)
            {
                return transfer(func, flags, step.source, step.target);
            }
            const directory = volume.stat(directoryOr(step.target));
            if (directory && !directory.isDirectory)
            {
                return DE_INVALIDFILES;
            }
            if (!directory && !makeDirectories(step.target))
            {
                return ERROR_ACCESS_DENIED;
            }
            return sequence(expand(step.source, flags), source=>
                transfer(func, flags, source, into(step.target, source)));
        });
    };

    /**
     * Every source is looked for before anything is deleted, so a list with
     * one name missing deletes none of the others; one that goes missing
     * because an earlier source took it with its directory stops the rest.
     *
     * @param {string[]} sources @param {number} flags @returns {number}
     */
    const remove = (sources, flags)=>{
        const absent = sources.find(source=>!wild(source) && !volume.stat(source));
        if (absent !== undefined)
        {
            return missing(absent);
        }
        return /** @type {number} */ (sequence(sources, source=>
            sequence(expand(source, flags), path=>
                (volume.stat(path) ? removeTree(path) : missing(path)))));
    };

    /**
     * @param {string[]} sources @param {string[]} targets @returns {number}
     */
    const rename = (sources, targets)=>{
        if (sources.length !== 1 || wild(sources[0]))
        {
            return DE_MANYSRC1DEST;
        }
        const [from] = sources;
        const to = targets[0] ?? '';
        const source = volume.stat(from);
        if (!source)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        if (to === '')
        {
            return DE_DIFFDIR;
        }
        if (wild(to))
        {
            return ERROR_INVALID_NAME;
        }
        if (key(parentOf(from)) !== key(parentOf(to)))
        {
            return DE_DIFFDIR;
        }
        const target = volume.stat(to);
        if (target && target.isDirectory !== source.isDirectory)
        {
            return source.isDirectory ? DE_FLDDESTISFILE : DE_FILEDESTISFLD;
        }
        return key(from) === key(to) ? ERROR_SUCCESS : moveTree(from, to);
    };

    return { copyOrMove, remove, rename, makeDirectories, missing };
}

/**
 * SHFileOperation's answer to one operation, once its lists are read: zero,
 * a Win32 error, or one of the shell's DE_* codes.
 *
 * @param {FileOpDeps} deps
 * @param {FileOperation} operation
 * @returns {number | Promise<number>}
 */
export function runFileOperation(deps, { func, from, to, flags }){
    if (from === null || func < FO_MOVE || func > FO_RENAME)
    {
        return ERROR_INVALID_PARAMETER;
    }
    const runner = createRunner(deps);
    /** @param {string[]} names */
    const tidy = names=>names.map(name=>name.replace(/\//g, '\\'));
    const sources = tidy(from);
    if (sources.some(name=>name.length >= MAX_PATH))
    {
        return DE_INVALIDFILES;
    }
    if (func === FO_DELETE)
    {
        return runner.remove(sources, flags);
    }
    if (to === null)
    {
        return ERROR_ACCESS_DENIED;
    }
    const targets = tidy(to);
    if (func === FO_RENAME)
    {
        return runner.rename(sources, targets);
    }
    // Every source is looked for first: a copy with one name missing
    // copies none of the others.
    const absent = sources.find(source=>!wild(source) && !deps.volume.stat(source));
    return absent === undefined
        ? runner.copyOrMove(func, sources, targets, flags) : runner.missing(absent);
}

/**
 * SHCreateDirectoryEx's answer: every directory of a full path made, the last
 * one not there before.
 *
 * @param {FileOpDeps} deps
 * @param {string | null} path
 */
export function createDirectoryPath(deps, path){
    if (path === null || path === '')
    {
        return ERROR_BAD_PATHNAME;
    }
    const full = path.replace(/\//g, '\\');
    if (!/^[A-Za-z]:\\/.test(full) && !full.startsWith('\\\\'))
    {
        return ERROR_BAD_PATHNAME;
    }
    if (full.length >= MAX_PATH)
    {
        return ERROR_FILENAME_EXCED_RANGE;
    }
    const existing = deps.volume.stat(full);
    if (existing)
    {
        return existing.isDirectory ? ERROR_ALREADY_EXISTS : ERROR_FILE_EXISTS;
    }
    return createRunner(deps).makeDirectories(full.replace(/\\+$/, ''))
        ? ERROR_SUCCESS : ERROR_PATH_NOT_FOUND;
}
