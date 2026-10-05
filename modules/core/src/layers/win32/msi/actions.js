/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sequences and the standard actions.
 *
 * A sequence table lists actions by number, each with a condition; they run
 * in order, and an action's answer decides whether the next one does. The
 * standard actions are the installer's own: costing works out where things
 * go, the rest put them there. Between InstallInitialize and InstallFinalize
 * an action does not change the machine itself but writes what it will do
 * into the script, which InstallFinalize runs -- the files a custom action
 * scheduled after InstallFiles would look for are not there until then, on
 * Windows as here.
 *
 * Nothing is rolled back: an installation that fails leaves what it did,
 * which is what a machine without the installer's rollback would show.
 */

import { MSICONDITION } from './condition.js';
import { INSTALLSTATE, normalize } from './session.js';
import { createRecord } from './record.js';
import { extractCabinet } from '../cabinet/stream.js';
import {
    HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS, REG_BINARY, REG_DWORD,
    REG_EXPAND_SZ, REG_MULTI_SZ, REG_SZ,
} from '../advapi32/registry.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { runCustomAction } from './custom.js';
import { PID } from './summary.js';

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

/** A File row's attributes that change how it is installed. */
const FILE_READONLY = 0x1;
const FILE_HIDDEN = 0x2;
const FILE_SYSTEM = 0x4;
const FILE_NONCOMPRESSED = 0x2000;
const FILE_COMPRESSED = 0x4000;
/** A component that never replaces a file already there. */
const COMPONENT_NEVER_OVERWRITE = 0x80;
/** A component whose key path is a registry value, not a file. */
const COMPONENT_REGISTRY_KEY_PATH = 0x4;

/** @typedef {import('./engine.js').Engine} Engine */

/** @param {Engine} engine @param {string} text */
const log = (engine, text)=>engine.host.log?.(text);

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
async function actionStart(engine, action){
    const row = engine.session.db.table('ActionText')?.rows.find(entry=>entry[0] === action);
    const now = new Date();
    const two = (/** @type {number} */ value)=>String(value).padStart(2, '0');
    const time = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
    log(engine, `Action ${time}: ${action}.`);
    return message(engine, INSTALLMESSAGE.ACTIONSTART,
        [null, action, row?.[1] ?? null, row?.[2] ?? null]);
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
 * Runs a sequence table: every action with a positive number, in order,
 * whose condition holds; then the one numbered for how it ended.
 *
 * @param {Engine} engine @param {string} table
 * @returns {Promise<number>}
 */
export async function runSequence(engine, table){
    const rows = [...engine.session.db.table(table)?.rows ?? []]
        .filter(row=>row[0] !== null)
        .sort((left, right)=>Number(left[2] ?? 0) - Number(right[2] ?? 0));
    /** @param {number} number */
    const terminal = async number=>{
        for (const row of rows.filter(entry=>Number(entry[2]) === number))
        {
            if (row[1] === null || engine.session.evaluate(String(row[1])) !== MSICONDITION.FALSE)
            {
                await doAction(engine, String(row[0]));
            }
        }
    };
    for (const row of rows)
    {
        if (Number(row[2] ?? 0) <= 0)
        {
            continue;
        }
        if (row[1] !== null && engine.session.evaluate(String(row[1])) === MSICONDITION.FALSE)
        {
            continue;
        }
        const code = await doAction(engine, String(row[0]));
        if (code === ERROR_SUCCESS || code === ERROR_FUNCTION_NOT_CALLED)
        {
            continue;
        }
        if (code === ERROR_NO_MORE_ITEMS)
        {
            // The rest of the sequence is skipped, and that is success.
            break;
        }
        if (code === ERROR_INSTALL_USEREXIT)
        {
            await terminal(-2);
            return code;
        }
        if (code === ERROR_INSTALL_SUSPEND)
        {
            await terminal(-4);
            return code;
        }
        await terminal(-3);
        return ERROR_INSTALL_FAILURE;
    }
    await terminal(-1);
    return ERROR_SUCCESS;
}

/**
 * One action by name: a standard action, a custom action, or a dialog.
 *
 * @param {Engine} engine @param {string} action
 * @returns {Promise<number>}
 */
export async function doAction(engine, action){
    const standard = STANDARD_ACTIONS[action];
    if (standard)
    {
        await actionStart(engine, action);
        return standard(engine);
    }
    const custom = engine.session.db.table('CustomAction')?.rows.find(row=>row[0] === action);
    if (custom)
    {
        await actionStart(engine, action);
        return runCustomAction(engine, {
            action, type: Number(custom[1] ?? 0),
            source: custom[2] === null ? null : String(custom[2]),
            target: custom[3] === null ? null : String(custom[3]),
        });
    }
    if (engine.session.db.table('Dialog')?.rows.some(row=>row[0] === action))
    {
        // The package's own dialogs are drawn by the full user interface,
        // which a setup driving its own does not ask for.
        log(engine, `Dialog ${action} not shown: no internal user interface.`);
        return ERROR_SUCCESS;
    }
    log(engine, `Action ${action} not found.`);
    return ERROR_FUNCTION_NOT_CALLED;
}

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

/** Runs the script written so far, and empties it. @param {Engine} engine */
async function runScript(engine){
    const { session } = engine;
    while (session.script.length > 0)
    {
        const step = /** @type {{ name: string, run: () => Promise<number> }} */ (
            session.script.shift());
        const code = await step.run();
        if (code !== ERROR_SUCCESS)
        {
            session.script.length = 0;
            return code;
        }
    }
    return ERROR_SUCCESS;
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
function create(files, path){
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
const componentOf = (engine, key)=>engine.session.components.get(key) ?? null;

/** @param {Engine} engine @param {string} key whether the component is being installed */
const installing = (engine, key)=>{
    const component = componentOf(engine, key);
    return Boolean(component && (component.action === INSTALLSTATE.LOCAL
        || component.action === INSTALLSTATE.SOURCE));
};

/**
 * The files to install and where they come from: each component installing
 * locally, its files by sequence, each in the Media row whose range holds it.
 *
 * @param {Engine} engine
 */
async function installFiles(engine){
    const { session } = engine;
    const wordCount = Number(session.summary.get(PID.WORDCOUNT)?.value ?? 0);
    const compressedByDefault = (wordCount & 2) !== 0;
    const shortSourceNames = (wordCount & 1) !== 0;
    const wanted = [...session.files.values()]
        .filter(file=>file.target !== null && componentOf(engine, file.component)?.action
            === INSTALLSTATE.LOCAL)
        .filter(file=>{
            const component = componentOf(engine, file.component);
            return !((Number(component?.attributes ?? 0) & COMPONENT_NEVER_OVERWRITE) !== 0
                && session.machine && engine.host.files.stat(file.target)?.exists);
        });
    if (wanted.length === 0)
    {
        return ERROR_SUCCESS;
    }
    const media = [...session.db.table('Media')?.rows ?? []]
        .sort((left, right)=>Number(left[0]) - Number(right[0]));
    const files = engine.host.files;
    /** @param {import('./session.js').PackageFile} file */
    const setAttributes = file=>{
        const attributes = file.attributes & (FILE_READONLY | FILE_HIDDEN | FILE_SYSTEM);
        if (attributes !== 0 && file.target)
        {
            files.setAttributes(file.target, attributes);
        }
    };
    let previous = 0;
    for (const row of media)
    {
        const last = Number(row[1] ?? 0);
        const inRange = wanted.filter(file=>file.sequence > previous && file.sequence <= last);
        previous = last;
        if (inRange.length === 0)
        {
            continue;
        }
        const compressed = inRange.filter(file=>(file.attributes & FILE_COMPRESSED) !== 0
            || (compressedByDefault && (file.attributes & FILE_NONCOMPRESSED) === 0));
        const loose = inRange.filter(file=>!compressed.includes(file));
        for (const file of loose)
        {
            const component = /** @type {import('./session.js').Component} */ (
                componentOf(engine, file.component));
            const source = `${session.sourcePath(component.directory)}`
                + `${shortSourceNames ? file.shortName : file.name}`;
            const bytes = await readFile(files, source);
            if (!bytes)
            {
                await errorMessage(engine, 1308, [source]);
                return ERROR_INSTALL_FAILURE;
            }
            writeFile(files, /** @type {string} */ (file.target), bytes);
            setAttributes(file);
        }
        if (compressed.length === 0)
        {
            continue;
        }
        const cabinet = row[3] === null ? '' : String(row[3]);
        /** @type {import('../cabinet/stream.js').ByteSource | null} */
        let source = null;
        /** @type {any} */
        let opened = null;
        if (cabinet.startsWith('#'))
        {
            const name = cabinet.slice(1);
            const size = session.db.streamSize(name);
            if (size !== null)
            {
                source = { size, read: async(offset, length)=>
                    (await session.db.readStreamRange(name, offset, length)) ?? new Uint8Array(0) };
            }
        }
        else if (cabinet !== '')
        {
            const directory = row[5] === null ? session.getProperty('SourceDir')
                : session.sourcePath(String(row[5]));
            const path = `${directory || session.sourceDir}${session.formatText(cabinet)}`;
            const stat = files.stat(path);
            opened = stat && !stat.isDirectory ? files.open(path, { read: true }) : null;
            if (opened)
            {
                const node = opened;
                source = { size: stat.size,
                    read: (offset, length)=>files.read(node, offset, length) };
            }
        }
        if (!source)
        {
            await errorMessage(engine, 1311, [cabinet]);
            return ERROR_INSTALL_FAILURE;
        }
        const byKey = new Map(compressed.map(file=>[file.key, file]));
        /** @type {Set<string>} */
        const done = new Set();
        const extracting = extractCabinet(source, entry=>{
            const file = byKey.get(entry.name);
            if (!file || !file.target || done.has(file.key))
            {
                return null;
            }
            done.add(file.key);
            const node = create(files, file.target);
            if (!node)
            {
                return null;
            }
            return {
                write: (offset, bytes)=>{
                    files.write(node, offset, bytes);
                },
                close: ()=>{
                    files.close(node);
                    setAttributes(file);
                },
            };
        }, { eager: true });
        try
        {
            await extracting;
        }
        finally
        {
            if (opened)
            {
                files.close(opened);
            }
        }
        const missing = compressed.filter(file=>!done.has(file.key));
        if (missing.length > 0)
        {
            await errorMessage(engine, 1334, [missing[0].key, cabinet]);
            return ERROR_INSTALL_FAILURE;
        }
    }
    return ERROR_SUCCESS;
}

/**
 * A Registry row's root: its own, or for -1 the machine's when the
 * installation is for everyone and the user's when it is not.
 *
 * @param {Engine} engine @param {number} root
 */
function registryRoot(engine, root){
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

/** @param {Engine} engine */
async function writeRegistryValues(engine){
    const { session, host } = engine;
    for (const row of session.db.table('Registry')?.rows ?? [])
    {
        if (!installing(engine, String(row[5])))
        {
            continue;
        }
        const root = registryRoot(engine, Number(row[1] ?? -2));
        if (!root)
        {
            continue;
        }
        const keyPath = session.formatText(String(row[2] ?? ''));
        const name = row[3] === null ? null : session.formatText(String(row[3]));
        const raw = row[4] === null ? null : String(row[4]);
        await schedule(engine, 'WriteRegistryValues', async()=>{
            const key = host.hive.create(root, keyPath).key;
            if (raw === null && (name === null || name === '+' || name === '*' || name === '-'))
            {
                return;
            }
            const { type, data } = registryValue(session.formatText(raw ?? ''));
            host.hive.setValue(key, name ?? '', type, data);
        });
    }
    return ERROR_SUCCESS;
}

/**
 * An INI file with one key set: the section made if missing, the key
 * replaced where it is or added at the section's end.
 *
 * @param {string} text @param {string} section @param {string} key @param {string} value
 */
export function setIniValue(text, section, key, value){
    const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const wanted = `[${section.toLowerCase()}]`;
    const header = lines.findIndex(line=>line.trim().toLowerCase() === wanted);
    if (header < 0)
    {
        lines.push(`[${section}]`, `${key}=${value}`);
        return `${lines.join('\r\n')}\r\n`;
    }
    let end = header + 1;
    while (end < lines.length && !lines[end].trim().startsWith('['))
    {
        end++;
    }
    for (let at = header + 1; at < end; at++)
    {
        const equals = lines[at].indexOf('=');
        if (equals > 0 && lines[at].slice(0, equals).trim().toLowerCase() === key.toLowerCase())
        {
            lines[at] = `${key}=${value}`;
            return `${lines.join('\r\n')}\r\n`;
        }
    }
    lines.splice(end, 0, `${key}=${value}`);
    return `${lines.join('\r\n')}\r\n`;
}

/** @param {Engine} engine */
async function writeIniValues(engine){
    const { session, host } = engine;
    for (const row of session.db.table('IniFile')?.rows ?? [])
    {
        if (!installing(engine, String(row[7])))
        {
            continue;
        }
        const directory = row[2] === null ? session.getProperty('WindowsFolder')
            : session.folders.get(String(row[2]))?.target ?? session.getProperty(String(row[2]));
        const name = String(row[1] ?? '').split('|').pop() ?? '';
        const path = `${normalize(directory)}${name}`;
        const section = session.formatText(String(row[3] ?? ''));
        const key = session.formatText(String(row[4] ?? ''));
        const value = session.formatText(String(row[5] ?? ''));
        await schedule(engine, 'WriteIniValues', async()=>{
            const bytes = await readFile(host.files, path);
            const text = bytes ? new TextDecoder('latin1').decode(bytes) : '';
            writeFile(host.files, path, encodeAnsi(setIniValue(text, section, key, value)));
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function createFolders(engine){
    const { session, host } = engine;
    for (const row of session.db.table('CreateFolder')?.rows ?? [])
    {
        if (!installing(engine, String(row[1])))
        {
            continue;
        }
        const target = session.folders.get(String(row[0]))?.target;
        if (target)
        {
            await schedule(engine, 'CreateFolders', async()=>{
                makeDirectories(host.files, target);
            });
        }
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function duplicateFiles(engine){
    const { session, host } = engine;
    for (const row of session.db.table('DuplicateFile')?.rows ?? [])
    {
        if (!installing(engine, String(row[1])))
        {
            continue;
        }
        const file = session.files.get(String(row[2]));
        if (!file?.target)
        {
            continue;
        }
        const directory = row[4] === null ? file.target.slice(0, file.target.lastIndexOf('\\') + 1)
            : session.folders.get(String(row[4]))?.target ?? session.getProperty(String(row[4]));
        const name = row[3] === null ? file.name : String(row[3]).split('|').pop() ?? file.name;
        const from = file.target;
        await schedule(engine, 'DuplicateFiles', async()=>{
            const bytes = await readFile(host.files, from);
            if (bytes)
            {
                writeFile(host.files, `${normalize(directory)}${name}`, bytes);
            }
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function createShortcuts(engine){
    const { session, host } = engine;
    for (const row of session.db.table('Shortcut')?.rows ?? [])
    {
        if (!installing(engine, String(row[3])))
        {
            continue;
        }
        const directory = session.folders.get(String(row[1]))?.target;
        if (!directory)
        {
            continue;
        }
        const name = `${String(row[2] ?? '').split('|').pop()}.lnk`;
        await schedule(engine, 'CreateShortcuts', async()=>{
            // As shell32's link object saves one: a file at the path, with no
            // contents nobody on this machine reads.
            writeFile(host.files, `${directory}${name}`, new Uint8Array(0));
        });
    }
    host.divergence?.('CreateShortcuts', 'a shortcut is an empty file at its path');
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function writeEnvironmentStrings(engine){
    const { session, host } = engine;
    for (const row of session.db.table('Environment')?.rows ?? [])
    {
        if (!installing(engine, String(row[3])))
        {
            continue;
        }
        let name = String(row[1] ?? '');
        const machine = name.includes('*');
        name = name.replace(/^[=+\-!*]+/, '');
        const value = session.formatText(String(row[2] ?? '')).replace(/\[~\]|\0/g, '');
        await schedule(engine, 'WriteEnvironmentStrings', async()=>{
            const root = host.hive.root(machine ? HKEY_LOCAL_MACHINE : HKEY_CURRENT_USER);
            const key = host.hive.create(root, machine
                ? 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
                : 'Environment').key;
            host.hive.setValue(key, name, REG_EXPAND_SZ, encodeAnsi(`${value}\0`));
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function registerProduct(engine){
    const { session, host } = engine;
    const productCode = session.getProperty('ProductCode');
    const now = new Date();
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
        + `${String(now.getDate()).padStart(2, '0')}`;
    return schedule(engine, 'RegisterProduct', async()=>{
        host.registration.registerProduct({
            productCode,
            packageCode: session.getProperty('PackageCode'),
            upgradeCode: session.getProperty('UpgradeCode') || null,
            name: session.getProperty('ProductName'),
            version: session.getProperty('ProductVersion'),
            manufacturer: session.getProperty('Manufacturer'),
            language: Number(session.getProperty('ProductLanguage')) || 0,
            installLocation: session.getProperty('ARPINSTALLLOCATION'),
            installSource: session.sourceDir,
            localPackage: session.packagePath,
            date,
            extras: Object.fromEntries([['HelpLink', 'ARPHELPLINK'],
                ['URLInfoAbout', 'ARPURLINFOABOUT'], ['URLUpdateInfo', 'ARPURLUPDATEINFO'],
                ['HelpTelephone', 'ARPHELPTELEPHONE'], ['Comments', 'ARPCOMMENTS'],
                ['Contact', 'ARPCONTACT'], ['ProductID', 'ProductID'],
                ['RegOwner', 'USERNAME'], ['RegCompany', 'COMPANYNAME']]
                .map(([name, property])=>[name, session.getProperty(property)])
                .filter(([, value])=>value !== '')),
        });
    });
}

/** @param {Engine} engine */
async function processComponents(engine){
    const { session, host } = engine;
    const productCode = session.getProperty('ProductCode');
    for (const component of session.components.values())
    {
        if (!component.id || !installing(engine, component.key))
        {
            continue;
        }
        const directory = session.folders.get(component.directory)?.target ?? '';
        const keyFile = component.keyPath ? session.files.get(component.keyPath) : null;
        const keyPath = (component.attributes & COMPONENT_REGISTRY_KEY_PATH) !== 0 ? ''
            : keyFile?.target ?? directory;
        const id = component.id;
        await schedule(engine, 'ProcessComponents', async()=>{
            host.registration.registerComponent(id, productCode, keyPath);
            component.installed = component.action;
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function publishFeatures(engine){
    const { session, host } = engine;
    const productCode = session.getProperty('ProductCode');
    for (const feature of session.features.values())
    {
        if (feature.action !== INSTALLSTATE.LOCAL && feature.action !== INSTALLSTATE.SOURCE)
        {
            continue;
        }
        const list = feature.components.join('');
        await schedule(engine, 'PublishFeatures', async()=>{
            host.registration.registerFeature(productCode, feature.key, list);
            feature.installed = feature.action;
        });
    }
    return ERROR_SUCCESS;
}

/**
 * SelfRegModules: each library the SelfReg table names registers itself,
 * as regsvr32 would have it, once it is installed.
 *
 * @param {Engine} engine
 */
async function selfRegModules(engine){
    const { session, host } = engine;
    for (const row of session.db.table('SelfReg')?.rows ?? [])
    {
        const file = session.files.get(String(row[0]));
        if (!file?.target || !installing(engine, file.component))
        {
            continue;
        }
        const path = file.target;
        await schedule(engine, 'SelfRegModules', async()=>{
            const code = await host.callDll(path, 'DllRegisterServer', []);
            if (code !== 0)
            {
                await errorMessage(engine, 1904, [path, code === null ? '' : String(code)]);
            }
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function launchConditions(engine){
    const { session } = engine;
    for (const row of session.db.table('LaunchCondition')?.rows ?? [])
    {
        if (row[0] !== null && session.evaluate(String(row[0])) === MSICONDITION.FALSE)
        {
            await message(engine, INSTALLMESSAGE.ERROR,
                [session.formatText(String(row[1] ?? ''))]);
            return ERROR_INSTALL_FAILURE;
        }
    }
    return ERROR_SUCCESS;
}

/**
 * AppSearch: each property a signature names, set to where it was found --
 * a registry value, a directory, a component's key path, an INI value.
 *
 * @param {Engine} engine
 */
async function appSearch(engine){
    const { session, host } = engine;
    /** @param {string} table @param {string} signature */
    const locator = (table, signature)=>session.db.table(table)?.rows
        .find(row=>row[0] === signature) ?? null;
    for (const row of session.db.table('AppSearch')?.rows ?? [])
    {
        const property = String(row[0]);
        const signature = String(row[1]);
        let found = null;
        const registry = locator('RegLocator', signature);
        if (registry)
        {
            const root = registryRoot(engine, Number(registry[1] ?? -2));
            const key = root ? host.hive.open(root, session.formatText(String(registry[2] ?? '')))
                : null;
            if (key)
            {
                const type = Number(registry[4] ?? 0) & 0x0f;
                if (type === 0 || type === 1)
                {
                    found = normalize(session.formatText(String(registry[2])));
                }
                if (type === 2 || registry[3] !== null)
                {
                    const value = host.hive.getValue(key,
                        session.formatText(String(registry[3] ?? '')));
                    if (value)
                    {
                        found = value.type === REG_DWORD
                            ? `#${new DataView(value.data.buffer, value.data.byteOffset, 4)
                                .getUint32(0, true)}`
                            : new TextDecoder('latin1').decode(value.data).replace(/\0[^]*$/, '');
                    }
                }
            }
        }
        const directory = locator('DrLocator', signature);
        if (found === null && directory)
        {
            const parent = directory[1] === null ? '' : session.getProperty(String(directory[1]));
            const path = session.formatText(String(directory[2] ?? ''));
            const full = /^[A-Za-z]:/.test(path) ? path : `${parent}${path}`;
            if (full && host.files.stat(full)?.exists)
            {
                found = host.files.stat(full)?.isDirectory ? normalize(full) : full;
            }
        }
        const component = locator('CompLocator', signature);
        if (found === null && component)
        {
            for (const product of host.registration.products())
            {
                const path = host.registration.componentPath(product, String(component[1]));
                if (path)
                {
                    found = path;
                    break;
                }
            }
        }
        if (found !== null)
        {
            session.setProperty(property, found);
        }
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function findRelatedProducts(engine){
    const { session, host } = engine;
    for (const row of session.db.table('Upgrade')?.rows ?? [])
    {
        const related = host.registration.relatedProducts(String(row[0] ?? ''))
            .filter(product=>product !== session.getProperty('ProductCode'));
        if (related.length > 0 && row[6] !== null)
        {
            const property = String(row[6]);
            const existing = session.getProperty(property);
            session.setProperty(property, [existing, ...related].filter(Boolean).join(';'));
        }
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function costInitialize(engine){
    const { session } = engine;
    if (session.getProperty('ROOTDRIVE') === '')
    {
        session.setProperty('ROOTDRIVE', 'C:\\');
    }
    session.setProperty('CostingComplete', '0');
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function costFinalize(engine){
    const { session } = engine;
    session.resolveTargets();
    session.settleStates();
    session.setProperty('CostingComplete', '1');
    session.setProperty('OutOfDiskSpace', '0');
    session.setProperty('OutOfNoRbDiskSpace', '0');
    session.setProperty('PrimaryVolumeSpaceAvailable', '25165824');
    session.setProperty('PrimaryVolumeSpaceRequired', '0');
    session.setProperty('PrimaryVolumeSpaceRemaining', '25165824');
    const target = session.getProperty('TARGETDIR');
    if (target)
    {
        session.setProperty('PrimaryVolumePath', target.slice(0, 2));
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function installInitialize(engine){
    engine.session.mode.scheduled = true;
    engine.session.script.length = 0;
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function installExecute(engine){
    engine.session.mode.scheduled = false;
    const code = await runScript(engine);
    engine.session.mode.scheduled = true;
    return code;
}

/** @param {Engine} engine */
async function installFinalize(engine){
    engine.session.mode.scheduled = false;
    const code = await runScript(engine);
    if (code !== ERROR_SUCCESS)
    {
        return code;
    }
    for (const step of engine.commit.splice(0))
    {
        await step.run();
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function executeAction(engine){
    const wasExecuting = engine.executing;
    engine.executing = true;
    try
    {
        return await runSequence(engine, 'InstallExecuteSequence');
    }
    finally
    {
        engine.executing = wasExecuting;
    }
}

/** @param {Engine} engine */
async function resolveSource(engine){
    if (engine.session.getProperty('SOURCEDIR') === '')
    {
        engine.session.setProperty('SOURCEDIR', engine.session.sourceDir);
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function validateProductId(engine){
    const key = engine.session.getProperty('PIDKEY');
    if (key !== '')
    {
        engine.session.setProperty('ProductID', key);
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function nothing(engine){
    void engine;
    return ERROR_SUCCESS;
}

/**
 * The standard actions this installer carries out. Those that change
 * nothing a program can see here -- costing details, removal on a first
 * installation, services this machine does not run, rollback -- succeed and
 * do nothing.
 *
 * @type {Record<string, (engine: Engine) => Promise<number>>}
 */
export const STANDARD_ACTIONS = {
    AppSearch: appSearch,
    CCPSearch: nothing,
    RMCCPSearch: nothing,
    LaunchConditions: launchConditions,
    FindRelatedProducts: findRelatedProducts,
    MigrateFeatureStates: nothing,
    ValidateProductID: validateProductId,
    CostInitialize: costInitialize,
    FileCost: nothing,
    IsolateComponents: nothing,
    CostFinalize: costFinalize,
    ResolveSource: resolveSource,
    SetODBCFolders: nothing,
    InstallValidate: nothing,
    InstallInitialize: installInitialize,
    AllocateRegistrySpace: nothing,
    ProcessComponents: processComponents,
    UnpublishComponents: nothing,
    UnpublishFeatures: nothing,
    StopServices: nothing,
    DeleteServices: nothing,
    UnregisterComPlus: nothing,
    SelfUnregModules: nothing,
    UnregisterTypeLibraries: nothing,
    RemoveODBC: nothing,
    UnregisterFonts: nothing,
    RemoveRegistryValues: nothing,
    UnregisterClassInfo: nothing,
    UnregisterExtensionInfo: nothing,
    UnregisterProgIdInfo: nothing,
    UnregisterMIMEInfo: nothing,
    RemoveIniValues: nothing,
    RemoveShortcuts: nothing,
    RemoveEnvironmentStrings: nothing,
    RemoveDuplicateFiles: nothing,
    RemoveFiles: nothing,
    RemoveFolders: nothing,
    CreateFolders: createFolders,
    MoveFiles: nothing,
    InstallFiles: installFiles,
    PatchFiles: nothing,
    DuplicateFiles: duplicateFiles,
    BindImage: nothing,
    CreateShortcuts: createShortcuts,
    RegisterClassInfo: nothing,
    RegisterExtensionInfo: nothing,
    RegisterProgIdInfo: nothing,
    RegisterMIMEInfo: nothing,
    WriteRegistryValues: writeRegistryValues,
    WriteIniValues: writeIniValues,
    WriteEnvironmentStrings: writeEnvironmentStrings,
    RegisterFonts: nothing,
    InstallODBC: nothing,
    InstallServices: nothing,
    StartServices: nothing,
    RegisterComPlus: nothing,
    RegisterTypeLibraries: nothing,
    SelfRegModules: selfRegModules,
    RegisterUser: nothing,
    RegisterProduct: registerProduct,
    PublishComponents: nothing,
    PublishFeatures: publishFeatures,
    PublishProduct: nothing,
    MsiPublishAssemblies: nothing,
    MsiUnpublishAssemblies: nothing,
    InstallExecute: installExecute,
    InstallExecuteAgain: installExecute,
    InstallFinalize: installFinalize,
    ExecuteAction: executeAction,
    ScheduleReboot: nothing,
    ForceReboot: nothing,
    RemoveExistingProducts: nothing,
    InstallAdminPackage: nothing,
    InstallSFPCatalogFile: nothing,
    StartApplication: nothing,
    DisableRollback: nothing,
    SetUILevel: nothing,
};
