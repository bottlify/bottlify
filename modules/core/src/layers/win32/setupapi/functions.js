/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { INF_STYLE_OLDNT, INF_STYLE_WIN4, infText, parseInf } from './inf.js';
import { decodeFolder, folderOf, readCabinet } from '../cabinet/cabinet.js';
import { commitQueue, queueInstallSection } from './queue.js';

/**
 * setupapi — INF files, cabinets and file queues: how an installer that
 * speaks the Setup API reads its instructions and puts its files in place.
 *
 * An installer loads the library at run time and looks every entry point it
 * will need up before it does anything, so a library with any of them
 * missing is one it cannot use at all.
 *
 * The notifications a queue or a cabinet sends go to the program's own
 * callback, on the thread that asked, with the structures they point at laid
 * out in its memory; its answers decide what happens next, as they do on
 * Windows.
 */

const INVALID_HANDLE_VALUE = 0xffffffff;
const MAX_PATH = 260;

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_DATA = 13;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_USER_BUFFER = 1784;
export const ERROR_SECTION_NOT_FOUND = 0xe0000101;
export const ERROR_LINE_NOT_FOUND = 0xe0000102;
const ERROR_CLASS_MISMATCH = 0xe0000201;

/** The notifications a callback is sent. */
export const SPFILENOTIFY = Object.freeze({
    STARTQUEUE: 0x01, ENDQUEUE: 0x02, STARTSUBQUEUE: 0x03, ENDSUBQUEUE: 0x04,
    STARTDELETE: 0x05, ENDDELETE: 0x06, DELETEERROR: 0x07,
    STARTRENAME: 0x08, ENDRENAME: 0x09, RENAMEERROR: 0x0a,
    STARTCOPY: 0x0b, ENDCOPY: 0x0c, COPYERROR: 0x0d, NEEDMEDIA: 0x0e,
    CABINETINFO: 0x10, FILEINCABINET: 0x11, NEEDNEWCABINET: 0x12, FILEEXTRACTED: 0x13,
});

/** What a callback answers a STARTxxx, NEEDMEDIA or error notification with. */
export const FILEOP = Object.freeze({ ABORT: 0, DOIT: 1, SKIP: 2, NEWPATH: 4 });

/**
 * What the default callback answers besides NEEDMEDIA; anything else is NO_ERROR.
 *
 * @type {Map<number, number>}
 */
const DEFAULT_ANSWERS = new Map([
    [SPFILENOTIFY.STARTQUEUE, 1], [SPFILENOTIFY.STARTSUBQUEUE, 1],
    [SPFILENOTIFY.STARTDELETE, FILEOP.DOIT], [SPFILENOTIFY.STARTRENAME, FILEOP.DOIT],
    [SPFILENOTIFY.STARTCOPY, FILEOP.DOIT],
    [SPFILENOTIFY.DELETEERROR, FILEOP.ABORT], [SPFILENOTIFY.RENAMEERROR, FILEOP.ABORT],
    [SPFILENOTIFY.COPYERROR, FILEOP.ABORT],
]);

/** SetupInstallFromInfSection's flags. */
const SPINST_FILES = 0x10;
const SPINST_ALL = 0x3ff;

/** SetupGetInfInformation's search controls. */
const INFINFO_INF_SPEC_IS_HINF = 1;
const INFINFO_INF_NAME_IS_ABSOLUTE = 2;
const INFINFO_REVERSE_DEFAULT_SEARCH = 4;
const INFINFO_INF_PATH_LIST_SEARCH = 5;

/** FILE_IN_CABINET_INFO_A: the target name buffer, and the whole. */
const CABINET_TARGET_OFFSET = 18;
const FILE_IN_CABINET_INFO_SIZE = 280;

/** Where each notification's structures are laid out: FILEPATHS_A, SOURCE_MEDIA_A. */
const FILEPATHS_SIZE = 16;
const SOURCE_MEDIA_SIZE = 24;

/**
 * @typedef {import('../kernel32/files.js').FileSystem} FileSystem
 *
 * @typedef {Object} SetupapiHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(code: number) => void} setLastError
 * @property {(thread: any, code: number) => void} setLastErrorFor
 *           For an answer that arrives after the thread was parked.
 * @property {FileSystem} files
 * @property {(path: string) => string} fullPath  A path made absolute, as the file calls do.
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread?: any) => number | Promise<number>} call
 * @property {() => any} callerThread
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any }} handles
 * @property {Readonly<Record<string, string>>} folders  The shell's folders, for DIRIDs.
 * @property {any} [registry]  The hive, where registered OS components are kept.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {string} path */
const directoryOf = path=>{
    const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
    return at < 0 ? '' : path.slice(0, at + 1);
};

/** @param {...string} parts  Joined with single separators, empty ones dropped. */
export const joinPath = (...parts)=>parts.filter(part=>part !== '').reduce((path, part)=>(
    path === '' ? part : `${path.replace(/[\\/]+$/, '')}\\${part.replace(/^[\\/]+/, '')}`), '');

/**
 * @param {SetupapiHost} host
 */
export function createSetupapiFunctions(host){
    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {string} text */
    const ansi = text=>Uint8Array.from([...text, '\0'].map(c=>c.charCodeAt(0) & 0xff));
    /** @param {number} address */
    const text = address=>((address >>> 0) === 0 ? null : host.readCString(address >>> 0, 4096));
    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /**
     * A whole file off the volume: bytes, a promise of them for a file not
     * resident yet, or null for none.
     *
     * @param {string} path
     * @returns {Uint8Array | Promise<Uint8Array> | null}
     */
    const readWhole = path=>{
        const stat = host.files.stat(path);
        if (!stat || stat.isDirectory)
        {
            return null;
        }
        const node = host.files.open(path, { read: true });
        if (!node)
        {
            return null;
        }
        const read = host.files.read(node, 0, stat.size);
        if (read instanceof Uint8Array)
        {
            host.files.close(node);
            return read;
        }
        return read.then(bytes=>{
            host.files.close(node);
            return bytes;
        });
    };

    /**
     * Creates a directory and every one above it that is missing.
     *
     * @param {string} directory
     */
    const makeDirectories = directory=>{
        const parts = directory.replace(/[\\/]+$/, '').split(/[\\/]/);
        for (let depth = 2; depth <= parts.length; depth++)
        {
            const path = parts.slice(0, depth).join('\\');
            if (!host.files.stat(path))
            {
                host.files.mkdir(path);
            }
        }
    };

    /**
     * Writes a whole file, answering a Win32 error code.
     *
     * @param {string} path @param {Uint8Array} bytes
     */
    const writeWhole = (path, bytes)=>{
        const parent = directoryOf(path);
        if (parent !== '' && !host.files.stat(parent.replace(/[\\/]+$/, '') || parent))
        {
            return ERROR_PATH_NOT_FOUND;
        }
        const node = host.files.open(path, { write: true, create: true, truncate: true });
        if (!node)
        {
            return ERROR_ACCESS_DENIED;
        }
        host.files.write(node, 0, bytes);
        host.files.close(node);
        return ERROR_SUCCESS;
    };

    const windows = host.folders.Windows;
    const system = host.folders.System;
    /**
     * The directory a DIRID stands for, or null for one this machine has no
     * directory for.
     *
     * @param {number} id
     */
    const dirid = id=>({
        10: windows, 11: system, 12: `${system}\\drivers`, 17: `${windows}\\inf`,
        18: `${windows}\\Help`, 20: host.folders.Fonts, 24: `${windows.slice(0, 2)}\\`,
        25: windows, 30: `${windows.slice(0, 2)}\\`, 50: `${windows}\\system`,
        16406: host.folders['Common Start Menu'], 16407: host.folders['Common Programs'],
        16408: host.folders['Common Startup'], 16409: host.folders['Common Desktop'],
        16419: host.folders['Common AppData'], 16422: host.folders.ProgramFiles,
        16427: host.folders.CommonFiles, 16430: host.folders['Common Documents'],
    })[id] ?? null;

    /**
     * An open INF: what a HINF names.
     *
     * @typedef {{ inf: import('./inf.js').Inf, path: string,
     *     list: import('./inf.js').InfSection[] }} OpenInf
     */

    /** @param {number} handle @returns {OpenInf | null} */
    const openInf = handle=>{
        try
        {
            return host.handles.resolve(handle >>> 0, 'inf') ?? null;
        }
        catch {
            return null;
        }
    };

    /**
     * Where a bare INF name is looked for, in order.
     *
     * @param {string} name @param {boolean} [reverse]
     */
    const infCandidates = (name, reverse = false)=>{
        if (/[\\/]/.test(name))
        {
            return [host.fullPath(name)];
        }
        const places = [`${windows}\\inf\\${name}`, `${system}\\${name}`];
        return reverse ? places.reverse() : places;
    };

    /**
     * Loads an INF, answering the record or the error it failed with.
     *
     * @param {string} path
     * @returns {{ open: OpenInf } | { error: number, line: number }
     *     | Promise<{ open: OpenInf } | { error: number, line: number }>}
     */
    const loadInf = path=>{
        const bytes = readWhole(path);
        if (bytes === null)
        {
            return { error: ERROR_FILE_NOT_FOUND, line: 0 };
        }
        /** @param {Uint8Array} data */
        const parse = data=>{
            const result = parseInf(infText(data), { dirid });
            if ('error' in result)
            {
                return result;
            }
            return { open: { inf: result.inf, path, list: [...result.inf.sections.values()] } };
        };
        return bytes instanceof Uint8Array ? parse(bytes) : bytes.then(parse);
    };

    /**
     * INFCONTEXT: the INF twice (the one searched, and the one the line is
     * in), then the section's and the line's indices.
     *
     * @param {number} address @param {number} handle
     * @param {number} section @param {number} line
     */
    const writeContext = (address, handle, section, line)=>{
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, handle >>> 0, true);
        view.setUint32(4, handle >>> 0, true);
        view.setUint32(8, section, true);
        view.setUint32(12, line, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /** @param {number} address */
    const readContext = address=>{
        const view = new DataView(host.readMemory(address >>> 0, 16).slice().buffer);
        return {
            handle: view.getUint32(4, true),
            section: view.getUint32(8, true),
            line: view.getUint32(12, true),
        };
    };

    /**
     * Copies a text answer into the caller's buffer the way the Setup API's
     * string calls do: the size needed, terminator included, whether or not
     * a buffer came; too small a buffer is ERROR_INSUFFICIENT_BUFFER.
     *
     * @param {string} value @param {number} buffer @param {number} size @param {number} required
     */
    const answerText = (value, buffer, size, required)=>{
        const bytes = ansi(value);
        if ((required >>> 0) !== 0)
        {
            writeU32(required, bytes.length);
        }
        if ((buffer >>> 0) === 0)
        {
            return 1;
        }
        if ((size >>> 0) < bytes.length)
        {
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        host.writeMemory(buffer >>> 0, bytes);
        return 1;
    };

    /**
     * Guest memory for the structures a callback is handed, and the strings
     * they point at; given back once the notifications are over.
     */
    const scratch = ()=>{
        /** @type {number[]} */
        const blocks = [];
        return {
            /** @param {number} bytes */
            block(bytes){
                const at = host.allocate(bytes);
                if (!at)
                {
                    throw new Error('the guest heap has no room for a notification');
                }
                host.writeMemory(at, new Uint8Array(bytes));
                blocks.push(at);
                return at;
            },
            /** @param {string | null} value */
            string(value){
                if (value === null)
                {
                    return 0;
                }
                const bytes = ansi(value);
                const at = this.block(Math.max(bytes.length, MAX_PATH));
                host.writeMemory(at, bytes);
                return at;
            },
            release(){
                blocks.splice(0).forEach(at=>host.free(at));
            },
        };
    };

    /**
     * SetupIterateCabinet's walk over one cabinet: CABINETINFO, then for
     * each file FILEINCABINET, and FILEEXTRACTED for each one extracted.
     *
     * @param {Uint8Array} bytes @param {string} full @param {number} pathArgument
     * @param {number} callback @param {number} context @param {any} thread
     */
    const iterateCabinet = async(bytes, full, pathArgument, callback, context, thread)=>{
        let cabinet;
        try
        {
            cabinet = readCabinet(bytes);
        }
        catch {
            return ERROR_INVALID_DATA;
        }
        if ((callback >>> 0) === 0)
        {
            return ERROR_INVALID_DATA;
        }
        const memory = scratch();
        /** @param {number} message @param {number} param1 @param {number} param2 */
        const notify = async(message, param1, param2)=>(await host.call(callback >>> 0,
            [context >>> 0, message, param1 >>> 0, param2 >>> 0], thread)) >>> 0;
        try
        {
            const info = memory.block(16);
            const infoView = new DataView(new ArrayBuffer(16));
            infoView.setUint32(0, memory.string(directoryOf(full)), true);
            infoView.setUint32(4, memory.string(cabinet.next ?? ''), true);
            infoView.setUint32(8, memory.string(''), true);
            infoView.setUint16(12, cabinet.setId, true);
            infoView.setUint16(14, cabinet.index, true);
            host.writeMemory(info, new Uint8Array(infoView.buffer));
            const answer = await notify(SPFILENOTIFY.CABINETINFO, info, 0);
            if (answer !== ERROR_SUCCESS)
            {
                return answer;
            }

            /** @type {Map<number, Uint8Array>} */
            const streams = new Map();
            const record = memory.block(FILE_IN_CABINET_INFO_SIZE);
            const paths = memory.block(FILEPATHS_SIZE);
            for (const file of cabinet.files)
            {
                const name = memory.string(file.name);
                const fields = new DataView(new ArrayBuffer(CABINET_TARGET_OFFSET));
                fields.setUint32(0, name, true);
                fields.setUint32(4, file.size, true);
                fields.setUint32(8, 0, true);
                fields.setUint16(12, file.date, true);
                fields.setUint16(14, file.time, true);
                fields.setUint16(16, file.attributes, true);
                host.writeMemory(record, new Uint8Array(fields.buffer));
                host.writeMemory(record + CABINET_TARGET_OFFSET, new Uint8Array(MAX_PATH));
                const operation = await notify(SPFILENOTIFY.FILEINCABINET, record, pathArgument);
                if (operation === FILEOP.ABORT)
                {
                    return readU32(record + 8) || ERROR_INVALID_DATA;
                }
                if (operation !== FILEOP.DOIT)
                {
                    continue;
                }
                const target = host.readCString(record + CABINET_TARGET_OFFSET, MAX_PATH);
                let error = ERROR_SUCCESS;
                const folder = folderOf(cabinet, file);
                if (!folder)
                {
                    error = ERROR_INVALID_DATA;
                }
                else
                {
                    try
                    {
                        let stream = streams.get(file.folder);
                        if (!stream)
                        {
                            stream = decodeFolder(cabinet, file.folder);
                            streams.set(file.folder, stream);
                        }
                        error = writeWhole(host.fullPath(target),
                            stream.subarray(file.offset, file.offset + file.size));
                    }
                    catch {
                        error = ERROR_INVALID_DATA;
                    }
                }
                const pathsView = new DataView(new ArrayBuffer(FILEPATHS_SIZE));
                pathsView.setUint32(0, memory.string(target), true);
                pathsView.setUint32(4, pathArgument >>> 0, true);
                pathsView.setUint32(8, error, true);
                host.writeMemory(paths, new Uint8Array(pathsView.buffer));
                const extracted = await notify(SPFILENOTIFY.FILEEXTRACTED, paths, 0);
                if (extracted !== ERROR_SUCCESS)
                {
                    return extracted;
                }
            }
            return ERROR_SUCCESS;
        }
        finally
        {
            memory.release();
        }
    };

    /** An open file queue: what a HSPFILEQ names. */
    const newQueue = ()=>({ copies: [], deletes: [], renames: [] });

    /**
     * Runs a queue against the program's callback: the notification
     * sequence of SetupCommitFileQueue, each notification's structures laid
     * out in guest memory.
     *
     * @param {any} queue @param {number} callback @param {number} context @param {any} thread
     */
    const commit = async(queue, callback, context, thread)=>{
        const memory = scratch();
        try
        {
            const paths = memory.block(FILEPATHS_SIZE);
            const media = memory.block(SOURCE_MEDIA_SIZE);
            const newPath = memory.block(MAX_PATH);
            return await commitQueue(queue, {
                files: host.files,
                readWhole,
                writeWhole,
                makeDirectories,
                /**
                 * @param {number} message
                 * @param {{ kind: 'paths', target: string | null, source: string | null,
                 *     error?: number } | { kind: 'media', tagfile: string | null,
                 *     description: string | null, path: string, file: string, flags: number }
                 *     | { kind: 'value', value: number }} first
                 * @param {number} second
                 */
                notify: async(message, first, second)=>{
                    let param1;
                    let param2 = second;
                    if (first.kind === 'paths')
                    {
                        const view = new DataView(new ArrayBuffer(FILEPATHS_SIZE));
                        view.setUint32(0, memory.string(first.target), true);
                        view.setUint32(4, memory.string(first.source), true);
                        view.setUint32(8, first.error ?? 0, true);
                        host.writeMemory(paths, new Uint8Array(view.buffer));
                        param1 = paths;
                        if (message === SPFILENOTIFY.COPYERROR)
                        {
                            host.writeMemory(newPath, new Uint8Array(MAX_PATH));
                            param2 = newPath;
                        }
                    }
                    else if (first.kind === 'media')
                    {
                        const view = new DataView(new ArrayBuffer(SOURCE_MEDIA_SIZE));
                        view.setUint32(4, memory.string(first.tagfile), true);
                        view.setUint32(8, memory.string(first.description), true);
                        view.setUint32(12, memory.string(first.path), true);
                        view.setUint32(16, memory.string(first.file), true);
                        view.setUint32(20, first.flags, true);
                        host.writeMemory(media, new Uint8Array(view.buffer));
                        host.writeMemory(newPath, new Uint8Array(MAX_PATH));
                        param1 = media;
                        param2 = newPath;
                    }
                    else
                    {
                        param1 = first.value;
                    }
                    const answer = (await host.call(callback >>> 0,
                        [context >>> 0, message, param1 >>> 0, param2 >>> 0], thread)) >>> 0;
                    const path = param2 === newPath ? host.readCString(newPath, MAX_PATH) : '';
                    return { answer, path };
                },
            });
        }
        finally
        {
            memory.release();
        }
    };

    /**
     * Where OS components are recorded, one key per component GUID holding
     * the two structures its registration was given. The location is this
     * build's own; programs reach it only through the three calls.
     */
    const COMPONENTS_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Setup\\OsComponents';
    const HKEY_LOCAL_MACHINE = 0x80000002;

    /** @param {Uint8Array} bytes  Sixteen bytes of a GUID, as {xxxxxxxx-...}. */
    const guidText = bytes=>{
        const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
        const hex = (/** @type {number} */ value, /** @type {number} */ width)=>
            value.toString(16).toUpperCase().padStart(width, '0');
        const tail = [...bytes.subarray(8)].map(b=>hex(b, 2)).join('');
        return `{${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-`
            + `${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
    };

    return {
        /**
         * HINF SetupOpenInfFileA(PCSTR FileName, PCSTR InfClass, DWORD InfStyle,
         *                        PUINT ErrorLine)
         *
         * A bare name is looked for in the INF directory and then the
         * system directory. INVALID_HANDLE_VALUE when the file is missing,
         * does not parse (with the line in ErrorLine), is not of a style
         * asked for, or not of the class asked for.
         */
        SetupOpenInfFileA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([namePointer, classPointer, style, errorLine])=>{
                const name = text(namePointer);
                if (name === null || name === '')
                {
                    return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
                }
                const wanted = text(classPointer);
                const thread = host.callerThread();
                const candidates = infCandidates(name);
                const path = candidates.find(place=>host.files.stat(place)) ?? candidates[0];
                /** @param {{ open: OpenInf } | { error: number, line: number }} result */
                const finish = result=>{
                    /** @param {number} code @param {number} line */
                    const refuse = (code, line)=>{
                        if ((errorLine >>> 0) !== 0)
                        {
                            writeU32(errorLine, line);
                        }
                        host.setLastErrorFor(thread, code);
                        return INVALID_HANDLE_VALUE;
                    };
                    if ('error' in result)
                    {
                        return refuse(result.error, result.line);
                    }
                    const { inf } = result.open;
                    if (((style >>> 0) & inf.style) === 0)
                    {
                        return refuse(0xe0000100, 0);
                    }
                    const infClass = inf.value('Version', 'Class') ?? '';
                    if (wanted !== null && wanted !== ''
                        && infClass.toLowerCase() !== wanted.toLowerCase())
                    {
                        return refuse(ERROR_CLASS_MISMATCH, 0);
                    }
                    host.setLastErrorFor(thread, ERROR_SUCCESS);
                    return host.handles.open('inf', result.open);
                };
                const loaded = loadInf(path);
                return 'then' in loaded ? loaded.then(finish) : finish(loaded);
            },
        },

        /** VOID SetupCloseInfFile(HINF InfHandle) -- a handle that names no INF is ignored. */
        SetupCloseInfFile: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (openInf(handle))
                {
                    host.handles.close(handle >>> 0);
                }
                return 0;
            },
        },

        /**
         * BOOL SetupFindFirstLineA(HINF InfHandle, PCSTR Section, PCSTR Key,
         *                          PINFCONTEXT Context)
         *
         * With no key, the section's first line; with one, the first line
         * whose key matches it, case aside. ERROR_LINE_NOT_FOUND for either
         * missing, the section included.
         */
        SetupFindFirstLineA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, sectionPointer, keyPointer, context])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const name = (text(sectionPointer) ?? '').toLowerCase();
                const index = open.list.findIndex(section=>section.name.toLowerCase() === name);
                const key = text(keyPointer)?.toLowerCase() ?? null;
                const lines = index < 0 ? [] : open.list[index].lines;
                const line = key === null
                    ? (lines.length > 0 ? 0 : -1)
                    : lines.findIndex(entry=>entry.key?.toLowerCase() === key);
                if (line < 0)
                {
                    return fail(ERROR_LINE_NOT_FOUND);
                }
                writeContext(context, handle, index, line);
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupFindNextLine(PINFCONTEXT ContextIn, PINFCONTEXT ContextOut)
         *
         * The next line of the same section, or ERROR_LINE_NOT_FOUND at its end.
         */
        SetupFindNextLine: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([contextIn, contextOut])=>{
                const at = readContext(contextIn);
                const open = openInf(at.handle);
                if (!open || !open.list[at.section])
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (at.line + 1 >= open.list[at.section].lines.length)
                {
                    return fail(ERROR_LINE_NOT_FOUND);
                }
                writeContext(contextOut, at.handle, at.section, at.line + 1);
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupGetLineTextA(PINFCONTEXT Context, HINF InfHandle, PCSTR Section,
         *     PCSTR Key, PSTR ReturnBuffer, DWORD ReturnBufferSize, PDWORD RequiredSize)
         *
         * A line's fields after the key, joined by commas, found by context
         * or else by section and key.
         */
        SetupGetLineTextA: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([context, handle, sectionPointer, keyPointer, buffer, size, required])=>{
                /** @type {import('./inf.js').InfLine | undefined} */
                let line;
                if ((context >>> 0) !== 0)
                {
                    const at = readContext(context);
                    line = openInf(at.handle)?.list[at.section]?.lines[at.line];
                    if (!line)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                }
                else
                {
                    const open = openInf(handle);
                    if (!open)
                    {
                        return fail(ERROR_INVALID_HANDLE);
                    }
                    const key = (text(keyPointer) ?? '').toLowerCase();
                    line = open.inf.section(text(sectionPointer) ?? '')?.lines
                        .find(entry=>entry.key?.toLowerCase() === key);
                    if (!line)
                    {
                        return fail(ERROR_LINE_NOT_FOUND);
                    }
                }
                const answered = answerText(line.fields.join(','), buffer, size, required);
                return answered ? fail(ERROR_SUCCESS, 1) : 0;
            },
        },

        /**
         * BOOL SetupGetInfInformationA(LPCVOID InfSpec, DWORD SearchControl,
         *     PSP_INF_INFORMATION ReturnBuffer, DWORD ReturnBufferSize, PDWORD RequiredSize)
         *
         * SP_INF_INFORMATION: the style, a count of one, and version data
         * whose layout the documentation leaves to the library -- here the
         * INF's full path and then its [Version] lines as key=value
         * strings, a terminator after each and an empty one after the last.
         * The size needed is reported whatever the buffer; a NULL buffer
         * with a size no smaller than that is ERROR_INVALID_PARAMETER.
         */
        SetupGetInfInformationA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([spec, search, buffer, size, required])=>{
                const control = search >>> 0;
                if (control < INFINFO_INF_SPEC_IS_HINF || control > INFINFO_INF_PATH_LIST_SEARCH)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const thread = host.callerThread();
                /** @param {OpenInf} open */
                const answer = open=>{
                    const version = open.inf.section('Version')?.lines ?? [];
                    const data = [open.path, ...version.map(line=>
                        `${line.key ?? ''}=${line.fields.join(',')}`), ''];
                    const strings = data.map(ansi);
                    const total = 8 + strings.reduce((sum, bytes)=>sum + bytes.length, 0) - 1;
                    if ((required >>> 0) !== 0)
                    {
                        writeU32(required, total);
                    }
                    if ((buffer >>> 0) === 0)
                    {
                        const refused = (size >>> 0) >= total;
                        host.setLastErrorFor(thread,
                            refused ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS);
                        return refused ? 0 : 1;
                    }
                    if ((size >>> 0) < total)
                    {
                        host.setLastErrorFor(thread, ERROR_INSUFFICIENT_BUFFER);
                        return 0;
                    }
                    const out = new Uint8Array(total);
                    const view = new DataView(out.buffer);
                    view.setUint32(0, open.inf.style, true);
                    view.setUint32(4, 1, true);
                    let at = 8;
                    for (const bytes of strings.slice(0, -1))
                    {
                        out.set(bytes, at);
                        at += bytes.length;
                    }
                    host.writeMemory(buffer >>> 0, out);
                    host.setLastErrorFor(thread, ERROR_SUCCESS);
                    return 1;
                };
                if (control === INFINFO_INF_SPEC_IS_HINF)
                {
                    const open = openInf(spec);
                    return open ? answer(open) : fail(ERROR_INVALID_HANDLE);
                }
                const name = text(spec);
                if (name === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const candidates = control === INFINFO_INF_NAME_IS_ABSOLUTE
                    ? [host.fullPath(name)]
                    : infCandidates(name, control === INFINFO_REVERSE_DEFAULT_SEARCH);
                const path = candidates.find(place=>host.files.stat(place));
                if (path === undefined)
                {
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                const loaded = loadInf(path);
                /** @param {{ open: OpenInf } | { error: number, line: number }} result */
                const finish = result=>{
                    if ('error' in result)
                    {
                        host.setLastErrorFor(thread, result.error);
                        return 0;
                    }
                    return answer(result.open);
                };
                return 'then' in loaded ? loaded.then(finish) : finish(loaded);
            },
        },

        /**
         * BOOL SetupIterateCabinetA(PCSTR CabinetFile, DWORD Reserved,
         *                           PSP_FILE_CALLBACK_A MsgHandler, PVOID Context)
         *
         * Wine's setupapi cabinet tests: NULL is ERROR_INVALID_PARAMETER, an
         * empty name ERROR_NOT_ENOUGH_MEMORY, a missing file
         * ERROR_FILE_NOT_FOUND, and a file that is not a cabinet -- or a
         * cabinet with no callback to report to -- ERROR_INVALID_DATA. A
         * callback that aborts, or answers an extraction with an error,
         * ends the walk with that error.
         */
        SetupIterateCabinetA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([cabinetPointer, , callback, context])=>{
                const name = text(cabinetPointer);
                if (name === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (name === '')
                {
                    return fail(ERROR_NOT_ENOUGH_MEMORY);
                }
                const full = host.fullPath(name);
                const bytes = readWhole(full);
                if (bytes === null)
                {
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                const thread = host.callerThread();
                return Promise.resolve(bytes)
                    .then(data=>
                        iterateCabinet(data, full, cabinetPointer, callback, context, thread))
                    .then(code=>{
                        host.setLastErrorFor(thread, code);
                        return code === ERROR_SUCCESS ? 1 : 0;
                    });
            },
        },

        /** HSPFILEQ SetupOpenFileQueue(VOID) */
        SetupOpenFileQueue: {
            argBytes: 0,
            handler: ()=>host.handles.open('file-queue', newQueue()),
        },

        /** BOOL SetupCloseFileQueue(HSPFILEQ QueueHandle) */
        SetupCloseFileQueue: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                try
                {
                    host.handles.resolve(handle >>> 0, 'file-queue');
                }
                catch {
                    return fail(ERROR_INVALID_HANDLE);
                }
                host.handles.close(handle >>> 0);
                return 1;
            },
        },

        /**
         * UINT SetupDefaultQueueCallbackA(PVOID Context, UINT Notification,
         *                                 UINT_PTR Param1, UINT_PTR Param2)
         *
         * What the system does when a program lets it: go on with every
         * operation, tell NEEDMEDIA the media is where the queue said (the
         * source path copied into Param2's buffer), and -- with no one to
         * ask whether to retry -- abort on an error. Every END notification
         * is answered NO_ERROR.
         */
        SetupDefaultQueueCallbackA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, notification, param1, param2])=>{
                const message = notification >>> 0;
                if (message === SPFILENOTIFY.NEEDMEDIA)
                {
                    const path = text(readU32((param1 >>> 0) + 12)) ?? '';
                    if ((param2 >>> 0) !== 0)
                    {
                        host.writeMemory(param2 >>> 0, ansi(path.slice(0, MAX_PATH - 1)));
                    }
                    return FILEOP.DOIT;
                }
                return DEFAULT_ANSWERS.get(message) ?? ERROR_SUCCESS;
            },
        },

        /**
         * BOOL SetupInstallFromInfSectionA(HWND Owner, HINF InfHandle, PCSTR SectionName,
         *     UINT Flags, HKEY RelativeKeyRoot, PCSTR SourceRootPath, UINT CopyFlags,
         *     PSP_FILE_CALLBACK_A MsgHandler, PVOID Context, HDEVINFO DeviceInfoSet,
         *     PSP_DEVINFO_DATA DeviceInfoData)
         *
         * SPINST_FILES queues the section's CopyFiles, DelFiles and RenFiles
         * and commits them through MsgHandler, sources found from the root
         * (the INF's own directory when none is given) by SourceDisksNames
         * and SourceDisksFiles, in a cabinet when the disk's tag file is one.
         * The section's other directives are not carried out here, and each
         * one met is reported as a divergence.
         */
        SetupInstallFromInfSectionA: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([, handle, sectionPointer, flags, , rootPointer, copyFlags, callback,
                context])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const name = text(sectionPointer) ?? '';
                const section = open.inf.section(name);
                if (!section)
                {
                    return fail(ERROR_SECTION_NOT_FOUND);
                }
                const wanted = (flags >>> 0) & SPINST_ALL;
                for (const line of section.lines)
                {
                    const directive = line.key?.toLowerCase() ?? '';
                    if (!['copyfiles', 'delfiles', 'renfiles'].includes(directive)
                        && directive !== '' && wanted & ~SPINST_FILES)
                    {
                        host.divergence?.('SetupInstallFromInfSectionA',
                            `the ${line.key} directive is not carried out`);
                    }
                }
                if ((wanted & SPINST_FILES) === 0)
                {
                    return fail(ERROR_SUCCESS, 1);
                }
                if ((callback >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const root = text(rootPointer) || directoryOf(open.path).replace(/\\$/, '');
                const queue = newQueue();
                queueInstallSection(queue, open.inf, section, {
                    root, copyFlags: copyFlags >>> 0, dirid,
                });
                const thread = host.callerThread();
                return commit(queue, callback, context, thread).then(code=>{
                    host.setLastErrorFor(thread, code);
                    return code === ERROR_SUCCESS ? 1 : 0;
                });
            },
        },

        /**
         * BOOL SetupQueryRegisteredOsComponent(LPGUID ComponentGuid,
         *     PSETUP_OS_COMPONENT_DATA SetupOsComponentData,
         *     PSETUP_OS_EXCEPTION_DATA SetupOsExceptionData)
         *
         * Undocumented, like its two companions: the component's two
         * structures as registered, given back into the caller's -- each
         * led by its own size, which must be the one registered. A
         * component never registered is ERROR_FILE_NOT_FOUND, the code its
         * callers test for.
         */
        SetupQueryRegisteredOsComponent: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([guidPointer, dataPointer, exceptionPointer])=>{
                if ((guidPointer >>> 0) === 0 || (dataPointer >>> 0) === 0
                    || (exceptionPointer >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const hive = host.registry;
                const key = hive?.open(hive.root(HKEY_LOCAL_MACHINE),
                    `${COMPONENTS_KEY}\\${guidText(host.readMemory(guidPointer >>> 0, 16))}`);
                if (!key)
                {
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                const data = hive.getValue(key, 'ComponentData')?.data;
                const exception = hive.getValue(key, 'ExceptionData')?.data;
                if (!(data instanceof Uint8Array) || !(exception instanceof Uint8Array))
                {
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                if (readU32(dataPointer) !== data.length
                    || readU32(exceptionPointer) !== exception.length)
                {
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                host.writeMemory(dataPointer >>> 0, data);
                host.writeMemory(exceptionPointer >>> 0, exception);
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupRegisterOsComponent(PSETUP_OS_COMPONENT_DATA SetupOsComponentData,
         *                               PSETUP_OS_EXCEPTION_DATA SetupOsExceptionData)
         *
         * Keeps both structures, as long as each says it is, under the
         * component's GUID -- the field after the first structure's size.
         */
        SetupRegisterOsComponent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([dataPointer, exceptionPointer])=>{
                const hive = host.registry;
                if ((dataPointer >>> 0) === 0 || (exceptionPointer >>> 0) === 0 || !hive)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const dataSize = readU32(dataPointer);
                const exceptionSize = readU32(exceptionPointer);
                if (dataSize < 20 || dataSize > 0x10000 || exceptionSize < 4
                    || exceptionSize > 0x10000)
                {
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                const data = host.readMemory(dataPointer >>> 0, dataSize).slice();
                const { key } = hive.create(hive.root(HKEY_LOCAL_MACHINE),
                    `${COMPONENTS_KEY}\\${guidText(data.subarray(4, 20))}`);
                hive.setValue(key, 'ComponentData', 3, data);
                hive.setValue(key, 'ExceptionData', 3,
                    host.readMemory(exceptionPointer >>> 0, exceptionSize).slice());
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /** BOOL SetupUnRegisterOsComponent(LPGUID ComponentGuid) */
        SetupUnRegisterOsComponent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([guidPointer])=>{
                const hive = host.registry;
                if ((guidPointer >>> 0) === 0 || !hive)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const removed = hive.remove(hive.root(HKEY_LOCAL_MACHINE),
                    `${COMPONENTS_KEY}\\${guidText(host.readMemory(guidPointer >>> 0, 16))}`);
                return removed === 'deleted' ? fail(ERROR_SUCCESS, 1) : fail(ERROR_FILE_NOT_FOUND);
            },
        },
    };
}

export { INF_STYLE_OLDNT, INF_STYLE_WIN4 };
