/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msi.dll: the Windows Installer's API over the engine in this folder.
 *
 * Everything a program holds is an MSIHANDLE, a small number of the
 * installer's own -- a database, a view, a record, a summary, a session --
 * closed with MsiCloseHandle and never confused with a kernel handle. A
 * string comes back the installer's way: the buffer's room in characters
 * going in, the length coming back, ERROR_MORE_DATA and the length needed
 * when it does not fit, and the length alone when there is no buffer.
 *
 * An installation reports to the user interface the program chose: an
 * external handler it registered gets every message it filtered for, as
 * text; without one an error is shown in a message box unless the
 * interface is off. The package's own dialogs are not drawn.
 */

import { openCompound } from './compound.js';
import { createEmptyDatabase, isKey, openDatabase } from './database.js';
import {
    ERROR_BAD_QUERY_SYNTAX, ERROR_FUNCTION_FAILED, ERROR_NO_MORE_ITEMS, columnInfo, openView,
} from './query.js';
import {
    MAX_FIELDS, MSI_NULL_INTEGER, bytesStream, clearRecord, createRecord, dataSize, getInteger,
    getString, isNull, setInteger, setStream, setString,
} from './record.js';
import { MSICONDITION } from './condition.js';
import { formatRecord } from './format.js';
import { INSTALLSTATE, createSession, parseCommandLine } from './session.js';
import { PID_TYPES, VT, readSummary } from './summary.js';
import { INSTALLMESSAGE, doAction, readFile, runSequence, writeFile } from './actions.js';
import {
    ERROR_INSTALL_TRANSFORM_FAILURE, applyTransform, applyTransformList, createTransformSummary,
    generateTransform, writeSummaryStream,
} from './transform.js';
import { embeddedCabinets, writeDatabase } from './database-writer.js';
import {
    ERROR_PATCH_PACKAGE_OPEN_FAILED, applyPatch, effectivePatches, openPatch,
} from './patch.js';
import { finishAsync } from './custom.js';
import { createRegistration, squashGuid, valueText } from './registration.js';
import { installerVersion } from './version.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { createProductFunctions } from './products.js';
import { installerObject, sessionObject } from './automation.js';
import { createJScriptEngine } from '../jscript/engine.js';
import { ExternalError } from '../script/external.js';
import { applyPatch as applyDeltaPatch } from '../mspatcha/pa19.js';
import {
    ERROR_BAD_PATHNAME, exportTable, importTable, mergeDatabases, streamFolder,
} from './archive.js';
import { parseGuid } from '../ole32/guid.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_OPEN_FAILED = 110;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_DATA = 13;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_DIRECTORY = 267;
const ERROR_FILE_INVALID = 1006;
const ERROR_INVALID_DATATYPE = 1804;
/** What GetExitCodeThread answers for a thread that has not ended. */
const STILL_ACTIVE = 259;
/** How often a library action run beside the installation is looked at for its end. */
const THREAD_POLL_MS = 5;
const ERROR_INSTALL_PACKAGE_OPEN_FAILED = 1619;
const ERROR_INSTALL_PACKAGE_INVALID = 1620;
const ERROR_UNKNOWN_FEATURE = 1606;
const ERROR_UNKNOWN_COMPONENT = 1607;
const ERROR_UNKNOWN_PROPERTY = 1608;
const ERROR_INVALID_TABLE = 1628;
const ERROR_DATATYPE_MISMATCH = 1629;
const ERROR_ACCESS_DENIED = 5;
const ERROR_UNKNOWN_PRODUCT = 1605;
const ERROR_INSTALL_SOURCE_ABSENT = 1612;
const ERROR_SUCCESS_REBOOT_REQUIRED = 3010;
const ERROR_INSTALL_FAILURE = 1603;

/** The script engines a script custom action runs in, by its language. */
const SCRIPT_ENGINES = /** @type {Record<string, ((options: any) => any) | undefined>} */ ({
    jscript: createJScriptEngine,
});

/**
 * What a script action's function answers, as the sequence reads it: IDOK
 * (or nothing) success, IDCANCEL the user's exit, IDABORT failure, IDRETRY a
 * suspension, IDIGNORE the rest of the sequence skipped.
 */
const SCRIPT_ANSWERS = new Map([[1, 0], [2, 1602], [3, 1603], [4, 1604], [5, 259]]);

/** "ActiveX component can't create object", as a script reports it (error 429). */
const CTL_E_CANTCREATEOBJECT = 0x800a01ad | 0;
const ERROR_CREATE_FAILED = 1631;

/** LoadTypeLibEx: load without registering; UnRegisterTypeLib: a 32-bit library. */
const REGKIND_NONE = 2;
const SYS_WIN32 = 1;

/** MsiConfigureProduct's install levels with a meaning of their own. */
const INSTALLLEVEL_DEFAULT = 0;
const INSTALLLEVEL_MAXIMUM = 0xffff;

/**
 * What MsiConfigureProduct's state asks the installation for: the whole
 * product removed, every feature local or from source, or as it stands.
 *
 * @type {Map<number, string>}
 */
const PRODUCT_REQUESTS = new Map([
    [2, 'REMOVE=ALL'], [3, 'ADDLOCAL=ALL'], [4, 'ADDSOURCE=ALL'], [5, ''],
]);

/** And MsiConfigureFeature's, for one feature. @type {Map<number, string>} */
const FEATURE_REQUESTS = new Map([
    [2, 'REMOVE'], [3, 'ADDLOCAL'], [4, 'ADDSOURCE'], [5, 'ADDDEFAULT'],
]);

/**
 * REINSTALLMODE's letters for MsiReinstallProduct's flags, lowest bit first:
 * repair, missing, older, equal, exact, checksum, all, machine data, user
 * data, shortcuts, package.
 */
const REINSTALL_LETTERS = 'rpoedcamusv';

/** @param {number} flags @returns {string} the REINSTALLMODE the flags spell */
const reinstallMode = flags=>[...REINSTALL_LETTERS]
    .filter((_, bit)=>((flags >>> 0) & (1 << bit)) !== 0).join('');

/** @param {string} value a property value quoted for a command line */
const quoted = value=>`"${value.replace(/"/g, '""')}"`;

/** INSTALLUILEVEL values. */
const INSTALLUILEVEL = Object.freeze({
    NOCHANGE: 0, DEFAULT: 1, NONE: 2, BASIC: 3, REDUCED: 4, FULL: 5, ENDDIALOG: 0x80,
    PROGRESSONLY: 0x40, HIDECANCEL: 0x20, SOURCERESONLY: 0x100,
});

/** MsiOpenDatabase's persistence modes; a larger value is an output path. */
const MSIDBOPEN_READONLY = 0;
const MSIDBOPEN_TRANSACT = 1;
const MSIDBOPEN_CREATE = 3;
const MSIDBOPEN_CREATEDIRECT = 4;
const MSIDBOPEN_PATCHFILE = 32;

/** MsiGetMode's run modes, as the session's mode flags. */
const RUN_MODES = Object.freeze({
    0: 'admin', 1: 'advertise', 2: 'maintenance', 3: 'rollbackEnabled', 4: 'logEnabled',
    5: 'operations', 6: 'rebootAtEnd', 7: 'rebootNow', 8: 'cabinet', 9: 'sourceShortNames',
    10: 'targetShortNames', 12: 'windows9x', 13: 'zawEnabled', 16: 'scheduled',
    17: 'rollback', 18: 'commit',
});

/**
 * A string argument is read up to this many characters: Windows bounds no
 * record's or property's text, and a script hands over all of a session's
 * properties in one; this only stops a read that ran off its string.
 */
const MAX_TEXT = 0x1000000;

/** MB_OK | MB_ICONERROR, and the answer a box that is not shown gives. */
const MB_ICONERROR = 0x10;
const IDOK = 1;

/**
 * @typedef {Object} MsiHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {any} files
 * @property {(path: string) => string} fullPath
 * @property {import('./registration.js').Hive} hive
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number> | number} call
 * @property {() => unknown} callerThread
 * @property {<T>(thread: unknown, fn: () => T) => T} [answering]
 *           Runs `fn` as the call of `thread`: what it loads, frees and calls
 *           back into the guest is that thread's.
 * @property {{ loadAnsi: (name: number) => number | Promise<number>,
 *     procAddress: (module: number, name: number) => number | Promise<number>,
 *     free: (module: number) => number | Promise<number> }} libraries
 * @property {{ start: (entry: number, argument: number) => number | Promise<number>,
 *     exitCode: (thread: number) => number | Promise<number>,
 *     terminate: (thread: number) => unknown,
 *     close: (thread: number) => unknown }} [threads]
 *     Threads of the process, for a library action that runs beside the installation: one
 *     started at an export with its argument, and its handle; asked for its exit code (259
 *     while it runs), ended, and given up.
 * @property {() => import('./session.js').Machine} machine
 * @property {(text: string, caption: string, flags: number) => number | Promise<number>}
 *     [messageBox]
 * @property {(commandLine: string, directory: string | null, wait: boolean)
 *     => Promise<number | null>} [runExe]
 * @property {(path: string) => Uint8Array | null | Promise<Uint8Array | null>} [versionInfo]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(text: string) => void} [log]
 */

/**
 * @param {MsiHost} host
 * @returns {Record<string, { argBytes: number, handler: (args: number[]) => any }>}
 */
export function createMsiFunctions(host){
    /** @type {Map<number, { kind: string, object: any }>} */
    const handles = new Map();
    let nextHandle = 1;
    /** @param {string} kind @param {any} object */
    const open = (kind, object)=>{
        const handle = nextHandle++;
        handles.set(handle, { kind, object });
        return handle;
    };
    /** @param {number} handle @param {string} kind */
    const get = (handle, kind)=>{
        const entry = handles.get(handle >>> 0);
        return entry && entry.kind === kind ? entry.object : null;
    };

    const registration = createRegistration(host.hive);

    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(Uint32Array.of(value >>> 0).buffer));
    /** @param {number} address @param {number} value */
    const writeI32 = (address, value)=>writeU32(address, value | 0);

    /** @param {boolean} wide @returns {(address: number) => string | null} */
    const reader = wide=>address=>((address >>> 0) === 0 ? null : wide
        ? host.readWideString(address >>> 0, MAX_TEXT) : host.readCString(address >>> 0, MAX_TEXT));

    /** @param {string} text */
    const utf16 = text=>{
        const bytes = new Uint8Array(text.length * 2);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at * 2] = text.charCodeAt(at) & 0xff;
            bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
        }
        return bytes;
    };

    /**
     * A string out, the installer's way.
     *
     * @param {boolean} wide @param {string} text @param {number} buffer @param {number} size
     */
    const putString = (wide, text, buffer, size)=>{
        if ((buffer >>> 0) !== 0 && (size >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if ((size >>> 0) === 0)
        {
            return ERROR_SUCCESS;
        }
        const room = readU32(size);
        const units = wide ? utf16(text) : encodeAnsi(text);
        const width = wide ? 2 : 1;
        const length = units.length / width;
        if ((buffer >>> 0) !== 0 && room > 0)
        {
            const fits = Math.min(length, room - 1);
            const out = new Uint8Array((fits + 1) * width);
            out.set(units.subarray(0, fits * width));
            host.writeMemory(buffer >>> 0, out);
        }
        writeU32(size, length);
        return (buffer >>> 0) !== 0 && length >= room ? ERROR_MORE_DATA : ERROR_SUCCESS;
    };

    /**
     * An entry point in both widths, its body told which.
     *
     * @param {string} name @param {number} argBytes
     * @param {(wide: boolean) => (args: number[]) => any} make
     */
    const both = (name, argBytes, make)=>({
        [`${name}A`]: { argBytes, handler: make(false) },
        [`${name}W`]: { argBytes, handler: make(true) },
    });

    // ----- the user interface ---------------------------------------------

    /** @type {number} */
    let uiLevel = INSTALLUILEVEL.BASIC;
    /** @type {{ handler: number, filter: number, context: number, wide: boolean } | null} */
    let externalUi = null;
    /** @type {{ handler: number, filter: number, context: number } | null} */
    let recordUi = null;

    /**
     * A message's text: an action's start as "Action time: name. description",
     * anything else its record formatted.
     *
     * @param {number} type @param {import('./record.js').Record} record
     * @param {import('./session.js').Session | null} session
     */
    const messageText = (type, record, session)=>{
        const kind = type & 0xff000000;
        if (kind === INSTALLMESSAGE.ACTIONSTART)
        {
            const now = new Date();
            const two = (/** @type {number} */ value)=>String(value).padStart(2, '0');
            const description = getString(record, 2);
            return `Action ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`
                + `: ${getString(record, 1)}. ${description}`;
        }
        if (kind === INSTALLMESSAGE.INITIALIZE || kind === INSTALLMESSAGE.TERMINATE)
        {
            return '';
        }
        return formatRecord({ count: record.fields.length - 1, field: index=>{
            const value = record.fields[index] ?? null;
            return value !== null && typeof value === 'object' ? null : value;
        } }, session ? { property: session.getProperty } : null);
    };

    /**
     * Delivers a message: to a record handler, then a text handler, as the
     * program registered them; an error with neither goes to a message box
     * unless the interface is off. Answers what the interface answered.
     *
     * @param {number} type @param {import('./record.js').Record} record
     * @param {import('./session.js').Session | null} session
     * @param {unknown} [thread]  Whose call the message is part of; the
     *     caller's own when a program's call delivers it.
     */
    const deliver = async(type, record, session, thread = host.callerThread())=>{
        const kind = (type >>> 24) & 0xff;
        const bit = 1 << kind;
        if (recordUi && (recordUi.filter & bit) !== 0)
        {
            const handle = open('record', record);
            try
            {
                const answer = await host.call(recordUi.handler,
                    [recordUi.context, type >>> 0, handle], thread);
                if (answer !== 0)
                {
                    return answer;
                }
            }
            finally
            {
                handles.delete(handle);
            }
        }
        const text = messageText(type, record, session);
        if (externalUi && (externalUi.filter & bit) !== 0)
        {
            const bytes = externalUi.wide ? utf16(`${text}\0`) : encodeAnsi(`${text}\0`);
            const block = host.allocate(bytes.length);
            host.writeMemory(block, bytes);
            try
            {
                const answer = await host.call(externalUi.handler,
                    [externalUi.context, type >>> 0, block], thread);
                if (answer !== 0)
                {
                    return answer;
                }
            }
            finally
            {
                host.free(block);
            }
        }
        const level = uiLevel & 0x0f;
        if ((type & 0xff000000) === INSTALLMESSAGE.ERROR
            || (type & 0xff000000) === INSTALLMESSAGE.FATALEXIT)
        {
            host.log?.(`Error: ${text}`);
            if (level !== INSTALLUILEVEL.NONE && host.messageBox && text !== '')
            {
                const caption = session?.getProperty('ProductName') || 'Windows Installer';
                return host.messageBox(text, caption, MB_ICONERROR | (type & 0xff));
            }
            return IDOK;
        }
        return 0;
    };

    // ----- installing -----------------------------------------------------

    /** @type {Map<import('./session.js').Session, import('./engine.js').Engine>} */
    const engines = new Map();

    /**
     * The engine a session runs its actions in.
     *
     * @param {import('./session.js').Session} session
     * @param {unknown} thread  Whose call the installation answers: what it
     *     loads, frees and calls is that thread's, read once at the call --
     *     past an await, the thread on the processor is any other, which may
     *     be in the middle of its own code.
     */
    const engineFor = (session, thread)=>{
        let engine = engines.get(session);
        if (!engine)
        {
            /** @type {import('./engine.js').Engine} */
            const made = {
                session,
                thread,
                executing: false,
                ran: new Set(),
                commit: [],
                async: [],
                host: {
                    files: host.files,
                    hive: host.hive,
                    registration,
                    message: (type, record)=>deliver(type, record, session, made.thread),
                    openHandle: (owner, deferred)=>open('session', { session: owner, deferred }),
                    closeHandle: handle=>{
                        handles.delete(handle);
                    },
                    callDll: (path, entry, args)=>callDll(path, entry, args, made.thread),
                    startDll: (path, entry, args)=>startDll(path, entry, args, made.thread),
                    runExe: async(commandLine, directory, wait)=>
                        host.runExe?.(commandLine, directory, wait) ?? null,
                    registerTypeLib: (path, helpDir)=>registerTypeLib(path, helpDir, made.thread),
                    unregisterTypeLib: (libId, major, minor, language)=>
                        unregisterTypeLib(libId, major, minor, language, made.thread),
                    removeProduct: (product, features)=>maintain(product,
                        `REMOVE=${quoted(features)}`, made.thread),
                    installNested: (kind, source, commandLine)=>installNested(session, kind,
                        source, commandLine, made.thread),
                    cachePackage,
                    runScript: script=>runScript(made, script),
                    applyDelta: async(old, delta)=>{
                        const result = applyDeltaPatch(old, delta);
                        return { code: result.code, bytes: result.bytes ?? null };
                    },
                    registerPatches: async(productCode, folder)=>{
                        for (const entry of sessionPatches.get(session) ?? [])
                        {
                            const kept = entry.fresh
                                ? await keepCopy(entry.path, folder, '.msp') : entry.path;
                            registration.registerPatch(productCode, entry.patch.code,
                                kept ?? entry.path, entry.transforms);
                        }
                        const removed = session.getProperty('MSIPATCHREMOVE').split(';')
                            .map(entry=>entry.trim()).filter(Boolean);
                        for (const code of removed)
                        {
                            const local = registration.patches(productCode)
                                .find(item=>item.code.toUpperCase() === code.toUpperCase());
                            registration.unregisterPatch(productCode, code);
                            if (local && local.localPackage.toLowerCase()
                                .startsWith(folder.toLowerCase()))
                            {
                                host.files.remove(local.localPackage);
                            }
                        }
                    },
                    fileVersion: async path=>{
                        const block = await host.versionInfo?.(path) ?? null;
                        const fixed = block ? fixedInfo(block) : null;
                        return fixed ? `${fixed.ms >>> 16}.${fixed.ms & 0xffff}.`
                            + `${fixed.ls >>> 16}.${fixed.ls & 0xffff}` : null;
                    },
                    sourcePackage: async()=>{
                        const product = session.getProperty('ProductCode');
                        const list = registration.sourceList(product);
                        const name = list ? valueText(host.hive.getValue(list, 'PackageName'))
                            : null;
                        const folder = session.getProperty('SourceDir');
                        return name && folder ? loadDatabase(`${folder}${name}`) : null;
                    },
                    divergence: host.divergence,
                    log: host.log,
                },
            };
            engine = made;
            engines.set(session, engine);
        }
        return engine;
    };

    /**
     * A script custom action: the script run in the engine's own script
     * engine with the Session object named, then -- when the action names
     * one -- its function called, whose answer is read as a library action's
     * (IDOK success, IDCANCEL the user's exit, IDABORT failure). A script
     * that fails fails the action; one in a language no engine is offered
     * for says so.
     *
     * @param {import('./engine.js').Engine} engine
     * @param {{ language: 'jscript' | 'vbscript', text: string, entry: string | null,
     *     data: string | null, action: string }} script
     * @returns {Promise<number>}
     */
    const runScript = async(engine, script)=>{
        const make = SCRIPT_ENGINES[script.language];
        if (!make)
        {
            host.divergence?.(`custom action ${script.action}`,
                `no ${script.language} engine to run it`);
            return ERROR_INSTALL_FAILURE;
        }
        const { session } = engine;
        const owner = { session, deferred: script.data };
        const installer = installerObject({
            windows: host.machine().windows, registration,
            environment: name=>host.machine().environment(name),
            fileVersion: async path=>{
                const block = await host.versionInfo?.(host.fullPath(path)) ?? null;
                const fixed = block ? fixedInfo(block) : null;
                return fixed ? `${fixed.ms >>> 16}.${fixed.ms & 0xffff}.`
                    + `${fixed.ls >>> 16}.${fixed.ls & 0xffff}` : null;
            },
            fileSize: path=>{
                const stat = host.files.stat(host.fullPath(path));
                return stat && !stat.isDirectory ? stat.size : null;
            },
            format: record=>session.format(record),
        });
        const scripting = make({
            // The one class an installer's script asks for that this machine
            // has a server for: the installer's own object model.
            /** @param {string} progId */
            createObject: progId=>{
                if (/^WindowsInstaller\.Installer(\.\d+)?$/i.test(progId))
                {
                    return installer;
                }
                throw new ExternalError(CTL_E_CANTCREATEOBJECT,
                    `ActiveX component can't create object: ${progId}`);
            },
            divergence: host.divergence,
        });
        scripting.addNamedItem('Session', sessionObject(engine, {
            property: name=>propertyOf(owner, name),
            // A deferred action's Session reads its data; it sets nothing.
            setProperty: (name, value)=>{
                if (script.data === null)
                {
                    session.setProperty(name, value);
                }
            },
            doAction: action=>doAction(engine, action),
            sequence: table=>runSequence(engine, table),
            message: (kind, record)=>deliver(kind, record, session, engine.thread),
            installer,
        }));
        try
        {
            await scripting.run(script.text);
            const answer = script.entry ? await scripting.call(script.entry, []) : undefined;
            const status = typeof answer === 'number' ? answer : IDOK;
            return SCRIPT_ANSWERS.get(status) ?? ERROR_SUCCESS;
        }
        catch (e){
            const error = /** @type {any} */ (e);
            host.log?.(`Custom action ${script.action}: script error ${error?.number ?? ''} `
                + `${error?.description ?? error?.message ?? String(e)}`
                + `${error?.line ? ` at line ${error.line}` : ''}.`);
            return ERROR_INSTALL_FAILURE;
        }
    };

    /**
     * Runs part of an installation as the call of `thread`: an action a
     * custom action asks for runs on the custom action's thread.
     *
     * @template T
     * @param {import('./engine.js').Engine} engine @param {unknown} thread
     * @param {() => Promise<T>} run
     * @returns {Promise<T>}
     */
    const asCallOf = async(engine, thread, run)=>{
        const before = engine.thread;
        engine.thread = thread;
        try
        {
            return await run();
        }
        finally
        {
            engine.thread = before;
        }
    };

    /**
     * @template T
     * @param {unknown} thread @param {() => T} fn
     * @returns {T}
     */
    const on = (thread, fn)=>(host.answering ? host.answering(thread, fn) : fn());

    /**
     * Bytes as a NUL-terminated string in the guest for as long as `use` runs.
     *
     * @template T
     * @param {string} text @param {(address: number) => T | Promise<T>} use
     * @returns {Promise<T>}
     */
    const withString = async(text, use)=>{
        const bytes = encodeAnsi(`${text}\0`);
        const block = host.allocate(bytes.length);
        host.writeMemory(block, bytes);
        try
        {
            return await use(block);
        }
        finally
        {
            host.free(block);
        }
    };

    /**
     * Loads a library, calls one of its exports and frees it, as the
     * installer runs a library action.
     *
     * @param {string} path @param {string} entry @param {number[]} args
     * @param {unknown} thread  The installation's: its DllMain and its export run there.
     * @returns {Promise<number | null>}
     */
    async function callDll(path, entry, args, thread){
        const module = await withString(path, name=>on(thread, ()=>host.libraries.loadAnsi(name)));
        if (!module)
        {
            return null;
        }
        try
        {
            const address = await withString(entry,
                name=>on(thread, ()=>host.libraries.procAddress(module >>> 0, name)));
            if (!address)
            {
                return null;
            }
            return (await host.call(address >>> 0, args, thread)) >>> 0;
        }
        finally
        {
            await on(thread, ()=>host.libraries.free(module >>> 0));
        }
    }

    /**
     * Loads a library and starts one of its exports on a thread of its own,
     * which goes on after this returns: a library action that runs beside the
     * installation. The library is freed when the installation asks, where
     * its own thread stands still: the action's thread ends whenever it does,
     * and a DllMain run then would be run on whatever thread was on the
     * processor, in the middle of its own code.
     *
     * @param {string} path @param {string} entry @param {number[]} args
     * @param {unknown} installing  The installation's thread.
     * @returns {Promise<{ done: Promise<number | null>, stop: () => void,
     *     free: () => Promise<unknown> } | null>}
     */
    async function startDll(path, entry, args, installing){
        const threads = host.threads;
        if (!threads)
        {
            host.divergence?.('MSI', 'a custom action that runs beside the installation has no'
                + ' thread to run on');
            return null;
        }
        const module = await withString(path,
            name=>on(installing, ()=>host.libraries.loadAnsi(name)));
        if (!module)
        {
            return null;
        }
        const free = async()=>on(installing, ()=>host.libraries.free(module >>> 0));
        const address = await withString(entry,
            name=>on(installing, ()=>host.libraries.procAddress(module >>> 0, name)));
        const thread = address
            ? await on(installing, ()=>threads.start(address >>> 0, args[0] ?? 0)) : 0;
        if (!thread)
        {
            await free();
            return null;
        }
        const done = new Promise(resolve=>{
            const poll = async()=>{
                const code = await threads.exitCode(thread);
                if (code === STILL_ACTIVE)
                {
                    setTimeout(poll, THREAD_POLL_MS);
                    return;
                }
                resolve(code >>> 0);
            };
            poll();
        }).then(async code=>{
            await threads.close(thread);
            return /** @type {number} */ (code);
        });
        return { done, free, stop: ()=>{
            threads.terminate(thread);
        } };
    }

    /**
     * Lends `use` a way to open files on the volume as byte sources, and
     * closes every one it opened once `use` is done with them.
     *
     * @template T
     * @param {(openFile: (path: string) => import('./compound.js').ByteSource | null)
     *     => Promise<T>} use
     * @returns {Promise<T>}
     */
    const withFiles = async use=>{
        /** @type {any[]} */
        const nodes = [];
        /** @param {string} path */
        const openFile = path=>{
            const full = host.fullPath(path);
            const stat = host.files.stat(full);
            const node = stat && !stat.isDirectory
                ? host.files.open(full, { read: true, shareWrite: true }) : null;
            if (!node)
            {
                return null;
            }
            nodes.push(node);
            return { size: stat.size, read: (/** @type {number} */ offset,
                /** @type {number} */ length)=>host.files.read(node, offset, length) };
        };
        try
        {
            return await use(openFile);
        }
        finally
        {
            for (const node of nodes)
            {
                host.files.close(node);
            }
        }
    };

    /**
     * The file each opened database reads its streams from.
     *
     * @type {WeakMap<import('./database.js').Database, any>}
     */
    const readers = new WeakMap();

    /**
     * What a summary information handle belongs to: its database, the file
     * when it was opened by path, whether it was opened for changes and
     * whether any were made.
     *
     * @type {WeakMap<Map<number, any>, { db: import('./database.js').Database,
     *     path: string | null, changed: boolean, readOnly: boolean }>}
     */
    const summaries = new WeakMap();

    /**
     * Writes a database to a file: into a new file beside it first, then in
     * its place -- the database still reads its streams from the file it
     * replaces -- and the database then reads from the new one. Its tables,
     * which open views hold, and its string numbers stay as they were.
     *
     * @param {import('./database.js').Database} db @param {string} target
     * @param {Parameters<typeof writeDatabase>[2]} [options]
     * @returns {Promise<number>}
     */
    const saveDatabase = async(db, target, options)=>{
        const temporary = `${target}.tmp`;
        const node = host.files.open(temporary,
            { read: false, write: true, create: true, truncate: true });
        if (!node)
        {
            return ERROR_FUNCTION_FAILED;
        }
        try
        {
            await writeDatabase(db,
                { write: (offset, bytes)=>host.files.write(node, offset, bytes) }, options);
        }
        catch (e){
            host.files.close(node);
            host.files.remove(temporary);
            host.log?.(`${target}: ${/** @type {Error} */ (e).message}`);
            return ERROR_FUNCTION_FAILED;
        }
        host.files.close(node);
        const old = readers.get(db);
        if (old)
        {
            host.files.close(old);
            readers.delete(db);
        }
        if (host.files.stat(target))
        {
            host.files.remove(target);
        }
        if (!host.files.rename(temporary, target))
        {
            return ERROR_FUNCTION_FAILED;
        }
        const fresh = await loadDatabase(target);
        if (fresh)
        {
            for (const name of /** @type {const} */ (['hasStream', 'streamSize', 'readStream',
                'readStreamRange', 'writeStream', 'streamNames', 'compound', 'summaryStream',
                'setSummaryStream']))
            {
                /** @type {any} */ (db)[name] = /** @type {any} */ (fresh)[name];
            }
            readers.set(db, readers.get(fresh));
        }
        return ERROR_SUCCESS;
    };

    /**
     * A file copied whole into the machine's Installer folder under a name
     * of its own; its path, or null when it could not be copied.
     *
     * @param {string} path @param {string} folder @param {string} extension
     */
    const keepCopy = async(path, folder, extension)=>{
        const bytes = await readFile(host.files, host.fullPath(path));
        if (!bytes)
        {
            return null;
        }
        if (!host.files.stat(folder.replace(/\\$/, ''))?.isDirectory)
        {
            host.files.mkdir(folder.replace(/\\$/, ''));
        }
        const name = `${folder.replace(/\\$/, '')}\\`
            + `${Math.floor(Math.random() * 0x100000000).toString(16)}${extension}`;
        return writeFile(host.files, name, bytes) ? name : null;
    };

    /**
     * A copy of an installed package for the machine to keep, as Windows
     * keeps one in its Installer folder for a repair or a removal: the
     * package as it shipped, its embedded cabinets left out. Null when it
     * could not be written.
     *
     * @param {string} packagePath @param {string} folder  The machine's Installer folder.
     * @returns {Promise<string | null>}
     */
    const cachePackage = async(packagePath, folder)=>{
        const db = await loadDatabase(packagePath);
        if (!db)
        {
            return null;
        }
        if (!host.files.stat(folder)?.isDirectory)
        {
            host.files.mkdir(folder);
        }
        const name = `${folder.replace(/\\$/, '')}\\${Math.floor(Math.random() * 0x100000000).toString(16)}.msi`;
        const cabinets = embeddedCabinets(db);
        const code = await saveDatabase(db, name, { omitStreams: stream=>cabinets.has(stream) });
        const node = readers.get(db);
        if (node)
        {
            host.files.close(node);
        }
        return code === ERROR_SUCCESS ? name : null;
    };

    /**
     * A database out of a file on the volume, read where it lies.
     *
     * @param {string} path
     * @returns {Promise<import('./database.js').Database | null>}
     */
    const loadDatabase = async path=>{
        const full = host.fullPath(path);
        const stat = host.files.stat(full);
        if (!stat || stat.isDirectory)
        {
            return null;
        }
        const node = host.files.open(full, { read: true, shareWrite: true });
        if (!node)
        {
            return null;
        }
        try
        {
            const db = await openDatabase(await openCompound({
                size: stat.size,
                read: (offset, length)=>host.files.read(node, offset, length),
            }));
            // Read where it lies, the file stays open until a commit replaces it.
            readers.set(db, node);
            return db;
        }
        catch (e){
            host.files.close(node);
            host.log?.(`${full}: ${/** @type {Error} */ (e).message}`);
            return null;
        }
    };

    /**
     * A patch file opened for as long as an installation reads the cabinets
     * inside it; the patch, or the error the patch calls answer.
     *
     * @param {string} path @returns {Promise<import('./patch.js').Patch | number>}
     */
    const loadPatch = async path=>{
        const full = host.fullPath(path);
        const stat = host.files.stat(full);
        const node = stat && !stat.isDirectory
            ? host.files.open(full, { read: true, shareWrite: true }) : null;
        if (!node)
        {
            return ERROR_PATCH_PACKAGE_OPEN_FAILED;
        }
        const patch = await openPatch({ size: stat.size,
            read: (offset, length)=>host.files.read(node, offset, length) });
        if (typeof patch === 'number')
        {
            host.files.close(node);
        }
        return patch;
    };

    /**
     * The patches an installation applies, with where each came from: those
     * its PATCH property names and those already applied to the product,
     * less the ones MSIPATCHREMOVE takes away.
     *
     * @type {WeakMap<import('./session.js').Session, { patch: import('./patch.js').Patch,
     *     path: string, fresh: boolean, transforms: string }[]>}
     */
    const sessionPatches = new WeakMap();

    /**
     * Applies an installation's patches to its package before the session
     * reads it.
     *
     * @param {import('./database.js').Database} db @param {string} commandLine
     */
    const patchesFor = async(db, commandLine)=>{
        const properties = parseCommandLine(commandLine);
        const productCode = String(db.table('Property')?.rows
            .find((/** @type {any[]} */ row)=>row[0] === 'ProductCode')?.[1] ?? '');
        const removing = new Set((properties.get('MSIPATCHREMOVE') ?? '').split(';')
            .map(entry=>entry.trim().toUpperCase()).filter(Boolean));
        /** @type {{ patch: import('./patch.js').Patch, path: string, fresh: boolean }[]} */
        const found = [];
        for (const path of (properties.get('PATCH') ?? '').split(';').map(entry=>entry.trim())
            .filter(Boolean))
        {
            const patch = await loadPatch(path);
            if (typeof patch === 'number')
            {
                return patch;
            }
            found.push({ patch, path: host.fullPath(path), fresh: true });
        }
        for (const installed of registration.patches(productCode))
        {
            if (removing.has(installed.code.toUpperCase()) || removing.has(installed.localPackage
                .toUpperCase()))
            {
                continue;
            }
            const patch = await loadPatch(installed.localPackage);
            if (typeof patch !== 'number')
            {
                found.push({ patch, path: installed.localPackage, fresh: false });
            }
        }
        const chosen = effectivePatches(found.map(entry=>entry.patch));
        const applied = [];
        for (const entry of found.filter(item=>chosen.includes(item.patch)))
        {
            const code = await applyPatch(db, entry.patch, { productCode, log: host.log });
            if (code !== ERROR_SUCCESS)
            {
                if (entry.fresh)
                {
                    return code;
                }
                continue;
            }
            applied.push({ ...entry, transforms: entry.patch.transforms
                .map(name=>`:${name}`).join(';') });
        }
        return applied;
    };

    /**
     * A package opened as a session: a path, or "#n" for a database handle
     * already open.
     *
     * @param {string} path @param {string} [commandLine]
     * @param {{ db: import('./database.js').Database, packagePath: string }} [given]
     *     A package already open -- one nested in another's storage.
     */
    const openSession = async(path, commandLine = '', given)=>{
        const byHandle = given ? null : /^#(\d+)$/.exec(path);
        const opened = byHandle ? get(Number(byHandle[1]), 'database') : null;
        const packagePath = given?.packagePath ?? (byHandle ? opened?.path ?? ''
            : host.fullPath(path));
        const db = given?.db ?? (byHandle ? opened?.db ?? null : await loadDatabase(packagePath));
        if (!db)
        {
            return ERROR_INSTALL_PACKAGE_OPEN_FAILED;
        }
        // The transforms the installation names, applied to the package before
        // anything is read from it. A database handed over by handle is the
        // caller's, transformed already if it wanted that.
        const transforms = byHandle ? '' : parseCommandLine(commandLine).get('TRANSFORMS')
            ?? String(db.table('Property')?.rows
                .find((/** @type {any[]} */ row)=>row[0] === 'TRANSFORMS')?.[1] ?? '');
        if (transforms !== '')
        {
            const applied = await withFiles(openFile=>applyTransformList(db, transforms,
                { packagePath, openFile, log: host.log }));
            if (applied.code !== ERROR_SUCCESS)
            {
                host.log?.(`${packagePath}: transforms ${transforms} answered ${applied.code}.`);
                return ERROR_INSTALL_TRANSFORM_FAILURE;
            }
        }
        const patched = byHandle ? [] : await patchesFor(db, commandLine);
        if (typeof patched === 'number')
        {
            return patched;
        }
        db.readOnly = true;
        const session = createSession({
            db, packagePath, machine: host.machine(), commandLine,
            isInstalled: code=>registration.productState(code) === INSTALLSTATE.DEFAULT,
            installed: {
                feature: registration.featureInstalled,
                component: (product, id)=>registration.componentPath(product, id) !== null,
                sharedWith: registration.sharedWith,
            },
        });
        session.setProperty('UILevel', String(uiLevel & 0x0f || INSTALLUILEVEL.BASIC));
        sessionPatches.set(session, patched);
        // Run from the machine's own copy, the package's source is where it
        // was installed from, as the product's records say.
        const product = session.getProperty('ProductCode');
        const kept = registration.productInfo(product, 'LocalPackage');
        const source = registration.productInfo(product, 'InstallSource');
        if ('value' in kept && kept.value.toLowerCase() === packagePath.toLowerCase()
            && 'value' in source && source.value !== '')
        {
            session.setProperty('SourceDir', source.value);
            session.setProperty('SOURCEDIR', source.value);
        }
        return session;
    };

    /**
     * MsiInstallProduct's work: the UI sequence when the interface is full or
     * reduced, which starts the execute sequence through ExecuteAction; the
     * execute sequence alone otherwise.
     *
     * @param {string} path @param {string} commandLine
     * @param {unknown} [thread]  Whose call the installation answers.
     * @param {{ db: import('./database.js').Database, packagePath: string }} [given]
     *     The package already open, for one nested in another's storage.
     */
    const installPackage = async(path, commandLine, thread = host.callerThread(), given)=>{
        const session = await openSession(path, commandLine, given);
        if (typeof session === 'number')
        {
            return session;
        }
        session.setProperty('ACTION', session.getProperty('ACTION') || 'INSTALL');
        const advertising = session.getProperty('ACTION') === 'ADVERTISE';
        if (advertising && session.getProperty('ADVERTISE') === '')
        {
            session.setProperty('ADVERTISE', 'ALL');
        }
        session.setProperty('EXECUTEACTION', advertising ? 'ADVERTISE' : 'INSTALL');
        const engine = engineFor(session, thread);
        await deliver(INSTALLMESSAGE.INITIALIZE, createRecord(0), session, thread);
        const level = uiLevel & 0x0f;
        const ui = level === INSTALLUILEVEL.FULL || level === INSTALLUILEVEL.REDUCED;
        let code;
        try
        {
            code = advertising ? await runSequence(engine, 'AdvertiseExecuteSequence')
                : ui ? await runSequence(engine, 'InstallUISequence')
                    : await runSequence(engine, 'InstallExecuteSequence');
            if (!advertising && ui && code === ERROR_SUCCESS && !engine.ran.has('ExecuteAction')
                && session.script.length === 0 && session.getProperty('CostingComplete') !== '1')
            {
                code = await doAction(engine, 'ExecuteAction');
            }
        }
        finally
        {
            const late = await finishAsync(engine);
            if (code === ERROR_SUCCESS && late !== ERROR_SUCCESS)
            {
                code = late;
            }
            await deliver(INSTALLMESSAGE.TERMINATE, createRecord(0), session, thread);
            engines.delete(session);
        }
        if (code === ERROR_SUCCESS && session.mode.rebootAtEnd)
        {
            code = ERROR_SUCCESS_REBOOT_REQUIRED;
        }
        host.log?.(`Installation of ${path} answered ${code}.`);
        return code;
    };

    // ----- an installed product ---------------------------------------------

    /**
     * The copy of its package the machine kept for an installed product, or
     * the error a call on a product that is not installed answers.
     *
     * @param {string | null} productCode @returns {string | number}
     */
    const localPackage = productCode=>{
        if (productCode === null || squashGuid(productCode) === null)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const state = registration.productState(productCode);
        if (state === INSTALLSTATE.ADVERTISED)
        {
            // Only advertised: its first use installs it from its source.
            const list = registration.sourceList(productCode);
            const net = list ? host.hive.open(list, 'Net') : null;
            const folder = net ? valueText(host.hive.getValue(net, '1')) : null;
            const name = list ? valueText(host.hive.getValue(list, 'PackageName')) : null;
            return folder && name ? `${folder}${name}` : ERROR_INSTALL_SOURCE_ABSENT;
        }
        if (state !== INSTALLSTATE.DEFAULT)
        {
            return ERROR_UNKNOWN_PRODUCT;
        }
        const info = registration.productInfo(productCode, 'LocalPackage');
        return 'value' in info && info.value !== '' ? info.value : ERROR_INSTALL_SOURCE_ABSENT;
    };

    /**
     * An installed product's package run again with the properties that ask
     * for a change: a removal, a repair, a feature added or taken away.
     *
     * @param {string | null} productCode @param {string} request
     * @param {unknown} [thread]  Whose call the installation answers.
     */
    const maintain = async(productCode, request, thread = host.callerThread())=>{
        const local = localPackage(productCode);
        return typeof local === 'number' ? local : installPackage(local, request, thread);
    };

    /**
     * A nested installation a custom action runs: a package stored in this
     * one's own file, a package beside this one's source, or an installed
     * product configured again -- each an installation of its own, answering
     * as MsiInstallProduct does.
     *
     * @param {import('./session.js').Session} parent
     * @param {'storage' | 'path' | 'product'} kind @param {string} source
     * @param {string} commandLine @param {unknown} thread
     */
    const installNested = async(parent, kind, source, commandLine, thread)=>{
        if (kind === 'product')
        {
            return maintain(source, commandLine, thread);
        }
        if (kind === 'path')
        {
            const path = /^[A-Za-z]:\\|^\\\\/.test(source) ? source
                : `${parent.sourceDir}${source}`;
            return installPackage(path, commandLine, thread);
        }
        const compound = parent.db.compound;
        const storage = compound ? [...compound.root.children.values()]
            .find(node=>node.kind === 'storage' && node.name === source) : null;
        if (!compound || !storage)
        {
            return ERROR_INSTALL_PACKAGE_OPEN_FAILED;
        }
        const db = await openDatabase({ ...compound, root: storage }).catch(()=>null);
        return db ? installPackage(source, commandLine, thread,
            { db, packagePath: `${parent.packagePath.slice(0,
                parent.packagePath.lastIndexOf('\\') + 1)}${source}.msi` })
            : ERROR_INSTALL_PACKAGE_INVALID;
    };

    /**
     * Calls one of oleaut32's exports from the installation, with the strings
     * and out-pointers it takes laid out in the guest for the call.
     *
     * @param {string} entry @param {(block: number) => number[]} args
     * @param {Uint8Array} data  Copied to the block first.
     * @param {unknown} thread
     * @returns {Promise<{ answer: number, block: Uint8Array } | null>}
     */
    const callOleaut = async(entry, args, data, thread)=>{
        const module = await withString('oleaut32.dll',
            name=>on(thread, ()=>host.libraries.loadAnsi(name)));
        if (!module)
        {
            return null;
        }
        const block = host.allocate(data.length);
        host.writeMemory(block, data);
        try
        {
            const address = await withString(entry,
                name=>on(thread, ()=>host.libraries.procAddress(module >>> 0, name)));
            if (!address)
            {
                return null;
            }
            const answer = (await host.call(address >>> 0, args(block), thread)) >>> 0;
            return { answer, block: host.readMemory(block, data.length).slice() };
        }
        finally
        {
            host.free(block);
            await on(thread, ()=>host.libraries.free(module >>> 0));
        }
    };

    /**
     * RegisterTypeLibraries' registration of one file: loaded by oleaut32,
     * registered with the help folder the row names, released.
     *
     * @param {string} path @param {string | null} helpDir @param {unknown} thread
     */
    const registerTypeLib = async(path, helpDir, thread)=>{
        const name = utf16(`${path}\0`);
        const help = helpDir === null ? new Uint8Array(0) : utf16(`${helpDir}\0`);
        // The out-pointer first, then the path and the help folder.
        const data = new Uint8Array(4 + name.length + help.length);
        data.set(name, 4);
        data.set(help, 4 + name.length);
        const loaded = await callOleaut('LoadTypeLibEx',
            block=>[block + 4, REGKIND_NONE, block], data, thread);
        if (!loaded || loaded.answer !== 0)
        {
            return loaded?.answer ?? null;
        }
        const library = new DataView(loaded.block.buffer).getUint32(0, true);
        try
        {
            const registered = await callOleaut('RegisterTypeLib', block=>[library, block,
                helpDir === null ? 0 : block + name.length], data.subarray(4), thread);
            return registered?.answer ?? null;
        }
        finally
        {
            const table = readU32(library);
            await host.call(readU32(table + 8), [library], thread);
        }
    };

    /**
     * UnregisterTypeLibraries' undoing of one: UnRegisterTypeLib for the
     * library's GUID, version and language.
     *
     * @param {string} libId @param {number} major @param {number} minor
     * @param {number} language @param {unknown} thread
     */
    const unregisterTypeLib = async(libId, major, minor, language, thread)=>{
        const guid = parseGuid(libId);
        if (guid === null)
        {
            return null;
        }
        const done = await callOleaut('UnRegisterTypeLib',
            block=>[block, major, minor, language, SYS_WIN32], guid, thread);
        return done?.answer ?? null;
    };

    /**
     * MsiConfigureProduct(Ex): the whole product put in a state -- removed,
     * every feature local or run from source, or reconfigured as it is --
     * at an install level, the caller's own properties after.
     *
     * @param {string | null} productCode @param {number} level @param {number} state
     * @param {string} commandLine
     */
    const configureProduct = async(productCode, level, state, commandLine)=>{
        const request = PRODUCT_REQUESTS.get(state | 0);
        if (request === undefined)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const levelText = (level | 0) === INSTALLLEVEL_DEFAULT ? ''
            : `INSTALLLEVEL=${(level | 0) === INSTALLLEVEL_MAXIMUM ? 32767 : level | 0}`;
        return maintain(productCode, [request, levelText, commandLine]
            .filter(part=>part !== '').join(' '));
    };

    // ----- sessions: what a custom action calls ---------------------------

    /**
     * The session a handle names, and whether it is a deferred action's.
     *
     * @param {number} handle
     * @returns {{ session: import('./session.js').Session, deferred: string | null } | null}
     */
    const sessionOf = handle=>get(handle, 'session');

    /** @param {{ session: any, deferred: string | null }} owner @param {string} name */
    const propertyOf = (owner, name)=>{
        if (owner.deferred === null)
        {
            return owner.session.getProperty(name);
        }
        // A deferred action sees its own data and a couple of facts, no more.
        if (name === 'CustomActionData')
        {
            return owner.deferred;
        }
        return name === 'ProductCode' || name === 'UserSID' ? owner.session.getProperty(name) : '';
    };

    /** @param {number} handle @returns {import('./record.js').Record | null} */
    const recordOf = handle=>get(handle, 'record');

    /**
     * A string into a buffer the caller sized for it, as the calls that hand
     * back a GUID or a feature's name take one: the text and its terminator.
     *
     * @param {boolean} wide @param {string} text @param {number} buffer
     */
    const putFixed = (wide, text, buffer)=>{
        host.writeMemory(buffer >>> 0, wide ? utf16(`${text}\0`) : encodeAnsi(`${text}\0`));
    };

    return {
        ...createProductFunctions({
            registration, hive: host.hive, files: host.files, fullPath: host.fullPath, reader,
            putString, putFixed, readU32, writeU32, get,
            writeMemory: (address, bytes)=>host.writeMemory(address, bytes),
            readFile: path=>readFile(host.files, path),
            openPackage: async path=>{
                const db = await loadDatabase(path);
                return db ? { compound: db.compound } : null;
            },
            maintain: (productCode, request)=>maintain(productCode, request),
            openProduct: async productCode=>{
                const local = localPackage(productCode);
                return typeof local === 'number' ? local : openSession(local);
            },
            messageBox: host.messageBox
                ? (text, caption, type)=>/** @type {any} */ (host.messageBox)(text, caption, type)
                : undefined,
            advertise: (path, transforms)=>installPackage(path,
                `ACTION=ADVERTISE${transforms ? ` TRANSFORMS="${transforms}"` : ''}`),
            inspectPatch: async path=>{
                const patch = await loadPatch(path);
                return typeof patch === 'number' ? patch
                    : { code: patch.code, targets: patch.targets };
            },
            productCodeOf: async path=>{
                const db = await loadDatabase(path);
                const row = db?.table('Property')?.rows
                    .find((/** @type {any[]} */ entry)=>entry[0] === 'ProductCode');
                return row ? String(row[1]) : null;
            },
            divergence: host.divergence,
        }),
        // ----- handles and records -----
        MsiCloseHandle: {
            argBytes: 4,
            handler: ([handle])=>{
                if ((handle >>> 0) === 0)
                {
                    return ERROR_SUCCESS;
                }
                return handles.delete(handle >>> 0) ? ERROR_SUCCESS : ERROR_INVALID_HANDLE;
            },
        },
        MsiCloseAllHandles: {
            argBytes: 0,
            handler: ()=>{
                const count = handles.size;
                handles.clear();
                return count;
            },
        },
        MsiCreateRecord: {
            argBytes: 4,
            handler: ([count])=>((count >>> 0) > MAX_FIELDS ? 0
                : open('record', createRecord(count >>> 0))),
        },
        MsiRecordGetFieldCount: {
            argBytes: 4,
            handler: ([handle])=>{
                const record = recordOf(handle);
                return record ? record.fields.length - 1 : -1;
            },
        },
        MsiRecordIsNull: {
            argBytes: 8,
            handler: ([handle, field])=>{
                const record = recordOf(handle);
                return record ? (isNull(record, field >>> 0) ? 1 : 0) : 0;
            },
        },
        MsiRecordDataSize: {
            argBytes: 8,
            handler: ([handle, field])=>{
                const record = recordOf(handle);
                return record && (field >>> 0) < record.fields.length
                    ? dataSize(record, field >>> 0) : 0;
            },
        },
        MsiRecordGetInteger: {
            argBytes: 8,
            handler: ([handle, field])=>{
                const record = recordOf(handle);
                return record ? getInteger(record, field >>> 0) : MSI_NULL_INTEGER;
            },
        },
        MsiRecordSetInteger: {
            argBytes: 12,
            handler: ([handle, field, value])=>{
                const record = recordOf(handle);
                if (!record)
                {
                    return ERROR_INVALID_HANDLE;
                }
                return setInteger(record, field >>> 0, value | 0) ? ERROR_SUCCESS
                    : ERROR_INVALID_PARAMETER;
            },
        },
        ...both('MsiRecordGetString', 16, wide=>([handle, field, buffer, size])=>{
            const record = recordOf(handle);
            if (!record)
            {
                return ERROR_INVALID_HANDLE;
            }
            const value = record.fields[field >>> 0] ?? null;
            if (value !== null && typeof value === 'object')
            {
                return ERROR_INVALID_DATATYPE;
            }
            return putString(wide, getString(record, field >>> 0), buffer, size);
        }),
        ...both('MsiRecordSetString', 12, wide=>([handle, field, text])=>{
            const record = recordOf(handle);
            if (!record)
            {
                return ERROR_INVALID_HANDLE;
            }
            return setString(record, field >>> 0, reader(wide)(text)) ? ERROR_SUCCESS
                : ERROR_INVALID_PARAMETER;
        }),
        ...both('MsiRecordSetStream', 12, wide=>async([handle, field, path])=>{
            const record = recordOf(handle);
            if (!record)
            {
                return ERROR_INVALID_HANDLE;
            }
            const name = reader(wide)(path);
            if (name === null)
            {
                const value = record.fields[field >>> 0] ?? null;
                if (value !== null && typeof value === 'object')
                {
                    value.position = 0;
                    return ERROR_SUCCESS;
                }
                return ERROR_INVALID_PARAMETER;
            }
            const bytes = await readFile(host.files, host.fullPath(name));
            if (!bytes)
            {
                return ERROR_FILE_NOT_FOUND;
            }
            return setStream(record, field >>> 0, bytesStream(bytes)) ? ERROR_SUCCESS
                : ERROR_INVALID_PARAMETER;
        }),
        MsiRecordReadStream: {
            argBytes: 16,
            handler: async([handle, field, buffer, size])=>{
                const record = recordOf(handle);
                if (!record)
                {
                    return ERROR_INVALID_HANDLE;
                }
                if ((size >>> 0) === 0 || (field >>> 0) >= record.fields.length)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const value = record.fields[field >>> 0];
                if (value === null)
                {
                    writeU32(size, 0);
                    return ERROR_INVALID_DATA;
                }
                if (typeof value !== 'object')
                {
                    return ERROR_INVALID_DATATYPE;
                }
                if ((buffer >>> 0) === 0)
                {
                    value.position = 0;
                    writeU32(size, value.stream.size);
                    return ERROR_SUCCESS;
                }
                const want = Math.min(readU32(size), value.stream.size - value.position);
                const bytes = want > 0 ? await value.stream.read(value.position, want)
                    : new Uint8Array(0);
                host.writeMemory(buffer >>> 0, bytes);
                value.position += bytes.length;
                writeU32(size, bytes.length);
                return ERROR_SUCCESS;
            },
        },
        MsiRecordClearData: {
            argBytes: 4,
            handler: ([handle])=>{
                const record = recordOf(handle);
                if (!record)
                {
                    return ERROR_INVALID_HANDLE;
                }
                clearRecord(record);
                return ERROR_SUCCESS;
            },
        },
        ...both('MsiFormatRecord', 16, wide=>([install, handle, buffer, size])=>{
            const record = recordOf(handle);
            if (!record)
            {
                return ERROR_INVALID_HANDLE;
            }
            const owner = sessionOf(install);
            const text = owner ? owner.session.format(record, owner.deferred !== null)
                : formatRecord({ count: record.fields.length - 1, field: index=>{
                    const value = record.fields[index] ?? null;
                    return value !== null && typeof value === 'object' ? null : value;
                } }, null);
            return putString(wide, text, buffer, size);
        }),

        // ----- databases and views -----
        ...both('MsiOpenDatabase', 12, wide=>async([path, persist, out])=>{
            const name = reader(wide)(path);
            if (name === null || (out >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            // A persist value past the modes is a pointer: the file a commit
            // writes to, the database opened for changes.
            const outPath = (persist >>> 0) > 0xffff ? reader(wide)(persist) : null;
            const mode = outPath !== null ? MSIDBOPEN_TRANSACT
                : (persist >>> 0) & ~MSIDBOPEN_PATCHFILE;
            let db;
            if (mode === MSIDBOPEN_CREATE || mode === MSIDBOPEN_CREATEDIRECT)
            {
                db = createEmptyDatabase();
            }
            else
            {
                db = await loadDatabase(name);
                if (!db)
                {
                    return host.files.stat(host.fullPath(name)) ? ERROR_INSTALL_PACKAGE_INVALID
                        : ERROR_OPEN_FAILED;
                }
                db.readOnly = mode === MSIDBOPEN_READONLY;
            }
            writeU32(out, open('database', { db, path: host.fullPath(name), mode,
                outPath: outPath === null ? null : host.fullPath(outPath) }));
            return ERROR_SUCCESS;
        }),
        ...both('MsiDatabaseOpenView', 12, wide=>([database, query, out])=>{
            const opened = get(database, 'database');
            if (!opened)
            {
                return ERROR_INVALID_HANDLE;
            }
            const text = reader(wide)(query);
            if (text === null || (out >>> 0) === 0)
            {
                return ERROR_BAD_QUERY_SYNTAX;
            }
            const result = openView(opened.db, text);
            if ('error' in result)
            {
                return result.error;
            }
            writeU32(out, open('view', { view: result.view, db: opened.db }));
            return ERROR_SUCCESS;
        }),
        MsiViewExecute: {
            argBytes: 8,
            handler: ([view, params])=>{
                const opened = get(view, 'view');
                if (!opened)
                {
                    return ERROR_INVALID_HANDLE;
                }
                return opened.view.execute((params >>> 0) === 0 ? null : recordOf(params));
            },
        },
        MsiViewFetch: {
            argBytes: 8,
            handler: ([view, out])=>{
                const opened = get(view, 'view');
                if (!opened)
                {
                    return ERROR_INVALID_HANDLE;
                }
                if ((out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if (!opened.view.executed)
                {
                    return ERROR_FUNCTION_FAILED;
                }
                const record = opened.view.fetch();
                if (!record)
                {
                    writeU32(out, 0);
                    return opened.view.kind === 'select' ? ERROR_NO_MORE_ITEMS
                        : ERROR_FUNCTION_FAILED;
                }
                writeU32(out, open('record', record));
                return ERROR_SUCCESS;
            },
        },
        MsiViewClose: {
            argBytes: 4,
            handler: ([view])=>{
                const opened = get(view, 'view');
                if (!opened)
                {
                    return ERROR_INVALID_HANDLE;
                }
                opened.view.close();
                return ERROR_SUCCESS;
            },
        },
        MsiViewModify: {
            argBytes: 12,
            handler: ([view, mode, handle])=>{
                const opened = get(view, 'view');
                const record = recordOf(handle);
                if (!opened || !record)
                {
                    return ERROR_INVALID_HANDLE;
                }
                return opened.view.modify(mode | 0, record);
            },
        },
        MsiViewGetColumnInfo: {
            argBytes: 12,
            handler: ([view, kind, out])=>{
                const opened = get(view, 'view');
                if (!opened)
                {
                    return ERROR_INVALID_HANDLE;
                }
                if ((out >>> 0) === 0 || (kind >>> 0) > 1)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                writeU32(out, open('record', columnInfo(opened.view.columns, null,
                    (kind >>> 0) === 0 ? 'names' : 'types')));
                return ERROR_SUCCESS;
            },
        },
        ...both('MsiViewGetError', 12, wide=>([view, buffer, size])=>{
            if (!get(view, 'view'))
            {
                return -3;
            }
            putString(wide, '', buffer, size);
            return 0;
        }),
        MsiDatabaseCommit: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([database])=>{
                const opened = get(database, 'database');
                if (!opened)
                {
                    return ERROR_INVALID_HANDLE;
                }
                if (opened.mode === MSIDBOPEN_READONLY || opened.db.readOnly)
                {
                    return ERROR_SUCCESS;
                }
                return saveDatabase(opened.db, opened.outPath ?? opened.path);
            },
        },
        ...both('MsiDatabaseGetPrimaryKeys', 12, wide=>([database, table, out])=>{
            const opened = get(database, 'database');
            if (!opened)
            {
                return ERROR_INVALID_HANDLE;
            }
            const name = reader(wide)(table) ?? '';
            const found = opened.db.table(name);
            if (!found)
            {
                return ERROR_INVALID_TABLE;
            }
            const keys = found.columns.filter(isKey).map((/** @type {any} */ column)=>column.name);
            const record = createRecord(keys.length);
            record.fields[0] = name;
            keys.forEach((/** @type {string} */ key, /** @type {number} */ index)=>{
                record.fields[index + 1] = key;
            });
            writeU32(out, open('record', record));
            return ERROR_SUCCESS;
        }),
        ...both('MsiDatabaseIsTablePersistent', 8, wide=>([database, table])=>{
            const opened = get(database, 'database');
            if (!opened)
            {
                return MSICONDITION.ERROR;
            }
            const found = opened.db.table(reader(wide)(table) ?? '');
            return !found ? MSICONDITION.NONE : found.temporary ? MSICONDITION.FALSE
                : MSICONDITION.TRUE;
        }),
        MsiGetActiveDatabase: {
            argBytes: 4,
            handler: ([install])=>{
                const owner = sessionOf(install);
                return owner ? open('database', { db: owner.session.active,
                    path: owner.session.packagePath }) : 0;
            },
        },
        MsiGetLastErrorRecord: { argBytes: 0, handler: ()=>0 },

        // ----- summary information -----
        ...both('MsiGetSummaryInformation', 16, wide=>async([database, path, count, out])=>{
            if ((out >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const opened = get(database, 'database');
            let db = opened?.db ?? null;
            if (!db && (database >>> 0) !== 0)
            {
                return ERROR_INVALID_HANDLE;
            }
            if (!db)
            {
                const name = reader(wide)(path);
                db = name === null ? null : await loadDatabase(name);
                if (!db)
                {
                    return ERROR_INSTALL_PACKAGE_INVALID;
                }
            }
            const summary = readSummary(db.summaryStream());
            summaries.set(summary, { db, path: opened ? null : reader(wide)(path), changed: false,
                readOnly: Boolean(opened?.db.readOnly ?? (count | 0) === 0) });
            writeU32(out, open('summary', summary));
            return ERROR_SUCCESS;
        }),
        MsiSummaryInfoGetPropertyCount: {
            argBytes: 8,
            handler: ([handle, out])=>{
                const summary = get(handle, 'summary');
                if (!summary)
                {
                    return ERROR_INVALID_HANDLE;
                }
                if ((out >>> 0) !== 0)
                {
                    writeU32(out, summary.size);
                }
                return ERROR_SUCCESS;
            },
        },
        ...both('MsiSummaryInfoGetProperty', 28,
            wide=>([handle, property, type, integer, filetime, buffer, size])=>{
                const summary = get(handle, 'summary');
                if (!summary)
                {
                    return ERROR_INVALID_HANDLE;
                }
                if (!(property in PID_TYPES))
                {
                    return ERROR_UNKNOWN_PROPERTY;
                }
                const entry = summary.get(property >>> 0) ?? null;
                if ((type >>> 0) !== 0)
                {
                    writeU32(type, entry?.type ?? VT.EMPTY);
                }
                if (!entry)
                {
                    return ERROR_SUCCESS;
                }
                if (entry.type === VT.LPSTR)
                {
                    return putString(wide, String(entry.value), buffer, size);
                }
                if (entry.type === VT.FILETIME)
                {
                    if ((filetime >>> 0) !== 0)
                    {
                        host.writeMemory(filetime >>> 0, new Uint8Array(
                            BigUint64Array.of(BigInt(entry.value)).buffer));
                    }
                    return ERROR_SUCCESS;
                }
                if ((integer >>> 0) !== 0)
                {
                    writeI32(integer, Number(entry.value));
                }
                return ERROR_SUCCESS;
            }),
        ...both('MsiSummaryInfoSetProperty', 24, wide=>([handle, property, type, integer, filetime,
            text])=>{
            const summary = get(handle, 'summary');
            if (!summary)
            {
                return ERROR_INVALID_HANDLE;
            }
            const wanted = /** @type {Record<number, number>} */ (PID_TYPES)[property >>> 0];
            if (wanted === undefined)
            {
                return ERROR_UNKNOWN_PROPERTY;
            }
            if ((type >>> 0) !== wanted)
            {
                return ERROR_DATATYPE_MISMATCH;
            }
            const value = wanted === VT.LPSTR ? reader(wide)(text) ?? ''
                : wanted === VT.FILETIME ? new DataView(host.readMemory(filetime >>> 0, 8)
                    .slice().buffer).getBigUint64(0, true) : integer | 0;
            summary.set(property >>> 0, { type: wanted, value });
            const owner = summaries.get(summary);
            if (owner)
            {
                owner.changed = true;
            }
            return ERROR_SUCCESS;
        }),
        MsiSummaryInfoPersist: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([handle])=>{
                const summary = get(handle, 'summary');
                const owner = summary ? summaries.get(summary) : null;
                if (!summary || !owner)
                {
                    return ERROR_INVALID_HANDLE;
                }
                if (owner.readOnly)
                {
                    return ERROR_FUNCTION_FAILED;
                }
                if (!owner.changed)
                {
                    return ERROR_SUCCESS;
                }
                owner.db.setSummaryStream(writeSummaryStream(summary));
                owner.changed = false;
                // Through a database handle, the file changes at its commit;
                // a summary opened by path is its file's alone, written now.
                return owner.path === null ? ERROR_SUCCESS
                    : saveDatabase(owner.db, host.fullPath(owner.path));
            },
        },

        // ----- sessions -----
        ...both('MsiOpenPackage', 8, wide=>async([path, out])=>{
            const name = reader(wide)(path);
            if (name === null || (out >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const session = await openSession(name);
            if (typeof session === 'number')
            {
                return session;
            }
            writeU32(out, open('session', { session, deferred: null }));
            return ERROR_SUCCESS;
        }),
        ...both('MsiOpenPackageEx', 12, wide=>async([path, options, out])=>{
            void options;
            const name = reader(wide)(path);
            if (name === null || (out >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const session = await openSession(name);
            if (typeof session === 'number')
            {
                return session;
            }
            writeU32(out, open('session', { session, deferred: null }));
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetProperty', 16, wide=>([install, name, buffer, size])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const key = reader(wide)(name);
            if (key === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            return putString(wide, propertyOf(owner, key), buffer, size);
        }),
        ...both('MsiSetProperty', 12, wide=>([install, name, value])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const key = reader(wide)(name);
            if (key === null || key === '')
            {
                return ERROR_FUNCTION_FAILED;
            }
            if (owner.deferred !== null)
            {
                return ERROR_SUCCESS;
            }
            owner.session.setProperty(key, reader(wide)(value));
            return ERROR_SUCCESS;
        }),
        ...both('MsiEvaluateCondition', 8, wide=>([install, text])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return MSICONDITION.ERROR;
            }
            const condition = reader(wide)(text);
            return condition === null ? MSICONDITION.NONE : owner.session.evaluate(condition);
        }),
        ...both('MsiDoAction', 8, wide=>async([install, action])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const name = reader(wide)(action);
            if (name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const thread = host.callerThread();
            const engine = engineFor(owner.session, thread);
            return asCallOf(engine, thread, ()=>doAction(engine, name));
        }),
        ...both('MsiSequence', 12, wide=>async([install, table])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const thread = host.callerThread();
            const engine = engineFor(owner.session, thread);
            return asCallOf(engine, thread, ()=>runSequence(engine, reader(wide)(table) ?? ''));
        }),
        MsiGetMode: {
            argBytes: 8,
            handler: ([install, mode])=>{
                const owner = sessionOf(install);
                const name = /** @type {Record<number, string>} */ (RUN_MODES)[mode >>> 0];
                if (!owner || !name)
                {
                    return 0;
                }
                if (owner.deferred !== null && name === 'scheduled')
                {
                    return 1;
                }
                return /** @type {Record<string, boolean>} */ (owner.session.mode)[name] ? 1 : 0;
            },
        },
        MsiSetMode: {
            argBytes: 12,
            handler: ([install, mode, state])=>{
                const owner = sessionOf(install);
                const name = /** @type {Record<number, string>} */ (RUN_MODES)[mode >>> 0];
                if (!owner)
                {
                    return ERROR_INVALID_HANDLE;
                }
                if (name === 'rebootAtEnd' || name === 'rebootNow')
                {
                    /** @type {Record<string, boolean>} */ (owner.session.mode)[name] = state !== 0;
                    return ERROR_SUCCESS;
                }
                return ERROR_ACCESS_DENIED;
            },
        },
        MsiGetLanguage: {
            argBytes: 4,
            handler: ([install])=>{
                const owner = sessionOf(install);
                return owner ? Number(owner.session.getProperty('ProductLanguage')) || 0 : 0;
            },
        },
        ...both('MsiGetTargetPath', 16, wide=>([install, folder, buffer, size])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const key = reader(wide)(folder) ?? '';
            const target = owner.session.folders.get(key)?.target;
            if (!target)
            {
                return ERROR_DIRECTORY;
            }
            return putString(wide, target, buffer, size);
        }),
        ...both('MsiSetTargetPath', 12, wide=>([install, folder, path])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const key = reader(wide)(folder) ?? '';
            const target = reader(wide)(path);
            if (target === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            return owner.session.folders.has(key) && owner.session.setTargetPath(key, target)
                ? ERROR_SUCCESS : ERROR_DIRECTORY;
        }),
        ...both('MsiGetSourcePath', 16, wide=>([install, folder, buffer, size])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const key = reader(wide)(folder) ?? '';
            if (!owner.session.folders.has(key) && key !== 'SourceDir' && key !== 'SOURCEDIR')
            {
                return ERROR_DIRECTORY;
            }
            const source = owner.session.folders.has(key) ? owner.session.sourcePath(key)
                : owner.session.sourceDir;
            return putString(wide, source, buffer, size);
        }),
        ...both('MsiGetComponentState', 16, wide=>([install, name, installed, action])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const component = owner.session.components.get(reader(wide)(name) ?? '');
            if (!component)
            {
                return ERROR_UNKNOWN_COMPONENT;
            }
            if ((installed >>> 0) !== 0)
            {
                writeI32(installed, component.installed);
            }
            if ((action >>> 0) !== 0)
            {
                writeI32(action, component.action);
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiSetComponentState', 12, wide=>([install, name, state])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const component = owner.session.components.get(reader(wide)(name) ?? '');
            if (!component)
            {
                return ERROR_UNKNOWN_COMPONENT;
            }
            component.action = state | 0;
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetFeatureState', 16, wide=>([install, name, installed, action])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const feature = owner.session.features.get(reader(wide)(name) ?? '');
            if (!feature)
            {
                return ERROR_UNKNOWN_FEATURE;
            }
            if ((installed >>> 0) !== 0)
            {
                writeI32(installed, feature.installed);
            }
            if ((action >>> 0) !== 0)
            {
                writeI32(action, feature.action);
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiSetFeatureState', 12, wide=>([install, name, state])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const feature = owner.session.features.get(reader(wide)(name) ?? '');
            if (!feature)
            {
                return ERROR_UNKNOWN_FEATURE;
            }
            feature.request = state | 0;
            owner.session.settleStates();
            return ERROR_SUCCESS;
        }),
        ...both('MsiSetFeatureAttributes', 12, wide=>([install, name, attributes])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            const feature = owner.session.features.get(reader(wide)(name) ?? '');
            if (!feature)
            {
                return ERROR_UNKNOWN_FEATURE;
            }
            feature.attributes = attributes >>> 0;
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetFeatureCost', 20, wide=>([install, name, tree, state, cost])=>{
            void tree;
            void state;
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            if (!owner.session.features.has(reader(wide)(name) ?? ''))
            {
                return ERROR_UNKNOWN_FEATURE;
            }
            if ((cost >>> 0) !== 0)
            {
                writeU32(cost, 0);
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetFeatureValidStates', 12, wide=>([install, name, states])=>{
            const owner = sessionOf(install);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            if (!owner.session.features.has(reader(wide)(name) ?? ''))
            {
                return ERROR_UNKNOWN_FEATURE;
            }
            if ((states >>> 0) !== 0)
            {
                writeU32(states, (1 << INSTALLSTATE.LOCAL) | (1 << INSTALLSTATE.SOURCE)
                    | (1 << INSTALLSTATE.ABSENT));
            }
            return ERROR_SUCCESS;
        }),
        MsiSetInstallLevel: {
            argBytes: 8,
            handler: ([install, level])=>{
                const owner = sessionOf(install);
                if (!owner)
                {
                    return ERROR_INVALID_HANDLE;
                }
                owner.session.setProperty('INSTALLLEVEL', String(level | 0));
                owner.session.settleStates();
                return ERROR_SUCCESS;
            },
        },
        MsiVerifyDiskSpace: {
            argBytes: 4,
            handler: ([install])=>(sessionOf(install) ? ERROR_SUCCESS : ERROR_INVALID_HANDLE),
        },
        MsiProcessMessage: {
            argBytes: 12,
            handler: async([install, type, handle])=>{
                const owner = sessionOf(install);
                const record = recordOf(handle);
                if (!owner || !record)
                {
                    return -1;
                }
                return deliver(type >>> 0, record, owner.session);
            },
        },

        // ----- installing and what is installed -----
        MsiSetInternalUI: {
            argBytes: 8,
            handler: ([level])=>{
                const previous = uiLevel;
                if ((level >>> 0) !== INSTALLUILEVEL.NOCHANGE)
                {
                    uiLevel = (level >>> 0) === INSTALLUILEVEL.DEFAULT ? INSTALLUILEVEL.BASIC
                        : level >>> 0;
                }
                return previous;
            },
        },
        ...both('MsiSetExternalUI', 12, wide=>([handler, filter, context])=>{
            const previous = externalUi?.handler ?? 0;
            externalUi = (handler >>> 0) === 0 ? null
                : { handler: handler >>> 0, filter: filter >>> 0, context: context >>> 0, wide };
            return previous;
        }),
        MsiSetExternalUIRecord: {
            argBytes: 16,
            handler: ([handler, filter, context, previous])=>{
                if ((previous >>> 0) !== 0)
                {
                    writeU32(previous, recordUi?.handler ?? 0);
                }
                recordUi = (handler >>> 0) === 0 ? null
                    : { handler: handler >>> 0, filter: filter >>> 0, context: context >>> 0 };
                return ERROR_SUCCESS;
            },
        },
        ...both('MsiEnableLog', 12, ()=>()=>ERROR_SUCCESS),
        ...both('MsiInstallProduct', 8, wide=>async([path, commandLine])=>{
            const name = reader(wide)(path);
            if (name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            return installPackage(name, reader(wide)(commandLine) ?? '');
        }),
        ...both('MsiConfigureProduct', 12, wide=>async([product, level, state])=>
            configureProduct(reader(wide)(product), level, state, '')),
        ...both('MsiConfigureProductEx', 16, wide=>async([product, level, state, commandLine])=>
            configureProduct(reader(wide)(product), level, state,
                reader(wide)(commandLine) ?? '')),
        ...both('MsiConfigureFeature', 12, wide=>async([product, feature, state])=>{
            const name = reader(wide)(feature);
            const request = name === null ? null : FEATURE_REQUESTS.get(state | 0);
            if (request === undefined || name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            return maintain(reader(wide)(product), `${request}=${quoted(name)}`);
        }),
        ...both('MsiReinstallProduct', 8, wide=>async([product, mode])=>
            maintain(reader(wide)(product), `REINSTALL=ALL REINSTALLMODE=${reinstallMode(mode)}`)),
        ...both('MsiReinstallFeature', 12, wide=>async([product, feature, mode])=>{
            const name = reader(wide)(feature);
            if (name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            return maintain(reader(wide)(product),
                `REINSTALL=${quoted(name)} REINSTALLMODE=${reinstallMode(mode)}`);
        }),
        ...both('MsiOpenProduct', 8, wide=>async([product, out])=>{
            const code = reader(wide)(product);
            if (code === null || (out >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const local = localPackage(code);
            if (typeof local === 'number')
            {
                return local;
            }
            const session = await openSession(local);
            if (typeof session === 'number')
            {
                return session;
            }
            writeU32(out, open('session', { session, deferred: null }));
            return ERROR_SUCCESS;
        }),
        ...both('MsiDatabaseApplyTransform', 12, wide=>async([database, transform, conditions])=>{
            const opened = get(database, 'database');
            const name = reader(wide)(transform);
            if (!opened)
            {
                return ERROR_INVALID_HANDLE;
            }
            if (name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            return withFiles(openFile=>applyTransform(opened.db, name, conditions | 0, openFile,
                host.log));
        }),
        ...both('MsiDatabaseGenerateTransform', 20, wide=>async([database, reference, file])=>{
            const opened = get(database, 'database');
            const base = get(reference, 'database');
            if (!opened || !base)
            {
                return ERROR_INVALID_HANDLE;
            }
            const { code, bytes } = await generateTransform(opened.db, base.db);
            if (code !== ERROR_SUCCESS)
            {
                return code;
            }
            const name = reader(wide)(file);
            // With no file named, the call answers only whether the two differ.
            if (name === null || bytes === null)
            {
                return ERROR_SUCCESS;
            }
            return writeFile(host.files, host.fullPath(name), bytes) ? ERROR_SUCCESS
                : ERROR_CREATE_FAILED;
        }),
        ...both('MsiDatabaseExport', 16, wide=>async([database, table, folder, file])=>{
            const opened = get(database, 'database');
            if (!opened)
            {
                return ERROR_INVALID_HANDLE;
            }
            const read = reader(wide);
            const name = read(table);
            const directory = read(folder);
            const target = read(file);
            if (name === null || directory === null || target === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!host.files.stat(host.fullPath(directory))?.isDirectory)
            {
                return ERROR_BAD_PATHNAME;
            }
            /** @param {string} path */
            const at = path=>host.fullPath(`${directory.replace(/[\\/]+$/, '')}\\${path}`);
            const made = await exportTable(opened.db, name);
            if (made.code !== ERROR_SUCCESS)
            {
                return made.code;
            }
            for (const stream of made.streams)
            {
                const folderOf = at(stream.path.slice(0, stream.path.lastIndexOf('\\')));
                if (!host.files.stat(folderOf)?.isDirectory)
                {
                    host.files.mkdir(folderOf);
                }
                if (!writeFile(host.files, at(stream.path), stream.bytes))
                {
                    return ERROR_FUNCTION_FAILED;
                }
            }
            return writeFile(host.files, at(target), made.bytes) ? ERROR_SUCCESS
                : ERROR_FUNCTION_FAILED;
        }),
        ...both('MsiDatabaseImport', 12, wide=>async([database, folder, file])=>{
            const opened = get(database, 'database');
            if (!opened)
            {
                return ERROR_INVALID_HANDLE;
            }
            const directory = reader(wide)(folder);
            const name = reader(wide)(file);
            if (directory === null || name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!host.files.stat(host.fullPath(directory))?.isDirectory)
            {
                return ERROR_BAD_PATHNAME;
            }
            /** @param {string} path */
            const at = path=>host.fullPath(`${directory.replace(/[\\/]+$/, '')}\\${path}`);
            const bytes = await readFile(host.files, at(name));
            if (!bytes)
            {
                return ERROR_FUNCTION_FAILED;
            }
            const streams = streamFolder(name);
            return importTable(opened.db, bytes, stream=>(streams === null ? null
                : readFile(host.files, at(`${streams}\\${stream}`))));
        }),
        ...both('MsiDatabaseMerge', 12, wide=>async([database, merge, table])=>{
            const opened = get(database, 'database');
            const other = get(merge, 'database');
            if (!opened || !other)
            {
                return ERROR_INVALID_HANDLE;
            }
            return mergeDatabases(opened.db, other.db, reader(wide)(table));
        }),
        ...both('MsiCreateTransformSummaryInfo', 20, wide=>async([database, reference, file,
            conditions, validation])=>{
            const opened = get(database, 'database');
            const base = get(reference, 'database');
            const name = reader(wide)(file);
            if (!opened || !base)
            {
                return ERROR_INVALID_HANDLE;
            }
            if (name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const bytes = await readFile(host.files, host.fullPath(name));
            if (!bytes)
            {
                return ERROR_OPEN_FAILED;
            }
            const made = createTransformSummary(bytes, opened.db, base.db, conditions | 0,
                validation | 0);
            if (made.code !== ERROR_SUCCESS || !made.bytes)
            {
                return made.code;
            }
            return writeFile(host.files, host.fullPath(name), made.bytes) ? ERROR_SUCCESS
                : ERROR_CREATE_FAILED;
        }),
        ...both('MsiQueryProductState', 4, wide=>([product])=>
            registration.productState(reader(wide)(product) ?? '')),
        ...both('MsiGetProductInfo', 16, wide=>([product, property, buffer, size])=>{
            const code = reader(wide)(product);
            const name = reader(wide)(property);
            if (code === null || name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const answer = registration.productInfo(code, name);
            return 'error' in answer ? answer.error : putString(wide, answer.value, buffer, size);
        }),
        ...both('MsiEnumProducts', 8, wide=>([index, buffer])=>{
            const products = registration.products();
            if ((index >>> 0) >= products.length)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            const text = `${products[index >>> 0]}\0`;
            host.writeMemory(buffer >>> 0, wide ? utf16(text) : encodeAnsi(text));
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetComponentPath', 16, wide=>([product, component, buffer, size])=>{
            const path = registration.componentPath(reader(wide)(product) ?? '',
                reader(wide)(component) ?? '');
            if (path === null)
            {
                return INSTALLSTATE.UNKNOWN;
            }
            putString(wide, path, buffer, size);
            return host.files.stat(path)?.exists || path === '' ? INSTALLSTATE.LOCAL
                : INSTALLSTATE.ABSENT;
        }),
        ...both('MsiLocateComponent', 12, wide=>([component, buffer, size])=>{
            const id = reader(wide)(component) ?? '';
            for (const product of registration.products())
            {
                const path = registration.componentPath(product, id);
                if (path !== null)
                {
                    putString(wide, path, buffer, size);
                    return host.files.stat(path)?.exists ? INSTALLSTATE.LOCAL : INSTALLSTATE.ABSENT;
                }
            }
            return INSTALLSTATE.UNKNOWN;
        }),
        ...both('MsiQueryFeatureState', 8, wide=>([product, feature])=>{
            const code = reader(wide)(product) ?? '';
            if (registration.productState(code) === INSTALLSTATE.UNKNOWN)
            {
                return INSTALLSTATE.UNKNOWN;
            }
            return registration.featureInstalled(code, reader(wide)(feature) ?? '')
                ? INSTALLSTATE.LOCAL : INSTALLSTATE.UNKNOWN;
        }),
        ...both('MsiGetFileVersion', 20, wide=>async([path, version, versionSize, language,
            languageSize])=>{
            const name = reader(wide)(path);
            if (name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const full = host.fullPath(name);
            if (!host.files.stat(full)?.exists)
            {
                return ERROR_FILE_NOT_FOUND;
            }
            const block = await host.versionInfo?.(full) ?? null;
            const fixed = block ? fixedInfo(block) : null;
            if (!fixed)
            {
                return ERROR_FILE_INVALID;
            }
            const text = `${fixed.ms >>> 16}.${fixed.ms & 0xffff}.${fixed.ls >>> 16}.`
                + `${fixed.ls & 0xffff}`;
            const first = putString(wide, text, version, versionSize);
            const second = putString(wide, String(fixed.language), language, languageSize);
            return first !== ERROR_SUCCESS ? first : second;
        }),
        DllGetVersion: {
            argBytes: 4,
            handler: ([info])=>{
                if ((info >>> 0) === 0)
                {
                    return 0x80070057 | 0;
                }
                const [major, minor, build] = installerVersion(host.machine().windows);
                writeU32(info + 4, major);
                writeU32(info + 8, minor);
                writeU32(info + 12, build);
                writeU32(info + 16, 2);
                return 0;
            },
        },
    };
}

/**
 * VS_FIXEDFILEINFO's version and the first translation's language, out of
 * a version block.
 *
 * @param {Uint8Array} block
 * @returns {{ ms: number, ls: number, language: number } | null}
 */
function fixedInfo(block){
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let at = 0; at + 52 <= block.length; at += 4)
    {
        if (view.getUint32(at, true) === 0xfeef04bd)
        {
            const translation = findTranslation(block);
            return { ms: view.getUint32(at + 8, true), ls: view.getUint32(at + 12, true),
                language: translation };
        }
    }
    return null;
}

/** @param {Uint8Array} block */
function findTranslation(block){
    const key = 'Translation';
    for (let at = 0; at + key.length * 2 + 8 < block.length; at += 2)
    {
        let match = true;
        for (let index = 0; index < key.length && match; index++)
        {
            match = block[at + index * 2] === key.charCodeAt(index)
                && block[at + index * 2 + 1] === 0;
        }
        if (match)
        {
            const value = (at + key.length * 2 + 2 + 3) & ~3;
            return block[value] | block[value + 1] << 8;
        }
    }
    return 0;
}
