/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The URL cache: Temporary Internet Files, which on this machine is empty and
 * holds nothing.
 *
 * Every read answers what an empty cache answers on Windows -- no entry by
 * that URL, nothing to enumerate -- and every handle a cache call takes is one
 * no call here ever gave out. Writing is refused as a cache with no room for
 * anything: a downloaded file goes where its program writes it, and a cache
 * entry that pointed at it would be a second copy the program could reach only
 * through this API. A program that caches does so as a courtesy and carries
 * on when told no.
 */

import { createRefusals } from '../common/refusal.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_DISK_FULL = 112;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NO_MORE_ITEMS = 259;

const EMPTY = 'the URL cache is empty';
const NO_ROOM = 'the URL cache takes no entries';

/**
 * @param {{ setLastError: (code: number) => void,
 *     divergence?: (api: string, detail: string) => void }} host
 */
export function createCacheFunctions(host){
    const refuse = createRefusals(host);

    /**
     * A lookup by URL: a null URL is a bad parameter, any other is not in an
     * empty cache.
     *
     * @param {string} name @param {number} argBytes
     */
    const lookup = (name, argBytes)=>{
        const refusal = refuse(name, { argBytes, answer: 0, lastError: ERROR_FILE_NOT_FOUND,
            why: EMPTY });
        return {
            argBytes,
            /** @param {number[]} args */
            handler: ([url])=>{
                if ((url >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return refusal.handler();
            },
        };
    };

    /**
     * GetUrlCacheEntryInfoEx(LPCTSTR lpszUrl, LPINTERNET_CACHE_ENTRY_INFO,
     *   LPDWORD lpcbCacheEntryInfo, LPTSTR lpszRedirectUrl,
     *   LPDWORD lpcbRedirectUrl, LPVOID lpReserved, DWORD dwFlags)
     *
     * The redirect URL is reserved: asking for it is a bad parameter before
     * the cache is even looked at.
     *
     * @param {string} name
     */
    const lookupEx = name=>{
        const missing = lookup(name, 28);
        return {
            argBytes: 28,
            /** @param {number[]} args */
            handler: args=>{
                if ((args[4] >>> 0) !== 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return missing.handler(args);
            },
        };
    };

    /** @param {string} name @param {number} argBytes */
    const noHandle = (name, argBytes)=>refuse(name, { argBytes, answer: 0,
        lastError: ERROR_INVALID_HANDLE, why: EMPTY });

    /** @param {string} name */
    const findFirst = name=>refuse(name, { argBytes: 12, answer: 0,
        lastError: ERROR_NO_MORE_ITEMS, why: EMPTY });

    /**
     * CommitUrlCacheEntry(LPCTSTR lpszUrlName, LPCTSTR lpszLocalFileName,
     *   FILETIME ExpireTime, FILETIME LastModifiedTime, DWORD CacheEntryType,
     *   LPBYTE lpHeaderInfo, DWORD cchHeaderInfo, LPCTSTR lpszFileExtension,
     *   LPCTSTR lpszOriginalUrl)
     *
     * A local file named here can only be one CreateUrlCacheEntry handed out,
     * and it handed out none; an entry with no file has no room.
     *
     * @param {string} name
     */
    const commit = name=>{
        const notOurs = refuse(name, { argBytes: 44, answer: 0, lastError: ERROR_FILE_NOT_FOUND,
            why: NO_ROOM });
        const full = refuse(name, { argBytes: 44, answer: 0, lastError: ERROR_DISK_FULL,
            why: NO_ROOM });
        return {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([url, localFile])=>{
                if ((url >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return (localFile >>> 0) !== 0 ? notOurs.handler() : full.handler();
            },
        };
    };

    const deleteEntry = lookup('DeleteUrlCacheEntry', 4);

    return {
        /** BOOL GetUrlCacheEntryInfoA(LPCSTR, LPINTERNET_CACHE_ENTRY_INFOA, LPDWORD) */
        GetUrlCacheEntryInfoA: lookup('GetUrlCacheEntryInfoA', 12),
        GetUrlCacheEntryInfoW: lookup('GetUrlCacheEntryInfoW', 12),
        GetUrlCacheEntryInfoExA: lookupEx('GetUrlCacheEntryInfoExA'),
        GetUrlCacheEntryInfoExW: lookupEx('GetUrlCacheEntryInfoExW'),

        /** BOOL DeleteUrlCacheEntry(LPCTSTR lpszUrlName): exported under both names */
        DeleteUrlCacheEntry: deleteEntry,
        DeleteUrlCacheEntryA: deleteEntry,
        DeleteUrlCacheEntryW: lookup('DeleteUrlCacheEntryW', 4),

        /**
         * HANDLE RetrieveUrlCacheEntryStreamW(LPCWSTR lpszUrlName,
         *   LPINTERNET_CACHE_ENTRY_INFOW, LPDWORD, BOOL fRandomRead, DWORD)
         */
        RetrieveUrlCacheEntryStreamW: lookup('RetrieveUrlCacheEntryStreamW', 20),

        /** BOOL SetUrlCacheEntryInfoW(LPCWSTR, LPINTERNET_CACHE_ENTRY_INFOW, DWORD) */
        SetUrlCacheEntryInfoW: lookup('SetUrlCacheEntryInfoW', 12),

        /**
         * BOOL SetUrlCacheEntryGroupW(LPCWSTR lpszUrlName, DWORD dwFlags,
         *   GROUPID GroupId, LPBYTE, DWORD, LPVOID): the GROUPID is a LONGLONG,
         *   eight bytes on the stack.
         */
        SetUrlCacheEntryGroupW: lookup('SetUrlCacheEntryGroupW', 28),

        /**
         * HANDLE FindFirstUrlCacheEntry(LPCTSTR lpszUrlSearchPattern,
         *   LPINTERNET_CACHE_ENTRY_INFO, LPDWORD): nothing to find.
         */
        FindFirstUrlCacheEntryA: findFirst('FindFirstUrlCacheEntryA'),
        FindFirstUrlCacheEntryW: findFirst('FindFirstUrlCacheEntryW'),

        /** BOOL FindNextUrlCacheEntry(HANDLE hEnumHandle, ...): no find was opened */
        FindNextUrlCacheEntryA: noHandle('FindNextUrlCacheEntryA', 12),
        FindNextUrlCacheEntryW: noHandle('FindNextUrlCacheEntryW', 12),
        /** BOOL FindCloseUrlCache(HANDLE hEnumHandle) */
        FindCloseUrlCache: noHandle('FindCloseUrlCache', 4),

        /**
         * BOOL ReadUrlCacheEntryStream(HANDLE hUrlCacheStream, DWORD dwLocation,
         *   LPVOID lpBuffer, LPDWORD lpdwLen, DWORD Reserved)
         */
        ReadUrlCacheEntryStream: noHandle('ReadUrlCacheEntryStream', 20),
        /** BOOL UnlockUrlCacheEntryStream(HANDLE hUrlCacheStream, DWORD Reserved) */
        UnlockUrlCacheEntryStream: noHandle('UnlockUrlCacheEntryStream', 8),

        /**
         * BOOL CreateUrlCacheEntryW(LPCWSTR lpszUrlName, DWORD dwExpectedFileSize,
         *   LPCWSTR lpszFileExtension, LPWSTR lpszFileName, DWORD dwReserved)
         */
        CreateUrlCacheEntryW: refuse('CreateUrlCacheEntryW', { argBytes: 20, answer: 0,
            lastError: ERROR_DISK_FULL, why: NO_ROOM }),

        CommitUrlCacheEntryA: commit('CommitUrlCacheEntryA'),
        CommitUrlCacheEntryW: commit('CommitUrlCacheEntryW'),

        /**
         * BOOL CreateUrlCacheContainerA(LPCSTR Name, LPCSTR lpCachePrefix,
         *   LPCSTR lpszCachePath, DWORD KBCacheLimit, DWORD dwContainerType,
         *   DWORD dwOptions, LPVOID, LPDWORD)
         *
         * A container is a machine-wide registration, which is an
         * administrator's to make.
         */
        CreateUrlCacheContainerA: refuse('CreateUrlCacheContainerA', { argBytes: 32, answer: 0,
            lastError: ERROR_ACCESS_DENIED, why: NO_ROOM }),

        /** BOOL DeleteUrlCacheContainerA(LPCSTR Name, DWORD dwOptions): there is none by any name */
        DeleteUrlCacheContainerA: refuse('DeleteUrlCacheContainerA', { argBytes: 8, answer: 0,
            lastError: ERROR_FILE_NOT_FOUND, why: EMPTY }),

        /**
         * BOOL FreeUrlCacheSpaceW(LPCWSTR lpszCachePath, DWORD dwSize, DWORD dwFilter)
         *
         * Asked to make room in a cache that holds nothing, it has made all
         * the room there is.
         */
        FreeUrlCacheSpaceW: { argBytes: 12, handler: ()=>1 },

        /**
         * DWORD RegisterUrlCacheNotification(HWND, UINT, GROUPID, DWORD, DWORD):
         * GROUPID is eight bytes. Registered, and never sent: the cache never
         * changes.
         */
        RegisterUrlCacheNotification: { argBytes: 24, handler: ()=>0 },
    };
}
