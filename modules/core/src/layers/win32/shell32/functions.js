/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shell32 — the calls that reach outside the process, and the ones that do not.
 *
 * Almost everything here is a refusal, and the refusals are the point. This
 * engine runs one program: it does not start others, it does not open a
 * document in whatever is registered for it, and there is nobody to pick a
 * folder out of a tree. Returning success for any of those is the failure that
 * costs most later, because the caller carries on believing something happened
 * and fails somewhere with nothing to connect it back.
 *
 * The refusals are the documented ones rather than a generic error, because a
 * caller distinguishes them: "no application is associated with this" is a
 * thing a program handles, and a program that gets it stops asking.
 *
 * Drag and drop is the exception, and it is not a refusal but a truth: files
 * are never dropped on a window here, so a window may accept drops and a query
 * against a drop that never arrived reports no files. Both are what a real
 * system answers when nobody has dragged anything.
 */

import { MY_COMPUTER, createShellNamespace, listBytes, pathOfList } from './namespace.js';

/** ShellExecute reports failure as a value of 32 or less, not as zero. */
const SE_ERR_ACCESSDENIED = 5;
const SE_ERR_NOASSOC = 31;

/** E_NOTIMPL, for the allocator this build does not hand out. */
const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const S_OK = 0;

/** What SHFileOperation answers when it will not operate. */
const ERROR_CALL_NOT_IMPLEMENTED = 120;

/** SHELLEXECUTEINFOA: where hInstApp lives, which a caller reads on failure. */
const SHELLEXECUTEINFO_HINSTAPP = 32;

/** SHFILEOPSTRUCTA: where fAnyOperationsAborted lives. */
const SHFILEOPSTRUCT_ABORTED = 20;
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

    const table = {
        /**
         * HINSTANCE ShellExecuteA(HWND, LPCSTR lpOperation, LPCSTR lpFile,
         *                         LPCSTR lpParameters, LPCSTR lpDirectory,
         *                         INT nShowCmd)
         *
         * Refused. This is how a program opens a web page, a readme or an
         * installer, and none of those exist to open from in here.
         */
        ShellExecuteA: {
            argBytes: 24,
            handler: ()=>SE_ERR_ACCESSDENIED,
        },

        /**
         * HINSTANCE FindExecutableA(LPCSTR lpFile, LPCSTR lpDirectory,
         *                           LPSTR lpResult)
         *
         * Refused with the association error rather than the access one: there
         * is no registry of file associations here at all, which is a different
         * thing from being told no.
         */
        FindExecutableA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , result])=>{
                if ((result >>> 0) !== 0)
                {
                    // The caller passes a buffer and reads it whatever the
                    // return value says; leaving it holding its own stack would
                    // be read as a path.
                    host.writeMemory(result >>> 0, new Uint8Array(1));
                }
                return SE_ERR_NOASSOC;
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
         * The same refusal as ShellExecuteA, in the form a caller of this one
         * reads: a FALSE, and the same error in the record's hInstApp.
         */
        ShellExecuteExA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([info])=>{
                if ((info >>> 0) !== 0)
                {
                    host.writeMemory(
                        (info >>> 0) + SHELLEXECUTEINFO_HINSTAPP, dword(SE_ERR_ACCESSDENIED));
                }
                return 0;
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
