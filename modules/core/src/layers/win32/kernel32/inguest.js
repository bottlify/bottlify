/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * kernel32's functions a runtime's loader calls most as it starts, answered in
 * the guest: each call was a crossing into the host, and a loader thread that
 * made one every few tens of thousands of instructions was kept on the
 * process's own executor beside the thread drawing its loading screen.
 *
 * MultiByteToWideChar and WideCharToMultiByte over ASCII: a loader converts
 * names and paths a few hundred thousand times, almost all of them ASCII.
 * Below 0x80 the ANSI page (1252), the page CP_ACP selects, and UTF-8 are all
 * the same characters, so a text that is ASCII throughout
 * converts here, unit for unit. Everything else goes to the host's handler
 * (`locale.js`) as the call was made, before anything is written: a unit at or
 * past 0x80, another page or selector (CP_THREAD_ACP follows the thread's
 * locale), a flag that could change ASCII, a length of zero, a destination
 * too small (filled as far as it goes and failed there), and every refusal.
 */

/**
 * @typedef {import('../msvcrt/guest-code.js').GuestMemory} Guest
 */
/** @typedef {import('../msvcrt/guest-code.js').u32} u32 */
/** @typedef {import('../msvcrt/guest-code.js').i32} i32 */

/** CP_ACP, which selects the ANSI page. */
const CP_ACP = 0;
/** The ANSI page this build has (`locale.js`'s ANSI_CODE_PAGE). */
const ANSI_PAGE = 1252;
const CP_UTF8 = 65001;
/** MB_PRECOMPOSED and MB_ERR_INVALID_CHARS: neither changes ASCII. */
const MB_ASCII_FLAGS = 0x9;
/**
 * WC_DISCARDNS, WC_SEPCHARS, WC_DEFAULTCHAR, WC_ERR_INVALID_CHARS,
 * WC_COMPOSITECHECK and WC_NO_BEST_FIT_CHARS (`locale.js`'s WC_FLAGS): all
 * about characters a page lacks or composes, none of them ASCII.
 */
const WC_ASCII_FLAGS = 0x6f0;

/**
 * int MultiByteToWideChar(UINT CodePage, DWORD dwFlags, LPCCH lpMultiByteStr,
 *                         int cbMultiByte, LPWSTR lpWideCharStr, int cchWideChar)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} page @param {u32} flags @param {u32} source
 * @param {u32} sourceBytes @param {u32} destination @param {u32} destinationChars
 * @returns {i32}
 */
export function MultiByteToWideChar({ u8, setU16, host }, page, flags, source, sourceBytes,
    destination, destinationChars)
{
    if (page !== CP_ACP && page !== ANSI_PAGE && page !== CP_UTF8)
    {
        return host();
    }
    if ((flags & ~MB_ASCII_FLAGS) !== 0 || source === 0 || (sourceBytes | 0) === 0
        || (destinationChars | 0) < 0 || (destination === 0 && destinationChars !== 0))
    {
        return host();
    }
    let count = 0;
    if ((sourceBytes | 0) < 0)
    {
        // Up to the terminator, which travels with the text and is counted.
        for (;;)
        {
            const unit = u8(source + count);
            if (unit >= 0x80)
            {
                return host();
            }
            count++;
            if (unit === 0)
            {
                break;
            }
        }
    }
    else
    {
        count = sourceBytes | 0;
        for (let at = 0; at < count; at++)
        {
            if (u8(source + at) >= 0x80)
            {
                return host();
            }
        }
    }
    if (destinationChars === 0)
    {
        return count;
    }
    if (count > (destinationChars | 0))
    {
        return host();
    }
    for (let at = 0; at < count; at++)
    {
        setU16(destination + at * 2, u8(source + at));
    }
    return count;
}

/**
 * int WideCharToMultiByte(UINT CodePage, DWORD dwFlags, LPCWCH lpWideCharStr,
 *                         int cchWideChar, LPSTR lpMultiByteStr, int cbMultiByte,
 *                         LPCCH lpDefaultChar, LPBOOL lpUsedDefaultChar)
 *
 * No default character is used for ASCII: `*lpUsedDefaultChar` is FALSE.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} page @param {u32} flags @param {u32} source
 * @param {u32} sourceChars @param {u32} destination @param {u32} destinationBytes
 * @param {u32} defaultChar @param {u32} usedDefault
 * @returns {i32}
 */
export function WideCharToMultiByte({ u16, setU8, setU32, host }, page, flags, source,
    sourceChars, destination, destinationBytes, defaultChar, usedDefault)
{
    if (page !== CP_ACP && page !== ANSI_PAGE && page !== CP_UTF8)
    {
        return host();
    }
    if ((flags & ~WC_ASCII_FLAGS) !== 0 || source === 0 || (sourceChars | 0) === 0
        || (destinationBytes | 0) < 0 || (destination === 0 && destinationBytes !== 0))
    {
        return host();
    }
    let count = 0;
    if ((sourceChars | 0) < 0)
    {
        for (;;)
        {
            const unit = u16(source + count * 2);
            if (unit >= 0x80)
            {
                return host();
            }
            count++;
            if (unit === 0)
            {
                break;
            }
        }
    }
    else
    {
        count = sourceChars | 0;
        for (let at = 0; at < count; at++)
        {
            if (u16(source + at * 2) >= 0x80)
            {
                return host();
            }
        }
    }
    if (destinationBytes !== 0 && count > (destinationBytes | 0))
    {
        return host();
    }
    if (usedDefault !== 0)
    {
        setU32(usedDefault, 0);
    }
    if (destinationBytes === 0)
    {
        return count;
    }
    for (let at = 0; at < count; at++)
    {
        setU8(destination + at, u16(source + at * 2));
    }
    return count;
}

/**
 * BOOL FlushInstructionCache(HANDLE hProcess, LPCVOID lpBaseAddress, SIZE_T dwSize)
 *
 * TRUE, and nothing to do: the processor here notices a written code page on
 * its own (`heap.js`'s handler, the reference). A JIT calls it after every
 * method it writes.
 *
 * @guestCode stdcall
 * @param {u32} process @param {u32} base @param {u32} size
 * @returns {i32}
 */
export function FlushInstructionCache(process, base, size){ // eslint-disable-line no-unused-vars
    return 1;
}
