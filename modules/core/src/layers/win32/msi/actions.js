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
import { extractCabinet } from '../cabinet/stream.js';
import { REG_DWORD, REG_EXPAND_SZ, REG_SZ } from '../advapi32/registry.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { runCustomAction } from './custom.js';
import { PID } from './summary.js';
import { editIni } from './ini.js';
import { replaces } from './versioning.js';
import { createMd5 } from '../crypto/digest.js';
import { REMOVAL_ACTIONS, productGone, unpublishProduct } from './removal.js';
import { CLASS_ACTIONS, iconPath, publishIcons } from './classes.js';
import { SW_SHOWNORMAL, encodeShellLink } from '../common/shell-link.js';
import { SYSTEM_ACTIONS } from './system.js';
import { UPGRADE_ACTIONS } from './upgrade.js';
import { environmentKey, environmentRow, installedValue } from './environment.js';
import { valueText } from './registration.js';
import {
    ERROR_SUCCESS, ERROR_FUNCTION_NOT_CALLED, ERROR_INSTALL_USEREXIT, ERROR_INSTALL_FAILURE,
    ERROR_INSTALL_SUSPEND, ERROR_NO_MORE_ITEMS, INSTALLMESSAGE, log, message, actionStart,
    errorMessage, REGISTRY_TICKS, COMPONENT_TICKS, PROGRESS_RESET, progressed, actionData,
    schedule, makeDirectories, create, readFile, writeFile, componentOf, installing,
    registryRoot, registryValue,
} from './steps.js';
export { setIniValue } from './ini.js';

export {
    ERROR_SUCCESS, ERROR_FUNCTION_NOT_CALLED, ERROR_INSTALL_USEREXIT, ERROR_INSTALL_FAILURE,
    ERROR_INSTALL_SUSPEND, ERROR_NO_MORE_ITEMS, ERROR_INVALID_HANDLE_STATE, INSTALLMESSAGE,
    message, errorMessage, schedule, makeDirectories, readFile, writeFile, registryValue,
} from './steps.js';

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
 * Runs the script written so far, and empties it. Each action in it starts
 * again as it is carried out, as Windows' script starts it, so the interface
 * says what is being done while it is.
 *
 * @param {Engine} engine
 */
async function runScript(engine){
    const { session } = engine;
    let running = '';
    while (session.script.length > 0)
    {
        const step = /** @type {{ name: string, run: () => Promise<number> }} */ (
            session.script.shift());
        if (step.name !== running)
        {
            running = step.name;
            await actionStart(engine, step.name);
        }
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
 * The files the installation puts down: those of each component installing
 * locally, but for one that never overwrites a file already there.
 *
 * @param {Engine} engine
 */
const filesToInstall = engine=>[...engine.session.files.values()]
    .filter(file=>file.target !== null && componentOf(engine, file.component)?.action
        === INSTALLSTATE.LOCAL)
    .filter(file=>{
        const component = componentOf(engine, file.component);
        return !((Number(component?.attributes ?? 0) & COMPONENT_NEVER_OVERWRITE) !== 0
            && engine.session.machine && engine.host.files.stat(file.target)?.exists);
    });

/**
 * The files to install that the versioning rules say to copy over what is
 * already at their targets, as REINSTALLMODE has them ("omus" when unset).
 *
 * @param {Engine} engine
 */
async function filesToCopy(engine){
    const { session, host } = engine;
    const mode = session.getProperty('REINSTALLMODE') || 'omus';
    /** @type {Map<string, Uint8Array>} */
    const hashes = new Map();
    for (const row of session.db.table('MsiFileHash')?.rows ?? [])
    {
        const words = [row[2], row[3], row[4], row[5]].map(word=>Number(word ?? 0) >>> 0);
        hashes.set(String(row[0]), new Uint8Array(Uint32Array.from(words).buffer));
    }
    const chosen = [];
    for (const file of filesToInstall(engine))
    {
        const target = /** @type {string} */ (file.target);
        const stat = host.files.stat(target);
        const there = stat && stat.exists !== false && !stat.isDirectory;
        // A companion file's Version names the file whose version it shares.
        const version = file.version !== null && session.files.has(file.version)
            ? session.files.get(file.version)?.version ?? null : file.version;
        const existing = there ? {
            version: await host.fileVersion?.(target) ?? null,
            md5: async()=>{
                const bytes = await readFile(host.files, target);
                if (!bytes)
                {
                    return null;
                }
                const md5 = createMd5();
                md5.update(bytes);
                return md5.digest();
            },
        } : null;
        if (await replaces({ version, hash: hashes.get(file.key) ?? null }, existing, mode))
        {
            chosen.push(file);
        }
    }
    return chosen;
}

/**
 * InstallFiles: the files are put down as the script is carried out, so a
 * removal written into the script before them -- an earlier product's, a
 * file the RemoveFile table names -- happens first, as on Windows.
 *
 * @param {Engine} engine
 */
async function installFiles(engine){
    return filesToInstall(engine).length === 0 ? ERROR_SUCCESS
        : schedule(engine, 'InstallFiles', ()=>copyFiles(engine));
}

/**
 * The files to install and where they come from: each component installing
 * locally, its files by sequence, each in the Media row whose range holds it.
 * Each is told to the interface as it is begun and counted on the bar when it
 * is down.
 *
 * @param {Engine} engine
 */
async function copyFiles(engine){
    const { session } = engine;
    const wordCount = Number(session.summary.get(PID.WORDCOUNT)?.value ?? 0);
    const compressedByDefault = (wordCount & 2) !== 0;
    const shortSourceNames = (wordCount & 1) !== 0;
    const wanted = await filesToCopy(engine);
    /** @param {import('./session.js').PackageFile} file */
    const begun = file=>{
        const target = /** @type {string} */ (file.target);
        // ActionText's template for it reads the name from the first field,
        // the size from the sixth and the folder from the ninth.
        return actionData(engine, 'InstallFiles', [file.name, null, null, null, null, file.size,
            null, null, target.slice(0, target.lastIndexOf('\\') + 1)]);
    };
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
            await begun(file);
            const bytes = await readFile(files, source);
            if (!bytes)
            {
                await errorMessage(engine, 1308, [source]);
                return ERROR_INSTALL_FAILURE;
            }
            writeFile(files, /** @type {string} */ (file.target), bytes);
            setAttributes(file);
            await progressed(engine, file.size);
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
            // The machine's copy of a package carries no cabinets: a repair
            // reads them from the package it was installed from.
            const holder = session.db.streamSize(name) !== null ? session.db
                : await engine.host.sourcePackage?.() ?? null;
            const size = holder?.streamSize(name) ?? null;
            if (holder && size !== null)
            {
                source = { size, read: async(offset, length)=>
                    (await holder.readStreamRange(name, offset, length)) ?? new Uint8Array(0) };
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
        const extracting = extractCabinet(source, async entry=>{
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
            await begun(file);
            return {
                write: (offset, bytes)=>{
                    files.write(node, offset, bytes);
                },
                close: async()=>{
                    files.close(node);
                    setAttributes(file);
                    await progressed(engine, file.size);
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
        if (raw === null && name === '-')
        {
            // A key named only to go with its component is not made.
            continue;
        }
        await schedule(engine, 'WriteRegistryValues', async()=>{
            const key = host.hive.create(root, keyPath).key;
            const value = raw === null ? null : session.formatText(raw);
            await actionData(engine, 'WriteRegistryValues', [keyPath, name, value]);
            if (raw === null && (name === null || name === '+' || name === '*' || name === '-'))
            {
                await progressed(engine, REGISTRY_TICKS);
                return;
            }
            const { type, data } = registryValue(value ?? '');
            host.hive.setValue(key, name ?? '', type, data);
            await progressed(engine, REGISTRY_TICKS);
        });
    }
    return ERROR_SUCCESS;
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
        const action = Number(row[6] ?? 0);
        await schedule(engine, 'WriteIniValues', async()=>{
            const bytes = await readFile(host.files, path);
            const text = bytes ? new TextDecoder('latin1').decode(bytes) : '';
            writeFile(host.files, path, encodeAnsi(editIni(text, section, key, value, action)));
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

/**
 * CreateShortcuts: a .lnk for each Shortcut row whose component installs,
 * made in the Shell Link format shell32 reads and writes. A row's Target is
 * a formatted path, or -- for an advertised shortcut -- a feature, whose
 * link runs the component's key file; its icon is the one PublishProduct
 * keeps for the product.
 *
 * @param {Engine} engine
 */
async function createShortcuts(engine){
    const { session, host } = engine;
    /** @param {string | number | null} value */
    const formatted = value=>(value === null ? '' : session.formatText(String(value)));
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
        const advertised = row[4] !== null && session.features.has(String(row[4]));
        const component = session.components.get(String(row[3]));
        const target = advertised
            ? (component?.keyPath ? session.files.get(component.keyPath)?.target ?? '' : '')
            : formatted(row[4]);
        const fields = {
            target,
            arguments: formatted(row[5]),
            description: formatted(row[6]),
            hotkey: row[7] === null ? 0 : Number(row[7]) & 0xffff,
            iconLocation: row[8] === null ? '' : iconPath(engine, String(row[8])),
            iconIndex: row[9] === null ? 0 : Number(row[9]) | 0,
            showCommand: row[10] === null ? SW_SHOWNORMAL : Number(row[10]),
            workingDirectory: row[11] === null ? ''
                : session.folders.get(String(row[11]))?.target ?? formatted(`[${row[11]}]`),
        };
        await schedule(engine, 'CreateShortcuts', async()=>{
            writeFile(host.files, `${directory}${name}`,
                encodeShellLink(fields, path=>host.files.stat(path)));
        });
    }
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
        const variable = environmentRow(String(row[1] ?? ''),
            row[2] === null ? '' : session.formatText(String(row[2])));
        if (variable.name === '')
        {
            continue;
        }
        await schedule(engine, 'WriteEnvironmentStrings', async()=>{
            const key = environmentKey(host.hive, variable.machine);
            const now = host.hive.getValue(key, variable.name);
            const existing = now ? valueText(now) : null;
            const next = installedValue(variable, existing);
            if (next === undefined)
            {
                return;
            }
            if (next === null)
            {
                host.hive.deleteValue(key, variable.name);
                return;
            }
            host.hive.setValue(key, variable.name, now?.type === REG_SZ ? REG_SZ : REG_EXPAND_SZ,
                encodeAnsi(`${next}\0`));
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
        // The machine keeps its own copy of the package, for a repair or a
        // removal once the source is gone; a maintenance run keeps the one
        // it already has.
        const installer = `${normalize(session.getProperty('WindowsFolder'))}Installer\\`;
        const recorded = host.registration.productInfo(productCode, 'LocalPackage');
        const kept = 'value' in recorded && recorded.value.toLowerCase()
            .startsWith(installer.toLowerCase()) ? recorded.value : null;
        const localPackage = kept ?? (session.packagePath.toLowerCase()
            .startsWith(installer.toLowerCase()) ? session.packagePath
            : await host.cachePackage?.(session.packagePath, installer) ?? session.packagePath);
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
            localPackage,
            packageName: session.packagePath.slice(session.packagePath.lastIndexOf('\\') + 1),
            date,
            extras: Object.fromEntries([['HelpLink', 'ARPHELPLINK'],
                ['URLInfoAbout', 'ARPURLINFOABOUT'], ['URLUpdateInfo', 'ARPURLUPDATEINFO'],
                ['HelpTelephone', 'ARPHELPTELEPHONE'], ['Comments', 'ARPCOMMENTS'],
                ['Contact', 'ARPCONTACT'], ['ProductID', 'ProductID'],
                ['RegOwner', 'USERNAME'], ['RegCompany', 'COMPANYNAME']]
                .map(([name, property])=>[name, session.getProperty(property)])
                .concat(session.getProperty('ARPPRODUCTICON') === '' ? []
                    : [['DisplayIcon', iconPath(engine, session.getProperty('ARPPRODUCTICON'))]])
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
        if (component.id && component.action === INSTALLSTATE.ABSENT)
        {
            const id = component.id;
            await schedule(engine, 'ProcessComponents', async()=>{
                host.registration.unregisterComponent(id, productCode);
                component.installed = INSTALLSTATE.ABSENT;
                await progressed(engine, COMPONENT_TICKS);
            });
            continue;
        }
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
            await progressed(engine, COMPONENT_TICKS);
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
            host.registration.registerFeature(productCode, feature.key, list, feature.parent);
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

/**
 * The bar set to what the installation will do, counted as it is done: the
 * files put down, the registry values written, the components registered.
 *
 * @param {Engine} engine
 */
async function installValidate(engine){
    const { session } = engine;
    const files = filesToInstall(engine).reduce((total, file)=>total + file.size, 0);
    const values = (session.db.table('Registry')?.rows ?? [])
        .filter(row=>installing(engine, String(row[5]))).length;
    const components = [...session.components.values()]
        .filter(component=>component.id && installing(engine, component.key)).length;
    await message(engine, INSTALLMESSAGE.PROGRESS, [null, PROGRESS_RESET,
        files + values * REGISTRY_TICKS + components * COMPONENT_TICKS, 0, 0]);
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
    if (productGone(engine))
    {
        await unpublishProduct(engine);
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
    ...REMOVAL_ACTIONS,
    ...CLASS_ACTIONS,
    ...SYSTEM_ACTIONS,
    ...UPGRADE_ACTIONS,
    AppSearch: appSearch,
    CCPSearch: nothing,
    RMCCPSearch: nothing,
    LaunchConditions: launchConditions,
    ValidateProductID: validateProductId,
    CostInitialize: costInitialize,
    FileCost: nothing,
    IsolateComponents: nothing,
    CostFinalize: costFinalize,
    ResolveSource: resolveSource,
    SetODBCFolders: nothing,
    InstallValidate: installValidate,
    InstallInitialize: installInitialize,
    AllocateRegistrySpace: nothing,
    ProcessComponents: processComponents,
    CreateFolders: createFolders,
    InstallFiles: installFiles,
    PatchFiles: nothing,
    DuplicateFiles: duplicateFiles,
    BindImage: nothing,
    CreateShortcuts: createShortcuts,
    WriteRegistryValues: writeRegistryValues,
    WriteIniValues: writeIniValues,
    WriteEnvironmentStrings: writeEnvironmentStrings,
    SelfRegModules: selfRegModules,
    RegisterUser: nothing,
    RegisterProduct: registerProduct,
    PublishFeatures: publishFeatures,
    PublishProduct: publishIcons,
    InstallExecute: installExecute,
    InstallExecuteAgain: installExecute,
    InstallFinalize: installFinalize,
    ExecuteAction: executeAction,
    InstallAdminPackage: nothing,
    InstallSFPCatalogFile: nothing,
    StartApplication: nothing,
    DisableRollback: nothing,
    SetUILevel: nothing,
};
