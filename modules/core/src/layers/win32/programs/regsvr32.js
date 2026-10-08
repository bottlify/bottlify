/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * regsvr32.exe: a library asked to register itself.
 *
 * `regsvr32 [/u] [/s] [/n] [/i[:cmdline]] library...` loads each library and
 * calls what it exports for the purpose: DllRegisterServer, or with /u
 * DllUnregisterServer; with /i also DllInstall(bInstall, cmdline), and with
 * /n /i that alone. OLE is initialised around the calls, as a registration
 * that creates objects needs. Without /s each outcome is told in a message
 * box, the program's only output.
 *
 * Its exit code says how far it got, by the constants of the regsvr32 sample
 * Microsoft shipped with Visual C++: 0, or 1 for the arguments, 2 for OLE, 3
 * for a library that did not load, 4 for an entry it does not export, 5 for
 * an entry that answered a failure.
 */

import { argumentsOf, splitArguments } from './command-line.js';

export const REGSVR32_EXIT = Object.freeze({
    SUCCESS: 0, FAIL_ARGS: 1, FAIL_OLE: 2, FAIL_LOAD: 3, FAIL_ENTRY: 4, FAIL_REG: 5,
});

/** LoadLibraryEx's flag that finds a library's own dependencies beside it. */
const LOAD_WITH_ALTERED_SEARCH_PATH = 0x8;
const MB_ICONERROR = 0x10;
const MB_ICONINFORMATION = 0x40;
const CAPTION = 'RegSvr32';
const USAGE = 'Usage: regsvr32 [/u] [/s] [/n] [/i[:cmdline]] dllname\n'
    + '/u - Unregister server\n/s - Silent; display no message boxes\n'
    + '/i - Call DllInstall passing it an optional [cmdline]; '
    + 'when it is used with /u, it calls dll uninstall\n'
    + '/n - do not call DllRegisterServer; this option must be used with /i';

/**
 * @typedef {Object} Regsvr32Plan
 * @property {boolean} silent
 * @property {boolean} unregister
 * @property {boolean} install     /i: DllInstall is called.
 * @property {string} installLine  What DllInstall is handed.
 * @property {boolean} register    False for /n: no DllRegisterServer or DllUnregisterServer.
 * @property {string[]} libraries
 * @property {string | null} error  Why the line is refused; null when it is not.
 */

/**
 * What a regsvr32 command line asks for. Options open with `/` or `-` and are
 * read without regard to case; /c, the console output of the oldest
 * versions, is accepted and changes nothing. Everything else is a library.
 *
 * @param {string} line  The arguments after argv[0].
 * @returns {Regsvr32Plan}
 */
export function parseRegsvr32(line){
    /** @type {Regsvr32Plan} */
    const plan = { silent: false, unregister: false, install: false, installLine: '',
        register: true, libraries: [], error: null };
    for (const { text } of splitArguments(line))
    {
        if (!/^[/-]./.test(text))
        {
            plan.libraries.push(text);
            continue;
        }
        const option = text.slice(1).toLowerCase();
        if (option === 's')
        {
            plan.silent = true;
        }
        else if (option === 'u')
        {
            plan.unregister = true;
        }
        else if (option === 'n')
        {
            plan.register = false;
        }
        else if (option === 'c')
        {
            // The console flag of the oldest regsvr32: nothing to change here.
        }
        else if (option === 'i' || option.startsWith('i:'))
        {
            plan.install = true;
            plan.installLine = text.slice(3);
        }
        else
        {
            plan.error = `Unrecognized flag: ${text}`;
        }
    }
    if (plan.error === null && !plan.register && !plan.install)
    {
        plan.error = '/n must be used with /i';
    }
    if (plan.error === null && plan.libraries.length === 0)
    {
        plan.error = 'No DLL name specified.';
    }
    return plan;
}

/** @param {number} hresult */
const failed = hresult=>(hresult | 0) < 0;
/** @param {number} hresult */
const hex = hresult=>`0x${(hresult >>> 0).toString(16).padStart(8, '0')}`;

/**
 * Runs regsvr32 over the process's command line; its answer is the exit code,
 * the first failure's when a library of several fails, and the libraries after
 * it are not tried.
 *
 * @param {import('./msiexec.js').ProgramContext} context
 * @returns {Promise<number>}
 */
export async function runRegsvr32(context){
    const plan = parseRegsvr32(argumentsOf(context.commandLine));
    /** @param {string} text @param {number} icon */
    const tell = async(text, icon)=>{
        if (!plan.silent)
        {
            await context.message(text, CAPTION, icon);
        }
    };
    if (plan.error !== null)
    {
        await tell(`${plan.error}\n\n${USAGE}`, MB_ICONERROR);
        return REGSVR32_EXIT.FAIL_ARGS;
    }
    /** @param {string} name @param {number[]} args */
    const kernel32 = (name, args)=>context.call('KERNEL32.dll', name, args);
    if (failed(await context.call('ole32.dll', 'OleInitialize', [0])))
    {
        await tell('OleInitialize failed.', MB_ICONERROR);
        return REGSVR32_EXIT.FAIL_OLE;
    }
    try
    {
        for (const library of plan.libraries)
        {
            const module = await kernel32('LoadLibraryExW',
                [context.wide(library), 0, LOAD_WITH_ALTERED_SEARCH_PATH]);
            if (!module)
            {
                await tell(`The module "${library}" failed to load.\n\nMake sure the binary is`
                    + ' stored at the specified path or debug it to check for problems with the'
                    + ' binary or dependent .DLL files.', MB_ICONERROR);
                return REGSVR32_EXIT.FAIL_LOAD;
            }
            const server = plan.unregister ? 'DllUnregisterServer' : 'DllRegisterServer';
            // Registering installs after the server is registered; unregistering
            // uninstalls first, undoing the two in the other order.
            const steps = plan.unregister
                ? [plan.install && 'DllInstall', plan.register && server]
                : [plan.register && server, plan.install && 'DllInstall'];
            /** @type {string[]} */
            const done = [];
            for (const step of steps.filter(each=>typeof each === 'string'))
            {
                const routine = await kernel32('GetProcAddress', [module, context.ansi(step)]);
                if (!routine)
                {
                    await kernel32('FreeLibrary', [module]);
                    await tell(`The module "${library}" was loaded but the entry-point ${step}`
                        + ` was not found.\n\nMake sure that "${library}" is a valid DLL or OCX`
                        + ' file and then try again.', MB_ICONERROR);
                    return REGSVR32_EXIT.FAIL_ENTRY;
                }
                const answer = step === 'DllInstall'
                    ? await context.callGuest(routine,
                        [plan.unregister ? 0 : 1, context.wide(plan.installLine)])
                    : await context.callGuest(routine, []);
                if (failed(answer))
                {
                    await kernel32('FreeLibrary', [module]);
                    await tell(`The module "${library}" was loaded but the call to ${step}`
                        + ` failed with error code ${hex(answer)}.`, MB_ICONERROR);
                    return REGSVR32_EXIT.FAIL_REG;
                }
                done.push(step);
            }
            await kernel32('FreeLibrary', [module]);
            await tell(`${done.join(' and ')} in ${library} succeeded.`, MB_ICONINFORMATION);
        }
        return REGSVR32_EXIT.SUCCESS;
    }
    finally
    {
        await context.call('ole32.dll', 'OleUninitialize', []);
    }
}
