/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VBScript's RegExp class (VBScript 5.5 and later): Pattern, IgnoreCase,
 * Global and Multiline; Test, Execute and Replace. Execute answers a Matches
 * collection, each Match its Value, FirstIndex, Length and SubMatches.
 *
 * The pattern language is JScript's, ECMA-262's third edition, and is
 * matched by the host's regular expressions as JScript's engine here matches
 * it: a pattern is data for the matcher, never code. The objects are host
 * objects (`script/external.js`), so a COM caller can hold and call them as
 * a script does.
 */

import { hostObject } from '../script/external.js';
import { VBRuntimeError } from './errors.js';
import { toBool, toStr } from './values.js';

/** @typedef {import('../script/values.js').Value} Value */

/**
 * The host's matcher for a pattern, global so that a search can start where
 * it is told; error 5017 for a pattern that is not one.
 *
 * @param {string} pattern @param {boolean} ignoreCase @param {boolean} multiline
 * @returns {RegExp}
 */
function compile(pattern, ignoreCase, multiline){
    try
    {
        return new RegExp(pattern, `g${ignoreCase ? 'i' : ''}${multiline ? 'm' : ''}`);
    }
    catch {
        throw new VBRuntimeError(5017);
    }
}

/**
 * One match: where, what, and each group's text, undefined (Empty) for a
 * group that took no part.
 *
 * @typedef {{ index: number, text: string, groups: (string | undefined)[] }} Found
 */

/**
 * The matches of a pattern in a text: all of them, or the first.
 *
 * @param {RegExp} matcher @param {string} text @param {boolean} all
 * @returns {Found[]}
 */
function matches(matcher, text, all){
    /** @type {Found[]} */
    const found = [];
    matcher.lastIndex = 0;
    for (;;)
    {
        const match = matcher.exec(text);
        if (match === null)
        {
            return found;
        }
        found.push({ index: match.index, text: match[0], groups: match.slice(1) });
        if (!all)
        {
            return found;
        }
        // An empty match moves on by one, so the search does not stand still.
        if (match[0] === '')
        {
            matcher.lastIndex++;
        }
    }
}

/**
 * A collection over a list: Count, Item(i) as the default member, and For
 * Each.
 *
 * @param {string} typeName @param {Value[]} items
 */
function collection(typeName, items){
    /** @param {Value[]} args */
    const item = args=>{
        const index = Number(args[0]);
        if (!Number.isInteger(index) || index < 0 || index >= items.length)
        {
            throw new VBRuntimeError(5);
        }
        return items[index];
    };
    return hostObject({
        typeName,
        value: { get: item },
        members: {
            Count: { get: ()=>items.length },
            Item: { get: item },
        },
        items: ()=>items,
    });
}

/** @param {Found} found */
function matchObject(found){
    const submatches = collection('ISubMatches', found.groups);
    return hostObject({
        typeName: 'IMatch2',
        value: { get: ()=>found.text },
        members: {
            Value: { get: ()=>found.text },
            FirstIndex: { get: ()=>found.index },
            Length: { get: ()=>found.text.length },
            // SubMatches(0) is the collection's Item(0), as a property
            // without parameters passes extra arguments to its value.
            SubMatches: { get: args=>(args.length === 0 ? submatches
                : submatches.get(null, args)) },
        },
    });
}

/** A new RegExp object, as New RegExp makes one. */
export function createRegExp(){
    const state = { pattern: '', ignoreCase: false, global: false, multiline: false };
    const matcher = ()=>compile(state.pattern, state.ignoreCase, state.multiline);
    /** @param {'ignoreCase' | 'global' | 'multiline'} name */
    const flag = name=>({
        get: ()=>state[name],
        put: (/** @type {Value} */ value)=>{
            state[name] = toBool(value);
        },
    });
    return hostObject({
        typeName: 'IRegExp2',
        members: {
            Pattern: { get: ()=>state.pattern,
                put: value=>{
                    state.pattern = toStr(value);
                } },
            IgnoreCase: flag('ignoreCase'),
            Global: flag('global'),
            Multiline: flag('multiline'),
            Test: { call: ([text])=>matches(matcher(), toStr(text), false).length > 0 },
            Execute: { call: ([text])=>collection('IMatchCollection2',
                matches(matcher(), toStr(text), state.global).map(matchObject)) },
            Replace: { call: ([text, replacement])=>{
                const source = toStr(text);
                const compiled = matcher();
                const found = matches(compiled, source, state.global);
                const replaceWith = toStr(replacement);
                let out = '';
                let at = 0;
                for (const match of found)
                {
                    out += source.slice(at, match.index)
                        + expand(replaceWith, match, source);
                    at = match.index + match.text.length;
                }
                return out + source.slice(at);
            } },
        },
    });
}

/**
 * A replacement's text for one match: $1 to $99 a group, $& the match, $`
 * and $' the text before and after it, $$ a dollar.
 *
 * @param {string} replacement @param {Found} match @param {string} source
 * @returns {string}
 */
function expand(replacement, match, source){
    return replacement.replace(/\$(\$|&|`|'|\d\d?)/g, (all, what)=>{
        switch (what)
        {
            case '$': return '$';
            case '&': return match.text;
            case '`': return source.slice(0, match.index);
            case '\'': return source.slice(match.index + match.text.length);
            default: {
                let n = Number(what);
                if (what.length === 2 && n > match.groups.length)
                {
                    n = Number(what[0]);
                    const rest = what[1];
                    return n >= 1 && n <= match.groups.length
                        ? `${match.groups[n - 1] ?? ''}${rest}` : all;
                }
                return n >= 1 && n <= match.groups.length ? match.groups[n - 1] ?? '' : all;
            }
        }
    });
}
