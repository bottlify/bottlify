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
 */

import { MY_COMPUTER, createShellNamespace, listBytes, pathOfList } from './namespace.js';

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
 * SHFILEOPSTRUCTA: where fAnyOperationsAborted lives. shellapi.h packs the
 * structure to one byte on Win32 and fFlags is a WORD, so the BOOL after it
 * sits at 18, not at the 20 natural alignment would give it.
 */
const SHFILEOPSTRUCT_ABORTED = 18;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** E_FAIL, for a namespace call in a build with no volume behind it. */
const E_FAIL = 0x80004005 | 0;

/** The computer: a folder with no path, whose children are the drives. */
const CSIDL_DRIVES = 0x11;

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
 *           id list with. Without it no list can be made and the folder calls
 *           fail as an out-of-memory would.
 * @property {Readonly<Record<string, string>>} [folders]
 *           The shell folders by the registry's names; absent, no CSIDL is known.
 * @property {import('./namespace.js').NamespaceVolume} [volume]
 *           The volume the namespace walks. Absent, there is no namespace and
 *           SHGetDesktopFolder is refused.
 * @property {(object: import('../oleaut32/objects.js').ComAdapter, interfaceId: string) => number} [publish]
 *           Puts a namespace object's interface into guest memory. Absent, as
 *           without the volume.
 */

/** @param {string} text @returns {Uint8Array} eight-bit text with its terminator */
const sz = text=>{
    const bytes = new Uint8Array(text.length + 1);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at] = text.charCodeAt(at) & 0xff;
    }
    return bytes;
};

/** @param {number} value */
const dword = value=>new Uint8Array([
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
]);

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
         */
        ShellExecuteA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, operation, file, parameters, directory])=>start(
                stringOf(operation), stringOf(file),
                stringOf(parameters), stringOf(directory)).answer,
        },

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
        FindExecutableA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([file, directory, result])=>{
                const name = stringOf(file);
                if (name === null || !host.resolve
                    || !SELF_EXECUTABLE.has(extensionOf(name)))
                {
                    writePath(result >>> 0, '');
                    return SE_ERR_NOASSOC;
                }
                writePath(result >>> 0, fullPath(name, stringOf(directory) ?? ''));
                return LAUNCH_SUCCESS;
            },
        },

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

        /** void DragFinish(HDROP hDrop) -- there was never a drop to release. */
        DragFinish: {
            argBytes: 4,
            handler: ()=>0,
        },

        /**
         * PIDLIST_ABSOLUTE SHBrowseForFolderA(LPBROWSEINFOA lpbi)
         *
         * Needs a person to choose a folder. Null is what a caller checks for
         * and means the browse was cancelled, which is true.
         */
        SHBrowseForFolderA: {
            argBytes: 4,
            handler: ()=>0,
        },

        /**
         * BOOL SHGetPathFromIDListA(PCIDLIST_ABSOLUTE pidl, LPSTR pszPath)
         *
         * A list made here carries its path, and one the program combined
         * from several of ours ends in the item that does; the computer's
         * list, and any other -- the browse above never makes one -- has none,
         * and the buffer is cleared so a caller that reads it regardless reads
         * an empty path.
         */
        SHGetPathFromIDListA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([list, path])=>{
                const found = pathOf(list >>> 0);
                writePath(path >>> 0, found ?? '');
                return found === null ? 0 : 1;
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
        ShellExecuteExA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([info])=>{
                const at = info >>> 0;
                if (at === 0)
                {
                    return 0;
                }
                const mask = dwordAt(at, SEI_MASK);
                const started = (mask & (SEE_MASK_IDLIST | SEE_MASK_CLASSNAME)) !== 0
                    ? { answer: SE_ERR_NOASSOC, record: null }
                    : start(stringOf(dwordAt(at, SEI_VERB)), stringOf(dwordAt(at, SEI_FILE)),
                        stringOf(dwordAt(at, SEI_PARAMETERS)),
                        stringOf(dwordAt(at, SEI_DIRECTORY)));
                host.writeMemory(at + SHELLEXECUTEINFO_HINSTAPP, dword(started.answer));
                if ((mask & SEE_MASK_NOCLOSEPROCESS) !== 0)
                {
                    host.writeMemory(at + SHELLEXECUTEINFO_PROCESS,
                        dword(started.record?.handle ?? 0));
                }
                return started.answer === LAUNCH_SUCCESS ? 1 : 0;
            },
        },

        /**
         * int SHFileOperationA(LPSHFILEOPSTRUCTA lpFileOp)
         *
         * A copy, move or delete with the shell's progress window and its
         * recycle bin. Neither exists here, and a program that asks for one
         * has the plain file calls to fall back on -- so it is refused as not
         * implemented and told that nothing it asked for was done.
         */
        SHFileOperationA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([operation])=>{
                if ((operation >>> 0) !== 0)
                {
                    host.writeMemory((operation >>> 0) + SHFILEOPSTRUCT_ABORTED, dword(1));
                }
                return ERROR_CALL_NOT_IMPLEMENTED;
            },
        },

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

        /**
         * DWORD_PTR SHGetFileInfoA(LPCSTR pszPath, DWORD dwFileAttributes,
         *                          SHFILEINFOA *psfi, UINT cbFileInfo, UINT uFlags)
         *
         * Icons, type names and display names come from the shell's namespace,
         * which this build does not have. Zero is failure, and the record is
         * left as the caller filled it.
         */
        SHGetFileInfoA: {
            argBytes: 20,
            handler: ()=>0,
        },

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
    };
    // The real library exports the ANSI browse under its bare name as well,
    // and a program that looks the pair up by hand asks for the bare one.
    return {
        ...table,
        SHBrowseForFolder: table.SHBrowseForFolderA,
        SHGetPathFromIDList: table.SHGetPathFromIDListA,
    };
}
