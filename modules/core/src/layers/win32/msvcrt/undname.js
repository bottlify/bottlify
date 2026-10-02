/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C++ a decorated type name stands for, as `__unDName` writes it: what
 * `type_info::name()` makes of the name a type descriptor carries.
 *
 * Covered: classes, structures, unions and enumerations, in their namespaces
 * and templates, with back-references; the built-in types; pointers and
 * references with their qualifiers. Not covered: the decorated names of
 * functions and variables, and pointers to members, which answer null -- the
 * answer `__unDName` gives a name it cannot read.
 */

/** @type {Record<string, string>} */
const BASIC = {
    C: 'signed char', D: 'char', E: 'unsigned char', F: 'short', G: 'unsigned short',
    H: 'int', I: 'unsigned int', J: 'long', K: 'unsigned long', M: 'float', N: 'double',
    O: 'long double', X: 'void',
};

/** After an underscore. @type {Record<string, string>} */
const EXTENDED = {
    D: '__int8', E: 'unsigned __int8', F: '__int16', G: 'unsigned __int16', H: '__int32',
    I: 'unsigned __int32', J: '__int64', K: 'unsigned __int64', L: '__int128',
    M: 'unsigned __int128', N: 'bool', W: 'wchar_t',
};

/** A pointee's or a referent's qualifiers. @type {Record<string, string>} */
const QUALIFIERS = { A: '', B: ' const', C: ' volatile', D: ' const volatile' };

/** A pointer's own qualifiers, by its letter. @type {Record<string, string>} */
const POINTERS = { P: '', Q: ' const', R: ' volatile', S: ' const volatile' };

/**
 * @param {string} mangled  A decorated type: `?AVclass@@`, `ABVVec4@ref2@dice@@`.
 * @returns {string | null}
 */
export function undecorateType(mangled){
    let at = 0;

    /** A run of text up to its `@`, which is consumed. */
    const fragment = ()=>{
        const end = mangled.indexOf('@', at);
        if (end <= at)
        {
            throw new SyntaxError('fragment');
        }
        const text = mangled.slice(at, end);
        at = end + 1;
        return text;
    };

    /** `$0`'s number: one digit for 1 to 10, else hex in A to P up to an `@`. */
    const number = ()=>{
        const negative = mangled[at] === '?';
        if (negative)
        {
            at++;
        }
        const first = mangled[at];
        let value = 0;
        if (first >= '0' && first <= '9')
        {
            value = first.charCodeAt(0) - 0x2f;
            at++;
        }
        else
        {
            for (; mangled[at] !== '@'; at++)
            {
                const digit = mangled.charCodeAt(at) - 0x41;
                if (!(digit >= 0 && digit < 16))
                {
                    throw new SyntaxError('number');
                }
                value = value * 16 + digit;
            }
            at++;
        }
        return String(negative ? -value : value);
    };

    /**
     * A qualified name, innermost part first, to its closing `@`. Each part
     * read is remembered, and a digit names one remembered before; a
     * template's arguments remember their own.
     *
     * @param {string[]} remembered
     */
    const name = remembered=>{
        /** @type {string[]} */
        const parts = [];
        while (mangled[at] !== '@')
        {
            if (at >= mangled.length)
            {
                throw new SyntaxError('name');
            }
            const digit = mangled.charCodeAt(at) - 0x30;
            if (digit >= 0 && digit <= 9)
            {
                const earlier = remembered[digit];
                if (earlier === undefined)
                {
                    throw new SyntaxError('back-reference');
                }
                parts.push(earlier);
                at++;
                continue;
            }
            let part;
            if (mangled.startsWith('?$', at))
            {
                at += 2;
                const base = fragment();
                /** @type {string[]} */
                const own = [base];
                /** @type {string[]} */
                const args = [];
                while (mangled[at] !== '@')
                {
                    if (mangled.startsWith('$0', at))
                    {
                        at += 2;
                        args.push(number());
                    }
                    else
                    {
                        args.push(type(own));
                    }
                }
                at++;
                const list = args.join(',');
                part = `${base}<${list}${list.endsWith('>') ? ' ' : ''}>`;
            }
            else
            {
                part = fragment();
            }
            if (remembered.length < 10)
            {
                remembered.push(part);
            }
            parts.push(part);
        }
        at++;
        return parts.reverse().join('::');
    };

    /** @param {string[]} remembered @returns {string} */
    const type = remembered=>{
        const code = mangled[at++];
        if (code === '?' || code === 'A')
        {
            const qualifier = QUALIFIERS[mangled[at++]];
            if (qualifier === undefined)
            {
                throw new SyntaxError('qualifier');
            }
            /** @type {string} */
            const inner = `${type(remembered)}${qualifier}`;
            return code === 'A' ? `${inner} &` : inner;
        }
        if (code in POINTERS)
        {
            const qualifier = QUALIFIERS[mangled[at++]];
            if (qualifier === undefined)
            {
                throw new SyntaxError('pointee');
            }
            return `${type(remembered)}${qualifier} *${POINTERS[code]}`;
        }
        switch (code)
        {
            case 'V': return `class ${name(remembered)}`;
            case 'U': return `struct ${name(remembered)}`;
            case 'T': return `union ${name(remembered)}`;
            case 'W':
                at++;
                return `enum ${name(remembered)}`;
            case '_': {
                const extended = EXTENDED[mangled[at++]];
                if (extended === undefined)
                {
                    throw new SyntaxError('extended');
                }
                return extended;
            }
            default:
                if (BASIC[code] === undefined)
                {
                    throw new SyntaxError('type');
                }
                return BASIC[code];
        }
    };

    try
    {
        const text = type([]);
        return at === mangled.length ? text : null;
    }
    catch (e){
        if (e instanceof SyntaxError)
        {
            return null;
        }
        throw e;
    }
}
