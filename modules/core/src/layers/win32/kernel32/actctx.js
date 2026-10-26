/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Activation contexts: the assemblies a manifest names, and what they redirect.
 *
 * A context is built from a manifest -- a file, a module's RT_MANIFEST
 * resource, an executable's own -- and the assemblies it depends on, each
 * found as Windows finds it: in the bottle's side-by-side store (a strong
 * name), then privately beside the application (`<name>.dll` with its
 * manifest as resource 1, `<name>.manifest`, then both under a `<name>\`
 * folder), at exactly the version asked for, then among the assemblies the
 * engine itself provides. One that cannot be found fails the whole context,
 * as Windows fails it. The context answers FindActCtxSectionString for the
 * DLLs its assemblies hold and the window classes they register, laid out in
 * guest memory as Windows lays its sections out, and QueryActCtx for itself,
 * its assemblies and their files.
 *
 * Contexts live in guest memory: a handle is the address of a small block the
 * guest never reads, so CloseHandle refuses it as it does on Windows. Each
 * thread's activation stack is the one its TEB points at
 * (ActivationContextStackPointer), with each frame linked to the one below,
 * so what a program reads off its TEB is what these calls keep.
 *
 * The loader takes its process default context from here and asks here where
 * a DLL a context redirects lives (`loaderApi`).
 */

import {
    compareVersions, encodeIdentity, identityMatches, parseManifest,
} from './manifest.js';

/** Codes and statuses these calls answer with. */
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_RESOURCE_NAME_NOT_FOUND = 1814;
const ERROR_SXS_CANT_GEN_ACTCTX = 14001;
const ERROR_SXS_SECTION_NOT_FOUND = 14000;
const ERROR_SXS_KEY_NOT_FOUND = 14007;
const ERROR_SXS_EARLY_DEACTIVATION = 14084;
const ERROR_SXS_INVALID_DEACTIVATION = 14085;
const ERROR_SXS_PROCESS_DEFAULT_ALREADY_SET = 14011;
const STATUS_SUCCESS = 0;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const STATUS_SXS_SECTION_NOT_FOUND = 0xc0150001;
const STATUS_SXS_KEY_NOT_FOUND = 0xc0150008;

const INVALID_HANDLE_VALUE = 0xffffffff;

/** ACTCTX's flags, and its fields' offsets. */
const ACTCTX_FLAG_PROCESSOR_ARCHITECTURE_VALID = 0x1;
const ACTCTX_FLAG_LANGID_VALID = 0x2;
const ACTCTX_FLAG_ASSEMBLY_DIRECTORY_VALID = 0x4;
const ACTCTX_FLAG_RESOURCE_NAME_VALID = 0x8;
const ACTCTX_FLAG_SET_PROCESS_DEFAULT = 0x10;
const ACTCTX_FLAG_APPLICATION_NAME_VALID = 0x20;
const ACTCTX_FLAG_HMODULE_VALID = 0x80;
const ACTCTX = Object.freeze({ cbSize: 0, dwFlags: 4, lpSource: 8, wProcessorArchitecture: 12,
    wLangId: 14, lpAssemblyDirectory: 16, lpResourceName: 20, lpApplicationName: 24, hModule: 28 });
/** Each field's end, which cbSize has to reach for its flag to be valid. */
const FIELD_ENDS = Object.freeze([
    [ACTCTX_FLAG_PROCESSOR_ARCHITECTURE_VALID, 14], [ACTCTX_FLAG_LANGID_VALID, 16],
    [ACTCTX_FLAG_ASSEMBLY_DIRECTORY_VALID, 20], [ACTCTX_FLAG_RESOURCE_NAME_VALID, 24],
    [ACTCTX_FLAG_APPLICATION_NAME_VALID, 28], [ACTCTX_FLAG_HMODULE_VALID, 32],
]);

/** RT_MANIFEST, and the resources a module's manifest is. */
const RT_MANIFEST = 24;
const CREATEPROCESS_MANIFEST_RESOURCE_ID = 1;
const ISOLATIONAWARE_MANIFEST_RESOURCE_ID = 2;

/** The sections FindActCtxSectionString looks in. */
const SECTION_DLL_REDIRECTION = 2;
const SECTION_WINDOW_CLASS_REDIRECTION = 3;
/** The highest section number Windows defines; past it no context has the section. */
const SECTION_LAST = 13;
const FIND_ACTCTX_SECTION_KEY_RETURN_HACTCTX = 0x1;
const FIND_ACTCTX_SECTION_KEY_RETURN_FLAGS = 0x2;
const FIND_ACTCTX_SECTION_KEY_RETURN_ASSEMBLY_METADATA = 0x4;
const KEYED_DATA_FLAG_FOUND_IN_PROCESS_DEFAULT = 0x1;
/** ACTCTX_SECTION_KEYED_DATA: what has to be there, and where its fields are. */
const KEYED_DATA_MINIMUM = 36;
const KEYED_DATA_FLAGS_END = 44;
const KEYED_DATA_FULL = 64;

/** A string section, as Windows lays it out: 'SsHd', then an index, names and data. */
const STRING_SECTION_MAGIC = 0x64487353;
const STRING_SECTION_HEADER = 44;
const STRING_INDEX_ENTRY = 24;
/** DLL_REDIRECT_PATH_OMITS_ASSEMBLY_ROOT: the DLL is in its assembly's directory. */
const DLL_REDIRECT_PATH_OMITS_ASSEMBLY_ROOT = 0x2;
const DLL_REDIRECT_DATA = 20;
const WNDCLASS_REDIRECT_DATA = 24;

/** QueryActCtxW's flags and classes. */
const QUERY_ACTCTX_FLAG_USE_ACTIVE_ACTCTX = 0x4;
const QUERY_ACTCTX_FLAG_ACTCTX_IS_HMODULE = 0x8;
const QUERY_ACTCTX_FLAG_ACTCTX_IS_ADDRESS = 0x10;
const QUERY_ACTCTX_FLAG_NO_ADDREF = 0x80000000;
const BASIC_INFORMATION = 1;
const DETAILED_INFORMATION = 2;
const ASSEMBLY_DETAILED_INFORMATION = 3;
const FILE_INFORMATION_IN_ASSEMBLY = 4;
const RUN_LEVEL_INFORMATION = 5;
const COMPATIBILITY_INFORMATION = 6;
const ACTIVATION_CONTEXT_PATH_TYPE_NONE = 1;
const ACTIVATION_CONTEXT_PATH_TYPE_WIN32_FILE = 2;
const DETAILED_SIZE = 48;
const ASSEMBLY_DETAILED_SIZE = 88;
const FILE_DETAILED_SIZE = 20;
const COMPATIBILITY_HEADER = 8;
const COMPATIBILITY_ELEMENT = 32;
const ACTCTX_COMPATIBILITY_ELEMENT_TYPE_OS = 1;
const ACTCTX_COMPATIBILITY_ELEMENT_TYPE_MAXVERSIONTESTED = 3;

/** The TEB's ActivationContextStackPointer, and the stack and frames it leads to. */
const TEB_ACTIVATION_STACK = 0x1a8;
const STACK_SIZE = 24;
const FRAME_SIZE = 12;
/** A frame these calls allocated, as against one the caller did. */
const FRAME_HEAP_ALLOCATED = 0x8;
/** DeactivateActCtx's flag that takes the frames above the cookie's off with it. */
const DEACTIVATE_ACTCTX_FLAG_FORCE_EARLY_DEACTIVATION = 0x1;
/** The caller-allocated extended frame: Size, Format, then the frame itself. */
const EXTENDED_FRAME_AT = 8;

/** The block a handle addresses, and the mark that says it is one of these. */
const CONTEXT_BLOCK = 8;
const CONTEXT_MAGIC = 0xc07e3e11;

/**
 * @typedef {import('./manifest.js').Identity} Identity
 * @typedef {import('./manifest.js').Manifest} Manifest
 */

/**
 * @typedef {Object} Assembly
 * @property {Identity} identity
 * @property {Manifest} manifest
 * @property {string | null} manifestPath  null for a manifest that is no file
 * @property {string | null} directory  where its files are, with a trailing separator;
 *     null for the root, whose files are the application's
 * @property {string | null} directoryName  what QueryActCtx gives as its directory name
 */

/**
 * @typedef {Object} Context
 * @property {number} handle
 * @property {number} references
 * @property {Assembly[]} assemblies  the root first
 * @property {string} appDirectory  with a trailing separator
 * @property {string | null} rootManifestPath
 * @property {Map<number, { base: number, size: number,
 *     entries: Map<string, { offset: number, length: number, roster: number }> } | null>} sections
 */

/**
 * @typedef {Object} StoreAssembly
 * @property {Identity} identity
 * @property {string} directory  with a trailing separator
 * @property {string} directoryName
 * @property {string | null} manifestPath
 * @property {Manifest} manifest
 */

/**
 * @typedef {Object} ActCtxHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString  limit in bytes
 * @property {(code: number) => void} setLastError
 * @property {(bytes: number) => number} allocate  guest memory, or 0
 * @property {(bytes: number) => number} [allocateCode]
 *     Guest memory the processor executes, for the fastcall entries.
 * @property {(address: number) => void} [free]
 * @property {() => number} teb  the running thread's
 * @property {(path: string) => Uint8Array | null | Promise<Uint8Array | null>} readFile
 * @property {(path: string) => { exists?: boolean, isDirectory?: boolean } | null} stat
 * @property {(path: string, pattern: string) => { name: string, isDirectory: boolean }[]} [list]
 * @property {(path: string) => string} fullPath  a path the way the file calls resolve it
 * @property {() => string} imagePath  the running program's
 * @property {(base: number, type: number, id: number) => Uint8Array | null} [moduleResource]
 *     A loaded module's resource, by its base.
 * @property {(path: string, type: number, id: number)
 *     => Uint8Array | null | Promise<Uint8Array | null>} [fileResource]
 *     A resource of an image on the volume, read as data.
 * @property {(address: number) => number | null} [moduleAt]  the base of the module holding it
 * @property {(name: string) => boolean} [answers]  whether the engine's own table has a DLL
 * @property {(base: number) => string | null} [modulePath]
 * @property {(text: string) => Uint8Array} encodeAnsi
 * @property {(bytes: Uint8Array) => string} decodeAnsi
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {string} text */
const wide = text=>{
    const bytes = new Uint8Array(text.length * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
    }
    return bytes;
};

/**
 * RtlHashUnicodeString's X65599 over the upper-cased string: what a string
 * section's index is ordered by.
 *
 * @param {string} key
 */
export const hashKey = key=>{
    let hash = 0;
    for (const unit of key.toUpperCase())
    {
        hash = (Math.imul(hash, 65599) + unit.charCodeAt(0)) >>> 0;
    }
    return hash;
};

/** @param {string} path */
const directoryOf = path=>path.slice(0, path.lastIndexOf('\\') + 1);

/**
 * The system assemblies the engine's store provides, as a Windows with the
 * Visual C++ redistributables installed holds them: Common Controls 6 is the
 * engine's comctl32, and each runtime's DLLs are the engine's own where it
 * has them and otherwise the bottle's copy, wherever the bottle keeps it
 * (`bottleCopyOf`). An assembly is there when its first file is -- answered
 * by the engine or found in the bottle -- and its files are seen at its
 * store directory, so a runtime that checks where it was loaded from finds
 * itself in WinSxS, as an installed one is.
 */
const VC_TOKEN = '1fc8b3b9a1e18e3b';
const VC80 = [8, 0, 50727, 6195];
const VC90 = [9, 0, 30729, 6161];
const ENGINE_ASSEMBLIES = Object.freeze([
    { name: 'Microsoft.Windows.Common-Controls', version: [6, 0, 2600, 2180],
        publicKeyToken: '6595b64144ccf1df', files: ['comctl32.dll'] },
    { name: 'Microsoft.VC80.CRT', version: VC80, publicKeyToken: VC_TOKEN,
        files: ['msvcr80.dll', 'msvcp80.dll', 'msvcm80.dll'] },
    { name: 'Microsoft.VC80.OpenMP', version: VC80, publicKeyToken: VC_TOKEN,
        files: ['vcomp.dll'] },
    { name: 'Microsoft.VC80.ATL', version: VC80, publicKeyToken: VC_TOKEN,
        files: ['atl80.dll'] },
    { name: 'Microsoft.VC80.MFC', version: VC80, publicKeyToken: VC_TOKEN,
        files: ['mfc80.dll', 'mfc80u.dll', 'mfcm80.dll', 'mfcm80u.dll'] },
    { name: 'Microsoft.VC90.CRT', version: VC90, publicKeyToken: VC_TOKEN,
        files: ['msvcr90.dll', 'msvcp90.dll', 'msvcm90.dll'] },
    { name: 'Microsoft.VC90.OpenMP', version: VC90, publicKeyToken: VC_TOKEN,
        files: ['vcomp90.dll'] },
    { name: 'Microsoft.VC90.ATL', version: VC90, publicKeyToken: VC_TOKEN,
        files: ['atl90.dll'] },
    { name: 'Microsoft.VC90.MFC', version: VC90, publicKeyToken: VC_TOKEN,
        files: ['mfc90.dll', 'mfc90u.dll', 'mfcm90.dll', 'mfcm90u.dll'] },
]);

/** Where a bottle keeps a runtime it was given outside the store, in the order looked. */
const BOTTLE_PLACES = ['C:\\WINDOWS\\system32\\', 'C:\\WINDOWS\\'];

/** Where the side-by-side store is. */
const STORE = 'C:\\WINDOWS\\WinSxS\\';

/**
 * A store directory's name, as Windows XP names one:
 * `x86_<name>_<token>_<version>_x-ww_<hash>`.
 *
 * @param {Identity} identity
 */
const storeDirectoryName = identity=>{
    const version = (identity.version ?? [0, 0, 0, 0]).join('.');
    const hash = hashKey(`${identity.name}_${version}`).toString(16).padStart(8, '0');
    return `x86_${identity.name}_${identity.publicKeyToken ?? 'none'}_${version}_x-ww_${hash}`;
};

/**
 * @param {ActCtxHost} host
 */
export function createActivationContexts(host){
    /** @type {Map<number, Context>} */
    const contexts = new Map();
    /** @type {Context | null} */
    let processDefault = null;

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address >>> 0, new Uint8Array(new Uint32Array([value >>> 0]).buffer));
    };
    /** @param {number} address @param {number} value */
    const writeDwordIf = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            writeDword(address, value);
        }
    };
    /** @param {number} code @param {number} [answer] */
    const fail = (code, answer = 0)=>{
        host.setLastError(code);
        return answer;
    };
    /** Guest memory, its bytes zero, or 0. @param {number} size */
    const allocate = size=>{
        const at = host.allocate(size);
        if (at !== 0)
        {
            host.writeMemory(at, new Uint8Array(size));
        }
        return at;
    };

    // ----------------------------------------------------------------- building

    /**
     * A manifest's bytes from a file, a module's resource or an image's,
     * parsed.
     *
     * @param {Uint8Array | null} bytes
     * @returns {Manifest | null}
     */
    const parsed = bytes=>{
        if (bytes === null)
        {
            return null;
        }
        const read = parseManifest(bytes);
        return 'manifest' in read ? read.manifest : null;
    };

    /**
     * The bottle's own store: every manifest under WinSxS\Manifests, its
     * files in the directory of the same name, and the publisher policies
     * under WinSxS\Policies.
     *
     * @returns {Promise<{ assemblies: StoreAssembly[], policies: Manifest[] }>}
     */
    const readBottleStore = async()=>{
        /** @type {StoreAssembly[]} */
        const assemblies = [];
        /** @type {Manifest[]} */
        const policies = [];
        const list = host.list ?? (()=>[]);
        for (const entry of list(`${STORE}Manifests`, '*.manifest'))
        {
            const manifestPath = `${STORE}Manifests\\${entry.name}`;
            const manifest = parsed(await host.readFile(manifestPath));
            if (manifest?.identity)
            {
                const directoryName = entry.name.replace(/\.manifest$/i, '');
                assemblies.push({ identity: manifest.identity, manifest, manifestPath,
                    directory: `${STORE}${directoryName}\\`, directoryName });
            }
        }
        for (const folder of list(`${STORE}Policies`, '*').filter(entry=>entry.isDirectory))
        {
            for (const entry of list(`${STORE}Policies\\${folder.name}`, '*.policy'))
            {
                const policy = parsed(await host.readFile(
                    `${STORE}Policies\\${folder.name}\\${entry.name}`));
                if (policy?.redirectsFor)
                {
                    policies.push(policy);
                }
            }
        }
        return { assemblies, policies };
    };
    /** The bottle's own store, read once, when a strong name is first looked for. */
    /** @type {{ assemblies: StoreAssembly[], policies: Manifest[] } | null} */
    let storeRead = null;

    /**
     * The version a store lookup asks for once publisher policy has had its
     * say: a binding redirect whose range holds the version asked for.
     *
     * @param {Identity} wanted @param {Manifest[]} policies
     */
    const redirected = (wanted, policies)=>{
        if (!wanted.version)
        {
            return wanted.version;
        }
        for (const policy of policies)
        {
            const target = /** @type {Identity} */ (policy.redirectsFor);
            if (target.name.toLowerCase() !== wanted.name.toLowerCase()
                || (target.publicKeyToken ?? '').toLowerCase()
                    !== (wanted.publicKeyToken ?? '').toLowerCase())
            {
                continue;
            }
            for (const redirect of policy.redirects)
            {
                if (compareVersions(redirect.oldVersion[0], wanted.version) <= 0
                    && compareVersions(wanted.version, redirect.oldVersion[1]) <= 0)
                {
                    return redirect.newVersion;
                }
            }
        }
        return wanted.version;
    };

    /**
     * An assembly the bottle's store holds for a strong name.
     *
     * @param {Identity} wanted
     * @returns {Promise<StoreAssembly | null>}
     */
    const fromBottleStore = async wanted=>{
        storeRead ??= await readBottleStore();
        const version = redirected(wanted, storeRead.policies);
        return storeRead.assemblies.find(assembly=>identityMatches({ ...wanted, version },
            assembly.identity)) ?? null;
    };

    /**
     * Where the bottle has its own copy of a store DLL: the system
     * directories, then beside the program. Null when it has none.
     *
     * @param {string} name
     */
    const bottleCopyOf = name=>{
        for (const place of [...BOTTLE_PLACES, directoryOf(host.imagePath())])
        {
            const entry = host.stat(`${place}${name}`);
            if (entry?.exists && !entry.isDirectory)
            {
                return `${place}${name}`;
            }
        }
        return null;
    };

    /**
     * An assembly the engine provides, for a dependency on one of its major
     * and minor version at or below the one provided -- what the runtimes'
     * own publisher policies redirect to the newest they install -- when its
     * first file is the engine's or the bottle's.
     *
     * @param {Identity} wanted
     * @returns {StoreAssembly | null}
     */
    const fromEngine = wanted=>{
        for (const provided of ENGINE_ASSEMBLIES)
        {
            const [first] = provided.files;
            if (!(host.answers?.(first) ?? false) && bottleCopyOf(first) === null)
            {
                continue;
            }
            /** @type {Identity} */
            const identity = { name: provided.name, type: 'win32', version: provided.version,
                processorArchitecture: 'x86', publicKeyToken: provided.publicKeyToken,
                language: null };
            const version = wanted.version;
            if (!identityMatches({ ...wanted, version: null }, identity)
                || (version && (version[0] !== provided.version[0]
                    || version[1] !== provided.version[1]
                    || compareVersions(version, provided.version) > 0)))
            {
                continue;
            }
            const directoryName = storeDirectoryName(identity);
            return {
                identity, directoryName, directory: `${STORE}${directoryName}\\`,
                manifestPath: `${STORE}Manifests\\${directoryName}.manifest`,
                manifest: { identity, files: provided.files.map(name=>({ name, loadFrom: null,
                    windowClasses: [] })), dependencies: [], noInheritable: true, runLevel: null,
                compatibility: { supportedOs: [], maxVersionTested: [] }, settings: new Map(),
                redirects: [], redirectsFor: null },
            };
        }
        return null;
    };

    /**
     * A private assembly beside the application, at exactly the version
     * asked for: `<name>.dll` (its manifest resource 1), `<name>.manifest`,
     * then the two of them in a `<name>\` folder.
     *
     * @param {Identity} wanted @param {string} directory
     * @returns {Promise<StoreAssembly | null>}
     */
    const fromApplication = async(wanted, directory)=>{
        for (const folder of [directory, `${directory}${wanted.name}\\`])
        {
            for (const kind of ['dll', 'manifest'])
            {
                const path = `${folder}${wanted.name}.${kind}`;
                const entry = host.stat(path);
                if (!entry?.exists || entry.isDirectory)
                {
                    continue;
                }
                const bytes = kind === 'dll'
                    ? await host.fileResource?.(path, RT_MANIFEST,
                        CREATEPROCESS_MANIFEST_RESOURCE_ID) ?? null
                    : await host.readFile(path);
                const manifest = parsed(bytes);
                if (manifest?.identity && identityMatches(wanted, manifest.identity))
                {
                    return { identity: manifest.identity, manifest, manifestPath: path,
                        directory: folder, directoryName: folder.slice(0, -1) };
                }
            }
        }
        return null;
    };

    /**
     * A dependency, found where Windows looks: the bottle's store for a
     * strong name, beside the application, then what the engine provides.
     *
     * @param {Identity} wanted @param {string} directory
     */
    const resolve = async(wanted, directory)=>{
        if (wanted.publicKeyToken)
        {
            const stored = await fromBottleStore(wanted);
            if (stored)
            {
                return stored;
            }
        }
        return await fromApplication(wanted, directory) ?? fromEngine(wanted);
    };

    /**
     * A context from a root manifest: the root, then every assembly it
     * depends on, each once, in the order they are first named.
     *
     * @param {Manifest} root
     * @param {{ manifestPath: string | null, appDirectory: string }} where
     * @returns {Promise<Context | string>} the context, or why there is none
     */
    const build = async(root, where)=>{
        /** @type {Assembly[]} */
        const assemblies = [{ identity: root.identity ?? { name: '', type: null, version: null,
            processorArchitecture: null, publicKeyToken: null, language: null },
        manifest: root, manifestPath: where.manifestPath, directory: null, directoryName: null }];
        for (let at = 0; at < assemblies.length; at++)
        {
            for (const dependency of assemblies[at].manifest.dependencies)
            {
                if (assemblies.some(held=>held.directory !== null
                    && identityMatches(dependency.identity, held.identity)))
                {
                    continue;
                }
                const found = await resolve(dependency.identity, where.appDirectory);
                if (!found)
                {
                    if (dependency.optional)
                    {
                        continue;
                    }
                    return `no assembly ${encodeIdentity(dependency.identity)}`;
                }
                assemblies.push({ ...found });
            }
        }
        const handle = allocate(CONTEXT_BLOCK);
        if (handle === 0)
        {
            return 'no memory for the context';
        }
        writeDword(handle, CONTEXT_MAGIC);
        /** @type {Context} */
        const context = { handle, references: 1, assemblies, appDirectory: where.appDirectory,
            rootManifestPath: where.manifestPath, sections: new Map() };
        contexts.set(handle, context);
        return context;
    };

    /** @param {number} handle */
    const contextOf = handle=>contexts.get(handle >>> 0) ?? null;

    /** @param {Context | null} context */
    const addRef = context=>{
        if (context)
        {
            context.references++;
        }
    };
    /** @param {Context | null} context */
    const release = context=>{
        if (!context || --context.references > 0)
        {
            return;
        }
        contexts.delete(context.handle);
        for (const section of context.sections.values())
        {
            if (section)
            {
                host.free?.(section.base);
            }
        }
        host.free?.(context.handle);
    };

    // ----------------------------------------------------------------- sections

    /**
     * A string section of a context, built the first time it is asked for
     * and kept in guest memory while the context lives; null when no
     * assembly of the context has an entry for it.
     *
     * @param {Context} context @param {number} id
     */
    const sectionOf = (context, id)=>{
        if (context.sections.has(id))
        {
            return context.sections.get(id) ?? null;
        }
        /** @type {{ key: string, roster: number, data: (at: number) => Uint8Array }[]} */
        const items = [];
        const seen = new Set();
        context.assemblies.forEach((assembly, index)=>{
            for (const file of assembly.manifest.files)
            {
                if (id === SECTION_DLL_REDIRECTION && !seen.has(file.name.toUpperCase()))
                {
                    seen.add(file.name.toUpperCase());
                    items.push({ key: file.name, roster: index + 1, data: ()=>{
                        const bytes = new Uint8Array(DLL_REDIRECT_DATA);
                        const view = new DataView(bytes.buffer);
                        view.setUint32(0, DLL_REDIRECT_DATA, true);
                        view.setUint32(4, DLL_REDIRECT_PATH_OMITS_ASSEMBLY_ROOT, true);
                        return bytes;
                    } });
                }
                if (id !== SECTION_WINDOW_CLASS_REDIRECTION)
                {
                    continue;
                }
                for (const windowClass of file.windowClasses)
                {
                    if (seen.has(windowClass.name.toUpperCase()))
                    {
                        continue;
                    }
                    seen.add(windowClass.name.toUpperCase());
                    const versioned = windowClass.versioned && assembly.identity.version
                        ? `${assembly.identity.version.join('.')}!${windowClass.name}`
                        : windowClass.name;
                    items.push({ key: windowClass.name, roster: index + 1, data: at=>{
                        // The versioned name follows the header, then the module's.
                        const name = wide(`${versioned}\0`);
                        const module = wide(`${file.name}\0`);
                        const bytes = new Uint8Array(WNDCLASS_REDIRECT_DATA + name.length
                            + module.length);
                        const view = new DataView(bytes.buffer);
                        view.setUint32(0, WNDCLASS_REDIRECT_DATA, true);
                        view.setUint32(8, name.length - 2, true);
                        view.setUint32(12, WNDCLASS_REDIRECT_DATA, true);
                        view.setUint32(16, module.length - 2, true);
                        view.setUint32(20, at + WNDCLASS_REDIRECT_DATA + name.length, true);
                        bytes.set(name, WNDCLASS_REDIRECT_DATA);
                        bytes.set(module, WNDCLASS_REDIRECT_DATA + name.length);
                        return bytes;
                    } });
                }
            }
        });
        if (items.length === 0)
        {
            context.sections.set(id, null);
            return null;
        }
        items.sort((a, b)=>hashKey(a.key) - hashKey(b.key));
        // Header, index, the names, then each entry's data.
        let at = STRING_SECTION_HEADER + STRING_INDEX_ENTRY * items.length;
        const names = items.map(item=>{
            const bytes = wide(`${item.key}\0`);
            const offset = at;
            at += (bytes.length + 3) & ~3;
            return { bytes, offset };
        });
        const datas = items.map(item=>{
            const offset = at;
            const bytes = item.data(offset);
            at += (bytes.length + 3) & ~3;
            return { bytes, offset };
        });
        const image = new Uint8Array(at);
        const view = new DataView(image.buffer);
        view.setUint32(0, STRING_SECTION_MAGIC, true);
        view.setUint32(4, STRING_SECTION_HEADER, true);
        view.setUint32(8, 1, true);
        view.setUint32(20, items.length, true);
        view.setUint32(24, STRING_SECTION_HEADER, true);
        /** @type {Map<string, { offset: number, length: number, roster: number }>} */
        const entries = new Map();
        items.forEach((item, index)=>{
            const entry = STRING_SECTION_HEADER + STRING_INDEX_ENTRY * index;
            view.setUint32(entry, hashKey(item.key), true);
            view.setUint32(entry + 4, names[index].offset, true);
            view.setUint32(entry + 8, names[index].bytes.length - 2, true);
            view.setUint32(entry + 12, datas[index].offset, true);
            view.setUint32(entry + 16, datas[index].bytes.length, true);
            view.setUint32(entry + 20, item.roster, true);
            image.set(names[index].bytes, names[index].offset);
            image.set(datas[index].bytes, datas[index].offset);
            entries.set(item.key.toUpperCase(), { offset: datas[index].offset,
                length: datas[index].bytes.length, roster: item.roster });
        });
        const base = allocate(image.length);
        if (base === 0)
        {
            return null;
        }
        host.writeMemory(base, image);
        const section = { base, size: image.length, entries };
        context.sections.set(id, section);
        return section;
    };

    // ----------------------------------------------------------------- stacks

    /**
     * A thread's activation stack, made when first needed: the running
     * thread's unless a TEB is named.
     *
     * @param {boolean} make @param {number} [teb]
     */
    const stackOf = (make, teb = host.teb())=>{
        if (teb === 0)
        {
            return 0;
        }
        let stack = readDword(teb + TEB_ACTIVATION_STACK);
        if (stack === 0 && make)
        {
            stack = allocate(STACK_SIZE);
            if (stack !== 0)
            {
                writeDword(teb + TEB_ACTIVATION_STACK, stack);
            }
        }
        return stack;
    };

    /** The context on top of the running thread's stack, or null for none. */
    const activeContext = ()=>{
        const stack = stackOf(false);
        const frame = stack === 0 ? 0 : readDword(stack);
        return frame === 0 ? null : contextOf(readDword(frame + 4));
    };

    /**
     * Puts a context on top of a thread's stack, in a frame of its own; the
     * frame's address is the cookie.
     *
     * @param {number} handle @param {number} [teb]
     * @returns {number} the cookie, or 0
     */
    const activate = (handle, teb)=>{
        const stack = stackOf(true, teb);
        const frame = stack === 0 ? 0 : allocate(FRAME_SIZE);
        if (frame === 0)
        {
            return 0;
        }
        writeDword(frame, readDword(stack));
        writeDword(frame + 4, handle);
        writeDword(frame + 8, FRAME_HEAP_ALLOCATED);
        writeDword(stack, frame);
        addRef(contextOf(handle));
        return frame;
    };

    /**
     * Takes frames off a thread's stack down to and including the one the
     * cookie names: 'unknown' when no frame on it is that one, 'early' when
     * frames above it would go too and `force` does not say they may.
     *
     * @param {number} cookie @param {number} [teb] @param {boolean} [force]
     * @returns {'done' | 'unknown' | 'early'}
     */
    const deactivate = (cookie, teb, force = true)=>{
        const stack = stackOf(false, teb);
        let frame = stack === 0 ? 0 : readDword(stack);
        /** @type {number[]} */
        const above = [];
        while (frame !== 0 && frame !== (cookie >>> 0))
        {
            above.push(frame);
            frame = readDword(frame);
        }
        if (frame === 0)
        {
            return 'unknown';
        }
        if (above.length > 0 && !force)
        {
            return 'early';
        }
        for (const popped of [...above, frame])
        {
            const flags = readDword(popped + 8);
            release(contextOf(readDword(popped + 4)));
            if ((flags & FRAME_HEAP_ALLOCATED) !== 0)
            {
                host.free?.(popped);
            }
        }
        writeDword(stack, readDword(frame));
        return 'done';
    };

    // ----------------------------------------------------------------- lookups

    /**
     * A key in a section, looked for in the active context and then the
     * process default, or the status that says why not.
     *
     * @param {number} id @param {string} key
     * @returns {{ context: Context, section: { base: number, size: number },
     *     entry: { offset: number, length: number, roster: number }, fallback: boolean }
     *     | { status: number }}
     */
    const find = (id, key)=>{
        const active = activeContext();
        const searched = [active, processDefault].filter((context, index, all)=>
            context !== null && all.indexOf(context) === index);
        let present = false;
        for (const context of /** @type {Context[]} */ (searched))
        {
            if (id >= 1 && id <= SECTION_LAST)
            {
                present = true;
            }
            const section = sectionOf(context, id);
            const entry = section?.entries.get(key.toUpperCase());
            if (section && entry)
            {
                return { context, section, entry, fallback: context !== active };
            }
        }
        return { status: present ? STATUS_SXS_KEY_NOT_FOUND : STATUS_SXS_SECTION_NOT_FOUND };
    };

    /**
     * Writes what a lookup found into an ACTCTX_SECTION_KEYED_DATA as far as
     * its cbSize reaches.
     *
     * @param {number} data @param {number} flags
     * @param {Exclude<ReturnType<typeof find>, { status: number }>} found
     */
    const fillKeyed = (data, flags, found)=>{
        const size = readDword(data);
        const bytes = new Uint8Array(Math.min(size, KEYED_DATA_FULL) - 4);
        const view = new DataView(bytes.buffer);
        const put = (/** @type {number} */ offset, /** @type {number} */ value)=>{
            if (offset + 4 <= bytes.length + 4)
            {
                view.setUint32(offset - 4, value >>> 0, true);
            }
        };
        put(4, 1);
        put(8, found.section.base + found.entry.offset);
        put(12, found.entry.length);
        put(24, found.section.base);
        put(28, found.section.size);
        const returnContext = (flags & FIND_ACTCTX_SECTION_KEY_RETURN_HACTCTX) !== 0;
        put(32, returnContext ? found.context.handle : 0);
        put(36, found.entry.roster);
        if (size >= KEYED_DATA_FLAGS_END && (flags & FIND_ACTCTX_SECTION_KEY_RETURN_FLAGS) !== 0)
        {
            put(40, found.fallback ? KEYED_DATA_FLAG_FOUND_IN_PROCESS_DEFAULT : 0);
        }
        host.writeMemory(data + 4, bytes);
        if (returnContext)
        {
            addRef(found.context);
        }
    };

    /**
     * RtlFindActivationContextSectionString's body, over a key already read.
     *
     * @param {number} flags @param {number} guid @param {number} id
     * @param {string | null} key @param {number} data
     */
    const findString = (flags, guid, id, key, data)=>{
        const known = FIND_ACTCTX_SECTION_KEY_RETURN_HACTCTX | FIND_ACTCTX_SECTION_KEY_RETURN_FLAGS
            | FIND_ACTCTX_SECTION_KEY_RETURN_ASSEMBLY_METADATA;
        if ((flags & ~known) !== 0 || guid !== 0 || key === null
            || (data !== 0 && readDword(data) < KEYED_DATA_MINIMUM))
        {
            return STATUS_INVALID_PARAMETER;
        }
        const found = find(id, key);
        if ('status' in found)
        {
            return found.status;
        }
        if (data !== 0)
        {
            fillKeyed(data, flags, found);
        }
        return STATUS_SUCCESS;
    };

    /** @param {number} status */
    const errorOf = status=>({
        [STATUS_INVALID_PARAMETER]: ERROR_INVALID_PARAMETER,
        [STATUS_SXS_SECTION_NOT_FOUND]: ERROR_SXS_SECTION_NOT_FOUND,
        [STATUS_SXS_KEY_NOT_FOUND]: ERROR_SXS_KEY_NOT_FOUND,
        [STATUS_BUFFER_TOO_SMALL]: ERROR_INSUFFICIENT_BUFFER,
    })[status >>> 0] ?? ERROR_INVALID_PARAMETER;

    /**
     * FindActCtxSectionString in either width: kernel32 wants the data block.
     *
     * @param {(address: number) => string} readKey
     */
    const findSectionString = readKey=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([flags, guid, id, key, data])=>{
            if ((data >>> 0) === 0 || (key >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const status = findString(flags >>> 0, guid >>> 0, id >>> 0, readKey(key >>> 0),
                data >>> 0);
            if (status !== STATUS_SUCCESS)
            {
                return fail(errorOf(status));
            }
            host.setLastError(0);
            return 1;
        },
    });

    // ----------------------------------------------------------------- queries

    /**
     * The context a query is about: the active one, a module's, the one a
     * handle names, or none -- the process default -- for a null handle.
     *
     * @param {number} flags @param {number} handle
     * @returns {{ context: Context | null, handle: number } | null} null when refused
     */
    const queried = (flags, handle)=>{
        if ((flags & QUERY_ACTCTX_FLAG_USE_ACTIVE_ACTCTX) !== 0)
        {
            if (handle !== 0)
            {
                return null;
            }
            const active = activeContext();
            return { context: active, handle: active?.handle ?? 0 };
        }
        if ((flags & (QUERY_ACTCTX_FLAG_ACTCTX_IS_HMODULE | QUERY_ACTCTX_FLAG_ACTCTX_IS_ADDRESS))
            !== 0)
        {
            const base = (flags & QUERY_ACTCTX_FLAG_ACTCTX_IS_ADDRESS) !== 0
                ? host.moduleAt?.(handle) ?? null : handle;
            const own = base === null ? null : moduleContexts.get(base) ?? null;
            return { context: own ?? processDefault, handle: own?.handle ?? 0 };
        }
        if (handle === 0)
        {
            return { context: processDefault, handle: 0 };
        }
        const context = contextOf(handle);
        return context ? { context, handle } : null;
    };

    /**
     * QueryActCtxW's answer for one class: the bytes, laid out for the
     * buffer they go to, or the status that refuses it.
     *
     * @param {Context | null} context @param {number} handle @param {number} kind
     * @param {number} subInstance @param {number} buffer
     * @returns {{ bytes: Uint8Array, written?: number } | { status: number }}
     */
    const answer = (context, handle, kind, subInstance, buffer)=>{
        switch (kind)
        {
            case BASIC_INFORMATION: {
                const bytes = new Uint8Array(8);
                new DataView(bytes.buffer).setUint32(0, handle, true);
                return { bytes };
            }
            case DETAILED_INFORMATION: {
                if (!context)
                {
                    return { bytes: new Uint8Array(DETAILED_SIZE) };
                }
                const root = context.rootManifestPath;
                const app = context.appDirectory;
                const rootBytes = root === null ? new Uint8Array(0) : wide(`${root}\0`);
                const appBytes = wide(`${app}\0`);
                const bytes = new Uint8Array(DETAILED_SIZE + rootBytes.length + appBytes.length);
                const view = new DataView(bytes.buffer);
                view.setUint32(4, 1, true);
                view.setUint32(8, context.assemblies.length, true);
                if (root !== null)
                {
                    view.setUint32(12, ACTIVATION_CONTEXT_PATH_TYPE_WIN32_FILE, true);
                    view.setUint32(16, root.length, true);
                    view.setUint32(36, buffer + DETAILED_SIZE, true);
                    bytes.set(rootBytes, DETAILED_SIZE);
                }
                view.setUint32(20, ACTIVATION_CONTEXT_PATH_TYPE_NONE, true);
                view.setUint32(28, ACTIVATION_CONTEXT_PATH_TYPE_WIN32_FILE, true);
                view.setUint32(32, app.length, true);
                view.setUint32(44, buffer + DETAILED_SIZE + rootBytes.length, true);
                bytes.set(appBytes, DETAILED_SIZE + rootBytes.length);
                return { bytes };
            }
            case ASSEMBLY_DETAILED_INFORMATION: {
                const index = subInstance === 0 ? 0 : readDword(subInstance);
                const assembly = context?.assemblies[index - 1];
                if (!assembly || index === 0)
                {
                    return { status: STATUS_INVALID_PARAMETER };
                }
                const strings = [encodeIdentity(assembly.identity), assembly.manifestPath ?? '',
                    assembly.directoryName ?? ''];
                const encoded = strings.map(text=>(text === '' ? new Uint8Array(0)
                    : wide(`${text}\0`)));
                const bytes = new Uint8Array(ASSEMBLY_DETAILED_SIZE
                    + encoded.reduce((sum, part)=>sum + part.length, 0));
                const view = new DataView(bytes.buffer);
                view.setUint32(0, assembly.directory === null ? 1 : 0x10, true);
                view.setUint32(4, strings[0].length * 2, true);
                view.setUint32(8, ACTIVATION_CONTEXT_PATH_TYPE_WIN32_FILE, true);
                view.setUint32(12, strings[1].length * 2, true);
                view.setUint32(24, ACTIVATION_CONTEXT_PATH_TYPE_NONE, true);
                view.setUint32(44, 1, true);
                view.setUint32(60, strings[2].length * 2, true);
                view.setUint32(80, assembly.manifest.files.length, true);
                let at = ASSEMBLY_DETAILED_SIZE;
                [64, 68, 76].forEach((field, part)=>{
                    if (encoded[part].length > 0)
                    {
                        view.setUint32(field, buffer + at, true);
                        bytes.set(encoded[part], at);
                        at += encoded[part].length;
                    }
                });
                return { bytes };
            }
            case FILE_INFORMATION_IN_ASSEMBLY: {
                const assemblyIndex = subInstance === 0 ? -1 : readDword(subInstance);
                const fileIndex = subInstance === 0 ? -1 : readDword(subInstance + 4);
                const file = context?.assemblies[assemblyIndex]?.manifest.files[fileIndex];
                if (!file)
                {
                    return { status: STATUS_INVALID_PARAMETER };
                }
                const name = wide(`${file.name}\0`);
                const bytes = new Uint8Array(FILE_DETAILED_SIZE + name.length);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, 2, true);
                view.setUint32(4, file.name.length * 2, true);
                view.setUint32(12, buffer + FILE_DETAILED_SIZE, true);
                bytes.set(name, FILE_DETAILED_SIZE);
                return { bytes, written: 0 };
            }
            case RUN_LEVEL_INFORMATION: {
                const bytes = new Uint8Array(12);
                const runLevel = context?.assemblies[0].manifest.runLevel ?? null;
                const view = new DataView(bytes.buffer);
                view.setUint32(4, runLevel?.level ?? 0, true);
                view.setUint32(8, runLevel?.uiAccess ? 1 : 0, true);
                return { bytes };
            }
            case COMPATIBILITY_INFORMATION: {
                const compatibility = context?.assemblies[0].manifest.compatibility
                    ?? { supportedOs: [], maxVersionTested: [] };
                const count = compatibility.supportedOs.length
                    + compatibility.maxVersionTested.length;
                const bytes = new Uint8Array(COMPATIBILITY_HEADER + COMPATIBILITY_ELEMENT * count);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, count, true);
                compatibility.supportedOs.forEach((guid, index)=>{
                    const at = COMPATIBILITY_HEADER + COMPATIBILITY_ELEMENT * index;
                    bytes.set(guidBytes(guid), at);
                    view.setUint32(at + 16, ACTCTX_COMPATIBILITY_ELEMENT_TYPE_OS, true);
                });
                compatibility.maxVersionTested.forEach((version, index)=>{
                    const at = COMPATIBILITY_HEADER
                        + COMPATIBILITY_ELEMENT * (compatibility.supportedOs.length + index);
                    view.setUint32(at + 16, ACTCTX_COMPATIBILITY_ELEMENT_TYPE_MAXVERSIONTESTED,
                        true);
                    const parts = `${version}.0.0.0`.split('.').slice(0, 4).map(Number);
                    view.setBigUint64(at + 24, parts.reduce((sum, part)=>(sum << 16n)
                        | BigInt(part & 0xffff), 0n), true);
                });
                return { bytes };
            }
            default:
                return { status: STATUS_INVALID_PARAMETER };
        }
    };

    /**
     * QueryActCtxW and RtlQueryInformationActivationContext's body.
     *
     * @param {number[]} args  flags, handle, subInstance, class, buffer, size, written
     * @returns {number} the status
     */
    const query = ([flags, handle, subInstance, kind, buffer, size, written])=>{
        const known = QUERY_ACTCTX_FLAG_USE_ACTIVE_ACTCTX | QUERY_ACTCTX_FLAG_ACTCTX_IS_HMODULE
            | QUERY_ACTCTX_FLAG_ACTCTX_IS_ADDRESS | QUERY_ACTCTX_FLAG_NO_ADDREF;
        const target = (flags & ~known) === 0 ? queried(flags >>> 0, handle >>> 0) : null;
        if (!target)
        {
            writeDwordIf(written, 0);
            return STATUS_INVALID_PARAMETER;
        }
        const result = answer(target.context, target.handle, kind >>> 0, subInstance >>> 0,
            buffer >>> 0);
        if ('status' in result)
        {
            return result.status;
        }
        if ((size >>> 0) < result.bytes.length || ((buffer >>> 0) === 0 && result.bytes.length > 0))
        {
            writeDwordIf(written, result.bytes.length);
            return STATUS_BUFFER_TOO_SMALL;
        }
        host.writeMemory(buffer >>> 0, result.bytes);
        writeDwordIf(written, result.written ?? result.bytes.length);
        if ((kind >>> 0) === BASIC_INFORMATION && (flags & QUERY_ACTCTX_FLAG_NO_ADDREF) === 0)
        {
            addRef(target.context && target.handle !== 0 ? target.context : null);
        }
        return STATUS_SUCCESS;
    };

    // ----------------------------------------------------------------- creating

    /**
     * @typedef {{ flags: number, source: string | null, directory: string | null,
     *     resource: number | null, module: number, application: string | null }} Request
     */

    /**
     * What CreateActCtx was asked, read from its ACTCTX, or the error it is
     * refused with before anything is looked for.
     *
     * @param {number} actctx @param {(address: number) => string} readText
     * @returns {Request | { error: number }}
     */
    const readRequest = (actctx, readText)=>{
        if ((actctx >>> 0) === 0)
        {
            return { error: ERROR_INVALID_PARAMETER };
        }
        const size = readDword(actctx + ACTCTX.cbSize);
        const flags = readDword(actctx + ACTCTX.dwFlags);
        if (size < ACTCTX.wProcessorArchitecture
            || FIELD_ENDS.some(([flag, end])=>(flags & flag) !== 0 && size < end))
        {
            return { error: ERROR_INVALID_PARAMETER };
        }
        const pointer = (/** @type {number} */ field)=>readDword(actctx + field);
        const source = pointer(ACTCTX.lpSource);
        const resource = (flags & ACTCTX_FLAG_RESOURCE_NAME_VALID) !== 0
            ? pointer(ACTCTX.lpResourceName) : 0;
        return {
            flags,
            source: source === 0 ? null : readText(source),
            directory: (flags & ACTCTX_FLAG_ASSEMBLY_DIRECTORY_VALID) !== 0
                && pointer(ACTCTX.lpAssemblyDirectory) !== 0
                ? readText(pointer(ACTCTX.lpAssemblyDirectory)) : null,
            // A resource is named by a number here: a manifest's always is.
            resource: resource === 0 ? null : resource >>> 16 === 0 ? resource
                : Number(readText(resource).replace(/^#/, '')) || null,
            module: (flags & ACTCTX_FLAG_HMODULE_VALID) !== 0 ? pointer(ACTCTX.hModule) : 0,
            application: (flags & ACTCTX_FLAG_APPLICATION_NAME_VALID) !== 0
                && pointer(ACTCTX.lpApplicationName) !== 0
                ? readText(pointer(ACTCTX.lpApplicationName)) : null,
        };
    };

    /**
     * CreateActCtx's body: the manifest found, the context built, its
     * handle or the error.
     *
     * @param {Request} request
     * @returns {Promise<{ context: Context } | { error: number }>}
     */
    const create = async request=>{
        /** @type {Uint8Array | null} */
        let bytes;
        /** @type {string | null} */
        let manifestPath = null;
        /** @type {string} */
        let appDirectory;
        const assemblyDirectory = request.directory === null ? null
            : `${host.fullPath(request.directory).replace(/\\+$/, '')}\\`;
        if (request.resource !== null && request.module !== 0)
        {
            bytes = host.moduleResource?.(request.module, RT_MANIFEST, request.resource) ?? null;
            if (bytes === null)
            {
                return { error: ERROR_RESOURCE_NAME_NOT_FOUND };
            }
            const path = host.modulePath?.(request.module) ?? host.imagePath();
            appDirectory = assemblyDirectory ?? directoryOf(path);
        }
        else
        {
            if (request.source === null || request.source === '')
            {
                return { error: ERROR_INVALID_PARAMETER };
            }
            const relative = !/^([A-Za-z]:|\\\\)/.test(request.source);
            const path = assemblyDirectory !== null && relative
                ? `${assemblyDirectory}${request.source}` : host.fullPath(request.source);
            const entry = host.stat(path);
            if (!entry?.exists || entry.isDirectory)
            {
                const parent = host.stat(directoryOf(path).replace(/\\$/, ''));
                return { error: parent?.exists ? ERROR_FILE_NOT_FOUND : ERROR_PATH_NOT_FOUND };
            }
            if (request.resource !== null)
            {
                bytes = await host.fileResource?.(path, RT_MANIFEST, request.resource) ?? null;
                if (bytes === null)
                {
                    return { error: ERROR_RESOURCE_NAME_NOT_FOUND };
                }
            }
            else
            {
                bytes = await host.readFile(path);
                manifestPath = path;
            }
            appDirectory = assemblyDirectory ?? directoryOf(path);
        }
        const read = parseManifest(/** @type {Uint8Array} */ (bytes));
        if ('refused' in read)
        {
            host.divergence?.('CreateActCtx', `the manifest is refused: ${read.refused}`);
            return { error: ERROR_SXS_CANT_GEN_ACTCTX };
        }
        const built = await build(read.manifest, { manifestPath, appDirectory });
        if (typeof built === 'string')
        {
            host.divergence?.('CreateActCtx', `no context: ${built}`);
            return { error: ERROR_SXS_CANT_GEN_ACTCTX };
        }
        if ((request.flags & ACTCTX_FLAG_SET_PROCESS_DEFAULT) !== 0)
        {
            if (processDefault !== null)
            {
                release(built);
                return { error: ERROR_SXS_PROCESS_DEFAULT_ALREADY_SET };
            }
            processDefault = built;
        }
        return { context: built };
    };

    /**
     * CreateActCtx in either width.
     *
     * @param {(address: number) => string} readText
     */
    const createActCtx = readText=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([actctx])=>{
            const request = readRequest(actctx >>> 0, readText);
            if ('error' in request)
            {
                return fail(request.error, INVALID_HANDLE_VALUE);
            }
            return create(request).then(made=>('error' in made
                ? fail(made.error, INVALID_HANDLE_VALUE) : made.context.handle));
        },
    });

    /** Modules' own contexts, by base: their RT_MANIFEST 2, read when they were loaded. */
    /** @type {Map<number, Context>} */
    const moduleContexts = new Map();

    const readAnsi = (/** @type {number} */ address)=>host.readCString(address, 0x10000);
    const readWide = (/** @type {number} */ address)=>host.readWideString(address, 0x20000);

    /** @param {number} address  a UNICODE_STRING */
    const readUnicodeString = address=>{
        if (address === 0)
        {
            return null;
        }
        const length = readDword(address) & 0xffff;
        const buffer = readDword(address + 4);
        const bytes = host.readMemory(buffer, length);
        return String.fromCharCode(...new Uint16Array(bytes.slice().buffer, 0, length >>> 1));
    };

    /**
     * A __fastcall entry: a trap cannot be bound fastcall, so the export is
     * a few instructions that put the register arguments (ECX, then EDX) on
     * the stack under the return address and go on to a stdcall trap of
     * them -- `pop eax; push edx; push ecx; push eax; jmp <trap>`.
     *
     * @param {string} name @param {number} registers  1 (ECX) or 2 (ECX, EDX)
     * @param {(args: number[]) => number} handler
     */
    const fastcall = (name, registers, handler)=>{
        let placed = 0;
        return {
            argBytes: 0,
            /** @param {{ register: (name: string, fn: any) => number }} builder */
            guest: builder=>{
                if (placed === 0)
                {
                    const trap = builder.register(`<${name}>`,
                        { argBytes: registers * 4, handler });
                    const pushes = registers === 2 ? [0x52, 0x51] : [0x51];
                    const length = 1 + pushes.length + 1 + 5;
                    placed = (host.allocateCode ?? host.allocate)(length);
                    const relative = (trap - (placed + length)) | 0;
                    host.writeMemory(placed, new Uint8Array([0x58, ...pushes, 0x50, 0xe9,
                        relative & 0xff, relative >>> 8 & 0xff, relative >>> 16 & 0xff,
                        relative >>> 24 & 0xff]));
                }
                return placed;
            },
        };
    };

    /** The ntdll calls these are the kernel32 ones' bodies of. */
    const natives = {
        /** NTSTATUS RtlActivateActivationContext(ULONG flags, HANDLE, ULONG_PTR *cookie) */
        RtlActivateActivationContext: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, handle, cookie])=>{
                const made = activate(handle >>> 0);
                if (made === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                writeDwordIf(cookie, made);
                return STATUS_SUCCESS;
            },
        },
        /** NTSTATUS RtlActivateActivationContextEx(ULONG, TEB *, HANDLE, ULONG_PTR *) */
        RtlActivateActivationContextEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, , handle, cookie])=>{
                const made = activate(handle >>> 0);
                if (made === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                writeDwordIf(cookie, made);
                return STATUS_SUCCESS;
            },
        },
        /** void RtlDeactivateActivationContext(ULONG flags, ULONG_PTR cookie) */
        RtlDeactivateActivationContext: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, cookie])=>{
                deactivate(cookie >>> 0);
                return 0;
            },
        },
        /**
         * RTL_ACTIVATION_CONTEXT_STACK_FRAME *FASTCALL
         * RtlActivateActivationContextUnsafeFast(RTL_CALLER_ALLOCATED_..._EXTENDED *, HANDLE)
         *
         * The caller's frame goes on the stack as it is: neither its Size
         * nor its Format is looked at, and it is not marked as allocated here.
         */
        RtlActivateActivationContextUnsafeFast: fastcall('RtlActivateActivationContextUnsafeFast',
            2, ([extended, handle])=>{
                const stack = stackOf(true);
                const frame = (extended >>> 0) + EXTENDED_FRAME_AT;
                writeDword(frame, stack === 0 ? 0 : readDword(stack));
                writeDword(frame + 4, handle);
                writeDword(frame + 8, 0);
                if (stack !== 0)
                {
                    writeDword(stack, frame);
                }
                addRef(contextOf(handle));
                return frame;
            }),
        /**
         * RTL_ACTIVATION_CONTEXT_STACK_FRAME *FASTCALL
         * RtlDeactivateActivationContextUnsafeFast(the caller's extended frame)
         */
        RtlDeactivateActivationContextUnsafeFast: fastcall(
            'RtlDeactivateActivationContextUnsafeFast', 1, ([extended])=>{
                const frame = (extended >>> 0) + EXTENDED_FRAME_AT;
                deactivate(frame);
                return frame;
            }),
        /** void RtlFreeThreadActivationContextStack(void): every frame of the thread's gone. */
        RtlFreeThreadActivationContextStack: {
            argBytes: 0,
            handler: ()=>{
                const stack = stackOf(false);
                let frame = stack === 0 ? 0 : readDword(stack);
                let bottom = 0;
                while (frame !== 0)
                {
                    bottom = frame;
                    frame = readDword(frame);
                }
                if (bottom !== 0)
                {
                    deactivate(bottom);
                }
                return 0;
            },
        },
        /**
         * NTSTATUS RtlFindActivationContextSectionString(ULONG flags, const GUID *,
         *     ULONG section, const UNICODE_STRING *, ACTCTX_SECTION_KEYED_DATA *)
         *
         * Unlike kernel32's, a null data block is allowed: the answer is
         * then only whether the key is there.
         */
        RtlFindActivationContextSectionString: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([flags, guid, id, key, data])=>findString(flags >>> 0, guid >>> 0, id >>> 0,
                readUnicodeString(key >>> 0), data >>> 0),
        },
        /** NTSTATUS RtlQueryInformationActiveActivationContext(ULONG, PVOID, SIZE_T, SIZE_T *) */
        RtlQueryInformationActiveActivationContext: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([kind, buffer, size, written])=>query([QUERY_ACTCTX_FLAG_USE_ACTIVE_ACTCTX, 0,
                0, kind, buffer, size, written]),
        },
        /** NTSTATUS RtlQueryInformationActivationContext(ULONG, HANDLE, PVOID, ULONG, PVOID, SIZE_T, SIZE_T *) */
        RtlQueryInformationActivationContext: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: args=>query(args),
        },
        /** void RtlAddRefActivationContext(HANDLE) */
        RtlAddRefActivationContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                addRef(contextOf(handle));
                return 0;
            },
        },
        /** void RtlReleaseActivationContext(HANDLE) */
        RtlReleaseActivationContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                release(contextOf(handle));
                return 0;
            },
        },
        /** NTSTATUS RtlGetActiveActivationContext(HANDLE *) */
        RtlGetActiveActivationContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                const active = activeContext();
                addRef(active);
                writeDwordIf(out, active?.handle ?? 0);
                return STATUS_SUCCESS;
            },
        },
        /** NTSTATUS RtlZombifyActivationContext(HANDLE) */
        RtlZombifyActivationContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(contextOf(handle) ? STATUS_SUCCESS : STATUS_INVALID_PARAMETER),
        },
    };

    const functions = {
        CreateActCtxA: { ...createActCtx(readAnsi), natives },
        CreateActCtxW: createActCtx(readWide),

        /**
         * BOOL ActivateActCtx(HANDLE hActCtx, ULONG_PTR *lpCookie)
         *
         * The context goes on top of the thread's stack; null, the process
         * default, goes there as itself.
         */
        ActivateActCtx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, cookie])=>{
                if ((cookie >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const made = activate(handle >>> 0);
                if (made === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(cookie, made);
                return 1;
            },
        },

        /**
         * BOOL DeactivateActCtx(DWORD dwFlags, ULONG_PTR ulCookie)
         *
         * The innermost frame comes off; one under others only with
         * DEACTIVATE_ACTCTX_FLAG_FORCE_EARLY_DEACTIVATION, the others with
         * it. Windows raises STATUS_SXS_EARLY_DEACTIVATION or
         * STATUS_SXS_INVALID_DEACTIVATION where this fails with the matching
         * error: a program that gets the cookie wrong goes on rather than
         * ending on an exception it has no handler for.
         */
        DeactivateActCtx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([flags, cookie])=>{
                const done = deactivate(cookie >>> 0, undefined,
                    ((flags >>> 0) & DEACTIVATE_ACTCTX_FLAG_FORCE_EARLY_DEACTIVATION) !== 0);
                return done === 'done' ? 1 : fail(done === 'early'
                    ? ERROR_SXS_EARLY_DEACTIVATION : ERROR_SXS_INVALID_DEACTIVATION);
            },
        },

        /** BOOL GetCurrentActCtx(HANDLE *lphActCtx): the top of the stack, referenced. */
        GetCurrentActCtx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const active = activeContext();
                addRef(active);
                writeDword(out, active?.handle ?? 0);
                return 1;
            },
        },

        /** void AddRefActCtx(HANDLE) */
        AddRefActCtx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                addRef(contextOf(handle));
                return 0;
            },
        },
        /** void ReleaseActCtx(HANDLE): the last reference frees the context. */
        ReleaseActCtx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                release(contextOf(handle));
                return 0;
            },
        },

        /**
         * BOOL ZombifyActCtx(HANDLE hActCtx)
         *
         * A context of the process keeps answering after it, as Windows'
         * does; null is no context to zombify.
         */
        ZombifyActCtx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(contextOf(handle) ? 1 : fail(ERROR_INVALID_PARAMETER)),
        },

        /**
         * BOOL FindActCtxSectionStringA/W(DWORD dwFlags, const GUID *, ULONG ulSectionId,
         *     LPCTSTR lpStringToFind, PACTCTX_SECTION_KEYED_DATA ReturnedData)
         *
         * The key in the active context, then in the process default.
         */
        FindActCtxSectionStringA: findSectionString(address=>host.decodeAnsi(
            host.encodeAnsi(readAnsi(address)))),
        FindActCtxSectionStringW: findSectionString(readWide),

        /**
         * BOOL FindActCtxSectionGuid(DWORD, const GUID *, ULONG, const GUID *,
         *     PACTCTX_SECTION_KEYED_DATA)
         *
         * No GUID section is kept -- COM classes, interfaces, type libraries
         * -- so a key there is not found.
         */
        FindActCtxSectionGuid: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, , , key, data])=>((key >>> 0) === 0 || (data >>> 0) === 0
                ? fail(ERROR_INVALID_PARAMETER) : fail(ERROR_SXS_SECTION_NOT_FOUND)),
        },

        /**
         * BOOL QueryActCtxW(DWORD dwFlags, HANDLE hActCtx, PVOID pvSubInstance,
         *     ULONG ulInfoClass, PVOID pvBuffer, SIZE_T cbBuffer, SIZE_T *pcbWrittenOrRequired)
         */
        QueryActCtxW: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: args=>{
                const status = query(args);
                return status === STATUS_SUCCESS ? 1 : fail(errorOf(status));
            },
        },
    };

    /**
     * What the loader asks of the contexts: the process default from the
     * program's manifest, a module's own from its, and where a DLL a
     * context redirects is.
     */
    const loaderApi = {
        /**
         * Builds the process default context from the program's manifest --
         * resource 1 of its image, else `<program>.manifest` beside it. A
         * program without one has none; one that names an assembly that
         * cannot be found is the error Windows ends the start with.
         *
         * @param {Uint8Array | null} resource  the image's RT_MANIFEST 1
         * @param {string} imagePath
         * @returns {Promise<string | null>} why there is no context, or null
         */
        async processDefaultFrom(resource, imagePath){
            /** @type {Uint8Array | null} */
            let bytes = resource;
            /** @type {string | null} */
            let manifestPath = null;
            if (bytes === null)
            {
                const external = `${imagePath}.manifest`;
                const entry = host.stat(external);
                if (!entry?.exists || entry.isDirectory)
                {
                    return null;
                }
                bytes = await host.readFile(external);
                manifestPath = external;
            }
            if (bytes === null)
            {
                return null;
            }
            const read = parseManifest(bytes);
            if ('refused' in read)
            {
                return `the program's manifest is refused: ${read.refused}`;
            }
            const built = await build(read.manifest,
                { manifestPath: manifestPath ?? imagePath, appDirectory: directoryOf(imagePath) });
            if (typeof built === 'string')
            {
                return built;
            }
            processDefault = built;
            return null;
        },

        /**
         * A library's own context, from its RT_MANIFEST 2: its handle, null
         * for a library without one, or why a library with one can have none.
         *
         * @param {Uint8Array | null} resource @param {string} path
         * @returns {Promise<{ handle: number } | { refused: string } | null>}
         */
        async moduleContextFrom(resource, path){
            if (resource === null)
            {
                return null;
            }
            const read = parseManifest(resource);
            if ('refused' in read)
            {
                return { refused: `${path}'s manifest is refused: ${read.refused}` };
            }
            const built = await build(read.manifest,
                { manifestPath: path, appDirectory: directoryOf(host.imagePath()) });
            return typeof built === 'string' ? { refused: built } : { handle: built.handle };
        },

        /**
         * Records a loaded library's own context, by its base, for QueryActCtx
         * and for the loads its imports make.
         *
         * @param {number} base @param {number} handle
         */
        bindModule(base, handle){
            const context = contextOf(handle);
            if (context)
            {
                moduleContexts.set(base, context);
            }
        },

        /** @param {number} base  the context a library brought, 0 for none */
        moduleContext: base=>moduleContexts.get(base)?.handle ?? 0,

        /**
         * Where the context a load runs under puts a DLL: `own`, the context
         * of the library whose import this is, first, then the thread's
         * active one and the process default. Null when no context
         * redirects the name. `path` is where the module is, as it and the
         * program see it; `source` is the file its bytes are in -- the path
         * itself, the bottle's copy of a store DLL kept elsewhere, or null
         * when the engine's own table answers it.
         *
         * @param {string} name  a bare library name
         * @param {number} [own]
         * @returns {{ path: string, source: string | null, context: number } | null}
         */
        redirect(name, own = 0){
            const key = name.toUpperCase();
            for (const context of [contextOf(own), activeContext(), processDefault])
            {
                if (!context)
                {
                    continue;
                }
                for (const assembly of context.assemblies)
                {
                    const file = assembly.manifest.files
                        .find(entry=>entry.name.toUpperCase() === key);
                    if (file)
                    {
                        const path = `${assembly.directory ?? context.appDirectory}${file.name}`;
                        const entry = host.stat(path);
                        const source = entry?.exists && !entry.isDirectory ? path
                            : host.answers?.(file.name) ? null : bottleCopyOf(file.name);
                        return { path, source, context: context.handle };
                    }
                }
            }
            return null;
        },

        /**
         * Puts a context on a thread's stack for a DllMain, the way the
         * loader runs one under the context it was found through; the cookie,
         * or 0 for none.
         *
         * @param {number} handle @param {number} teb
         */
        activate: (handle, teb)=>(handle === 0 || !contextOf(handle) ? 0 : activate(handle, teb)),
        /** @param {number} cookie @param {number} teb */
        deactivate: (cookie, teb)=>cookie !== 0 && deactivate(cookie, teb) === 'done',
        /** Whether there is a process default, for a report. */
        hasProcessDefault: ()=>processDefault !== null,
    };

    return { functions, loaderApi };
}

/** @param {string} text  a GUID in braces */
function guidBytes(text){
    const hex = text.replace(/[{}-]/g, '');
    const bytes = new Uint8Array(16);
    if (hex.length !== 32)
    {
        return bytes;
    }
    const view = new DataView(bytes.buffer);
    view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
    view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
    view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
    for (let at = 0; at < 8; at++)
    {
        bytes[8 + at] = parseInt(hex.slice(16 + at * 2, 18 + at * 2), 16);
    }
    return bytes;
}

export { ISOLATIONAWARE_MANIFEST_RESOURCE_ID, CREATEPROCESS_MANIFEST_RESOURCE_ID, RT_MANIFEST };
