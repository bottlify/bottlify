/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A system program's command line, as the program itself reads it.
 *
 * Windows hands a process one string, and each program splits it its own way:
 * msiexec keeps a property's quotes for the installer to read, rundll32 hands
 * everything after its entry point to the library untouched. So the split here
 * keeps, for every argument, both its text and where it stands in the line,
 * and each program takes what it needs of the two.
 */

/**
 * @typedef {Object} Argument
 * @property {string} raw    As typed, quotes and all.
 * @property {string} text   With its quotes taken out.
 * @property {number} start  Where it begins in the line it was split from.
 * @property {number} end    Where it ends there.
 */

/** @param {string} unit */
const isBlank = unit=>unit === ' ' || unit === '\t';

/**
 * What follows argv[0]: the program's name ends at its closing quote when it
 * opens with one, at the first space or tab otherwise -- as CommandLineToArgvW
 * reads it -- and the blanks after it are not part of the arguments.
 *
 * @param {string} commandLine
 * @returns {string}
 */
export function argumentsOf(commandLine){
    let at = 0;
    if (commandLine.startsWith('"'))
    {
        const close = commandLine.indexOf('"', 1);
        at = close < 0 ? commandLine.length : close + 1;
    }
    else
    {
        while (at < commandLine.length && !isBlank(commandLine[at]))
        {
            at++;
        }
    }
    while (at < commandLine.length && isBlank(commandLine[at]))
    {
        at++;
    }
    return commandLine.slice(at);
}

/**
 * The arguments of a line: runs of anything but spaces and tabs, where a
 * quote starts a stretch in which those are ordinary characters, until the
 * next quote. A backslash is an ordinary character -- a path ending in one
 * before its closing quote (`"C:\Setup\"`) is the folder it names -- which is
 * how these programs read their paths.
 *
 * @param {string} line
 * @returns {Argument[]}
 */
export function splitArguments(line){
    /** @type {Argument[]} */
    const found = [];
    let at = 0;
    while (at < line.length)
    {
        while (at < line.length && isBlank(line[at]))
        {
            at++;
        }
        if (at >= line.length)
        {
            break;
        }
        const start = at;
        let quoted = false;
        let text = '';
        while (at < line.length && (quoted || !isBlank(line[at])))
        {
            if (line[at] === '"')
            {
                quoted = !quoted;
            }
            else
            {
                text += line[at];
            }
            at++;
        }
        found.push({ raw: line.slice(start, at), text, start, end: at });
    }
    return found;
}

/**
 * Where the first of a set of characters is in a line, outside quotes; -1
 * when there is none.
 *
 * @param {string} line @param {string} wanted
 * @returns {number}
 */
export function indexOutsideQuotes(line, wanted){
    let quoted = false;
    for (let at = 0; at < line.length; at++)
    {
        if (line[at] === '"')
        {
            quoted = !quoted;
        }
        else if (!quoted && wanted.includes(line[at]))
        {
            return at;
        }
    }
    return -1;
}

/** @param {string} text  An argument with its quotes still in. */
export const unquote = text=>text.replaceAll('"', '');
