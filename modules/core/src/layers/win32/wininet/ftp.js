/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * FTP and Gopher: the services InternetConnect is asked for and cannot reach.
 *
 * Both connect when InternetConnect is called, unlike HTTP, which connects
 * when a request is sent; a server that cannot be reached therefore fails the
 * connect itself, and no FTP or Gopher session handle ever exists here. Every
 * call below takes one, so each answers what Windows answers for the handle
 * it was given: none at all, or one of ours that is not an FTP or Gopher
 * session -- the handle type is wrong. The same holds for a find handle,
 * which only those sessions make.
 */

import { createRefusals } from '../common/refusal.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INTERNET_UNRECOGNIZED_SCHEME = 12006;
const ERROR_INTERNET_INCORRECT_HANDLE_TYPE = 12018;

const NO_FTP = 'no FTP server is reachable, so no FTP session exists';
const NO_GOPHER = 'no Gopher server is reachable, so no Gopher session exists';

/**
 * @param {{ setLastError: (code: number) => void,
 *     divergence?: (api: string, detail: string) => void,
 *     isHandle: (handle: number) => boolean }} host
 *     `isHandle` answers whether a handle is one this library gave out.
 */
export function createFtpFunctions(host){
    const refuse = createRefusals(host);

    /**
     * A call on a session that cannot exist: the handle is no handle, or the
     * wrong kind of one. Answers FALSE or a null handle, which are both zero.
     *
     * @param {string} name @param {number} argBytes @param {string} why
     */
    const onSession = (name, argBytes, why)=>{
        const refusal = refuse(name, { argBytes, answer: 0, why });
        return {
            argBytes,
            /** @param {number[]} args */
            handler: ([handle])=>{
                refusal.handler();
                host.setLastError(host.isHandle(handle >>> 0)
                    ? ERROR_INTERNET_INCORRECT_HANDLE_TYPE : ERROR_INVALID_HANDLE);
                return 0;
            },
        };
    };

    /** @param {string} name @param {number} argBytes */
    const ftp = (name, argBytes)=>onSession(name, argBytes, NO_FTP);
    /** @param {string} name @param {number} argBytes */
    const gopher = (name, argBytes)=>onSession(name, argBytes, NO_GOPHER);

    return {
        /** HINTERNET FtpFindFirstFile(HINTERNET, LPCTSTR, LPWIN32_FIND_DATA, DWORD, DWORD_PTR) */
        FtpFindFirstFileA: ftp('FtpFindFirstFileA', 20),
        FtpFindFirstFileW: ftp('FtpFindFirstFileW', 20),
        /** HINTERNET FtpOpenFile(HINTERNET, LPCTSTR, DWORD dwAccess, DWORD dwFlags, DWORD_PTR) */
        FtpOpenFileA: ftp('FtpOpenFileA', 20),
        FtpOpenFileW: ftp('FtpOpenFileW', 20),
        /** BOOL FtpCreateDirectory(HINTERNET, LPCTSTR) */
        FtpCreateDirectoryA: ftp('FtpCreateDirectoryA', 8),
        FtpCreateDirectoryW: ftp('FtpCreateDirectoryW', 8),
        /** BOOL FtpRemoveDirectory(HINTERNET, LPCTSTR) */
        FtpRemoveDirectoryA: ftp('FtpRemoveDirectoryA', 8),
        FtpRemoveDirectoryW: ftp('FtpRemoveDirectoryW', 8),
        /** BOOL FtpSetCurrentDirectory(HINTERNET, LPCTSTR) */
        FtpSetCurrentDirectoryA: ftp('FtpSetCurrentDirectoryA', 8),
        FtpSetCurrentDirectoryW: ftp('FtpSetCurrentDirectoryW', 8),
        /** BOOL FtpGetCurrentDirectory(HINTERNET, LPTSTR, LPDWORD) */
        FtpGetCurrentDirectoryA: ftp('FtpGetCurrentDirectoryA', 12),
        FtpGetCurrentDirectoryW: ftp('FtpGetCurrentDirectoryW', 12),
        /** BOOL FtpDeleteFile(HINTERNET, LPCTSTR) */
        FtpDeleteFileA: ftp('FtpDeleteFileA', 8),
        FtpDeleteFileW: ftp('FtpDeleteFileW', 8),
        /** BOOL FtpRenameFile(HINTERNET, LPCTSTR lpszExisting, LPCTSTR lpszNew) */
        FtpRenameFileA: ftp('FtpRenameFileA', 12),
        FtpRenameFileW: ftp('FtpRenameFileW', 12),
        /**
         * BOOL FtpGetFile(HINTERNET, LPCTSTR lpszRemoteFile, LPCTSTR lpszNewFile,
         *   BOOL fFailIfExists, DWORD dwFlagsAndAttributes, DWORD dwFlags, DWORD_PTR)
         */
        FtpGetFileA: ftp('FtpGetFileA', 28),
        FtpGetFileW: ftp('FtpGetFileW', 28),
        /** BOOL FtpPutFile(HINTERNET, LPCTSTR lpszLocalFile, LPCTSTR lpszNewRemoteFile, DWORD, DWORD_PTR) */
        FtpPutFileA: ftp('FtpPutFileA', 20),
        FtpPutFileW: ftp('FtpPutFileW', 20),
        /**
         * BOOL FtpCommand(HINTERNET, BOOL fExpectResponse, DWORD dwFlags,
         *   LPCTSTR lpszCommand, DWORD_PTR, HINTERNET *phFtpCommand)
         */
        FtpCommandA: ftp('FtpCommandA', 24),
        FtpCommandW: ftp('FtpCommandW', 24),

        /** BOOL InternetFindNextFile(HINTERNET hFind, LPVOID lpvFindData): no find was opened */
        InternetFindNextFileA: ftp('InternetFindNextFileA', 8),
        InternetFindNextFileW: ftp('InternetFindNextFileW', 8),

        /**
         * HINTERNET GopherFindFirstFile(HINTERNET, LPCTSTR lpszLocator,
         *   LPCTSTR lpszSearchString, LPGOPHER_FIND_DATA, DWORD, DWORD_PTR)
         */
        GopherFindFirstFileA: gopher('GopherFindFirstFileA', 24),
        GopherFindFirstFileW: gopher('GopherFindFirstFileW', 24),
        /** HINTERNET GopherOpenFile(HINTERNET, LPCTSTR lpszLocator, LPCTSTR lpszView, DWORD, DWORD_PTR) */
        GopherOpenFileA: gopher('GopherOpenFileA', 20),
        GopherOpenFileW: gopher('GopherOpenFileW', 20),
        /**
         * BOOL GopherGetAttribute(HINTERNET, LPCTSTR lpszLocator,
         *   LPCTSTR lpszAttributeName, LPBYTE, DWORD, LPDWORD,
         *   GOPHER_ATTRIBUTE_ENUMERATOR, DWORD_PTR)
         */
        GopherGetAttributeA: gopher('GopherGetAttributeA', 32),
        GopherGetAttributeW: gopher('GopherGetAttributeW', 32),

        /**
         * BOOL GopherCreateLocator(LPCTSTR lpszHost, INTERNET_PORT nServerPort,
         *   LPCTSTR lpszDisplayString, LPCTSTR lpszSelectorString,
         *   DWORD dwGopherType, LPTSTR lpszLocator, LPDWORD lpdwBufferLength)
         *
         * Takes no handle, but a locator is the Gopher service's own text and
         * this library does not speak Gopher: the scheme is one it does not
         * recognise, as on a system whose WinInet has dropped the protocol.
         */
        GopherCreateLocatorA: refuse('GopherCreateLocatorA', { argBytes: 28, answer: 0,
            lastError: ERROR_INTERNET_UNRECOGNIZED_SCHEME, why: NO_GOPHER }),
        GopherCreateLocatorW: refuse('GopherCreateLocatorW', { argBytes: 28, answer: 0,
            lastError: ERROR_INTERNET_UNRECOGNIZED_SCHEME, why: NO_GOPHER }),
    };
}
