/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The programs Windows keeps in its system folder and this engine provides
 * itself: msiexec, rundll32, regsvr32.
 *
 * Installers, bootstrappers and uninstall strings start them by name -- `MsiExec.exe
 * /X{GUID}`, `rundll32 setupapi,InstallHinfSection ...`, `regsvr32 /s x.dll` --
 * and the volume has no file for any of them. So a request for one in the
 * system folder that the volume cannot answer starts a process like any
 * other, whose image is made here rather than read: a program whose entry
 * point calls its routine in this engine's own library (`PROGRAMS_LIBRARY`)
 * and exits with the answer. Everything after that is the same as for a
 * program a title brought: its own process and worker, its own handles and
 * command line, an exit code the parent waits for and reads.
 *
 * One table, name to routine: a program is added by a row here and a routine
 * of the same name.
 */

import { synthesiseProgram } from '../../loader/internal/synth.js';
import { runMsiexec } from './msiexec.js';
import { runRundll32 } from './rundll32.js';
import { runRegsvr32 } from './regsvr32.js';

/** Where the programs are: GetSystemDirectory's answer. */
export const SYSTEM_DIRECTORY = 'C:\\WINDOWS\\system32';

/**
 * The library whose routines the programs are. Not one of Windows': a name of
 * the engine's own, so it is never a file a program brought.
 */
export const PROGRAMS_LIBRARY = 'bottlify.dll';

/**
 * Each program by its file name, lower case, with the routine that is it.
 *
 * @type {ReadonlyMap<string, { routine: string,
 *     run: (context: import('./msiexec.js').ProgramContext) => Promise<number> }>}
 */
export const SYSTEM_PROGRAMS = new Map([
    ['msiexec.exe', { routine: 'msiexec', run: runMsiexec }],
    ['rundll32.exe', { routine: 'rundll32', run: runRundll32 }],
    ['regsvr32.exe', { routine: 'regsvr32', run: runRegsvr32 }],
]);

/**
 * The program a full path names, when it names one of these in the system
 * folder, whatever its case and whichever slash it uses; null otherwise.
 * Whether the volume has a file there is the caller's to ask first.
 *
 * @param {string} path
 * @returns {string | null}  its routine
 */
export function systemProgramAt(path){
    const normal = path.trim().replaceAll('/', '\\').replace(/\\+/g, '\\').toLowerCase();
    const cut = normal.lastIndexOf('\\');
    if (normal.slice(0, cut) !== SYSTEM_DIRECTORY.toLowerCase())
    {
        return null;
    }
    return SYSTEM_PROGRAMS.get(normal.slice(cut + 1))?.routine ?? null;
}

/**
 * The image of the program a path names, or null when it names none.
 *
 * @param {string} path
 * @returns {Uint8Array | null}
 */
export function systemProgramImage(path){
    const routine = systemProgramAt(path);
    return routine === null ? null
        : synthesiseProgram({ library: PROGRAMS_LIBRARY, routine }).bytes;
}
