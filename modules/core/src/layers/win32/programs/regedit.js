/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * regedit.exe, as a setup runs it: `regedit /s settings.reg` imports a
 * registration file and says nothing; without `/s` it asks first and tells
 * the person when the keys are in, each in a message box of regedit's own
 * words. Started with no file, regedit is the registry's editor, which this
 * machine does not show: that is said, and the program ends.
 *
 *   regedit [/s] <file.reg> [<file.reg> ...]
 *
 * The file is read as regedit reads one (`regfile.js`), and the import goes
 * through advapi32 as any program's would, so what it writes is what every
 * process of the run reads. The exit code is 0, as regedit's is whether or
 * not the import worked; a file it cannot read is told in a box, or nowhere
 * under `/s`.
 */

import { splitArguments, argumentsOf } from './command-line.js';
import { readText } from './notepad.js';
import { importRegEntries, parseRegFile } from './regfile.js';

const MB_OK = 0x0;
const MB_YESNO = 0x4;
const MB_ICONERROR = 0x10;
const MB_ICONWARNING = 0x30;
const MB_ICONINFORMATION = 0x40;
const IDYES = 6;
const CAPTION = 'Registry Editor';

/**
 * What a regedit command line asks for: the files, quotes taken off, and
 * whether it is silent. Other switches (/e export, /v, /m) are named back so
 * the program can refuse them.
 *
 * @param {string} line  The arguments after argv[0].
 * @returns {{ silent: boolean, files: string[], unknown: string[] }}
 */
export function parseRegedit(line){
    const plan = { silent: false, files: /** @type {string[]} */ ([]),
        unknown: /** @type {string[]} */ ([]) };
    for (const { text } of splitArguments(line))
    {
        if (/^[/-]s$/i.test(text))
        {
            plan.silent = true;
        }
        else if (/^[/-]/.test(text))
        {
            plan.unknown.push(text);
        }
        else
        {
            plan.files.push(text);
        }
    }
    return plan;
}

/**
 * Runs regedit over the process's command line.
 *
 * @param {import('./msiexec.js').ProgramContext} context
 * @returns {Promise<number>}
 */
export async function runRegedit(context){
    const plan = parseRegedit(argumentsOf(context.commandLine));
    if (plan.unknown.length > 0 || plan.files.length === 0)
    {
        if (!plan.silent)
        {
            await context.message(plan.files.length === 0
                ? 'The Registry Editor is not shown on this machine.'
                : `Registry Editor here only imports a file: ${plan.unknown.join(' ')}`
                    + ' is not taken.', CAPTION, MB_OK | MB_ICONERROR);
        }
        return 0;
    }
    for (const file of plan.files)
    {
        if (!plan.silent && await context.message('Adding information can unintentionally'
            + ' change or delete values and cause components to stop working correctly. If'
            + ` you do not trust the source of this information in ${file}, do not add it to`
            + ' the registry.\n\nAre you sure you want to continue?', CAPTION,
        MB_YESNO | MB_ICONWARNING) !== IDYES)
        {
            continue;
        }
        const text = await readText(context, file);
        const read = text === null ? null : parseRegFile(text);
        if (read === null || 'error' in read)
        {
            if (!plan.silent)
            {
                await context.message(`Cannot import ${file}: ${read === null
                    ? 'Error opening the file. There may be a disk or file system error.'
                    : 'The specified file is not a registry script. You can only import'
                        + ' binary registry files from within the registry editor.'}`,
                CAPTION, MB_OK | MB_ICONERROR);
            }
            continue;
        }
        const code = await importRegEntries(context, read.entries);
        if (!plan.silent)
        {
            await context.message(code === 0
                ? `The keys and values contained in ${file} have been successfully added to`
                    + ' the registry.'
                : `Cannot import ${file}: Not all data was successfully written to the`
                    + ' registry. Some keys are open by the system or other processes.',
            CAPTION, MB_OK | (code === 0 ? MB_ICONINFORMATION : MB_ICONERROR));
        }
    }
    return 0;
}
