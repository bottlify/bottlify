/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * loadperf - installing a service's performance counter names and help
 * (what `lodctr` and `unlodctr` do), which a setup calls for the counters its
 * service publishes (the .NET Framework's `aspnet_regiis -iru` for ASP.NET's).
 *
 * Nothing here publishes performance data (`HKEY_PERFORMANCE_DATA` answers no
 * counters), so the names would be read by nothing: a load or an unload is
 * taken, said once with its command line, and answers success.
 */

const ERROR_SUCCESS = 0;

/** A command line's length to read; longer than any `lodctr` takes. */
const MAX_LINE = 0x8000;

/**
 * @typedef {Object} LoadperfHost
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {LoadperfHost} host */
export function createLoadperfFunctions(host){
    let said = false;
    /** @param {string} api @param {string} line */
    const taken = (api, line)=>{
        if (!said)
        {
            said = true;
            host.divergence?.(api, `performance counter text is taken and kept nowhere (${line})`);
        }
        return ERROR_SUCCESS;
    };
    /** @param {string} api @param {boolean} wide */
    const entry = (api, wide)=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([line])=>taken(api, (line >>> 0) === 0 ? '' : (wide ? host.readWideString
            : host.readCString)(line >>> 0, MAX_LINE)),
    });
    return {
        // DWORD LoadPerfCounterTextStrings(LPTSTR lpCommandLine, BOOL bQuietModeArg)
        LoadPerfCounterTextStringsA: entry('LoadPerfCounterTextStringsA', false),
        LoadPerfCounterTextStringsW: entry('LoadPerfCounterTextStringsW', true),
        // DWORD UnloadPerfCounterTextStrings(LPTSTR lpCommandLine, BOOL bQuietModeArg)
        UnloadPerfCounterTextStringsA: entry('UnloadPerfCounterTextStringsA', false),
        UnloadPerfCounterTextStringsW: entry('UnloadPerfCounterTextStringsW', true),
    };
}
