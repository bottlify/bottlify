/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a Visual C++ decorated name says about the call behind it: the calling
 * convention, and how many bytes of arguments the callee takes off the stack.
 *
 * An import nothing implements still has to return to its caller with the
 * stack where the caller expects it. A C name carries that in its decoration
 * (`_name@8`); a C++ name carries it in its type -- the convention is a letter,
 * and the argument bytes are the sum of the parameter types' sizes. A member
 * function of a C runtime's exception class is `thiscall`, and a stub that
 * returned from it as `cdecl` left the caller's stack short by its arguments.
 *
 * Only as much of the grammar is read as it takes to find where each
 * parameter ends: names, templates, pointers and references to anything, and
 * the back-references that shorten a repeated one. What the name does not
 * carry is answered as not known: the size of a class passed or returned by
 * value, and whether a constructor takes the hidden flag a class with virtual
 * bases passes to it.
 */

/** @typedef {'cdecl' | 'pascal' | 'thiscall' | 'stdcall' | 'fastcall'} Convention */

/** The convention letters, in their pairs: the second of each is the `__far` form. */
const CONVENTIONS = /** @type {Record<string, Convention>} */ ({
    A: 'cdecl', B: 'cdecl', C: 'pascal', D: 'pascal', E: 'thiscall', F: 'thiscall',
    G: 'stdcall', H: 'stdcall', I: 'fastcall', J: 'fastcall',
});

/** Access letters of a member function that has a `this`, which is qualified next. */
const MEMBER = 'ABEFIJMNQRUV';
/** Access letters of a static member function, and of a free one. */
const STATIC = 'CDKLSTYZ';

/** Sizes on the stack of the single-letter types; every one is pushed as at least a dword. */
const PRIMITIVE = /** @type {Record<string, number>} */ ({
    C: 4, D: 4, E: 4, F: 4, G: 4, H: 4, I: 4, J: 4, K: 4, M: 4, N: 8, O: 8,
});
/** The same for the `_`-prefixed ones: the 64-bit integers, bool, wchar_t and friends. */
const EXTENDED = /** @type {Record<string, number>} */ ({
    D: 4, E: 4, F: 4, G: 4, H: 4, I: 4, J: 8, K: 8, N: 4, S: 4, U: 4, W: 4, Q: 4,
});

/** Thrown out of the reader for a spelling it does not follow; answered as "not known". */
class Unreadable extends Error {}

/**
 * @typedef {Object} MangledCall
 * @property {Convention} convention
 * @property {number | null} argBytes
 *   What the callee pops: every parameter, and the hidden pointer a class
 *   returned by value is written through -- null when some size is not in
 *   the name. Zero for `cdecl`, whose caller pops.
 */

/**
 * @param {string} name  As an import names it.
 * @returns {MangledCall | null} null when the name is not a decorated function
 */
export function mangledCall(name){
    if (!name.startsWith('?'))
    {
        return null;
    }
    let at = 1;

    const peek = ()=>name[at];
    const next = ()=>{
        if (at >= name.length)
        {
            throw new Unreadable(name);
        }
        return name[at++];
    };
    /** @param {string} expected */
    const expect = expected=>{
        if (next() !== expected)
        {
            throw new Unreadable(name);
        }
    };

    /** A plain identifier, up to and including its '@'. */
    const identifier = ()=>{
        const end = name.indexOf('@', at);
        if (end < 0)
        {
            throw new Unreadable(name);
        }
        at = end + 1;
    };

    /** A qualified name: fragments up to the '@' that ends it. */
    const qualified = ()=>{
        while (peek() !== '@')
        {
            fragment();
        }
        at++;
    };

    const fragment = ()=>{
        const first = next();
        if (first >= '0' && first <= '9')
        {
            return;
        }
        if (first !== '?')
        {
            at--;
            identifier();
            return;
        }
        if (peek() === '$')
        {
            at++;
            template();
            return;
        }
        throw new Unreadable(name);
    };

    /**
     * The parameter types seen so far, by size, for the digits that refer back
     * to them. Only a type spelled in more than one character is kept, and a
     * template's arguments keep their own.
     *
     * @type {(number | null)[]}
     */
    let seen = [];

    /** A template's name, then its arguments up to the '@' that closes them. */
    const template = ()=>{
        const outer = seen;
        seen = [];
        if (peek() === '?')
        {
            at++;
            operator();
        }
        else
        {
            identifier();
        }
        while (peek() !== '@')
        {
            argument();
        }
        at++;
        seen = outer;
    };

    /** A template argument: a type, or one of the `$` constants. */
    const argument = ()=>{
        if (peek() !== '$' || name[at + 1] === '$')
        {
            type();
            return;
        }
        at++;
        const kind = next();
        if (kind === '0')
        {
            number();
            return;
        }
        throw new Unreadable(name);
    };

    /** An encoded integer: a digit for 1 to 10, or hex letters up to '@', or '?' first for negative. */
    const number = ()=>{
        if (peek() === '?')
        {
            at++;
        }
        const first = next();
        if (first >= '0' && first <= '9')
        {
            return;
        }
        at--;
        identifier();
    };

    /**
     * An operator's code: one character, or two after an underscore.
     *
     * @returns {string}
     */
    const operator = ()=>{
        const code = next();
        if (code === '_')
        {
            return code + next();
        }
        if (code === '$')
        {
            throw new Unreadable(name);
        }
        return code;
    };

    /** A cv letter, with the pointer modifiers that may come first. */
    const qualifiers = ()=>{
        while ('EFI'.includes(peek()))
        {
            at++;
        }
        next();
    };

    /**
     * Reads one type.
     *
     * @returns {number | null} its size on the stack, or null when the name does not say
     */
    const type = ()=>{
        const code = next();
        if (code in PRIMITIVE)
        {
            return PRIMITIVE[code];
        }
        switch (code)
        {
            case 'X':
                return 0;
            case '_': {
                const extended = next();
                if (!(extended in EXTENDED))
                {
                    throw new Unreadable(name);
                }
                return EXTENDED[extended];
            }
            case 'P': case 'Q': case 'R': case 'S':
                pointee();
                return 4;
            case 'A': case 'B':
                qualifiers();
                type();
                return 4;
            case 'V': case 'U': case 'T':
                qualified();
                return null;
            case 'W':
                next();
                qualified();
                return 4;
            case '$': {
                expect('$');
                const kind = next();
                if (kind === 'Q' || kind === 'R')
                {
                    qualifiers();
                    type();
                    return 4;
                }
                if (kind === 'C')
                {
                    qualifiers();
                    return type();
                }
                if (kind === 'T')
                {
                    return 4;
                }
                throw new Unreadable(name);
            }
            default:
                throw new Unreadable(name);
        }
    };

    /** What a pointer points at: data of some type, or a function. */
    const pointee = ()=>{
        while ('EFI'.includes(peek()))
        {
            at++;
        }
        const kind = next();
        if (kind === '6')
        {
            signature(false, conventionLetter());
            return;
        }
        if (kind === '8')
        {
            qualified();
            qualifiers();
            signature(true, conventionLetter());
            return;
        }
        if (!'ABCD'.includes(kind))
        {
            throw new Unreadable(name);
        }
        type();
    };

    /**
     * A function type after its convention letter: return type, parameters,
     * and the exception specification.
     *
     * @param {boolean} member  Whether it has a `this`: in ECX for `thiscall`,
     *        the first argument otherwise, and the reason a class returned by
     *        value goes through a hidden pointer whatever its size.
     * @param {Convention} convention
     * @returns {number | null} what the callee pops
     */
    const signature = (member, convention)=>{
        /** @type {number | null} */
        let hidden = 0;
        if (peek() === '@')
        {
            at++;
        }
        else
        {
            if (peek() === '?')
            {
                at += 2;
            }
            // A class returned by value goes out through a pointer the caller
            // passes: always for a member, and for anything else only past a
            // size the name does not carry.
            if (type() === null)
            {
                hidden = member ? 4 : null;
            }
        }
        /** @type {(number | null)[]} */
        const sizes = member && convention !== 'thiscall' ? [4] : [];
        if (peek() === 'X')
        {
            at++;
        }
        else
        {
            while (peek() !== '@' && peek() !== 'Z')
            {
                const code = next();
                if (code >= '0' && code <= '9')
                {
                    const size = seen[Number(code)];
                    if (size === undefined)
                    {
                        throw new Unreadable(name);
                    }
                    sizes.push(size);
                    continue;
                }
                at--;
                const from = at;
                const size = type();
                if (at - from > 1 && seen.length < 10)
                {
                    seen.push(size);
                }
                sizes.push(size);
            }
            at++;
        }
        // The exception specification, which says nothing about the stack.
        if (peek() === 'Z')
        {
            at++;
        }
        else if (peek() === '_' && name[at + 1] === 'E')
        {
            at += 2;
        }
        return popped(convention, sizes, hidden);
    };

    /** @returns {Convention} */
    const conventionLetter = ()=>{
        const convention = CONVENTIONS[next()];
        if (!convention)
        {
            throw new Unreadable(name);
        }
        return convention;
    };

    try
    {
        let constructor = false;
        if (peek() === '?')
        {
            at++;
            if (peek() === '$')
            {
                at++;
                template();
            }
            else
            {
                constructor = operator() === '0';
            }
        }
        qualified();
        const kind = next();
        const member = MEMBER.includes(kind);
        if (!member && !STATIC.includes(kind))
        {
            return null;
        }
        if (member)
        {
            qualifiers();
        }
        const convention = conventionLetter();
        // The caller pops a cdecl call's arguments, whatever they are.
        if (convention === 'cdecl')
        {
            return { convention, argBytes: 0 };
        }
        if (constructor)
        {
            return { convention, argBytes: null };
        }
        return { convention, argBytes: knownOrNull(()=>signature(member, convention)) };
    }
    catch (e){
        if (e instanceof Unreadable)
        {
            return null;
        }
        throw e;
    }
}

/**
 * @param {() => number | null} read
 * @returns {number | null} what `read` answers, or null for a spelling it does not follow
 */
function knownOrNull(read){
    try
    {
        return read();
    }
    catch (e){
        if (e instanceof Unreadable)
        {
            return null;
        }
        throw e;
    }
}

/**
 * What the callee pops for a convention and its parameters' sizes.
 *
 * @param {Convention} convention
 * @param {(number | null)[]} sizes
 * @param {number | null} hidden  The pointer a returned class is written through.
 * @returns {number | null}
 */
function popped(convention, sizes, hidden){
    if (convention === 'cdecl')
    {
        return 0;
    }
    if (hidden === null || sizes.some(size=>size === null))
    {
        return null;
    }
    const known = /** @type {number[]} */ (sizes);
    if (convention === 'fastcall')
    {
        // The first two that fit a register travel in ECX and EDX.
        let registers = 2;
        let bytes = hidden;
        for (const size of known)
        {
            if (size <= 4 && registers > 0)
            {
                registers--;
                continue;
            }
            bytes += size;
        }
        return bytes;
    }
    return known.reduce((total, size)=>total + size, hidden);
}
