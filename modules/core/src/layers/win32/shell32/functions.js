/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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

/**
 * @typedef {Object} ShellHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
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

    return {
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
         * Not implemented, and null is written where the interface would go so
         * that a caller which ignores the HRESULT fails on a null it can see
         * rather than on a pointer to nothing.
         *
         * The allocator itself belongs in ole32 as CoGetMalloc, and this would
         * forward to it. Nothing needs one yet: the only thing a caller frees
         * with it is a list from the browse above, which never returns one.
         */
        SHGetMalloc: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, dword(0));
                }
                return E_NOTIMPL;
            },
        },
    };
}
