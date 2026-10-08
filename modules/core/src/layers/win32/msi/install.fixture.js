/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A machine and a package for the installation tests: a fresh volume and
 * registry, a database made from tables written out in the test, and a run
 * of a sequence over them as one installation -- each run a session of its
 * own that starts from what the machine recorded, as MsiInstallProduct and
 * MsiConfigureProduct start one.
 */

import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';
import { createHive } from '../advapi32/registry.js';
import { windowsVersion } from '../kernel32/versions.js';
import { createEmptyDatabase } from './database.js';
import { INSTALLSTATE, createSession } from './session.js';
import { runSequence } from './actions.js';
import { createRegistration, valueText } from './registration.js';

/** @type {import('./session.js').Machine} */
export const MACHINE = {
    windows: windowsVersion(), computerName: 'PC', userName: 'User', userSid: 'S-1-5-21-1',
    language: 0x409, screenWidth: 1024, screenHeight: 768, colorBits: 32,
    memoryMegabytes: 512, tempFolder: 'C:\\WINDOWS\\TEMP\\', environment: ()=>null,
    now: ()=>new Date(2026, 0, 1),
};

/** @typedef {Record<string, [string[], (string | number | null)[][]]>} Tables */

/**
 * A database of the tables given, columns in the order written.
 *
 * @param {Tables} tables @param {Record<string, Uint8Array>} [streams]
 */
export function packageDatabase(tables, streams = {}){
    const db = createEmptyDatabase();
    for (const [name, [columns, rows]] of Object.entries(tables))
    {
        db.tables.set(name, {
            name, rows, temporary: false, temporaryRows: new Set(), hold: 0,
            columns: columns.map((column, index)=>({ table: name, number: index + 1,
                name: column, type: 0 })),
        });
    }
    for (const [name, bytes] of Object.entries(streams))
    {
        db.writeStream(name, bytes);
    }
    return db;
}

/**
 * A database whose columns are typed as a package's schema types them --
 * a column holding numbers a nullable long, any other a nullable string, the
 * first the key -- so it writes to a file and reads back the same.
 *
 * @param {import('./database.js').Database} db
 */
export function typed(db){
    db.tables.forEach(table=>{
        if (table.name.startsWith('_'))
        {
            // The database's own tables are typed already.
            return;
        }
        for (const column of table.columns)
        {
            column.type = table.rows.some(row=>typeof row[column.number - 1] === 'number')
                ? 0x1104 : 0x19ff;
        }
        table.columns[0].type = (table.columns[0].type | 0x2000) & ~0x1000;
    });
    return db;
}

/**
 * A machine: a volume with the folders given made and files written, and a
 * registry with the installer's records over it.
 *
 * @param {string[]} [folders] @param {Record<string, string | Uint8Array>} [files]
 */
export async function machine(folders = [], files = {}){
    const volume = /** @type {any} */ (createVolume(await filesystemModule.create({})));
    for (const path of ['C:\\Program Files', 'C:\\WINDOWS', ...folders])
    {
        volume.mkdir(path);
    }
    for (const [path, content] of Object.entries(files))
    {
        const node = volume.open(path, { write: true, create: true });
        volume.write(node, 0, typeof content === 'string' ? new TextEncoder().encode(content)
            : content);
        volume.close(node);
    }
    const hive = /** @type {any} */ (createHive());
    return { files: volume, hive, registration: createRegistration(hive) };
}

/**
 * Runs the execute sequence of a package as one installation.
 *
 * @param {Awaited<ReturnType<typeof machine>>} host @param {Tables} tables
 * @param {string} commandLine @param {Record<string, any>} [extra]  More of the engine's host.
 * @param {Record<string, Uint8Array>} [streams]
 */
export async function run(host, tables, commandLine, extra = {}, streams = {}){
    const { registration } = host;
    const session = createSession({
        db: packageDatabase(tables, streams), packagePath: 'C:\\src\\test.msi', machine: MACHINE,
        commandLine,
        isInstalled: code=>registration.productState(code) === INSTALLSTATE.DEFAULT,
        installed: {
            feature: registration.featureInstalled,
            component: (product, id)=>registration.componentPath(product, id) !== null,
            sharedWith: registration.sharedWith,
        },
    });
    session.setProperty('ProgramFilesFolder', 'C:\\Program Files\\');
    /** @type {{ api: string, detail: string }[]} */
    const divergences = [];
    const engine = /** @type {any} */ ({
        session, thread: null, ran: new Set(), commit: [], async: [], executing: true,
        host: { ...host, message: ()=>0, log: ()=>{}, callDll: async()=>0,
            divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
                void divergences.push({ api, detail }),
            ...extra },
    });
    const code = await runSequence(engine, 'InstallExecuteSequence');
    return { code, session, divergences };
}

/**
 * A file's text, or null when there is none.
 *
 * @param {any} files @param {string} path
 */
export async function text(files, path){
    const stat = files.stat(path);
    if (!stat || stat.exists === false || stat.isDirectory)
    {
        return null;
    }
    const node = files.open(path, { read: true });
    const bytes = await files.read(node, 0, stat.size);
    files.close(node);
    return new TextDecoder('latin1').decode(bytes);
}

/**
 * A registry value's text, or null when the key or value is not there.
 *
 * @param {any} hive @param {number} root @param {string} path @param {string} name
 */
export function registryText(hive, root, path, name){
    const key = hive.open(hive.root(root), path);
    return key ? valueText(hive.getValue(key, name)) : null;
}

/**
 * The sequence an ordinary package runs, every standard action this engine
 * knows in Windows' own order; the registration steps skipped on a removal.
 *
 * @type {[string, string | null, number][]}
 */
export const EXECUTE_SEQUENCE = [
    ['FindRelatedProducts', null, 200], ['CostInitialize', null, 800], ['FileCost', null, 900],
    ['CostFinalize', null, 1000], ['MigrateFeatureStates', null, 1200],
    ['InstallValidate', null, 1400], ['InstallInitialize', null, 1500],
    ['RemoveExistingProducts', null, 1525], ['ProcessComponents', null, 1600],
    ['UnpublishComponents', null, 1700], ['UnpublishFeatures', null, 1800],
    ['StopServices', null, 1900], ['DeleteServices', null, 2000],
    ['UnregisterComPlus', null, 2100], ['SelfUnregModules', null, 2200],
    ['UnregisterTypeLibraries', null, 2300], ['RemoveODBC', null, 2400],
    ['UnregisterFonts', null, 2500], ['RemoveRegistryValues', null, 2600],
    ['UnregisterClassInfo', null, 2700], ['UnregisterExtensionInfo', null, 2800],
    ['UnregisterProgIdInfo', null, 2900], ['UnregisterMIMEInfo', null, 3000],
    ['RemoveIniValues', null, 3100], ['RemoveShortcuts', null, 3200],
    ['RemoveEnvironmentStrings', null, 3300], ['RemoveDuplicateFiles', null, 3400],
    ['RemoveFiles', null, 3500], ['RemoveFolders', null, 3600], ['CreateFolders', null, 3700],
    ['MoveFiles', null, 3800], ['InstallFiles', null, 4000], ['PatchFiles', null, 4090],
    ['DuplicateFiles', null, 4210],
    ['InstallODBC', null, 5400], ['InstallServices', null, 5800],
    ['StartServices', null, 5900], ['RegisterClassInfo', null, 4600],
    ['RegisterExtensionInfo', null, 4700], ['RegisterProgIdInfo', null, 4800],
    ['RegisterMIMEInfo', null, 4900], ['WriteRegistryValues', null, 5000],
    ['WriteIniValues', null, 5100], ['WriteEnvironmentStrings', null, 5200],
    ['RegisterFonts', null, 5300], ['RegisterTypeLibraries', null, 5500],
    ['SelfRegModules', null, 5600], ['RegisterProduct', 'NOT REMOVE~="ALL"', 6100],
    ['PublishComponents', null, 6200], ['PublishFeatures', 'NOT REMOVE~="ALL"', 6300],
    ['PublishProduct', 'NOT REMOVE~="ALL"', 6400], ['InstallFinalize', null, 6600],
];
