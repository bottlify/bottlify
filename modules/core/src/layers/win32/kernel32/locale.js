/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Code pages and the string conversions built on them.
 *
 * A C runtime asks these before main runs, to find out what a byte means. The
 * answer chosen here is Windows-1252 for the ANSI page and 437 for the OEM one:
 * one byte per character, every byte defined, which is what a program compiled
 * for a Western Windows was linked against.
 *
 * Two conventions run through every function here and are the whole difficulty.
 * A source length of -1 means "the string is NUL-terminated, and the terminator
 * is part of what you convert and part of what you count". A destination size of
 * zero means "do not write anything; tell me how much room you need". A runtime
 * uses both on the same call pair -- measure, allocate, convert -- so getting
 * either wrong produces a buffer that is exactly one character short, which is
 * the kind of fault that lands somewhere else entirely.
 */

/** The pages this build understands. CP_ACP and CP_OEMCP are selectors, not pages. */
const CP_ACP = 0;
const CP_OEMCP = 1;
const CP_UTF8 = 65001;
const CP_WINDOWS_1252 = 1252;
const CP_OEM_437 = 437;

/** What GetACP and GetOEMCP answer. */
const ANSI_CODE_PAGE = CP_WINDOWS_1252;
const OEM_CODE_PAGE = CP_OEM_437;

/** Error codes this file can produce. */
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** sizeof(CPINFO): MaxCharSize, DefaultChar[2], LeadByte[12]. */
const CPINFO_SIZE = 18;

/** What GetStringType reports. Only CT_CTYPE1 is answered. */
const CT_CTYPE1 = 1;
const C1_UPPER = 0x0001;
const C1_LOWER = 0x0002;
const C1_DIGIT = 0x0004;
const C1_SPACE = 0x0008;
const C1_PUNCT = 0x0010;
const C1_CNTRL = 0x0020;
const C1_BLANK = 0x0040;
const C1_XDIGIT = 0x0080;
const C1_ALPHA = 0x0100;

/** LCMapString's two cases. Everything else is a copy. */
const LCMAP_LOWERCASE = 0x00000100;
const LCMAP_UPPERCASE = 0x00000200;

/**
 * The sixteen positions where Windows-1252 is not Latin-1.
 *
 * Latin-1 leaves 0x80..0x9f as control characters; Windows put punctuation and
 * a handful of letters there, and text from that era is full of them. A zero
 * here means the position is genuinely undefined in the page.
 */
const CP1252_HIGH = [
    0x20ac, 0x0000, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
    0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x0000, 0x017d, 0x0000,
    0x0000, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x0000, 0x017e, 0x0178,
];

/**
 * Code page 437's upper half, which is nothing like Latin-1: accented letters,
 * box-drawing and mathematics, in the order IBM chose for the PC.
 */
const CP437_HIGH = [
    0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7,
    0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
    0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
    0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
    0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba,
    0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
    0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
    0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
    0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
    0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
    0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b,
    0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
    0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
    0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
    0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
    0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
];

/** The byte a character outside the page becomes. */
const DEFAULT_CHAR = 0x3f;

/** @param {number} page */
const resolvePage = page=>{
    const wanted = page >>> 0;
    if (wanted === CP_ACP)
    {
        return ANSI_CODE_PAGE;
    }
    if (wanted === CP_OEMCP)
    {
        return OEM_CODE_PAGE;
    }
    return wanted;
};

/** The upper half of a single-byte page, or null when the page is not one. */
const highHalf = (/** @type {number} */ page)=>{
    switch (page)
    {
        case CP_WINDOWS_1252:
            return CP1252_HIGH;
        case CP_OEM_437:
            return CP437_HIGH;
        default:
            // An unknown page is treated as the ANSI one rather than refused.
            // A program that names a page we do not carry is better served with
            // readable text than with a failure it has no path for.
            return CP1252_HIGH;
    }
};

/**
 * Bytes of a single-byte page, decoded.
 *
 * @param {Uint8Array} bytes @param {number} page
 */
const decodeSingleByte = (bytes, page)=>{
    const high = highHalf(page);
    let text = '';
    for (const byte of bytes)
    {
        text += String.fromCharCode(byte < 0x80 ? byte : high[byte - 0x80] || byte);
    }
    return text;
};

/**
 * Text encoded into a single-byte page. Anything the page cannot hold becomes
 * the default character, which is what Windows does and what a caller asking
 * for lpUsedDefaultChar is trying to find out.
 *
 * @param {string} text @param {number} page
 * @returns {{ bytes: Uint8Array, usedDefault: boolean }}
 */
const encodeSingleByte = (text, page)=>{
    const high = highHalf(page);
    const bytes = new Uint8Array(text.length);
    let usedDefault = false;
    for (let at = 0; at < text.length; at++)
    {
        const code = text.charCodeAt(at);
        if (code < 0x80)
        {
            bytes[at] = code;
            continue;
        }
        const found = high.indexOf(code);
        if (found === -1)
        {
            bytes[at] = DEFAULT_CHAR;
            usedDefault = true;
            continue;
        }
        bytes[at] = 0x80 + found;
    }
    return { bytes, usedDefault };
};

/** @param {number} code */
const characterType = code=>{
    const character = String.fromCharCode(code);
    let type = 0;
    if (/\p{Lu}/u.test(character))
    {
        type |= C1_UPPER | C1_ALPHA;
    }
    if (/\p{Ll}/u.test(character))
    {
        type |= C1_LOWER | C1_ALPHA;
    }
    if (/\p{L}/u.test(character))
    {
        type |= C1_ALPHA;
    }
    if (code >= 0x30 && code <= 0x39)
    {
        type |= C1_DIGIT | C1_XDIGIT;
    }
    if (/[a-fA-F]/.test(character))
    {
        type |= C1_XDIGIT;
    }
    if (/\s/.test(character))
    {
        type |= C1_SPACE;
    }
    if (code === 0x20 || code === 0x09)
    {
        type |= C1_BLANK;
    }
    if (code < 0x20 || code === 0x7f)
    {
        type |= C1_CNTRL;
    }
    if (/[!-/:-@[-`{-~]/.test(character))
    {
        type |= C1_PUNCT;
    }
    return type;
};

/**
 * @typedef {Object} LocaleHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 */

/**
 * @param {LocaleHost} host
 */
export function createLocaleFunctions(host){
    /**
     * The source of a conversion, as characters.
     *
     * A length of -1 means the string is NUL-terminated and the terminator
     * travels with it -- so the result of the conversion is terminated too, and
     * the count a caller is told includes it. Every other length is exact and
     * carries no terminator of its own.
     *
     * @param {number} address @param {number} declared @param {number} unit
     * @returns {{ length: number, terminated: boolean }}
     */
    const sourceSpan = (address, declared, unit)=>{
        if ((declared | 0) !== -1)
        {
            return { length: Math.max(declared | 0, 0), terminated: false };
        }
        let count = 0;
        for (;;)
        {
            const bytes = host.readMemory(address + count * unit, unit);
            const code = unit === 1 ? bytes[0] : bytes[0] | bytes[1] << 8;
            if (code === 0)
            {
                break;
            }
            count++;
        }
        return { length: count + 1, terminated: true };
    };

    /** @param {number} address @param {number} count */
    const readWide = (address, count)=>{
        const bytes = host.readMemory(address, count * 2);
        let text = '';
        for (let at = 0; at < count; at++)
        {
            text += String.fromCharCode(bytes[at * 2] | bytes[at * 2 + 1] << 8);
        }
        return text;
    };

    /** @param {number} address @param {string} text */
    const writeWide = (address, text)=>{
        const bytes = new Uint8Array(text.length * 2);
        for (let at = 0; at < text.length; at++)
        {
            const code = text.charCodeAt(at);
            bytes[at * 2] = code & 0xff;
            bytes[at * 2 + 1] = code >> 8;
        }
        host.writeMemory(address, bytes);
    };

    return {
        /** UINT GetACP(VOID) */
        GetACP: { argBytes: 0, handler: ()=>ANSI_CODE_PAGE },

        /** UINT GetOEMCP(VOID) */
        GetOEMCP: { argBytes: 0, handler: ()=>OEM_CODE_PAGE },

        /** BOOL GetCPInfo(UINT CodePage, LPCPINFO lpCPInfo) */
        GetCPInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([page, info])=>{
                const resolved = resolvePage(page);
                const bytes = new Uint8Array(CPINFO_SIZE);
                // MaxCharSize, then DefaultChar, then the lead-byte ranges. Every
                // page here is single byte or UTF-8, so no lead-byte range is
                // reported and the array stays zero -- which is how a caller
                // learns the page has no double-byte sequences.
                new DataView(bytes.buffer).setUint32(
                    0, resolved === CP_UTF8 ? 4 : 1, true);
                bytes[4] = DEFAULT_CHAR;
                host.writeMemory(info >>> 0, bytes);
                return 1;
            },
        },

        /**
         * int MultiByteToWideChar(UINT CodePage, DWORD dwFlags, LPCCH lpMultiByteStr,
         *                         int cbMultiByte, LPWSTR lpWideCharStr, int cchWideChar)
         */
        MultiByteToWideChar: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([page, flags, source, sourceBytes, destination, destinationChars])=>{
                void flags;
                const resolved = resolvePage(page);
                const span = sourceSpan(source >>> 0, sourceBytes, 1);
                if (span.length === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const raw = host.readMemory(source >>> 0, span.length);
                const text = resolved === CP_UTF8
                    ? new TextDecoder().decode(raw)
                    : decodeSingleByte(raw, resolved);

                // Zero is the measuring call, and it must not write.
                if ((destinationChars | 0) === 0)
                {
                    return text.length;
                }
                if (text.length > (destinationChars | 0))
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                writeWide(destination >>> 0, text);
                return text.length;
            },
        },

        /**
         * int WideCharToMultiByte(UINT CodePage, DWORD dwFlags, LPCWCH lpWideCharStr,
         *                         int cchWideChar, LPSTR lpMultiByteStr, int cbMultiByte,
         *                         LPCCH lpDefaultChar, LPBOOL lpUsedDefaultChar)
         */
        WideCharToMultiByte: {
            argBytes: 32,
            /** @param {number[]} args */
            handler(args){
                const [page, flags, source, sourceChars, destination, destinationBytes] = args;
                const usedDefaultOut = args[7] >>> 0;
                void flags;
                const resolved = resolvePage(page);
                const span = sourceSpan(source >>> 0, sourceChars, 2);
                if (span.length === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const text = readWide(source >>> 0, span.length);
                const encoded = resolved === CP_UTF8
                    ? { bytes: new TextEncoder().encode(text), usedDefault: false }
                    : encodeSingleByte(text, resolved);

                if (usedDefaultOut !== 0)
                {
                    host.writeMemory(usedDefaultOut,
                        new Uint8Array([encoded.usedDefault ? 1 : 0, 0, 0, 0]));
                }
                if ((destinationBytes | 0) === 0)
                {
                    return encoded.bytes.length;
                }
                if (encoded.bytes.length > (destinationBytes | 0))
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                host.writeMemory(destination >>> 0, encoded.bytes);
                return encoded.bytes.length;
            },
        },

        /**
         * BOOL GetStringTypeA(LCID Locale, DWORD dwInfoType, LPCSTR lpSrcStr,
         *                     int cchSrc, LPWORD lpCharType)
         */
        GetStringTypeA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([locale, infoType, source, count, types])=>{
                void locale;
                if ((infoType >>> 0) !== CT_CTYPE1)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const span = sourceSpan(source >>> 0, count, 1);
                const raw = host.readMemory(source >>> 0, span.length);
                const text = decodeSingleByte(raw, ANSI_CODE_PAGE);
                const out = new Uint8Array(text.length * 2);
                const view = new DataView(out.buffer);
                for (let at = 0; at < text.length; at++)
                {
                    view.setUint16(at * 2, characterType(text.charCodeAt(at)), true);
                }
                host.writeMemory(types >>> 0, out);
                return 1;
            },
        },

        /**
         * BOOL GetStringTypeW(DWORD dwInfoType, LPCWCH lpSrcStr, int cchSrc,
         *                     LPWORD lpCharType)
         *
         * Four arguments, not five: the W form has no locale, which is the one
         * place these two disagree about their own shape.
         */
        GetStringTypeW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([infoType, source, count, types])=>{
                if ((infoType >>> 0) !== CT_CTYPE1)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const span = sourceSpan(source >>> 0, count, 2);
                const text = readWide(source >>> 0, span.length);
                const out = new Uint8Array(text.length * 2);
                const view = new DataView(out.buffer);
                for (let at = 0; at < text.length; at++)
                {
                    view.setUint16(at * 2, characterType(text.charCodeAt(at)), true);
                }
                host.writeMemory(types >>> 0, out);
                return 1;
            },
        },

        /**
         * int LCMapStringA(LCID Locale, DWORD dwMapFlags, LPCSTR lpSrcStr, int cchSrc,
         *                  LPSTR lpDestStr, int cchDest)
         */
        LCMapStringA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([locale, mapFlags, source, sourceChars, destination, destinationChars])=>{
                void locale;
                const span = sourceSpan(source >>> 0, sourceChars, 1);
                const raw = host.readMemory(source >>> 0, span.length);
                const text = decodeSingleByte(raw, ANSI_CODE_PAGE);
                const mapped = (mapFlags >>> 0) & LCMAP_UPPERCASE
                    ? text.toUpperCase()
                    : (mapFlags >>> 0) & LCMAP_LOWERCASE ? text.toLowerCase() : text;
                const { bytes } = encodeSingleByte(mapped, ANSI_CODE_PAGE);

                if ((destinationChars | 0) === 0)
                {
                    return bytes.length;
                }
                if (bytes.length > (destinationChars | 0))
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                host.writeMemory(destination >>> 0, bytes);
                return bytes.length;
            },
        },

        /**
         * int LCMapStringW(LCID Locale, DWORD dwMapFlags, LPCWSTR lpSrcStr, int cchSrc,
         *                  LPWSTR lpDestStr, int cchDest)
         */
        LCMapStringW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([locale, mapFlags, source, sourceChars, destination, destinationChars])=>{
                void locale;
                const span = sourceSpan(source >>> 0, sourceChars, 2);
                const text = readWide(source >>> 0, span.length);
                const mapped = (mapFlags >>> 0) & LCMAP_UPPERCASE
                    ? text.toUpperCase()
                    : (mapFlags >>> 0) & LCMAP_LOWERCASE ? text.toLowerCase() : text;

                if ((destinationChars | 0) === 0)
                {
                    return mapped.length;
                }
                if (mapped.length > (destinationChars | 0))
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                writeWide(destination >>> 0, mapped);
                return mapped.length;
            },
        },
    };
}
