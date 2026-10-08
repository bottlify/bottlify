/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The standard actions that register what a package installs with the rest
 * of the system: fonts with the font list, services with the service
 * manager, published components under their categories; and MoveFiles, the
 * reboot actions, and the tables for subsystems this machine does not have.
 *
 * A service is registered where advapi32's service manager reads it, but
 * none runs here: starting one is reported as a divergence and the
 * installation goes on, where Windows would have a process for it. ODBC,
 * COM+ and side-by-side assemblies have no subsystem behind them; a package
 * that asks for one has that said once and the rest of it installed.
 */

import { INSTALLSTATE, normalize } from './session.js';
import {
    HKEY_LOCAL_MACHINE, REG_DWORD, REG_EXPAND_SZ, REG_MULTI_SZ, REG_SZ,
} from '../advapi32/registry.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import {
    ERROR_SUCCESS, installing, readFile, removing, schedule, writeFile,
} from './steps.js';
import { removeKeyTree, squashGuid } from './registration.js';
import { parseGuid } from '../ole32/guid.js';

/** @typedef {import('./engine.js').Engine} Engine */

const FONTS_KEY = 'Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
const SERVICES_KEY = 'SYSTEM\\CurrentControlSet\\Services';
const COMPONENTS_KEY = 'Software\\Classes\\Installer\\Components';

/** @param {string} text */
const sz = text=>encodeAnsi(`${text}\0`);
/** @param {number} value */
const dword = value=>new Uint8Array(Uint32Array.of(value >>> 0).buffer);

/** @param {Engine} engine */
const machineRoot = engine=>engine.host.hive.root(HKEY_LOCAL_MACHINE);

/**
 * A TrueType or OpenType font's full name, from its `name` table: the
 * Windows platform's US English record first, then any Windows record, then
 * the Macintosh one. A collection is named by its first font.
 *
 * @param {Uint8Array} bytes @returns {string | null}
 */
export function fontFullName(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (/** @type {number} */ at)=>String.fromCharCode(...bytes.subarray(at, at + 4));
    if (bytes.length < 12)
    {
        return null;
    }
    let base = 0;
    if (tag(0) === 'ttcf')
    {
        base = view.getUint32(12);
    }
    if (base + 12 > bytes.length)
    {
        return null;
    }
    const tables = view.getUint16(base + 4);
    for (let index = 0; index < tables; index++)
    {
        const record = base + 12 + index * 16;
        if (record + 16 > bytes.length || tag(record) !== 'name')
        {
            continue;
        }
        const table = view.getUint32(record + 8);
        if (table + 6 > bytes.length)
        {
            return null;
        }
        const count = view.getUint16(table + 2);
        const strings = table + view.getUint16(table + 4);
        /** @type {{ platform: number, language: number, text: string }[]} */
        const found = [];
        for (let at = 0; at < count; at++)
        {
            const entry = table + 6 + at * 12;
            if (entry + 12 > bytes.length || view.getUint16(entry + 6) !== 4)
            {
                continue;
            }
            const platform = view.getUint16(entry);
            const length = view.getUint16(entry + 8);
            const start = strings + view.getUint16(entry + 10);
            if (start + length > bytes.length)
            {
                continue;
            }
            const raw = bytes.subarray(start, start + length);
            const text = platform === 3 || platform === 0
                ? String.fromCharCode(...Array.from({ length: length >> 1 },
                    (_, unit)=>(raw[unit * 2] << 8) | raw[unit * 2 + 1]))
                : decodeAnsi(raw);
            found.push({ platform, language: view.getUint16(entry + 4), text });
        }
        const chosen = found.find(entry=>entry.platform === 3 && entry.language === 0x409)
            ?? found.find(entry=>entry.platform === 3) ?? found[0];
        return chosen?.text ?? null;
    }
    return null;
}

/**
 * The font list's entry for a Font row: its title, or the font's own name
 * with "(TrueType)" after it as the font folder shows one; and the file, by
 * name alone when it is in the fonts folder.
 *
 * @param {Engine} engine @param {import('./database.js').Row} row
 */
async function fontEntry(engine, row){
    const { session, host } = engine;
    const file = session.files.get(String(row[0]));
    if (!file?.target)
    {
        return null;
    }
    const fonts = normalize(session.getProperty('FontsFolder')).toLowerCase();
    const inFonts = file.target.toLowerCase().startsWith(fonts)
        && !file.target.slice(fonts.length).includes('\\');
    const data = inFonts ? file.name : file.target;
    if (row[1] !== null)
    {
        return { title: String(row[1]), data };
    }
    const bytes = await readFile(host.files, file.target);
    const name = bytes ? fontFullName(bytes) : null;
    return { title: name === null ? file.name : `${name} (TrueType)`, data };
}

/**
 * RegisterFonts: each font a component installs, entered in the font list.
 *
 * @param {Engine} engine
 */
async function registerFonts(engine){
    const { session, host } = engine;
    for (const row of session.db.table('Font')?.rows ?? [])
    {
        const file = session.files.get(String(row[0]));
        if (!file || !installing(engine, file.component))
        {
            continue;
        }
        await schedule(engine, 'RegisterFonts', async()=>{
            const entry = await fontEntry(engine, row);
            if (entry)
            {
                host.hive.setValue(host.hive.create(machineRoot(engine), FONTS_KEY).key,
                    entry.title, REG_SZ, sz(entry.data));
            }
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function unregisterFonts(engine){
    const { session, host } = engine;
    for (const row of session.db.table('Font')?.rows ?? [])
    {
        const file = session.files.get(String(row[0]));
        if (!file || !removing(engine, file.component))
        {
            continue;
        }
        await schedule(engine, 'UnregisterFonts', async()=>{
            const entry = await fontEntry(engine, row);
            const key = host.hive.open(machineRoot(engine), FONTS_KEY);
            if (entry && key)
            {
                host.hive.deleteValue(key, entry.title);
            }
        });
    }
    return ERROR_SUCCESS;
}

/** The characters a descriptor writes a GUID in, five for each 32 bits. */
const BASE85 = '!$%&\'()*+,-.0123456789=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    + '[]^_`abcdefghijklmnopqrstuvwxyz{}~';

/**
 * A GUID as a descriptor packs it: its sixteen bytes as four little-endian
 * numbers, each written in five base-85 digits, the lowest first.
 *
 * @param {string} guid @returns {string | null}
 */
export function packGuid(guid){
    const bytes = parseGuid(guid);
    if (bytes === null)
    {
        return null;
    }
    const view = new DataView(bytes.buffer);
    let text = '';
    for (let word = 0; word < 4; word++)
    {
        let value = view.getUint32(word * 4, true);
        for (let digit = 0; digit < 5; digit++)
        {
            text += BASE85[value % 85];
            value = Math.floor(value / 85);
        }
    }
    return text;
}

/**
 * The descriptor that names a product's feature and component: the packed
 * product code, the feature, and `>` and the packed component code -- or `<`
 * alone when the feature has that one component.
 *
 * @param {string} product @param {string} feature @param {string} component
 * @param {boolean} onlyComponent
 */
export function descriptor(product, feature, component, onlyComponent){
    const packed = packGuid(product);
    const packedComponent = packGuid(component);
    if (packed === null || packedComponent === null)
    {
        return null;
    }
    return onlyComponent ? `${packed}${feature}<` : `${packed}${feature}>${packedComponent}`;
}

/**
 * The PublishComponent rows and the key and value each is filed under.
 *
 * @param {Engine} engine @param {boolean} removal
 */
function publishedComponents(engine, removal){
    const { session } = engine;
    const product = session.getProperty('ProductCode');
    return (session.db.table('PublishComponent')?.rows ?? []).flatMap(row=>{
        const component = session.components.get(String(row[2]));
        const category = squashGuid(String(row[0]));
        if (!component?.id || category === null
            || (removal ? !removing(engine, component.key) : !installing(engine, component.key)))
        {
            return [];
        }
        const feature = session.features.get(String(row[4]));
        const text = descriptor(product, String(row[4]), component.id,
            feature?.components.length === 1);
        return text === null ? [] : [{
            path: `${COMPONENTS_KEY}\\${category}`, qualifier: String(row[1] ?? ''),
            value: `${text}${row[3] === null ? '' : session.formatText(String(row[3]))}`,
        }];
    });
}

/**
 * PublishComponents: each qualified component under its category, as
 * MsiProvideQualifiedComponent finds it.
 *
 * @param {Engine} engine
 */
async function publishComponents(engine){
    const { hive } = engine.host;
    for (const entry of publishedComponents(engine, false))
    {
        await schedule(engine, 'PublishComponents', async()=>{
            hive.setValue(hive.create(machineRoot(engine), entry.path).key, entry.qualifier,
                REG_MULTI_SZ, encodeAnsi(`${entry.value}\0\0`));
        });
    }
    return ERROR_SUCCESS;
}

/** @param {Engine} engine */
async function unpublishComponents(engine){
    const { hive } = engine.host;
    for (const entry of publishedComponents(engine, true))
    {
        await schedule(engine, 'UnpublishComponents', async()=>{
            const key = hive.open(machineRoot(engine), entry.path);
            if (key)
            {
                hive.deleteValue(key, entry.qualifier);
                if (hive.values(key).length === 0)
                {
                    hive.remove(machineRoot(engine), entry.path);
                }
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * InstallServices: each service a component installs, registered with the
 * service manager: its type, start, error control, image -- the component's
 * key file and the row's arguments -- display name, group, dependencies,
 * account and description.
 *
 * @param {Engine} engine
 */
async function installServices(engine){
    const { session, host } = engine;
    for (const row of session.db.table('ServiceInstall')?.rows ?? [])
    {
        const component = session.components.get(String(row[11]));
        if (!component || !installing(engine, component.key))
        {
            continue;
        }
        const keyFile = component.keyPath ? session.files.get(component.keyPath)?.target : null;
        const name = session.formatText(String(row[1] ?? ''));
        const text = (/** @type {number} */ column)=>(row[column] === null ? ''
            : session.formatText(String(row[column])));
        const argumentsText = text(10);
        await schedule(engine, 'InstallServices', async()=>{
            const key = host.hive.create(machineRoot(engine), `${SERVICES_KEY}\\${name}`).key;
            host.hive.setValue(key, 'Type', REG_DWORD, dword(Number(row[3] ?? 0x10)));
            host.hive.setValue(key, 'Start', REG_DWORD, dword(Number(row[4] ?? 3)));
            host.hive.setValue(key, 'ErrorControl', REG_DWORD, dword(Number(row[5] ?? 1)));
            if (keyFile)
            {
                host.hive.setValue(key, 'ImagePath', REG_EXPAND_SZ, sz(argumentsText === ''
                    ? `"${keyFile}"` : `"${keyFile}" ${argumentsText}`));
            }
            /** @type {[string, string][]} */
            const strings = [['DisplayName', text(2)], ['Group', text(6)],
                ['ObjectName', text(8) || 'LocalSystem'], ['Description', text(12)]];
            for (const [value, content] of strings)
            {
                if (content !== '')
                {
                    host.hive.setValue(key, value, REG_SZ, sz(content));
                }
            }
            const dependencies = text(7).split('[~]').join('\0').split('\0')
                .filter(part=>part !== '');
            if (dependencies.length > 0)
            {
                host.hive.setValue(key, 'DependOnService', REG_MULTI_SZ,
                    encodeAnsi(`${dependencies.join('\0')}\0\0`));
            }
        });
    }
    return ERROR_SUCCESS;
}

/** ServiceControl's Event bits: what to do to a service, and when. */
const SERVICE_EVENT = Object.freeze({
    INSTALL_START: 0x1, INSTALL_STOP: 0x2, INSTALL_DELETE: 0x8,
    UNINSTALL_START: 0x10, UNINSTALL_STOP: 0x20, UNINSTALL_DELETE: 0x80,
});

/**
 * The services a ServiceControl event names for now: those whose component
 * is being installed for the install bits, removed for the uninstall ones.
 *
 * @param {Engine} engine @param {number} onInstall @param {number} onRemoval
 */
function controlled(engine, onInstall, onRemoval){
    const { session } = engine;
    return (session.db.table('ServiceControl')?.rows ?? []).filter(row=>{
        const event = Number(row[2] ?? 0);
        const component = String(row[5]);
        return ((event & onInstall) !== 0 && installing(engine, component))
            || ((event & onRemoval) !== 0 && removing(engine, component));
    }).map(row=>session.formatText(String(row[1] ?? '')));
}

/**
 * StartServices: no service runs on this machine, so a start asked for is
 * said once and the installation goes on, the service registered and stopped.
 *
 * @param {Engine} engine
 */
async function startServices(engine){
    for (const name of controlled(engine, SERVICE_EVENT.INSTALL_START,
        SERVICE_EVENT.UNINSTALL_START))
    {
        engine.host.divergence?.('StartServices', `service ${name} is not started: no service`
            + ' runs on this machine');
    }
    return ERROR_SUCCESS;
}

/**
 * DeleteServices: the services a ServiceControl row deletes, taken out of the
 * service manager's list.
 *
 * @param {Engine} engine
 */
async function deleteServices(engine){
    for (const name of controlled(engine, SERVICE_EVENT.INSTALL_DELETE,
        SERVICE_EVENT.UNINSTALL_DELETE))
    {
        await schedule(engine, 'DeleteServices', async()=>{
            removeKeyTree(engine.host.hive, machineRoot(engine), `${SERVICES_KEY}\\${name}`);
        });
    }
    return ERROR_SUCCESS;
}

/** MoveFile's Options: move rather than copy. */
const MOVE_FILE_MOVE = 1;

/**
 * MoveFiles: files already on the machine, by name or wildcard, copied or
 * moved where the MoveFile table says, renamed to its DestName when one file
 * is named.
 *
 * @param {Engine} engine
 */
async function moveFiles(engine){
    const { session, host } = engine;
    /** @param {string | number | null} property */
    const folder = property=>{
        if (property === null)
        {
            return '';
        }
        const value = session.folders.get(String(property))?.target
            ?? session.getProperty(String(property));
        return value === '' ? '' : normalize(value);
    };
    for (const row of session.db.table('MoveFile')?.rows ?? [])
    {
        if (!installing(engine, String(row[1])))
        {
            continue;
        }
        const from = folder(row[4]);
        const to = folder(row[5]);
        if (from === '' || to === '')
        {
            continue;
        }
        const pattern = row[2] === null ? '*' : String(row[2]).split('|').pop() ?? '*';
        const single = !/[*?]/.test(pattern);
        const rename = row[3] === null ? null : String(row[3]).split('|').pop() ?? null;
        const move = (Number(row[6] ?? 0) & MOVE_FILE_MOVE) !== 0;
        await schedule(engine, 'MoveFiles', async()=>{
            for (const entry of host.files.list(from.replace(/\\$/, ''), pattern))
            {
                if (entry.isDirectory)
                {
                    continue;
                }
                const source = `${from}${entry.name}`;
                const target = `${to}${single && rename ? rename : entry.name}`;
                const bytes = await readFile(host.files, source);
                if (bytes && writeFile(host.files, target, bytes) && move)
                {
                    host.files.remove(source);
                }
            }
        });
    }
    return ERROR_SUCCESS;
}

/**
 * ScheduleReboot and ForceReboot: the installation ends asking for a restart,
 * which MsiInstallProduct answers with ERROR_SUCCESS_REBOOT_REQUIRED. This
 * machine does not stop in the middle to restart, so ForceReboot's request
 * waits for the end as well.
 *
 * @param {Engine} engine
 */
async function scheduleReboot(engine){
    engine.session.mode.rebootAtEnd = true;
    return ERROR_SUCCESS;
}

/**
 * The tables of subsystems this machine has none of: a package with rows in
 * them for what it installs is told so once, and the rest installs.
 *
 * @param {string} action @param {string[]} tables @param {number} componentColumn
 * @param {string} why
 * @returns {(engine: Engine) => Promise<number>}
 */
const absent = (action, tables, componentColumn, why)=>async engine=>{
    const { session } = engine;
    const named = tables.some(table=>(session.db.table(table)?.rows ?? []).some(row=>{
        const component = session.components.get(String(row[componentColumn]));
        return component && component.action !== INSTALLSTATE.UNKNOWN;
    }));
    if (named)
    {
        engine.host.divergence?.(action, why);
    }
    return ERROR_SUCCESS;
};

/**
 * The system-registration actions, by name, for the table of standard actions.
 *
 * @type {Record<string, (engine: Engine) => Promise<number>>}
 */
export const SYSTEM_ACTIONS = {
    RegisterFonts: registerFonts,
    UnregisterFonts: unregisterFonts,
    PublishComponents: publishComponents,
    UnpublishComponents: unpublishComponents,
    InstallServices: installServices,
    StartServices: startServices,
    StopServices: async()=>ERROR_SUCCESS,
    DeleteServices: deleteServices,
    MoveFiles: moveFiles,
    ScheduleReboot: scheduleReboot,
    ForceReboot: scheduleReboot,
    InstallODBC: absent('InstallODBC', ['ODBCDriver', 'ODBCTranslator', 'ODBCDataSource'], 1,
        'no ODBC driver manager to register drivers and data sources with'),
    RemoveODBC: absent('RemoveODBC', ['ODBCDriver', 'ODBCTranslator', 'ODBCDataSource'], 1,
        'no ODBC driver manager to take drivers and data sources from'),
    RegisterComPlus: absent('RegisterComPlus', ['Complus'], 0,
        'no COM+ catalog to install applications into'),
    UnregisterComPlus: absent('UnregisterComPlus', ['Complus'], 0,
        'no COM+ catalog to take applications from'),
    MsiPublishAssemblies: absent('MsiPublishAssemblies', ['MsiAssembly'], 0,
        'no side-by-side or global assembly cache to publish assemblies in'),
    MsiUnpublishAssemblies: absent('MsiUnpublishAssemblies', ['MsiAssembly'], 0,
        'no side-by-side or global assembly cache to take assemblies from'),
};
