/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mscoree's hosting interface: the legacy shim's entry points (GetCORVersion,
 * GetRequestedRuntimeInfo, LoadLibraryShim and kin) and the .NET 4 one
 * (CLRCreateInstance: ICLRMetaHost, ICLRRuntimeInfo), over the runtimes a bottle
 * with Mono has (`versions.js`).
 *
 * A runtime's own interfaces -- ICorRuntimeHost, ICLRRuntimeHost -- are made
 * by whoever starts Mono (`functions.js`, `runtimeInterface`); everything up to
 * them is answered here without starting it, as the shim answers without
 * loading a runtime on Windows. The contract is Wine's conformance tests of
 * mscoree (mscoree.c, metahost.c), which say what Windows answers.
 */

import { createComObject } from '../ole32/objects.js';
import { readGuid } from '../ole32/guid.js';
import { LATEST_LEGACY, RUNTIME_VERSIONS, exactRuntime, requestedRuntime } from './versions.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
const E_HANDLE = 0x80070006 | 0;
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111 | 0;
/** No runtime answers the request. */
export const CLR_E_SHIM_RUNTIME = 0x80131700 | 0;
/** The runtime does not export the function asked for. */
const CLR_E_SHIM_RUNTIMEEXPORT = 0x80131701 | 0;
const HOST_E_INVALIDOPERATION = 0x80131022 | 0;
const COR_E_NULLREFERENCE = E_POINTER;
const COR_E_FILENOTFOUND = 0x80070002 | 0;
/** A file that is not a managed assembly, asked for its runtime version. */
const COR_E_BADIMAGEFORMAT = 0x8007000b | 0;

export const CLSID = Object.freeze({
    CLR_META_HOST: '{9280188D-0E8E-4867-B30C-7FA83884E8DE}',
    COR_RUNTIME_HOST: '{CB2F6723-AB3A-11D2-9C40-00C04FA30A3E}',
    CLR_RUNTIME_HOST: '{90F1A06E-7712-4762-86B5-7A5EBA6BDB02}',
});
export const IID = Object.freeze({
    CLR_META_HOST: '{D332DB9E-B9B3-4125-8207-A14884F53216}',
    CLR_RUNTIME_INFO: '{BD39D1D2-BA2F-486A-89B0-B4B0CB466891}',
    ENUM_UNKNOWN: '{00000100-0000-0000-C000-000000000046}',
    SEQUENTIAL_STREAM: '{0C733A30-2A1C-11CE-ADE5-00AA0044773D}',
    STREAM: '{0000000C-0000-0000-C000-000000000046}',
    COR_RUNTIME_HOST: '{CB2F6722-AB3A-11D2-9C40-00C04FA30A3E}',
    CLR_RUNTIME_HOST: '{90F1A06C-7712-4762-86B5-7A5EBA6BDB02}',
});

/**
 * @typedef {Object} HostingHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {() => string} windowsDirectory  GetWindowsDirectory's answer
 * @property {() => boolean} installed  whether the bottle has the runtime
 * @property {(path: string) => boolean} exists
 * @property {(path: string) => Promise<Uint8Array | null>} readFile
 * @property {(path: string) => Promise<number>} loadLibrary  a module, or 0
 * @property {(object: any, iid: string) => number} publish  an interface pointer
 * @property {(code: number) => Promise<any> | any} exitProcess
 * @property {(version: string, clsid: string, iid: string)
 *     => Promise<{ pointer: number } | { failed: number }>} runtimeInterface
 *     The runtime's own interface, the runtime started for it if it is not yet.
 * @property {(callback: number, info: number) => Promise<any>} [notifyLoaded]
 *     Calls a RuntimeLoadedCallbackFnPtr for a runtime just loaded.
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/** @param {[string, number][]} slots @param {Record<string, Function>} handlers */
const methods = (slots, handlers)=>slots.map(([name, words])=>({
    name, argBytes: 4 + words * 4,
    invoke: (/** @type {any} */ _self, /** @type {number[]} */ args)=>
        (handlers[name] ? handlers[name](args) : E_NOTIMPL),
}));

const META_HOST_SLOTS = /** @type {[string, number][]} */ ([['GetRuntime', 3],
    ['GetVersionFromFile', 3], ['EnumerateInstalledRuntimes', 1],
    ['EnumerateLoadedRuntimes', 2], ['RequestRuntimeLoadedNotification', 1],
    ['QueryLegacyV2RuntimeBinding', 2], ['ExitProcess', 1]]);
const RUNTIME_INFO_SLOTS = /** @type {[string, number][]} */ ([['GetVersionString', 2],
    ['GetRuntimeDirectory', 2], ['IsLoaded', 2], ['LoadErrorString', 4], ['LoadLibrary', 2],
    ['GetProcAddress', 2], ['GetInterface', 3], ['IsLoadable', 1],
    ['SetDefaultStartupFlags', 2], ['GetDefaultStartupFlags', 3], ['BindAsLegacyV2Runtime', 0],
    ['IsStarted', 2]]);
const ENUM_SLOTS = /** @type {[string, number][]} */ ([['Next', 3], ['Skip', 1], ['Reset', 0],
    ['Clone', 1]]);
const STREAM_SLOTS = /** @type {[string, number][]} */ ([['Read', 3], ['Write', 3],
    ['Seek', 4], ['SetSize', 2], ['CopyTo', 5], ['Commit', 1], ['Revert', 0],
    ['LockRegion', 5], ['UnlockRegion', 5], ['Stat', 2], ['Clone', 1]]);

/**
 * The runtime version an assembly's metadata says it was built for: the
 * string in the metadata root its CLI header points at, or null for a file
 * that is not a managed assembly.
 *
 * @param {Uint8Array} file
 * @returns {string | null}
 */
export function metadataVersion(file){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    if (file.length < 0x40 || view.getUint16(0, true) !== 0x5a4d)
    {
        return null;
    }
    const pe = view.getUint32(0x3c, true);
    if (pe + 24 > file.length || view.getUint32(pe, true) !== 0x4550)
    {
        return null;
    }
    const sections = view.getUint16(pe + 6, true);
    const optional = pe + 24;
    const optionalSize = view.getUint16(pe + 20, true);
    const wide = view.getUint16(optional, true) === 0x20b;
    // Data directory 14, the CLI header.
    const directory = optional + (wide ? 112 : 96) + 14 * 8;
    if (directory + 8 > optional + optionalSize)
    {
        return null;
    }
    /** @param {number} rva */
    const offsetOf = rva=>{
        for (let i = 0; i < sections; i++)
        {
            const at = optional + optionalSize + i * 40;
            const address = view.getUint32(at + 12, true);
            const size = Math.max(view.getUint32(at + 8, true), view.getUint32(at + 16, true));
            if (rva >= address && rva < address + size)
            {
                return rva - address + view.getUint32(at + 20, true);
            }
        }
        return -1;
    };
    const cli = offsetOf(view.getUint32(directory, true));
    if (cli < 0 || cli + 16 > file.length)
    {
        return null;
    }
    const root = offsetOf(view.getUint32(cli + 8, true));
    if (root < 0 || root + 16 > file.length || view.getUint32(root, true) !== 0x424a5342)
    {
        return null;
    }
    const length = view.getUint32(root + 12, true);
    const bytes = file.subarray(root + 16, Math.min(file.length, root + 16 + length));
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/**
 * @param {HostingHost} host
 */
export function createHostingFunctions(host){
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));
    /** @param {number} at */
    const readU32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} at @param {string} text */
    const writeWide = (at, text)=>host.writeMemory(at >>> 0,
        new Uint8Array(Uint16Array.from(`${text}\0`, unit=>unit.charCodeAt(0)).buffer));
    /** @param {number} at */
    const wideAt = at=>((at >>> 0) === 0 ? null : host.readWideString(at >>> 0, 1024));
    /** @param {number} at */
    const guidAt = at=>readGuid(host, at >>> 0);

    /** `...\Microsoft.NET\Framework\`, where every runtime's directory is. */
    const frameworkRoot = ()=>`${host.windowsDirectory().replace(/\\$/, '')}\\Microsoft.NET\\`
        + 'Framework\\';

    /**
     * A string answered into a caller's buffer of `size` characters, its
     * length with the terminator told through `lengthAt` when there is one.
     * E_NOT_SUFFICIENT_BUFFER when there is a buffer and it is too small.
     *
     * @param {string} text @param {number} buffer @param {number} size @param {number} lengthAt
     */
    const answerText = (text, buffer, size, lengthAt)=>{
        if (lengthAt >>> 0)
        {
            writeU32(lengthAt, text.length + 1);
        }
        if ((buffer >>> 0) === 0)
        {
            return S_OK;
        }
        if ((size >>> 0) < text.length + 1)
        {
            return E_NOT_SUFFICIENT_BUFFER;
        }
        writeWide(buffer, text);
        return S_OK;
    };

    /** @type {number} */
    let loadedCallback = 0;
    /** @type {Map<string, { startupFlags: number, started: boolean, object: any }>} */
    const runtimes = new Map();

    /**
     * A file under a runtime's directory, loaded as a library: the name gets
     * `.dll` when it has no extension. E_HANDLE when it is not there.
     *
     * @param {string} version @param {string} name @param {number} out
     */
    const loadFromRuntime = async(version, name, out)=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        writeU32(out, 0);
        const file = /\.[^\\.]+$/.test(name) ? name : `${name}.dll`;
        const path = `${frameworkRoot()}${version}\\${file}`;
        if (!host.exists(path))
        {
            return E_HANDLE;
        }
        const module = await host.loadLibrary(path);
        if (!module)
        {
            return E_HANDLE;
        }
        writeU32(out, module);
        return S_OK;
    };

    /**
     * An installed runtime's ICLRRuntimeInfo, one object for each, kept for
     * the process: what it was told sticks, as the runtime's state does.
     *
     * @param {string} version
     */
    const runtimeInfo = version=>{
        const known = runtimes.get(version);
        if (known)
        {
            return known.object;
        }
        const state = { startupFlags: 0, started: false, object: /** @type {any} */ (null) };
        const handlers = {
            GetVersionString: (/** @type {number[]} */ [buffer, countAt])=>{
                if ((countAt >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const size = readU32(countAt);
                return answerText(version, buffer, size, countAt);
            },
            GetRuntimeDirectory: (/** @type {number[]} */ [buffer, countAt])=>{
                if ((countAt >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return answerText(`${frameworkRoot()}${version}\\`, buffer, readU32(countAt),
                    countAt);
            },
            IsLoaded: (/** @type {number[]} */ [, loadedAt])=>{
                if ((loadedAt >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(loadedAt, state.started ? 1 : 0);
                return S_OK;
            },
            LoadErrorString: ()=>{
                host.divergence?.('ICLRRuntimeInfo::LoadErrorString',
                    'the runtime\'s own error strings are not there');
                return E_NOTIMPL;
            },
            LoadLibrary: (/** @type {number[]} */ [name, out])=>{
                const text = wideAt(name);
                return text === null ? E_POINTER : loadFromRuntime(version, text, out);
            },
            GetProcAddress: (/** @type {number[]} */ [name, out])=>{
                if ((out >>> 0) !== 0)
                {
                    writeU32(out, 0);
                }
                host.divergence?.('ICLRRuntimeInfo::GetProcAddress',
                    `the runtime library's own export ${wideAt(name)} is not there`);
                return CLR_E_SHIM_RUNTIMEEXPORT;
            },
            GetInterface: async(/** @type {number[]} */ [clsid, iid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                const firstLoad = !runtimesStarted();
                const made = await host.runtimeInterface(version, guidAt(clsid), guidAt(iid));
                if ('failed' in made)
                {
                    return made.failed;
                }
                state.started = true;
                if (firstLoad && loadedCallback && host.notifyLoaded)
                {
                    await host.notifyLoaded(loadedCallback,
                        host.publish(state.object, IID.CLR_RUNTIME_INFO));
                }
                writeU32(out, made.pointer);
                return S_OK;
            },
            IsLoadable: (/** @type {number[]} */ [loadableAt])=>{
                if ((loadableAt >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(loadableAt, 1);
                return S_OK;
            },
            SetDefaultStartupFlags: (/** @type {number[]} */ [flags])=>{
                state.startupFlags = flags >>> 0;
                return S_OK;
            },
            GetDefaultStartupFlags: (/** @type {number[]} */ [flagsAt, buffer, countAt])=>{
                if ((flagsAt >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(flagsAt, state.startupFlags);
                // No host configuration file was named.
                return (countAt >>> 0) ? answerText('', buffer, readU32(countAt), countAt) : S_OK;
            },
            BindAsLegacyV2Runtime: ()=>S_OK,
            IsStarted: (/** @type {number[]} */ [startedAt, flagsAt])=>{
                if ((startedAt >>> 0) === 0 || (flagsAt >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(startedAt, state.started ? 1 : 0);
                writeU32(flagsAt, state.startupFlags);
                return S_OK;
            },
        };
        state.object = createComObject(IID.CLR_RUNTIME_INFO, { owned: true, interfaces: [
            { id: IID.CLR_RUNTIME_INFO, methods: methods(RUNTIME_INFO_SLOTS, handlers) },
        ] });
        runtimes.set(version, state);
        return state.object;
    };
    const runtimesStarted = ()=>[...runtimes.values()].some(state=>state.started);

    /**
     * An enumeration of objects, each handed out as IUnknown.
     *
     * @param {any[]} items @param {number} [start]
     */
    const enumeration = (items, start = 0)=>{
        let at = start;
        const handlers = {
            Next: (/** @type {number[]} */ [count, out, fetchedAt])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                let given = 0;
                while (given < (count >>> 0) && at < items.length)
                {
                    const item = items[at++];
                    item.addRef?.();
                    writeU32(out + given * 4, host.publish(item, '{00000000-0000-0000-C000-'
                        + '000000000046}'));
                    given++;
                }
                if (fetchedAt >>> 0)
                {
                    writeU32(fetchedAt, given);
                }
                return given === (count >>> 0) ? S_OK : S_FALSE;
            },
            Skip: (/** @type {number[]} */ [count])=>{
                const left = items.length - at;
                at += Math.min(left, count >>> 0);
                return (count >>> 0) <= left ? S_OK : S_FALSE;
            },
            Reset: ()=>{
                at = 0;
                return S_OK;
            },
            Clone: (/** @type {number[]} */ [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, host.publish(enumeration(items, at), IID.ENUM_UNKNOWN));
                return S_OK;
            },
        };
        return createComObject(IID.ENUM_UNKNOWN, { interfaces: [
            { id: IID.ENUM_UNKNOWN, methods: methods(ENUM_SLOTS, handlers) },
        ] });
    };

    /** The process's one ICLRMetaHost. @type {any} */
    let metaHost = null;
    const metaHostObject = ()=>{
        if (metaHost)
        {
            return metaHost;
        }
        const handlers = {
            GetRuntime: (/** @type {number[]} */ [versionAt, iid, out])=>{
                const version = wideAt(versionAt);
                if (version === null || (out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                const runtime = host.installed() ? exactRuntime(version) : null;
                if (runtime === null)
                {
                    return CLR_E_SHIM_RUNTIME;
                }
                return answerInterface(runtimeInfo(runtime), guidAt(iid), out);
            },
            GetVersionFromFile: async(/** @type {number[]} */ [pathAt, buffer, countAt])=>{
                const path = wideAt(pathAt);
                if (path === null || (countAt >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const file = await host.readFile(path);
                if (!file)
                {
                    return COR_E_FILENOTFOUND;
                }
                const version = metadataVersion(file);
                return version === null ? COR_E_BADIMAGEFORMAT
                    : answerText(version, buffer, readU32(countAt), countAt);
            },
            EnumerateInstalledRuntimes: (/** @type {number[]} */ [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const installed = host.installed() ? RUNTIME_VERSIONS.map(runtimeInfo) : [];
                writeU32(out, host.publish(enumeration(installed), IID.ENUM_UNKNOWN));
                return S_OK;
            },
            EnumerateLoadedRuntimes: (/** @type {number[]} */ [, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const loaded = RUNTIME_VERSIONS.filter(version=>runtimes.get(version)?.started)
                    .map(runtimeInfo);
                writeU32(out, host.publish(enumeration(loaded), IID.ENUM_UNKNOWN));
                return S_OK;
            },
            RequestRuntimeLoadedNotification: (/** @type {number[]} */ [callback])=>{
                if ((callback >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (loadedCallback)
                {
                    return HOST_E_INVALIDOPERATION;
                }
                loadedCallback = callback >>> 0;
                return S_OK;
            },
            QueryLegacyV2RuntimeBinding: (/** @type {number[]} */ [, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                return E_NOTIMPL;
            },
            ExitProcess: async(/** @type {number[]} */ [code])=>{
                await host.exitProcess(code >>> 0);
                return S_OK;
            },
        };
        metaHost = createComObject(CLSID.CLR_META_HOST, { owned: true, interfaces: [
            { id: IID.CLR_META_HOST, methods: methods(META_HOST_SLOTS, handlers) },
        ] });
        return metaHost;
    };

    /**
     * An object asked for by an interface: published and written out, or
     * E_NOINTERFACE with the out set to NULL.
     *
     * @param {any} object @param {string} iid @param {number} out
     */
    const answerInterface = (object, iid, out)=>{
        const record = object.queryInterface(iid);
        if (!record)
        {
            writeU32(out, 0);
            return E_NOINTERFACE;
        }
        writeU32(out, host.publish(object, iid));
        return S_OK;
    };

    /**
     * A read-only stream over a configuration file's bytes, as
     * CreateConfigStream hands one out: it reads forward and does nothing else.
     *
     * @param {Uint8Array} bytes
     */
    const configStream = bytes=>{
        let position = 0;
        const handlers = {
            Read: (/** @type {number[]} */ [buffer, count, readAt])=>{
                const taken = bytes.subarray(position, position + (count >>> 0));
                if (taken.length > 0)
                {
                    host.writeMemory(buffer >>> 0, taken);
                }
                position += taken.length;
                if (readAt >>> 0)
                {
                    writeU32(readAt, taken.length);
                }
                return S_OK;
            },
            Write: ()=>E_FAIL,
        };
        const streamMethods = methods(STREAM_SLOTS, handlers);
        return createComObject(IID.STREAM, { interfaces: [
            { id: IID.STREAM, methods: streamMethods },
            { id: IID.SEQUENTIAL_STREAM, methods: streamMethods.slice(0, 2) },
        ] });
    };

    /**
     * CLRCreateInstance and CreateInterface: the metahost, or no such class;
     * E_NOTIMPL on a machine without the runtime, as the shim that predates
     * .NET 4 answers.
     */
    const createInstance = {
        argBytes: 12,
        handler: (/** @type {number[]} */ [clsid, iid, out])=>{
            if ((out >>> 0) === 0 || (clsid >>> 0) === 0 || (iid >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            if (!host.installed())
            {
                // No .NET 4 on the machine: the shim of an older one, which
                // has no metahost to make.
                host.divergence?.('CLRCreateInstance', 'no .NET runtime in this bottle');
                return E_NOTIMPL;
            }
            if (guidAt(clsid) !== CLSID.CLR_META_HOST)
            {
                host.divergence?.('CLRCreateInstance', `the class ${guidAt(clsid)} is not made`);
                return CLASS_E_CLASSNOTAVAILABLE;
            }
            return answerInterface(metaHostObject(), guidAt(iid), out);
        },
    };

    return {
        /**
         * HRESULT GetCORVersion(LPWSTR pbBuffer, DWORD cchBuffer, DWORD *dwLength)
         *
         * The newest runtime the legacy shim knows: 2.0.
         */
        GetCORVersion: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [buffer, size, lengthAt])=>{
                if (!host.installed())
                {
                    return CLR_E_SHIM_RUNTIME;
                }
                if ((lengthAt >>> 0) === 0 || (buffer >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return answerText(LATEST_LEGACY, buffer, size, lengthAt);
            },
        },

        /**
         * HRESULT GetCORSystemDirectory(LPWSTR pbuffer, DWORD cchBuffer, DWORD *dwLength)
         *
         * That runtime's directory, with its backslash.
         */
        GetCORSystemDirectory: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [buffer, size, lengthAt])=>{
                if ((lengthAt >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (!host.installed())
                {
                    return CLR_E_SHIM_RUNTIME;
                }
                return answerText(`${frameworkRoot()}${LATEST_LEGACY}\\`, buffer, size, lengthAt);
            },
        },

        /**
         * HRESULT GetRequestedRuntimeInfo(LPCWSTR pExe, LPCWSTR pwszVersion,
         *   LPCWSTR pConfigurationFile, DWORD startupFlags, DWORD runtimeInfoFlags,
         *   LPWSTR pDirectory, DWORD dwDirectory, DWORD *dwDirectoryLength,
         *   LPWSTR pVersion, DWORD cchBuffer, DWORD *dwlength)
         *
         * The runtime a version asks for (`requestedRuntime`): the directory the
         * runtimes are in and the version as it is named. Either buffer may be
         * NULL and the other is still filled.
         */
        GetRequestedRuntimeInfo: {
            argBytes: 44,
            handler: (/** @type {number[]} */ [exe, versionAt, config, , flags, directory,
                directorySize, directoryLengthAt, versionOut, versionSize, versionLengthAt])=>{
                if (!host.installed())
                {
                    return CLR_E_SHIM_RUNTIME;
                }
                if ((exe >>> 0) !== 0 || (config >>> 0) !== 0)
                {
                    host.divergence?.('GetRequestedRuntimeInfo', 'an executable\'s or a'
                        + ' configuration file\'s own choice of runtime is not read');
                }
                const chosen = requestedRuntime(wideAt(versionAt), flags >>> 0);
                if (chosen === null)
                {
                    return CLR_E_SHIM_RUNTIME;
                }
                const placed = answerText(frameworkRoot(), directory, directorySize,
                    directoryLengthAt);
                const named = answerText(chosen.shown, versionOut, versionSize, versionLengthAt);
                return placed !== S_OK ? placed : named;
            },
        },

        /**
         * HRESULT CorIsLatestSvc(int *unk1, int *unk2)
         *
         * Undocumented; the one answer known is E_POINTER for no pointers. With
         * them, the runtime is said to be the latest serviced one.
         */
        CorIsLatestSvc: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [first, second])=>{
                if ((first >>> 0) === 0 || (second >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(first, 1);
                writeU32(second, 1);
                return S_OK;
            },
        },

        /**
         * HRESULT CreateConfigStream(LPCWSTR pszFileName, IStream **ppStream)
         *
         * A configuration file as a stream that reads forward and refuses the
         * rest: E_FAIL to a write, E_NOTIMPL to a seek, a resize, a clone, a
         * commit, a revert.
         */
        CreateConfigStream: {
            argBytes: 8,
            handler: async(/** @type {number[]} */ [nameAt, out])=>{
                if ((out >>> 0) === 0)
                {
                    return COR_E_NULLREFERENCE;
                }
                const name = wideAt(nameAt);
                if (name === null)
                {
                    return E_FAIL;
                }
                writeU32(out, 0);
                const bytes = await host.readFile(name);
                if (!bytes)
                {
                    return COR_E_FILENOTFOUND;
                }
                writeU32(out, host.publish(configStream(bytes), IID.STREAM));
                return S_OK;
            },
        },

        /**
         * HRESULT LoadLibraryShim(LPCWSTR szDllName, LPCWSTR szVersion,
         *   LPVOID pvReserved, HMODULE *phModDll)
         *
         * A library of a runtime's own directory: the version named, or the
         * newest legacy one; E_HANDLE for a version not installed or a library
         * not in that directory.
         */
        LoadLibraryShim: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [nameAt, versionAt, , out])=>{
                const name = wideAt(nameAt);
                if (name === null || (out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const asked = wideAt(versionAt);
                const version = !host.installed() ? null
                    : asked === null ? LATEST_LEGACY : exactRuntime(asked);
                if (version === null)
                {
                    writeU32(out, 0);
                    return E_HANDLE;
                }
                return loadFromRuntime(version, name, out);
            },
        },

        /** HRESULT CLRCreateInstance(REFCLSID clsid, REFIID riid, LPVOID *ppInterface) */
        CLRCreateInstance: createInstance,
        /** HRESULT CreateInterface(REFCLSID clsid, REFIID riid, LPVOID *ppInterface) */
        CreateInterface: createInstance,
    };
}

