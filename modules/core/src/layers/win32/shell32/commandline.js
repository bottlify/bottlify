/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A command line split into the arguments CommandLineToArgvW answers with.
 *
 * The first argument is the program, and it is read by a rule of its own,
 * because it is a path and a path's separators are backslashes: quoted, it
 * runs to the next quote, and unquoted to the first space or tab, a
 * backslash being an ordinary character either way -- `"C:\dir\"` is the
 * directory, not the start of an escaped quote. A line that starts with
 * white space therefore has an empty program, as the documentation says.
 *
 * The rest are separated by spaces and tabs outside quotes, as the C runtime
 * of the same era reads them:
 *
 * - 2n backslashes and a quote are n backslashes, and the quote opens or
 *   closes a quoted part;
 * - 2n+1 backslashes and a quote are n backslashes and a quote;
 * - backslashes before anything else are themselves;
 * - inside a quoted part, two quotes in a row are a quote, and close it.
 *
 * White space at the end makes no argument, and `""` makes an empty one.
 */

/** @param {string | undefined} character */
const isBlank = character=>character === ' ' || character === '\t';

/**
 * @param {string} line
 * @returns {string[]}
 */
export function splitCommandLine(line){
    let at = 0;
    /** @type {string[]} */
    const args = [];
    if (line.startsWith('"'))
    {
        const close = line.indexOf('"', 1);
        args.push(close < 0 ? line.slice(1) : line.slice(1, close));
        at = close < 0 ? line.length : close + 1;
    }
    else
    {
        while (at < line.length && !isBlank(line[at]))
        {
            at++;
        }
        args.push(line.slice(0, at));
    }

    /** The argument being read, or null between arguments. @type {string | null} */
    let arg = null;
    let quoted = false;
    while (at < line.length)
    {
        const character = line[at];
        if (!quoted && isBlank(character))
        {
            if (arg !== null)
            {
                args.push(arg);
                arg = null;
            }
            at++;
            continue;
        }
        arg ??= '';
        if (character === '\\')
        {
            let run = 0;
            while (line[at] === '\\')
            {
                run++;
                at++;
            }
            if (line[at] !== '"')
            {
                arg += '\\'.repeat(run);
                continue;
            }
            arg += '\\'.repeat(run >>> 1);
            if ((run & 1) !== 0)
            {
                arg += '"';
                at++;
            }
            // After an even run the quote is left to open or close.
            continue;
        }
        if (character !== '"')
        {
            arg += character;
            at++;
            continue;
        }
        if (quoted && line[at + 1] === '"')
        {
            arg += '"';
            quoted = false;
            at += 2;
            continue;
        }
        quoted = !quoted;
        at++;
    }
    if (arg !== null)
    {
        args.push(arg);
    }
    return args;
}
