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
 * Explorer calls itself. A library that does not load fails the whole module
 * that imports it, whatever else the module does. The string is the one the
 * Windows being run ships its Internet Explorer with, as Microsoft documents
 * each version's (Understanding User-Agent Strings).
 */

const S_OK = 0;
const E_INVALIDARG = 0x80070057;
const E_OUTOFMEMORY = 0x8007000e;

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
 */
export function createUrlmonFunctions({ windows, readU32, writeU32, writeMemory }){
    const agent = USER_AGENTS[windows] ?? USER_AGENTS.winxp;
    return {
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
