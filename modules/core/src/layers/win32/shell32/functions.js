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
/** E_FAIL, for a shell folder there is no namespace to resolve. */
const E_FAIL = 0x80004005 | 0;

/**
 * @typedef {Object} ShellHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(notice: { api: string, detail: string }) => void} [divergence]
 *           Where a call whose answer differs from Windows says so, rather than
 *           failing silently.
 * @property {{ pointer: () => number }} [taskAllocator]
 *           The process's IMalloc, the same one CoGetMalloc answers with.
 *           Absent in a build without ole32 behind it, and then SHGetMalloc
 *           is refused.
 */

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
         * There are no item id lists to turn into paths, because the only thing
         * that makes one is the browse above.
         */
        SHGetPathFromIDListA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, path])=>{
                if ((path >>> 0) !== 0)
                {
                    host.writeMemory(path >>> 0, new Uint8Array(1));
                }
                return 0;
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
         * There is no shell namespace here to turn a CSIDL into an item id
         * list, so this reports the failure the API defines rather than a
         * success with nothing behind it: E_FAIL, and a null where the list
         * would go. A caller checks the HRESULT and takes its own path -- an
         * installer that cannot find the Programs folder this way asks the
         * registry for it instead. Declared with its real argument size so the
         * stack is whole whichever branch the caller then takes.
         */
        SHGetSpecialFolderLocation: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , out])=>{
                if ((out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, dword(0));
                }
                host.divergence?.({
                    api: 'SHELL32.dll!SHGetSpecialFolderLocation',
                    detail: 'no shell namespace: reports E_FAIL with a null id list',
                });
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
