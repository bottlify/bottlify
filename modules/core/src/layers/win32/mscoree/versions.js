/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which .NET runtimes a bottle with the Mono runtime has, and the legacy shim's
 * answers about them: the versions by name, where each lives, and which one a
 * request for a version gets.
 *
 * Both runtimes a program of the era asks for are there, the 2.0 one (which
 * 3.0 and 3.5 add to) and the 4 one, as Windows 7 with .NET 4 installed has
 * them: Mono runs the assemblies of either. The legacy entry points, which
 * predate .NET 4, see 2.0 as the newest runtime; only a request naming 4
 * exactly is answered with it, as the shim answers on Windows.
 */

/** The runtimes, oldest first, by the names their directories have. */
export const RUNTIME_VERSIONS = Object.freeze(['v2.0.50727', 'v4.0.30319']);

/**
 * The libraries of the engine's own that a runtime's directory holds, each
 * standing in `<windows>\Microsoft.NET\Framework\<version>` as in the system
 * folder (A41): LoadLibraryShim and ICLRRuntimeInfo::LoadLibrary find them
 * there.
 */
export const RUNTIME_LIBRARIES = Object.freeze(['fusion.dll']);

/**
 * The runtimes' directories, which a runtime library stands in.
 *
 * @param {string} windows  the Windows folder
 */
export const runtimeDirectories = windows=>RUNTIME_VERSIONS.map(version=>
    `${windows}\\Microsoft.NET\\Framework\\${version}`);

/** The newest runtime the legacy entry points (GetCORVersion and kin) hand out. */
export const LATEST_LEGACY = 'v2.0.50727';

/** RUNTIME_INFO_UPGRADE_VERSION: an older version asked for is given the newest legacy one. */
export const RUNTIME_INFO_UPGRADE_VERSION = 0x1;

/**
 * A version string's numbers, or null for one that is not `v` and dotted numbers.
 *
 * @param {string} text
 * @returns {number[] | null}
 */
export function versionNumbers(text){
    const match = /^[vV](\d+(?:\.\d+)*)$/.exec(text);
    return match ? match[1].split('.').map(Number) : null;
}

/**
 * The installed runtime a version names exactly, without regard to the case
 * of its `v`, or null.
 *
 * @param {string} version
 * @returns {string | null}
 */
export function exactRuntime(version){
    return RUNTIME_VERSIONS.find(known=>known.toLowerCase() === version.toLowerCase()) ?? null;
}

/**
 * The runtime GetRequestedRuntimeInfo answers a request with, and the version
 * string it hands back, or null when there is none (CLR_E_SHIM_RUNTIME).
 *
 * A version named exactly is that runtime, and the string handed back is the
 * one asked with, its case kept. Otherwise only RUNTIME_INFO_UPGRADE_VERSION
 * finds one: no version, or one no newer than the newest legacy runtime, is
 * given that runtime; a newer one, or no flag, is none.
 *
 * @param {string | null} version  null for none given
 * @param {number} flags  RUNTIME_INFO_FLAGS
 * @returns {{ runtime: string, shown: string } | null}
 */
export function requestedRuntime(version, flags){
    const exact = version === null ? null : exactRuntime(version);
    if (exact !== null && version !== null)
    {
        return { runtime: exact, shown: version };
    }
    if ((flags & RUNTIME_INFO_UPGRADE_VERSION) === 0)
    {
        return null;
    }
    if (version === null)
    {
        return { runtime: LATEST_LEGACY, shown: LATEST_LEGACY };
    }
    const asked = versionNumbers(version);
    const latest = /** @type {number[]} */ (versionNumbers(LATEST_LEGACY));
    if (asked === null)
    {
        return null;
    }
    for (let i = 0; i < Math.max(asked.length, latest.length); i++)
    {
        const a = asked[i] ?? 0;
        const b = latest[i] ?? 0;
        if (a !== b)
        {
            return a < b ? { runtime: LATEST_LEGACY, shown: LATEST_LEGACY } : null;
        }
    }
    return { runtime: LATEST_LEGACY, shown: LATEST_LEGACY };
}
