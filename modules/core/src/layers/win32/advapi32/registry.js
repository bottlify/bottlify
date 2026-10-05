/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The registry hive: keys, the values hanging off them, and nothing else.
 *
 * This is a store, not an API surface -- it knows nothing about handles, guest
 * memory or error codes. What it does know are the two rules that make a
 * registry a registry rather than a nested map: names compare without regard to
 * case, and string data carries its own terminator. Both are the kind of detail
 * a program only notices by failing to find a setting it wrote itself.
 *
 * A session's registry outlives the session, so the whole tree converts to a
 * plain JSON-able object and back.
 *
 * HKEY_CLASSES_ROOT is not a tree of its own. It is a view of two others: the
 * machine's classes under HKLM\Software\Classes and the user's under
 * HKCU\Software\Classes, the user's lying over the machine's. A class an
 * installer registers under one name is found under the other, and a program
 * that registers a COM server under HKLM\Software\Classes has it activated by
 * code that only ever reads the classes root.
 */

import { PROCESSOR, PROCESSOR_IDENTIFIER } from '../kernel32/processor.js';
import { windowsVersion } from '../kernel32/versions.js';

/** The predefined roots. A guest names these by constant; it never opens them. */
export const HKEY_CLASSES_ROOT = 0x80000000;
export const HKEY_CURRENT_USER = 0x80000001;
export const HKEY_LOCAL_MACHINE = 0x80000002;
export const HKEY_USERS = 0x80000003;

/** Value types. The numbers are the guest's, not ours. */
export const REG_NONE = 0;
export const REG_SZ = 1;
export const REG_EXPAND_SZ = 2;
export const REG_BINARY = 3;
export const REG_DWORD = 4;
export const REG_MULTI_SZ = 7;

/** Types whose data is text, and is therefore expected to end in a terminator. */
const STRING_TYPES = new Set([REG_SZ, REG_EXPAND_SZ, REG_MULTI_SZ]);

/** The roots that are trees of their own; the classes root is a view of two of them. */
const ROOT_NAMES = new Map([
    [HKEY_CURRENT_USER, 'HKEY_CURRENT_USER'],
    [HKEY_LOCAL_MACHINE, 'HKEY_LOCAL_MACHINE'],
    [HKEY_USERS, 'HKEY_USERS'],
]);

/** Where each side of the classes root lives. */
const MACHINE_CLASSES = 'SOFTWARE\\Classes';
const USER_CLASSES = 'Software\\Classes';

/**
 * @typedef {Object} RegistryValue
 * @property {string} name   As the writer spelled it; lookups ignore its case.
 * @property {number} type
 * @property {Uint8Array} data
 */

/**
 * A key as the hive stores it.
 *
 * @typedef {Object} RegistryNode
 * @property {string} name
 * @property {Map<string, RegistryNode>} keys      Keyed by folded name.
 * @property {Map<string, RegistryValue>} values  Keyed by folded name.
 */

/**
 * A key reached through HKEY_CLASSES_ROOT: a path under the classes, looked up
 * on both sides whenever it is used, so a key one side gains or loses after it
 * was opened is seen through a handle already held.
 *
 * @typedef {Object} ClassesKey
 * @property {'classes'} view
 * @property {string} name
 * @property {string[]} path
 */

/** @typedef {RegistryNode | ClassesKey} RegistryKey */

/**
 * @typedef {Object} StoredValue
 * @property {string} name
 * @property {number} type
 * @property {number[]} data
 */

/**
 * @typedef {Object} StoredKey
 * @property {string} name
 * @property {StoredValue[]} values
 * @property {StoredKey[]} keys
 */

/**
 * Windows folds case with the invariant mapping, never the user's locale, so
 * `toLowerCase` rather than `toLocaleLowerCase` is the correct one here.
 *
 * @param {string} name
 */
const fold = name=>name.toLowerCase();

/** @param {string} name @returns {RegistryNode} */
function makeKey(name){
    return { name, keys: new Map(), values: new Map() };
}

/**
 * A key outside every root: the tree RegLoadAppKey opens a hive file as,
 * which no path from a root reaches.
 *
 * @returns {RegistryNode}
 */
export function detachedKey(){
    return makeKey('');
}

/**
 * Splits a subkey path. A leading or trailing separator is tolerated because
 * guest code builds these paths by concatenation and often leaves one behind.
 *
 * @param {string | null | undefined} path
 * @returns {string[]}
 */
function segments(path){
    return typeof path === 'string' ? path.split('\\').filter(part=>part.length > 0) : [];
}

/**
 * String data is stored the way a reader expects to find it: REG_SZ ends in one
 * NUL, REG_MULTI_SZ in two. Guests that pass `strlen` as the byte count are
 * common enough that fixing the terminator here beats handing back a string
 * whose end nobody can find. Data of no bytes at all stays that: advapi32's
 * registry tests set a REG_SZ of zero bytes and read zero bytes back.
 *
 * @param {number} type @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function terminate(type, data){
    if (!STRING_TYPES.has(type) || data.length === 0)
    {
        return data;
    }
    const wanted = type === REG_MULTI_SZ ? 2 : 1;
    let present = 0;
    while (present < wanted && data[data.length - 1 - present] === 0)
    {
        present++;
    }
    if (present === wanted)
    {
        return data;
    }
    const padded = new Uint8Array(data.length + (wanted - present));
    padded.set(data);
    return padded;
}

/** @param {RegistryNode} key @returns {StoredKey} */
function keyToJSON(key){
    return {
        name: key.name,
        values: [...key.values.values()].map(value=>({
            name: value.name,
            type: value.type,
            data: [...value.data],
        })),
        keys: [...key.keys.values()].map(keyToJSON),
    };
}

/** @param {any} stored @returns {RegistryNode} */
function keyFromJSON(stored){
    const key = makeKey(stored?.name ?? '');
    for (const value of stored?.values ?? [])
    {
        const name = value?.name ?? '';
        key.values.set(fold(name), {
            name,
            type: value?.type >>> 0,
            data: Uint8Array.from(value?.data ?? []),
        });
    }
    for (const child of stored?.keys ?? [])
    {
        key.keys.set(fold(child?.name ?? ''), keyFromJSON(child));
    }
    return key;
}

/**
 * @typedef {Object} MachineKey
 * @property {number} root
 * @property {string} path
 * @property {Record<string, string | number | Uint8Array>} [values]
 *     Text is REG_SZ, a number REG_DWORD, bytes REG_BINARY.
 * @property {readonly string[]} [owned]
 *     Values that describe the machine rather than anything a program chose:
 *     written from `values` whenever the machine's keys are put in place, and
 *     removed when `values` has none, so a hive kept from a run under another
 *     Windows describes this one.
 */

/** @typedef {import('../kernel32/versions.js').WindowsVersion} WindowsVersion */

/**
 * Where the shell keeps its folders, by the names the registry lists them
 * under. One table, because a program reads the same folder two ways -- the
 * registry value and the shell's own call -- and compares what it got.
 *
 * Windows Vista moved them: the profile from `Documents and Settings` to
 * `Users`, a roaming and a local `AppData` in it, and what every user shares
 * to `ProgramData` and `Users\Public`.
 *
 * @param {WindowsVersion} [windows]
 * @returns {Readonly<Record<string, string>>}
 */
export function shellFolders(windows = windowsVersion()){
    const { user, allUsers, public: shared } = windows.profiles;
    const machine = {
        Fonts: 'C:\\WINDOWS\\Fonts',
        Windows: 'C:\\WINDOWS',
        System: 'C:\\WINDOWS\\system32',
        ProgramFiles: 'C:\\Program Files',
        CommonFiles: 'C:\\Program Files\\Common Files',
    };
    if (shared === null)
    {
        return Object.freeze({
            Desktop: `${user}\\Desktop`,
            Programs: `${user}\\Start Menu\\Programs`,
            'Start Menu': `${user}\\Start Menu`,
            Startup: `${user}\\Start Menu\\Programs\\Startup`,
            Personal: `${user}\\My Documents`,
            AppData: `${user}\\Application Data`,
            'Local AppData': `${user}\\Local Settings\\Application Data`,
            Profile: user,
            'Common Desktop': `${allUsers}\\Desktop`,
            'Common Programs': `${allUsers}\\Start Menu\\Programs`,
            'Common Start Menu': `${allUsers}\\Start Menu`,
            'Common Startup': `${allUsers}\\Start Menu\\Programs\\Startup`,
            'Common Documents': `${allUsers}\\Documents`,
            'Common AppData': `${allUsers}\\Application Data`,
            ...machine,
        });
    }
    const roaming = `${user}\\AppData\\Roaming`;
    const menu = `${roaming}\\Microsoft\\Windows\\Start Menu`;
    const commonMenu = `${allUsers}\\Microsoft\\Windows\\Start Menu`;
    return Object.freeze({
        Desktop: `${user}\\Desktop`,
        Programs: `${menu}\\Programs`,
        'Start Menu': menu,
        Startup: `${menu}\\Programs\\Startup`,
        Personal: `${user}\\Documents`,
        AppData: roaming,
        'Local AppData': `${user}\\AppData\\Local`,
        Profile: user,
        'Common Desktop': `${shared}\\Desktop`,
        'Common Programs': `${commonMenu}\\Programs`,
        'Common Start Menu': commonMenu,
        'Common Startup': `${commonMenu}\\Programs\\Startup`,
        'Common Documents': `${shared}\\Documents`,
        'Common AppData': allUsers,
        ...machine,
    });
}

/**
 * The directories a Windows's profile folders need on the volume, each parent
 * before its children: every shell folder under the user's, the shared and the
 * public profile, and the directories that hold them.
 *
 * @param {WindowsVersion} [windows]
 * @returns {string[]}
 */
export function profileDirectories(windows = windowsVersion()){
    const { user, allUsers, public: shared } = windows.profiles;
    const roots = [user, allUsers, shared].filter(root=>root !== null);
    /** @type {Set<string>} */
    const directories = new Set();
    for (const folder of Object.values(shellFolders(windows)))
    {
        if (!roots.some(root=>folder === root || folder.startsWith(`${root}\\`)))
        {
            continue;
        }
        const parts = folder.split('\\');
        for (let depth = 2; depth <= parts.length; depth++)
        {
            directories.add(parts.slice(0, depth).join('\\'));
        }
    }
    return [...directories];
}

/** What NT 4, 2000 and XP keep in CurrentBuild; Vista put the build number there. */
const OBSOLETE_BUILD = '1.511.1 () (Obsolete data - do not use)';

/** Every value of the Windows NT version key that describes the version. */
const VERSION_VALUES = Object.freeze(['CurrentVersion', 'CurrentBuildNumber', 'CurrentBuild',
    'CSDVersion', 'ProductName', 'CurrentMajorVersionNumber', 'CurrentMinorVersionNumber',
    'DisplayVersion', 'ReleaseId', 'UBR']);

/**
 * The Windows NT version key's description of a Windows. Windows 10 leaves
 * CurrentVersion at 6.3, where programs that parse it expect to find a
 * number they know, and says 10.0 in two DWORDs of its own, beside the name of
 * its release and the revision of its last update; a Windows with no service
 * pack has no CSDVersion.
 *
 * @param {WindowsVersion} windows
 * @returns {Record<string, string | number>}
 */
const versionValues = windows=>({
    CurrentVersion: windows.major >= 10 ? '6.3' : `${windows.major}.${windows.minor}`,
    CurrentBuildNumber: String(windows.build),
    CurrentBuild: windows.major >= 6 ? String(windows.build) : OBSOLETE_BUILD,
    ...windows.csdVersion === '' ? {} : { CSDVersion: windows.csdVersion },
    ProductName: windows.productName,
    ...windows.major >= 10
        ? { CurrentMajorVersionNumber: windows.major, CurrentMinorVersionNumber: windows.minor }
        : {},
    ...windows.release === null ? {} : {
        DisplayVersion: windows.release.displayVersion,
        ReleaseId: windows.release.releaseId,
        UBR: windows.release.ubr,
    },
});

/**
 * The DirectX this machine has, as its own setup library reads it back: 9.0c,
 * the newest of the interfaces the drawing layer answers for.
 */
export const DIRECTX_VERSION = '4.09.00.0904';

/**
 * The same DirectX by the name its release went by, 9.0c, in the three parts
 * DxDiag reports: an installer that asks it compares the letter too, since
 * 9.0, 9.0b and 9.0c share a major and a minor.
 */
export const DIRECTX_RELEASE = Object.freeze({ major: 9, minor: 0, letter: 'c' });

/**
 * @typedef {Object} DirectXRelease
 * @property {string} version  As the setup library reads it back.
 * @property {number} major    And as DxDiag names the release.
 * @property {number} minor
 * @property {string} letter   A space where the release had none.
 */

/**
 * The releases a bottle's graphics choice may make the machine report, by
 * major version: 7.0, 8.1 and the default 9.0c.
 *
 * @type {Readonly<Record<'7' | '8' | '9', DirectXRelease>>}
 */
export const DIRECTX_RELEASES = Object.freeze({
    7: Object.freeze({ version: '4.07.00.0700', major: 7, minor: 0, letter: ' ' }),
    8: Object.freeze({ version: '4.08.01.0881', major: 8, minor: 1, letter: ' ' }),
    9: Object.freeze({ version: DIRECTX_VERSION, ...DIRECTX_RELEASE }),
});

/**
 * InstalledVersion's eight bytes for a version string: the minor in the first
 * dword and the release and build in the second, each pair of the build's
 * digits a byte read as hex -- 4.09.00.0904 is 00 00 00 09 00 00 09 04.
 *
 * @param {string} version
 * @returns {Uint8Array}
 */
export function installedVersionOf(version){
    const [, minor, release, build] = version.split('.');
    return Uint8Array.of(0, 0, 0, Number(minor), 0, Number(release),
        parseInt(build.slice(0, 2), 16), parseInt(build.slice(2), 16));
}

/**
 * @param {Readonly<Record<string, string>>} table @param {string[]} names
 * @returns {Record<string, string>}
 */
const pick = (table, names)=>Object.fromEntries(names.map(name=>[name, table[name]]));

/** Where the kernel describes the processor. */
const PROCESSOR_KEY = 'HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0';

/** The in-process COM classes the system libraries serve, by CLSID. */
const IN_PROCESS_CLASSES = Object.freeze([
    { clsid: '{47D4D946-62E8-11CF-93BC-444553540000}', library: 'dsound.dll' }, // DirectSound
    { clsid: '{3901CC3F-84B5-4FA4-BA35-AA8172B8A09B}', library: 'dsound.dll' }, // DirectSound8
    { clsid: '{B0210780-89CD-11D0-AF08-00A0C925CD16}', library: 'dsound.dll' }, // Capture
    { clsid: '{E4BCAC13-7F99-4908-9A8E-74E3BF24B6E1}', library: 'dsound.dll' }, // Capture8
    { clsid: '{FEA4300C-7959-4147-B26A-2377B9E7A91D}', library: 'dsound.dll' }, // FullDuplex
    { clsid: '{D7B70EE0-4340-11CF-B063-0020AFC2CD35}', library: 'ddraw.dll' }, // DirectDraw
    { clsid: '{3C305196-50DB-11D3-9CFE-00C04FD930C5}', library: 'ddraw.dll' }, // DirectDraw7
]);

/**
 * The keys and values every Windows installation carries before any program
 * has run, as far as a program of the era asks for them: where programs go,
 * where the shared-library counts live, where an installer registers what it
 * put there, where the shell keeps its folders and which Windows this is. An
 * installer opens these without creating them and takes a missing one for a
 * broken machine.
 *
 * Every string is stored as REG_SZ; a path is what this machine's volume
 * actually holds, so what a program reads here it can then open.
 *
 * @param {WindowsVersion} windows
 * @param {DirectXRelease} [directx]  A bottle's own; absent, 9.0c.
 * @returns {readonly MachineKey[]}
 */
const machineKeys = (windows, directx)=>{
    const folders = shellFolders(windows);
    const userFolders = pick(folders, ['Desktop', 'Programs', 'Start Menu', 'Startup',
        'Personal', 'AppData', 'Local AppData', 'Fonts']);
    const commonFolders = pick(folders, ['Common Desktop', 'Common Programs',
        'Common Start Menu', 'Common Startup', 'Common Documents']);
    const windowsKey = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion';
    return Object.freeze(/** @type {MachineKey[]} */ ([
        { root: HKEY_LOCAL_MACHINE, path: MACHINE_CLASSES },
        // The class root's own subtrees, there on every machine before any server
        // registers: a COM server registering itself opens CLSID, and one that
        // finds it missing takes the registry for broken and gives up.
        ...['CLSID', 'Interface', 'TypeLib', 'AppID'].map(name=>
            ({ root: HKEY_LOCAL_MACHINE, path: `${MACHINE_CLASSES}\\${name}` })),
        // The classes a system library serves in process, as their setup
        // registers them: CoCreateInstance finds the library here and asks its
        // DllGetClassObject for the class, which is how a program that never
        // calls DirectSoundCreate makes a DirectSound object.
        ...IN_PROCESS_CLASSES.map(({ clsid, library })=>({
            root: HKEY_LOCAL_MACHINE,
            path: `${MACHINE_CLASSES}\\CLSID\\${clsid}\\InprocServer32`,
            values: { '': library, ThreadingModel: 'Both' },
        })),
        { root: HKEY_LOCAL_MACHINE, path: windowsKey, values: {
            ProgramFilesDir: folders.ProgramFiles,
            ProgramFilesPath: folders.ProgramFiles,
            CommonFilesDir: folders.CommonFiles,
            SystemRoot: folders.Windows,
            MediaPath: 'C:\\WINDOWS\\Media',
        } },
        { root: HKEY_LOCAL_MACHINE, path: `${windowsKey}\\SharedDLLs` },
        { root: HKEY_LOCAL_MACHINE, path: `${windowsKey}\\Setup` },
        { root: HKEY_LOCAL_MACHINE, path: `${windowsKey}\\Uninstall` },
        { root: HKEY_LOCAL_MACHINE, path: `${windowsKey}\\App Paths` },
        { root: HKEY_LOCAL_MACHINE, path: `${windowsKey}\\Run` },
        { root: HKEY_LOCAL_MACHINE, path: `${windowsKey}\\RunOnce` },
        { root: HKEY_LOCAL_MACHINE,
            path: `${windowsKey}\\Explorer\\Shell Folders`,
            values: commonFolders, owned: Object.keys(commonFolders) },
        { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
            values: {
                ...versionValues(windows),
                SystemRoot: 'C:\\WINDOWS',
                PathName: 'C:\\WINDOWS',
            },
            owned: VERSION_VALUES },
        { root: HKEY_LOCAL_MACHINE, path: 'SYSTEM\\CurrentControlSet\\Control\\Session Manager' },
        // What the kernel wrote about the processor it found: the identifier is
        // the emulated CPUID's family, model and stepping, and the speed the
        // emulated counter's rate (`createHive`'s `processorMhz`). A program reads
        // the speed from here before it measures anything, and one that finds no
        // key reports a 0 MHz machine.
        { root: HKEY_LOCAL_MACHINE, path: PROCESSOR_KEY,
            values: {
                Identifier: PROCESSOR_IDENTIFIER,
                VendorIdentifier: PROCESSOR.vendor,
                '~MHz': PROCESSOR.mhz,
            } },
        // The DirectX this machine has, in the two forms its own setup library
        // reads back: the version string, and the binary pair an older setup
        // library consults first. 9.0c, the newest of the interfaces the drawing
        // layer answers for, and every earlier one is inside it, so an installer
        // asking for 8.1 is satisfied. An installer that finds no version here
        // treats the machine as having none and installs the whole runtime over
        // the interfaces the drawing layer answers for.
        { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\DirectX', values: {
            Version: (directx ?? DIRECTX_RELEASES[9]).version,
            InstalledVersion: installedVersionOf((directx ?? DIRECTX_RELEASES[9]).version),
            InstalledCount: 1,
            RC: 0,
        // A bottle's own release is put back at every start, over whatever a
        // setup wrote there: it describes the machine, as the Windows does.
        }, ...directx ? { owned: ['Version', 'InstalledVersion'] } : {} },
        { root: HKEY_CURRENT_USER, path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
        { root: HKEY_CURRENT_USER,
            path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
            values: userFolders, owned: Object.keys(userFolders) },
        { root: HKEY_CURRENT_USER, path: 'Control Panel\\Desktop' },
        { root: HKEY_CURRENT_USER, path: USER_CLASSES },
    ]));
};

/** @param {string} text @returns {Uint8Array} eight-bit text with its terminator */
const sz = text=>{
    const bytes = new Uint8Array(text.length + 1);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at] = text.charCodeAt(at) & 0xff;
    }
    return bytes;
};

/** @param {number} value @returns {Uint8Array} a little-endian DWORD */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * The node a path leads to from a node, or null where it stops.
 *
 * @param {RegistryNode | null | undefined} node @param {string[]} parts
 * @returns {RegistryNode | null}
 */
function walk(node, parts){
    let at = node ?? null;
    for (const part of parts)
    {
        at = at?.keys.get(fold(part)) ?? null;
    }
    return at;
}

/**
 * Copies into a node what a saved tree has and the node does not, leaving
 * what the node already holds as it is.
 *
 * @param {RegistryNode} into @param {RegistryNode} from
 */
function mergeMissing(into, from){
    for (const [name, value] of from.values)
    {
        if (!into.values.has(name))
        {
            into.values.set(name, value);
        }
    }
    for (const [name, child] of from.keys)
    {
        const present = into.keys.get(name);
        if (present)
        {
            mergeMissing(present, child);
        }
        else
        {
            into.keys.set(name, child);
        }
    }
}

/** @param {RegistryKey} key @returns {key is ClassesKey} */
const isClasses = key=>'view' in key;

/** @param {string[]} path @returns {ClassesKey} */
const classesKey = path=>({
    view: 'classes',
    name: path.length > 0 ? path[path.length - 1] : 'HKEY_CLASSES_ROOT',
    path,
});

/**
 * Builds a hive: the predefined roots with the machine's own keys under
 * them (see machineKeys), and nothing a program has put there yet.
 *
 * Enumeration order is insertion order throughout, which is what makes an
 * index-based enumeration answer the same thing twice. Overwriting a value
 * leaves it where it was; only deleting and re-adding moves it to the end.
 *
 * @param {{ processorMhz?: number, windows?: WindowsVersion,
 *     directx?: DirectXRelease }} [options]
 *        `processorMhz` is the speed the processor key reports: the rate the
 *        engine's rdtsc advances at, which is the engine's to say. `windows` is
 *        the Windows the machine's keys describe, `directx` the DirectX; absent,
 *        the defaults.
 */
export function createHive(
    { processorMhz = PROCESSOR.mhz, windows = windowsVersion(), directx } = {},
)
{
    const furnishings = machineKeys(windows, directx);
    /** @type {Map<number, RegistryNode>} */
    const roots = new Map();

    /** The classes root itself: the same object every time it is asked for. */
    const CLASSES_ROOT = classesKey([]);

    /**
     * Whoever keeps the hive between runs. Told once per burst of changes and
     * on a microtask, so a program writing its settings one value at a time
     * costs one save rather than one per value, and nothing is announced from
     * inside the call that is still making the change.
     *
     * @type {(() => void)[]}
     */
    const listeners = [];
    let announcing = false;
    /** Moves with every change, for a copy kept elsewhere to tell it has none. */
    let revision = 0;
    const changed = ()=>{
        revision++;
        if (announcing || listeners.length === 0)
        {
            return;
        }
        announcing = true;
        queueMicrotask(()=>{
            announcing = false;
            for (const listener of listeners)
            {
                listener();
            }
        });
    };

    /**
     * Puts the machine's own keys in place, adding what is missing and
     * leaving what is there: a hive restored from an earlier run keeps every
     * value a program wrote, and a key the program deleted comes back, as
     * it would on a machine whose registry was repaired. The values that
     * describe the machine itself are the exception, and are written over.
     */
    const furnish = ()=>{
        for (const entry of furnishings)
        {
            // HARDWARE is written by the kernel at every boot, not kept: a hive
            // restored from a run on another engine reports this one's speed.
            const volatile = entry.path.startsWith('HARDWARE\\');
            const values = entry.path === PROCESSOR_KEY
                ? { ...entry.values, '~MHz': processorMhz } : entry.values ?? {};
            let node = /** @type {RegistryNode} */ (roots.get(entry.root));
            for (const part of segments(entry.path))
            {
                let next = node.keys.get(fold(part));
                if (!next)
                {
                    next = makeKey(part);
                    node.keys.set(fold(part), next);
                }
                node = next;
            }
            for (const name of entry.owned ?? [])
            {
                if (!Object.hasOwn(values, name))
                {
                    node.values.delete(fold(name));
                }
            }
            for (const [name, value] of Object.entries(values))
            {
                if (volatile || !node.values.has(fold(name)) || entry.owned?.includes(name))
                {
                    node.values.set(fold(name), typeof value === 'number'
                        ? { name, type: REG_DWORD, data: dword(value) }
                        : value instanceof Uint8Array
                            ? { name, type: REG_BINARY, data: value }
                            : { name, type: REG_SZ, data: sz(value) });
                }
            }
        }
    };

    const reset = ()=>{
        roots.clear();
        for (const [id, name] of ROOT_NAMES)
        {
            roots.set(id, makeKey(name));
        }
        furnish();
    };
    reset();

    /**
     * Walks to the parent of the last path segment, which is where both
     * creation and deletion have to act.
     *
     * @param {RegistryNode} key @param {string | null | undefined} path
     * @returns {{ parent: RegistryNode, name: string } | null}
     */
    const parentOf = (key, path)=>{
        const parts = segments(path);
        if (parts.length === 0)
        {
            return null;
        }
        let node = key;
        for (const part of parts.slice(0, -1))
        {
            const next = node.keys.get(fold(part));
            if (!next)
            {
                return null;
            }
            node = next;
        }
        return { parent: node, name: parts[parts.length - 1] };
    };

    /**
     * The two keys a classes path stands for, either of which may be absent.
     *
     * @param {ClassesKey} key
     */
    const sidesOf = key=>({
        user: walk(roots.get(HKEY_CURRENT_USER), [...segments(USER_CLASSES), ...key.path]),
        machine: walk(roots.get(HKEY_LOCAL_MACHINE),
            [...segments(MACHINE_CLASSES), ...key.path]),
    });

    /**
     * Where a write through the classes root lands: the user's key when the
     * user has one, the machine's otherwise.
     *
     * @param {RegistryKey} key @returns {RegistryNode | null}
     */
    const writable = key=>{
        if (!isClasses(key))
        {
            return key;
        }
        const { user, machine } = sidesOf(key);
        return user ?? machine;
    };

    /**
     * @param {RegistryNode} key @param {string | null} [path]
     * @returns {{ key: RegistryNode, created: boolean }}
     */
    const createNode = (key, path)=>{
        let node = key;
        let created = false;
        for (const part of segments(path))
        {
            let next = node.keys.get(fold(part));
            if (!next)
            {
                next = makeKey(part);
                node.keys.set(fold(part), next);
                created = true;
            }
            node = next;
        }
        if (created)
        {
            changed();
        }
        return { key: node, created };
    };

    /**
     * The key a key hangs from, and its name there: found by looking, since
     * a key does not point back. Null for a root, which hangs from nothing.
     *
     * @param {RegistryNode} key
     * @returns {{ parent: RegistryNode, name: string } | null}
     */
    const holderOf = key=>{
        const pending = [...roots.values()];
        while (pending.length > 0)
        {
            const node = /** @type {RegistryNode} */ (pending.pop());
            for (const child of node.keys.values())
            {
                if (child === key)
                {
                    return { parent: node, name: child.name };
                }
                pending.push(child);
            }
        }
        return null;
    };

    /**
     * @param {RegistryNode} key @param {string | null} [path]
     * @returns {'deleted' | 'missing' | 'has-subkeys'}
     */
    const removeNode = (key, path)=>{
        // No subkey named is the key itself, as RegDeleteKey(hKey, "") asks.
        const target = segments(path).length === 0 ? holderOf(key) : parentOf(key, path);
        if (!target)
        {
            return 'missing';
        }
        const doomed = target.parent.keys.get(fold(target.name));
        if (!doomed)
        {
            return 'missing';
        }
        if (doomed.keys.size > 0)
        {
            return 'has-subkeys';
        }
        target.parent.keys.delete(fold(target.name));
        changed();
        return 'deleted';
    };

    /**
     * What a list keyed by folded name holds on both sides of a classes key,
     * the user's first and the machine's only where the user has none.
     *
     * @template T
     * @param {ClassesKey} key
     * @param {(node: RegistryNode) => Map<string, T>} listOf
     * @returns {T[]}
     */
    const merged = (key, listOf)=>{
        const { user, machine } = sidesOf(key);
        const seen = new Map(user ? listOf(user) : []);
        for (const [name, entry] of machine ? listOf(machine) : [])
        {
            if (!seen.has(name))
            {
                seen.set(name, entry);
            }
        }
        return [...seen.values()];
    };

    return {
        /**
         * @param {number} id
         * @returns {RegistryKey | null}
         */
        root(id){
            return (id >>> 0) === HKEY_CLASSES_ROOT ? CLASSES_ROOT : roots.get(id >>> 0) ?? null;
        },

        /**
         * Resolves a subkey path. An empty or absent path names the key itself,
         * which is how a caller reopens the key it already holds.
         *
         * @param {RegistryKey} key @param {string | null} [path]
         * @returns {RegistryKey | null}
         */
        open(key, path){
            const parts = segments(path);
            if (parts.length === 0)
            {
                return key;
            }
            if (isClasses(key))
            {
                const found = classesKey([...key.path, ...parts]);
                const { user, machine } = sidesOf(found);
                return user || machine ? found : null;
            }
            return walk(key, parts);
        },

        /**
         * Creates a subkey path, intermediate keys included. A key made
         * through the classes root that neither side has is the machine's,
         * which is where Windows stores it.
         *
         * @param {RegistryKey} key @param {string | null} [path]
         * @returns {{ key: RegistryKey, created: boolean }}
         */
        create(key, path){
            if (!isClasses(key))
            {
                return createNode(key, path);
            }
            const parts = segments(path);
            if (parts.length === 0)
            {
                return { key, created: false };
            }
            const made = classesKey([...key.path, ...parts]);
            const { user, machine } = sidesOf(made);
            if (user || machine)
            {
                return { key: made, created: false };
            }
            const classes = createNode(/** @type {RegistryNode} */ (
                roots.get(HKEY_LOCAL_MACHINE)), MACHINE_CLASSES).key;
            createNode(classes, made.path.join('\\'));
            return { key: made, created: true };
        },

        /**
         * Deletes a subkey. One that has subkeys of its own is refused rather
         * than removed recursively -- NT's rule, and the reason a delete can
         * fail on a key that plainly exists. Through the classes root the
         * user's key goes first, and the machine's is what a second delete
         * finds.
         *
         * @param {RegistryKey} key @param {string | null} [path]
         * @returns {'deleted' | 'missing' | 'has-subkeys'}
         */
        remove(key, path){
            if (!isClasses(key))
            {
                return removeNode(key, path);
            }
            const parts = segments(path);
            if (parts.length === 0)
            {
                return 'missing';
            }
            const doomed = classesKey([...key.path, ...parts]);
            const { user, machine } = sidesOf(doomed);
            const base = user
                ? walk(roots.get(HKEY_CURRENT_USER), segments(USER_CLASSES))
                : machine ? walk(roots.get(HKEY_LOCAL_MACHINE), segments(MACHINE_CLASSES)) : null;
            return base ? removeNode(base, doomed.path.join('\\')) : 'missing';
        },

        /**
         * @param {RegistryKey} key
         * @returns {string[]} subkey names, in enumeration order
         */
        subkeys(key){
            return (isClasses(key) ? merged(key, node=>node.keys) : [...key.keys.values()])
                .map(child=>child.name);
        },

        /**
         * @param {RegistryKey} key
         * @returns {RegistryValue[]} in enumeration order
         */
        values(key){
            return isClasses(key) ? merged(key, node=>node.values) : [...key.values.values()];
        },

        /**
         * The unnamed default value is the one whose name is the empty string.
         *
         * @param {RegistryKey} key @param {string} name
         * @returns {RegistryValue | null}
         */
        getValue(key, name){
            if (isClasses(key))
            {
                const { user, machine } = sidesOf(key);
                return user?.values.get(fold(name)) ?? machine?.values.get(fold(name)) ?? null;
            }
            return key.values.get(fold(name)) ?? null;
        },

        /**
         * @param {RegistryKey} key @param {string} name
         * @param {number} type @param {Uint8Array} data
         * @returns {RegistryValue}
         */
        setValue(key, name, type, data){
            const value = { name, type: type >>> 0, data: terminate(type >>> 0, data) };
            const node = writable(key);
            // A classes key both sides have since deleted takes the value nowhere.
            if (node)
            {
                node.values.set(fold(name), value);
                changed();
            }
            return value;
        },

        /**
         * Gives a subkey a new name beside its siblings; its values and
         * subkeys go with it, and every handle on it stays on it. Not
         * through the classes root, whose keys are two sides' at once.
         *
         * @param {RegistryKey} parent @param {string} name @param {string} to
         * @returns {'renamed' | 'missing' | 'taken'}
         */
        rename(parent, name, to){
            const node = isClasses(parent) ? null : parent.keys.get(fold(name));
            if (!node || isClasses(parent))
            {
                return 'missing';
            }
            if (fold(name) !== fold(to) && parent.keys.has(fold(to)))
            {
                return 'taken';
            }
            parent.keys.delete(fold(name));
            node.name = to;
            parent.keys.set(fold(to), node);
            changed();
            return 'renamed';
        },

        /**
         * Where a key hangs: its parent and its name there, looked for from
         * the roots, as a handle holds only the key. Null for a root, a key
         * outside every root, and one deleted since.
         *
         * @param {RegistryKey} key @returns {{ parent: RegistryKey, name: string } | null}
         */
        placeOf(key){
            if (isClasses(key))
            {
                return key.path.length === 0 ? null
                    : { parent: CLASSES_ROOT, name: key.path.join('\\') };
            }
            const pending = [...roots.values()];
            const seen = new Set();
            while (pending.length > 0)
            {
                const node = /** @type {RegistryNode} */ (pending.pop());
                if (seen.has(node))
                {
                    continue;
                }
                seen.add(node);
                for (const child of node.keys.values())
                {
                    if (child === key)
                    {
                        return { parent: node, name: child.name };
                    }
                    pending.push(child);
                }
            }
            return null;
        },

        /** @param {RegistryKey} key @param {string} name @returns {boolean} */
        deleteValue(key, name){
            const deleted = writable(key)?.values.delete(fold(name)) ?? false;
            if (deleted)
            {
                changed();
            }
            return deleted;
        },

        /** Moves with every change and never with a restore. */
        revision: ()=>revision,

        /**
         * Asks to be told when the hive has changed. A restore is not a change.
         *
         * @param {() => void} listener
         * @returns {() => void} forgets the listener
         */
        onChanged(listener){
            listeners.push(listener);
            return ()=>{
                const at = listeners.indexOf(listener);
                if (at >= 0)
                {
                    listeners.splice(at, 1);
                }
            };
        },

        /**
         * The whole hive as a plain object. Roots are a list rather than an
         * object so that nothing depends on how a JSON implementation orders
         * numeric keys. The classes root is not among them: what it shows is
         * already under the two roots it is a view of.
         *
         * @returns {{ roots: { id: number, key: StoredKey }[] }}
         */
        toJSON(){
            return {
                roots: [...roots.entries()].map(([id, key])=>({ id, key: keyToJSON(key) })),
            };
        },

        /**
         * Replaces the contents with a saved tree. Roots the save does not
         * mention come back empty rather than missing, so a hive is always
         * usable after a restore. A save that kept the classes root as a tree
         * of its own has it folded into the machine's classes, keeping what
         * the machine side already says: the classes a program registered
         * there are still found.
         *
         * @param {any} stored
         */
        fromJSON(stored){
            reset();
            /** @type {RegistryNode[]} */
            const classes = [];
            for (const entry of stored?.roots ?? [])
            {
                const id = entry?.id >>> 0;
                if (id === HKEY_CLASSES_ROOT)
                {
                    classes.push(keyFromJSON(entry.key));
                }
                else if (ROOT_NAMES.has(id))
                {
                    roots.set(id, keyFromJSON(entry.key));
                }
            }
            furnish();
            const machine = /** @type {RegistryNode} */ (
                walk(roots.get(HKEY_LOCAL_MACHINE), segments(MACHINE_CLASSES)));
            for (const tree of classes)
            {
                mergeMissing(machine, tree);
            }
        },

        /**
         * Adds what a saved tree holds and this hive does not, leaving every
         * key and value already here as it is: the registry an installation
         * left, beneath what the programs run since have written over it.
         *
         * @param {any} stored
         */
        fillFromJSON(stored){
            for (const entry of stored?.roots ?? [])
            {
                const id = entry?.id >>> 0;
                const tree = keyFromJSON(entry.key);
                if (id === HKEY_CLASSES_ROOT)
                {
                    mergeMissing(/** @type {RegistryNode} */ (
                        walk(roots.get(HKEY_LOCAL_MACHINE), segments(MACHINE_CLASSES))), tree);
                }
                else if (ROOT_NAMES.has(id))
                {
                    const root = roots.get(id);
                    if (root)
                    {
                        mergeMissing(root, tree);
                    }
                    else
                    {
                        roots.set(id, tree);
                    }
                }
            }
        },
    };
}
