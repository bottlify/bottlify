/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The redistributables a Steam app declares, installed into its bottle as
 * Steam installs them on a person's machine -- read with the engine's own
 * readers, nothing of the system's.
 *
 * An app's product info names depots of other apps it needs
 * (`depotfromapp`, mostly Steamworks Common Redistributables, 228980: the
 * Visual C++ and DirectX redistributables, each with an `installscript.vdf`),
 * and an install script of its own (`extended.installscript`). Steam
 * downloads the shared depots beside the game and, on the first start, writes
 * the scripts' registry values and runs their `Run Process` programs
 * silently: `vc_redist.x64.exe /q`, `DXSETUP.exe /silent`.
 *
 * The programs are not run here. A Visual C++ redistributable is a bootstrapper
 * (WiX Burn from 2015 on, a self-extractor before) around Windows Installer
 * packages, and what it installs is what those packages' tables say: the
 * files of their components and the registry rows that go with them. So each
 * program is unpacked -- the cabinets appended to it, the packages and
 * cabinets inside those, the cabinets a package keeps as its own streams --
 * and every package found is applied by its tables: a component whose
 * condition holds on the bottle's machine has its files put where its
 * directory resolves to (system32, SysWOW64 for a 32-bit component on a
 * 64-bit machine) and its registry rows written. DirectX's setup carries no
 * package: beside it is a cabinet per component, each with the INF its setup
 * installs it by, and those INFs are applied instead -- their files copied
 * where their DestinationDirs say (`directxFiles`); a library the engine also
 * answers stays the engine's while its table covers what a program imports
 * (the loader's rule for a system copy). The COM servers among them are not
 * registered: that is their own code's to do. Any other program with no
 * package inside is left to the engine.
 * The other programs the app carries are read the same way, and a package of
 * theirs that installs only into the Windows folder is applied too: the
 * prerequisite installer an engine ships and its launcher offers to run
 * (decision A67).
 *
 * What is written goes into the bottle where the engine mounts it back
 * (`@bottlify/core`'s BOTTLE_DRIVE_PATH, BOTTLE_REGISTRY_PATH): files under
 * `.bottlify\drive_c\` by their path from C:\, the registry as a hive's JSON
 * in `.bottlify\registry.json`.
 *
 * The installed app is reached as an `AppTree`, so the one install runs over
 * a directory on a host (tools/redist.mjs, tools/steam-install.mjs) and over a
 * bottle a page writes in the browser (`install.js`).
 */

import { parseText } from './keyvalues.js';
import { readCabinet, decodeFolder } from '../layers/win32/cabinet/cabinet.js';
import { openCompound, bytesSource } from '../layers/win32/msi/compound.js';
import { openDatabase } from '../layers/win32/msi/database.js';
import { evaluateCondition, MSICONDITION } from '../layers/win32/msi/condition.js';

/**
 * An installed app's files, by their backslashed paths in it.
 *
 * @typedef {Object} AppTree
 * @property {() => Promise<string[]>} list  Every file.
 * @property {(path: string) => Promise<Uint8Array>} read  A file `list` names.
 * @property {(path: string, bytes: Uint8Array) => Promise<void>} write  Made or replaced.
 */

/** Where the engine mounts a bottle's files of elsewhere on C:, and its registry. */
export const DRIVE_PATH = '.bottlify\\drive_c';
export const REGISTRY_PATH = '.bottlify\\registry.json';

/** Where a bottle is mounted: what a script's %INSTALLDIR% is. */
export const INSTALL_DIRECTORY = 'C:\\App';

const HKEY_CLASSES_ROOT = 0x80000000;
const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const HKEY_USERS = 0x80000003;
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const REG_BINARY = 3;
const REG_DWORD = 4;
const REG_MULTI_SZ = 7;

/** msidbComponentAttributes64bit: a component of the 64-bit view. */
const COMPONENT_64BIT = 0x100;

/**
 * A key looked up whatever its case: Valve's scripts write `Process 1` and
 * `process 1`, `Run Process` and `run process`.
 *
 * @param {any} node @param {string} name
 */
const field = (node, name)=>{
    if (!node || typeof node !== 'object')
    {
        return undefined;
    }
    const key = Object.keys(node).find(one=>one.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : node[key];
};

const ROOTS = /** @type {Record<string, number>} */ ({
    hkey_local_machine: HKEY_LOCAL_MACHINE, hklm: HKEY_LOCAL_MACHINE,
    hkey_current_user: HKEY_CURRENT_USER, hkcu: HKEY_CURRENT_USER,
    hkey_classes_root: HKEY_CLASSES_ROOT, hkcr: HKEY_CLASSES_ROOT,
    hkey_users: HKEY_USERS,
});

/**
 * @typedef {Object} RegistryWrite
 * @property {number} root  An HKEY_ constant.
 * @property {string} key
 * @property {string} name
 * @property {number} type  A REG_ type.
 * @property {Uint8Array} data  As the registry keeps it.
 */

/** @param {string} text  eight-bit, with its terminator, as the engine's hive keeps a string */
const sz = text=>Uint8Array.from([...text, '\0'], character=>character.charCodeAt(0) & 0xff);

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * A Steam install script: the registry values it writes and the programs it
 * runs, `%INSTALLDIR%` already the bottle's directory.
 *
 * @param {string} text  `installscript.vdf`'s text.
 * @param {string} [installDirectory]
 * @returns {{ registry: RegistryWrite[], runs: { name: string, programs:
 *     { path: string, arguments: string }[], requires64: boolean }[] }}
 */
export function parseInstallScript(text, installDirectory = INSTALL_DIRECTORY){
    const root = parseText(text);
    const script = field(root, 'InstallScript') ?? {};
    /** @param {unknown} value */
    const expand = value=>String(value ?? '').replace(/%INSTALLDIR%/gi, installDirectory);
    /** @type {RegistryWrite[]} */
    const registry = [];
    for (const [path, kinds] of Object.entries(field(script, 'Registry') ?? {}))
    {
        const at = path.indexOf('\\');
        const hive = ROOTS[path.slice(0, at).toLowerCase()];
        if (!hive || typeof kinds !== 'object')
        {
            continue;
        }
        for (const [kind, values] of Object.entries(kinds))
        {
            for (const [name, value] of Object.entries(values ?? {}))
            {
                const isDword = kind.toLowerCase() === 'dword';
                if (isDword || kind.toLowerCase() === 'string')
                {
                    registry.push({ root: hive, key: path.slice(at + 1), name,
                        type: isDword ? REG_DWORD : REG_SZ,
                        data: isDword ? dword(Number(value)) : sz(expand(value)) });
                }
            }
        }
    }
    const runs = Object.entries(field(script, 'Run Process') ?? {}).map(([name, entry])=>{
        const programs = [];
        for (let n = 1; field(entry, `Process ${n}`) !== undefined; n++)
        {
            programs.push({ path: expand(field(entry, `Process ${n}`)),
                arguments: expand(field(entry, `Command ${n}`)) });
        }
        const requirement = field(entry, 'Requirement_OS');
        return { name, programs, requires64: String(field(requirement, 'Is64BitWindows')) === '1' };
    });
    return { registry, runs };
}

const MSCF = [0x4d, 0x53, 0x43, 0x46];
const MZ = [0x4d, 0x5a];
const COMPOUND = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** @param {Uint8Array} bytes @param {number[]} magic @param {number} [at] */
const startsWith = (bytes, magic, at = 0)=>magic.every((byte, i)=>bytes[at + i] === byte);

/**
 * The cabinets inside a file: each `MSCF` header whose size fits, in order --
 * what a self-extractor carries after its stub and a Burn bundle after its engine.
 *
 * @param {Uint8Array} bytes
 */
export function embeddedCabinets(bytes){
    /** @type {Uint8Array[]} */
    const found = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 36 < bytes.length; at++)
    {
        if (startsWith(bytes, MSCF, at) && view.getUint32(at + 4, true) === 0)
        {
            const size = view.getUint32(at + 8, true);
            if (size > 36 && at + size <= bytes.length)
            {
                try
                {
                    readCabinet(bytes.subarray(at, at + size));
                    found.push(bytes.subarray(at, at + size));
                    at += size - 1;
                }
                catch {
                    // A signature that is not a cabinet's header.
                }
            }
        }
    }
    return found;
}

/**
 * Every file a cabinet holds, by its name in the cabinet.
 *
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>}
 */
function cabinetFiles(bytes){
    const cabinet = readCabinet(bytes);
    /** @type {Map<number, Uint8Array>} */
    const folders = new Map();
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    for (const file of cabinet.files)
    {
        if (!folders.has(file.folder))
        {
            folders.set(file.folder, decodeFolder(cabinet, file.folder));
        }
        const stream = /** @type {Uint8Array} */ (folders.get(file.folder));
        files.set(file.name.replace(/^\.\\/, ''), stream.subarray(file.offset, file.offset + file.size));
    }
    return files;
}

/**
 * An INF file's sections, by name lower-cased, each its lines with comments
 * and blank lines dropped.
 *
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
export function parseInf(text){
    /** @type {Map<string, string[]>} */
    const sections = new Map();
    /** @type {string[] | null} */
    let current = null;
    for (const raw of text.split(/\r?\n/))
    {
        const line = raw.replace(/;.*$/, '').trim();
        const head = /^\[(.+)\]$/.exec(line);
        if (head)
        {
            current = [];
            sections.set(head[1].trim().toLowerCase(), current);
        }
        else if (line && current)
        {
            current.push(line);
        }
    }
    return sections;
}

/** A section's `key = value` lines, by key lower-cased. @param {string[] | undefined} lines */
const keyed = lines=>new Map((lines ?? []).filter(line=>line.includes('=')).map(line=>[
    line.slice(0, line.indexOf('=')).trim().toLowerCase(),
    line.slice(line.indexOf('=') + 1).trim().replace(/^"(.*)"$/, '$1')]));

/** The directory ids DirectX's INFs name: the Windows folder and the system folder. */
const DIRECTORY_IDS = /** @type {Record<string, string>} */ ({
    10: 'C:\\WINDOWS', 11: 'C:\\WINDOWS\\system32' });

/**
 * The files DirectX's setup installs from its cabinets on a machine, as their
 * INFs say: each cabinet's Windows NT INF (its 9x one is not this machine's),
 * every install section of it but the other machine's -- `x86_Install` on a
 * 32-bit machine, `x64_Install` (the 32-bit libraries into SysWOW64) on a
 * 64-bit one -- each file its CopyFiles lists put in its DestinationDirs
 * directory. A 32-bit machine takes no 64-bit image. `unregistered` names the
 * libraries an INF has registered as COM servers ([DllRegisterServer]), which
 * this does not do.
 *
 * @param {Uint8Array[]} cabinets
 * @param {'x86' | 'amd64'} machine
 * @returns {{ files: { path: string, bytes: Uint8Array }[], unregistered: string[] }}
 */
export function directxFiles(cabinets, machine){
    /** @type {Map<string, { path: string, bytes: Uint8Array }>} */
    const files = new Map();
    /** @type {Set<string>} */
    const unregistered = new Set();
    const other = machine === 'amd64' ? 'x86_install' : 'x64_install';
    for (const bytes of cabinets)
    {
        /** @type {Map<string, { name: string, bytes: Uint8Array }>} */
        const inside = new Map();
        try
        {
            for (const [name, content] of cabinetFiles(bytes))
            {
                inside.set(name.toLowerCase(), { name, bytes: content });
            }
        }
        catch {
            continue;
        }
        for (const [name, { bytes: text }] of inside)
        {
            if (!name.endsWith('.inf'))
            {
                continue;
            }
            const inf = parseInf(latin1(text));
            if (!/^\$windows nt\$$/i.test(keyed(inf.get('version')).get('signature') ?? ''))
            {
                continue;
            }
            const directories = keyed(inf.get('destinationdirs'));
            let copied = false;
            for (const [section, lines] of inf)
            {
                const lists = section === other ? undefined : keyed(lines).get('copyfiles');
                for (const list of lists ? lists.split(',').map(one=>one.trim().toLowerCase()) : [])
                {
                    const [id, below] = (directories.get(list)
                        ?? directories.get('defaultdestdir') ?? '').split(',').map(one=>one.trim());
                    const directory = DIRECTORY_IDS[id];
                    for (const line of directory ? inf.get(list) ?? [] : [])
                    {
                        const file = inside.get(line.split(',')[0].trim().toLowerCase());
                        if (!file || (machine === 'x86' && /\.(dll|exe)$/i.test(file.name)
                            && imageMachine(file.bytes.subarray(0, 4096)) !== 'x86'))
                        {
                            continue;
                        }
                        const path = `${directory}${below ? `\\${below}` : ''}\\${file.name}`;
                        files.set(path.toLowerCase(), { path, bytes: file.bytes });
                        copied = true;
                    }
                }
            }
            for (const line of copied ? inf.get('dllregisterserver') ?? [] : [])
            {
                unregistered.add(line.slice(line.lastIndexOf('\\') + 1));
            }
        }
    }
    return { files: [...files.values()], unregistered: [...unregistered].sort() };
}

/**
 * The installer packages a program carries and every file of every cabinet
 * around and inside them: the cabinets appended to it, the cabinets and
 * packages inside those, and the cabinets a package keeps as its own streams.
 * A cabinet's files are named as it names them -- a package's file keys --
 * lower-cased, every file of a name kept: a bootstrapper that chains the x86
 * and the x64 runtime carries two `vcruntime140.dll`s.
 *
 * @param {Uint8Array} program
 * @returns {Promise<{ packages: import('../layers/win32/msi/database.js').Database[],
 *     files: Map<string, Uint8Array[]> }>}
 */
export async function unpackRedistributable(program){
    /** @type {import('../layers/win32/msi/database.js').Database[]} */
    const packages = [];
    /** @type {Map<string, Uint8Array[]>} */
    const files = new Map();
    /** @param {Uint8Array} bytes @param {number} depth */
    const visit = async(bytes, depth)=>{
        if (depth > 4)
        {
            return;
        }
        if (startsWith(bytes, COMPOUND))
        {
            const compound = await openCompound(bytesSource(bytes));
            packages.push(await openDatabase(compound));
            for (const node of compound.root.children.values())
            {
                if (node.kind === 'stream' && node.size > 36)
                {
                    const data = await compound.readAll(node);
                    if (startsWith(data, MSCF))
                    {
                        await visit(data, depth + 1);
                    }
                }
            }
            return;
        }
        for (const cabinet of startsWith(bytes, MSCF) ? [bytes] : embeddedCabinets(bytes))
        {
            for (const [name, data] of cabinetFiles(cabinet))
            {
                files.set(name.toLowerCase(), [...files.get(name.toLowerCase()) ?? [], data]);
                // A bootstrapper chains others: a Burn bundle's packages are
                // programs as often as installer databases.
                if (startsWith(data, MSCF) || startsWith(data, COMPOUND) || startsWith(data, MZ))
                {
                    await visit(data, depth + 1);
                }
            }
        }
    };
    await visit(program, 0);
    return { packages, files };
}

/** @param {any} db @param {string} name @returns {Record<string, any>[]} */
const rowsOf = (db, name)=>{
    const table = db.table(name);
    if (!table)
    {
        return [];
    }
    return table.rows.map((/** @type {any[]} */ row)=>Object.fromEntries(
        table.columns.map((/** @type {any} */ column, /** @type {number} */ at)=>[column.name, row[at]])));
};

/** A name of the Directory or File table: `short|long`, the long one wanted. @param {string} name */
const longName = name=>String(name ?? '').split('|').pop() ?? '';

/**
 * A package's files and registry rows as a bottle on `machine` gets them:
 * every component whose condition holds, its files where its directory
 * resolves to -- the system folders and the Windows folder; a file anywhere
 * else is left out -- and its registry rows, `[Property]` references read
 * from the package's Property table.
 *
 * @param {any} db  An opened package (`unpackRedistributable`).
 * @param {Map<string, Uint8Array[]>} cabinetFilesByKey  By lower-cased file key; the
 *     one of a key whose size is the File table's is the package's.
 * @param {'x86' | 'amd64'} machine
 * @returns {{ files: { path: string, bytes: Uint8Array }[], registry: RegistryWrite[],
 *     skipped: string[] }}
 */
export function applyPackage(db, cabinetFilesByKey, machine){
    const wide = machine === 'amd64';
    const properties = new Map(rowsOf(db, 'Property')
        .map(row=>[row.Property, String(row.Value ?? '')]));
    // What the machine says of itself: Windows 7's version, and on a 64-bit
    // one the 64-bit properties a package's conditions read.
    properties.set('VersionNT', '601');
    properties.set('WindowsBuild', '7601');
    properties.set('ALLUSERS', '1');
    if (wide)
    {
        properties.set('VersionNT64', '601');
        properties.set('Msix64', '601');
    }
    else
    {
        properties.set('Intel', '6');
    }
    const env = { property: (/** @type {string} */ name)=>properties.get(name) ?? '' };

    /** @type {Record<string, string>} */
    const folders = {
        WindowsFolder: 'C:\\WINDOWS',
        SystemFolder: wide ? 'C:\\WINDOWS\\SysWOW64' : 'C:\\WINDOWS\\system32',
        ...wide ? { System64Folder: 'C:\\WINDOWS\\system32' } : {},
    };
    /** @param {string} text */
    const format = text=>text.replace(/\[([A-Za-z_][\w.]*)\]/g,
        (_, name)=>folders[name] ?? properties.get(name) ?? '');
    // A merge module's folders are its own names, set to the system's by the
    // package's custom actions that set a directory or a property (types 35
    // and 51) -- run here as the execute sequence would, the others not at all.
    const actions = new Map(rowsOf(db, 'CustomAction').map(row=>[row.Action, row]));
    for (const step of rowsOf(db, 'InstallExecuteSequence')
        .sort((a, b)=>Number(a.Sequence) - Number(b.Sequence)))
    {
        const action = actions.get(step.Action);
        const kind = Number(action?.Type ?? 0) & 0x3f;
        if (action && (kind === 35 || kind === 51) && (!step.Condition
            || evaluateCondition(String(step.Condition), env) !== MSICONDITION.FALSE))
        {
            const value = format(String(action.Target ?? '')).replace(/\\+$/, '');
            if (value)
            {
                folders[action.Source] = value;
                properties.set(action.Source, value);
            }
        }
    }
    const directories = new Map(rowsOf(db, 'Directory').map(row=>[row.Directory, row]));
    /** @type {Map<string, string | null>} */
    const resolved = new Map();
    /** @param {string} id @param {number} depth @returns {string | null} */
    const resolve = (id, depth = 0)=>{
        if (folders[id])
        {
            return folders[id];
        }
        if (resolved.has(id))
        {
            return /** @type {string | null} */ (resolved.get(id));
        }
        const row = directories.get(id);
        let path = null;
        if (row && row.Directory_Parent && row.Directory_Parent !== id && depth < 32)
        {
            const parent = resolve(row.Directory_Parent, depth + 1);
            // DefaultDir is `target:source`; "." is the parent itself.
            const name = longName(String(row.DefaultDir ?? '').split(':')[0]);
            path = parent === null ? null
                : name === '.' || name === '' ? parent : `${parent}\\${name}`;
        }
        resolved.set(id, path);
        return path;
    };

    const installed = new Map();
    /** @type {string[]} */
    const skipped = [];
    for (const component of rowsOf(db, 'Component'))
    {
        const attributes = Number(component.Attributes ?? 0);
        if ((attributes & COMPONENT_64BIT) && !wide)
        {
            continue;
        }
        const condition = String(component.Condition ?? '');
        if (condition && evaluateCondition(condition, env) === MSICONDITION.FALSE)
        {
            continue;
        }
        // Its registry rows go in wherever its files would; a 64-bit
        // component's SystemFolder is the 64-bit one.
        const directory = resolve(String(component.Directory_));
        installed.set(component.Component, (attributes & COMPONENT_64BIT) && wide
            && directory === folders.SystemFolder ? folders.System64Folder : directory);
    }

    /** @type {{ path: string, bytes: Uint8Array }[]} */
    const files = [];
    for (const file of rowsOf(db, 'File'))
    {
        const directory = installed.get(file.Component_);
        if (directory === undefined)
        {
            continue;
        }
        if (directory === null)
        {
            skipped.push(`${file.File}: its directory is not a Windows folder`);
            continue;
        }
        const bytes = cabinetFilesByKey.get(String(file.File).toLowerCase())
            ?.find(one=>one.length === Number(file.FileSize));
        if (!bytes)
        {
            skipped.push(`${file.File}: in no cabinet the program carries`);
            continue;
        }
        files.push({ path: `${directory}\\${longName(file.FileName)}`, bytes });
    }

    const roots = [HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS];
    /** @type {RegistryWrite[]} */
    const registry = [];
    for (const row of rowsOf(db, 'Registry'))
    {
        const name = row.Name === null || row.Name === undefined ? '' : String(row.Name);
        if (!installed.has(row.Component_) || row.Value === null || row.Value === undefined
            || ['+', '-', '*'].includes(name))
        {
            continue;
        }
        // -1 is the per-machine root for an installation for all users.
        const root = Number(row.Root) === -1 ? HKEY_LOCAL_MACHINE : roots[Number(row.Root)];
        if (root === undefined)
        {
            continue;
        }
        registry.push({ root, key: format(String(row.Key)), name: format(name),
            ...registryValue(format(String(row.Value))) });
    }
    return { files, registry, skipped };
}

/**
 * A Registry table's value as the registry keeps it: `#n` a DWORD, `#xhex`
 * binary, `#%text` an expandable string, `[~]` separating a multi-string's
 * parts, anything else a string (`##` a string starting with `#`).
 *
 * @param {string} value
 * @returns {{ type: number, data: Uint8Array }}
 */
export function registryValue(value){
    if (value.startsWith('##'))
    {
        return { type: REG_SZ, data: sz(value.slice(1)) };
    }
    if (/^#x/i.test(value))
    {
        const hex = value.slice(2).replace(/[^0-9a-f]/gi, '');
        return { type: REG_BINARY,
            data: Uint8Array.from(hex.match(/../g) ?? [], pair=>parseInt(pair, 16)) };
    }
    if (value.startsWith('#%'))
    {
        return { type: REG_EXPAND_SZ, data: sz(value.slice(2)) };
    }
    if (value.startsWith('#'))
    {
        return { type: REG_DWORD, data: dword(Number(value.slice(1))) };
    }
    if (value.includes('[~]'))
    {
        const parts = value.split('[~]').filter(Boolean);
        return { type: REG_MULTI_SZ,
            data: Uint8Array.from([...parts.join('\0'), '\0', '\0'], c=>c.charCodeAt(0) & 0xff) };
    }
    return { type: REG_SZ, data: sz(value) };
}

/**
 * Registry writes laid into a hive's JSON (`toJSON`'s form), over what it
 * already holds.
 *
 * @param {any} hive  `{ roots: [{ id, key }] }`, or null for an empty one.
 * @param {RegistryWrite[]} writes
 */
export function writeRegistry(hive, writes){
    const stored = hive ?? { roots: [] };
    for (const write of writes)
    {
        let root = stored.roots.find((/** @type {any} */ one)=>one.id === write.root);
        if (!root)
        {
            root = { id: write.root, key: { name: '', values: [], keys: [] } };
            stored.roots.push(root);
        }
        let key = root.key;
        for (const part of write.key.split('\\').filter(Boolean))
        {
            let next = key.keys.find((/** @type {any} */ one)=>one.name.toLowerCase() === part.toLowerCase());
            if (!next)
            {
                next = { name: part, values: [], keys: [] };
                key.keys.push(next);
            }
            key = next;
        }
        const value = { name: write.name, type: write.type, data: [...write.data] };
        const at = key.values.findIndex((/** @type {any} */ one)=>one.name.toLowerCase() === write.name.toLowerCase());
        if (at >= 0)
        {
            key.values[at] = value;
        }
        else
        {
            key.values.push(value);
        }
    }
    return stored;
}

/** A guest path on C: as the bottle carries it. @param {string} path */
const carried = path=>`${DRIVE_PATH}\\${path.replace(/^C:\\/i, '')}`;

/**
 * Bytes as characters of the same codes -- ISO 8859-1, which TextDecoder's
 * 'latin1' is not: it is windows-1252, and 0x80 would come back as the euro sign.
 *
 * @param {Uint8Array} bytes
 */
const latin1 = bytes=>{
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000)
    {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return text;
};

/**
 * The programs a step runs: the program itself, or for a batch file the
 * programs it starts from beside itself (`"%~dp0\vc_redist.x64" /q`), as
 * Valve's redistributable scripts do -- the name as written, or with `.exe`.
 *
 * @param {AppTree} tree
 * @param {(path: string) => string | undefined} find  A file's path as the tree has it,
 *     whatever its case.
 * @param {string} inside  The program's path in the app.
 * @returns {Promise<string[]>}
 */
export async function batchPrograms(tree, find, inside){
    if (!/\.(cmd|bat)$/i.test(inside))
    {
        return [inside];
    }
    const text = latin1(await tree.read(inside));
    const folder = inside.slice(0, inside.lastIndexOf('\\') + 1);
    return [...text.matchAll(/%~dp0\\?([^"\r\n]+?)(?="|\s|$)/gi)].flatMap(([, name])=>{
        const found = [name, `${name}.exe`].map(one=>find(folder + one)).find(Boolean);
        return found ? [found] : [];
    });
}

/** Whether version `a` is before `b`, field by field. @param {string} a @param {string} b */
export function compareVersions(a, b){
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let at = 0; at < Math.max(left.length, right.length); at++)
    {
        const difference = (left[at] || 0) - (right[at] || 0);
        if (difference !== 0)
        {
            return difference;
        }
    }
    return 0;
}

/** A path in the bottle's Windows folder: where a runtime installs. @param {string} path */
const inWindows = path=>/^C:\\WINDOWS\\/i.test(path);

/**
 * The tree's files by their folded paths: Windows finds a file whatever the
 * case a script writes its name in, `/` or `\`.
 *
 * @param {AppTree} tree
 */
async function finder(tree){
    const paths = (await tree.list()).sort();
    const byFolded = new Map(paths.map(path=>[path.toLowerCase(), path]));
    return {
        paths,
        /** @param {string | undefined} path @returns {string | undefined} */
        find: path=>(path ? byFolded.get(path.replace(/\//g, '\\').toLowerCase()) : undefined),
    };
}

/**
 * Installs an installed app's redistributables into it, the bottle-to-be, as
 * Steam and the app's own prerequisite installer would on a first start:
 *
 * - its Steam install scripts' registry values, and every package the
 *   programs they run carry -- what Steam runs on every machine;
 * - every package of the other programs the app carries -- the prerequisite
 *   installer an engine ships, a folder of redistributables no script names
 *   -- whose files all go into the Windows folder: a runtime the program asks
 *   for before it starts, where Windows would run that installer on the
 *   person's say-so (decision A67).
 *
 * The packages are applied oldest product version first, so where two carry
 * one runtime -- Visual C++ 2015's and 2019's `vcruntime140.dll` -- the newer
 * one's files and registry values are what the bottle keeps, as the newer
 * installer replaces the older's on Windows. Each program's outcome is a line
 * of the answer.
 *
 * @param {AppTree} tree  The installed app, mounted at `INSTALL_DIRECTORY`.
 * @param {string[]} scripts  The scripts, as paths in it.
 * @param {'x86' | 'amd64'} machine  The bottle's machine: its program's width.
 * @returns {Promise<string[]>}
 */
export async function installRedistributables(tree, scripts, machine){
    const { paths, find } = await finder(tree);
    /** @type {string[]} */
    const said = [];
    /** @type {RegistryWrite[]} */
    const registry = [];
    /** @type {Map<string, string>} The programs the scripts run, by their folded path. */
    const declared = new Map();
    for (const script of scripts)
    {
        const { registry: values, runs } = parseInstallScript(
            latin1(await tree.read(find(script) ?? script)));
        registry.push(...values);
        for (const run of runs)
        {
            if (run.requires64 && machine !== 'amd64')
            {
                said.push(`${script}: ${run.name}: for 64-bit Windows, not run`);
                continue;
            }
            for (const program of run.programs)
            {
                const inside = /^C:\\App\\/i.test(program.path)
                    ? find(program.path.replace(/^C:\\App\\/i, '')) : undefined;
                if (!inside)
                {
                    said.push(`${script}: ${run.name}: ${program.path} is not in the app`);
                    continue;
                }
                for (const one of await batchPrograms(tree, find, inside))
                {
                    declared.set(one.toLowerCase(), one);
                }
            }
        }
    }

    /** @type {{ version: string, files: { path: string, bytes: Uint8Array }[], registry: RegistryWrite[] }[]} */
    const chosen = [];
    // The other programs the app carries: what may be a bootstrapper.
    const carriedPrograms = paths.filter(path=>/\.(exe|msi)$/i.test(path)
        && !path.toLowerCase().startsWith('.bottlify\\') && !declared.has(path.toLowerCase()));
    for (const inside of [...declared.values(), ...carriedPrograms])
    {
        const named = declared.has(inside.toLowerCase());
        const { packages, files } = await unpackRedistributable(await tree.read(inside));
        if (named && packages.length === 0)
        {
            // DirectX's setup: the cabinets in its own folder.
            const folder = inside.slice(0, inside.lastIndexOf('\\') + 1).toLowerCase();
            const cabinets = await Promise.all(paths.filter(path=>/\.cab$/i.test(path)
                && path.toLowerCase().startsWith(folder)
                && !path.slice(folder.length).includes('\\')).map(path=>tree.read(path)));
            const directx = directxFiles(cabinets, machine);
            if (directx.files.length === 0)
            {
                said.push(`${inside}: no installer package inside; left to the engine`);
                continue;
            }
            chosen.push({ version: '0', files: directx.files, registry: [] });
            said.push(`${inside}: ${directx.files.length} file(s) by its cabinets' INFs`
                + `${directx.unregistered.length > 0
                    ? `, not registered: ${directx.unregistered.join(', ')}` : ''}`);
            continue;
        }
        const applied = packages.map(db=>({
            version: String(rowsOf(db, 'Property')
                .find(row=>row.Property === 'ProductVersion')?.Value ?? '0'),
            ...applyPackage(db, files, machine),
        })).filter(one=>named || (one.files.length > 0
            && one.files.every(file=>inWindows(file.path))
            && !one.skipped.some(line=>line.includes('not a Windows folder'))));
        if (applied.length > 0)
        {
            chosen.push(...applied);
            said.push(`${inside}: ${applied.length} package(s), `
                + `${applied.reduce((sum, one)=>sum + one.files.length, 0)} file(s)`
                + `${named ? '' : ', the app\'s own'}`);
        }
    }

    /** @type {Map<string, { path: string, bytes: Uint8Array }>} The last of each path. */
    const files = new Map();
    for (const one of chosen.sort((a, b)=>compareVersions(a.version, b.version)))
    {
        registry.push(...one.registry);
        for (const file of one.files)
        {
            files.set(file.path.toLowerCase(), file);
        }
    }
    for (const file of files.values())
    {
        await tree.write(carried(file.path), file.bytes);
    }
    if (registry.length > 0)
    {
        const kept = find(REGISTRY_PATH);
        const hive = kept ? JSON.parse(new TextDecoder().decode(await tree.read(kept))) : null;
        await tree.write(REGISTRY_PATH,
            new TextEncoder().encode(JSON.stringify(writeRegistry(hive, registry))));
    }
    said.push(`redistributables: ${files.size} file(s), ${registry.length} registry value(s)`);
    return said;
}

/**
 * A PE image's machine: `amd64` for an x86-64 one, else `x86`.
 *
 * @param {Uint8Array} bytes  Its first few kilobytes are enough.
 * @returns {'x86' | 'amd64'}
 */
export function imageMachine(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = bytes.length >= 0x40 ? view.getUint32(0x3c, true) : 0;
    return at + 6 <= bytes.length && view.getUint16(at + 4, true) === 0x8664 ? 'amd64' : 'x86';
}

/**
 * What Steam does on an installed app's first start: the install scripts of
 * the app (`extended.installscript` in its product info) and of the
 * redistributables' depots it took (each an `installscript.vdf`) run on the
 * machine its program is for -- how tools/steam-install.mjs and an install in
 * the browser both finish.
 *
 * @param {AppTree} tree
 * @param {Object} what
 * @param {string} [what.installscript]  The app's own, as its product info names it.
 * @param {string[]} what.shared  The paths of the redistributables' depots' files.
 * @param {string} [what.executable]  The program Steam starts: its width is the machine's.
 * @returns {Promise<string[]>}
 */
export async function installSteamRedistributables(tree, { installscript, shared, executable }){
    const { find } = await finder(tree);
    const scripts = [installscript, ...shared.filter(name=>/(^|\\)installscript\.vdf$/i.test(name))]
        .map(find).filter(/** @returns {path is string} */ path=>path !== undefined);
    const program = find(executable);
    const machine = program ? imageMachine((await tree.read(program)).subarray(0, 4096)) : 'x86';
    return installRedistributables(tree, scripts, machine);
}
