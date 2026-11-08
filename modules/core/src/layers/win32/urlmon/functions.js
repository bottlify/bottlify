/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * urlmon - the URL moniker library Internet Explorer ships with the system.
 *
 * A program that embeds a browser of its own, or fetches over HTTP with the
 * system's identity, links ObtainUserAgentString to learn what Internet
 * Explorer calls itself; WPF asks FindMimeFromData the type of a resource it
 * loads. A library that does not load fails the whole module
 * that imports it, whatever else the module does. The string is the one the
 * Windows being run ships its Internet Explorer with, as Microsoft documents
 * each version's (Understanding User-Agent Strings).
 */

const S_OK = 0;
const E_FAIL = 0x80004005;
const E_INVALIDARG = 0x80070057;
const E_OUTOFMEMORY = 0x8007000e;

/** How many bytes of the data FindMimeFromData looks at, as urlmon does. */
const SNIFFED = 256;

/**
 * The types FindMimeFromData knows by their data, in the order it tries
 * them, with the names urlmon gives them (MIME Type Detection in Internet
 * Explorer): a signature at the start, or a test of the bytes.
 *
 * @type {ReadonlyArray<readonly [string, (bytes: Uint8Array) => boolean]>}
 */
const SNIFFERS = Object.freeze([
    ['text/html', bytes=>/<(html|head|title|body|script|table|a\s+href|pre|img|plaintext)\b/i
        .test(latin1(bytes))],
    ['text/xml', bytes=>/^\s*<\?xml\b/.test(latin1(bytes))],
    ['text/richtext', bytes=>startsWith(bytes, '{\\rtf')],
    ['image/gif', bytes=>startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a')],
    ['image/pjpeg', bytes=>bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8],
    ['image/tiff', bytes=>startsWith(bytes, 'II*\0') || startsWith(bytes, 'MM\0*')],
    ['image/x-png', bytes=>startsWith(bytes, '\x89PNG\r\n\x1a\n')],
    ['image/bmp', bytes=>startsWith(bytes, 'BM') && bytes.length >= 14],
    ['video/avi', bytes=>startsWith(bytes, 'RIFF') && latin1(bytes.subarray(8, 12)) === 'AVI '],
    ['audio/wav', bytes=>startsWith(bytes, 'RIFF') && latin1(bytes.subarray(8, 12)) === 'WAVE'],
    ['application/postscript', bytes=>startsWith(bytes, '%!')],
    ['application/pdf', bytes=>startsWith(bytes, '%PDF')],
    ['application/x-zip-compressed', bytes=>startsWith(bytes, 'PK\x03\x04')],
    ['application/x-gzip-compressed', bytes=>bytes.length >= 2 && bytes[0] === 0x1f
        && bytes[1] === 0x8b],
    ['application/java', bytes=>startsWith(bytes, '\xca\xfe\xba\xbe')],
    ['application/x-msdownload', bytes=>startsWith(bytes, 'MZ')],
]);

/** @param {Uint8Array} bytes */
const latin1 = bytes=>String.fromCharCode(...bytes);
/** @param {Uint8Array} bytes @param {string} text */
const startsWith = (bytes, text)=>bytes.length >= text.length
    && [...text].every((char, index)=>bytes[index] === char.charCodeAt(0));

/**
 * What urlmon makes of data no signature names: text when every byte is one
 * text carries (printable, or tab, line feed, form feed, carriage return,
 * escape), else a stream of bytes.
 *
 * @param {Uint8Array} bytes
 */
const textOrBinary = bytes=>([...bytes].every(byte=>byte >= 0x20 || [9, 10, 12, 13, 27]
    .includes(byte)) ? 'text/plain' : 'application/octet-stream');

/** The data's type by its bytes, or null for none known. @param {Uint8Array} bytes */
export function sniffMime(bytes){
    return SNIFFERS.find(([, matches])=>matches(bytes))?.[0] ?? null;
}

/** The extension of a URL's last path segment, with its dot, or ''. @param {string} url */
export function urlExtension(url){
    const path = url.replace(/[?#].*$/, '');
    const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * What Internet Explorer calls itself on each Windows: the version shipped
 * with it - 6 SP3 on XP, 8 on 7, 11 on 10, which answers with the
 * compatibility token a legacy caller asks for - and 5.01 on 2000.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const USER_AGENTS = Object.freeze({
    win2000: 'Mozilla/4.0 (compatible; MSIE 5.01; Windows NT 5.0)',
    winxp: 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; SV1)',
    win7: 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)',
    win10: 'Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 10.0; Trident/7.0)',
});

/**
 * @param {Object} host
 * @param {string} host.windows  the Windows being run, by name (`versions.js`)
 * @param {(address: number) => number} host.readU32
 * @param {(address: number, value: number) => void} host.writeU32
 * @param {(address: number, bytes: Uint8Array) => void} host.writeMemory
 * @param {(address: number, length: number) => Uint8Array} [host.readMemory]
 * @param {(address: number) => string} [host.readWideString]
 * @param {(bytes: number) => number} [host.allocate]  CoTaskMemAlloc's
 * @param {(extension: string) => string | null} [host.contentType]  the
 *     `Content Type` of HKEY_CLASSES_ROOT's key for an extension
 */
export function createUrlmonFunctions(host){
    const { windows, readU32, writeU32, writeMemory, readMemory, readWideString, allocate,
        contentType } = host;
    const agent = USER_AGENTS[windows] ?? USER_AGENTS.winxp;

    /** A string the caller frees with CoTaskMemFree, or 0. @param {string} text */
    const taskString = text=>{
        const at = allocate?.((text.length + 1) * 2) ?? 0;
        if (at !== 0)
        {
            const bytes = new Uint8Array((text.length + 1) * 2);
            const view = new DataView(bytes.buffer);
            [...text].forEach((char, index)=>view.setUint16(index * 2, char.charCodeAt(0), true));
            writeMemory(at, bytes);
        }
        return at >>> 0;
    };

    return {
        /**
         * HRESULT FindMimeFromData(LPBC pBC, LPCWSTR pwzUrl, LPVOID pBuffer,
         *     DWORD cbSize, LPCWSTR pwzMimeProposed, DWORD dwMimeFlags,
         *     LPWSTR *ppwzMimeOut, DWORD dwReserved)
         *
         * The data's own type when its first bytes name one; else the type
         * the caller proposed; else the one the URL's extension is registered
         * with; else, with data, text or bytes as the data looks. Without
         * data, a URL whose extension is not registered and no proposal is
         * E_FAIL. The answer is the caller's to free with CoTaskMemFree.
         */
        FindMimeFromData: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([, url, buffer, size, proposed, , out])=>{
                if ((out >>> 0) === 0 || ((url >>> 0) === 0 && (buffer >>> 0) === 0))
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const data = (buffer >>> 0) !== 0 && (size >>> 0) !== 0 && readMemory
                    ? readMemory(buffer >>> 0, Math.min(size >>> 0, SNIFFED)) : null;
                const offered = (proposed >>> 0) !== 0 && readWideString
                    ? readWideString(proposed >>> 0) : '';
                const extension = (url >>> 0) !== 0 && readWideString
                    ? urlExtension(readWideString(url >>> 0)) : '';
                const registered = extension ? contentType?.(extension) ?? null : null;
                const found = (data && sniffMime(data)) || offered || registered
                    || (data ? textOrBinary(data) : null);
                if (!found)
                {
                    return E_FAIL;
                }
                const answer = taskString(found);
                if (answer === 0)
                {
                    return E_OUTOFMEMORY;
                }
                writeU32(out, answer);
                return S_OK;
            },
        },

        /**
         * HRESULT ObtainUserAgentString(DWORD dwOption, LPSTR pcszUAOut, DWORD *cbSize)
         *
         * The string and its terminator into the buffer; one too small is
         * E_OUTOFMEMORY with the size it needs written back.
         */
        ObtainUserAgentString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, out, size])=>{
                if ((out >>> 0) === 0 || (size >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const needed = agent.length + 1;
                const room = readU32(size);
                writeU32(size, needed);
                if (room < needed)
                {
                    return E_OUTOFMEMORY;
                }
                const bytes = new Uint8Array(needed);
                for (let i = 0; i < agent.length; i++)
                {
                    bytes[i] = agent.charCodeAt(i);
                }
                writeMemory(out, bytes);
                return S_OK;
            },
        },
    };
}
