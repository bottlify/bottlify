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

import { MY_COMPUTER, createShellNamespace, listBytes, pathOfList } from './namespace.js';
import { createDirectoryPath, runFileOperation } from './fileop.js';
import { readFileIcons } from './icons.js';
import { splitCommandLine } from './commandline.js';
import { createDesktopFunctions } from './desktop.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { fileAttributes, msToFileTime } from '../kernel32/filetime.js';
import { WIN32_FIND_DATAA } from '../kernel32/files.js';

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

/** E_NOTIMPL, for the allocator this build does not hand out. */
const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const S_OK = 0;

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
const SHELLEXECUTEINFO_HINSTAPP = 32;
const SHELLEXECUTEINFO_PROCESS = 56;

/**
 * The mask bits that change what the record means rather than what is done:
 * an item id list or a class name in place of a file, neither of which is a
 * path this shell can resolve, and the ask for a handle to wait on.
 */
const SEE_MASK_IDLIST = 0x00000004;
const SEE_MASK_NOCLOSEPROCESS = 0x00000040;
const SEE_MASK_CLASSNAME = 0x00000400;

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
    /** Which windows said they would take a drop. Nothing ever drops on them. */
    const accepting = new Set();

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
        }) : null;

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
    const pathOf = list=>(list === 0 || !memory ? null : pathOfList(memory, list));

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
            return host.readCString(address >>> 0, MAX_PATH);
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
        let name = '';
        const unit = wide ? 2 : 1;
        // An ANSI name is the page's, as the path of every other ANSI call is.
        const text = (/** @type {string} */ units)=>(wide ? units
            : decodeAnsi(Uint8Array.from(units, character=>character.charCodeAt(0))));
        for (let at = address >>> 0; at - (address >>> 0) < MAX_LIST * unit; at += 256)
        {
            const bytes = host.readMemory(at, 256);
            for (let index = 0; index + unit <= bytes.length; index += unit)
            {
                const code = wide ? bytes[index] | bytes[index + 1] << 8 : bytes[index];
                if (code !== 0)
                {
                    name += String.fromCharCode(code);
                    continue;
                }
                if (name === '')
                {
                    return names;
                }
                names.push(text(name));
                name = '';
            }
        }
        return names;
    };

    /**
     * The UTF-16 string an argument points at, or null for a null pointer.
     *
     * @param {number} address
     * @param {number} [limit]  How many characters are read at most.
     * @returns {string | null}
     */
    const wideStringOf = (address, limit = MAX_PATH)=>{
        if ((address >>> 0) === 0 || !host.readMemory)
        {
            return null;
        }
        let text = '';
        for (let at = address >>> 0; text.length < limit; at += 64)
        {
            const bytes = host.readMemory(at, 64);
            for (let index = 0; index + 1 < bytes.length && text.length < limit; index += 2)
            {
                const code = bytes[index] | bytes[index + 1] << 8;
                if (code === 0)
                {
                    return text;
                }
                text += String.fromCharCode(code);
            }
        }
        return text;
    };

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
    const createDirectory = wide=>({
        argBytes: 12,
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
     * @returns {{ answer: number, record: any }}
     */
    const start = (verb, file, parameters, directory)=>{
        const name = unquote((file ?? '').trim());
        if (name === '')
        {
            // Nothing was named, which is also what a build with no string
            // reader can tell about any name.
            return { answer: SE_ERR_ACCESSDENIED, record: null };
        }
        const wanted = (verb ?? 'open').trim().toLowerCase();
        if (!RUNNABLE_VERBS.has(wanted) || !SELF_EXECUTABLE.has(extensionOf(name)))
        {
            // A verb is a handler, and a document is a handler: both come from
            // registries this build does not have, so the ask is refused rather
            // than answered with a launch that did not happen.
            return { answer: SE_ERR_NOASSOC, record: null };
        }
        if (!host.launcher)
        {
            // A build with nothing behind it that can start a program. Told no
            // rather than told there was nothing to open it with, because the
            // file is exactly the kind the shell runs itself.
            return { answer: SE_ERR_ACCESSDENIED, record: null };
        }
        const image = host.launcher.imageOf(name);
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
        const record = host.launcher.launch(
            image, tail === '' ? `"${image}"` : `"${image}" ${tail}`, 0);
        return record
            ? { answer: LAUNCH_SUCCESS, record }
            : { answer: SE_ERR_FNF, record: null };
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
            const started = (mask & (SEE_MASK_IDLIST | SEE_MASK_CLASSNAME)) !== 0
                ? { answer: SE_ERR_NOASSOC, record: null }
                : start(field(SEI_VERB), field(SEI_FILE), field(SEI_PARAMETERS),
                    field(SEI_DIRECTORY));
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
            if (name === null || !host.resolve || !SELF_EXECUTABLE.has(extensionOf(name)))
            {
                write(result >>> 0, '');
                return SE_ERR_NOASSOC;
            }
            write(result >>> 0, fullPath(name, textOf(directory, wide) ?? ''));
            return LAUNCH_SUCCESS;
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
         * Accepted and remembered. A window that accepts drops and never
         * receives one is an ordinary window on an ordinary desktop.
         */
        DragAcceptFiles: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([window, accept])=>{
                if ((accept | 0) !== 0)
                {
                    accepting.add(window >>> 0);
                }
                else
                {
                    accepting.delete(window >>> 0);
                }
                return 0;
            },
        },

        /**
         * UINT DragQueryFileA(HDROP hDrop, UINT iFile, LPSTR lpszFile, UINT cch)
         *
         * An index of 0xFFFFFFFF asks how many files were dropped. No drop ever
         * happens here, so that is zero -- and a caller's loop over the count
         * runs no times, which is the correct amount.
         */
        DragQueryFileA: {
            argBytes: 16,
            handler: ()=>0,
        },
        /** UINT DragQueryFileW(HDROP hDrop, UINT iFile, LPWSTR lpszFile, UINT cch) */
        DragQueryFileW: {
            argBytes: 16,
            handler: ()=>0,
        },

        /** void DragFinish(HDROP hDrop) -- there was never a drop to release. */
        DragFinish: {
            argBytes: 4,
            handler: ()=>0,
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
         * says nothing it asked for was done.
         */
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
         * A notification icon lives on the taskbar, and there is no taskbar.
         * FALSE is what the real call answers when the shell's tray window is
         * not there to receive the icon, and a program treats that the way it
         * treats a machine without an Explorer: it carries on without the icon.
         */
        Shell_NotifyIconA: {
            argBytes: 8,
            handler: ()=>0,
        },

        Shell_NotifyIconW: {
            argBytes: 8,
            handler: ()=>0,
        },

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
                const folder = ((csidl | 0) & ~CSIDL_FLAG_MASK) === CSIDL_DRIVES
                    ? MY_COMPUTER : folderOf(csidl | 0);
                if (folder === null)
                {
                    host.writeMemory(out >>> 0, dword(0));
                    return E_INVALIDARG;
                }
                const list = listFor(folder);
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
