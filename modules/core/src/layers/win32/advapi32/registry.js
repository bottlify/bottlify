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
 * whose end nobody can find.
 *
 * @param {number} type @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function terminate(type, data){
    if (!STRING_TYPES.has(type))
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
 */

/**
 * Where the shell keeps its folders, by the names the registry lists them
 * under. One table, because a program reads the same folder two ways -- the
 * registry value and the shell's own call -- and compares what it got.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SHELL_FOLDERS = Object.freeze({
    Desktop: 'C:\\Documents and Settings\\User\\Desktop',
    Programs: 'C:\\Documents and Settings\\User\\Start Menu\\Programs',
    'Start Menu': 'C:\\Documents and Settings\\User\\Start Menu',
    Startup: 'C:\\Documents and Settings\\User\\Start Menu\\Programs\\Startup',
    Personal: 'C:\\Documents and Settings\\User\\My Documents',
    AppData: 'C:\\Documents and Settings\\User\\Application Data',
    'Local AppData': 'C:\\Documents and Settings\\User\\Local Settings\\Application Data',
    Fonts: 'C:\\WINDOWS\\Fonts',
    Profile: 'C:\\Documents and Settings\\User',
    'Common Desktop': 'C:\\Documents and Settings\\All Users\\Desktop',
    'Common Programs': 'C:\\Documents and Settings\\All Users\\Start Menu\\Programs',
    'Common Start Menu': 'C:\\Documents and Settings\\All Users\\Start Menu',
    'Common Startup': 'C:\\Documents and Settings\\All Users\\Start Menu\\Programs\\Startup',
    'Common Documents': 'C:\\Documents and Settings\\All Users\\Documents',
    'Common AppData': 'C:\\Documents and Settings\\All Users\\Application Data',
    Windows: 'C:\\WINDOWS',
    System: 'C:\\WINDOWS\\system32',
    ProgramFiles: 'C:\\Program Files',
    CommonFiles: 'C:\\Program Files\\Common Files',
});

/**
 * The DirectX this machine has, as its own setup library reads it back: 9.0c,
 * the newest of the interfaces the drawing layer answers for.
 */
export const DIRECTX_VERSION = '4.09.00.0904';

/**
 * @param {Readonly<Record<string, string>>} table @param {string[]} names
 * @returns {Record<string, string>}
 */
const pick = (table, names)=>Object.fromEntries(names.map(name=>[name, table[name]]));

/**
 * The keys and values every Windows installation carries before any program
 * has run, as far as a program of the era asks for them: where programs go,
 * where the shared-library counts live, where an installer registers what it
 * put there and where the shell keeps its folders. An installer opens these
 * without creating them and takes a missing one for a broken machine.
 *
 * Every string is stored as REG_SZ; a path is what this machine's volume
 * actually holds, so what a program reads here it can then open.
 *
 * @type {readonly MachineKey[]}
 */
const MACHINE_KEYS = Object.freeze(/** @type {MachineKey[]} */ ([
    { root: HKEY_LOCAL_MACHINE, path: MACHINE_CLASSES },
    { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion', values: {
        ProgramFilesDir: SHELL_FOLDERS.ProgramFiles,
        ProgramFilesPath: SHELL_FOLDERS.ProgramFiles,
        CommonFilesDir: SHELL_FOLDERS.CommonFiles,
        SystemRoot: SHELL_FOLDERS.Windows,
        MediaPath: 'C:\\WINDOWS\\Media',
    } },
    { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs' },
    { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Setup' },
    { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
    { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths' },
    { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' },
    { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce' },
    { root: HKEY_LOCAL_MACHINE,
        path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
        values: pick(SHELL_FOLDERS, ['Common Desktop', 'Common Programs', 'Common Start Menu',
            'Common Startup', 'Common Documents']) },
    { root: HKEY_LOCAL_MACHINE, path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', values: {
        CurrentVersion: '5.1',
        CurrentBuildNumber: '2600',
        ProductName: 'Microsoft Windows XP',
        SystemRoot: 'C:\\WINDOWS',
        PathName: 'C:\\WINDOWS',
    } },
    { root: HKEY_LOCAL_MACHINE, path: 'SYSTEM\\CurrentControlSet\\Control\\Session Manager' },
    // What the kernel wrote about the processor it found: the identifier is
    // the emulated CPUID's family, model and stepping, and the speed the
    // emulated counter's rate. A program reads the speed from here before it
    // measures anything, and one that finds no key reports a 0 MHz machine.
    { root: HKEY_LOCAL_MACHINE, path: 'HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0',
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
        Version: DIRECTX_VERSION,
        InstalledVersion: Uint8Array.of(0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x09, 0x04),
        InstalledCount: 1,
        RC: 0,
    } },
    { root: HKEY_CURRENT_USER, path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
    { root: HKEY_CURRENT_USER,
        path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
        values: pick(SHELL_FOLDERS, ['Desktop', 'Programs', 'Start Menu', 'Startup', 'Personal',
            'AppData', 'Local AppData', 'Fonts']) },
    { root: HKEY_CURRENT_USER, path: 'Control Panel\\Desktop' },
    { root: HKEY_CURRENT_USER, path: USER_CLASSES },
]));

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
 * them (see MACHINE_KEYS), and nothing a program has put there yet.
 *
 * Enumeration order is insertion order throughout, which is what makes an
 * index-based enumeration answer the same thing twice. Overwriting a value
 * leaves it where it was; only deleting and re-adding moves it to the end.
 */
export function createHive(){
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
    const changed = ()=>{
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
     * it would on a machine whose registry was repaired.
     */
    const furnish = ()=>{
        for (const entry of MACHINE_KEYS)
        {
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
            for (const [name, value] of Object.entries(entry.values ?? {}))
            {
                if (!node.values.has(fold(name)))
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
     * @param {RegistryNode} key @param {string | null} [path]
     * @returns {'deleted' | 'missing' | 'has-subkeys'}
     */
    const removeNode = (key, path)=>{
        const target = parentOf(key, path);
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

        /** @param {RegistryKey} key @param {string} name @returns {boolean} */
        deleteValue(key, name){
            const deleted = writable(key)?.values.delete(fold(name)) ?? false;
            if (deleted)
            {
                changed();
            }
            return deleted;
        },

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
    };
}
