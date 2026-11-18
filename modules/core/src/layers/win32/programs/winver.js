/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * winver.exe: the "About Windows" box, which is the shell's about box with
 * the system's name, and a process that ends when it is closed.
 *
 * Programs start it as the one program every Windows has in its system
 * folder - a child to suspend, to read the version of, to terminate - and
 * setups to show which Windows this is. It is the shell's ShellAboutW, as
 * the real one is; whatever that box does here, winver does.
 */

/** @param {import('./msiexec.js').ProgramContext} context @returns {Promise<number>} */
export async function runWinver(context){
    await context.call('SHELL32.dll', 'ShellAboutW', [0, context.wide('Windows'), 0, 0]);
    return 0;
}
