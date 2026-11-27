/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * lodctr.exe and unlodctr.exe: a program's performance counters registered
 * with the system, and taken away.
 *
 * Setups run them from custom actions - the .NET Framework's for every
 * counter set it ships (`LodCtr_WF_x86`, `CA_loadNetworkingPerfCounters_x86`
 * ...). Without them the actions fail with "file not found" and the setup
 * ends with that code, though everything it installs is in place, and its
 * self-extractor then leaves the folder it unpacked into. The engine keeps no
 * performance counters to register them with (Perflib's data is not answered:
 * decision A246), so both answer success and register nothing.
 */

/** @param {import('./msiexec.js').ProgramContext} context @returns {Promise<number>} */
export async function runLodctr(context){
    void context;
    return 0;
}
