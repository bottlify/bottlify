/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { INF_STYLE_OLDNT, INF_STYLE_WIN4, infText, parseInf } from './inf.js';
import { decodeFolder, folderOf, readCabinet } from '../cabinet/cabinet.js';
import { expand as expandLz, readHeader as lzHeader } from '../lz32/expand.js';
import {
    commitQueue, lookup, queueInstallSection, targetDirectory as listTarget,
} from './queue.js';
import { standardDirids } from './dirids.js';
import { createStringTableFunctions } from './stringtable.js';
import {
    CLASS_KEY, DEVICE_CLASSES_KEY, GUID_NULL, SPINT, createDeviceStore, interfacePath,
} from './devices.js';
import { installRegistry } from './registry.js';
import { CATALOG_STORE } from '../sfc/functions.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { HKEY_CLASSES_ROOT, HKEY_USERS } from '../advapi32/registry.js';

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
const ERROR_FILE_EXISTS = 80;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_NO_SUCH_DEVINST = 0xe000020b;
export const ERROR_SECTION_NOT_FOUND = 0xe0000101;
export const ERROR_LINE_NOT_FOUND = 0xe0000102;
const ERROR_CLASS_MISMATCH = 0xe0000201;
const ERROR_INVALID_DEVINST_NAME = 0xe0000205;
const ERROR_DEVINST_ALREADY_EXISTS = 0xe0000207;
const ERROR_NO_ASSOCIATED_CLASS = 0xe0000200;
const ERROR_INVALID_MACHINENAME = 0xe0000220;
const ERROR_INVALID_CLASS = 0xe0000206;

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

/** SetupCopyOEMInf's copy styles that change its answer. */
const SP_COPY_REPLACEONLY = 0x2;
const SP_COPY_NOOVERWRITE = 0x8;

/** SetupDiGetClassDevs: every class rather than the one named, and interfaces rather than devices. */
const DIGCF_ALLCLASSES = 0x4;
const DIGCF_DEVICEINTERFACE = 0x10;

/** SetupDiCreateDeviceInfo: make the instance id, under ROOT. */
const DICD_GENERATE_ID = 0x1;

/** SetupDiOpenClassRegKeyEx: the installer's classes, or the interfaces'. */
const DIOCR_INSTALLER = 0x1;
const DIOCR_INTERFACE = 0x2;

/** SP_DEVINSTALL_PARAMS' flags: no file queue of the installer's own. */
const DI_NOVCP = 0x8;

/** SP_DEVINFO_LIST_DETAIL_DATA's sizes: a GUID, a handle and 263 characters. */
const LIST_DETAIL_A_SIZE = 288;
const LIST_DETAIL_W_SIZE = 552;

/** SP_DEVICE_INTERFACE_DETAIL_DATA's cbSize: a DWORD and the first character of the path. */
const DETAIL_A_SIZE = 5;
const DETAIL_W_SIZE = 6;

/** sizeof(SP_DEVINFO_DATA): cbSize, the class GUID, DevInst, Reserved. */
const SP_DEVINFO_DATA_SIZE = 28;
/** SP_DEVICE_INTERFACE_DATA's cbSize: a GUID, two DWORDs and a ULONG_PTR. */
const SP_DEVICE_INTERFACE_DATA_SIZE = 28;

/** The first DIRID a program may assign with SetupSetDirectoryId. */
const DIRID_USER = 0x8000;

/**
 * A default queue callback's context as Windows lays it out, which a caller
 * may read: the magic "SPQC", the owner, and past fields of its own the
 * progress window and its message.
 */
const DEFAULT_CONTEXT = Object.freeze({ SIZE: 80, MAGIC: 0x43515053, OWNER: 4, PROGRESS: 52,
    MESSAGE: 56 });

/** What SetupGetFileCompressionInfo says a file is. */
const FILE_COMPRESSION = Object.freeze({ NONE: 0, WINLZA: 1, MSZIP: 2, NTCAB: 3 });

/** A setup log's severities: LogSevMaximum and above are none. */
const LOG_SEVERITY_MAXIMUM = 4;
const ERROR_FILE_INVALID = 1006;

/** SetupInstallFromInfSection's flags. */
const SPINST_REGISTRY = 0x04;
const SPINST_FILES = 0x10;
const SPINST_ALL = 0x3ff;

/** SetupGetInfInformation's search controls. */
const INFINFO_INF_SPEC_IS_HINF = 1;
const INFINFO_INF_NAME_IS_ABSOLUTE = 2;
const INFINFO_REVERSE_DEFAULT_SEARCH = 4;
const INFINFO_INF_PATH_LIST_SEARCH = 5;

/** FILE_IN_CABINET_INFO_A and _W: the target name buffer, and the whole. */
const CABINET_TARGET_OFFSET = 18;
const FILE_IN_CABINET_INFO_SIZE = 280;
const FILE_IN_CABINET_INFO_W_SIZE = 540;

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
 * @property {any} [registry]  The hive: where registered OS components are kept, and
 *           what an install section's AddReg and DelReg write.
 * @property {(path: string) => number} [keyHandle]
 *           An HKEY for a key under HKEY_LOCAL_MACHINE, from the registry's
 *           own handle table; 0 for a key that is not there.
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
    /** Terminated, in the ANSI page. @param {string} text */
    const ansi = text=>encodeAnsi(`${text}\0`);
    /** @param {number} address */
    const text = address=>((address >>> 0) === 0 ? null : host.readCString(address >>> 0, 4096));
    /**
     * A string argument in the call's width: UTF-16 for a W call.
     *
     * @param {number} address @param {boolean} wide
     */
    const textOf = (address, wide)=>{
        if (!wide)
        {
            return text(address);
        }
        return (address >>> 0) === 0 ? null
            : /** @type {NonNullable<typeof host.readWideString>} */ (host.readWideString)(
                address >>> 0, 8192);
    };
    /** Terminated, in the call's width. @param {string} value @param {boolean} wide */
    const encodeIn = (value, wide)=>{
        if (!wide)
        {
            return ansi(value);
        }
        const bytes = new Uint8Array((value.length + 1) * 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < value.length; at++)
        {
            view.setUint16(at * 2, value.charCodeAt(at), true);
        }
        return bytes;
    };
    /** @param {number} code @param {number} [result] */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /**
     * A name a program passed as a path, made absolute; null for one that
     * names no file at all -- empty, or nothing but blanks -- which the
     * volume refuses outright.
     *
     * @param {string} name
     */
    const pathOf = name=>{
        try
        {
            return host.fullPath(name);
        }
        catch {
            return null;
        }
    };

    /**
     * A whole file off the volume: bytes, a promise of them for a file not
     * resident yet, or null for none.
     *
     * @param {string | null} path
     * @returns {Uint8Array | Promise<Uint8Array> | null}
     */
    const readWhole = path=>{
        if (path === null)
        {
            return null;
        }
        // A path the volume refuses outright -- a component of blanks --
        // names no file, which is the answer the caller is after.
        let stat;
        try
        {
            stat = host.files.stat(path);
        }
        catch {
            return null;
        }
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
     * @param {string | null} path @param {Uint8Array} bytes
     */
    const writeWhole = (path, bytes)=>{
        if (path === null)
        {
            return ERROR_PATH_NOT_FOUND;
        }
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
    /** The directory a DIRID stands for, or null for one this machine has none for. */
    const dirid = standardDirids(host.folders);

    /**
     * An open INF: what a HINF names, and the user DIRIDs set on it.
     *
     * @typedef {{ inf: import('./inf.js').Inf, path: string,
     *     list: import('./inf.js').InfSection[], ids: Map<number, string>,
     *     fields?: Map<string, number> }} OpenInf
     * `fields`: the wide copies `pSetupGetField` handed out, by section, line
     * and field, given back when the INF is closed.
     */

    /**
     * What a DIRID stands for in one INF: its own user DIRIDs first.
     *
     * @param {OpenInf} open
     */
    const diridOf = open=>(/** @type {number} */ id)=>open.ids.get(id) ?? dirid(id);

    /**
     * A value with the user DIRIDs set since the INF was opened put in: the
     * parser leaves a %N% it could not resolve as written, and a user DIRID is
     * only known after opening. As the parser does, a directory's trailing
     * separator merges with one that follows it.
     *
     * @param {OpenInf} open @param {string} value
     */
    const expand = (open, value)=>(open.ids.size === 0 || !value.includes('%') ? value
        : value.replace(/%(\d+)%/g, (whole, id, at, all)=>{
            const directory = open.ids.get(Number(id));
            if (directory === undefined)
            {
                return whole;
            }
            return directory.endsWith('\\') && all[at + whole.length] === '\\'
                ? directory.slice(0, -1) : directory;
        }));

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
            const path = pathOf(name);
            return path === null ? [] : [path];
        }
        const places = [`${windows}\\inf\\${name}`, `${system}\\${name}`];
        return reverse ? places.reverse() : places;
    };

    /**
     * Loads an INF, answering the record or the error it failed with.
     *
     * @param {string | undefined} path  Undefined for a name that names no file.
     * @returns {{ open: OpenInf } | { error: number, line: number }
     *     | Promise<{ open: OpenInf } | { error: number, line: number }>}
     */
    const loadInf = path=>{
        const bytes = path === undefined ? null : readWhole(path);
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
            return { open: { inf: result.inf, path: /** @type {string} */ (path),
                list: [...result.inf.sections.values()],
                ids: new Map() } };
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
     * Sizes count the call's characters: bytes for an A call, WCHARs for a
     * W one.
     *
     * @param {string} value @param {number} buffer @param {number} size @param {number} required
     * @param {boolean} [wide]
     */
    const answerText = (value, buffer, size, required, wide = false)=>{
        const bytes = encodeIn(value, wide);
        const characters = wide ? bytes.length / 2 : bytes.length;
        if ((required >>> 0) !== 0)
        {
            writeU32(required, characters);
        }
        if ((buffer >>> 0) === 0)
        {
            return 1;
        }
        if ((size >>> 0) < characters)
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
            /** @param {string | null} value @param {boolean} [wide] */
            string(value, wide = false){
                if (value === null)
                {
                    return 0;
                }
                const bytes = encodeIn(value, wide);
                const at = this.block(Math.max(bytes.length, MAX_PATH * (wide ? 2 : 1)));
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
     * The notifications' structures are the W ones for the W call: strings
     * in UTF-16, and the target name a buffer of WCHARs.
     *
     * @param {Uint8Array} bytes @param {string} full @param {number} pathArgument
     * @param {number} callback @param {number} context @param {any} thread
     * @param {boolean} wide
     */
    const iterateCabinet = async(bytes, full, pathArgument, callback, context, thread, wide)=>{
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
            infoView.setUint32(0, memory.string(directoryOf(full), wide), true);
            infoView.setUint32(4, memory.string(cabinet.next ?? '', wide), true);
            infoView.setUint32(8, memory.string('', wide), true);
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
            const recordSize = wide ? FILE_IN_CABINET_INFO_W_SIZE : FILE_IN_CABINET_INFO_SIZE;
            const record = memory.block(recordSize);
            const paths = memory.block(FILEPATHS_SIZE);
            for (const file of cabinet.files)
            {
                const name = memory.string(file.name, wide);
                const fields = new DataView(new ArrayBuffer(CABINET_TARGET_OFFSET));
                fields.setUint32(0, name, true);
                fields.setUint32(4, file.size, true);
                fields.setUint32(8, 0, true);
                fields.setUint16(12, file.date, true);
                fields.setUint16(14, file.time, true);
                fields.setUint16(16, file.attributes, true);
                host.writeMemory(record, new Uint8Array(fields.buffer));
                host.writeMemory(record + CABINET_TARGET_OFFSET,
                    new Uint8Array(recordSize - CABINET_TARGET_OFFSET));
                const operation = await notify(SPFILENOTIFY.FILEINCABINET, record, pathArgument);
                if (operation === FILEOP.ABORT)
                {
                    return readU32(record + 8) || ERROR_INVALID_DATA;
                }
                if (operation !== FILEOP.DOIT)
                {
                    continue;
                }
                const target = textOf(record + CABINET_TARGET_OFFSET, wide) ?? '';
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
                        error = writeWhole(pathOf(target),
                            stream.subarray(file.offset, file.offset + file.size));
                    }
                    catch {
                        error = ERROR_INVALID_DATA;
                    }
                }
                const pathsView = new DataView(new ArrayBuffer(FILEPATHS_SIZE));
                pathsView.setUint32(0, memory.string(target, wide), true);
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

    /**
     * Merges an INF into an open one: lines of a section both have go after
     * the open one's, and new sections after its last, where an INFCONTEXT's
     * section index reaches them.
     *
     * @param {OpenInf} open @param {import('./inf.js').Inf} inf
     */
    const appendInf = (open, inf)=>{
        for (const [lower, section] of inf.sections)
        {
            const there = open.inf.sections.get(lower);
            if (there)
            {
                there.lines.push(...section.lines);
            }
            else
            {
                open.inf.sections.set(lower, section);
                open.list.push(section);
            }
        }
    };

    /** An open file queue: what a HSPFILEQ names. */
    const newQueue = ()=>({ copies: [], deletes: [], renames: [] });

    /**
     * The queue a HSPFILEQ names, or null for a handle that is not one.
     *
     * @param {number} handle @returns {import('./queue.js').FileQueue | null}
     */
    const fileQueue = handle=>{
        try
        {
            return host.handles.resolve(handle >>> 0, 'file-queue') ?? null;
        }
        catch {
            return null;
        }
    };

    /** The contexts SetupInitDefaultQueueCallback handed out, not yet given back. */
    const callbackContexts = new Set();

    /**
     * A default callback's context: the windows it was told of, in a block
     * the program holds and gives back. SetupDefaultQueueCallback has no one
     * to show progress to, so it does not read it.
     *
     * @param {number} owner @param {number} progress @param {number} message
     */
    const defaultContext = (owner, progress, message)=>{
        const at = host.allocate(DEFAULT_CONTEXT.SIZE);
        if (!at)
        {
            return fail(ERROR_NOT_ENOUGH_MEMORY);
        }
        const bytes = new Uint8Array(DEFAULT_CONTEXT.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, DEFAULT_CONTEXT.MAGIC, true);
        view.setUint32(DEFAULT_CONTEXT.OWNER, owner >>> 0, true);
        view.setUint32(DEFAULT_CONTEXT.PROGRESS, progress >>> 0, true);
        view.setUint32(DEFAULT_CONTEXT.MESSAGE, message >>> 0, true);
        host.writeMemory(at, bytes);
        callbackContexts.add(at);
        return at;
    };

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
     * SetupDiGetActualSectionToInstall's body.
     *
     * @param {number} handle @param {string | null} section @param {number} buffer
     * @param {number} size @param {number} required @param {number} extension
     * @param {boolean} wide
     */
    const actualSection = (handle, section, buffer, size, required, extension, wide)=>{
        const open = openInf(handle);
        if (!open)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if (section === null)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const decoration = ['.NTx86', '.NT'].find(suffix=>open.inf.section(section + suffix))
            ?? '';
        if (!answerText(section + decoration, buffer, size, required, wide))
        {
            return 0;
        }
        if ((extension >>> 0) !== 0 && (buffer >>> 0) !== 0)
        {
            writeU32(extension, decoration === '' ? 0
                : (buffer >>> 0) + section.length * (wide ? 2 : 1));
        }
        return fail(ERROR_SUCCESS, 1);
    };

    /**
     * The key of a class, or of all of them: the installer's under
     * Control\\Class, the interfaces' under Control\\DeviceClasses -- the
     * root made when it is not there yet.
     *
     * @param {string | null} classGuid @param {number} flags
     */
    const classKey = (classGuid, flags)=>{
        const root = flags === DIOCR_INTERFACE ? DEVICE_CLASSES_KEY : CLASS_KEY;
        const hive = host.registry;
        if (!hive || !host.keyHandle)
        {
            return fail(ERROR_INVALID_CLASS, INVALID_HANDLE_VALUE);
        }
        if (classGuid === null)
        {
            hive.create(hive.root(HKEY_LOCAL_MACHINE), root);
            return fail(ERROR_SUCCESS, host.keyHandle(root) || INVALID_HANDLE_VALUE);
        }
        const handle = host.keyHandle(`${root}\\${classGuid}`);
        return handle ? fail(ERROR_SUCCESS, handle)
            : fail(ERROR_INVALID_CLASS, INVALID_HANDLE_VALUE);
    };

    /**
     * SetupDiInstallClass's body.
     *
     * @param {string | null} name @param {number} flags @param {number} queue
     */
    const installClass = (name, flags, queue)=>{
        if (name === null || ((flags & DI_NOVCP) !== 0 && queue === 0))
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const hive = host.registry;
        const candidates = infCandidates(name);
        const path = candidates.find(place=>host.files.stat(place)) ?? candidates[0];
        const thread = host.callerThread();
        /** @param {{ open: OpenInf } | { error: number, line: number }} result */
        const finish = result=>{
            if ('error' in result)
            {
                host.setLastErrorFor(thread, result.error);
                return 0;
            }
            const { inf } = result.open;
            const guid = (inf.value('Version', 'ClassGUID') ?? '').toLowerCase();
            if (!hive || !/^\{[0-9a-f-]{36}\}$/.test(guid))
            {
                host.setLastErrorFor(thread, ERROR_INVALID_CLASS);
                return 0;
            }
            const { key } = hive.create(hive.root(HKEY_LOCAL_MACHINE), `${CLASS_KEY}\\${guid}`);
            hive.setValue(key, 'Class', 1, ansi(inf.value('Version', 'Class') ?? ''));
            const section = ['ClassInstall32.NTx86', 'ClassInstall32.NT', 'ClassInstall32']
                .map(candidate=>inf.section(candidate)).find(Boolean);
            if (section)
            {
                installRegistry(hive, inf, section, {
                    relativeRoot: key,
                    expand: value=>expand(result.open, value),
                    divergence: detail=>host.divergence?.('SetupDiInstallClass', detail),
                });
            }
            host.setLastErrorFor(thread, ERROR_SUCCESS);
            return 1;
        };
        const loaded = loadInf(path);
        return 'then' in loaded ? loaded.then(finish) : finish(loaded);
    };

    /** Where devices and their interfaces are kept: the registry. */
    const devices = host.registry ? createDeviceStore(host.registry) : null;
    devices?.seedMachine();

    /**
     * The set a HDEVINFO names, or null for a handle that is not one.
     *
     * @param {number} handle @returns {import('./devices.js').DeviceSet | null}
     */
    const deviceSet = handle=>{
        try
        {
            return host.handles.resolve(handle >>> 0, 'device-info-set') ?? null;
        }
        catch {
            return null;
        }
    };

    /** A new, empty set. @param {string | null} classGuid */
    const newSet = classGuid=>host.handles.open('device-info-set',
        { classGuid, devices: [], made: new Set(), faces: new Map() });

    /** A GUID from guest memory, as lower-case text; null for none. @param {number} pointer */
    const guidAt = pointer=>((pointer >>> 0) === 0 ? null
        : guidText(host.readMemory(pointer >>> 0, 16).slice()).toLowerCase());

    /** @param {number} address @param {string} guid  Braced. */
    const writeGuid = (address, guid)=>{
        const hex = guid.replace(/[{}-]/g, '');
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, Number.parseInt(hex.slice(0, 8), 16), true);
        view.setUint16(4, Number.parseInt(hex.slice(8, 12), 16), true);
        view.setUint16(6, Number.parseInt(hex.slice(12, 16), 16), true);
        for (let at = 0; at < 8; at++)
        {
            bytes[8 + at] = Number.parseInt(hex.slice(16 + at * 2, 18 + at * 2), 16);
        }
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * SP_DEVINFO_DATA after its cbSize: the class, the device node, and
     * which device of its set it is.
     *
     * @param {number} address @param {import('./devices.js').Device} device
     */
    const writeDevice = (address, device)=>{
        writeGuid(address + 4, device.classGuid);
        writeU32(address + 20, device.devnode);
        writeU32(address + 24, device.key);
    };

    /**
     * Device data a set handed out: its cbSize right and its device the
     * set's. Null otherwise.
     *
     * @param {import('./devices.js').DeviceSet} set @param {number} address
     */
    const deviceIn = (set, address)=>{
        if ((address >>> 0) === 0 || readU32(address) !== SP_DEVINFO_DATA_SIZE)
        {
            return null;
        }
        const key = readU32(address + 24);
        return set.devices.find(device=>device.key === key) ?? null;
    };

    /**
     * A new or opened device's answer: its data written when the caller's
     * structure is the right size, ERROR_INVALID_USER_BUFFER when it is not
     * -- the device in the set either way.
     *
     * @param {number} data @param {import('./devices.js').Device} device
     */
    const answerDevice = (data, device)=>{
        if ((data >>> 0) === 0)
        {
            return fail(ERROR_SUCCESS, 1);
        }
        if (readU32(data) !== SP_DEVINFO_DATA_SIZE)
        {
            return fail(ERROR_INVALID_USER_BUFFER);
        }
        writeDevice(data, device);
        return fail(ERROR_SUCCESS, 1);
    };

    /** Interface handles: what SP_DEVICE_INTERFACE_DATA's Reserved names. */
    let nextFace = 1;

    /**
     * SP_DEVICE_INTERFACE_DATA after its cbSize: the class, the flags, and
     * which interface of its set it is.
     *
     * @param {number} address @param {import('./devices.js').DeviceSet} set
     * @param {import('./devices.js').Device} device
     * @param {import('./devices.js').DeviceInterface} face
     */
    const writeInterface = (address, set, device, face)=>{
        const { faces } = set;
        let key = [...faces].find(([, held])=>held.face === face)?.[0];
        if (key === undefined)
        {
            key = nextFace++;
            faces.set(key, { device, face });
        }
        writeGuid(address + 4, face.classGuid);
        writeU32(address + 20, face.flags);
        writeU32(address + 24, key);
    };

    /**
     * Interface data a set handed out, as its device and interface; null
     * for data that is not that.
     *
     * @param {import('./devices.js').DeviceSet} set @param {number} address
     */
    const interfaceIn = (set, address)=>{
        if ((address >>> 0) === 0 || readU32(address) !== SP_DEVICE_INTERFACE_DATA_SIZE)
        {
            return null;
        }
        const held = set.faces.get(readU32(address + 24));
        return held && held.device.interfaces.includes(held.face) ? held : null;
    };

    /**
     * SetupDiGetClassDevs's body: a set of the devices asked for, added to
     * the set given or a new one.
     *
     * @param {string | null} classGuid @param {string | null} enumerator
     * @param {number} flags @param {number} into
     */
    const classDevices = (classGuid, enumerator, flags, into)=>{
        const allClasses = (flags & DIGCF_ALLCLASSES) !== 0;
        const byInterface = (flags & DIGCF_DEVICEINTERFACE) !== 0;
        if (classGuid === null && !allClasses)
        {
            return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
        }
        const parts = enumerator?.split('\\') ?? [];
        if (enumerator !== null && (enumerator === '' || parts.includes('')
            || (parts.length >= 3 && !byInterface)))
        {
            return fail(ERROR_INVALID_DATA, INVALID_HANDLE_VALUE);
        }
        const existing = into === 0 ? null : deviceSet(into);
        if (into !== 0 && !existing)
        {
            return fail(ERROR_INVALID_HANDLE, INVALID_HANDLE_VALUE);
        }
        const handle = existing ? into
            : newSet(allClasses || byInterface ? null : classGuid);
        const set = /** @type {import('./devices.js').DeviceSet} */ (deviceSet(handle));
        const prefix = parts.map(part=>part.toUpperCase());
        for (const id of devices?.allInstances() ?? [])
        {
            const idParts = id.toUpperCase().split('\\');
            if (!devices?.registered(id) || prefix.some((part, at)=>idParts[at] !== part)
                || set.devices.some(device=>device.id.toUpperCase() === id.toUpperCase()))
            {
                continue;
            }
            const deviceClass = devices.classOf(id);
            const entry = devices.entry(id, deviceClass);
            if (byInterface)
            {
                entry.interfaces = entry.interfaces.filter(face=>allClasses
                    || face.classGuid === classGuid);
                if (entry.interfaces.length === 0)
                {
                    continue;
                }
            }
            else
            {
                if (!allClasses && deviceClass !== classGuid)
                {
                    continue;
                }
                entry.interfaces = [];
            }
            set.devices.push(entry);
        }
        return fail(ERROR_SUCCESS, handle);
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

    /**
     * What a file is, compressed or not: an LZ-compressed (SZDD) file the
     * size its header promises; a cabinet the size of its first file, which
     * is what decompressing it gives, called MSZIP whatever its folders
     * use, as Windows calls it; anything else itself. Null for a file that
     * is not there.
     *
     * @param {Uint8Array} bytes
     */
    const compressionOf = bytes=>{
        const lz = lzHeader(bytes);
        if (lz)
        {
            return { type: FILE_COMPRESSION.WINLZA, target: lz.length };
        }
        if (bytes[0] === 0x4d && bytes[1] === 0x53 && bytes[2] === 0x43 && bytes[3] === 0x46)
        {
            try
            {
                const first = readCabinet(bytes).files[0];
                if (first)
                {
                    return { type: FILE_COMPRESSION.MSZIP, target: first.size };
                }
            }
            catch {
                // Not a cabinet after all: what it is, is itself.
            }
        }
        return { type: FILE_COMPRESSION.NONE, target: bytes.length };
    };

    /**
     * A file's bytes as a type says to read them: an LZ file expanded, a
     * cabinet's first file, anything else as it is. Null for bytes that are
     * not what the type says.
     *
     * @param {Uint8Array} bytes @param {number} type
     */
    const decompressed = (bytes, type)=>{
        if (type === FILE_COMPRESSION.WINLZA)
        {
            return expandLz(bytes);
        }
        if (type === FILE_COMPRESSION.MSZIP || type === FILE_COMPRESSION.NTCAB)
        {
            try
            {
                const cabinet = readCabinet(bytes);
                const first = cabinet.files[0];
                return first ? decodeFolder(cabinet, first.folder)
                    .slice(first.offset, first.offset + first.size) : null;
            }
            catch {
                return null;
            }
        }
        return bytes;
    };

    /** The setup log's two files once SetupOpenLog has opened them. */
    let log = /** @type {{ actions: string, errors: string } | null} */ (null);

    /** @param {string} path @param {string} line */
    const appendLog = (path, line)=>{
        const node = host.files.open(path, { write: true, create: true });
        if (node)
        {
            host.files.write(node, host.files.stat(path)?.size ?? 0, encodeAnsi(line));
            host.files.close(node);
        }
    };

    /**
     * A call's ANSI and wide entries: the one factory, told whether the
     * call's strings are UTF-16, under each name.
     *
     * @template {string} N @template T
     * @param {N} name @param {(wide: boolean) => T} make
     * @returns {Record<`${N}A` | `${N}W`, T>}
     */
    const bothWidths = (name, make)=>/** @type {Record<`${N}A` | `${N}W`, T>} */ (
        /** @type {unknown} */ ({ [`${name}A`]: make(false), [`${name}W`]: make(true) }));

    return {
        ...host.readWideString ? createStringTableFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readWideString: host.readWideString,
            allocate: host.allocate,
            free: host.free,
        }) : {},

        /**
         * HINF SetupOpenInfFileA(PCSTR FileName, PCSTR InfClass, DWORD InfStyle,
         *                        PUINT ErrorLine)
         *
         * A bare name is looked for in the INF directory and then the
         * system directory. INVALID_HANDLE_VALUE when the file is missing,
         * does not parse (with the line in ErrorLine), is not of a style
         * asked for, or not of the class asked for.
         */
        ...bothWidths('SetupOpenInfFile', wide=>({
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([namePointer, classPointer, style, errorLine])=>{
                const name = textOf(namePointer, wide);
                if (name === null || name === '')
                {
                    return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
                }
                const wanted = textOf(classPointer, wide);
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
        })),

        /** VOID SetupCloseInfFile(HINF InfHandle) -- a handle that names no INF is ignored. */
        SetupCloseInfFile: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const open = openInf(handle);
                if (open)
                {
                    open.fields?.forEach(address=>host.free(address));
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
        ...bothWidths('SetupFindFirstLine', wide=>({
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, sectionPointer, keyPointer, context])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const name = (textOf(sectionPointer, wide) ?? '').toLowerCase();
                const index = open.list.findIndex(section=>section.name.toLowerCase() === name);
                const key = textOf(keyPointer, wide)?.toLowerCase() ?? null;
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
        })),

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
        ...bothWidths('SetupGetLineText', wide=>({
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([context, handle, sectionPointer, keyPointer, buffer, size, required])=>{
                /** @type {import('./inf.js').InfLine | undefined} */
                let line;
                /** @type {OpenInf | null} */
                let open;
                if ((context >>> 0) !== 0)
                {
                    const at = readContext(context);
                    open = openInf(at.handle);
                    line = open?.list[at.section]?.lines[at.line];
                    if (!open || !line)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                }
                else
                {
                    open = openInf(handle);
                    if (!open)
                    {
                        return fail(ERROR_INVALID_HANDLE);
                    }
                    const key = (textOf(keyPointer, wide) ?? '').toLowerCase();
                    line = open.inf.section(textOf(sectionPointer, wide) ?? '')?.lines
                        .find(entry=>entry.key?.toLowerCase() === key);
                    if (!line)
                    {
                        return fail(ERROR_LINE_NOT_FOUND);
                    }
                }
                const value = line.fields.map(field=>expand(/** @type {OpenInf} */ (open), field))
                    .join(',');
                const answered = answerText(value, buffer, size, required, wide);
                return answered ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /**
         * BOOL SetupGetStringFieldA(PINFCONTEXT Context, DWORD FieldIndex,
         *     PSTR ReturnBuffer, DWORD ReturnBufferSize, PDWORD RequiredSize)
         *
         * Field 0 is the line's key -- which a line of several fields and no
         * `=` does not have -- and field N the Nth value after it. A field
         * that is not there is ERROR_INVALID_PARAMETER.
         */
        ...bothWidths('SetupGetStringField', wide=>({
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([context, index, buffer, size, required])=>{
                if ((context >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const at = readContext(context);
                const open = openInf(at.handle);
                const line = open?.list[at.section]?.lines[at.line];
                if (!open || !line)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const field = (index >>> 0) === 0 ? line.key : line.fields[(index >>> 0) - 1];
                if (field === null || field === undefined)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const answered = answerText(expand(open, field), buffer, size, required, wide);
                return answered ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /**
         * BOOL SetupGetBinaryField(PINFCONTEXT Context, DWORD FieldIndex,
         *     PBYTE ReturnBuffer, DWORD ReturnBufferSize, LPDWORD RequiredSize)
         *
         * The fields from FieldIndex (1-based; 0 is not data) to the end of
         * the line, each one byte in hexadecimal; a field that is not one is
         * ERROR_INVALID_DATA. The size needed is reported whatever the buffer.
         */
        SetupGetBinaryField: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([context, index, buffer, size, required])=>{
                if ((context >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const at = readContext(context);
                const line = openInf(at.handle)?.list[at.section]?.lines[at.line];
                const first = index >>> 0;
                if (!line || first === 0 || first > line.fields.length)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const fields = line.fields.slice(first - 1);
                if (!fields.every(field=>/^(0x)?[0-9a-f]+$/i.test(field)
                    && Number.parseInt(field, 16) <= 0xff))
                {
                    return fail(ERROR_INVALID_DATA);
                }
                if ((required >>> 0) !== 0)
                {
                    writeU32(required, fields.length);
                }
                if ((buffer >>> 0) === 0)
                {
                    return fail(ERROR_SUCCESS, 1);
                }
                if ((size >>> 0) < fields.length)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory(buffer >>> 0,
                    Uint8Array.from(fields, field=>Number.parseInt(field, 16)));
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * LONG SetupGetLineCountA(HINF InfHandle, PCSTR Section)
         *
         * -1 for a section that is not there, with ERROR_SECTION_NOT_FOUND
         * (Wine's setupapi test_GLE) -- how a caller tells a missing section
         * from an empty one, as it does probing for a platform-decorated one.
         */
        ...bothWidths('SetupGetLineCount', wide=>({
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, sectionPointer])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE, -1);
                }
                const section = open.inf.section(textOf(sectionPointer, wide) ?? '');
                return section ? fail(ERROR_SUCCESS, section.lines.length)
                    : fail(ERROR_SECTION_NOT_FOUND, -1);
            },
        })),

        /**
         * BOOL SetupGetLineByIndexA(HINF InfHandle, PCSTR Section, DWORD Index,
         *                           PINFCONTEXT Context)
         *
         * ERROR_LINE_NOT_FOUND for a section that is not there as well as
         * for an index past its end.
         */
        ...bothWidths('SetupGetLineByIndex', wide=>({
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, sectionPointer, index, context])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const name = (textOf(sectionPointer, wide) ?? '').toLowerCase();
                const section = open.list.findIndex(entry=>entry.name.toLowerCase() === name);
                if (section < 0 || (index >>> 0) >= open.list[section].lines.length)
                {
                    return fail(ERROR_LINE_NOT_FOUND);
                }
                writeContext(context, handle, section, index >>> 0);
                return fail(ERROR_SUCCESS, 1);
            },
        })),

        /**
         * BOOL SetupFindNextMatchLineA(PINFCONTEXT ContextIn, PCSTR Key,
         *                              PINFCONTEXT ContextOut), and the W form
         *
         * The next line of the section whose key is Key, case aside, or with
         * no key the next line; ERROR_LINE_NOT_FOUND past the last.
         */
        ...bothWidths('SetupFindNextMatchLine', wide=>({
            argBytes: 12,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [contextIn, keyPointer, contextOut])=>{
                const at = readContext(contextIn);
                const open = openInf(at.handle);
                const lines = open?.list[at.section]?.lines;
                if (!lines)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const key = textOf(keyPointer, wide)?.toLowerCase() ?? null;
                const found = lines.findIndex((entry, index)=>index > at.line
                    && (key === null || entry.key?.toLowerCase() === key));
                if (found < 0)
                {
                    return fail(ERROR_LINE_NOT_FOUND);
                }
                writeContext(contextOut, at.handle, at.section, found);
                return fail(ERROR_SUCCESS, 1);
            },
        })),

        /**
         * BOOL SetupEnumInfSectionsA(HINF InfHandle, UINT Index, PSTR Buffer,
         *                            DWORD Size, UINT *SizeNeeded), and the W form
         *
         * The name of the INF's section of that index, in file order; past
         * the last, ERROR_NO_MORE_ITEMS. The size needed is reported first;
         * no buffer with a size is ERROR_INVALID_USER_BUFFER.
         */
        ...bothWidths('SetupEnumInfSections', wide=>({
            argBytes: 20,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, index, buffer, size, needed])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const section = open.list[index >>> 0];
                if (!section)
                {
                    return fail(ERROR_NO_MORE_ITEMS);
                }
                if ((buffer >>> 0) === 0 && (size >>> 0) !== 0)
                {
                    if ((needed >>> 0) !== 0)
                    {
                        writeU32(needed, section.name.length + 1);
                    }
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                return answerText(section.name, buffer, size, needed, wide)
                    ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /**
         * DWORD SetupGetFieldCount(PINFCONTEXT Context)
         *
         * The fields after the key: a line of several fields and no `=` has
         * them all.
         */
        SetupGetFieldCount: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([context])=>{
                const at = readContext(context);
                const line = openInf(at.handle)?.list[at.section]?.lines[at.line];
                return line ? fail(ERROR_SUCCESS, line.fields.length)
                    : fail(ERROR_INVALID_PARAMETER);
            },
        },

        /**
         * BOOL SetupGetIntField(PINFCONTEXT Context, DWORD FieldIndex, PINT IntegerValue)
         *
         * The field as strtol reads it with its base from its prefix (0x
         * hexadecimal, 0 octal), the whole field a number; an empty field is
         * 0. Anything else is ERROR_INVALID_DATA, the value untouched.
         */
        SetupGetIntField: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([context, index, value])=>{
                const at = readContext(context);
                const open = openInf(at.handle);
                const line = open?.list[at.section]?.lines[at.line];
                if (!open || !line)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const raw = (index >>> 0) === 0 ? line.key : line.fields[(index >>> 0) - 1];
                if (raw === null || raw === undefined)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const field = expand(open, raw).trim();
                const number = /^([+-]?)(?:0x([0-9a-f]+)|(0[0-7]*)|([1-9][0-9]*))$/i.exec(field);
                if (field !== '' && !number)
                {
                    return fail(ERROR_INVALID_DATA);
                }
                let magnitude = 0;
                if (number)
                {
                    magnitude = number[2] !== undefined ? Number.parseInt(number[2], 16)
                        : number[3] !== undefined ? Number.parseInt(number[3], 8)
                            : Number(number[4]);
                    magnitude = Math.min(magnitude, number[1] === '-' ? 0x80000000 : 0x7fffffff);
                }
                writeU32(value, number?.[1] === '-' ? -magnitude : magnitude);
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupGetMultiSzFieldA(PINFCONTEXT Context, DWORD FieldIndex,
         *     PSTR ReturnBuffer, DWORD ReturnBufferSize, LPDWORD RequiredSize),
         *     and the W form
         *
         * The fields from FieldIndex (1-based) to the end of the line, each
         * terminated, and an empty string after the last.
         */
        ...bothWidths('SetupGetMultiSzField', wide=>({
            argBytes: 20,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [context, index, buffer, size, required])=>{
                const at = readContext(context);
                const open = openInf(at.handle);
                const line = open?.list[at.section]?.lines[at.line];
                const first = index >>> 0;
                if (!open || !line || first === 0 || first > line.fields.length)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const joined = `${line.fields.slice(first - 1)
                    .map(field=>expand(open, field)).join('\0')}\0`;
                return answerText(joined, buffer, size, required, wide)
                    ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /**
         * PCWSTR pSetupGetField(PINFCONTEXT Context, DWORD FieldIndex)
         *
         * The field itself, wide, kept with the INF until it is closed;
         * field 0 the key. NULL with ERROR_INVALID_PARAMETER for a field the
         * line has not.
         */
        pSetupGetField: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([context, index])=>{
                const at = readContext(context);
                const open = openInf(at.handle);
                const line = open?.list[at.section]?.lines[at.line];
                const raw = !line ? undefined
                    : (index >>> 0) === 0 ? line.key : line.fields[(index >>> 0) - 1];
                if (!open || raw === null || raw === undefined)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                open.fields ??= new Map();
                const name = `${at.section}:${at.line}:${index >>> 0}`;
                let address = open.fields.get(name);
                if (address === undefined)
                {
                    const bytes = encodeIn(expand(open, raw), true);
                    address = host.allocate(bytes.length);
                    if (!address)
                    {
                        return fail(ERROR_NOT_ENOUGH_MEMORY);
                    }
                    host.writeMemory(address, bytes);
                    open.fields.set(name, address);
                }
                return fail(ERROR_SUCCESS, address);
            },
        },

        /**
         * BOOL SetupQueryInfFileInformationA(PSP_INF_INFORMATION InfInformation,
         *     UINT InfIndex, PSTR ReturnBuffer, DWORD ReturnBufferSize,
         *     PDWORD RequiredSize), and the W form
         *
         * The path of the INF of that index in what SetupGetInfInformation
         * wrote, which leads its version data; an index past the count is
         * ERROR_INVALID_PARAMETER.
         */
        ...bothWidths('SetupQueryInfFileInformation', wide=>({
            argBytes: 20,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [information, index, buffer, size, required])=>{
                if ((information >>> 0) === 0 || (index >>> 0) >= readU32(information + 4))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const path = textOf(information + 8, wide) ?? '';
                return answerText(path, buffer, size, required, wide)
                    ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /**
         * BOOL SetupGetSourceFileLocationA(HINF InfHandle, PINFCONTEXT InfContext,
         *     PCSTR FileName, PUINT SourceId, PSTR ReturnBuffer,
         *     DWORD ReturnBufferSize, PDWORD RequiredSize), and the W form
         *
         * The disk a file comes from and its path on it, from its
         * [SourceDisksFiles] line. With a context, the file is the one the
         * context's copy line names where it goes -- whatever name is passed,
         * as Windows looks it up. ERROR_LINE_NOT_FOUND for a file no line names.
         */
        ...bothWidths('SetupGetSourceFileLocation', wide=>({
            argBytes: 28,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, context, namePointer, sourceId, buffer,
                size, required])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                let name = textOf(namePointer, wide) ?? '';
                if ((context >>> 0) !== 0)
                {
                    const at = readContext(context);
                    const line = openInf(at.handle)?.list[at.section]?.lines[at.line];
                    name = line?.fields[0] ?? line?.key ?? '';
                }
                const disk = name === '' ? null : lookup(open.inf, 'SourceDisksFiles', name);
                if (!disk)
                {
                    return fail(ERROR_LINE_NOT_FOUND);
                }
                if ((sourceId >>> 0) !== 0)
                {
                    writeU32(sourceId, Number.parseInt(disk.fields[0] ?? '', 10) || 0);
                }
                return answerText(expand(open, disk.fields[1] ?? ''), buffer, size, required, wide)
                    ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /**
         * BOOL SetupGetSourceInfoA(HINF InfHandle, UINT SourceId, UINT InfoDesired,
         *     PSTR ReturnBuffer, DWORD ReturnBufferSize, LPDWORD RequiredSize),
         *     and the W form
         *
         * A [SourceDisksNames] line's fields by what is asked: SRCINFO_PATH
         * (1) its fourth, SRCINFO_TAGFILE (2) its second, SRCINFO_DESCRIPTION
         * (3) its first, SRCINFO_TAGFILE2 (5) its sixth -- empty when the line
         * has not got it. ERROR_LINE_NOT_FOUND for a disk no line names.
         */
        ...bothWidths('SetupGetSourceInfo', wide=>({
            argBytes: 24,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, sourceId, desired, buffer, size,
                required])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const field = ({ 1: 3, 2: 1, 3: 0, 5: 5 })[desired >>> 0];
                if (field === undefined)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const disk = lookup(open.inf, 'SourceDisksNames', String(sourceId >>> 0));
                if (!disk)
                {
                    return fail(ERROR_LINE_NOT_FOUND);
                }
                return answerText(expand(open, disk.fields[field] ?? ''), buffer, size, required,
                    wide) ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /**
         * BOOL SetupGetTargetPathA(HINF InfHandle, PINFCONTEXT InfContext,
         *     PCSTR Section, PSTR ReturnBuffer, DWORD ReturnBufferSize,
         *     PDWORD RequiredSize), and the W form
         *
         * Where a file list's files go, by the context's section or the
         * section named: its DestinationDirs entry, the INF's DefaultDestDir,
         * or the system directory. A context whose section is none of the
         * INF's has the default.
         */
        ...bothWidths('SetupGetTargetPath', wide=>({
            argBytes: 24,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, context, sectionPointer, buffer, size,
                required])=>{
                let open = openInf(handle);
                let list = textOf(sectionPointer, wide) ?? '';
                if ((context >>> 0) !== 0)
                {
                    const at = readContext(context);
                    open = openInf(at.handle) ?? open;
                    list = open?.list[at.section]?.name ?? '';
                }
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const path = listTarget(open.inf, list, diridOf(open));
                return answerText(path, buffer, size, required, wide)
                    ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /** PVOID MyMalloc(DWORD Size) -- setupapi's own heap, which MyFree gives back to */
        MyMalloc: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([size])=>host.allocate(Math.max(1, size >>> 0)),
        },

        /** VOID MyFree(PVOID Block) */
        MyFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                if ((block >>> 0) !== 0)
                {
                    host.free(block >>> 0);
                }
                return 0;
            },
        },

        /**
         * DWORD SetupGetFileCompressionInfoA(PCSTR SourceFileName,
         *     PSTR *ActualSourceFileName, PDWORD SourceFileSize,
         *     PDWORD TargetFileSize, PUINT CompressionType), and the W form
         *
         * Every pointer is wanted: ERROR_INVALID_PARAMETER without one. The
         * name it hands back is the source's, from setupapi's heap, which
         * MyFree gives back. The error, or 0.
         */
        ...bothWidths('SetupGetFileCompressionInfo', wide=>({
            argBytes: 20,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [sourcePointer, nameOut, sourceSize, targetSize,
                type])=>{
                const source = textOf(sourcePointer, wide);
                if (source === null || [nameOut, sourceSize, targetSize, type]
                    .some(pointer=>(pointer >>> 0) === 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const bytes = readWhole(pathOf(source));
                /** @param {Uint8Array | null} data */
                const answer = data=>{
                    if (data === null)
                    {
                        return ERROR_FILE_NOT_FOUND;
                    }
                    const encoded = encodeIn(source, wide);
                    const name = host.allocate(encoded.length);
                    if (!name)
                    {
                        return ERROR_NOT_ENOUGH_MEMORY;
                    }
                    host.writeMemory(name, encoded);
                    const what = compressionOf(data);
                    writeU32(nameOut, name);
                    writeU32(sourceSize, data.length);
                    writeU32(targetSize, what.target);
                    writeU32(type, what.type);
                    return ERROR_SUCCESS;
                };
                return bytes instanceof Promise ? bytes.then(answer) : answer(bytes);
            },
        })),

        /**
         * BOOL SetupGetFileCompressionInfoExA(PCSTR SourceFileName,
         *     PSTR ActualSourceFileNameBuffer, DWORD ActualSourceFileNameBufferLen,
         *     PDWORD RequiredBufferLen, PDWORD SourceFileSize, PDWORD TargetFileSize,
         *     PUINT CompressionType), and the W form
         *
         * The size the name needs is reported first, whatever follows; no
         * buffer, or a file that is not there, is then a failure.
         */
        ...bothWidths('SetupGetFileCompressionInfoEx', wide=>({
            argBytes: 28,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [sourcePointer, buffer, length, required,
                sourceSize, targetSize, type])=>{
                const source = textOf(sourcePointer, wide);
                if (source === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((required >>> 0) !== 0)
                {
                    writeU32(required, source.length + 1);
                }
                if ((buffer >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const bytes = readWhole(pathOf(source));
                /** @param {Uint8Array | null} data */
                const answer = data=>{
                    if (data === null)
                    {
                        return fail(ERROR_FILE_NOT_FOUND);
                    }
                    if ((length >>> 0) < source.length + 1)
                    {
                        return fail(ERROR_INSUFFICIENT_BUFFER);
                    }
                    host.writeMemory(buffer >>> 0, encodeIn(source, wide));
                    const what = compressionOf(data);
                    for (const [pointer, value] of [[sourceSize, data.length],
                        [targetSize, what.target], [type, what.type]])
                    {
                        if ((pointer >>> 0) !== 0)
                        {
                            writeU32(pointer, value);
                        }
                    }
                    return 1;
                };
                return bytes instanceof Promise ? bytes.then(answer) : answer(bytes);
            },
        })),

        /**
         * DWORD SetupDecompressOrCopyFileA(PCSTR SourceFileName, PCSTR TargetFileName,
         *     PUINT CompressionType), and the W form
         *
         * The source written to the target as the type says to read it --
         * no type, the type it is -- a cabinet giving its first file. No
         * source or target, or a type that is none, is ERROR_INVALID_PARAMETER.
         * The error, or 0.
         */
        ...bothWidths('SetupDecompressOrCopyFile', wide=>({
            argBytes: 12,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [sourcePointer, targetPointer, typePointer])=>{
                const source = textOf(sourcePointer, wide);
                const target = textOf(targetPointer, wide);
                const asked = (typePointer >>> 0) === 0 ? null : readU32(typePointer);
                if (source === null || target === null
                    || (asked !== null && asked > FILE_COMPRESSION.NTCAB))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const bytes = readWhole(pathOf(source));
                /** @param {Uint8Array | null} data */
                const copy = data=>{
                    if (data === null)
                    {
                        return ERROR_FILE_NOT_FOUND;
                    }
                    const out = decompressed(data, asked ?? compressionOf(data).type);
                    return out === null ? ERROR_INVALID_DATA
                        : writeWhole(pathOf(target), out);
                };
                return bytes instanceof Promise ? bytes.then(copy) : copy(bytes);
            },
        })),

        /**
         * BOOL SetupUninstallOEMInfA(PCSTR InfFileName, DWORD Flags, PVOID Reserved),
         *     and the W form
         *
         * An INF the INF directory holds removed, with the precompiled one
         * beside it; ERROR_FILE_NOT_FOUND for one it has not.
         */
        ...bothWidths('SetupUninstallOEMInf', wide=>({
            argBytes: 12,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [namePointer])=>{
                const name = textOf(namePointer, wide);
                if (name === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const path = `${windows}\\inf\\${name}`;
                if (name === '' || /[\\/]/.test(name) || !host.files.stat(path)?.exists)
                {
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                host.files.remove(path);
                host.files.remove(path.replace(/\.inf$/i, '.pnf'));
                return fail(ERROR_SUCCESS, 1);
            },
        })),

        /**
         * BOOL SetupOpenLog(BOOL Erase)
         *
         * The setup log opened: setupact.log and setuperr.log in the Windows
         * directory, emptied first when asked. Opening an open log is not
         * an error.
         */
        SetupOpenLog: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([erase])=>{
                log = { actions: `${windows}\\setupact.log`, errors: `${windows}\\setuperr.log` };
                if ((erase >>> 0) !== 0)
                {
                    writeWhole(log.actions, new Uint8Array(0));
                    writeWhole(log.errors, new Uint8Array(0));
                }
                return 1;
            },
        },

        /** VOID SetupCloseLog(void) */
        SetupCloseLog: {
            argBytes: 0,
            handler: ()=>{
                log = null;
                return 0;
            },
        },

        /**
         * BOOL SetupLogErrorA(PCSTR MessageString, LogSeverity Severity), and the W form
         *
         * The message added to the action log, and to the error log too for
         * an error or a fatal error. No log open is ERROR_FILE_INVALID; a
         * severity that is none fails with the last error untouched.
         */
        ...bothWidths('SetupLogError', wide=>({
            argBytes: 8,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [messagePointer, severity])=>{
                if (!log)
                {
                    return fail(ERROR_FILE_INVALID);
                }
                if ((severity >>> 0) >= LOG_SEVERITY_MAXIMUM)
                {
                    return 0;
                }
                const message = textOf(messagePointer, wide) ?? '';
                appendLog(log.actions, message);
                if ((severity >>> 0) >= 2)
                {
                    appendLog(log.errors, message);
                }
                return 1;
            },
        })),

        /** WORD CM_Get_Version(void) -- version 4.0 of the configuration manager */
        CM_Get_Version: {
            argBytes: 0,
            handler: ()=>0x0400,
        },

        /**
         * BOOL SetupSetDirectoryIdA(HINF InfHandle, DWORD Id, PCSTR Directory)
         *
         * A user DIRID (DIRID_USER, 0x8000, and above) for this INF alone:
         * what its DestinationDirs and its %N% stand for from now on. A NULL
         * directory unassigns the id, and id 0 unassigns every one; an id
         * below DIRID_USER is ERROR_INVALID_PARAMETER.
         */
        ...bothWidths('SetupSetDirectoryId', wide=>({
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, id, directoryPointer])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const number = id >>> 0;
                if (number === 0)
                {
                    open.ids.clear();
                    return fail(ERROR_SUCCESS, 1);
                }
                if (number < DIRID_USER)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const directory = textOf(directoryPointer, wide);
                if (directory === null)
                {
                    open.ids.delete(number);
                }
                else
                {
                    open.ids.set(number, directory);
                }
                return fail(ERROR_SUCCESS, 1);
            },
        })),

        /**
         * BOOL SetupOpenAppendInfFileA(PCSTR FileName, HINF InfHandle, PUINT ErrorLine)
         *
         * Another INF's sections become the open one's: a section it already
         * has gets the lines after its own, and the others are added after
         * its last. A NULL name means each file [Version]'s LayoutFile lists,
         * and no LayoutFile is ERROR_LINE_NOT_FOUND. A name is looked for as
         * SetupOpenInfFile looks for it; a file that does not parse leaves
         * its line in ErrorLine.
         */
        ...bothWidths('SetupOpenAppendInfFile', wide=>({
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([namePointer, handle, errorLine])=>{
                const open = openInf(handle);
                if (!open)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const name = textOf(namePointer, wide);
                let names = name === null ? null : [name];
                if (names === null)
                {
                    const layout = open.inf.section('Version')?.lines
                        .find(line=>line.key?.toLowerCase() === 'layoutfile');
                    if (!layout)
                    {
                        return fail(ERROR_LINE_NOT_FOUND);
                    }
                    names = layout.fields.filter(field=>field !== '');
                }
                const thread = host.callerThread();
                const loads = names.map(file=>{
                    const candidates = infCandidates(file);
                    return loadInf(candidates.find(place=>host.files.stat(place))
                        ?? candidates[0]);
                });
                /** @param {({ open: OpenInf } | { error: number, line: number })[]} results */
                const finish = results=>{
                    for (const result of results)
                    {
                        if ('error' in result)
                        {
                            if ((errorLine >>> 0) !== 0)
                            {
                                writeU32(errorLine, result.line);
                            }
                            host.setLastErrorFor(thread, result.error);
                            return 0;
                        }
                        appendInf(open, result.open.inf);
                    }
                    host.setLastErrorFor(thread, ERROR_SUCCESS);
                    return 1;
                };
                return loads.some(loaded=>'then' in loaded) ? Promise.all(loads).then(finish)
                    : finish(/** @type {({ open: OpenInf } | { error: number, line: number })[]} */
                        (loads));
            },
        })),

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
        ...bothWidths('SetupGetInfInformation', wide=>({
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
                    const strings = data.map(value=>encodeIn(value, wide));
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
                const name = textOf(spec, wide);
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
        })),

        /**
         * BOOL SetupIterateCabinetA(PCSTR CabinetFile, DWORD Reserved,
         *                           PSP_FILE_CALLBACK_A MsgHandler, PVOID Context),
         *     and the W form, whose callback is handed the W structures
         *
         * Wine's setupapi cabinet tests: NULL is ERROR_INVALID_PARAMETER, an
         * empty name ERROR_NOT_ENOUGH_MEMORY, a missing file
         * ERROR_FILE_NOT_FOUND, and a file that is not a cabinet -- or a
         * cabinet with no callback to report to -- ERROR_INVALID_DATA. A
         * callback that aborts, or answers an extraction with an error,
         * ends the walk with that error.
         */
        ...bothWidths('SetupIterateCabinet', wide=>({
            argBytes: 16,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [cabinetPointer, , callback, context])=>{
                const name = textOf(cabinetPointer, wide);
                if (name === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (name === '')
                {
                    return fail(ERROR_NOT_ENOUGH_MEMORY);
                }
                const full = pathOf(name);
                const bytes = readWhole(full);
                if (full === null || bytes === null)
                {
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                const thread = host.callerThread();
                return Promise.resolve(bytes)
                    .then(data=>iterateCabinet(data, full, cabinetPointer, callback, context,
                        thread, wide))
                    .then(code=>{
                        host.setLastErrorFor(thread, code);
                        return code === ERROR_SUCCESS ? 1 : 0;
                    });
            },
        })),

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

        /** PVOID SetupInitDefaultQueueCallback(HWND OwnerWindow) */
        SetupInitDefaultQueueCallback: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([owner])=>defaultContext(owner, 0, 0),
        },

        /**
         * PVOID SetupInitDefaultQueueCallbackEx(HWND OwnerWindow,
         *     HWND AlternateProgressWindow, UINT ProgressMessage, DWORD Reserved1,
         *     PVOID Reserved2)
         */
        SetupInitDefaultQueueCallbackEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([owner, progress, message])=>defaultContext(owner, progress, message),
        },

        /**
         * VOID SetupTermDefaultQueueCallback(PVOID Context) -- a context not
         * handed out, or already given back, is ignored.
         */
        SetupTermDefaultQueueCallback: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([context])=>{
                if (callbackContexts.delete(context >>> 0))
                {
                    host.free(context >>> 0);
                }
                return 0;
            },
        },

        /**
         * BOOL SetupQueueCopyA(HSPFILEQ QueueHandle, PCSTR SourceRootPath,
         *     PCSTR SourcePath, PCSTR SourceFilename, PCSTR SourceDescription,
         *     PCSTR SourceTagfile, PCSTR TargetDirectory, PCSTR TargetFilename,
         *     DWORD CopyStyle)
         *
         * The file is looked for under the root joined with SourcePath, and
         * the tag file at the root. No target name means the source's; no
         * source name or no target directory is ERROR_INVALID_PARAMETER.
         */
        SetupQueueCopyA: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([handle, rootPointer, pathPointer, filePointer, descriptionPointer,
                tagPointer, directoryPointer, targetPointer, style])=>{
                const queue = fileQueue(handle);
                if (!queue)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const sourceFile = text(filePointer);
                const targetDirectory = text(directoryPointer);
                if (!sourceFile || !targetDirectory)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const root = text(rootPointer) ?? '';
                const where = joinPath(root, text(pathPointer) ?? '');
                const sourcePath = where === '' ? '' : host.fullPath(where);
                queue.copies.push({
                    sourceRoot: root === '' ? sourcePath : host.fullPath(root),
                    sourcePath,
                    sourceFile,
                    description: text(descriptionPointer) || null,
                    tagfile: text(tagPointer) || null,
                    targetDirectory: host.fullPath(targetDirectory),
                    targetFile: text(targetPointer) || sourceFile,
                    flags: style >>> 0,
                });
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupCommitFileQueueA(HWND Owner, HSPFILEQ QueueHandle,
         *                            PSP_FILE_CALLBACK_A MsgHandler, PVOID Context)
         *
         * The queue's operations, through MsgHandler, in SetupCommitFileQueue's
         * order; FALSE with the error that ended it when it did not finish.
         */
        SetupCommitFileQueueA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, callback, context])=>{
                const queue = fileQueue(handle);
                if (!queue)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((callback >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const thread = host.callerThread();
                return commit(queue, callback, context, thread).then(code=>{
                    host.setLastErrorFor(thread, code);
                    return code === ERROR_SUCCESS ? 1 : 0;
                });
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
         * SPINST_REGISTRY then carries out its DelReg and AddReg sections,
         * HKR the predefined key RelativeKeyRoot names. The section's other
         * directives are not carried out here, and each one met is reported
         * as a divergence.
         */
        SetupInstallFromInfSectionA: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([, handle, sectionPointer, flags, relativeKey, rootPointer, copyFlags,
                callback, context])=>{
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
                    if (!['copyfiles', 'delfiles', 'renfiles', 'addreg', 'delreg']
                        .includes(directive) && directive !== ''
                        && wanted & ~(SPINST_FILES | SPINST_REGISTRY))
                    {
                        host.divergence?.('SetupInstallFromInfSectionA',
                            `the ${line.key} directive is not carried out`);
                    }
                }
                const registry = ()=>{
                    if ((wanted & SPINST_REGISTRY) === 0 || !host.registry)
                    {
                        return;
                    }
                    const relative = (relativeKey >>> 0) >= HKEY_CLASSES_ROOT
                        && (relativeKey >>> 0) <= HKEY_USERS
                        ? host.registry.root(relativeKey >>> 0) : null;
                    if ((relativeKey >>> 0) !== 0 && !relative)
                    {
                        host.divergence?.('SetupInstallFromInfSectionA',
                            'an HKR line under an opened key is not carried out');
                    }
                    installRegistry(host.registry, open.inf, section, {
                        relativeRoot: relative,
                        expand: value=>expand(open, value),
                        divergence: detail=>host.divergence?.('SetupInstallFromInfSectionA',
                            detail),
                    });
                };
                if ((wanted & SPINST_FILES) === 0)
                {
                    registry();
                    return fail(ERROR_SUCCESS, 1);
                }
                if ((callback >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const root = text(rootPointer) || directoryOf(open.path).replace(/\\$/, '');
                const queue = newQueue();
                queueInstallSection(queue, open.inf, section, {
                    root, copyFlags: copyFlags >>> 0, dirid: diridOf(open),
                });
                const thread = host.callerThread();
                return commit(queue, callback, context, thread).then(code=>{
                    if (code === ERROR_SUCCESS)
                    {
                        registry();
                    }
                    host.setLastErrorFor(thread, code);
                    return code === ERROR_SUCCESS ? 1 : 0;
                });
            },
        },

        /**
         * BOOL SetupCopyOEMInfA(PCSTR SourceInfFileName, PCSTR OEMSourceMediaLocation,
         *     DWORD OEMSourceMediaType, DWORD CopyStyle, PSTR DestinationInfFileName,
         *     DWORD DestinationInfFileNameSize, PDWORD RequiredSize,
         *     PSTR *DestinationInfFileNameComponent)
         *
         * The INF goes into the INF directory as oemN.inf, N the first number
         * free, and its catalog, when [Version] names one beside it, into the
         * catalog store as oemN.CAT. An INF already there with the same
         * contents is not copied again: its name is the answer, and with
         * SP_COPY_NOOVERWRITE that is ERROR_FILE_EXISTS; with
         * SP_COPY_REPLACEONLY there must be one (Wine's setupapi
         * test_copy_oem_inf).
         */
        SetupCopyOEMInfA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([sourcePointer, , , style, dest, destSize, required, component])=>{
                const name = text(sourcePointer);
                if (name === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const source = name === '' ? null : pathOf(name);
                const bytes = source === null ? null : readWhole(source);
                if (bytes === null)
                {
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                const thread = host.callerThread();
                const sourceDirectory = directoryOf(/** @type {string} */ (source));
                const infDirectory = `${windows}\\inf`;
                /** @param {Uint8Array} data */
                const place = data=>{
                    /** @param {Uint8Array} a @param {Uint8Array} b */
                    const same = (a, b)=>a.length === b.length && a.every((byte, i)=>byte === b[i]);
                    const oem = host.files.list(infDirectory, 'oem*.inf')
                        .map(entry=>entry.name)
                        .filter(entry=>/^oem\d+\.inf$/i.test(entry));
                    const existing = oem.find(entry=>{
                        const there = readWhole(`${infDirectory}\\${entry}`);
                        return there instanceof Uint8Array && same(there, data);
                    });
                    let code = ERROR_SUCCESS;
                    let target;
                    if (existing)
                    {
                        target = `${infDirectory}\\${existing}`;
                        code = ((style >>> 0) & SP_COPY_NOOVERWRITE) ? ERROR_FILE_EXISTS : code;
                    }
                    else if ((style >>> 0) & SP_COPY_REPLACEONLY)
                    {
                        host.setLastErrorFor(thread, ERROR_FILE_NOT_FOUND);
                        return 0;
                    }
                    else
                    {
                        const taken = new Set(oem.map(entry=>entry.toLowerCase()));
                        let number = 0;
                        while (taken.has(`oem${number}.inf`))
                        {
                            number++;
                        }
                        target = `${infDirectory}\\oem${number}.inf`;
                        makeDirectories(infDirectory);
                        code = writeWhole(target, data);
                        const parsed = parseInf(infText(data), { dirid });
                        const catalog = 'inf' in parsed
                            ? parsed.inf.value('Version', 'CatalogFile') : null;
                        const catalogBytes = catalog
                            ? readWhole(`${sourceDirectory}${catalog}`) : null;
                        if (code === ERROR_SUCCESS && catalogBytes instanceof Uint8Array)
                        {
                            makeDirectories(CATALOG_STORE);
                            writeWhole(`${CATALOG_STORE}\\oem${number}.CAT`, catalogBytes);
                        }
                    }
                    const written = ansi(target);
                    if ((required >>> 0) !== 0)
                    {
                        writeU32(required, written.length);
                    }
                    if ((dest >>> 0) !== 0)
                    {
                        if ((destSize >>> 0) < written.length)
                        {
                            host.setLastErrorFor(thread, ERROR_INSUFFICIENT_BUFFER);
                            return 0;
                        }
                        host.writeMemory(dest >>> 0, written);
                        if ((component >>> 0) !== 0)
                        {
                            writeU32(component, (dest >>> 0) + target.lastIndexOf('\\') + 1);
                        }
                    }
                    host.setLastErrorFor(thread, code);
                    return code === ERROR_SUCCESS ? 1 : 0;
                };
                return bytes instanceof Uint8Array ? place(bytes) : bytes.then(place);
            },
        },

        /**
         * BOOL SetupDiGetActualSectionToInstallA(HINF InfHandle, PCSTR InfSectionName,
         *     PSTR InfSectionWithExt, DWORD InfSectionWithExtSize, PDWORD RequiredSize,
         *     PSTR *Extension), the W form, and the Ex forms with an alternate
         *     platform after the name and a reserved pointer last
         *
         * The section this machine installs: the name decorated .NTx86 if the
         * INF has that, else .NT, else the name itself; Extension at the
         * decoration in the caller's buffer, or null for none.
         */
        ...bothWidths('SetupDiGetActualSectionToInstall', wide=>({
            argBytes: 24,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, sectionPointer, buffer, size, required,
                extension])=>actualSection(handle, textOf(sectionPointer, wide), buffer, size,
                required, extension, wide),
        })),
        ...bothWidths('SetupDiGetActualSectionToInstallEx', wide=>({
            argBytes: 32,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, sectionPointer, platform, buffer, size,
                required, extension, reserved])=>((platform >>> 0) !== 0 || (reserved >>> 0) !== 0
                ? fail(ERROR_INVALID_PARAMETER)
                : actualSection(handle, textOf(sectionPointer, wide), buffer, size, required,
                    extension, wide)),
        })),

        /**
         * BOOL SetupDiInstallClassA(HWND hwndParent, PCSTR InfFileName, DWORD Flags,
         *     HSPFILEQ FileQueue), the W form, and the Ex forms with an interface
         *     class, a reserved pointer and another after them
         *
         * The INF's [Version] class made under Control\\Class -- its name the
         * key's Class value -- and its ClassInstall32 section, decorated for
         * this machine, carried out there: its AddReg and DelReg with HKR the
         * class's key. DI_NOVCP with no queue to add to, or no INF, is
         * ERROR_INVALID_PARAMETER.
         */
        ...bothWidths('SetupDiInstallClass', wide=>({
            argBytes: 16,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [, namePointer, flags, queue])=>
                installClass(textOf(namePointer, wide), flags >>> 0, queue >>> 0),
        })),

        /**
         * BOOL SetupDiGetClassDescriptionA(const GUID *ClassGuid, PSTR ClassDescription,
         *     DWORD ClassDescriptionSize, PDWORD RequiredSize), the W form, and the
         *     Ex forms with a machine and a reserved pointer after them
         *
         * The class key's default value; a class not installed is
         * ERROR_INVALID_CLASS, the size untouched.
         */
        ...bothWidths('SetupDiGetClassDescription', wide=>({
            argBytes: 16,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [classGuid, buffer, size, required])=>{
                const guid = guidAt(classGuid);
                const hive = host.registry;
                const key = guid === null || !hive ? null
                    : hive.open(hive.root(HKEY_LOCAL_MACHINE), `${CLASS_KEY}\\${guid}`);
                const value = key ? hive.getValue(key, '') : null;
                if (!value)
                {
                    return fail(ERROR_INVALID_CLASS);
                }
                const description = decodeAnsi(value.data).replace(/\0[\s\S]*$/, '');
                return answerText(description, buffer, size, required, wide)
                    ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /**
         * HKEY SetupDiOpenClassRegKey(const GUID *ClassGuid, REGSAM samDesired)
         *
         * The installer's class key, or with no class the key every class's is under.
         */
        SetupDiOpenClassRegKey: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([classGuid])=>classKey(guidAt(classGuid), DIOCR_INSTALLER),
        },

        /**
         * HKEY SetupDiOpenClassRegKeyExA(const GUID *ClassGuid, REGSAM samDesired,
         *     DWORD Flags, PCSTR MachineName, PVOID Reserved), and the W form
         *
         * DIOCR_INSTALLER the installer's class keys, DIOCR_INTERFACE the
         * interface classes'. A class that has none is INVALID_HANDLE_VALUE
         * with ERROR_INVALID_CLASS.
         */
        ...bothWidths('SetupDiOpenClassRegKeyEx', wide=>({
            argBytes: 20,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [classGuid, , flags, machinePointer, reserved])=>{
                if ((reserved >>> 0) !== 0 || ((flags >>> 0) !== DIOCR_INSTALLER
                    && (flags >>> 0) !== DIOCR_INTERFACE))
                {
                    return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
                }
                if ((textOf(machinePointer, wide) ?? '') !== '')
                {
                    return fail(ERROR_INVALID_MACHINENAME, INVALID_HANDLE_VALUE);
                }
                return classKey(guidAt(classGuid), flags >>> 0);
            },
        })),

        /**
         * HDEVINFO SetupDiCreateDeviceInfoList(const GUID *ClassGuid, HWND hwndParent)
         *
         * An empty set, of the class given or of any.
         */
        SetupDiCreateDeviceInfoList: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([classGuid])=>newSet(guidAt(classGuid)),
        },

        /**
         * HDEVINFO SetupDiCreateDeviceInfoListExA(const GUID *ClassGuid, HWND hwndParent,
         *     PCSTR MachineName, PVOID Reserved), and the W form
         *
         * A machine named is a remote one, which this machine cannot reach;
         * an empty name is this one. Anything reserved is ERROR_INVALID_PARAMETER.
         */
        ...bothWidths('SetupDiCreateDeviceInfoListEx', wide=>({
            argBytes: 16,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [classGuid, , machinePointer, reserved])=>{
                if ((reserved >>> 0) !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
                }
                if ((textOf(machinePointer, wide) ?? '') !== '')
                {
                    return fail(ERROR_INVALID_MACHINENAME, INVALID_HANDLE_VALUE);
                }
                return newSet(guidAt(classGuid));
            },
        })),

        /**
         * BOOL SetupDiGetDeviceInfoListClass(HDEVINFO DeviceInfoSet, LPGUID ClassGuid)
         *
         * A set of no one class has none to give: ERROR_NO_ASSOCIATED_CLASS.
         */
        SetupDiGetDeviceInfoListClass: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const set = deviceSet(handle);
                if (!set)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (set.classGuid === null)
                {
                    return fail(ERROR_NO_ASSOCIATED_CLASS);
                }
                writeGuid(out, set.classGuid);
                return 1;
            },
        },

        /**
         * BOOL SetupDiGetDeviceInfoListDetailA(HDEVINFO DeviceInfoSet,
         *     PSP_DEVINFO_LIST_DETAIL_DATA_A DeviceInfoSetDetailData), and the W form
         *
         * The set's class (GUID_NULL for none) and no remote machine.
         */
        ...bothWidths('SetupDiGetDeviceInfoListDetail', wide=>({
            argBytes: 8,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, detail])=>{
                const set = deviceSet(handle);
                if (!set)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const size = wide ? LIST_DETAIL_W_SIZE : LIST_DETAIL_A_SIZE;
                if ((detail >>> 0) === 0 || readU32(detail) !== size)
                {
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                host.writeMemory((detail >>> 0) + 4, new Uint8Array(size - 4));
                writeGuid(detail + 4, set.classGuid ?? GUID_NULL);
                return 1;
            },
        })),

        /**
         * BOOL SetupDiCreateDeviceInfoA(HDEVINFO DeviceInfoSet, PCSTR DeviceName,
         *     const GUID *ClassGuid, PCSTR DeviceDescription, HWND hwndParent,
         *     DWORD CreationFlags, PSP_DEVINFO_DATA DeviceInfoData), and the W form
         *
         * A phantom instance in the registry and in the set, until it is
         * registered. The name is a whole instance id, or with
         * DICD_GENERATE_ID a device's name under ROOT, given the first
         * instance free. The checks come in Windows' order: the name, the
         * set, the class, the class against the set's, the id itself, an
         * instance already there. Device data of the wrong size is
         * ERROR_INVALID_USER_BUFFER, the device made all the same.
         */
        ...bothWidths('SetupDiCreateDeviceInfo', wide=>({
            argBytes: 28,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, namePointer, classGuid, , , flags,
                data])=>{
                const name = textOf(namePointer, wide);
                if (name === null)
                {
                    return fail(ERROR_INVALID_DEVINST_NAME);
                }
                const set = deviceSet(handle);
                if (!set || !devices)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const guid = guidAt(classGuid);
                if (guid === null)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (set.classGuid !== null && set.classGuid !== guid)
                {
                    return fail(ERROR_CLASS_MISMATCH);
                }
                const taken = new Set(set.devices.map(device=>device.id.toUpperCase()));
                const id = devices.instanceId(name, ((flags >>> 0) & DICD_GENERATE_ID) !== 0,
                    taken);
                if (id === null)
                {
                    return fail(ERROR_INVALID_DEVINST_NAME);
                }
                if (taken.has(id.toUpperCase()) || devices.exists(id))
                {
                    return fail(ERROR_DEVINST_ALREADY_EXISTS);
                }
                devices.createPhantom(id, guid);
                const device = devices.entry(id, guid);
                set.devices.push(device);
                set.made.add(id.toUpperCase());
                return answerDevice(data, device);
            },
        })),

        /**
         * BOOL SetupDiOpenDeviceInfoA(HDEVINFO DeviceInfoSet, PCSTR DeviceInstanceId,
         *     HWND hwndParent, DWORD OpenFlags, PSP_DEVINFO_DATA DeviceInfoData),
         *     and the W form
         *
         * A registered instance added to the set, or the set's own entry
         * for it; a phantom, or none, is ERROR_NO_SUCH_DEVINST, and one of
         * another class than the set's ERROR_CLASS_MISMATCH.
         */
        ...bothWidths('SetupDiOpenDeviceInfo', wide=>({
            argBytes: 20,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, idPointer, , , data])=>{
                const set = deviceSet(handle);
                if (!set || !devices)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const name = textOf(idPointer, wide);
                if (name === null)
                {
                    // The W form reads none as the root device, of no
                    // class; the A form refuses it outright.
                    return fail(wide && set.classGuid !== null ? ERROR_CLASS_MISMATCH
                        : ERROR_INVALID_PARAMETER);
                }
                const id = devices.instanceId(name, false, new Set());
                if (id === null)
                {
                    return fail(ERROR_INVALID_DEVINST_NAME);
                }
                const held = set.devices.find(device=>!device.removed
                    && device.id.toUpperCase() === id.toUpperCase());
                if (held && !set.made.has(id.toUpperCase()))
                {
                    return answerDevice(data, held);
                }
                if (!devices.registered(id))
                {
                    return fail(ERROR_NO_SUCH_DEVINST);
                }
                const classGuid = devices.classOf(id);
                if (set.classGuid !== null && set.classGuid !== classGuid)
                {
                    return fail(ERROR_CLASS_MISMATCH);
                }
                const device = devices.entry(id, classGuid);
                set.devices.push(device);
                return answerDevice(data, device);
            },
        })),

        /**
         * BOOL SetupDiRegisterDeviceInfo(HDEVINFO DeviceInfoSet,
         *     PSP_DEVINFO_DATA DeviceInfoData, DWORD Flags, PSP_DETSIG_CMPPROC CompareProc,
         *     PVOID CompareContext, PSP_DEVINFO_DATA DupDeviceInfoData)
         *
         * A phantom made real: it stays when its set goes.
         */
        SetupDiRegisterDeviceInfo: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, data])=>{
                const set = deviceSet(handle);
                if (!set || !devices)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const device = deviceIn(set, data);
                if (!device)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                devices.register(device.id);
                set.made.delete(device.id.toUpperCase());
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupDiDeleteDeviceInfo(HDEVINFO DeviceInfoSet, PSP_DEVINFO_DATA DeviceInfoData)
         *
         * The device out of the set; a phantom the set made goes from the
         * registry with it, a registered one stays there.
         */
        SetupDiDeleteDeviceInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, data])=>{
                const set = deviceSet(handle);
                if (!set || !devices)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const device = deviceIn(set, data);
                if (!device)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                set.devices.splice(set.devices.indexOf(device), 1);
                if (set.made.delete(device.id.toUpperCase()))
                {
                    devices.removeInstance(device.id);
                }
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupDiRemoveDevice(HDEVINFO DeviceInfoSet, PSP_DEVINFO_DATA DeviceInfoData)
         *
         * The instance and its interfaces out of the registry; the set keeps
         * the device, which no longer has an instance id, and its
         * interfaces, marked removed.
         */
        SetupDiRemoveDevice: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, data])=>{
                const set = deviceSet(handle);
                if (!set || !devices)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const device = deviceIn(set, data);
                if (!device)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                devices.removeInstance(device.id);
                set.made.delete(device.id.toUpperCase());
                device.removed = true;
                device.interfaces.forEach(face=>{
                    face.flags |= SPINT.REMOVED;
                });
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupDiEnumDeviceInfo(HDEVINFO DeviceInfoSet, DWORD MemberIndex,
         *                            PSP_DEVINFO_DATA DeviceInfoData)
         */
        SetupDiEnumDeviceInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, index, data])=>{
                const set = deviceSet(handle);
                if (!set)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((data >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (readU32(data) !== SP_DEVINFO_DATA_SIZE)
                {
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                const device = set.devices[index >>> 0];
                if (!device)
                {
                    return fail(ERROR_NO_MORE_ITEMS);
                }
                writeDevice(data, device);
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupDiGetDeviceInstanceIdA(HDEVINFO DeviceInfoSet,
         *     PSP_DEVINFO_DATA DeviceInfoData, PSTR DeviceInstanceId,
         *     DWORD DeviceInstanceIdSize, PDWORD RequiredSize), and the W form
         *
         * A removed device has none: ERROR_NO_SUCH_DEVINST.
         */
        ...bothWidths('SetupDiGetDeviceInstanceId', wide=>({
            argBytes: 20,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, data, buffer, size, required])=>{
                const set = deviceSet(handle);
                if (!set)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const device = deviceIn(set, data);
                if (!device)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (device.removed)
                {
                    return fail(ERROR_NO_SUCH_DEVINST);
                }
                // No buffer is too small a one here, unlike the INF calls.
                if ((buffer >>> 0) === 0)
                {
                    if ((required >>> 0) !== 0)
                    {
                        writeU32(required, device.id.length + 1);
                    }
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                return answerText(device.id, buffer, size, required, wide)
                    ? fail(ERROR_SUCCESS, 1) : 0;
            },
        })),

        /**
         * HDEVINFO SetupDiGetClassDevsA(const GUID *ClassGuid, PCSTR Enumerator,
         *     HWND hwndParent, DWORD Flags), the W form, and the Ex forms with a
         *     set to add to, a machine and a reserved pointer after them
         *
         * The registered devices of a class, or of any with DIGCF_ALLCLASSES,
         * under an enumerator or a device's prefix of an instance id; with
         * DIGCF_DEVICEINTERFACE, the devices with interfaces of the class
         * (any, with DIGCF_ALLCLASSES) and those interfaces, the enumerator
         * then allowed to be a whole instance id. No class and no
         * DIGCF_ALLCLASSES is ERROR_INVALID_PARAMETER; an empty enumerator,
         * one ending in a separator, or an instance id where it may not be,
         * ERROR_INVALID_DATA.
         */
        ...bothWidths('SetupDiGetClassDevs', wide=>({
            argBytes: 16,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [classGuid, enumerator, , flags])=>
                classDevices(guidAt(classGuid), textOf(enumerator, wide), flags >>> 0, 0),
        })),
        ...bothWidths('SetupDiGetClassDevsEx', wide=>({
            argBytes: 28,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [classGuid, enumerator, , flags, into,
                machinePointer, reserved])=>{
                if ((reserved >>> 0) !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
                }
                if ((textOf(machinePointer, wide) ?? '') !== '')
                {
                    return fail(ERROR_INVALID_MACHINENAME, INVALID_HANDLE_VALUE);
                }
                return classDevices(guidAt(classGuid), textOf(enumerator, wide), flags >>> 0,
                    into >>> 0);
            },
        })),

        /**
         * BOOL SetupDiCreateDeviceInterfaceA(HDEVINFO DeviceInfoSet,
         *     PSP_DEVINFO_DATA DeviceInfoData, const GUID *InterfaceClassGuid,
         *     PCSTR ReferenceString, DWORD CreationFlags,
         *     PSP_DEVICE_INTERFACE_DATA DeviceInterfaceData), and the W form
         *
         * An interface of the device, kept in the registry from now on; one
         * the device already has, the reference's case aside, is that one.
         * No class is ERROR_INVALID_USER_BUFFER.
         */
        ...bothWidths('SetupDiCreateDeviceInterface', wide=>({
            argBytes: 24,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, data, classGuid, referencePointer, ,
                out])=>{
                const set = deviceSet(handle);
                if (!set || !devices)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const device = deviceIn(set, data);
                if (!device)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const guid = guidAt(classGuid);
                if (guid === null)
                {
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                const reference = textOf(referencePointer, wide) ?? '';
                let face = device.interfaces.find(entry=>entry.classGuid === guid
                    && entry.reference.toLowerCase() === reference.toLowerCase());
                if (!face)
                {
                    face = { classGuid: guid, reference, flags: 0 };
                    device.interfaces.push(face);
                    devices.addInterface(device.id, guid, reference);
                }
                if ((out >>> 0) !== 0)
                {
                    if (readU32(out) !== SP_DEVICE_INTERFACE_DATA_SIZE)
                    {
                        return fail(ERROR_INVALID_USER_BUFFER);
                    }
                    writeInterface(out, set, device, face);
                }
                return fail(ERROR_SUCCESS, 1);
            },
        })),

        /**
         * BOOL SetupDiEnumDeviceInterfaces(HDEVINFO DeviceInfoSet,
         *     PSP_DEVINFO_DATA DeviceInfoData, const GUID *InterfaceClassGuid,
         *     DWORD MemberIndex, PSP_DEVICE_INTERFACE_DATA DeviceInterfaceData)
         *
         * The Nth interface of the class -- of the device given, or of the
         * set's devices in turn -- removed ones included, flagged.
         */
        SetupDiEnumDeviceInterfaces: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, data, interfaceClass, index, out])=>{
                const set = deviceSet(handle);
                if (!set)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((out >>> 0) === 0 || (interfaceClass >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (readU32(out) !== SP_DEVICE_INTERFACE_DATA_SIZE)
                {
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                const only = (data >>> 0) === 0 ? null : deviceIn(set, data);
                if ((data >>> 0) !== 0 && !only)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const guid = guidAt(interfaceClass);
                const found = (only ? [only] : set.devices).flatMap(device=>device.interfaces
                    .filter(face=>face.classGuid === guid).map(face=>({ device, face })));
                const chosen = found[index >>> 0];
                if (!chosen)
                {
                    return fail(ERROR_NO_MORE_ITEMS);
                }
                writeInterface(out, set, chosen.device, chosen.face);
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupDiGetDeviceInterfaceDetailA(HDEVINFO DeviceInfoSet,
         *     PSP_DEVICE_INTERFACE_DATA DeviceInterfaceData,
         *     PSP_DEVICE_INTERFACE_DETAIL_DATA_A DeviceInterfaceDetailData,
         *     DWORD DeviceInterfaceDetailDataSize, PDWORD RequiredSize,
         *     PSP_DEVINFO_DATA DeviceInfoData), and the W form
         *
         * The interface's path, after a cbSize that must be the structure's
         * own; the size needed is reported, and the device filled in, before
         * a buffer too small is refused.
         */
        ...bothWidths('SetupDiGetDeviceInterfaceDetail', wide=>({
            argBytes: 24,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [handle, faceData, detail, size, required,
                data])=>{
                const set = deviceSet(handle);
                if (!set)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const held = interfaceIn(set, faceData);
                if (!held)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((detail >>> 0) === 0 && (size >>> 0) !== 0)
                {
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                if ((detail >>> 0) !== 0
                    && readU32(detail) !== (wide ? DETAIL_W_SIZE : DETAIL_A_SIZE))
                {
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                const path = encodeIn(interfacePath(held.device.id, held.face.classGuid,
                    held.face.reference), wide);
                const needed = 4 + path.length;
                if ((required >>> 0) !== 0)
                {
                    writeU32(required, needed);
                }
                if ((data >>> 0) !== 0 && readU32(data) === SP_DEVINFO_DATA_SIZE)
                {
                    writeDevice(data, held.device);
                }
                if ((detail >>> 0) === 0 || (size >>> 0) < needed)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory((detail >>> 0) + 4, path);
                return fail(ERROR_SUCCESS, 1);
            },
        })),

        /**
         * BOOL SetupDiRemoveDeviceInterface(HDEVINFO DeviceInfoSet,
         *     PSP_DEVICE_INTERFACE_DATA DeviceInterfaceData)
         *
         * The interface out of the registry, left in the set marked removed.
         */
        SetupDiRemoveDeviceInterface: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, faceData])=>{
                const set = deviceSet(handle);
                if (!set || !devices)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const held = interfaceIn(set, faceData);
                if (!held)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                devices.removeInterface(held.device.id, held.face.classGuid, held.face.reference);
                held.face.flags |= SPINT.REMOVED;
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupDiDeleteDeviceInterfaceData(HDEVINFO DeviceInfoSet,
         *     PSP_DEVICE_INTERFACE_DATA DeviceInterfaceData)
         *
         * The interface out of the set, the registry untouched.
         */
        SetupDiDeleteDeviceInterfaceData: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, faceData])=>{
                const set = deviceSet(handle);
                if (!set)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const held = interfaceIn(set, faceData);
                if (!held)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                held.device.interfaces.splice(held.device.interfaces.indexOf(held.face), 1);
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupDiDestroyDeviceInfoList(HDEVINFO DeviceInfoSet)
         *
         * The set gone, and with it the phantoms it made and never registered.
         */
        SetupDiDestroyDeviceInfoList: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const set = deviceSet(handle);
                if (!set)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                for (const device of set.devices)
                {
                    if (set.made.has(device.id.toUpperCase()))
                    {
                        devices?.removeInstance(device.id);
                    }
                }
                host.handles.close(handle >>> 0);
                return fail(ERROR_SUCCESS, 1);
            },
        },

        /**
         * BOOL SetupDiGetDeviceRegistryPropertyA(HDEVINFO DeviceInfoSet,
         *     PSP_DEVINFO_DATA DeviceInfoData, DWORD Property, PDWORD PropertyRegDataType,
         *     PBYTE PropertyBuffer, DWORD PropertyBufferSize, PDWORD RequiredSize)
         *
         * No device data can name a device of an empty set.
         */
        SetupDiGetDeviceRegistryPropertyA: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([set])=>fail(deviceSet(set) ? ERROR_NO_SUCH_DEVINST : ERROR_INVALID_HANDLE),
        },

        /**
         * BOOL SetupDiSetDeviceRegistryPropertyA(HDEVINFO DeviceInfoSet,
         *     PSP_DEVINFO_DATA DeviceInfoData, DWORD Property, const BYTE *PropertyBuffer,
         *     DWORD PropertyBufferSize)
         */
        SetupDiSetDeviceRegistryPropertyA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([set])=>fail(deviceSet(set) ? ERROR_NO_SUCH_DEVINST : ERROR_INVALID_HANDLE),
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
