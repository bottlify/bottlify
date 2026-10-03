/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * dsetup — the DirectX setup library, as the runtime's own setup leaves it in
 * the system directory.
 *
 * A game's autorun asks it which DirectX the machine has before it decides
 * whether to install one: it loads `dsetup.dll` by name, looks up
 * `DirectXSetupGetVersion` and `DirectXSetupA`, and a library that does not
 * load reads as no DirectX at all -- the installer then refuses, or starts a
 * runtime install, whatever the registry says. The version answered is the
 * one the registry and every DirectX file on this machine carry, 9.0c, and
 * setup has nothing to put down: every interface a runtime installs is one
 * the drawing layer already answers for.
 */

import { DIRECTX_VERSION } from '../advapi32/registry.js';

/** DirectXSetup's answer when everything is in place and no restart is needed. */
export const DSETUPERR_SUCCESS = 0;

/**
 * The version as DirectXSetupGetVersion hands it out: the major and minor
 * numbers in one DWORD, high word first, and the release and build in the
 * other, each the decimal number the dotted form spells, as a file version's
 * words are -- `4.09.00.0904` is 0x00040009 and 0x00000388.
 */
export const versionWords = (version = DIRECTX_VERSION)=>{
    const [major, minor, release, build] = version.split('.').map(Number);
    return { version: (major << 16 | minor) >>> 0, revision: (release << 16 | build) >>> 0 };
};

/** The default release's words. */
export const DIRECTX_VERSION_WORDS = versionWords();

/**
 * @typedef {Object} DsetupHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {string} [directx]  The version the bottle reports; absent, 9.0c.
 */

/** @param {number} value */
const dword = value=>Uint8Array.of(value & 0xff, value >>> 8 & 0xff,
    value >>> 16 & 0xff, value >>> 24 & 0xff);

/**
 * @param {DsetupHost} host
 */
export function createDsetupFunctions(host){
    const words = versionWords(host.directx);
    /**
     * INT DirectXSetupA(HWND hWnd, LPSTR lpszRootPath, DWORD dwFlags)
     * INT DirectXSetupW(HWND hWnd, LPWSTR lpszRootPath, DWORD dwFlags)
     *
     * Installs the runtime from the redistributable at the path. What it would
     * copy is no newer than what is here, so it copies nothing and says the
     * install succeeded without a restart, which is what a caller that
     * installs whenever it is unsure goes on from.
     */
    const setup = {
        argBytes: 12,
        handler: ()=>DSETUPERR_SUCCESS,
    };

    return {
        /**
         * INT DirectXSetupGetVersion(DWORD *pdwVersion, DWORD *pdwMinorVersion)
         *
         * TRUE, with the installed version in whichever of the two the caller
         * passed; either may be NULL when that half is not wanted.
         */
        DirectXSetupGetVersion: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([version, revision])=>{
                if ((version >>> 0) !== 0)
                {
                    host.writeMemory(version >>> 0, dword(words.version));
                }
                if ((revision >>> 0) !== 0)
                {
                    host.writeMemory(revision >>> 0, dword(words.revision));
                }
                return 1;
            },
        },

        DirectXSetupA: setup,
        DirectXSetupW: setup,
    };
}
