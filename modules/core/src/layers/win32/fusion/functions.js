/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * fusion.dll, the .NET runtime's assembly cache API: assembly names
 * (CreateAssemblyNameObject, `names.js`), the global assembly cache a setup
 * installs into and a program asks about (CreateAssemblyCache: InstallAssembly,
 * QueryAssemblyInfo, UninstallAssembly), its enumeration (CreateAssemblyEnum)
 * and where it lies (GetCachePath). The cache is folders on the volume
 * (`cache.js`); an assembly installed is read as the runtime reads it
 * (`mscoree/metadata.js`).
 *
 * The contract is Wine's fusion tests (asmname.c, asmcache.c, asmenum.c,
 * fusion.c), which say what Windows answers. The engine has no download
 * cache, no native images and no install references: what asks for those is
 * answered as an empty cache or refused, and said.
 */

import { createComObject } from '../ole32/objects.js';
import { readClrImage, COMIMAGE_FLAGS_ILONLY, COMIMAGE_FLAGS_32BITREQUIRED,
    COMIMAGE_FLAGS_32BITPREFERRED } from '../mscoree/metadata.js';
import { CANOF_PARSE_DISPLAY_NAME, E_INVALIDARG, E_NOTIMPL, E_NOT_SUFFICIENT_BUFFER,
    IID_IASSEMBLY_NAME, S_FALSE, S_OK, createAssemblyName, emptyFields, methods,
    parseDisplayName, tokenOf } from './names.js';
import { createCache } from './cache.js';

const E_FAIL = 0x80004005 | 0;
const ERROR_FILE_NOT_FOUND = 0x80070002 | 0;
const ERROR_INVALID_NAME = 0x8007007b | 0;
const ERROR_NO_MORE_ITEMS = 0x80070103 | 0;
/** The file is not an assembly: no CLI header, or no Assembly row. */
const COR_E_ASSEMBLYEXPECTED = 0x80131018 | 0;
/** A module the manifest lists is not beside it. */
const FUSION_E_ASM_MODULE_MISSING = 0x80131042 | 0;
/** The cache holds only strongly named assemblies, and is asked by such names. */
const FUSION_E_PRIVATE_ASM_DISALLOWED = 0x80131044 | 0;

const IID = Object.freeze({
    ASSEMBLY_CACHE: '{E707DCDE-D1CD-11D2-BAB9-00C04F8ECEAE}',
    ASSEMBLY_CACHE_ITEM: '{9E3AAEB4-D1CD-11D2-BAB9-00C04F8ECEAE}',
    ASSEMBLY_ENUM: '{21B8916C-F28E-11D2-A473-00C04F8EF448}',
    INSTALL_REFERENCE_ENUM: '{56B1A988-7C0C-4AA2-8639-C3EB5A90226F}',
});

/** ASM_CACHE_FLAGS. */
export const ASM_CACHE = Object.freeze({ ZAP: 0x1, GAC: 0x2, DOWNLOAD: 0x4, ROOT: 0x8,
    ROOT_EX: 0x80 });

const QUERYASMINFO_FLAG_GETSIZE = 0x2;
const ASSEMBLYINFO_FLAG_INSTALLED = 0x1;
const IASSEMBLYCACHE_INSTALL_FLAG_FORCE_REFRESH = 0x2;
const DISPOSITION_UNINSTALLED = 1;
const DISPOSITION_ALREADY_UNINSTALLED = 3;

/** The runtime whose native image cache GetCachePath names. */
const NATIVE_IMAGES_RUNTIME = 'v4.0.30319';

const CACHE_SLOTS = /** @type {[string, number][]} */ ([['UninstallAssembly', 4],
    ['QueryAssemblyInfo', 3], ['CreateAssemblyCacheItem', 4], ['CreateAssemblyScavenger', 1],
    ['InstallAssembly', 3]]);
const CACHE_ITEM_SLOTS = /** @type {[string, number][]} */ ([['CreateStream', 6],
    ['Commit', 2], ['AbortItem', 0]]);
const ENUM_SLOTS = /** @type {[string, number][]} */ ([['GetNextAssembly', 3], ['Reset', 0],
    ['Clone', 1]]);
const REFERENCE_ENUM_SLOTS = /** @type {[string, number][]} */ ([
    ['GetNextInstallReferenceItem', 3]]);

/**
 * @typedef {Object} FusionHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {4 | 8} pointerSize
 * @property {() => string} windowsDirectory  GetWindowsDirectory's answer
 * @property {import('../kernel32/files.js').FileSystem} files
 * @property {(object: any, iid: string) => number} publish  an interface pointer
 * @property {(pointer: number) => any} objectAt  the object behind one this engine made
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/**
 * The cache folder an image belongs in, by the processor it runs on: IL
 * that any process runs is MSIL, IL bound to 32 bits and x86 code GAC_32,
 * 64-bit code GAC_64; the first runtimes knew one folder.
 *
 * @param {import('../mscoree/metadata.js').ClrImage} image
 */
function kindOf(image){
    if (/^v1\./.test(image.version))
    {
        return 'GAC';
    }
    if (image.machine === 0x8664 || image.machine === 0x200)
    {
        return 'GAC_64';
    }
    if (image.machine === 0xaa64)
    {
        return 'GAC_Arm64';
    }
    const anyProcess = (image.flags & COMIMAGE_FLAGS_ILONLY) !== 0
        && ((image.flags & COMIMAGE_FLAGS_32BITREQUIRED) === 0
            || (image.flags & COMIMAGE_FLAGS_32BITPREFERRED) !== 0);
    return anyProcess ? 'GAC_MSIL' : 'GAC_32';
}

/**
 * @param {FusionHost} host
 */
export function createFusionFunctions(host){
    const files = host.files;
    const windows = ()=>host.windowsDirectory().replace(/\\$/, '');
    const cache = ()=>createCache(files, windows());
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));
    /** @param {number} at */
    const readU32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} at @param {number} value  a pointer-sized value */
    const writePointer = (at, value)=>(host.pointerSize === 8
        ? host.writeMemory(at >>> 0, new Uint8Array(new BigUint64Array([BigInt(value >>> 0)])
            .buffer))
        : writeU32(at, value));
    /**
     * A pointer the program wrote: its low half, as guest memory lies below
     * 4 GiB in every process this engine runs.
     *
     * @param {number} at
     */
    const readPointer = at=>readU32(at);
    /** @param {number} at @param {string} text */
    const writeWide = (at, text)=>host.writeMemory(at >>> 0,
        new Uint8Array(Uint16Array.from(`${text}\0`, unit=>unit.charCodeAt(0)).buffer));
    /** @param {number} at */
    const wideAt = at=>((at >>> 0) === 0 ? null : host.readWideString(at >>> 0, 32768 * 2));
    /** @param {import('./names.js').AssemblyFields} fields */
    const publishName = fields=>host.publish(createAssemblyName(host, fields),
        IID_IASSEMBLY_NAME);
    /** @param {string} path  A path as a program gives it, made whole. */
    const fullPath = path=>(/^[a-z]:\\/i.test(path) || path.startsWith('\\\\') ? path
        : `${files.currentDirectory().replace(/\\$/, '')}\\${path}`);

    /** @param {string} path */
    const readWhole = async path=>{
        const found = files.stat(path);
        const node = found && !found.isDirectory ? files.open(path, { read: true }) : null;
        if (!found || !node)
        {
            return null;
        }
        try
        {
            return await files.read(node, 0, found.size);
        }
        finally
        {
            files.close(node);
        }
    };
    /** @param {string} path @param {Uint8Array} bytes */
    const writeWhole = (path, bytes)=>{
        const node = files.open(path, { write: true, create: true, truncate: true });
        if (!node)
        {
            return false;
        }
        try
        {
            return files.write(node, 0, bytes) === bytes.length;
        }
        finally
        {
            files.close(node);
        }
    };

    /**
     * ASSEMBLY_INFO's fields: cbAssemblyInfo, dwAssemblyFlags,
     * uliAssemblySizeInKB, pszCurrentAssemblyPathBuf, cchBuf.
     */
    const infoLayout = host.pointerSize === 8
        ? { size: 32, flags: 4, kb: 8, path: 16, count: 24 }
        : { size: 24, flags: 4, kb: 8, path: 16, count: 20 };

    /**
     * IAssemblyCache::QueryAssemblyInfo: whether an assembly the name names
     * is in the cache, and its manifest's path; its size too for GETSIZE.
     * Nothing in the structure changes for one not found or a structure of a
     * size that is not this one's.
     *
     * @param {number} flags @param {number} nameAt @param {number} info
     */
    const queryAssemblyInfo = (flags, nameAt, info)=>{
        const text = wideAt(nameAt);
        if (!text)
        {
            return E_INVALIDARG;
        }
        const query = parseDisplayName(text);
        if (typeof query === 'number')
        {
            return query;
        }
        if (query.nullToken)
        {
            return FUSION_E_PRIVATE_ASM_DISALLOWED;
        }
        const declared = (info >>> 0) === 0 ? 0 : readU32(info);
        if (declared !== 0 && declared !== infoLayout.size)
        {
            return E_INVALIDARG;
        }
        const gac = cache();
        const [found] = gac.find(query);
        if (!found)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        if ((info >>> 0) === 0)
        {
            return S_OK;
        }
        writeU32(info, infoLayout.size);
        writeU32(info + infoLayout.flags, ASSEMBLYINFO_FLAG_INSTALLED);
        writeU32(info + infoLayout.kb, (flags & QUERYASMINFO_FLAG_GETSIZE) !== 0
            ? gac.sizeInKb(found) : 0);
        writeU32(info + infoLayout.kb + 4, 0);
        const buffer = readPointer(info + infoLayout.path);
        const room = readU32(info + infoLayout.count);
        writeU32(info + infoLayout.count, found.file.length + 1);
        if (buffer === 0 || room < found.file.length + 1)
        {
            return E_NOT_SUFFICIENT_BUFFER;
        }
        writeWide(buffer, found.file);
        return S_OK;
    };

    /**
     * IAssemblyCache::InstallAssembly: a strongly named assembly's manifest,
     * and the modules it lists beside it, copied into the cache folder its
     * name and processor give it. One already there stays as it is unless
     * FORCE_REFRESH asks for it again.
     *
     * @param {number} flags @param {number} pathAt @param {number} reference
     */
    const installAssembly = async(flags, pathAt, reference)=>{
        const given = wideAt(pathAt);
        if (!given)
        {
            return E_INVALIDARG;
        }
        const extension = /\.(dll|exe)$/i.exec(given)?.[1];
        if (!extension)
        {
            return ERROR_INVALID_NAME;
        }
        const path = fullPath(given);
        const bytes = await readWhole(path);
        if (!bytes)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        const image = readClrImage(bytes);
        const identity = image?.assembly;
        if (!image || !identity)
        {
            return COR_E_ASSEMBLYEXPECTED;
        }
        if (identity.publicKey.length === 0)
        {
            return FUSION_E_PRIVATE_ASM_DISALLOWED;
        }
        if ((reference >>> 0) !== 0)
        {
            host.divergence?.('IAssemblyCache::InstallAssembly',
                'the install reference is not kept: the assembly is installed without it');
        }
        const fields = { ...emptyFields(), name: identity.name, version: [...identity.version],
            culture: identity.culture, token: tokenOf(identity.publicKey) };
        const gac = cache();
        const folder = gac.folderFor(fields, { runtime: image.version, kind: kindOf(image) });
        const manifest = `${folder}\\${identity.name}.${extension.toLowerCase()}`;
        if (files.stat(manifest) && (flags & IASSEMBLYCACHE_INSTALL_FLAG_FORCE_REFRESH) === 0)
        {
            return S_OK;
        }
        const beside = path.slice(0, path.lastIndexOf('\\'));
        /** @type {[string, Uint8Array][]} */
        const modules = [];
        for (const module of image.files)
        {
            const content = await readWhole(`${beside}\\${module}`);
            if (!content)
            {
                return FUSION_E_ASM_MODULE_MISSING;
            }
            modules.push([module, content]);
        }
        if (!gac.makeFolders(folder))
        {
            host.divergence?.('IAssemblyCache::InstallAssembly',
                `the cache folder ${folder} could not be made`, 'loss');
            return E_FAIL;
        }
        /** @type {[string, Uint8Array][]} */
        const writes = [[manifest, bytes],
            ...modules.map(([module, content])=>/** @type {[string, Uint8Array]} */ (
                [`${folder}\\${module}`, content]))];
        for (const [where, content] of writes)
        {
            if (!writeWhole(where, content))
            {
                host.divergence?.('IAssemblyCache::InstallAssembly',
                    `${where} could not be written into the cache`, 'loss');
                return E_FAIL;
            }
        }
        return S_OK;
    };

    /**
     * IAssemblyCache::UninstallAssembly: every cached assembly the name
     * allows taken out, S_FALSE when there is none.
     *
     * @param {number} nameAt @param {number} reference @param {number} dispositionAt
     */
    const uninstallAssembly = (nameAt, reference, dispositionAt)=>{
        const text = wideAt(nameAt);
        if (!text)
        {
            return E_INVALIDARG;
        }
        const query = parseDisplayName(text);
        if (typeof query === 'number')
        {
            return query;
        }
        if ((reference >>> 0) !== 0)
        {
            host.divergence?.('IAssemblyCache::UninstallAssembly',
                'install references are not kept: the assembly is uninstalled whatever holds it');
        }
        const gac = cache();
        const found = gac.find(query);
        found.forEach(gac.remove);
        if ((dispositionAt >>> 0) !== 0)
        {
            writeU32(dispositionAt, found.length > 0 ? DISPOSITION_UNINSTALLED
                : DISPOSITION_ALREADY_UNINSTALLED);
        }
        return found.length > 0 ? S_OK : S_FALSE;
    };

    /**
     * An IAssemblyCacheItem: the cache's way to install from streams rather
     * than files, which no program this engine has met uses. It is made, as
     * Windows makes it; writing into it is refused, and said.
     */
    const cacheItem = ()=>{
        /** @param {string} method */
        const refused = method=>()=>{
            host.divergence?.(`IAssemblyCacheItem::${method}`,
                'installing an assembly from streams is not provided');
            return E_NOTIMPL;
        };
        return createComObject(IID.ASSEMBLY_CACHE_ITEM, { interfaces: [
            { id: IID.ASSEMBLY_CACHE_ITEM, methods: methods(CACHE_ITEM_SLOTS, {
                CreateStream: refused('CreateStream'),
                Commit: refused('Commit'),
                AbortItem: ()=>S_OK,
            }) },
        ] });
    };

    const assemblyCache = ()=>createComObject(IID.ASSEMBLY_CACHE, { interfaces: [
        { id: IID.ASSEMBLY_CACHE, methods: methods(CACHE_SLOTS, {
            UninstallAssembly: (/** @type {number[]} */ [, name, reference, disposition])=>
                uninstallAssembly(name, reference, disposition),
            QueryAssemblyInfo: (/** @type {number[]} */ [flags, name, info])=>
                queryAssemblyInfo(flags >>> 0, name, info),
            CreateAssemblyCacheItem: (/** @type {number[]} */ [, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writePointer(out, host.publish(cacheItem(), IID.ASSEMBLY_CACHE_ITEM));
                return S_OK;
            },
            CreateAssemblyScavenger: ()=>{
                host.divergence?.('IAssemblyCache::CreateAssemblyScavenger',
                    'the cache has no scavenger: nothing is downloaded into it');
                return E_NOTIMPL;
            },
            InstallAssembly: (/** @type {number[]} */ [flags, path, reference])=>
                installAssembly(flags >>> 0, path, reference),
        }) },
    ] });

    /**
     * An IAssemblyEnum over the cached assemblies found when it was made,
     * each handed out as a new IAssemblyName.
     *
     * @param {import('./cache.js').CachedAssembly[]} items @param {number} [start]
     */
    const assemblyEnum = (items, start = 0)=>{
        let next = start;
        return createComObject(IID.ASSEMBLY_ENUM, { interfaces: [
            { id: IID.ASSEMBLY_ENUM, methods: methods(ENUM_SLOTS, {
                GetNextAssembly: (/** @type {number[]} */ [, out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    if (next >= items.length)
                    {
                        return S_FALSE;
                    }
                    const { fields } = items[next++];
                    writePointer(out, publishName({ ...fields, version: [...fields.version],
                        others: new Map() }));
                    return S_OK;
                },
                Reset: ()=>{
                    next = 0;
                    return S_OK;
                },
                Clone: (/** @type {number[]} */ [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    writePointer(out, host.publish(assemblyEnum(items, next), IID.ASSEMBLY_ENUM));
                    return S_OK;
                },
            }) },
        ] });
    };

    /**
     * The fields of a name object a program hands in, which must be one of
     * this library's: null when the pointer is null, undefined when it is
     * someone else's.
     *
     * @param {number} pointer @param {string} api
     */
    const fieldsAt = (pointer, api)=>{
        if ((pointer >>> 0) === 0)
        {
            return null;
        }
        const fields = host.objectAt(pointer >>> 0)?.state?.fields;
        if (!fields)
        {
            host.divergence?.(api, 'an assembly name this library did not make is not read');
        }
        return fields;
    };

    /** The path GetCachePath names for one kind of cache, or a refusal. */
    const cachePath = (/** @type {number} */ flags)=>{
        const { roots } = cache();
        switch (flags)
        {
            case ASM_CACHE.ZAP:
                return `${roots.legacy}\\NativeImages_${NATIVE_IMAGES_RUNTIME}_`
                    + `${host.pointerSize === 8 ? 64 : 32}`;
            case ASM_CACHE.GAC:
                return `${roots.legacy}\\GAC`;
            case ASM_CACHE.ROOT:
                return roots.legacy;
            case ASM_CACHE.ROOT_EX:
                return roots.v4;
            case ASM_CACHE.DOWNLOAD:
                host.divergence?.('GetCachePath', 'there is no download cache');
                return E_NOTIMPL;
            default:
                return E_INVALIDARG;
        }
    };

    return {
        /**
         * HRESULT CreateAssemblyNameObject(LPASSEMBLYNAME *ppAssemblyNameObj,
         *   LPCWSTR szAssemblyName, DWORD dwFlags, LPVOID pvReserved)
         *
         * With CANOF_PARSE_DISPLAY_NAME the text is a display name, read
         * whole or refused with nothing written; without it, it is the simple
         * name alone, which may be empty or absent.
         */
        CreateAssemblyNameObject: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [out, nameAt, flags])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const text = wideAt(nameAt);
                let fields = emptyFields();
                if ((flags & CANOF_PARSE_DISPLAY_NAME) !== 0)
                {
                    if (!text)
                    {
                        return E_INVALIDARG;
                    }
                    const parsed = parseDisplayName(text);
                    if (typeof parsed === 'number')
                    {
                        return parsed;
                    }
                    fields = parsed;
                }
                else if (text !== null)
                {
                    fields.name = text;
                }
                writePointer(out, publishName(fields));
                return S_OK;
            },
        },

        /** HRESULT CreateAssemblyCache(IAssemblyCache **ppAsmCache, DWORD dwReserved) */
        CreateAssemblyCache: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                // The cache's root is there once a cache has been asked for.
                const gac = cache();
                gac.makeFolders(gac.roots.legacy);
                writePointer(out, host.publish(assemblyCache(), IID.ASSEMBLY_CACHE));
                return S_OK;
            },
        },

        /**
         * HRESULT CreateAssemblyEnum(IAssemblyEnum **pEnum, IUnknown *pUnkReserved,
         *   IAssemblyName *pName, DWORD dwFlags, LPVOID pvReserved)
         *
         * The global cache, all of it or what a name allows; the native image
         * and download caches are empty here, as the engine makes neither.
         */
        CreateAssemblyEnum: {
            argBytes: 20,
            handler: (/** @type {number[]} */ [out, , nameAt, flags])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const kind = flags >>> 0;
                if (kind !== ASM_CACHE.GAC && kind !== ASM_CACHE.ZAP
                    && kind !== ASM_CACHE.DOWNLOAD)
                {
                    return E_INVALIDARG;
                }
                const query = fieldsAt(nameAt, 'CreateAssemblyEnum');
                if (query === undefined)
                {
                    return E_INVALIDARG;
                }
                const items = kind === ASM_CACHE.GAC ? cache().find(query) : [];
                writePointer(out, host.publish(assemblyEnum(items), IID.ASSEMBLY_ENUM));
                return S_OK;
            },
        },

        /**
         * HRESULT CreateInstallReferenceEnum(IInstallReferenceEnum **ppRefEnum,
         *   IAssemblyName *pName, DWORD dwFlags, LPVOID pvReserved)
         *
         * The references that hold an assembly in the cache: none, as the
         * cache here keeps none.
         */
        CreateInstallReferenceEnum: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [out, nameAt])=>{
                if ((out >>> 0) === 0 || (nameAt >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const references = createComObject(IID.INSTALL_REFERENCE_ENUM, { interfaces: [
                    { id: IID.INSTALL_REFERENCE_ENUM, methods: methods(REFERENCE_ENUM_SLOTS, {
                        GetNextInstallReferenceItem: ()=>ERROR_NO_MORE_ITEMS,
                    }) },
                ] });
                writePointer(out, host.publish(references, IID.INSTALL_REFERENCE_ENUM));
                return S_OK;
            },
        },

        /**
         * HRESULT GetCachePath(ASM_CACHE_FLAGS dwCacheFlags, LPWSTR pwzCachePath,
         *   PDWORD pcchPath)
         *
         * One kind of cache at a time; the length with its terminator told
         * back, and nothing written to a buffer too small for it.
         */
        GetCachePath: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [flags, buffer, sizeAt])=>{
                if ((sizeAt >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const path = cachePath(flags >>> 0);
                if (typeof path === 'number')
                {
                    return path;
                }
                const room = readU32(sizeAt);
                writeU32(sizeAt, path.length + 1);
                if ((buffer >>> 0) === 0 || room < path.length + 1)
                {
                    return E_NOT_SUFFICIENT_BUFFER;
                }
                writeWide(buffer, path);
                return S_OK;
            },
        },

        /** HRESULT ClearDownloadCache(void): there is no download cache to clear. */
        ClearDownloadCache: { argBytes: 0, handler: ()=>S_OK },

        /** HRESULT InitializeFusion(void) */
        InitializeFusion: { argBytes: 0, handler: ()=>S_OK },

        /** HRESULT CopyPDBs(void *unknown) */
        CopyPDBs: {
            argBytes: 4,
            handler: ()=>{
                host.divergence?.('CopyPDBs', 'symbol files are not copied into the cache');
                return E_NOTIMPL;
            },
        },

        /** HRESULT CreateApplicationContext(IAssemblyName *pName, LPVOID *ppCtx) */
        CreateApplicationContext: {
            argBytes: 8,
            handler: ()=>{
                host.divergence?.('CreateApplicationContext',
                    'binding contexts are the runtime\'s own and are not provided');
                return E_NOTIMPL;
            },
        },
    };
}
