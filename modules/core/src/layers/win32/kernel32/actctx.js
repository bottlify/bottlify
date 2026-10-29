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

import { formatGuid, parseGuid } from '../ole32/guid.js';
import {
    compareVersions, encodeIdentity, identityMatches, parseManifest,
} from './manifest.js';

/** Codes and statuses these calls answer with. */
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_RESOURCE_TYPE_NOT_FOUND = 1813;
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

/** The sections FindActCtxSectionString and FindActCtxSectionGuid look in. */
const SECTION_DLL_REDIRECTION = 2;
const SECTION_WINDOW_CLASS_REDIRECTION = 3;
const SECTION_COM_SERVER_REDIRECTION = 4;
const SECTION_COM_INTERFACE_REDIRECTION = 5;
const SECTION_COM_TYPE_LIBRARY_REDIRECTION = 6;
const SECTION_COM_PROGID_REDIRECTION = 7;
const SECTION_CLR_SURROGATES = 9;
const SECTION_WINRT_ACTIVATABLE_CLASSES = 12;
const GUID_SECTIONS = new Set([SECTION_COM_SERVER_REDIRECTION,
    SECTION_COM_INTERFACE_REDIRECTION, SECTION_COM_TYPE_LIBRARY_REDIRECTION,
    SECTION_CLR_SURROGATES]);
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
/** A GUID section: 'GsHd', then an index of GUIDs, the names and data. */
const GUID_SECTION_MAGIC = 0x64487347;
const GUID_SECTION_HEADER = 40;
const GUID_INDEX_ENTRY = 28;
const GUID_SIZE = 16;

const DLL_REDIRECT_PATH_OMITS_ASSEMBLY_ROOT = 0x2;
const DLL_REDIRECT_DATA = 20;
const WNDCLASS_REDIRECT_DATA = 24;
const COMCLASS_REDIRECT_DATA = 120;
const CLRCLASS_DATA = 44;
const IFACEPS_REDIRECT_DATA = 68;
const TLIB_REDIRECT_DATA = 32;
const PROGID_REDIRECT_DATA = 12;
const CLRSURROGATE_DATA = 40;
const ACTIVATABLE_CLASS_DATA = 20;
/** What a CLR class's server is, in the two spellings Windows gives it. */
const CLR_SERVER = 'MSCOREE.DLL';

/** comClass threadingModel, by its manifest spelling. */
const COM_THREADING = Object.freeze({ apartment: 1, free: 2, no: 3, both: 4, neutral: 5 });
/** activatableClass threadingModel. */
const WINRT_THREADING = Object.freeze({ both: 0, sta: 1, mta: 2 });
/** The miscStatus attributes, and the bit of the class's flags each sets. */
/** @type {readonly [string, number, number][]} */
const MISC_FIELDS = Object.freeze([['miscStatus', 1, 100], ['miscStatusContent', 4, 104],
    ['miscStatusThumbnail', 8, 108], ['miscStatusIcon', 2, 112], ['miscStatusDocPrint', 16, 116]]);
/** OLEMISC, by the names a manifest's miscStatus lists. */
const OLEMISC = Object.freeze({ recomposeonresize: 0x1, onlyiconic: 0x2, insertnotreplace: 0x4,
    static: 0x8, cantlinkinside: 0x10, canlinkbyole1: 0x20, islinkobject: 0x40, insideout: 0x80,
    activatewhenvisible: 0x100, renderingisdeviceindependent: 0x200, invisibleatruntime: 0x400,
    alwaysrun: 0x800, actslikebutton: 0x1000, actslikelabel: 0x2000, nouiactivate: 0x4000,
    alignable: 0x8000, simpleframe: 0x10000, setclientsitefirst: 0x20000, imemode: 0x40000,
    ignoreactivatewhenvisible: 0x80000, wantstomenumerge: 0x100000,
    supportsmultilevelundo: 0x200000 });
/** LIBFLAGS, by the names a typelib's flags list. */
const LIBFLAGS = Object.freeze({ restricted: 0x1, control: 0x2, hidden: 0x4, hasdiskimage: 0x8 });
/** ifacepsredirect_data's mask: which optional attributes were given. */
const IFACEPS_NUM_METHODS = 0x1;
const IFACEPS_BASE_INTERFACE = 0x2;

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
 * @property {Map<number, Section | null>} sections
 * @property {Map<object, Uint8Array>} aliases  the GUID each COM class is also found by
 */

/**
 * A section of a context in guest memory, with where each key's data is.
 *
 * @typedef {Object} Section
 * @property {number} base
 * @property {number} size
 * @property {number} global  the section's global data, from its base; 0 for none
 * @property {number} globalLength
 * @property {Map<string, { offset: number, length: number, roster: number }>} entries
 */

/**
 * What one key of a section is: the data is built once the layout says
 * where it goes (`at`, from the section's base) and where each string or
 * GUID it puts in the section's global data is (`global`).
 *
 * @typedef {Object} SectionItem
 * @property {string[]} keys  a string section's key, or the GUIDs a GUID section finds it by
 * @property {number} roster
 * @property {(at: number, global: (value: string | Uint8Array) => number) => Uint8Array} data
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
 * @property {(path: string, type: number, id: number | null)
 *     => Uint8Array | null | Promise<Uint8Array | null>} [fileResource]
 *     A resource of an image on the volume, read as data; a null id is the
 *     type's lowest numbered one, in any language.
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

/**
 * The last eight bytes of the GUID a COM class is given beside its own,
 * after a count and the context; any GUID no class has would do.
 */
const ALIAS_TAIL = Uint8Array.of(0xac, 0x7c, 0x7e, 0x11, 0xa1, 0x1a, 0x5e, 0xd0);

/** @param {string | null} text */
const guidOrZero = text=>(text === null ? null : parseGuid(text)) ?? new Uint8Array(GUID_SIZE);

/**
 * A comma-separated list of flag names, OR-ed through a table; names are
 * matched ignoring case and unknown ones add nothing.
 *
 * @param {string} text @param {Readonly<Record<string, number>>} table
 */
const flagsOf = (text, table)=>text.split(',').reduce((flags, name)=>
    flags | (table[name.trim().toLowerCase()] ?? 0), 0);

/** @param {Uint8Array} bytes */
const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** dllredirect_data for a DLL found in its assembly's directory. */
const dllRedirectData = ()=>{
    const bytes = new Uint8Array(DLL_REDIRECT_DATA);
    const view = viewOf(bytes);
    view.setUint32(0, DLL_REDIRECT_DATA, true);
    view.setUint32(4, DLL_REDIRECT_PATH_OMITS_ASSEMBLY_ROOT, true);
    return bytes;
};

/**
 * wndclass_redirect_data: the versioned name follows the header, then the
 * module's, whose offset is from the section's base.
 *
 * @param {number} at @param {string} versioned @param {string} module
 */
const wndclassData = (at, versioned, module)=>{
    const name = wide(`${versioned}\0`);
    const moduleName = wide(`${module}\0`);
    const bytes = new Uint8Array(WNDCLASS_REDIRECT_DATA + name.length + moduleName.length);
    const view = viewOf(bytes);
    view.setUint32(0, WNDCLASS_REDIRECT_DATA, true);
    view.setUint32(8, name.length - 2, true);
    view.setUint32(12, WNDCLASS_REDIRECT_DATA, true);
    view.setUint32(16, moduleName.length - 2, true);
    view.setUint32(20, at + WNDCLASS_REDIRECT_DATA + name.length, true);
    bytes.set(name, WNDCLASS_REDIRECT_DATA);
    bytes.set(moduleName, WNDCLASS_REDIRECT_DATA + name.length);
    return bytes;
};

/**
 * comclassredirect_data, then a CLR class's clrclass_data with its name and
 * runtime, then the class's ProgID. The server's name is in the section's
 * global data; a CLR class's server is the runtime's, MSCOREE.DLL there and
 * mscoree.dll in its clrclass_data.
 *
 * @param {import('./manifest.js').ComClass} comClass @param {Uint8Array} alias
 * @param {string | null} file  null for a CLR class
 * @param {(value: string | Uint8Array) => number} global
 */
const comClassData = (comClass, alias, file, global)=>{
    let clr = new Uint8Array(0);
    if (file === null)
    {
        const name = wide(`${comClass.name ?? ''}\0`);
        const runtime = wide(`${comClass.runtime ?? ''}\0`);
        clr = new Uint8Array(CLRCLASS_DATA + name.length + runtime.length);
        const view = viewOf(clr);
        const server = CLR_SERVER.toLowerCase();
        view.setUint32(0, CLRCLASS_DATA, true);
        view.setUint32(8, 2, true);
        view.setUint32(12, server.length * 2, true);
        view.setUint32(16, global(server), true);
        view.setUint32(20, name.length - 2, true);
        view.setUint32(24, CLRCLASS_DATA, true);
        view.setUint32(28, runtime.length - 2, true);
        view.setUint32(32, CLRCLASS_DATA + name.length, true);
        clr.set(name, CLRCLASS_DATA);
        clr.set(runtime, CLRCLASS_DATA + name.length);
    }
    const progid = comClass.progid === null ? null : wide(`${comClass.progid}\0`);
    const bytes = new Uint8Array(COMCLASS_REDIRECT_DATA + clr.length + (progid?.length ?? 0));
    const view = viewOf(bytes);
    const server = file ?? CLR_SERVER;
    let misc = 0;
    for (const [field, bit, offset] of MISC_FIELDS)
    {
        const value = comClass.misc[field];
        if (value !== undefined)
        {
            misc |= bit;
            view.setUint32(offset, flagsOf(value, OLEMISC), true);
        }
    }
    view.setUint32(0, COMCLASS_REDIRECT_DATA, true);
    view.setUint32(4, misc << 8, true);
    view.setUint32(8, COM_THREADING[/** @type {'both'} */ (comClass.threadingModel
        .toLowerCase())] ?? 0, true);
    bytes.set(guidOrZero(comClass.clsid), 12);
    bytes.set(alias, 28);
    bytes.set(guidOrZero(comClass.clsid), 44);
    bytes.set(guidOrZero(comClass.tlbid), 60);
    view.setUint32(76, server.length * 2, true);
    view.setUint32(80, global(server), true);
    if (clr.length > 0)
    {
        view.setUint32(92, clr.length, true);
        view.setUint32(96, COMCLASS_REDIRECT_DATA, true);
        bytes.set(clr, COMCLASS_REDIRECT_DATA);
    }
    if (progid)
    {
        view.setUint32(84, progid.length - 2, true);
        view.setUint32(88, COMCLASS_REDIRECT_DATA + clr.length, true);
        bytes.set(progid, COMCLASS_REDIRECT_DATA + clr.length);
    }
    return bytes;
};

/**
 * ifacepsredirect_data and the interface's name. An external proxy-stub
 * that names its proxy-stub class gives that class where the interface's
 * IID would be.
 *
 * @param {import('./manifest.js').ProxyStub} stub @param {boolean} external
 */
const proxyStubData = (stub, external)=>{
    const name = stub.name === null ? null : wide(`${stub.name}\0`);
    const bytes = new Uint8Array(IFACEPS_REDIRECT_DATA + (name?.length ?? 0));
    const view = viewOf(bytes);
    view.setUint32(0, IFACEPS_REDIRECT_DATA, true);
    view.setUint32(4, (stub.numMethods === null ? 0 : IFACEPS_NUM_METHODS)
        | (stub.baseInterface === null ? 0 : IFACEPS_BASE_INTERFACE), true);
    bytes.set(guidOrZero(external && stub.proxyStubClsid32 !== null
        ? stub.proxyStubClsid32 : stub.iid), 8);
    view.setUint32(24, stub.numMethods === null ? 0 : parseInt(stub.numMethods, 10) >>> 0, true);
    bytes.set(guidOrZero(stub.tlbid), 28);
    bytes.set(guidOrZero(stub.baseInterface), 44);
    if (name)
    {
        view.setUint32(60, name.length - 2, true);
        view.setUint32(64, IFACEPS_REDIRECT_DATA, true);
        bytes.set(name, IFACEPS_REDIRECT_DATA);
    }
    return bytes;
};

/**
 * tlibredirect_data and the help directory; the module's name is in the
 * section's global data.
 *
 * @param {{ version: string, helpdir: string, resourceid: string | null, flags: string }} typelib
 * @param {string} file @param {(value: string | Uint8Array) => number} global
 */
const typelibData = (typelib, file, global)=>{
    const help = typelib.helpdir === '' ? null : wide(`${typelib.helpdir}\0`);
    const bytes = new Uint8Array(TLIB_REDIRECT_DATA + (help?.length ?? 0));
    const view = viewOf(bytes);
    const [major = 0, minor = 0] = typelib.version.split('.').map(part=>parseInt(part, 10) || 0);
    view.setUint32(0, TLIB_REDIRECT_DATA, true);
    view.setUint32(8, file.length * 2, true);
    view.setUint32(12, global(file), true);
    view.setUint16(16, typelib.resourceid === null ? 0
        : parseInt(typelib.resourceid, 16) & 0xffff || 0, true);
    view.setUint16(18, flagsOf(typelib.flags, LIBFLAGS), true);
    if (help)
    {
        view.setUint32(20, help.length - 2, true);
        view.setUint32(24, TLIB_REDIRECT_DATA, true);
        bytes.set(help, TLIB_REDIRECT_DATA);
    }
    view.setUint16(28, major, true);
    view.setUint16(30, minor, true);
    return bytes;
};

/**
 * clrsurrogate_data, its runtime version, then its name.
 *
 * @param {{ clsid: string, name: string, runtime: string }} surrogate
 */
const surrogateData = surrogate=>{
    const runtime = wide(`${surrogate.runtime}\0`);
    const name = wide(`${surrogate.name}\0`);
    const bytes = new Uint8Array(CLRSURROGATE_DATA + runtime.length + name.length);
    const view = viewOf(bytes);
    view.setUint32(0, CLRSURROGATE_DATA, true);
    bytes.set(guidOrZero(surrogate.clsid), 8);
    view.setUint32(24, CLRSURROGATE_DATA, true);
    view.setUint32(28, runtime.length - 2, true);
    view.setUint32(32, CLRSURROGATE_DATA + runtime.length, true);
    view.setUint32(36, name.length - 2, true);
    bytes.set(runtime, CLRSURROGATE_DATA);
    bytes.set(name, CLRSURROGATE_DATA + runtime.length);
    return bytes;
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
    let aliasCount = 0;

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
     * then the two of them in a `<name>\` folder. One of a language is
     * looked for in that language's folder, `<culture>\` and
     * `<culture>\<name>\`, and nowhere else.
     *
     * @param {Identity} wanted @param {string} directory
     * @returns {Promise<StoreAssembly | null>}
     */
    const fromApplication = async(wanted, directory)=>{
        const culture = wanted.language && wanted.language !== '*'
            && wanted.language.toLowerCase() !== 'neutral' ? `${wanted.language}\\` : '';
        for (const folder of [`${directory}${culture}`, `${directory}${culture}${wanted.name}\\`])
        {
            for (const kind of ['dll', 'manifest'])
            {
                const path = `${folder}${wanted.name}.${kind}`;
                const entry = host.stat(path);
                if (!entry?.exists || entry.isDirectory)
                {
                    continue;
                }
                // A DLL's manifest is its lowest numbered one, whatever its language.
                const bytes = kind === 'dll'
                    ? await host.fileResource?.(path, RT_MANIFEST, null) ?? null
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
            rootManifestPath: where.manifestPath, sections: new Map(), aliases: new Map() };
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
     * The GUID a COM class is also found by, made for it in this context the
     * first time it is needed: its ProgIDs point at it.
     *
     * @param {Context} context @param {object} comClass
     */
    const aliasOf = (context, comClass)=>{
        let alias = context.aliases.get(comClass);
        if (!alias)
        {
            alias = new Uint8Array(GUID_SIZE);
            const view = new DataView(alias.buffer);
            view.setUint32(0, ++aliasCount, true);
            view.setUint32(4, context.handle, true);
            alias.set(ALIAS_TAIL, 8);
            context.aliases.set(comClass, alias);
        }
        return alias;
    };

    /**
     * What each assembly of a context puts in a section, in roster order.
     *
     * @param {Context} context @param {number} id
     * @returns {SectionItem[]}
     */
    const itemsOf = (context, id)=>{
        /** @type {SectionItem[]} */
        const items = [];
        const seen = new Set();
        /** @param {string[]} keys @param {number} roster @param {SectionItem['data']} data */
        const add = (keys, roster, data)=>{
            const fresh = keys.filter(key=>key !== '' && !seen.has(key.toUpperCase()));
            fresh.forEach(key=>seen.add(key.toUpperCase()));
            if (fresh.length > 0)
            {
                items.push({ keys: fresh, roster, data });
            }
        };
        context.assemblies.forEach((assembly, index)=>{
            const roster = index + 1;
            const manifest = assembly.manifest;
            /** @type {{ file: string | null, comClass: import('./manifest.js').ComClass }[]} */
            const classes = [
                ...manifest.files.flatMap(file=>(file.comClasses ?? []).map(comClass=>({
                    file: file.name, comClass }))),
                ...(manifest.clrClasses ?? []).map(comClass=>({ file: null, comClass })),
            ];
            switch (id)
            {
                case SECTION_DLL_REDIRECTION:
                    for (const file of manifest.files)
                    {
                        add([file.name], roster, ()=>dllRedirectData());
                    }
                    break;
                case SECTION_WINDOW_CLASS_REDIRECTION:
                    for (const file of manifest.files)
                    {
                        for (const windowClass of file.windowClasses)
                        {
                            const versioned = windowClass.versioned && assembly.identity.version
                                ? `${assembly.identity.version.join('.')}!${windowClass.name}`
                                : windowClass.name;
                            add([windowClass.name], roster, at=>wndclassData(at, versioned,
                                file.name));
                        }
                    }
                    break;
                case SECTION_COM_SERVER_REDIRECTION:
                    for (const { file, comClass } of classes)
                    {
                        const alias = aliasOf(context, comClass);
                        add([comClass.clsid, formatGuid(alias)], roster, (at, global)=>
                            comClassData(comClass, alias, file, global));
                    }
                    break;
                case SECTION_COM_PROGID_REDIRECTION:
                    for (const { comClass } of classes)
                    {
                        const alias = aliasOf(context, comClass);
                        for (const progid of comClass.progids)
                        {
                            add([progid], roster, (at, global)=>{
                                const bytes = new Uint8Array(PROGID_REDIRECT_DATA);
                                const view = new DataView(bytes.buffer);
                                view.setUint32(0, PROGID_REDIRECT_DATA, true);
                                view.setUint32(8, global(alias), true);
                                return bytes;
                            });
                        }
                    }
                    break;
                case SECTION_COM_INTERFACE_REDIRECTION:
                    for (const stub of [...manifest.files.flatMap(file=>file.proxyStubs ?? [])
                        .map(proxyStub=>({ proxyStub, external: false })),
                    ...(manifest.externalProxyStubs ?? []).map(proxyStub=>({ proxyStub,
                        external: true }))])
                    {
                        add([stub.proxyStub.iid], roster, ()=>proxyStubData(stub.proxyStub,
                            stub.external));
                    }
                    break;
                case SECTION_COM_TYPE_LIBRARY_REDIRECTION:
                    for (const file of manifest.files)
                    {
                        for (const typelib of file.typelibs ?? [])
                        {
                            add([typelib.tlbid], roster, (at, global)=>typelibData(typelib,
                                file.name, global));
                        }
                    }
                    break;
                case SECTION_CLR_SURROGATES:
                    for (const surrogate of manifest.clrSurrogates ?? [])
                    {
                        add([surrogate.clsid], roster, ()=>surrogateData(surrogate));
                    }
                    break;
                case SECTION_WINRT_ACTIVATABLE_CLASSES:
                    for (const file of manifest.files)
                    {
                        for (const activatable of file.activatableClasses ?? [])
                        {
                            add([activatable.name], roster, (at, global)=>{
                                const bytes = new Uint8Array(ACTIVATABLE_CLASS_DATA);
                                const view = new DataView(bytes.buffer);
                                view.setUint32(0, ACTIVATABLE_CLASS_DATA, true);
                                view.setUint32(8, file.name.length * 2, true);
                                view.setUint32(12, global(file.name), true);
                                view.setUint32(16, WINRT_THREADING[/** @type {'both'} */ (
                                    activatable.threadingModel.toLowerCase())] ?? 0, true);
                                return bytes;
                            });
                        }
                    }
                    break;
                default:
                    break;
            }
        });
        return items;
    };

    /**
     * A section of a context, built the first time it is asked for and kept
     * in guest memory while the context lives; null when no assembly of the
     * context has an entry for it.
     *
     * A string section is laid out header, index, key names, global data,
     * then each key's data; a GUID section the same without the names. Its
     * index is ordered by the key's hash, or by the GUID.
     *
     * @param {Context} context @param {number} id
     * @returns {Section | null}
     */
    const sectionOf = (context, id)=>{
        if (context.sections.has(id))
        {
            return context.sections.get(id) ?? null;
        }
        const guids = GUID_SECTIONS.has(id);
        const items = itemsOf(context, id);
        /** @type {{ key: string, item: SectionItem, guid: Uint8Array | null }[]} */
        const keys = items.flatMap(item=>item.keys.map(key=>({ key, item,
            guid: guids ? parseGuid(key) : null })))
            .filter(entry=>!guids || entry.guid !== null);
        if (keys.length === 0)
        {
            context.sections.set(id, null);
            return null;
        }
        if (guids)
        {
            const order = (/** @type {Uint8Array | null} */ guid)=>formatGuid(
                /** @type {Uint8Array} */ (guid));
            keys.sort((a, b)=>(order(a.guid) < order(b.guid) ? -1 : 1));
        }
        else
        {
            keys.sort((a, b)=>hashKey(a.key) - hashKey(b.key));
        }
        const header = guids ? GUID_SECTION_HEADER : STRING_SECTION_HEADER;
        let at = header + (guids ? GUID_INDEX_ENTRY : STRING_INDEX_ENTRY) * keys.length;
        /** @param {Uint8Array} bytes */
        const place = bytes=>{
            const offset = at;
            at += (bytes.length + 3) & ~3;
            return { bytes, offset };
        };
        const names = guids ? [] : keys.map(entry=>place(wide(`${entry.key}\0`)));
        // The global data holds what the items share: module names, aliases.
        /** @type {Map<string, { bytes: Uint8Array, offset: number }>} */
        const pool = new Map();
        /** @type {{ bytes: Uint8Array, offset: number }[]} */
        const pooled = [];
        /** @param {string | Uint8Array} value */
        const intern = value=>{
            const name = typeof value === 'string' ? `s${value}` : `g${formatGuid(value)}`;
            if (!pool.has(name))
            {
                pool.set(name, { bytes: typeof value === 'string' ? wide(`${value}\0`) : value,
                    offset: 0 });
            }
            return /** @type {{ bytes: Uint8Array, offset: number }} */ (pool.get(name));
        };
        // Data is built twice: once to learn what goes in the global data, then
        // in place, now that each piece has its offset.
        for (const item of items)
        {
            item.data(0, value=>{
                intern(value);
                return 0;
            });
        }
        const global = at;
        for (const piece of pool.values())
        {
            const placed = place(piece.bytes);
            piece.offset = placed.offset;
            pooled.push(placed);
        }
        const globalLength = at - global;
        /** @type {Map<SectionItem, { bytes: Uint8Array, offset: number }>} */
        const datas = new Map();
        for (const item of items)
        {
            datas.set(item, place(item.data(at, value=>intern(value).offset)));
        }
        const image = new Uint8Array(at);
        const view = new DataView(image.buffer);
        view.setUint32(0, guids ? GUID_SECTION_MAGIC : STRING_SECTION_MAGIC, true);
        view.setUint32(4, header, true);
        view.setUint32(8, 1, true);
        view.setUint32(20, keys.length, true);
        view.setUint32(24, header, true);
        view.setUint32(guids ? 32 : 36, globalLength === 0 ? 0 : global, true);
        view.setUint32(guids ? 36 : 40, globalLength, true);
        /** @type {Map<string, { offset: number, length: number, roster: number }>} */
        const entries = new Map();
        keys.forEach((entry, index)=>{
            const data = /** @type {{ bytes: Uint8Array, offset: number }} */ (
                datas.get(entry.item));
            if (entry.guid)
            {
                const slot = header + GUID_INDEX_ENTRY * index;
                image.set(entry.guid, slot);
                view.setUint32(slot + 16, data.offset, true);
                view.setUint32(slot + 20, data.bytes.length, true);
                view.setUint32(slot + 24, entry.item.roster, true);
            }
            else
            {
                const slot = header + STRING_INDEX_ENTRY * index;
                view.setUint32(slot, hashKey(entry.key), true);
                view.setUint32(slot + 4, names[index].offset, true);
                view.setUint32(slot + 8, names[index].bytes.length - 2, true);
                view.setUint32(slot + 12, data.offset, true);
                view.setUint32(slot + 16, data.bytes.length, true);
                view.setUint32(slot + 20, entry.item.roster, true);
                image.set(names[index].bytes, names[index].offset);
            }
            entries.set(entry.guid ? formatGuid(entry.guid) : entry.key.toUpperCase(),
                { offset: data.offset, length: data.bytes.length, roster: entry.item.roster });
        });
        for (const placed of [...pooled, ...datas.values()])
        {
            image.set(placed.bytes, placed.offset);
        }
        const base = allocate(image.length);
        if (base === 0)
        {
            return null;
        }
        host.writeMemory(base, image);
        /** @type {Section} */
        const section = { base, size: image.length, global: globalLength === 0 ? 0 : global,
            globalLength, entries };
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
     * @returns {{ context: Context, section: Section,
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
        put(16, found.section.global === 0 ? 0 : found.section.base + found.section.global);
        put(20, found.section.globalLength);
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

    /**
     * RtlFindActivationContextSectionGuid's body: the GUID read from guest
     * memory is the key, in the form the GUID sections index it by.
     *
     * @param {number} flags @param {number} extension @param {number} id
     * @param {number} key @param {number} data
     */
    const findGuid = (flags, extension, id, key, data)=>(key === 0
        ? STATUS_INVALID_PARAMETER
        : findString(flags, extension, id, formatGuid(host.readMemory(key, GUID_SIZE)), data));

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
        const named = (flags & ACTCTX_FLAG_RESOURCE_NAME_VALID) !== 0;
        const resource = named ? pointer(ACTCTX.lpResourceName) : 0;
        if (named && resource === 0)
        {
            return { error: ERROR_INVALID_PARAMETER };
        }
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
        /** @type {string} */
        let manifestPath;
        /** @type {string} */
        let appDirectory;
        const assemblyDirectory = request.directory === null ? null
            : `${host.fullPath(request.directory).replace(/\\+$/, '')}\\`;
        // A manifest in an image is the resource named, or else number 1:
        // missing, the one named is not found, and with none named there is
        // no manifest of that kind at all.
        const missing = request.resource === null
            ? ERROR_RESOURCE_TYPE_NOT_FOUND : ERROR_RESOURCE_NAME_NOT_FOUND;
        const resource = request.resource ?? CREATEPROCESS_MANIFEST_RESOURCE_ID;
        if (request.module !== 0)
        {
            bytes = host.moduleResource?.(request.module, RT_MANIFEST, resource) ?? null;
            if (bytes === null)
            {
                return { error: missing };
            }
            const path = host.modulePath?.(request.module) ?? host.imagePath();
            manifestPath = path;
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
            bytes = await host.readFile(path);
            // An image named as the source holds its manifest as a resource.
            const image = bytes !== null && bytes[0] === 0x4d && bytes[1] === 0x5a;
            if (request.resource !== null || image)
            {
                bytes = await host.fileResource?.(path, RT_MANIFEST, resource) ?? null;
                if (bytes === null)
                {
                    return { error: missing };
                }
            }
            manifestPath = path;
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
        /**
         * NTSTATUS RtlFindActivationContextSectionGuid(ULONG flags, const GUID *,
         *     ULONG section, const GUID *, ACTCTX_SECTION_KEYED_DATA *)
         */
        RtlFindActivationContextSectionGuid: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([flags, guid, id, key, data])=>findGuid(flags >>> 0, guid >>> 0, id >>> 0,
                key >>> 0, data >>> 0),
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
         * BOOL FindActCtxSectionGuid(DWORD dwFlags, const GUID *, ULONG ulSectionId,
         *     const GUID *lpGuidToFind, PACTCTX_SECTION_KEYED_DATA ReturnedData)
         *
         * COM classes (by CLSID or the GUID a ProgID points at), interfaces,
         * type libraries and CLR surrogates.
         */
        FindActCtxSectionGuid: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([flags, guid, id, key, data])=>{
                if ((data >>> 0) === 0 || (key >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const status = findGuid(flags >>> 0, guid >>> 0, id >>> 0, key >>> 0, data >>> 0);
                if (status !== STATUS_SUCCESS)
                {
                    return fail(errorOf(status));
                }
                host.setLastError(0);
                return 1;
            },
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
