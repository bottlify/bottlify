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
 * (the loader's rule for a system copy). The COM servers among them, and the
 * libraries a package's SelfReg table names, register themselves at the
 * bottle's next start: each is left a RunOnce value, regsvr32 on its path,
 * since registering is their own code's to do and none runs here. Any other program with no
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
 * a directory on a host (bottlify-ui/gamehub/tools/steam-install.mjs) and over a
 * bottle a page writes in the browser (`install.js`).
 */

import { parseText } from './keyvalues.js';
import { readCabinet } from '../layers/win32/cabinet/cabinet.js';
import { cabinetFiles, directxFiles, DIRECTX_CABINET, imageMachine, latin1, parseInf }
    from '../layers/win32/dsetup/redistributable.js';
import { openCompound, bytesSource } from '../layers/win32/msi/compound.js';
import { openDatabase } from '../layers/win32/msi/database.js';
import { evaluateCondition, MSICONDITION } from '../layers/win32/msi/condition.js';
import { managedImageOf } from '../layers/win32/mscoree/need.js';
import { utf8 } from '../system/text.js';

export { directxFiles, imageMachine, parseInf };

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

/** Where a logon finds what to run once (`programs/runonce.js`), below HKEY_LOCAL_MACHINE. */
const RUN_ONCE_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';

/**
 * A library an installer registers as a COM server (an INF's
 * [DllRegisterServer], a package's SelfReg row), left for the bottle's next
 * logon to register: the install runs no guest code, and regsvr32 run from
 * RunOnce calls the library's own DllRegisterServer, as the setup would have.
 *
 * @param {string} path
 * @returns {RegistryWrite}
 */
const registerAtLogon = path=>({ root: HKEY_LOCAL_MACHINE, key: RUN_ONCE_KEY, name: path,
    type: REG_SZ, data: sz(`regsvr32.exe /s "${path}"`) });

/**
 * The RunOnce values for the COM servers a DirectX INF registers, each where
 * its file was put.
 *
 * @param {{ files: { path: string }[], unregistered: string[] }} directx
 */
const directxRegistrations = directx=>directx.files
    .filter(file=>directx.unregistered.some(name=>file.path.toLowerCase()
        .endsWith(`\\${name.toLowerCase()}`)))
    .map(file=>registerAtLogon(file.path));

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

/** Windows Installer's program, by its name in a path. */
const MSIEXEC = /(?:^|\\)msiexec(?:\.exe)?$/i;
/** The package msiexec's arguments name: after /package or /i, quoted or not. */
const MSIEXEC_PACKAGE = /(?:^|\s)[/-](?:package|i)\s+(?:"([^"]+)"|(\S+))/i;

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
            const path = expand(field(entry, `Process ${n}`));
            const args = expand(field(entry, `Command ${n}`));
            // Windows Installer run on a package the app carries: the program
            // is the package its /package or /i names, not msiexec, which is
            // Windows' own and never in the app (XNA Framework 4.0's).
            const msi = MSIEXEC.test(path) ? MSIEXEC_PACKAGE.exec(args) : null;
            programs.push(msi ? { path: msi[1] ?? msi[2], arguments: args }
                : { path, arguments: args });
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
        // Where a runtime keeps what is not Windows' own: XNA's native
        // library, which its assemblies load from the path its registry names.
        // A package a script names puts files here; one the app only carries
        // is still taken only when everything goes into Windows (`inWindows`).
        ProgramFilesFolder: wide ? 'C:\\Program Files (x86)' : 'C:\\Program Files',
        CommonFilesFolder: wide ? 'C:\\Program Files (x86)\\Common Files'
            : 'C:\\Program Files\\Common Files',
        ...wide ? { ProgramFiles64Folder: 'C:\\Program Files',
            CommonFiles64Folder: 'C:\\Program Files\\Common Files' } : {},
    };
    /**
     * A directory's path by its Directory key, once the table is read: a
     * Formatted [key] naming one is its path with the trailing backslash
     * Windows Installer gives it (XNA's NativeLibraryPath is "[CommonV2Dir]",
     * and its assemblies load XnaNative.dll from what it says).
     *
     * @type {(id: string) => string | null}
     */
    let directoryPath = ()=>null;
    /** @param {string} text */
    const format = text=>text.replace(/\[([A-Za-z_][\w.]*)\]/g, (_, name)=>{
        const directory = folders[name] ?? directoryPath(name);
        return directory ? `${directory}\\` : properties.get(name) ?? '';
    });
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
    directoryPath = id=>(directories.has(id) ? resolve(id) : null);

    const installed = new Map();
    /** Each component's key file, which names a global assembly's runtime. */
    const keyFiles = new Map();
    /** @type {string[]} */
    const skipped = [];
    for (const component of rowsOf(db, 'Component'))
    {
        keyFiles.set(component.Component, String(component.KeyPath ?? ''));
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

    // A global Win32 assembly (an MsiAssembly row of Attributes 1 and no
    // File_Application) is not copied where its Directory says: Windows
    // Installer hands it to the side-by-side store, laid out as the activation
    // context reads it (`actctx.js`) - its files under WinSxS\<key>\ and its
    // manifest also as WinSxS\Manifests\<key>.manifest; a publisher policy's
    // under WinSxS\Policies\<key>\. The key is the folder the package names
    // for the component, the store's own name for the assembly.
    const fileRows = rowsOf(db, 'File');
    /** @type {Map<string, { key: string, manifest: string, policy: boolean }>} */
    const assemblies = new Map();
    for (const row of rowsOf(db, 'MsiAssembly'))
    {
        const directory = installed.get(row.Component_);
        if (Number(row.Attributes ?? 0) !== 1 || row.File_Application || !directory)
        {
            continue;
        }
        const manifest = String(row.File_Manifest ?? '');
        const named = longName(fileRows.find(file=>file.File === manifest)?.FileName ?? '');
        assemblies.set(row.Component_, { key: directory.split('\\').pop() ?? '', manifest,
            policy: /\.policy$/i.test(named) });
    }
    const STORE = `${folders.WindowsFolder}\\WinSxS`;

    // A global .NET assembly (Attributes 0, no File_Application) goes to the
    // global assembly cache, not to its Directory: the folder its name,
    // version, culture and public key token make, under the cache of the
    // runtime its metadata was built against - CLR 4's under Microsoft.NET
    // (v4.0_ folders), CLR 2's under assembly - and of its architecture.
    // Copied where its Directory says, a runtime looking it up by its name
    // never found it, and a program built on it stopped at its first use
    // (XNA Framework 4.0's ten assemblies).
    /** @type {Map<string, Record<string, string>>} */
    const cached = new Map();
    for (const row of rowsOf(db, 'MsiAssembly'))
    {
        // Its own Directory does not matter: an installed component is enough.
        if (Number(row.Attributes ?? 0) === 0 && !row.File_Application
            && installed.has(row.Component_))
        {
            cached.set(row.Component_, Object.fromEntries(rowsOf(db, 'MsiAssemblyName')
                .filter(name=>name.Component_ === row.Component_)
                .map(name=>[String(name.Name).toLowerCase(), String(name.Value ?? '')])));
        }
    }
    /** @param {string} key @returns {Uint8Array | undefined} a file's bytes, by its key */
    const packed = key=>{
        const row = fileRows.find(file=>file.File === key);
        return row ? cabinetFilesByKey.get(String(key).toLowerCase())
            ?.find(one=>one.length === Number(row.FileSize)) : undefined;
    };
    /** @type {Map<string, string | null>} */
    const cacheFolders = new Map();
    /** @param {string} component @returns {string | null} */
    const cacheFolder = component=>{
        if (!cacheFolders.has(component))
        {
            const name = /** @type {Record<string, string>} */ (cached.get(component));
            const key = packed(keyFiles.get(component) ?? '');
            const runtime = key ? managedImageOf(key)?.runtime ?? null : null;
            const architecture = (name.processorarchitecture ?? '').toLowerCase();
            const which = architecture === 'x86' ? 'GAC_32'
                : architecture === 'amd64' ? 'GAC_64' : 'GAC_MSIL';
            const version = (name.version ?? '').split('.').map(part=>String(Number(part)))
                .join('.');
            const culture = (name.culture ?? '').toLowerCase() === 'neutral' ? ''
                : name.culture ?? '';
            const token = (name.publickeytoken ?? '').toLowerCase();
            const windows = folders.WindowsFolder;
            cacheFolders.set(component, !name.name || !runtime ? null
                : runtime.startsWith('v4')
                    ? `${windows}\\Microsoft.NET\\assembly\\${which}\\${name.name}`
                        + `\\v4.0_${version}_${culture}_${token}`
                    : `${windows}\\assembly\\${which}\\${name.name}`
                        + `\\${version}_${culture}_${token}`);
        }
        return cacheFolders.get(component) ?? null;
    };

    /** @type {{ path: string, bytes: Uint8Array }[]} */
    const files = [];
    /** Where each file the package lays down went, by its File key. @type {Map<string, string>} */
    const placed = new Map();
    for (const file of fileRows)
    {
        const assembly = assemblies.get(file.Component_);
        const directory = assembly
            ? `${STORE}${assembly.policy ? '\\Policies' : ''}\\${assembly.key}`
            : cached.has(file.Component_) ? cacheFolder(file.Component_)
                : installed.get(file.Component_);
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
        placed.set(file.File, `${directory}\\${longName(file.FileName)}`);
        if (assembly && !assembly.policy && file.File === assembly.manifest)
        {
            files.push({ path: `${STORE}\\Manifests\\${assembly.key}.manifest`, bytes });
        }
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
    // SelfRegModules: each library the SelfReg table names registers itself
    // once it is installed - here at the bottle's next logon.
    for (const row of rowsOf(db, 'SelfReg'))
    {
        const path = placed.get(String(row.File_));
        if (path)
        {
            registry.push(registerAtLogon(path));
        }
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
 * @param {string[]} [programs]  Installers named outright rather than by a
 *     script, as paths in it: a store that lists each redistributable's
 *     program (GOG's dependencies) where Steam has a script run it.
 * @returns {Promise<string[]>}
 */
export async function installRedistributables(tree, scripts, machine, programs = []){
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

    for (const program of programs)
    {
        const inside = find(program);
        if (!inside)
        {
            said.push(`${program} is not in the app`);
            continue;
        }
        declared.set(inside.toLowerCase(), inside);
    }

    /** @type {{ version: string, files: { path: string, bytes: Uint8Array }[], registry: RegistryWrite[] }[]} */
    const chosen = [];
    // The other programs the app carries: what may be a bootstrapper.
    const carriedPrograms = paths.filter(path=>/\.(exe|msi)$/i.test(path)
        && !path.toLowerCase().startsWith('.bottlify\\') && !declared.has(path.toLowerCase()));
    for (const inside of [...declared.values(), ...carriedPrograms])
    {
        const named = declared.has(inside.toLowerCase());
        /** @type {Awaited<ReturnType<typeof unpackRedistributable>>} */
        let unpacked;
        try
        {
            unpacked = await unpackRedistributable(await tree.read(inside));
        }
        catch (e){
            const why = String(/** @type {Error} */ (e)?.message ?? e);
            // A program the app merely carries need not be an installer at
            // all: one this cannot read is passed over, said; one a script
            // names is the install's to fail on, by its name.
            if (named)
            {
                throw new Error(`${inside}: ${why}`, { cause: e });
            }
            said.push(`${inside}: not read as an installer (${why})`);
            continue;
        }
        const { packages, files } = unpacked;
        if (named && packages.length === 0)
        {
            // DirectX's setup: the optional components' cabinets in its own folder.
            const folder = inside.slice(0, inside.lastIndexOf('\\') + 1).toLowerCase();
            const cabinetPaths = paths.filter(path=>path.toLowerCase().startsWith(folder)
                && DIRECTX_CABINET.test(path.slice(folder.length)));
            const cabinets = await Promise.all(cabinetPaths.map(path=>tree.read(path)));
            /** @type {ReturnType<typeof directxFiles>} */
            let directx;
            try
            {
                directx = directxFiles(cabinets, machine);
            }
            catch (e){
                // Which cabinet it is, for whoever reads the failure.
                const at = cabinets.findIndex(bytes=>{
                    try
                    {
                        cabinetFiles(bytes);
                        return false;
                    }
                    catch {
                        return true;
                    }
                });
                throw new Error(`${at >= 0 ? cabinetPaths[at] : folder}: `
                    + `${String(/** @type {Error} */ (e)?.message ?? e)}`, { cause: e });
            }
            if (directx.files.length === 0)
            {
                said.push(`${inside}: no installer package inside; left to the engine`);
                continue;
            }
            chosen.push({ version: '0', files: directx.files,
                registry: directxRegistrations(directx) });
            said.push(`${inside}: ${directx.files.length} file(s) by its cabinets' INFs`
                + `${directx.unregistered.length > 0
                    ? `, registered at the next start: ${directx.unregistered.join(', ')}` : ''}`);
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
            // A package that lays DirectX's setup down with its optional
            // components' cabinets runs it from there, a custom action this
            // does not run: its cabinets go in by their INFs, as the DirectX
            // step's do (XNA Framework 4.0's X3DAudio, XAudio2 and XACT, which
            // its assemblies import and the engine does not answer).
            for (const one of applied)
            {
                const setups = new Set(one.files.filter(file=>/\\dxsetup\.exe$/i.test(file.path))
                    .map(file=>file.path.slice(0, file.path.lastIndexOf('\\')).toLowerCase()));
                const cabinets = one.files.filter(file=>{
                    const at = file.path.lastIndexOf('\\');
                    return setups.has(file.path.slice(0, at).toLowerCase())
                        && DIRECTX_CABINET.test(file.path.slice(at + 1));
                });
                if (cabinets.length === 0)
                {
                    continue;
                }
                const directx = directxFiles(cabinets.map(file=>file.bytes), machine);
                chosen.push({ version: one.version, files: directx.files,
                    registry: directxRegistrations(directx) });
                said.push(`${inside}: DirectX's setup it lays down, ${directx.files.length} `
                    + `file(s) by its cabinets' INFs${directx.unregistered.length > 0
                        ? `, registered at the next start: ${directx.unregistered.join(', ')}`
                        : ''}`);
            }
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
        const hive = kept ? JSON.parse(utf8.decode(await tree.read(kept))) : null;
        await tree.write(REGISTRY_PATH,
            utf8.encode(JSON.stringify(writeRegistry(hive, registry))));
    }
    said.push(`redistributables: ${files.size} file(s), ${registry.length} registry value(s)`);
    return said;
}

/**
 * What Steam does on an installed app's first start: the install scripts of
 * the app (`extended.installscript` in its product info) and of the
 * redistributables' depots it took (each an `installscript.vdf`) run on the
 * machine its program is for -- how bottlify-ui/gamehub/tools/steam-install.mjs and an install in
 * the browser both finish.
 *
 * @param {AppTree} tree
 * @param {Object} what
 * @param {string} [what.installscript]  The app's own, as its product info names it.
 * @param {string[]} what.shared  The paths of the redistributables' depots' files.
 * @param {string} [what.executable]  The program Steam starts: its width is the machine's
 *     unless `machine` says.
 * @param {'x86' | 'amd64'} [what.machine]  The bottle's machine: a 64-bit one holds both
 *     widths' runtimes, so a 32-bit build of a game that ships both runs too.
 * @returns {Promise<string[]>}
 */
export async function installSteamRedistributables(tree, { installscript, shared, executable,
    machine: told })
{
    const { find } = await finder(tree);
    const scripts = [installscript, ...shared.filter(name=>/(^|\\)installscript\.vdf$/i.test(name))]
        .map(find).filter(/** @returns {path is string} */ path=>path !== undefined);
    const program = find(executable);
    const machine = told
        ?? (program ? imageMachine((await tree.read(program)).subarray(0, 4096)) : 'x86');
    return installRedistributables(tree, scripts, machine);
}
