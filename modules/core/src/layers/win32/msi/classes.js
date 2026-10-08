/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The COM and shell registration a package describes in tables rather than
 * in Registry rows: classes, their ProgIDs, file extensions and their verbs,
 * MIME types, AppIDs and type libraries. Each is written under the classes
 * root where COM, the shell and OLE look for it, when the component it names
 * is installed -- and taken out again when that component is removed.
 *
 * A server's path is its component's key path, the file COM loads. An icon a
 * class or ProgID shows is the Icon table's, kept by the installer in its own
 * folder for the product, as PublishProduct keeps every icon the package
 * carries.
 */

import { INSTALLSTATE, normalize } from './session.js';
import { HKEY_CLASSES_ROOT, REG_SZ } from '../advapi32/registry.js';
import { encodeAnsi } from '../kernel32/locale.js';
import {
    ERROR_SUCCESS, installing, removing, schedule, writeFile,
} from './steps.js';
import { removeKeyTree } from './registration.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./database.js').Row} Row */

/** A Class row's server path is the file's name alone, found on the search path. */
const CLASS_RELATIVE_PATH = 0x1;

/** @param {string} text a REG_SZ value's bytes */
const sz = text=>encodeAnsi(`${text}\0`);

/** @param {Engine} engine */
const classesRoot = engine=>engine.host.hive.root(HKEY_CLASSES_ROOT);

/**
 * Sets a string value under the classes root, the key made first.
 *
 * @param {Engine} engine @param {string} path @param {string} name @param {string} value
 */
function setString(engine, path, name, value){
    const { hive } = engine.host;
    const key = hive.create(classesRoot(engine), path).key;
    hive.setValue(key, name, REG_SZ, sz(value));
}

/**
 * The file a component's key path names, once installed: what COM loads for
 * a class and the shell runs for a verb.
 *
 * @param {Engine} engine @param {string} componentKey
 */
function keyFile(engine, componentKey){
    const { session } = engine;
    const component = session.components.get(componentKey);
    const file = component?.keyPath ? session.files.get(component.keyPath) : null;
    return file?.target ?? null;
}

/**
 * Where the installer keeps a product's icons, and the path of one.
 *
 * @param {Engine} engine @param {string} icon
 */
export function iconPath(engine, icon){
    const { session } = engine;
    return `${normalize(session.getProperty('WindowsFolder'))}Installer\\`
        + `${session.getProperty('ProductCode')}\\${icon}`;
}

/**
 * PublishProduct's icons: each the Icon table holds, written where a class,
 * a ProgID, a shortcut or the control panel will name it.
 *
 * @param {Engine} engine
 */
export async function publishIcons(engine){
    const { session, host } = engine;
    for (const row of session.db.table('Icon')?.rows ?? [])
    {
        const name = String(row[0]);
        const path = iconPath(engine, name);
        await schedule(engine, 'PublishProduct', async()=>{
            const bytes = await session.db.readStream(`Icon.${name}`);
            if (bytes)
            {
                writeFile(host.files, path, bytes);
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * An icon value: the icon's kept path and its index, or the empty string for
 * a row that names no icon.
 *
 * @param {Engine} engine @param {string | number | null} icon @param {string | number | null} index
 */
const iconValue = (engine, icon, index)=>(icon === null ? ''
    : `${iconPath(engine, String(icon))},${Number(index ?? 0)}`);

/**
 * The rows of a table whose component is being installed (or removed), and
 * whose feature, when the table names one, is too.
 *
 * @param {Engine} engine @param {string} table @param {number} componentColumn
 * @param {number | null} featureColumn @param {boolean} removal
 * @returns {Row[]}
 */
function rowsFor(engine, table, componentColumn, featureColumn, removal){
    const { session } = engine;
    return (session.db.table(table)?.rows ?? []).filter(row=>{
        const component = String(row[componentColumn]);
        if (removal ? !removing(engine, component) : !installing(engine, component))
        {
            return false;
        }
        if (featureColumn === null || row[featureColumn] === null || removal)
        {
            return true;
        }
        const action = session.features.get(String(row[featureColumn]))?.action;
        return action === INSTALLSTATE.LOCAL || action === INSTALLSTATE.SOURCE;
    });
}

/**
 * The ProgID rows that belong to a class: its own, and the version-independent
 * ones that point at them.
 *
 * @param {Engine} engine @param {Set<string>} classes
 * @returns {Row[]}
 */
function progIdsOf(engine, classes){
    const rows = engine.session.db.table('ProgId')?.rows ?? [];
    const direct = rows.filter(row=>row[2] !== null && classes.has(String(row[2])));
    const names = new Set(direct.map(row=>String(row[0])));
    return [...direct, ...rows.filter(row=>row[1] !== null && names.has(String(row[1]))
        && !names.has(String(row[0])))];
}

/**
 * The class a ProgID row stands for: its own Class_, or its parent's for a
 * version-independent one.
 *
 * @param {Engine} engine @param {Row} row
 */
function classOfProgId(engine, row){
    if (row[2] !== null)
    {
        return String(row[2]);
    }
    const parent = (engine.session.db.table('ProgId')?.rows ?? [])
        .find(entry=>row[1] !== null && entry[0] === row[1]);
    return parent?.[2] === null || parent?.[2] === undefined ? null : String(parent[2]);
}

/**
 * RegisterClassInfo: each class whose component and feature are installed,
 * under CLSID with its server, ProgIDs, AppID, handler, icon and file types;
 * and the AppIDs the classes name.
 *
 * @param {Engine} engine
 */
async function registerClassInfo(engine){
    const { session } = engine;
    const rows = rowsFor(engine, 'Class', 2, 11, false);
    const progIds = progIdsOf(engine, new Set(rows.map(row=>String(row[0]))));
    for (const row of rows)
    {
        const clsid = String(row[0]);
        const context = String(row[1]);
        const file = keyFile(engine, String(row[2]));
        const attributes = Number(row[12] ?? 0);
        const server = file === null ? null : (attributes & CLASS_RELATIVE_PATH) !== 0
            ? file.slice(file.lastIndexOf('\\') + 1) : file;
        const argument = row[10] === null ? '' : session.formatText(String(row[10]));
        const versionIndependent = progIds.find(entry=>entry[1] !== null
            && entry[1] === row[3]);
        await schedule(engine, 'RegisterClassInfo', async()=>{
            const base = `CLSID\\${clsid}`;
            if (row[4] !== null)
            {
                setString(engine, base, '', String(row[4]));
            }
            if (server !== null)
            {
                setString(engine, `${base}\\${context}`, '',
                    argument === '' ? server : `${server} ${argument}`);
            }
            if (row[3] !== null)
            {
                setString(engine, `${base}\\ProgID`, '', String(row[3]));
            }
            if (versionIndependent)
            {
                setString(engine, `${base}\\VersionIndependentProgID`, '',
                    String(versionIndependent[0]));
            }
            if (row[5] !== null)
            {
                setString(engine, base, 'AppID', String(row[5]));
            }
            if (row[7] !== null)
            {
                setString(engine, `${base}\\DefaultIcon`, '', iconValue(engine, row[7], row[8]));
            }
            const handler = row[9] === null ? '' : String(row[9]);
            if (handler === '1' || handler === '3')
            {
                setString(engine, `${base}\\InprocHandler`, '', 'ole2.dll');
            }
            if (handler === '2' || handler === '3')
            {
                setString(engine, `${base}\\InprocHandler32`, '', 'ole32.dll');
            }
            else if (handler !== '' && handler !== '1')
            {
                setString(engine, `${base}\\InprocHandler32`, '', handler);
            }
            const masks = row[6] === null ? [] : String(row[6]).split(';').filter(Boolean);
            masks.forEach((mask, index)=>{
                setString(engine, `FileType\\${clsid}\\${index}`, '', mask);
            });
        });
    }
    const appIds = new Set(rows.map(row=>row[5]).filter(id=>id !== null).map(String));
    for (const row of session.db.table('AppId')?.rows ?? [])
    {
        if (!appIds.has(String(row[0])))
        {
            continue;
        }
        await schedule(engine, 'RegisterClassInfo', async()=>{
            const base = `AppID\\${String(row[0])}`;
            engine.host.hive.create(classesRoot(engine), base);
            /** @type {[string, string | number | null][]} */
            const values = [['RemoteServerName', row[1]], ['LocalService', row[2]],
                ['ServiceParameters', row[3]], ['DllSurrogate', row[4]]];
            for (const [name, value] of values)
            {
                if (value !== null)
                {
                    setString(engine, base, name, session.formatText(String(value)));
                }
            }
            if (Number(row[5] ?? 0) !== 0)
            {
                setString(engine, base, 'ActivateAtStorage', 'Y');
            }
            if (Number(row[6] ?? 0) !== 0)
            {
                setString(engine, base, 'RunAs', 'Interactive User');
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * UnregisterClassInfo: the classes of components being removed, and their
 * file types and AppIDs.
 *
 * @param {Engine} engine
 */
async function unregisterClassInfo(engine){
    const { hive } = engine.host;
    for (const row of rowsFor(engine, 'Class', 2, 11, true))
    {
        const clsid = String(row[0]);
        await schedule(engine, 'UnregisterClassInfo', async()=>{
            removeKeyTree(hive, classesRoot(engine), `CLSID\\${clsid}`);
            removeKeyTree(hive, classesRoot(engine), `FileType\\${clsid}`);
            if (row[5] !== null)
            {
                removeKeyTree(hive, classesRoot(engine), `AppID\\${String(row[5])}`);
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * The ProgIDs to write or take away: those of the classes whose components
 * are, and those the extensions being registered name.
 *
 * @param {Engine} engine @param {boolean} removal
 */
function progIdsFor(engine, removal){
    const classes = new Set(rowsFor(engine, 'Class', 2, 11, removal).map(row=>String(row[0])));
    const named = new Set(rowsFor(engine, 'Extension', 1, 4, removal).map(row=>row[2])
        .filter(id=>id !== null).map(String));
    const rows = engine.session.db.table('ProgId')?.rows ?? [];
    const chosen = [...progIdsOf(engine, classes),
        ...rows.filter(row=>named.has(String(row[0])))];
    return [...new Set(chosen)];
}

/**
 * RegisterProgIdInfo: each ProgID with its description, class, icon, and for
 * a version-independent one the version it currently stands for.
 *
 * @param {Engine} engine
 */
async function registerProgIdInfo(engine){
    for (const row of progIdsFor(engine, false))
    {
        const progId = String(row[0]);
        const clsid = classOfProgId(engine, row);
        await schedule(engine, 'RegisterProgIdInfo', async()=>{
            engine.host.hive.create(classesRoot(engine), progId);
            if (row[3] !== null)
            {
                setString(engine, progId, '', String(row[3]));
            }
            if (clsid !== null)
            {
                setString(engine, `${progId}\\CLSID`, '', clsid);
            }
            if (row[1] !== null)
            {
                setString(engine, `${progId}\\CurVer`, '', String(row[1]));
            }
            if (row[4] !== null)
            {
                setString(engine, `${progId}\\DefaultIcon`, '', iconValue(engine, row[4], row[5]));
            }
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function unregisterProgIdInfo(engine){
    for (const row of progIdsFor(engine, true))
    {
        const progId = String(row[0]);
        await schedule(engine, 'UnregisterProgIdInfo', async()=>{
            removeKeyTree(engine.host.hive, classesRoot(engine), progId);
        });
    }
    return ERROR_SUCCESS;
}

/**
 * RegisterExtensionInfo: each extension pointing at its ProgID and MIME type,
 * and its verbs under the ProgID -- or under the extension itself when it has
 * none -- each running the component's key file, the first by Sequence the
 * default.
 *
 * @param {Engine} engine
 */
async function registerExtensionInfo(engine){
    const { session } = engine;
    const verbs = session.db.table('Verb')?.rows ?? [];
    for (const row of rowsFor(engine, 'Extension', 1, 4, false))
    {
        const extension = `.${String(row[0])}`;
        const progId = row[2] === null ? null : String(row[2]);
        const file = keyFile(engine, String(row[1]));
        const own = verbs.filter(verb=>verb[0] === row[0])
            .sort((left, right)=>Number(left[2] ?? 0) - Number(right[2] ?? 0));
        await schedule(engine, 'RegisterExtensionInfo', async()=>{
            engine.host.hive.create(classesRoot(engine), extension);
            if (progId !== null)
            {
                setString(engine, extension, '', progId);
            }
            if (row[3] !== null)
            {
                setString(engine, extension, 'Content Type', String(row[3]));
            }
            const base = progId ?? extension;
            for (const verb of own)
            {
                const name = String(verb[1]);
                if (verb[3] !== null)
                {
                    setString(engine, `${base}\\shell\\${name}`, '', session.formatText(
                        String(verb[3])));
                }
                const argument = verb[4] === null ? '' : ` ${session.formatText(String(verb[4]))}`;
                if (file !== null)
                {
                    setString(engine, `${base}\\shell\\${name}\\command`, '',
                        `"${file}"${argument}`);
                }
            }
            if (own.length > 0)
            {
                setString(engine, `${base}\\shell`, '', String(own[0][1]));
            }
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function unregisterExtensionInfo(engine){
    const { hive } = engine.host;
    for (const row of rowsFor(engine, 'Extension', 1, 4, true))
    {
        const extension = `.${String(row[0])}`;
        const progId = row[2] === null ? null : String(row[2]);
        await schedule(engine, 'UnregisterExtensionInfo', async()=>{
            removeKeyTree(hive, classesRoot(engine), extension);
            if (progId !== null)
            {
                removeKeyTree(hive, classesRoot(engine), `${progId}\\shell`);
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * The MIME rows whose extension is being registered (or removed).
 *
 * @param {Engine} engine @param {boolean} removal
 */
function mimeRows(engine, removal){
    const extensions = new Set(rowsFor(engine, 'Extension', 1, 4, removal)
        .map(row=>String(row[0])));
    return (engine.session.db.table('MIME')?.rows ?? [])
        .filter(row=>extensions.has(String(row[1])));
}

/** @param {string} type @returns {string} where a content type is described */
const mimePath = type=>`MIME\\Database\\Content Type\\${type}`;

/**
 * RegisterMIMEInfo: each content type an extension being registered names,
 * with its extension and class.
 *
 * @param {Engine} engine
 */
async function registerMimeInfo(engine){
    for (const row of mimeRows(engine, false))
    {
        const type = String(row[0]);
        await schedule(engine, 'RegisterMIMEInfo', async()=>{
            setString(engine, mimePath(type), 'Extension', `.${String(row[1])}`);
            if (row[2] !== null)
            {
                setString(engine, mimePath(type), 'CLSID', String(row[2]));
            }
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function unregisterMimeInfo(engine){
    for (const row of mimeRows(engine, true))
    {
        const type = String(row[0]);
        await schedule(engine, 'UnregisterMIMEInfo', async()=>{
            removeKeyTree(engine.host.hive, classesRoot(engine), mimePath(type));
        });
    }
    return ERROR_SUCCESS;
}

/**
 * A TypeLib row's version as the registry spells it: major.minor in hex.
 *
 * @param {Row} row
 */
const typeLibVersion = row=>{
    const version = Number(row[3] ?? 0);
    return { major: version >>> 8 & 0xffff, minor: version & 0xff };
};

/**
 * RegisterTypeLibraries: each type library a component carries, registered
 * by oleaut32 as RegisterTypeLib does -- the library's key and the
 * interfaces it describes -- with the help folder the row names.
 *
 * @param {Engine} engine
 */
async function registerTypeLibraries(engine){
    const { session, host } = engine;
    for (const row of rowsFor(engine, 'TypeLib', 2, 6, false))
    {
        const file = keyFile(engine, String(row[2]));
        if (file === null)
        {
            continue;
        }
        const help = row[5] === null ? null : session.folders.get(String(row[5]))?.target ?? null;
        await schedule(engine, 'RegisterTypeLibraries', async()=>{
            const code = await host.registerTypeLib?.(file, help) ?? null;
            if (code === null)
            {
                host.divergence?.('RegisterTypeLibraries',
                    'no oleaut32 to register a type library with');
            }
            else if (code !== 0)
            {
                host.log?.(`RegisterTypeLibraries: ${file} answered 0x${(code >>> 0)
                    .toString(16)}.`);
            }
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function unregisterTypeLibraries(engine){
    const { host } = engine;
    for (const row of rowsFor(engine, 'TypeLib', 2, 6, true))
    {
        const { major, minor } = typeLibVersion(row);
        const libId = String(row[0]);
        const language = Number(row[1] ?? 0);
        await schedule(engine, 'UnregisterTypeLibraries', async()=>{
            const code = await host.unregisterTypeLib?.(libId, major, minor, language) ?? null;
            if (code === null)
            {
                removeKeyTree(host.hive, classesRoot(engine), `TypeLib\\${libId}\\`
                    + `${major.toString(16)}.${minor.toString(16)}`);
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * The class-registration actions, by name, for the table of standard actions.
 *
 * @type {Record<string, (engine: Engine) => Promise<number>>}
 */
export const CLASS_ACTIONS = {
    RegisterClassInfo: registerClassInfo,
    UnregisterClassInfo: unregisterClassInfo,
    RegisterProgIdInfo: registerProgIdInfo,
    UnregisterProgIdInfo: unregisterProgIdInfo,
    RegisterExtensionInfo: registerExtensionInfo,
    UnregisterExtensionInfo: unregisterExtensionInfo,
    RegisterMIMEInfo: registerMimeInfo,
    UnregisterMIMEInfo: unregisterMimeInfo,
    RegisterTypeLibraries: registerTypeLibraries,
    UnregisterTypeLibraries: unregisterTypeLibraries,
};
