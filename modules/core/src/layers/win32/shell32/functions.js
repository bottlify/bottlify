/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shell32 — the calls that reach outside the process, and the ones that do not.
 *
 * Most of this is a refusal, and the refusals are the point. The shell's job is
 * to consult registries this build does not have -- which handler a document
 * belongs to, which verb a file offers, what a shortcut resolves to -- and to
 * put a person in front of a folder tree. Returning success for any of those is
 * the failure that costs most later, because the caller carries on believing
 * something happened and fails somewhere with nothing to connect it back.
 *
 * The refusals are the documented ones rather than a generic error, because a
 * caller distinguishes them: "no application is associated with this" is a
 * thing a program handles, and a program that gets it stops asking.
 *
 * Launching is not a refusal. A program the shell is asked to run is run, the
 * same way kernel32's CreateProcess runs one, because the file is its own
 * handler and there is nothing to look up; that is how an installer starts the
 * installer it just unpacked. What still cannot be done is a document, whose
 * handler would come from an association registry.
 *
 * Drag and drop is neither, and it is not a refusal but a truth: files are
 * never dropped on a window here, so a window may accept drops and a query
 * against a drop that never arrived reports no files. Both are what a real
 * system answers when nobody has dragged anything.
 *
 * Nor is the file operation an installer lays its files out with: the volume
 * is there to copy, move, rename and delete on (`fileop.js`).
 */

import {
    CONTROL_PANEL, MY_COMPUTER, createShellNamespace, itemsOf, listBytes, pathOfList,
} from './namespace.js';
import { createDirectoryPath, runFileOperation } from './fileop.js';
import { readFileIcons } from './icons.js';
import { splitCommandLine } from './commandline.js';
import { createDesktopFunctions } from './desktop.js';
import { createShellItems } from './shellitem.js';
import { IDLIST_ORDINALS, createIdListFunctions } from './idlist.js';
import { createDropFunctions } from './drop.js';
import { createShellExtras } from './extras.js';
import { argify, createAssociations, pathOfFileUrl } from './associations.js';
import { decodeShellLink } from '../common/shell-link.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { fileAttributes, msToFileTime } from '../kernel32/filetime.js';
import { WIN32_FIND_DATAA } from '../kernel32/files.js';
import { urlOfShortcut } from './internet-shortcut.js';
import { charactersOf, readToTerminator } from '../common/scan-windows.js';

/**
 * How far a name a program hands these is read: whole, as Windows reads it, up to
 * the 32 767 characters a path may have. A name cut shorter names another file.
 */
const WHOLE_NAME = 32767;

/**
 * The exports a program imports from shell32 by number alone, by their XP
 * ordinals.
 */
export const SHELL32_ORDINALS = Object.freeze(Object.fromEntries([
    [2, 'SHChangeNotifyRegister'], [3, 'SHDefExtractIconA'], [4, 'SHChangeNotifyDeregister'],
    [6, 'SHDefExtractIconW'], [28, 'SHILCreateFromPath'], [67, 'Shell_MergeMenus'],
    [256, 'SHCreateShellFolderView'], [654, 'ReadCabinetState'], [727, 'SHGetImageList'],
    [747, 'SHLimitInputEdit'], [179, 'SHGetNewLinkInfoA'], [180, 'SHGetNewLinkInfoW'],
    [71, 'Shell_GetImageLists'], [157, 'ILCreateFromPathW'], [162, 'SHSimpleIDListFromPath'],
    [165, 'SHCreateDirectory'], [189, 'ILCreateFromPathA'], [190, 'ILCreateFromPathW'],
    [644, 'SHChangeNotification_Lock'], [645, 'SHChangeNotification_Unlock'],
    ...IDLIST_ORDINALS,
]));

/** ShellExecute reports failure as a value of 32 or less, not as zero. */
const SE_ERR_FNF = 2;
const SE_ERR_ACCESSDENIED = 5;
const SE_ERR_NOASSOC = 31;

/** FindExecutable and ShellExecute, like WinExec, report success above 32. */
const LAUNCH_SUCCESS = 33;

/**
 * The verbs that amount to running the file. An empty verb is `open`, as the
 * call documents; `runas` is `open` with a prompt this machine has no reason to
 * show, there being one user and one volume it already owns.
 */
const RUNNABLE_VERBS = Object.freeze(new Set(['', 'open', 'runas']));

/**
 * The extensions the shell runs directly: the file is its own associated
 * executable, needing no handler registry. Anything else is a document whose
 * handler would come from an association registry this build does not have.
 */
const SELF_EXECUTABLE = Object.freeze(new Set(['exe', 'com', 'bat', 'cmd', 'pif', 'scr']));

/** The text documents Windows XP opens in Notepad. */
const TEXT_DOCUMENTS = Object.freeze(new Set(['txt', 'log', 'ini', 'inf', 'nfo', 'diz']));
/**
 * The command XP's registry gives a text file: Notepad in the system folder,
 * the file after it unquoted, as `%SystemRoot%\system32\NOTEPAD.EXE %1` reads.
 */
const NOTEPAD = 'C:\\WINDOWS\\system32\\notepad.exe';
/** An address the browser opens rather than a file. */
const ADDRESS = /^(https?|ftp|mailto):/i;

/** A URL's scheme: two characters at least, so that a drive is none. */
const PROTOCOL = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/** E_NOTIMPL, for the allocator this build does not hand out. */
const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const S_OK = 0;
const S_FALSE = 1;

/** What SHFileOperation answers when it will not operate. */
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** A name that is there but is a file where a directory was asked for. */
const ERROR_DIRECTORY = 267;

/** @param {number} code @returns {number} HRESULT_FROM_WIN32 */
const fromWin32 = code=>(code === 0 ? S_OK : (0x80070000 | code) | 0);

/**
 * SHPathPrepareForWrite's flags. SHPPFW_NOWRITECHECK and
 * SHPPFW_MEDIACHECKONLY are documented as not implemented, and are not.
 */
const SHPPFW_DIRCREATE = 0x01;
const SHPPFW_ASKDIRCREATE = 0x02;
const SHPPFW_IGNOREFILENAME = 0x04;

/** The longest command line a process can be given, in characters. */
const MAX_COMMAND_LINE = 32767;

/** SHELLEXECUTEINFOA: the fields a launch reads, and the two it writes back. */
const SEI_MASK = 4;
const SEI_VERB = 12;
const SEI_FILE = 16;
const SEI_PARAMETERS = 20;
const SEI_DIRECTORY = 24;
const SEI_CLASS = 40;
const SHELLEXECUTEINFO_HINSTAPP = 32;
const SHELLEXECUTEINFO_PROCESS = 56;

/**
 * The mask bits that change what the record means rather than what is done:
 * an item id list or a class name in place of a file, neither of which is a
 * path this shell can resolve, and the ask for a handle to wait on.
 */
const SEE_MASK_IDLIST = 0x00000004;
const SEE_MASK_NOCLOSEPROCESS = 0x00000040;
const SEE_MASK_CLASSNAME = 0x00000001;
const GWL_EXSTYLE = -20;
const WS_EX_ACCEPTFILES = 0x10;
const NIM_ADD = 0;
const NIM_MODIFY = 1;
const NIM_DELETE = 2;
const NIM_SETFOCUS = 3;
const NIM_SETVERSION = 4;
const SEE_MASK_DOENVSUBST = 0x00000200;

/**
 * SHFILEOPSTRUCT, either spelling. shellapi.h packs the structure to one byte
 * on Win32 and fFlags is a WORD, so the BOOL after it sits at 18, not at the
 * 20 natural alignment would give it, and hNameMappings at 22.
 */
const SHFILEOPSTRUCT_FUNC = 4;
const SHFILEOPSTRUCT_FROM = 8;
const SHFILEOPSTRUCT_TO = 12;
const SHFILEOPSTRUCT_FLAGS = 16;
const SHFILEOPSTRUCT_ABORTED = 18;
const SHFILEOPSTRUCT_MAPPINGS = 22;

/** Asks for the renames FOF_RENAMEONCOLLISION made, in hNameMappings. */
const FOF_WANTMAPPINGHANDLE = 0x0020;

/** How much of a pFrom or pTo list is read, every name included. */
const MAX_LIST = 0x8000;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** E_FAIL, for a namespace call in a build with no volume behind it. */
const E_FAIL = 0x80004005 | 0;

/** The computer: a folder with no path, whose children are the drives. */
const CSIDL_DRIVES = 0x11;
const CSIDL_CONTROLS = 0x03;
const CLSID_SHELL_DESKTOP = '{00021400-0000-0000-C000-000000000046}';
const CSIDL_DESKTOP = 0x00;
const CSIDL_DESKTOPDIRECTORY = 0x10;
/** The user's documents, "My Documents". */
const CSIDL_PERSONAL = 0x05;

/** Where a bare file name is looked for after the current directory. */
const CSIDL_SYSTEM = 0x25;
const CSIDL_WINDOWS = 0x24;

/** CSIDL_FLAG_CREATE and its kin ride in the high bits of the folder id. */
const CSIDL_FLAG_MASK = 0xff00;

/** A path argument is at most this long. */
const MAX_PATH = 260;

/**
 * The folders a CSIDL names, by the registry's name for each. The desktop and
 * its directory are one folder here, as they are on disk.
 *
 * @type {Readonly<Record<number, string>>}
 */
const CSIDL_FOLDERS = Object.freeze({
    0x00: 'Desktop',
    0x02: 'Programs',
    0x05: 'Personal',
    0x07: 'Startup',
    0x0b: 'Start Menu',
    0x10: 'Desktop',
    0x14: 'Fonts',
    0x16: 'Common Start Menu',
    0x17: 'Common Programs',
    0x18: 'Common Startup',
    0x19: 'Common Desktop',
    0x1a: 'AppData',
    0x1c: 'Local AppData',
    0x23: 'Common AppData',
    0x24: 'Windows',
    0x25: 'System',
    0x26: 'ProgramFiles',
    0x28: 'Profile',
    0x2b: 'CommonFiles',
    0x2e: 'Common Documents',
});

/**
 * @typedef {Object} ShellHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(address: number) => void} [free]
 *           Gives back what `allocate` gave: ILFree and SHFree.
 * @property {(steps: Generator<{ entry: number, args: number[] }, any, number>) => any} [drive]
 *           Runs a handler's calls into the guest: SHBindToObject on a folder
 *           of the program's own.
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }>
 *     | undefined} [library]
 *           Another library's exports, read when a call is made: what the
 *           calls built on kernel32's -- a drop's block, environment strings
 *           -- reach it through.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call whose answer differs from Windows says so, rather than
 *           failing silently -- the name and the detail, as the assembling
 *           caller's reporter takes them.
 * @property {{ pointer: () => number }} [taskAllocator]
 *           The process's IMalloc, the same one CoGetMalloc answers with.
 *           Absent in a build without ole32 behind it, and then SHGetMalloc
 *           is refused.
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, limit: number) => string} [readCString]
 *           Reads an ANSI argument string. Without it neither FindExecutable nor
 *           a launch can read the file it is asked about, and both refuse.
 * @property {(path: string) => string} [resolve]
 *           Qualifies a path against the process's current directory and
 *           normalises it; what FindExecutable writes back as the executable.
 *           Without it there is no full path to answer with, so it refuses.
 * @property {import('../kernel32/spawn.js').Spawner} [launcher]
 *           Finds the image a name points at and records a child for it --
 *           kernel32's own machinery, because a program started through the
 *           shell has to be started the same way as one started through
 *           CreateProcess or it is a different program. Without it a launch is
 *           refused, and a record's handle is what ShellExecuteEx hands a caller
 *           that asked to wait on the child.
 * @property {(url: string) => boolean} [openUrl]
 *           Hands an address to whoever is in front of the run -- a page opens
 *           it in a tab of its own -- and says whether anything took it: the
 *           browser Windows starts for an http link, a .url or a mailto.
 * @property {(bytes: number) => number} [allocate]
 *           The task allocator's memory, which is what a caller frees an item
 *           id list with -- and LocalFree frees the block CommandLineToArgvW
 *           makes with, the process having one allocator under both. Without
 *           it no list can be made and the folder calls fail as an
 *           out-of-memory would.
 * @property {Readonly<Record<string, string>>} [folders]
 *           The shell folders by the registry's names; absent, no CSIDL is known.
 * @property {import('./namespace.js').NamespaceVolume} [volume]
 *           The volume the namespace walks, and the file operation works on
 *           when it is the whole of kernel32's (`fileop.js`). Absent, there is
 *           no namespace and SHGetDesktopFolder is refused, and a file
 *           operation is refused as not implemented.
 * @property {(object: import('../oleaut32/objects.js').ComAdapter, interfaceId: string) => number} [publish]
 *           Puts a namespace object's interface into guest memory. Absent, as
 *           without the volume.
 * @property {(picture: import('../user32/cursors.js').CursorPicture) => number} [icon]
 *           An icon handle over a picture, the object user32's CreateIcon
 *           makes, which DestroyIcon releases and DrawIcon draws. Without it
 *           ExtractIcon still counts a file's icons but hands none out.
 * @property {() => string} [imagePath]
 *           The running program's path, what GetModuleFileName answers for
 *           it: CommandLineToArgvW's whole answer to an empty command line.
 * @property {(code: number) => void} [setLastError]
 * @property {(clsid: string, factory: () => import('../ole32/objects.js').ComClassDefinition)
 *     => void} [registerClass]  Where CoCreateInstance finds a class of the shell's.
 */

/** @param {string} text @returns {Uint8Array} text in the ANSI page, with its terminator */
const sz = text=>encodeAnsi(`${text}\0`);

/** @param {number} value */
const dword = value=>new Uint8Array([
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
]);

/**
 * `then` on a value, or on what a promise of one settles to: an icon read
 * may wait for bytes still on their way.
 *
 * @template T, U
 * @param {T | Promise<T>} value @param {(settled: T) => U | Promise<U>} then
 * @returns {U | Promise<U>}
 */
const after = (value, then)=>(value instanceof Promise ? value.then(then) : then(value));

/** ExtractIconEx's two sizes: SM_CXICON's and SM_CXSMICON's. */
const LARGE_ICON = 32;
const SMALL_ICON = 16;

/** The most icons one ExtractIconEx hands out, whatever count it is given. */
const MAX_EXTRACTED = 0x100;

/** SHGetDataFromIDList's formats, and the sizes of what the first and third fill. */
const SHGDFIL_FINDDATA = 1;
const SHGDFIL_DESCRIPTIONID = 3;
const WIN32_FIND_DATAW_SIZE = 592;
const SHDESCRIPTIONID_SIZE = 20;
/** SHDESCRIPTIONID's kinds for what a path names. */
const SHDID_FS_FILE = 2;
const SHDID_FS_DIRECTORY = 3;
const SHDID_COMPUTER_FIXED = 8;

/**
 * @param {ShellHost} host
 */
export function createShellFunctions(host){
    /** Memory to scan, where the host gives it: asked only once `host.readMemory` is seen. */
    const scanned = /** @type {import('../common/scan-windows.js').ScannedMemory} */ (host);

    /** @param {number} csidl @returns {string | null} */
    const folderOf = csidl=>host.folders?.[CSIDL_FOLDERS[csidl & ~CSIDL_FLAG_MASK]] ?? null;

    /**
     * A path into a buffer that MAX_PATH was sized for: written whole or, when
     * the buffer is not there, not at all.
     *
     * @param {number} buffer @param {string} path
     */
    const writePath = (buffer, path)=>{
        if (buffer !== 0)
        {
            host.writeMemory(buffer, sz(path.slice(0, MAX_PATH - 1)));
        }
    };

    /**
     * The same path into a buffer sized for wide characters: each code unit
     * two bytes, terminated by two zero bytes.
     *
     * @param {number} buffer @param {string} path
     */
    const writeWidePath = (buffer, path)=>{
        if (buffer === 0)
        {
            return;
        }
        const text = path.slice(0, MAX_PATH - 1);
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let at = 0; at < text.length; at++)
        {
            const code = text.charCodeAt(at);
            bytes[at * 2] = code & 0xff;
            bytes[at * 2 + 1] = code >> 8;
        }
        host.writeMemory(buffer, bytes);
    };

    const memory = host.readMemory
        ? { readMemory: host.readMemory, writeMemory: host.writeMemory } : null;
    const namespace = memory && host.volume && host.publish && host.allocate
        ? createShellNamespace({
            publish: host.publish, allocate: host.allocate, memory, volume: host.volume,
            documents: ()=>folderOf(CSIDL_PERSONAL),
        }) : null;
    if (namespace)
    {
        // The desktop is a class too, which COM makes for a program that asks.
        host.registerClass?.(CLSID_SHELL_DESKTOP, ()=>namespace.desktopClass());
    }

    /** @returns {number} the empty list, put where ILFree frees it, or zero */
    const emptyList = ()=>{
        const at = host.allocate?.(2) ?? 0;
        if (at)
        {
            host.writeMemory(at, Uint8Array.of(0, 0));
        }
        return at;
    };

    /**
     * An item id list of one item whose data is the text (a path, or the
     * computer's `::` name), then the empty item that ends every list. A
     * list made this way carries what it names, so turning it back needs no
     * table.
     *
     * @param {string} text
     * @returns {number} where it was put, or zero
     */
    const listFor = text=>{
        if (!host.allocate)
        {
            return 0;
        }
        const bytes = listBytes(text);
        const at = host.allocate(bytes.length);
        host.writeMemory(at, bytes);
        return at;
    };

    /** @param {number} list @returns {string | null} */
    // The empty list is the desktop, whose files are its directory's.
    const pathOf = list=>(list === 0 || !memory ? null
        : itemsOf(memory, list).length === 0 ? folderOf(CSIDL_DESKTOPDIRECTORY)
            : pathOfList(memory, list));

    /**
     * The ANSI string an argument points at, or null when there is none to
     * read: a null pointer, no reader, or a pointer to unterminated data.
     *
     * @param {number} address
     * @returns {string | null}
     */
    const stringOf = address=>{
        if ((address >>> 0) === 0 || !host.readCString)
        {
            return null;
        }
        try
        {
            return host.readCString(address >>> 0, WHOLE_NAME);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * The extension of a path: the text after the last dot in its final name,
     * lower-cased, or empty when it has none.
     *
     * @param {string} path
     * @returns {string}
     */
    const extensionOf = path=>{
        const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
        const dot = name.lastIndexOf('.');
        return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    };

    /** @param {string} path @returns {boolean} whether it already names a place */
    const isQualified = path=>/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path);

    /**
     * The full path FindExecutable writes back: a qualified name is normalised,
     * a relative one is resolved against the directory when one is given and
     * against the process's current directory otherwise.
     *
     * @param {string} file @param {string} directory
     * @returns {string}
     */
    const fullPath = (file, directory)=>{
        const candidate = isQualified(file) || directory === ''
            ? file : `${/[\\/]$/.test(directory) ? directory : `${directory}\\`}${file}`;
        try
        {
            return host.resolve?.(candidate) ?? candidate;
        }
        catch (e){
            void e;
            return candidate;
        }
    };

    /**
     * A name without the quotes a caller may have put round it: the shell takes
     * a file, and a program that already composed a command line hands it over
     * quoted.
     *
     * @param {string} name
     * @returns {string}
     */
    const unquote = name=>name.length > 1 && name.startsWith('"') && name.endsWith('"')
        ? name.slice(1, -1).trim() : name;

    /**
     * A name without the dots that end it, which no file's name keeps:
     * `readme.txt.` is readme.txt. A name that is all dots stays.
     *
     * @param {string} name
     */
    const withoutTrailingDots = name=>name.replace(/([^\\/.])\.+$/, '$1');

    /**
     * The volume as the file operation needs it, or null in a build whose
     * volume cannot do all of it.
     *
     * @returns {import('./fileop.js').FileOpVolume | null}
     */
    const fileVolume = ()=>{
        const volume = /** @type {any} */ (host.volume);
        const needed = ['stat', 'list', 'open', 'read', 'write', 'close', 'remove', 'mkdir',
            'rename', 'currentDirectory'];
        return volume && host.readMemory && needed.every(name=>typeof volume[name] === 'function')
            ? /** @type {import('./fileop.js').FileOpVolume} */ (volume) : null;
    };

    /**
     * A pFrom or pTo list: names each ended by a terminator, the list by an
     * empty name. Null for a null pointer, which is not an empty list.
     *
     * @param {number} address @param {boolean} wide
     * @returns {string[] | null}
     */
    const listAt = (address, wide)=>{
        if ((address >>> 0) === 0 || !host.readMemory)
        {
            return null;
        }
        /** @type {string[]} */
        const names = [];
        const unit = wide ? 2 : 1;
        // Each name read a window at a time, so a list at the end of what the
        // program allocated is not read past; one cut short by the end of the
        // list's room or of memory is no name.
        for (let at = address >>> 0, read = 0; read < MAX_LIST;)
        {
            const { bytes, terminated } = readToTerminator(scanned, at, unit, MAX_LIST - read);
            if (!terminated || bytes.length === 0)
            {
                return names;
            }
            // An ANSI name is the page's, as the path of every other ANSI call is.
            names.push(wide ? charactersOf(bytes, 2) : decodeAnsi(bytes));
            read += bytes.length / unit + 1;
            at += bytes.length + unit;
        }
        return names;
    };

    /**
     * The UTF-16 string an argument points at, or null for a null pointer;
     * read a window at a time, so one at the end of what the program
     * allocated is not read past.
     *
     * @param {number} address
     * @param {number} [limit]  How many characters are read at most.
     * @returns {string | null}
     */
    const wideStringOf = (address, limit = MAX_PATH)=>((address >>> 0) === 0 || !host.readMemory
        ? null : charactersOf(readToTerminator(scanned, address, 2, limit).bytes, 2));

    /**
     * A string argument in the spelling the call was made in.
     *
     * @param {number} address @param {boolean} wide
     * @returns {string | null}
     */
    const textOf = (address, wide)=>(wide ? wideStringOf(address) : stringOf(address));

    /**
     * SHFileOperation, for either spelling of the record: its lists read,
     * FALSE written where the caller reads whether anything was cancelled --
     * nothing is, there being nobody to cancel it -- and the operation run.
     *
     * @param {boolean} wide
     */
    const fileOperation = wide=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [operation])=>{
            const at = operation >>> 0;
            if (at === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const volume = fileVolume();
            if (!volume)
            {
                host.writeMemory(at + SHFILEOPSTRUCT_ABORTED, dword(1));
                return ERROR_CALL_NOT_IMPLEMENTED;
            }
            const from = listAt(dwordAt(at, SHFILEOPSTRUCT_FROM), wide);
            const flags = dwordAt(at, SHFILEOPSTRUCT_FLAGS) & 0xffff;
            if (from !== null)
            {
                host.writeMemory(at + SHFILEOPSTRUCT_ABORTED, dword(0));
            }
            if ((flags & FOF_WANTMAPPINGHANDLE) !== 0)
            {
                // Renames made on a collision are not kept as a mapping
                // object, so there is none to hand over.
                host.writeMemory(at + SHFILEOPSTRUCT_MAPPINGS, dword(0));
            }
            const deps = { volume, resolve: host.resolve, divergence: host.divergence };
            return runFileOperation(deps, {
                func: dwordAt(at, SHFILEOPSTRUCT_FUNC),
                from,
                to: listAt(dwordAt(at, SHFILEOPSTRUCT_TO), wide),
                flags,
            });
        },
    });

    /**
     * SHCreateDirectoryEx, for either spelling of the path.
     *
     * @param {boolean} wide
     */
    const createDirectory = (wide, argBytes = 12)=>({
        argBytes,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [, path])=>{
            const volume = fileVolume();
            if (!volume)
            {
                return ERROR_ACCESS_DENIED;
            }
            return createDirectoryPath({ volume }, wide ? wideStringOf(path) : stringOf(path));
        },
    });

    /**
     * The dword a record holds at an offset, or zero with no memory to read.
     *
     * @param {number} record @param {number} offset
     * @returns {number}
     */
    const dwordAt = (record, offset)=>{
        if (!host.readMemory)
        {
            return 0;
        }
        const bytes = host.readMemory((record + offset) >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @type {Set<string>} The notification area's icons, by window and id. */
    const trayIcons = new Set();
    const notifyIcon = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [message, data])=>{
            if ((data >>> 0) === 0)
            {
                return 0;
            }
            const icon = `${dwordAt(data >>> 0, 4)}:${dwordAt(data >>> 0, 8)}`;
            const known = trayIcons.has(icon);
            switch (message >>> 0)
            {
                case NIM_ADD:
                    if (known)
                    {
                        return 0;
                    }
                    trayIcons.add(icon);
                    host.setLastError?.(0);
                    return 1;
                case NIM_DELETE:
                    if (!known)
                    {
                        host.setLastError?.(E_FAIL >>> 0);
                        return 0;
                    }
                    trayIcons.delete(icon);
                    return 1;
                case NIM_MODIFY:
                case NIM_SETFOCUS:
                case NIM_SETVERSION:
                    return known ? 1 : 0;
                default:
                    return 0;
            }
        },
    };

    /**
     * Runs what the shell was asked to open, answering the way ShellExecute
     * does: above 32 when a child was recorded, and one of its own codes below
     * it when it could not be.
     *
     * The child's command line is composed here rather than passed through, so
     * that the image travels quoted however the caller spelled it: an image
     * found under a name with a space in it hands the tail of its own path to
     * the program as an argument otherwise.
     *
     * @param {string | null} verb       The operation; null is `open`.
     * @param {string | null} file       The file to open.
     * @param {string | null} parameters The arguments the child is given.
     * @param {string | null} directory  The directory the child is to start in.
     * @param {string | null} [given]  The class SEE_MASK_CLASSNAME names.
     * @returns {{ answer: number, record: any }}
     */
    const start = (verb, file, parameters, directory, given = null)=>{
        // A blank before the name is part of it, which names no file; one
        // after it is not. A name in doubled quotes is the name inside them.
        const url = pathOfFileUrl(unquote(unquote((file ?? '').trimEnd())));
        if (url === null)
        {
            return { answer: SE_ERR_FNF, record: null };
        }
        const typed = withoutTrailingDots(url);
        if (given !== null)
        {
            return openAssociated(typed, verb, parameters, given)
                ?? { answer: SE_ERR_NOASSOC, record: null };
        }
        const runnable = RUNNABLE_VERBS.has((verb ?? 'open').trim().toLowerCase());
        if (PROTOCOL.test(typed))
        {
            // A URL opens with its scheme's class; only an address the
            // browser takes is opened without one.
            return openAssociated(typed, verb, parameters)
                ?? (ADDRESS.test(typed) && runnable ? openDocument(typed, parameters) : null)
                ?? { answer: SE_ERR_NOASSOC, record: null };
        }
        const placed = inDirectory(typed, (directory ?? '').trim());
        if (placed !== typed)
        {
            return start(verb, placed, parameters, directory);
        }
        const link = extensionOf(typed) === 'lnk' && runnable ? targetOfLink(typed) : null;
        if (link !== null)
        {
            // A shortcut is opened as its target, with its own arguments and
            // then the caller's (Wine's test_lnks).
            const extra = (parameters ?? '').trim();
            return start(verb, link.target,
                [link.arguments.trim(), extra].filter(Boolean).join(' '),
                directory ?? link.workingDirectory);
        }
        // A name with no extension is looked for as a program, as the shell
        // searches with ".exe" as the default extension: `msiexec` is
        // msiexec.exe.
        const name = typed !== '' && extensionOf(typed) === '' && !/[\\/]$/.test(typed)
            ? `${typed}.exe` : typed;
        if (name === '')
        {
            // Nothing was named, which is also what a build with no string
            // reader can tell about any name.
            return { answer: SE_ERR_ACCESSDENIED, record: null };
        }
        const wanted = (verb ?? 'open').trim().toLowerCase();
        if (!RUNNABLE_VERBS.has(wanted) || !SELF_EXECUTABLE.has(extensionOf(name)))
        {
            const associated = openAssociated(name, verb, parameters);
            if (associated)
            {
                return associated;
            }
        }
        if (RUNNABLE_VERBS.has(wanted) && !SELF_EXECUTABLE.has(extensionOf(name)))
        {
            const document = openDocument(name, parameters);
            if (document)
            {
                return document;
            }
        }
        if (!RUNNABLE_VERBS.has(wanted) || !SELF_EXECUTABLE.has(extensionOf(name)))
        {
            // A verb is a handler, and a document is a handler: neither is
            // registered for this file, which has to be there to be told so.
            const volume = readableVolume();
            return { answer: volume && programOf(name) === null ? SE_ERR_FNF : SE_ERR_NOASSOC,
                record: null };
        }
        if (!host.launcher)
        {
            // A build with nothing behind it that can start a program. Told no
            // rather than told there was nothing to open it with, because the
            // file is exactly the kind the shell runs itself.
            return { answer: SE_ERR_ACCESSDENIED, record: null };
        }
        const image = host.launcher.imageOf(programOf(name) ?? '');
        if (image === null)
        {
            return { answer: SE_ERR_FNF, record: null };
        }
        if (wanted === 'runas')
        {
            host.divergence?.('ShellExecute',
                `"runas" starts ${image} without asking: one user, one volume it owns`);
        }
        const asked = (directory ?? '').trim();
        if (asked !== '')
        {
            host.divergence?.('ShellExecute',
                `the child starts in its own image's directory, not in ${asked}`);
        }
        const tail = (parameters ?? '').trim();
        const record = launch(image, tail === '' ? `"${image}"` : `"${image}" ${tail}`);
        return record
            ? { answer: LAUNCH_SUCCESS, record }
            : { answer: SE_ERR_FNF, record: null };
    };

    /**
     * The program a name is, looked for where the shell looks: the current
     * directory, then the system directories -- not the caller's own, and
     * not split into a program and its arguments, which a file name never is
     * (Wine's test_exes). The name itself in a build with no volume to look in.
     *
     * @param {string} name
     * @returns {string | null}
     */
    const programOf = name=>{
        const volume = readableVolume();
        if (!volume)
        {
            return name;
        }
        const found = locate(volume, fullPath(name, ''))
            ?? (isQualified(name) ? null : locate(volume, name));
        if (found !== null || isQualified(name) || !host.launcher)
        {
            return found;
        }
        // A program of the system's own is in its directory without a file
        // on the volume.
        const launcher = host.launcher;
        return [folderOf(CSIDL_SYSTEM), folderOf(CSIDL_WINDOWS)]
            .map(folder=>(folder === null ? null : `${folder.replace(/[\\/]+$/, '')}\\${name}`))
            .find(candidate=>candidate !== null && launcher.imageOf(candidate) !== null) ?? null;
    };

    /**
     * Where a relative name is when a directory is asked for: the shell looks
     * there before anywhere else (Wine's test_directory). The name as it is
     * when the directory does not have it, as a program or as it is spelled.
     *
     * @param {string} name @param {string} directory
     */
    const inDirectory = (name, directory)=>{
        const volume = readableVolume();
        if (directory === '' || name === '' || isQualified(name) || !volume)
        {
            return name;
        }
        const joined = fullPath(name, directory);
        const candidates = extensionOf(joined) === '' ? [joined, `${joined}.exe`] : [joined];
        return candidates.find(candidate=>volume.stat(candidate)?.exists
            && !volume.stat(candidate)?.isDirectory) ?? name;
    };

    /**
     * A string with the caller's environment variables put in, as
     * SEE_MASK_DOENVSUBST asks for; a name that is no variable stays as it is.
     *
     * @param {string | null} text
     */
    const substitute = text=>{
        const variables = text?.includes('%') ? environment() : null;
        if (text === null || !variables)
        {
            return text;
        }
        const named = new Map(Object.entries(variables)
            .map(([name, value])=>[name.toUpperCase(), value]));
        return text.replace(/%([^%]+)%/g, (whole, name)=>named.get(name.toUpperCase()) ?? whole);
    };

    /**
     * The calling process's variables, as kernel32 has them now: what a child
     * the shell starts inherits, as one CreateProcess starts does. Null
     * without kernel32 to ask, and the child is then given the spawner's own.
     *
     * @returns {Record<string, string> | null}
     */
    const environment = ()=>{
        const kernel32 = host.library?.('KERNEL32.dll');
        const read = host.readMemory;
        const block = kernel32 && read
            ? /** @type {number} */ (kernel32.GetEnvironmentStringsW?.handler([])) >>> 0 : 0;
        if (!block || !read || !kernel32)
        {
            return null;
        }
        /** @type {Record<string, string>} */
        const variables = {};
        let at = block;
        for (let count = 0; count < 0x8000; count++)
        {
            let entry = '';
            for (let pair = read(at, 2); (pair[0] | pair[1]) !== 0; pair = read(at, 2))
            {
                entry += String.fromCharCode(pair[0] | pair[1] << 8);
                at += 2;
            }
            at += 2;
            if (entry === '')
            {
                break;
            }
            // A drive's current directory is "=C:=C:\dir": its name starts with the equals.
            const split = entry.indexOf('=', 1);
            if (split > 0)
            {
                variables[entry.slice(0, split)] = entry.slice(split + 1);
            }
        }
        kernel32.FreeEnvironmentStringsW?.handler([block]);
        return variables;
    };

    /**
     * A child started as the shell starts one: the caller's variables its own.
     *
     * @param {string} image @param {string} line
     */
    const launch = (image, line)=>{
        const variables = environment();
        return host.launcher?.launch(image, line, 0, '',
            variables ? { environment: variables } : {}) ?? null;
    };

    /**
     * What a shortcut on the volume points at, or null when it is no
     * shortcut, or names no target.
     *
     * @param {string} name
     * @returns {{ target: string, arguments: string, workingDirectory: string | null } | null}
     */
    const targetOfLink = name=>{
        const volume = readableVolume();
        const found = volume ? locate(volume, name) : null;
        const bytes = found && volume ? readNow(volume, found) : null;
        const link = bytes ? decodeShellLink(bytes) : null;
        if (!link || !link.target)
        {
            return null;
        }
        return { target: link.target, arguments: link.arguments,
            workingDirectory: link.workingDirectory || null };
    };

    const associations = host.library && host.readMemory && host.allocate
        ? createAssociations({ readMemory: host.readMemory, writeMemory: host.writeMemory,
            allocate: host.allocate, free: host.free, library: host.library })
        : null;

    /**
     * The program a command line starts: its first word in quotes, or else
     * the shortest run of its words that names a file, as CreateProcess
     * reads an unquoted one.
     *
     * @param {string} line
     */
    const imageOfCommand = line=>{
        if (!host.launcher)
        {
            return null;
        }
        const launcher = host.launcher;
        if (line.startsWith('"'))
        {
            const end = line.indexOf('"', 1);
            return launcher.imageOf(end < 0 ? line.slice(1) : line.slice(1, end));
        }
        const words = line.split(' ');
        for (let count = 1; count <= words.length; count++)
        {
            const image = launcher.imageOf(words.slice(0, count).join(' '));
            if (image !== null)
            {
                return image;
            }
        }
        return null;
    };

    /**
     * A file opened with what its type is registered to: the verb's command
     * under its class, filled in with the file and the parameters
     * (`argify`); a command that does not name the file is run without it,
     * as Windows runs it. Null when the type, or the verb, has no command.
     *
     * @param {string} name @param {string | null} verb @param {string | null} parameters
     * @param {string | null} [given]  The class SEE_MASK_CLASSNAME names, over the file's.
     * @returns {{ answer: number, record: any } | null}
     */
    const openAssociated = (name, verb, parameters, given = null)=>{
        const protocol = given === null
            ? /^([A-Za-z][A-Za-z0-9+.-]+):/.exec(name)?.[1] ?? null : null;
        const extension = extensionOf(name);
        // A class named as an extension is the class that extension names.
        const named = (given?.startsWith('.') ? associations?.classOf(given) : given) ?? protocol
            ?? (extension === '' ? null : associations?.classOf(`.${extension}`));
        // A scheme is a class that says it is one (Wine's test_urls).
        const command = named && (protocol === null || associations?.isProtocol(protocol))
            ? associations?.commandOf(named, verb) : null;
        if (!command)
        {
            return null;
        }
        const volume = readableVolume();
        const found = protocol || !volume ? name : locate(volume, name);
        if (found === null)
        {
            return { answer: SE_ERR_FNF, record: null };
        }
        const file = protocol ? name : host.resolve?.(found) ?? found;
        const template = command.value;
        const line = argify(template, file, parameters ?? '');
        const image = imageOfCommand(line.trim());
        if (image === null || !host.launcher)
        {
            return { answer: SE_ERR_FNF, record: null };
        }
        const record = launch(image, line);
        return record ? { answer: LAUNCH_SUCCESS, record } : { answer: SE_ERR_FNF, record: null };
    };

    /**
     * A small file's bytes when the volume has them at hand -- a shortcut a
     * setup just wrote -- or null for one still to be fetched.
     *
     * @param {import('./icons.js').IconVolume} volume @param {string} path
     * @returns {Uint8Array | null}
     */
    const readNow = (volume, path)=>{
        const node = volume.open(path, { read: true });
        if (!node)
        {
            return null;
        }
        try
        {
            const bytes = volume.read(node, 0, volume.stat(path)?.size ?? 0);
            return bytes instanceof Uint8Array ? bytes : null;
        }
        finally
        {
            volume.close(node);
        }
    };

    /**
     * A document the shell opens with the program its type is registered to,
     * as Windows XP has them: text in Notepad, an address -- an http, ftp or
     * mailto link, or a .url shortcut's -- in the browser, which here is
     * whoever is in front of the run. Null for any other document, which has
     * no handler on this machine.
     *
     * @param {string} name @param {string | null} parameters
     * @returns {{ answer: number, record: any } | null}
     */
    const openDocument = (name, parameters)=>{
        const extension = extensionOf(name);
        if (ADDRESS.test(name) || extension === 'url')
        {
            const volume = readableVolume();
            const found = extension === 'url' && volume ? locate(volume, name) : null;
            const bytes = found && volume ? readNow(volume, found) : null;
            const url = ADDRESS.test(name) ? name : bytes ? urlOfShortcut(decodeAnsi(bytes)) : null;
            if (url === null)
            {
                return extension === 'url' ? { answer: SE_ERR_FNF, record: null } : null;
            }
            if (!host.openUrl?.(url))
            {
                host.divergence?.('ShellExecute', `${url} is not opened: there is no browser`);
                return { answer: SE_ERR_NOASSOC, record: null };
            }
            return { answer: LAUNCH_SUCCESS, record: null };
        }
        if (!TEXT_DOCUMENTS.has(extension) || !host.launcher)
        {
            return null;
        }
        const notepad = host.launcher.imageOf(NOTEPAD);
        if (notepad === null)
        {
            return null;
        }
        const file = host.launcher.imageOf(name);
        if (file === null)
        {
            return { answer: SE_ERR_FNF, record: null };
        }
        void parameters;
        const record = launch(notepad, `${notepad} ${file}`);
        return record ? { answer: LAUNCH_SUCCESS, record } : { answer: SE_ERR_FNF, record: null };
    };

    /**
     * ShellExecute, for either spelling of its strings.
     *
     * @param {boolean} wide
     */
    const shellExecute = wide=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [, operation, file, parameters, directory])=>start(
            textOf(operation, wide), textOf(file, wide),
            textOf(parameters, wide), textOf(directory, wide)).answer,
    });

    /**
     * ShellExecuteEx, for either spelling of the record: SHELLEXECUTEINFOW is
     * SHELLEXECUTEINFOA field for field, its strings pointers to wide ones.
     *
     * @param {boolean} wide
     */
    const shellExecuteEx = wide=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [info])=>{
            const at = info >>> 0;
            if (at === 0)
            {
                return 0;
            }
            const mask = dwordAt(at, SEI_MASK);
            /** @param {number} offset */
            const field = offset=>textOf(dwordAt(at, offset), wide);
            const expanded = (mask & SEE_MASK_DOENVSUBST) !== 0 ? substitute : (/** @type {string | null} */ text)=>text;
            // A class asked for and not named is no class to open with.
            const given = (mask & SEE_MASK_CLASSNAME) !== 0 ? field(SEI_CLASS) : null;
            const started = (mask & SEE_MASK_IDLIST) !== 0
                || ((mask & SEE_MASK_CLASSNAME) !== 0 && !given)
                ? { answer: SE_ERR_NOASSOC, record: null }
                : start(field(SEI_VERB), expanded(field(SEI_FILE)), field(SEI_PARAMETERS),
                    expanded(field(SEI_DIRECTORY)), given);
            host.writeMemory(at + SHELLEXECUTEINFO_HINSTAPP, dword(started.answer));
            if ((mask & SEE_MASK_NOCLOSEPROCESS) !== 0)
            {
                host.writeMemory(at + SHELLEXECUTEINFO_PROCESS,
                    dword(started.record?.handle ?? 0));
            }
            return started.answer === LAUNCH_SUCCESS ? 1 : 0;
        },
    });

    /**
     * SHGetPathFromIDList, for either spelling of the buffer.
     *
     * @param {boolean} wide
     */
    const pathFromList = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [list, path])=>{
            const found = pathOf(list >>> 0);
            (wide ? writeWidePath : writePath)(path >>> 0, found ?? '');
            return found === null ? 0 : 1;
        },
    });

    /**
     * The volume as reading a file needs it, or null in a build without one.
     *
     * @returns {import('./icons.js').IconVolume | null}
     */
    const readableVolume = ()=>{
        const volume = /** @type {any} */ (host.volume);
        return volume && ['stat', 'open', 'read', 'close']
            .every(name=>typeof volume[name] === 'function')
            ? /** @type {import('./icons.js').IconVolume} */ (volume) : null;
    };

    /**
     * Where a file a program named by itself is: a qualified name is where it
     * says, and a bare or relative one is looked for in the current
     * directory, then the system directory, then the Windows directory --
     * which is where a program finds the shell's own libraries by name.
     *
     * @param {import('./icons.js').IconVolume} volume @param {string} name
     * @returns {string | null}
     */
    const locate = (volume, name)=>{
        const candidates = [name];
        if (!isQualified(name))
        {
            for (const folder of [folderOf(CSIDL_SYSTEM), folderOf(CSIDL_WINDOWS)])
            {
                if (folder !== null)
                {
                    candidates.push(`${folder.replace(/[\\/]+$/, '')}\\${name}`);
                }
            }
        }
        return candidates.find(candidate=>volume.stat(candidate)?.exists) ?? null;
    };

    /**
     * ExtractIcon, for either spelling of the file name. The instance names
     * the caller, which plays no part in which file is read.
     *
     * @param {boolean} wide
     */
    const extractIcon = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [, file, index])=>{
            const name = (textOf(file, wide) ?? '').trim();
            const volume = readableVolume();
            const path = name === '' || !volume ? null : locate(volume, name);
            if (path === null || !volume)
            {
                return 0;
            }
            const wanted = index | 0;
            /** @param {import('./icons.js').FileIcons} found */
            const answer = found=>{
                if (found.unread !== null)
                {
                    host.divergence?.('ExtractIcon',
                        `${path} is ${found.unread}, whose icons are not read`);
                }
                if (wanted === -1)
                {
                    return found.count;
                }
                if (found.picture === null)
                {
                    return 0;
                }
                if (!host.icon)
                {
                    host.divergence?.('ExtractIcon',
                        'no icon can be made here: the icon in the file is not handed out');
                    return 0;
                }
                return host.icon(found.picture);
            };
            const found = readFileIcons(volume, path, wanted);
            return found instanceof Promise ? found.then(answer) : answer(found);
        },
    });

    /**
     * SHPathPrepareForWrite, for either spelling of the path: whether the
     * directory a program is about to write into is there, and with
     * SHPPFW_DIRCREATE every directory of a full path made that is not. With
     * SHPPFW_IGNOREFILENAME the last name is the file to be written, and only
     * the directory above it is looked at; a bare file name is in the current
     * directory, which is always there.
     *
     * @param {boolean} wide
     */
    const prepareForWrite = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [, , path, flags])=>{
            const named = textOf(path, wide);
            if (named === null)
            {
                return E_INVALIDARG;
            }
            let directory = named.trim().replace(/\//g, '\\');
            if ((flags & SHPPFW_IGNOREFILENAME) !== 0)
            {
                directory = directory.slice(0, directory.lastIndexOf('\\') + 1);
            }
            // A directory's trailing separator is not part of its name, except
            // the root's.
            directory = directory.replace(/([^:\\])\\+$/, '$1');
            if (directory === '')
            {
                return S_OK;
            }
            const full = fullPath(directory, '');
            const volume = fileVolume();
            const entry = volume?.stat(full) ?? null;
            if (entry)
            {
                return entry.isDirectory ? S_OK : fromWin32(ERROR_DIRECTORY);
            }
            // A relative path is looked for but never made: Windows reports
            // it missing whatever the flags, as Wine's conformance test has it.
            const whole = /^[A-Za-z]:\\/.test(directory) || directory.startsWith('\\\\');
            if (!volume || !whole || (flags & (SHPPFW_DIRCREATE | SHPPFW_ASKDIRCREATE)) === 0)
            {
                return fromWin32(ERROR_PATH_NOT_FOUND);
            }
            if ((flags & SHPPFW_DIRCREATE) === 0)
            {
                host.divergence?.('SHPathPrepareForWrite',
                    `${full} is made without asking: there is nobody to ask`);
            }
            return fromWin32(createDirectoryPath({ volume }, full));
        },
    });

    /**
     * LPWSTR *CommandLineToArgvW(LPCWSTR lpCmdLine, int *pNumArgs)
     *
     * The arguments (`commandline.js`) in one block: the array of pointers,
     * ended by a null one, and the strings after it, so that the LocalFree
     * the caller is documented to call frees all of it. An empty line is the
     * program's own path alone, which is what GetModuleFileName answers.
     */
    const commandLineToArgv = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [line, count])=>{
            /** @param {number} code */
            const fail = code=>{
                host.setLastError?.(code);
                return 0;
            };
            const text = wideStringOf(line, MAX_COMMAND_LINE);
            if (text === null || (count >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if (text === '' && !host.imagePath)
            {
                host.divergence?.('CommandLineToArgvW',
                    'the program\'s path is not known: an empty line answers an empty argv[0]');
            }
            const args = text === '' ? [host.imagePath?.() ?? ''] : splitCommandLine(text);
            const pointers = (args.length + 1) * 4;
            const size = args.reduce((total, arg)=>total + (arg.length + 1) * 2, pointers);
            const block = host.allocate?.(size) ?? 0;
            if (block === 0)
            {
                return fail(ERROR_NOT_ENOUGH_MEMORY);
            }
            const bytes = new Uint8Array(size);
            const view = new DataView(bytes.buffer);
            let at = pointers;
            args.forEach((arg, index)=>{
                view.setUint32(index * 4, block + at, true);
                for (let unit = 0; unit < arg.length; unit++)
                {
                    view.setUint16(at + unit * 2, arg.charCodeAt(unit), true);
                }
                at += (arg.length + 1) * 2;
            });
            host.writeMemory(block, bytes);
            host.writeMemory(count >>> 0, dword(args.length));
            return block;
        },
    };

    /**
     * FindExecutable, for either spelling of its strings.
     *
     * @param {boolean} wide
     */
    const findExecutable = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [file, directory, result])=>{
            const name = textOf(file, wide);
            const write = wide ? writeWidePath : writePath;
            // A text document's program is Notepad, as the registry has it:
            // a setup asks this before it starts the program on its readme.
            if (name !== null && TEXT_DOCUMENTS.has(extensionOf(name)) && host.launcher
                && host.launcher.imageOf(NOTEPAD) !== null)
            {
                if (host.launcher.imageOf(name) === null)
                {
                    write(result >>> 0, '');
                    return SE_ERR_FNF;
                }
                write(result >>> 0, NOTEPAD);
                return LAUNCH_SUCCESS;
            }
            const volume = readableVolume();
            if (name === null || !host.resolve || !volume)
            {
                write(result >>> 0, '');
                return SE_ERR_NOASSOC;
            }
            // The file is found before its type is asked about: in the
            // directory given, else where the shell looks for a program; a
            // file: URL is no file's name here (Wine's test_fileurls).
            const spelled = withoutTrailingDots(unquote(name.trim()));
            const placed = inDirectory(spelled, (textOf(directory, wide) ?? '').trim());
            const found = placed !== spelled ? placed : programOf(spelled);
            if (found === null || volume.stat(found)?.isDirectory)
            {
                write(result >>> 0, '');
                return found === null ? SE_ERR_FNF : SE_ERR_NOASSOC;
            }
            const extension = extensionOf(found);
            if (SELF_EXECUTABLE.has(extension))
            {
                write(result >>> 0, host.resolve(found));
                return LAUNCH_SUCCESS;
            }
            const named = extension === '' ? null : associations?.classOf(`.${extension}`);
            const command = named ? associations?.commandOf(named, null) : null;
            const image = command
                ? imageOfCommand(argify(command.value, host.resolve(found), '').trim()) : null;
            write(result >>> 0, image ?? '');
            return image === null ? SE_ERR_NOASSOC : LAUNCH_SUCCESS;
        },
    });

    /**
     * ExtractIconEx, for either spelling of the file name: up to nIcons icons
     * from nIconIndex on, each at the large size into one array and the
     * small into the other, either array optional. With both arrays absent
     * and an index of -1 it is how many icons the file has; otherwise how
     * many icons were handed out, a pair of sizes counting once. An index
     * below -1 is a resource id and names one icon.
     *
     * @param {boolean} wide
     */
    const extractIconEx = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [file, index, large, small, count])=>{
            const name = (textOf(file, wide) ?? '').trim();
            const volume = readableVolume();
            const path = name === '' || !volume ? null : locate(volume, name);
            if (path === null || !volume)
            {
                return 0;
            }
            const first = index | 0;
            if (first === -1 && (large >>> 0) === 0 && (small >>> 0) === 0)
            {
                return after(readFileIcons(volume, path, -1), found=>found.count);
            }
            const wanted = first < -1 ? Math.min(1, count >>> 0)
                : Math.min(count >>> 0, MAX_EXTRACTED);
            const arrays = /** @type {[number, number][]} */ ([[large >>> 0, LARGE_ICON],
                [small >>> 0, SMALL_ICON]]).filter(([array])=>array !== 0);
            if (!host.icon)
            {
                host.divergence?.('ExtractIconEx',
                    'no icon can be made here: the icons in the file are not handed out');
                return 0;
            }
            const make = /** @type {NonNullable<ShellHost['icon']>} */ (host.icon);
            /**
             * @param {number} n @param {number} made
             * @returns {number | Promise<number>}
             */
            const extract = (n, made)=>{
                if (n >= wanted)
                {
                    return made;
                }
                /**
                 * @param {number} which
                 * @returns {boolean | Promise<boolean>} whether either size was made
                 */
                const sizes = which=>{
                    if (which >= arrays.length)
                    {
                        return false;
                    }
                    const [array, side] = arrays[which];
                    return after(readFileIcons(volume, path, first < -1 ? first : first + n,
                        side), found=>{
                        const handle = found.picture ? make(found.picture) : 0;
                        host.writeMemory(array + n * 4, dword(handle));
                        return after(sizes(which + 1), rest=>handle !== 0 || rest);
                    });
                };
                return after(sizes(0), got=>(got ? extract(n + 1, made + 1) : made));
            };
            return extract(0, 0);
        },
    });

    /**
     * ExtractAssociatedIconEx, for either spelling of the path: the icon the
     * file itself carries at the index the caller holds, and its resource id
     * through piIconId. A file with no icon of its own would be given its
     * handler's, or a stock icon of the shell's, and neither the association
     * registry nor the shell's own icons are here: NULL, the call's failure.
     *
     * @param {boolean} wide
     */
    const extractAssociatedIconEx = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [, file, indexAt, idAt])=>{
            const name = (textOf(file, wide) ?? '').trim();
            const volume = readableVolume();
            const path = name === '' || !volume ? null : locate(volume, name);
            if (path === null || !volume || (indexAt >>> 0) === 0 || !host.readMemory)
            {
                return 0;
            }
            const held = host.readMemory(indexAt >>> 0, 2);
            const index = held[0] | held[1] << 8;
            return after(readFileIcons(volume, path, index), found=>{
                if (!found.picture || !host.icon)
                {
                    host.divergence?.('ExtractAssociatedIconEx',
                        `${path} has no icon ${index} of its own, and no handler's or stock `
                        + 'icon is here to give: NULL');
                    return 0;
                }
                if ((idAt >>> 0) !== 0)
                {
                    const id = found.id ?? 0;
                    host.writeMemory(idAt >>> 0, Uint8Array.of(id & 0xff, id >>> 8 & 0xff));
                }
                return host.icon(found.picture);
            });
        },
    });

    /**
     * SHGetDataFromIDList, for either spelling of WIN32_FIND_DATA: what a
     * list's last item names, read from the volume. SHGDFIL_FINDDATA fills
     * the find data -- attributes, the write time as all three times, the
     * size and the name, no short name -- and SHGDFIL_DESCRIPTIONID says
     * whether it is a file, a directory or a fixed drive's root. An item that
     * is no path -- the computer -- and SHGDFIL_NETRESOURCE, there being no
     * network item, are E_INVALIDARG, as is a buffer smaller than the
     * structure; an item no longer on the volume is E_FAIL.
     *
     * @param {boolean} wide
     */
    const dataFromList = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [, list, format, out, size])=>{
            const path = pathOf(list >>> 0);
            const needed = (format | 0) === SHGDFIL_FINDDATA
                ? wide ? WIN32_FIND_DATAW_SIZE : WIN32_FIND_DATAA.SIZE
                : (format | 0) === SHGDFIL_DESCRIPTIONID ? SHDESCRIPTIONID_SIZE : 0;
            if (path === null || needed === 0 || (out >>> 0) === 0 || (size | 0) < needed)
            {
                return E_INVALIDARG;
            }
            const entry = /** @type {any} */ (host.volume)?.stat(path) ?? null;
            if (!entry)
            {
                return E_FAIL;
            }
            const bytes = new Uint8Array(needed);
            const view = new DataView(bytes.buffer);
            if ((format | 0) === SHGDFIL_DESCRIPTIONID)
            {
                view.setUint32(0, /^[A-Za-z]:\\$/.test(path) ? SHDID_COMPUTER_FIXED
                    : entry.isDirectory ? SHDID_FS_DIRECTORY : SHDID_FS_FILE, true);
                host.writeMemory(out >>> 0, bytes);
                return S_OK;
            }
            view.setUint32(WIN32_FIND_DATAA.dwFileAttributes, fileAttributes(entry), true);
            const time = msToFileTime(entry.modified ?? 0);
            view.setBigUint64(WIN32_FIND_DATAA.ftCreationTime, time, true);
            view.setBigUint64(WIN32_FIND_DATAA.ftLastAccessTime, time, true);
            view.setBigUint64(WIN32_FIND_DATAA.ftLastWriteTime, time, true);
            const length = entry.size ?? 0;
            view.setUint32(WIN32_FIND_DATAA.nFileSizeHigh, Math.floor(length / 0x100000000), true);
            view.setUint32(WIN32_FIND_DATAA.nFileSizeLow, length >>> 0, true);
            const name = (path.replace(/\\+$/, '').split('\\').pop() ?? '')
                .slice(0, MAX_PATH - 1);
            if (wide)
            {
                for (let at = 0; at < name.length; at++)
                {
                    view.setUint16(WIN32_FIND_DATAA.cFileName + at * 2, name.charCodeAt(at), true);
                }
            }
            else
            {
                bytes.set(encodeAnsi(name), WIN32_FIND_DATAA.cFileName);
            }
            host.writeMemory(out >>> 0, bytes);
            return S_OK;
        },
    });

    const table = {
        /**
         * HINSTANCE ShellExecuteA(HWND, LPCSTR lpOperation, LPCSTR lpFile,
         *                         LPCSTR lpParameters, LPCSTR lpDirectory,
         *                         INT nShowCmd)
         *
         * An executable is started, through the same machinery CreateProcess
         * uses: the file is its own handler, so the launch needs none of the
         * registry the shell would otherwise consult. A document is refused as
         * having no association, and so is a verb that is not one of the
         * runnable ones -- `edit`, `print` and `explore` each name a handler
         * that would have to be looked up.
         *
         * The window is not made the child's owner and nShowCmd is not carried:
         * how a program first shows its window is its own business once it runs,
         * which is what kernel32's WinExec does with the same argument.
         *
         * HINSTANCE ShellExecuteW(HWND, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, INT)
         */
        ShellExecuteA: shellExecute(false),
        ShellExecuteW: shellExecute(true),

        /**
         * HINSTANCE FindExecutableA(LPCSTR lpFile, LPCSTR lpDirectory,
         *                           LPSTR lpResult)
         *
         * An executable is associated with itself -- the shell runs it directly
         * and needs no handler registry for it -- so a file whose extension is
         * one of those resolves to its qualified path and succeeds. Anything
         * else is a document whose handler would come from an association
         * registry this build does not have; that is reported as no association
         * rather than guessed at. Either way the buffer is written, because a
         * caller reads it whatever the return says and its own stack left there
         * would be read as a path.
         */
        FindExecutableA: findExecutable(false),
        /** HINSTANCE FindExecutableW(LPCWSTR lpFile, LPCWSTR lpDirectory, LPWSTR lpResult) */
        FindExecutableW: findExecutable(true),

        /**
         * void DragAcceptFiles(HWND hWnd, BOOL fAccept)
         *
         * The window's WS_EX_ACCEPTFILES, set or cleared, which is all the
         * call is (Wine's test_DragQueryFile reads it back); user32 keeps it.
         */
        DragAcceptFiles: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([window, accept])=>{
                const user32 = host.library?.('USER32.dll');
                const style = user32?.GetWindowLongA?.handler([window, GWL_EXSTYLE]);
                if (typeof style !== 'number')
                {
                    return 0;
                }
                const wanted = (accept | 0) !== 0 ? style | WS_EX_ACCEPTFILES
                    : style & ~WS_EX_ACCEPTFILES;
                if (wanted !== style)
                {
                    user32?.SetWindowLongA?.handler([window, GWL_EXSTYLE, wanted]);
                }
                return 0;
            },
        },

        /**
         * PIDLIST_ABSOLUTE SHBrowseForFolderA(LPBROWSEINFOA lpbi)
         * PIDLIST_ABSOLUTE SHBrowseForFolderW(LPBROWSEINFOW lpbi)
         *
         * Needs a person to choose a folder. Null is what a caller checks for
         * and means the browse was cancelled, which is true.
         */
        SHBrowseForFolderA: {
            argBytes: 4,
            handler: ()=>0,
        },
        SHBrowseForFolderW: {
            argBytes: 4,
            handler: ()=>0,
        },

        /**
         * BOOL SHGetPathFromIDListA(PCIDLIST_ABSOLUTE pidl, LPSTR pszPath)
         * BOOL SHGetPathFromIDListW(PCIDLIST_ABSOLUTE pidl, LPWSTR pszPath)
         *
         * A list made here carries its path, and one the program combined
         * from several of ours ends in the item that does; the computer's
         * list, and any other -- the browse above never makes one -- has none,
         * and the buffer is cleared so a caller that reads it regardless reads
         * an empty path.
         */
        SHGetPathFromIDListA: pathFromList(false),
        SHGetPathFromIDListW: pathFromList(true),

        /**
         * HRESULT DllGetVersion(DLLVERSIONINFO *pdvi)
         *
         * The shell of Windows XP Service Pack 3, 6.0.2900.5512, on the NT
         * platform. The caller says which structure it passed by its first
         * field -- DLLVERSIONINFO, 20 bytes, or DLLVERSIONINFO2, 32, which adds
         * flags and the version as one 64-bit number -- and any other size is
         * refused.
         */
        DllGetVersion: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([info])=>{
                if ((info >>> 0) === 0 || !host.readMemory)
                {
                    return E_INVALIDARG;
                }
                const head = host.readMemory(info >>> 0, 4);
                const size = (head[0] | head[1] << 8 | head[2] << 16 | head[3] << 24) >>> 0;
                if (size !== 20 && size !== 32)
                {
                    return E_INVALIDARG;
                }
                const fields = new DataView(new ArrayBuffer(size - 4));
                fields.setUint32(0, 6, true);
                fields.setUint32(4, 0, true);
                fields.setUint32(8, 2900, true);
                fields.setUint32(12, 2, true);
                if (size === 32)
                {
                    fields.setUint32(20, (2900 << 16 | 5512) >>> 0, true);
                    fields.setUint32(24, 6 << 16, true);
                }
                host.writeMemory((info >>> 0) + 4, new Uint8Array(fields.buffer));
                return S_OK;
            },
        },

        /**
         * BOOL SHGetSpecialFolderPathA(HWND, LPSTR pszPath, int csidl, BOOL fCreate)
         *
         * The folder is not made on the volume: a program that asks to create
         * it goes on to write into it, and the write makes it then.
         */
        SHGetSpecialFolderPathA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, path, csidl])=>{
                const folder = folderOf(csidl | 0);
                writePath(path >>> 0, folder ?? '');
                return folder === null ? 0 : 1;
            },
        },

        /** BOOL SHGetSpecialFolderPathW(HWND, LPWSTR pszPath, int csidl, BOOL fCreate) */
        SHGetSpecialFolderPathW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, path, csidl])=>{
                const folder = folderOf(csidl | 0);
                writeWidePath(path >>> 0, folder ?? '');
                return folder === null ? 0 : 1;
            },
        },

        /**
         * HRESULT SHGetFolderPathA(HWND, int csidl, HANDLE hToken, DWORD dwFlags,
         *                          LPSTR pszPath)
         *
         * The later spelling of the same question; the token is the caller's
         * own, which is the only one there is.
         */
        SHGetFolderPathA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, csidl, , , path])=>{
                const folder = folderOf(csidl | 0);
                writePath(path >>> 0, folder ?? '');
                return folder === null ? E_INVALIDARG : S_OK;
            },
        },

        /** HRESULT SHGetFolderPathW(HWND, int csidl, HANDLE, DWORD, LPWSTR) */
        SHGetFolderPathW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, csidl, , , path])=>{
                const folder = folderOf(csidl | 0);
                writeWidePath(path >>> 0, folder ?? '');
                return folder === null ? E_INVALIDARG : S_OK;
            },
        },

        /**
         * HRESULT SHGetMalloc(IMalloc **ppMalloc)
         *
         * The task allocator, the same object CoGetMalloc hands out. A
         * program takes it at start-up and releases it on the way out
         * without looking at the HRESULT, so a refusal here is a call
         * through whatever a null pointer's vtable holds; without an
         * allocator to give, null is still written so that the failure is
         * one a caller can see.
         */
        SHGetMalloc: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const pointer = host.taskAllocator?.pointer() ?? 0;
                host.writeMemory(out >>> 0, dword(pointer));
                return pointer === 0 ? E_NOTIMPL : S_OK;
            },
        },

        /**
         * BOOL ShellExecuteExA(SHELLEXECUTEINFOA *pExecInfo)
         * BOOL ShellExecuteExW(SHELLEXECUTEINFOW *pExecInfo)
         *
         * The same launch, read out of a record and answered into it: hInstApp
         * carries what ShellExecute would have returned, and the BOOL says only
         * whether that was a success. A caller that asked to keep the process
         * open gets the handle on the child, which is what it then waits on.
         *
         * A record naming something other than a file -- an item id list, a
         * class -- is refused, because neither is a path, and it is refused
         * rather than read as one. A record that cannot be read at all names no
         * file, which is the access refusal a caller of this one already reads.
         */
        ShellExecuteExA: shellExecuteEx(false),
        ShellExecuteExW: shellExecuteEx(true),

        /**
         * int SHFileOperationA(LPSHFILEOPSTRUCTA lpFileOp)
         * int SHFileOperationW(LPSHFILEOPSTRUCTW lpFileOp)
         *
         * A copy, move, rename or delete of a list of files, on the volume.
         * A build with no volume to work on refuses it as not implemented and
         * says nothing it asked for was done. The undecorated name is the
         * ANSI one, as shell32.dll exports it.
         */
        SHFileOperation: fileOperation(false),
        SHFileOperationA: fileOperation(false),
        SHFileOperationW: fileOperation(true),

        /**
         * int SHCreateDirectoryExA(HWND hwnd, LPCSTR pszPath,
         *                          const SECURITY_ATTRIBUTES *psa)
         * int SHCreateDirectoryExW(HWND, LPCWSTR, const SECURITY_ATTRIBUTES *)
         *
         * Every directory of a full path that is not there yet.
         */
        SHCreateDirectoryExA: createDirectory(false),
        SHCreateDirectoryExW: createDirectory(true),

        /**
         * int SHCreateDirectory(HWND hwnd, LPCWSTR pszPath)
         *
         * The same, with no security attributes, and exported by number
         * alone (SHELL32_ORDINALS).
         */
        SHCreateDirectory: createDirectory(true, 8),

        /**
         * void SHChangeNotify(LONG wEventId, UINT uFlags, LPCVOID dwItem1, LPCVOID dwItem2)
         *
         * Tells the shell a file or a folder changed so its windows repaint.
         * There are no shell windows; the notice has nobody to reach.
         */
        SHChangeNotify: {
            argBytes: 16,
            handler: ()=>0,
        },

        /**
         * BOOL Shell_NotifyIconA(DWORD dwMessage, NOTIFYICONDATAA *lpData)
         * BOOL Shell_NotifyIconW(DWORD dwMessage, NOTIFYICONDATAW *lpData)
         *
         * The notification area's icons, each named by its window and id,
         * which both spellings of the record keep after its size -- a size
         * that is wrong still names the icon (Wine's test_cbsize). An icon is
         * added once and modified or deleted while it is there; deleting one
         * that is not fails with E_FAIL as the last error. Nothing draws them:
         * there is no taskbar to show them on.
         */
        Shell_NotifyIconA: notifyIcon,
        Shell_NotifyIconW: notifyIcon,

        /**
         * DWORD_PTR SHGetFileInfoA(LPCSTR pszPath, DWORD dwFileAttributes,
         *                          SHFILEINFOA *psfi, UINT cbFileInfo, UINT uFlags)
         * DWORD_PTR SHGetFileInfoW(LPCWSTR pszPath, DWORD dwFileAttributes,
         *                          SHFILEINFOW *psfi, UINT cbFileInfo, UINT uFlags)
         *
         * Icons, type names and display names come from the shell's namespace,
         * which this build does not have. Zero is failure, and the record is
         * left as the caller filled it -- in either spelling, so the two
         * layouts, whose names are twice as wide in the second, are not
         * written at all.
         */
        SHGetFileInfoA: {
            argBytes: 20,
            handler: ()=>0,
        },
        SHGetFileInfoW: {
            argBytes: 20,
            handler: ()=>0,
        },

        /**
         * HICON ExtractIconA(HINSTANCE hInst, LPCSTR pszExeFileName, UINT nIconIndex)
         * HICON ExtractIconW(HINSTANCE hInst, LPCWSTR pszExeFileName, UINT nIconIndex)
         *
         * An icon a file carries (`icons.js`), as an icon handle the caller
         * destroys. An index of 0xFFFFFFFF asks how many there are: an
         * executable's or a library's icon groups, or one for an icon file.
         * A file with none, a file that is not there, and an index past the
         * last all answer NULL, as Wine's conformance test has Windows answer
         * them -- the 1 the documentation promises for a file that is not an
         * image is not what Windows returns.
         */
        ExtractIconA: extractIcon(false),
        ExtractIconW: extractIcon(true),

        CommandLineToArgvW: commandLineToArgv,

        /**
         * HRESULT SHPathPrepareForWriteA(HWND hwnd, IUnknown *punkEnableModless,
         *                                LPCSTR pszPath, DWORD dwFlags)
         * HRESULT SHPathPrepareForWriteW(HWND, IUnknown *, LPCWSTR, DWORD)
         *
         * S_OK for a directory that is there; a file where the directory
         * should be is ERROR_DIRECTORY, and one that is not there is
         * ERROR_PATH_NOT_FOUND unless the caller asked for it to be made.
         * There is no removable medium to ask for, so the window and the
         * object whose modelessness a prompt would switch play no part.
         */
        SHPathPrepareForWriteA: prepareForWrite(false),
        SHPathPrepareForWriteW: prepareForWrite(true),

        /**
         * HRESULT SHGetSpecialFolderLocation(HWND hwnd, int csidl,
         *   LPITEMIDLIST *ppidl)
         *
         * The folders this machine has, as the registry's Shell Folders key
         * also reports them: an installer asks here for Program Files and
         * the Start Menu before it proposes a destination or writes a
         * shortcut. The list is the caller's to free with the task allocator,
         * which is the one it was made from. A folder this machine does not
         * have is E_INVALIDARG with a null where the list would go.
         */
        SHGetSpecialFolderLocation: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, csidl, out])=>{
                const virtual = ((csidl | 0) & ~CSIDL_FLAG_MASK);
                const folder = virtual === CSIDL_DRIVES ? MY_COMPUTER
                    : virtual === CSIDL_CONTROLS ? CONTROL_PANEL : folderOf(csidl | 0);
                if (folder === null)
                {
                    host.writeMemory(out >>> 0, dword(0));
                    return E_INVALIDARG;
                }
                // The desktop is the namespace's root: the empty list.
                const list = virtual === CSIDL_DESKTOP ? emptyList() : listFor(folder);
                host.writeMemory(out >>> 0, dword(list));
                return list === 0 ? E_OUTOFMEMORY : S_OK;
            },
        },

        /**
         * HRESULT SHGetDesktopFolder(IShellFolder **ppshf)
         *
         * The root of the shell namespace, which a folder browser walks: the
         * computer under it, the drives under that, the volume's directories
         * under those. Without a volume there is none: E_FAIL, and a null
         * where the interface would go, so a caller that ignores the HRESULT
         * fails on a null it can see.
         */
        SHGetDesktopFolder: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if (namespace)
                {
                    return namespace.desktop(out >>> 0);
                }
                host.writeMemory(out >>> 0, dword(0));
                host.divergence?.('SHGetDesktopFolder',
                    'no shell namespace: reports E_FAIL with a null interface');
                return E_FAIL;
            },
        },

        /**
         * UINT ExtractIconExA(LPCSTR lpszFile, int nIconIndex, HICON *phiconLarge,
         *                     HICON *phiconSmall, UINT nIcons)
         * UINT ExtractIconExW(LPCWSTR, int, HICON *, HICON *, UINT)
         */
        ExtractIconExA: extractIconEx(false),
        ExtractIconExW: extractIconEx(true),

        /**
         * HICON ExtractAssociatedIconExA(HINSTANCE hInst, LPSTR pszIconPath,
         *                                LPWORD piIconIndex, LPWORD piIconId)
         * HICON ExtractAssociatedIconExW(HINSTANCE, LPWSTR, LPWORD, LPWORD)
         */
        ExtractAssociatedIconExA: extractAssociatedIconEx(false),
        ExtractAssociatedIconExW: extractAssociatedIconEx(true),

        /**
         * HICON ExtractAssociatedIconA(HINSTANCE hInst, LPSTR pszIconPath, LPWORD piIcon)
         *
         * ExtractAssociatedIconEx without the resource id.
         */
        ExtractAssociatedIconA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([instance, path, index])=>
                extractAssociatedIconEx(false).handler([instance, path, index, 0]),
        },
        ExtractAssociatedIconW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([instance, path, index])=>
                extractAssociatedIconEx(true).handler([instance, path, index, 0]),
        },

        /**
         * HRESULT SHDefExtractIconA(LPCSTR pszIconFile, int iIndex, UINT uFlags,
         *     HICON *phiconLarge, HICON *phiconSmall, UINT nIconSize)
         *
         * ExtractIconEx's icon at the index: S_OK when there is one, S_FALSE
         * when the file has none there; nowhere to put one asks for nothing.
         */
        SHDefExtractIconA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([file, index, , large, small])=>{
                if ((large >>> 0) === 0 && (small >>> 0) === 0)
                {
                    return S_OK;
                }
                return after(extractIconEx(false).handler([file, index, large, small, 1]),
                    (/** @type {number} */ count)=>((count | 0) > 0 ? S_OK : S_FALSE));
            },
        },
        SHDefExtractIconW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([file, index, , large, small])=>{
                if ((large >>> 0) === 0 && (small >>> 0) === 0)
                {
                    return S_OK;
                }
                return after(extractIconEx(true).handler([file, index, large, small, 1]),
                    (/** @type {number} */ count)=>((count | 0) > 0 ? S_OK : S_FALSE));
            },
        },

        /**
         * HRESULT SHBindToObject(IShellFolder *psf, PCUIDLIST_RELATIVE pidl, IBindCtx *pbc,
         *                        REFIID riid, void **ppv)
         *
         * The object the list names under the folder, the desktop for none:
         * the folder's own BindToObject.
         */
        SHBindToObject: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([folder, list, , riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((folder >>> 0) === 0)
                {
                    return namespace ? namespace.bind(list, riid, out) : E_FAIL;
                }
                const read = host.readMemory;
                if (!host.drive || !read)
                {
                    host.writeMemory(out >>> 0, dword(0));
                    return E_NOTIMPL;
                }
                /** @param {number} at */
                const u32 = at=>new DataView(read(at >>> 0, 4).slice().buffer).getUint32(0, true);
                // IShellFolder::BindToObject is its fifth method after IUnknown's three.
                const entry = u32(u32(folder) + 5 * 4);
                return host.drive((function* (){
                    return yield { entry,
                        args: [folder >>> 0, list >>> 0, 0, riid >>> 0, out >>> 0] };
                })());
            },
        },

        /**
         * HRESULT SHBindToParent(PCIDLIST_ABSOLUTE pidl, REFIID riid, void **ppv,
         *                        PCUITEMID_CHILD *ppidlLast)
         *
         * The folder the list's last item is in, as IShellFolder, and a
         * pointer to that item inside the caller's own list, not a copy; an
         * empty list is the desktop and itself (Wine's shlfolder tests). No
         * list is E_INVALIDARG with a null child, as later systems answer it
         * -- this one's E_OUTOFMEMORY being the accident the tests call it.
         * Without a namespace the bind fails as SHGetDesktopFolder's does.
         */
        SHBindToParent: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([list, riid, out, last])=>{
                if ((last >>> 0) !== 0)
                {
                    host.writeMemory(last >>> 0, dword(0));
                }
                if ((out >>> 0) === 0 || (riid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, dword(0));
                if ((list >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if (!namespace)
                {
                    host.divergence?.('SHBindToParent', 'no shell namespace: E_FAIL');
                    return E_FAIL;
                }
                const bound = namespace.parent(list >>> 0, riid >>> 0, out >>> 0);
                if (bound.hr === S_OK && (last >>> 0) !== 0)
                {
                    host.writeMemory(last >>> 0, dword(bound.last));
                }
                return bound.hr;
            },
        },

        /**
         * HRESULT SHGetDataFromIDListA(IShellFolder *psf, PCUITEMID_CHILD pidl,
         *                              int nFormat, void *pv, int cb)
         * HRESULT SHGetDataFromIDListW(IShellFolder *, PCUITEMID_CHILD, int, void *, int)
         *
         * A list made here carries its whole path, so the folder it is
         * relative to plays no part.
         */
        SHGetDataFromIDListA: dataFromList(false),
        SHGetDataFromIDListW: dataFromList(true),

        /**
         * HRESULT SHGetFolderLocation(HWND hwndOwner, int nFolder, HANDLE hToken,
         *                             DWORD dwReserved, PIDLIST_ABSOLUTE *ppidl)
         *
         * SHGetSpecialFolderLocation's answer under the later name; the token
         * is the caller's own, the only one there is. The reserved word must
         * be zero.
         */
        SHGetFolderLocation: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([window, csidl, , reserved, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((reserved >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, dword(0));
                    return E_INVALIDARG;
                }
                return table.SHGetSpecialFolderLocation.handler([window, csidl, out]);
            },
        },

        ...createDesktopFunctions(host),

        ...(namespace && memory && host.publish && host.allocate ? createShellItems({
            readMemory: memory.readMemory, writeMemory: memory.writeMemory,
            readWideString: host.readWideString, allocate: host.allocate, free: host.free,
            publish: host.publish, library: host.library,
        }, namespace) : {}),

        ...(host.readMemory ? createIdListFunctions({ readMemory: host.readMemory,
            writeMemory: host.writeMemory, allocate: host.allocate, free: host.free }) : {}),
        // Without guest memory to read, every drop holds nothing: kernel32's
        // lock is not reached, and the zeros read are never asked for.
        ...createDropFunctions({
            readMemory: host.readMemory ?? ((_, length)=>new Uint8Array(length)),
            writeMemory: host.writeMemory, library: host.library }, decodeAnsi,
        text=>encodeAnsi(text)),
        ...(host.readMemory && host.readCString ? createShellExtras({
            readMemory: host.readMemory, writeMemory: host.writeMemory,
            readCString: host.readCString, readWideString: host.readWideString,
            allocate: host.allocate, free: host.free, library: host.library,
            publish: host.publish, divergence: host.divergence,
        }, {
            /** @returns {Record<string, { handler: (args: number[]) => any }>} */
            get table(){
                return /** @type {any} */ (table);
            },
            listFor,
            exists: path=>namespace?.parse(path) !== null && namespace !== null,
            parse: name=>namespace?.parse(name) ?? null,
        }) : {}),
    };
    // The real library exports the ANSI form of several calls under their
    // bare names as well, and a program that looks one up by hand may ask
    // for the bare one.
    return {
        ...table,
        SHBrowseForFolder: table.SHBrowseForFolderA,
        SHGetPathFromIDList: table.SHGetPathFromIDListA,
        DragQueryFile: table.DragQueryFileA,
        ExtractIconEx: table.ExtractIconExA,
        ShellExecuteEx: table.ShellExecuteExA,
    };
}
