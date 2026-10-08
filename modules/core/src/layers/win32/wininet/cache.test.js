/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCacheFunctions } from './cache.js';
import { createFtpFunctions } from './ftp.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_DISK_FULL = 112;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_INTERNET_UNRECOGNIZED_SCHEME = 12006;
const ERROR_INTERNET_INCORRECT_HANDLE_TYPE = 12018;

const URL = 0x100;
const HANDLE = 0x40;

/** @param {(host: any) => Record<string, { argBytes: number, handler: Function }>} make */
function setup(make){
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const said = [];
    const fns = make({
        setLastError: (/** @type {number} */ code)=>errors.push(code),
        divergence: (/** @type {string} */ api)=>said.push(api),
        isHandle: (/** @type {number} */ handle)=>handle === HANDLE,
    });
    return { fns, errors, said };
}

test('the URL cache is empty: each call answers as an empty cache does', ()=>{
    // [name, argBytes, args, answer, last error]
    const cases = /** @type {[string, number, number[], number, number | null][]} */ ([
        ['GetUrlCacheEntryInfoA', 12, [URL, 0, 0], 0, ERROR_FILE_NOT_FOUND],
        ['GetUrlCacheEntryInfoW', 12, [URL, 0, 0], 0, ERROR_FILE_NOT_FOUND],
        ['GetUrlCacheEntryInfoA', 12, [0, 0, 0], 0, ERROR_INVALID_PARAMETER],
        ['GetUrlCacheEntryInfoExA', 28, [URL, 0, 0, 0, 0, 0, 0], 0, ERROR_FILE_NOT_FOUND],
        ['GetUrlCacheEntryInfoExW', 28, [URL, 0, 0, 0, 0, 0, 0], 0, ERROR_FILE_NOT_FOUND],
        ['GetUrlCacheEntryInfoExA', 28, [0, 0, 0, 0, 0, 0, 0], 0, ERROR_INVALID_PARAMETER],
        ['GetUrlCacheEntryInfoExA', 28, [URL, 0, 0, 0, 0x200, 0, 0], 0,
            ERROR_INVALID_PARAMETER],
        ['DeleteUrlCacheEntry', 4, [URL], 0, ERROR_FILE_NOT_FOUND],
        ['DeleteUrlCacheEntryA', 4, [URL], 0, ERROR_FILE_NOT_FOUND],
        ['DeleteUrlCacheEntryW', 4, [URL], 0, ERROR_FILE_NOT_FOUND],
        ['RetrieveUrlCacheEntryStreamW', 20, [URL, 0, 0, 0, 0], 0, ERROR_FILE_NOT_FOUND],
        ['SetUrlCacheEntryInfoW', 12, [URL, 0, 0], 0, ERROR_FILE_NOT_FOUND],
        ['SetUrlCacheEntryGroupW', 28, [URL, 0, 0, 0, 0, 0, 0], 0, ERROR_FILE_NOT_FOUND],
        ['FindFirstUrlCacheEntryA', 12, [0, 0, 0], 0, ERROR_NO_MORE_ITEMS],
        ['FindFirstUrlCacheEntryW', 12, [0, 0, 0], 0, ERROR_NO_MORE_ITEMS],
        ['FindNextUrlCacheEntryA', 12, [HANDLE, 0, 0], 0, ERROR_INVALID_HANDLE],
        ['FindNextUrlCacheEntryW', 12, [HANDLE, 0, 0], 0, ERROR_INVALID_HANDLE],
        ['FindCloseUrlCache', 4, [HANDLE], 0, ERROR_INVALID_HANDLE],
        ['ReadUrlCacheEntryStream', 20, [HANDLE, 0, 0, 0, 0], 0, ERROR_INVALID_HANDLE],
        ['UnlockUrlCacheEntryStream', 8, [HANDLE, 0], 0, ERROR_INVALID_HANDLE],
        ['CreateUrlCacheEntryW', 20, [URL, 0, 0, 0x200, 0], 0, ERROR_DISK_FULL],
        ['CommitUrlCacheEntryA', 44, [URL, 0x200, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0,
            ERROR_FILE_NOT_FOUND],
        ['CommitUrlCacheEntryW', 44, [URL, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0, ERROR_DISK_FULL],
        ['CommitUrlCacheEntryA', 44, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0,
            ERROR_INVALID_PARAMETER],
        ['CreateUrlCacheContainerA', 32, [URL, 0, 0, 0, 0, 0, 0, 0], 0, ERROR_ACCESS_DENIED],
        ['DeleteUrlCacheContainerA', 8, [URL, 0], 0, ERROR_FILE_NOT_FOUND],
        ['FreeUrlCacheSpaceW', 12, [0, 100, 0], 1, null],
        ['RegisterUrlCacheNotification', 24, [0, 0, 0, 0, 0, 0], 0, null],
    ]);
    for (const [name, argBytes, args, answer, lastError] of cases)
    {
        const { fns, errors } = setup(createCacheFunctions);
        assert.equal(fns[name].argBytes, argBytes, name);
        assert.equal(fns[name].handler(args), answer, name);
        assert.deepEqual(errors, lastError === null ? [] : [lastError], name);
    }
});

test('FTP and Gopher calls name the handle wrong, and say so once per call', ()=>{
    const calls = /** @type {[string, number][]} */ ([
        ['FtpFindFirstFileA', 20], ['FtpFindFirstFileW', 20], ['FtpOpenFileA', 20],
        ['FtpOpenFileW', 20], ['FtpCreateDirectoryA', 8], ['FtpCreateDirectoryW', 8],
        ['FtpRemoveDirectoryA', 8], ['FtpRemoveDirectoryW', 8], ['FtpSetCurrentDirectoryA', 8],
        ['FtpSetCurrentDirectoryW', 8], ['FtpGetCurrentDirectoryA', 12],
        ['FtpGetCurrentDirectoryW', 12], ['FtpDeleteFileA', 8], ['FtpDeleteFileW', 8],
        ['FtpRenameFileA', 12], ['FtpRenameFileW', 12], ['FtpGetFileA', 28], ['FtpGetFileW', 28],
        ['FtpPutFileA', 20], ['FtpPutFileW', 20], ['FtpCommandA', 24], ['FtpCommandW', 24],
        ['InternetFindNextFileA', 8], ['InternetFindNextFileW', 8],
        ['GopherFindFirstFileA', 24], ['GopherFindFirstFileW', 24], ['GopherOpenFileA', 20],
        ['GopherOpenFileW', 20], ['GopherGetAttributeA', 32], ['GopherGetAttributeW', 32],
    ]);
    for (const [name, argBytes] of calls)
    {
        const { fns, errors, said } = setup(createFtpFunctions);
        assert.equal(fns[name].argBytes, argBytes, name);
        assert.equal(fns[name].handler([0, 0, 0, 0, 0, 0, 0, 0]), 0, name);
        assert.equal(fns[name].handler([HANDLE, 0, 0, 0, 0, 0, 0, 0]), 0, name);
        assert.deepEqual(errors, [ERROR_INVALID_HANDLE, ERROR_INTERNET_INCORRECT_HANDLE_TYPE],
            name);
        assert.deepEqual(said, [name]);
    }
    for (const name of ['GopherCreateLocatorA', 'GopherCreateLocatorW'])
    {
        const { fns, errors } = setup(createFtpFunctions);
        assert.equal(fns[name].argBytes, 28);
        assert.equal(fns[name].handler(), 0);
        assert.deepEqual(errors, [ERROR_INTERNET_UNRECOGNIZED_SCHEME]);
    }
});
