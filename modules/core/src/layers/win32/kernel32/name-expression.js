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
    /** @type {Map<number, boolean>} */
    const memo = new Map();

    /** @param {number} i @param {number} j @returns {boolean} */
    const from = (i, j)=>{
        const key = i * (n.length + 1) + j;
        const known = memo.get(key);
        if (known !== undefined)
        {
            return known;
        }
        const answer = step(i, j);
        memo.set(key, answer);
        return answer;
    };

    /** @param {number} i @param {number} j @returns {boolean} */
    const step = (i, j)=>{
        if (i === e.length)
        {
            return j === n.length;
        }
        switch (e[i])
        {
            case '*':
                for (let k = j; k <= n.length; k++)
                {
                    if (from(i + 1, k))
                    {
                        return true;
                    }
                }
                return false;
            case '?':
                return j < n.length && from(i + 1, j + 1);
            case DOS_STAR: {
                // Past the final dot, or with none before it, any run; else a
                // run that stops at the final dot or takes it and no more.
                const last = finalDot < j ? n.length : finalDot + 1;
                for (let k = j; k <= last; k++)
                {
                    if (from(i + 1, k))
                    {
                        return true;
                    }
                }
                return false;
            }
            case DOS_QM: {
                if (j === n.length || n[j] === '.')
                {
                    let past = i;
                    while (e[past] === DOS_QM)
                    {
                        past++;
                    }
                    return from(past, j);
                }
                return from(i + 1, j + 1);
            }
            case DOS_DOT:
                if (j === n.length)
                {
                    return from(i + 1, j);
                }
                return n[j] === '.' && from(i + 1, j + 1);
            default:
                return j < n.length && n[j] === e[i] && from(i + 1, j + 1);
        }
    };
    return from(0, 0);
}
