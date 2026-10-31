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
import { parsePe, rvaToFileOffset } from '../../loader/internal/pe.js';
import { findResource } from '../../loader/internal/resources.js';
import { versionStringOf } from '../version/functions.js';
import { DSETUPERR_SUCCESS } from '../dsetup/functions.js';
import { runMsiexec } from './msiexec.js';
import { runRundll32 } from './rundll32.js';
import { runRegsvr32 } from './regsvr32.js';
import { runNotepad } from './notepad.js';

/** Where the programs are: GetSystemDirectory's answer. */
export const SYSTEM_DIRECTORY = 'C:\\WINDOWS\\system32';

/**
 * The library whose routines the programs are. Not one of Windows': a name of
 * the engine's own, so it is never a file a program brought.
 */
export const PROGRAMS_LIBRARY = 'bottlify.dll';

/** The Windows directory, where Notepad is too. */
export const WINDOWS_DIRECTORY = 'C:\\WINDOWS';

/**
 * Each program by its file name, lower case, with the routine that is it and
 * the directories Windows keeps it in -- the system folder, and for Notepad
 * the Windows directory as well, where setups name it.
 *
 * @type {ReadonlyMap<string, { routine: string, directories?: string[],
 *     run: (context: import('./msiexec.js').ProgramContext) => Promise<number> }>}
 */
export const SYSTEM_PROGRAMS = new Map([
    ['msiexec.exe', { routine: 'msiexec', run: runMsiexec }],
    ['rundll32.exe', { routine: 'rundll32', run: runRundll32 }],
    ['regsvr32.exe', { routine: 'regsvr32', run: runRegsvr32 }],
    ['notepad.exe', { routine: 'notepad', run: runNotepad,
        directories: [WINDOWS_DIRECTORY, SYSTEM_DIRECTORY] }],
]);

/**
 * The programs a title brings that the engine runs in their place, known by
 * what their version block says they are rather than by a file name.
 *
 * DirectX's redistributable setup: DirectX 9.0c is part of this system, and
 * the drawing layer answers every DirectX library whatever a setup copies.
 * Run, it found XP's own DirectX files missing from the system folder, copied
 * them in, and answered "succeeded, restart needed" -- which a game's
 * installer stops at. In its place it puts nothing down and succeeds, with no
 * window: the licence it shows is for files it would not install.
 *
 * @type {readonly { routine: string, company: string, original: string,
 *     run: (context: import('./msiexec.js').ProgramContext) => Promise<number> }[]}
 */
export const PROGRAMS_IN_PLACE = [
    { routine: 'dxsetup', company: 'Microsoft Corporation', original: 'dxsetup.exe',
        run: async()=>DSETUPERR_SUCCESS },
];

const RT_VERSION = 16;

/**
 * The image the engine runs in place of an executable it knows by its version
 * block (`PROGRAMS_IN_PLACE`), or null for every other.
 *
 * @param {Uint8Array} executable
 * @returns {Uint8Array | null}
 */
export function programInPlaceOf(executable){
    let block;
    try
    {
        const image = parsePe(executable, { wide: true });
        const found = findResource(executable, image, RT_VERSION, 1);
        const at = found ? rvaToFileOffset(image, found.rva) : -1;
        block = found && at >= 0 ? executable.subarray(at, at + found.size) : null;
    }
    catch {
        return null;
    }
    const company = block && versionStringOf(block, 'CompanyName');
    const original = block && versionStringOf(block, 'OriginalFilename')?.toLowerCase();
    const program = PROGRAMS_IN_PLACE.find(each=>each.company === company
        && each.original === original);
    return program ? synthesiseProgram({ library: PROGRAMS_LIBRARY, routine: program.routine })
        .bytes : null;
}

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
    const program = SYSTEM_PROGRAMS.get(normal.slice(cut + 1));
    const directories = program?.directories ?? [SYSTEM_DIRECTORY];
    return program && directories.some(each=>each.toLowerCase() === normal.slice(0, cut))
        ? program.routine : null;
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
