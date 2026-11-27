/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether a file name is in a native expression, as NtQueryDirectoryFile's
 * FileName mask is matched (FsRtlIsNameInExpression, ignoring case).
 *
 * The native expression is not FindFirstFile's pattern: `*.*` asks for a dot
 * here, and the DOS forms a Win32 pattern is rewritten into have their own
 * characters (ntifs.h):
 *
 * - `*` any run of characters, `?` exactly one;
 * - `<` (DOS_STAR) any run up to the name's final dot, or up to and taking it;
 * - `>` (DOS_QM) one character, or none at a dot or the name's end, where
 *   the run of DOS_QMs it stands in is passed over;
 * - `"` (DOS_DOT) a dot, or nothing past the name's end.
 *
 * Windows matches "." and ".." as either the one dot or nothing at all: the
 * conformance tests find `?`, `>` and `"` each listing both, and `??` neither.
 * A volume that keeps 8.3 names also matches a name's short form; none is kept
 * here, so a name is matched by its long form alone.
 */

const DOS_STAR = '<';
const DOS_QM = '>';
const DOS_DOT = '"';

/**
 * @param {string} expression
 * @param {string} name
 * @returns {boolean}
 */
export function isNameInExpression(expression, name){
    const e = expression.toUpperCase();
    if (name === '.' || name === '..')
    {
        return matches(e, '.') || matches(e, '');
    }
    return matches(e, name.toUpperCase());
}

/**
 * @param {string} e  the expression, upcased
 * @param {string} n  the name, upcased
 */
function matches(e, n){
    const finalDot = n.lastIndexOf('.');
    const width = n.length + 1;
    // Whether the expression from i matches the name from j, filled from the
    // expression's end back. Every step reads only the row after its own, so
    // two rows a name long are the whole table: a long expression against a
    // long name costs neither the stack nor the expression's length in rows.
    let after = new Uint8Array(width);
    let row = new Uint8Array(width);
    /** @param {number} j */
    const next = j=>after[j] === 1;

    /** @param {number} i @param {number} j @returns {boolean} */
    const step = (i, j)=>{
        switch (e[i])
        {
            case '*':
                for (let k = j; k <= n.length; k++)
                {
                    if (next(k))
                    {
                        return true;
                    }
                }
                return false;
            case '?':
                return j < n.length && next(j + 1);
            case DOS_STAR: {
                // Past the final dot, or with none before it, any run; else a
                // run that stops at the final dot or takes it and no more.
                const last = finalDot < j ? n.length : finalDot + 1;
                for (let k = j; k <= last; k++)
                {
                    if (next(k))
                    {
                        return true;
                    }
                }
                return false;
            }
            case DOS_QM:
                // At a dot or the end a run of them matches nothing, and the
                // expression goes on past the run: the next row says so, as
                // it is another DOS_QM at the same place or what follows.
                if (j === n.length || n[j] === '.')
                {
                    return next(j);
                }
                return next(j + 1);
            case DOS_DOT:
                if (j === n.length)
                {
                    return next(j);
                }
                return n[j] === '.' && next(j + 1);
            default:
                return j < n.length && n[j] === e[i] && next(j + 1);
        }
    };

    after[n.length] = 1;
    for (let i = e.length - 1; i >= 0; i--)
    {
        for (let j = n.length; j >= 0; j--)
        {
            row[j] = step(i, j) ? 1 : 0;
        }
        [after, row] = [row, after];
    }
    return next(0);
}

/**
 * The native expression a Win32 search pattern is (FindFirstFile's last
 * component, rewritten as kernel32 hands it to NtQueryDirectoryFile):
 *
 * - a pattern ending in spaces loses every trailing dot and space; one ending
 *   in a dot loses them too and keeps that one dot, so `* .` and `*..` are `*.`;
 * - `*.*` is `*`, every name;
 * - `?` is DOS_QM; a `.` before a `?` or a `*`, or at the end, is DOS_DOT; a
 *   `*` before a `.` is DOS_STAR. So `*.` is the names with no extension.
 *
 * The rules are read off the conformance tests' table of patterns and what
 * each lists; what that table lists by a name's 8.3 form is not reached, a
 * volume here keeping none.
 *
 * @param {string} pattern
 * @returns {string}
 */
export function win32Expression(pattern){
    const trimmed = /[. ]$/.test(pattern)
        ? pattern.replace(/[. ]+$/, '') + (pattern.endsWith('.') ? '.' : '')
        : pattern;
    if (trimmed === '*.*')
    {
        return '*';
    }
    let out = '';
    for (let i = 0; i < trimmed.length; i++)
    {
        const here = trimmed[i];
        const next = trimmed[i + 1];
        if (here === '?')
        {
            out += DOS_QM;
        }
        else if (here === '.' && (next === '?' || next === '*' || next === undefined))
        {
            out += DOS_DOT;
        }
        else if (here === '*' && next === '.')
        {
            out += DOS_STAR;
        }
        else
        {
            out += here;
        }
    }
    return out;
}
