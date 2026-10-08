/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * rundll32.exe: a library's routine run as a program.
 *
 * `rundll32 library,entry arguments` loads the library and calls the entry as
 * Microsoft documents a rundll32 entry point (KB164787):
 *
 *     void CALLBACK Entry(HWND hwnd, HINSTANCE hinst, LPSTR lpszCmdLine, int nCmdShow)
 *
 * on the program's own thread, with everything after the entry's name as the
 * command line. A library that exports `EntryW` is asked for that first and
 * handed the line as UTF-16; then `EntryA` and `Entry`, handed it in the ANSI
 * code page. The window is a hidden one of the program's own, which is what a
 * routine that shows anything uses as its owner.
 */

import { argumentsOf, indexOutsideQuotes, splitArguments, unquote } from './command-line.js';

/** SW_SHOWDEFAULT: how a window is shown when the starter said nothing. */
const SW_SHOWDEFAULT = 10;
const MB_ICONERROR = 0x10;
/** The predefined class the hidden owner window is made of: nothing to register. */
const STUB_CLASS = 'STATIC';

/**
 * @typedef {Object} Rundll32Plan
 * @property {string} library  As named, for LoadLibrary to find.
 * @property {string} entry    The routine's name, or `#n` for its ordinal; '' for none.
 * @property {string} commandLine  Everything after it, as typed.
 */

/**
 * What a rundll32 command line names: the library before the first comma
 * outside quotes in the first argument, the entry after it -- or, with no
 * comma there, the next argument -- and the rest of the line, as typed, from
 * the first character after the entry that is not a blank.
 *
 * @param {string} line  The arguments after argv[0].
 * @returns {Rundll32Plan | null}  null when no library was named.
 */
export function parseRundll32(line){
    const args = splitArguments(line);
    if (args.length === 0)
    {
        return null;
    }
    const [first, second] = args;
    const comma = indexOutsideQuotes(first.raw, ',');
    let library = first.text;
    let entry = '';
    let after = first.end;
    if (comma >= 0)
    {
        library = unquote(first.raw.slice(0, comma));
        entry = unquote(first.raw.slice(comma + 1));
    }
    if (entry === '' && second)
    {
        // `library entry` and `library, entry` both name it in the next argument.
        entry = second.text;
        after = second.end;
    }
    return {
        library: library.trim(),
        entry: entry.trim(),
        commandLine: line.slice(after).replace(/^[ \t]+/, ''),
    };
}

/** @param {string} entry  An ordinal is `#` and its number. */
const ordinalOf = entry=>(/^#\d+$/.test(entry) ? Number(entry.slice(1)) : null);

/**
 * Runs rundll32 over the process's command line. It answers 0, whatever the
 * routine did: the routine returns nothing.
 *
 * @param {import('./msiexec.js').ProgramContext} context
 * @returns {Promise<number>}
 */
export async function runRundll32(context){
    const plan = parseRundll32(argumentsOf(context.commandLine));
    if (!plan || plan.library === '' || plan.entry === '')
    {
        return 0;
    }
    /** @param {string} name @param {number[]} args */
    const kernel32 = (name, args)=>context.call('KERNEL32.dll', name, args);
    const module = await kernel32('LoadLibraryW', [context.wide(plan.library)]);
    if (!module)
    {
        await context.message(`There was a problem starting ${plan.library}\n\n`
            + 'The specified module could not be found.', 'RunDLL', MB_ICONERROR);
        return 0;
    }
    const ordinal = ordinalOf(plan.entry);
    let unicode = false;
    let routine = 0;
    if (ordinal !== null)
    {
        routine = await kernel32('GetProcAddress', [module, ordinal]);
    }
    else
    {
        for (const [suffix, wide] of /** @type {[string, boolean][]} */ (
            [['W', true], ['A', false], ['', false]]))
        {
            routine = await kernel32('GetProcAddress',
                [module, context.ansi(`${plan.entry}${suffix}`)]);
            if (routine)
            {
                unicode = wide;
                break;
            }
        }
    }
    if (!routine)
    {
        await context.message(`Error in ${plan.library}\nMissing entry:${plan.entry}`,
            'RunDLL', MB_ICONERROR);
        await kernel32('FreeLibrary', [module]);
        return 0;
    }
    const owner = await context.call('USER32.dll', 'CreateWindowExW', [0,
        context.wide(STUB_CLASS), context.wide(''), 0, 0, 0, 0, 0, 0, 0, module, 0]);
    const line = unicode ? context.wide(plan.commandLine) : context.ansi(plan.commandLine);
    await context.callGuest(routine, [owner, module, line, SW_SHOWDEFAULT]);
    if (owner)
    {
        await context.call('USER32.dll', 'DestroyWindow', [owner]);
    }
    await kernel32('FreeLibrary', [module]);
    return 0;
}
