/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What every standard action is made of: telling the interface what is
 * happening, putting work into the script or doing it now, reading and
 * writing the volume, and finding where a Registry row's key lives. The
 * actions that install and the ones that remove share them, so a step means
 * the same whichever way an installation runs.
 */

import { INSTALLSTATE, normalize } from './session.js';
import { createRecord } from './record.js';
import {
    HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS, REG_BINARY, REG_DWORD,
    REG_EXPAND_SZ, REG_MULTI_SZ, REG_SZ,
} from '../advapi32/registry.js';
import { encodeAnsi } from '../kernel32/locale.js';

/** @typedef {import('./engine.js').Engine} Engine */

export const ERROR_SUCCESS = 0;
export const ERROR_FUNCTION_NOT_CALLED = 1626;
export const ERROR_INSTALL_USEREXIT = 1602;
export const ERROR_INSTALL_FAILURE = 1603;
export const ERROR_INSTALL_SUSPEND = 1604;
export const ERROR_NO_MORE_ITEMS = 259;
export const ERROR_INVALID_HANDLE_STATE = 1609;

/** INSTALLMESSAGE types, in the top byte of a message's type. */
export const INSTALLMESSAGE = Object.freeze({
    FATALEXIT: 0x00000000, ERROR: 0x01000000, WARNING: 0x02000000, USER: 0x03000000,
    INFO: 0x04000000, FILESINUSE: 0x05000000, RESOLVESOURCE: 0x06000000,
    OUTOFDISKSPACE: 0x07000000, ACTIONSTART: 0x08000000, ACTIONDATA: 0x09000000,
    PROGRESS: 0x0a000000, COMMONDATA: 0x0b000000, INITIALIZE: 0x0c000000,
    TERMINATE: 0x0d000000, SHOWDIALOG: 0x0e000000,
});

/** @param {Engine} engine @param {string} text */
export const log = (engine, text)=>engine.host.log?.(text);

/**
 * Sends a message to the user interface.
 *
 * @param {Engine} engine @param {number} type @param {(string | number | null)[]} fields
 */
export async function message(engine, type, fields){
    const record = createRecord(Math.max(0, fields.length - 1));
    fields.forEach((value, index)=>{
        record.fields[index] = value;
    });
    return engine.host.message(type, record);
}

/**
 * The action's start, as ActionText describes it, told to the interface.
 *
 * @param {Engine} engine @param {string} action
 */
export async function actionStart(engine, action){
    const row = engine.session.db.table('ActionText')?.rows.find(entry=>entry[0] === action);
    // The log's own "Action time: name." line is the message's, written there
    // as the interface is told.
    return message(engine, INSTALLMESSAGE.ACTIONSTART,
        [null, action, row?.[1] ?? null, row?.[2] ?? null]);
}

/**
 * The action's end in the log, as Windows writes it: the return value 1 for
 * success, 2 for a user's exit, 3 for a failure, 4 for a suspension, 0 for an
 * action not called. A failed installation's log names the action that failed
 * by this line and no other.
 *
 * @param {Engine} engine @param {string} action @param {number} code
 */
export function actionEnded(engine, action, code){
    const now = new Date();
    const two = (/** @type {number} */ value)=>String(value).padStart(2, '0');
    const time = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
    const value = { [ERROR_SUCCESS]: 1, [ERROR_NO_MORE_ITEMS]: 1, [ERROR_INSTALL_USEREXIT]: 2,
        [ERROR_INSTALL_FAILURE]: 3, [ERROR_INSTALL_SUSPEND]: 4,
        [ERROR_FUNCTION_NOT_CALLED]: 0 }[code] ?? 3;
    log(engine, `Action ended ${time}: ${action}. Return value ${value}.`);
}

/**
 * An error from the Error table, its fields formatted in.
 *
 * @param {Engine} engine @param {number} code @param {(string | number | null)[]} fields
 */
export async function errorMessage(engine, code, fields){
    const row = engine.session.db.table('Error')?.rows.find(entry=>entry[0] === code);
    return message(engine, INSTALLMESSAGE.ERROR, [row?.[1] ?? null, code, ...fields]);
}

/**
 * What a piece of the installation counts for on the progress bar: a file
 * its size in bytes, a registry value and a component a fixed amount each.
 * Windows documents the messages, not the amounts (roadmap/decisions.md, A33).
 */
export const REGISTRY_TICKS = 13200;
export const COMPONENT_TICKS = 24000;

/** INSTALLMESSAGE_PROGRESS's first field: what the message does to the bar. */
export const PROGRESS_RESET = 0;
const PROGRESS_REPORT = 2;

/**
 * The bar moved on by so many ticks.
 *
 * @param {Engine} engine @param {number} ticks
 */
export const progressed = (engine, ticks)=>
    message(engine, INSTALLMESSAGE.PROGRESS, [null, PROGRESS_REPORT, ticks, 0, 0]);

/**
 * What an action is doing now, as its ActionText template words it.
 *
 * @param {Engine} engine @param {string} action @param {(string | number | null)[]} fields
 *     From the first.
 */
export const actionData = (engine, action, fields)=>{
    const row = engine.session.db.table('ActionText')?.rows.find(entry=>entry[0] === action);
    return message(engine, INSTALLMESSAGE.ACTIONDATA,
        [row?.[2] === null || row?.[2] === undefined ? null : String(row[2]), ...fields]);
};

/**
 * Puts work into the script when one is being written, or does it now.
 *
 * @param {Engine} engine @param {string} name @param {() => Promise<number | void>} run
 */
export async function schedule(engine, name, run){
    if (engine.session.mode.scheduled)
    {
        engine.session.script.push({ name, run: async()=>(await run()) ?? ERROR_SUCCESS });
        return ERROR_SUCCESS;
    }
    return (await run()) ?? ERROR_SUCCESS;
}

/**
 * Makes a directory and every one above it that is missing.
 *
 * @param {any} files @param {string} path
 */
export function makeDirectories(files, path){
    const parts = normalize(path).replace(/\\$/, '').split('\\');
    for (let depth = 1; depth <= parts.length; depth++)
    {
        const partial = parts.slice(0, depth).join('\\');
        if (depth === 1 && /^[A-Za-z]:$/.test(partial))
        {
            continue;
        }
        if (!files.stat(partial)?.isDirectory)
        {
            files.mkdir(partial);
        }
    }
}

/**
 * Opens a file for writing, its directory made first; the file is replaced.
 *
 * @param {any} files @param {string} path
 */
export function create(files, path){
    makeDirectories(files, path.slice(0, path.lastIndexOf('\\') + 1));
    return files.open(path, { read: false, write: true, create: true, truncate: true });
}

/**
 * Reads a whole file off the volume.
 *
 * @param {any} files @param {string} path @returns {Promise<Uint8Array | null>}
 */
export async function readFile(files, path){
    const stat = files.stat(path);
    if (!stat || stat.isDirectory)
    {
        return null;
    }
    const node = files.open(path, { read: true });
    if (!node)
    {
        return null;
    }
    try
    {
        return await files.read(node, 0, stat.size);
    }
    finally
    {
        files.close(node);
    }
}

/**
 * Writes a whole file, replacing it.
 *
 * @param {any} files @param {string} path @param {Uint8Array} bytes
 */
export function writeFile(files, path, bytes){
    const node = create(files, path);
    if (!node)
    {
        return false;
    }
    files.write(node, 0, bytes);
    files.close(node);
    return true;
}

/** @param {Engine} engine @param {string} key */
export const componentOf = (engine, key)=>engine.session.components.get(key) ?? null;

/** @param {Engine} engine @param {string} key whether the component is being installed */
export const installing = (engine, key)=>{
    const component = componentOf(engine, key);
    return Boolean(component && (component.action === INSTALLSTATE.LOCAL
        || component.action === INSTALLSTATE.SOURCE));
};

/**
 * A Registry row's root: its own, or for -1 the machine's when the
 * installation is for everyone and the user's when it is not.
 *
 * @param {Engine} engine @param {number} root
 */
export function registryRoot(engine, root){
    const roots = [HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS];
    const id = root === -1
        ? (engine.session.getProperty('ALLUSERS') !== '' ? HKEY_LOCAL_MACHINE : HKEY_CURRENT_USER)
        : roots[root];
    return id === undefined ? null : engine.host.hive.root(id);
}

/**
 * A Registry row's value, formatted and typed as its prefix says: #x binary
 * in hex, #% an expandable string, # a number, ## a string beginning with
 * #, and a value holding NULs from [~] several strings.
 *
 * @param {string} value @returns {{ type: number, data: Uint8Array }}
 */
export function registryValue(value){
    if (value.startsWith('#x') || value.startsWith('#X'))
    {
        const hex = value.slice(2).replace(/[^0-9A-Fa-f]/g, '');
        const padded = hex.length % 2 === 1 ? `0${hex}` : hex;
        return { type: REG_BINARY,
            data: Uint8Array.from(padded.match(/../g) ?? [], pair=>parseInt(pair, 16)) };
    }
    if (value.startsWith('#%'))
    {
        return { type: REG_EXPAND_SZ, data: encodeAnsi(`${value.slice(2)}\0`) };
    }
    if (value.startsWith('##'))
    {
        return { type: REG_SZ, data: encodeAnsi(`${value.slice(1)}\0`) };
    }
    if (value.startsWith('#'))
    {
        const number = Number.parseInt(value.slice(1), 10);
        return { type: REG_DWORD,
            data: new Uint8Array(Uint32Array.of(Number.isNaN(number) ? 0 : number >>> 0).buffer) };
    }
    if (value.includes('\0'))
    {
        const strings = value.split('\0').filter(part=>part !== '');
        return { type: REG_MULTI_SZ, data: encodeAnsi(`${strings.join('\0')}\0\0`) };
    }
    return { type: REG_SZ, data: encodeAnsi(`${value}\0`) };
}


/**
 * Whether a component's resources are being taken off the machine: it is
 * being removed, and no other product has it -- a shared component's files,
 * values and registrations stay for the product that still uses them.
 *
 * @param {Engine} engine @param {string} key
 */
export const removing = (engine, key)=>{
    const component = componentOf(engine, key);
    return component?.action === INSTALLSTATE.ABSENT && !component.shared;
};
