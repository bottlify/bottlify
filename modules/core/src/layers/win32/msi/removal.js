/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The standard actions that take things off the machine: what a removed
 * component put down -- its files, copies, shortcuts, registry values, INI
 * lines, environment variables, its own self-registration and its place in
 * the installer's records -- and what the RemoveFile, RemoveRegistry and
 * RemoveIniFile tables name for removal when a component is installed. Each
 * runs in the script, like the actions that install, so a removal happens
 * when InstallFinalize carries it out.
 *
 * When an installation leaves none of the product's features on the
 * machine, the product itself is forgotten at its end, as Windows unpublishes
 * it: a removal leaves nothing a later query finds.
 */

import { INSTALLSTATE, machineProperties, normalize } from './session.js';
import { REG_SZ } from '../advapi32/registry.js';
import { encodeAnsi } from '../kernel32/locale.js';
import {
    ERROR_SUCCESS, actionData, errorMessage, installing, progressed, readFile, registryRoot,
    removing, schedule, writeFile, REGISTRY_TICKS,
} from './steps.js';
import { editIni, undoIniAction, INI_ACTION } from './ini.js';
import { environmentKey, environmentRow, removedValue } from './environment.js';
import { removeKeyTree, valueText } from './registration.js';

/** @typedef {import('./engine.js').Engine} Engine */

/** RemoveFile's InstallMode: when the row applies. */
const REMOVE_ON_INSTALL = 1;
const REMOVE_ON_UNINSTALL = 2;

/** A path as the volume takes a directory: no separator at its end but a drive's. */
const bare = (/** @type {string} */ path)=>(/^[A-Za-z]:\\$/.test(path) ? path
    : path.replace(/\\+$/, ''));

/**
 * Removes a file, read-only or not; true when it is gone.
 *
 * @param {any} files @param {string} path
 */
function deleteFile(files, path){
    const stat = files.stat(path);
    if (!stat || stat.exists === false)
    {
        return true;
    }
    if (stat.isDirectory)
    {
        return false;
    }
    files.setAttributes?.(path, null);
    return files.remove(path);
}

/**
 * Removes a directory when nothing is left in it.
 *
 * @param {any} files @param {string} path @returns {boolean} whether it went
 */
function removeEmptyDirectory(files, path){
    const directory = bare(path);
    const stat = files.stat(directory);
    if (!stat?.isDirectory || files.list(directory, '*').length > 0)
    {
        return false;
    }
    return files.remove(directory);
}

/**
 * A directory a RemoveFile or RemoveIniFile row names through a property:
 * the property's value, a directory's resolved target when the property is
 * one of the Directory table's keys.
 *
 * @param {Engine} engine @param {string | null} property
 */
function directoryOf(engine, property){
    if (property === null)
    {
        return '';
    }
    const { session } = engine;
    const value = session.folders.get(property)?.target ?? session.getProperty(property);
    return value === '' ? '' : normalize(value);
}

/**
 * Whether a RemoveFile-style row applies now: on its component's
 * installation, its removal, or both.
 *
 * @param {Engine} engine @param {string} component @param {number} mode
 */
const applies = (engine, component, mode)=>((mode & REMOVE_ON_INSTALL) !== 0
    && installing(engine, component)) || ((mode & REMOVE_ON_UNINSTALL) !== 0
    && removing(engine, component));

/**
 * RemoveFiles: the files of every component being removed, and what the
 * RemoveFile table names -- files by name or wildcard, or a folder once it
 * is empty -- for the components it applies to.
 *
 * @param {Engine} engine
 */
async function removeFiles(engine){
    const { session, host } = engine;
    for (const file of session.files.values())
    {
        if (!file.target || !removing(engine, file.component))
        {
            continue;
        }
        const target = file.target;
        await schedule(engine, 'RemoveFiles', async()=>{
            await actionData(engine, 'RemoveFiles', [file.name,
                target.slice(0, target.lastIndexOf('\\') + 1)]);
            deleteFile(host.files, target);
        });
    }
    /** @type {string[]} */
    const folders = [];
    for (const row of session.db.table('RemoveFile')?.rows ?? [])
    {
        if (!applies(engine, String(row[1]), Number(row[4] ?? 0)))
        {
            continue;
        }
        const directory = directoryOf(engine, row[3] === null ? null : String(row[3]));
        if (directory === '')
        {
            continue;
        }
        if (row[2] === null)
        {
            folders.push(directory);
            continue;
        }
        const pattern = String(row[2]).split('|').pop() ?? '';
        await schedule(engine, 'RemoveFiles', async()=>{
            for (const entry of host.files.list(bare(directory), pattern))
            {
                if (!entry.isDirectory)
                {
                    await actionData(engine, 'RemoveFiles', [entry.name, directory]);
                    deleteFile(host.files, `${directory}${entry.name}`);
                }
            }
        });
    }
    for (const directory of folders)
    {
        await schedule(engine, 'RemoveFiles', async()=>{
            removeEmptyDirectory(host.files, directory);
        });
    }
    return ERROR_SUCCESS;
}

/**
 * RemoveFolders: the folders a removed component made or put its files in,
 * each once it is empty, and the empty ones above it -- but never a folder
 * the machine had before any package, the Program Files and the like.
 *
 * @param {Engine} engine
 */
async function removeFolders(engine){
    const { session, host } = engine;
    const standing = new Set([...machineProperties(session.machine).keys(), 'TARGETDIR']);
    /** @type {Set<string>} */
    const keys = new Set();
    for (const row of session.db.table('CreateFolder')?.rows ?? [])
    {
        if (removing(engine, String(row[1])))
        {
            keys.add(String(row[0]));
        }
    }
    for (const component of session.components.values())
    {
        if (removing(engine, component.key))
        {
            keys.add(component.directory);
        }
    }
    /** @type {string[]} */
    const paths = [];
    for (const key of keys)
    {
        for (let folder = session.folders.get(key); folder && !standing.has(folder.key);
            folder = folder.parent ? session.folders.get(folder.parent) : undefined)
        {
            if (folder.target && !paths.includes(folder.target))
            {
                paths.push(folder.target);
            }
        }
    }
    // The deepest first, so a parent is looked at once its children are gone.
    paths.sort((left, right)=>right.length - left.length);
    if (paths.length > 0)
    {
        await schedule(engine, 'RemoveFolders', async()=>{
            for (const path of paths)
            {
                removeEmptyDirectory(host.files, path);
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * Removes a key that has nothing left in it, and each key above it that the
 * removal leaves empty in turn, up to the root.
 *
 * @param {Engine} engine @param {any} root @param {string} path
 */
function pruneEmpty(engine, root, path){
    const { hive } = engine.host;
    for (let at = path.replace(/\\+$/, ''); at !== ''; at = at.slice(0, Math.max(0,
        at.lastIndexOf('\\'))))
    {
        const key = hive.open(root, at);
        if (!key || hive.values(key).length > 0 || hive.subkeys(key).length > 0)
        {
            return;
        }
        hive.remove(root, at);
    }
}

/**
 * Takes a value out of a key, and the key with it when nothing is left in it.
 *
 * @param {Engine} engine @param {any} root @param {string} path @param {string} name
 */
function removeValue(engine, root, path, name){
    const { hive } = engine.host;
    const key = hive.open(root, path);
    if (!key)
    {
        return;
    }
    hive.deleteValue(key, name);
    pruneEmpty(engine, root, path);
}

/**
 * RemoveRegistryValues: each value a removed component wrote, or its whole
 * key where the row's name is `-` or `*` and it has no value; and what the
 * RemoveRegistry table names when its component is installed.
 *
 * @param {Engine} engine
 */
async function removeRegistryValues(engine){
    const { session } = engine;
    /**
     * @param {any} root @param {string} path @param {string | null} name
     * @param {boolean} wholeKey
     */
    const remove = (root, path, name, wholeKey)=>schedule(engine, 'RemoveRegistryValues',
        async()=>{
            await actionData(engine, 'RemoveRegistryValues', [path, name]);
            if (wholeKey)
            {
                removeKeyTree(engine.host.hive, root, path);
                pruneEmpty(engine, root, path.slice(0, Math.max(0, path.lastIndexOf('\\'))));
            }
            else
            {
                removeValue(engine, root, path, name ?? '');
            }
            await progressed(engine, REGISTRY_TICKS);
        });
    for (const row of session.db.table('Registry')?.rows ?? [])
    {
        if (!removing(engine, String(row[5])))
        {
            continue;
        }
        const root = registryRoot(engine, Number(row[1] ?? -2));
        if (!root)
        {
            continue;
        }
        const name = row[3] === null ? null : session.formatText(String(row[3]));
        if (row[4] === null && name === '+')
        {
            // A key made on installation alone stays where it is.
            continue;
        }
        await remove(root, session.formatText(String(row[2] ?? '')), name,
            row[4] === null && (name === '-' || name === '*'));
    }
    for (const row of session.db.table('RemoveRegistry')?.rows ?? [])
    {
        if (!installing(engine, String(row[4])))
        {
            continue;
        }
        const root = registryRoot(engine, Number(row[1] ?? -2));
        if (!root)
        {
            continue;
        }
        const name = row[3] === null ? null : session.formatText(String(row[3]));
        await remove(root, session.formatText(String(row[2] ?? '')), name, name === '-');
    }
    return ERROR_SUCCESS;
}

/**
 * Applies one INI action to a file on the volume, leaving a file that ends
 * up empty as no file at all.
 *
 * @param {Engine} engine @param {string} path @param {string} section @param {string} key
 * @param {string} value @param {number} action
 */
async function editIniFile(engine, path, section, key, value, action){
    const { files } = engine.host;
    const bytes = await readFile(files, path);
    if (!bytes)
    {
        return;
    }
    const text = editIni(new TextDecoder('latin1').decode(bytes), section, key, value, action);
    if (text.trim() === '')
    {
        deleteFile(files, path);
        return;
    }
    writeFile(files, path, encodeAnsi(text));
}

/**
 * RemoveIniValues: the lines and tags a removed component's IniFile rows
 * wrote, and what the RemoveIniFile table names when its component is
 * installed.
 *
 * @param {Engine} engine
 */
async function removeIniValues(engine){
    const { session } = engine;
    /** @param {import('./database.js').Row} row @param {number} action */
    const undo = (row, action)=>{
        const directory = row[2] === null ? normalize(session.getProperty('WindowsFolder'))
            : directoryOf(engine, String(row[2]));
        const path = `${directory}${String(row[1] ?? '').split('|').pop()}`;
        const section = session.formatText(String(row[3] ?? ''));
        const key = session.formatText(String(row[4] ?? ''));
        const value = row[5] === null ? '' : session.formatText(String(row[5]));
        return schedule(engine, 'RemoveIniValues',
            ()=>editIniFile(engine, path, section, key, value, action));
    };
    for (const row of session.db.table('IniFile')?.rows ?? [])
    {
        if (removing(engine, String(row[7])))
        {
            await undo(row, undoIniAction(Number(row[6] ?? 0)));
        }
    }
    for (const row of session.db.table('RemoveIniFile')?.rows ?? [])
    {
        const action = Number(row[6] ?? INI_ACTION.REMOVE_LINE);
        if (installing(engine, String(row[7]))
            && (action === INI_ACTION.REMOVE_LINE || action === INI_ACTION.REMOVE_TAG))
        {
            await undo(row, action);
        }
    }
    return ERROR_SUCCESS;
}

/**
 * RemoveShortcuts: the links a removed component's Shortcut rows made.
 *
 * @param {Engine} engine
 */
async function removeShortcuts(engine){
    const { session, host } = engine;
    for (const row of session.db.table('Shortcut')?.rows ?? [])
    {
        const directory = session.folders.get(String(row[1]))?.target;
        if (!directory || !removing(engine, String(row[3])))
        {
            continue;
        }
        const path = `${directory}${String(row[2] ?? '').split('|').pop()}.lnk`;
        await schedule(engine, 'RemoveShortcuts', async()=>{
            deleteFile(host.files, path);
        });
    }
    return ERROR_SUCCESS;
}

/**
 * RemoveEnvironmentStrings: the variables a removed component set -- or,
 * for a part of a list, that part alone.
 *
 * @param {Engine} engine
 */
async function removeEnvironmentStrings(engine){
    const { session, host } = engine;
    for (const row of session.db.table('Environment')?.rows ?? [])
    {
        if (!removing(engine, String(row[3])))
        {
            continue;
        }
        const variable = environmentRow(String(row[1] ?? ''),
            row[2] === null ? '' : session.formatText(String(row[2])));
        if (variable.name === '' || !variable.removeOnUninstall)
        {
            continue;
        }
        await schedule(engine, 'RemoveEnvironmentStrings', async()=>{
            const key = environmentKey(host.hive, variable.machine);
            const now = host.hive.getValue(key, variable.name);
            const next = removedValue(variable, now ? valueText(now) : null);
            if (next === null)
            {
                host.hive.deleteValue(key, variable.name);
            }
            else if (next !== undefined)
            {
                host.hive.setValue(key, variable.name, now?.type ?? REG_SZ,
                    encodeAnsi(`${next}\0`));
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * RemoveDuplicateFiles: the copies DuplicateFiles made for removed components.
 *
 * @param {Engine} engine
 */
async function removeDuplicateFiles(engine){
    const { session, host } = engine;
    for (const row of session.db.table('DuplicateFile')?.rows ?? [])
    {
        const file = session.files.get(String(row[2]));
        if (!file?.target || !removing(engine, String(row[1])))
        {
            continue;
        }
        const directory = row[4] === null ? file.target.slice(0, file.target.lastIndexOf('\\') + 1)
            : directoryOf(engine, String(row[4]));
        const name = row[3] === null ? file.name : String(row[3]).split('|').pop() ?? file.name;
        await schedule(engine, 'RemoveDuplicateFiles', async()=>{
            deleteFile(host.files, `${directory}${name}`);
        });
    }
    return ERROR_SUCCESS;
}

/**
 * SelfUnregModules: each library the SelfReg table names unregisters itself
 * before its component's files go.
 *
 * @param {Engine} engine
 */
async function selfUnregModules(engine){
    const { session, host } = engine;
    for (const row of session.db.table('SelfReg')?.rows ?? [])
    {
        const file = session.files.get(String(row[0]));
        if (!file?.target || !removing(engine, file.component))
        {
            continue;
        }
        const path = file.target;
        await schedule(engine, 'SelfUnregModules', async()=>{
            const code = await host.callDll(path, 'DllUnregisterServer', []);
            if (code !== 0)
            {
                await errorMessage(engine, 1910, [path, code === null ? '' : String(code)]);
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * UnpublishFeatures: the features being removed leave the product's records.
 *
 * @param {Engine} engine
 */
async function unpublishFeatures(engine){
    const { session, host } = engine;
    const productCode = session.getProperty('ProductCode');
    for (const feature of session.features.values())
    {
        if (feature.action !== INSTALLSTATE.ABSENT)
        {
            continue;
        }
        await schedule(engine, 'UnpublishFeatures', async()=>{
            host.registration.unregisterFeature(productCode, feature.key);
            feature.installed = INSTALLSTATE.ABSENT;
        });
    }
    return ERROR_SUCCESS;
}

/**
 * Whether the installation leaves none of the product's features on the
 * machine: each is being removed, or was not there and is not being added.
 *
 * @param {Engine} engine
 */
export function productGone(engine){
    const { session } = engine;
    if (session.getProperty('Installed') === '')
    {
        return false;
    }
    return [...session.features.values()].every(feature=>
        feature.action === INSTALLSTATE.ABSENT || (feature.action === INSTALLSTATE.UNKNOWN
            && feature.installed !== INSTALLSTATE.LOCAL
            && feature.installed !== INSTALLSTATE.SOURCE));
}

/**
 * The end of a removal: the product forgotten, and the copy of its package
 * the machine kept for it deleted -- unless it is the very package being
 * run from somewhere other than the installer's own folder.
 *
 * @param {Engine} engine
 */
export async function unpublishProduct(engine){
    const { session, host } = engine;
    const productCode = session.getProperty('ProductCode');
    const info = host.registration.productInfo(productCode, 'LocalPackage');
    host.registration.unregisterProduct(productCode);
    const cached = 'value' in info ? info.value : '';
    const cache = `${normalize(session.getProperty('WindowsFolder'))}Installer\\`;
    if (cached !== '' && cached.toLowerCase().startsWith(cache.toLowerCase()))
    {
        deleteFile(host.files, cached);
    }
    return ERROR_SUCCESS;
}

/**
 * The removal actions, by name, for the table of standard actions.
 *
 * @type {Record<string, (engine: Engine) => Promise<number>>}
 */
export const REMOVAL_ACTIONS = {
    RemoveFiles: removeFiles,
    RemoveFolders: removeFolders,
    RemoveRegistryValues: removeRegistryValues,
    RemoveIniValues: removeIniValues,
    RemoveShortcuts: removeShortcuts,
    RemoveEnvironmentStrings: removeEnvironmentStrings,
    RemoveDuplicateFiles: removeDuplicateFiles,
    SelfUnregModules: selfUnregModules,
    UnpublishFeatures: unpublishFeatures,
};
