/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * String and RegExp (ECMA-262 3rd edition 15.5 and 15.10), as JScript 5
 * has them.
 *
 * A pattern is matched by the host's regular expression engine, compiled
 * from the script's pattern text: matching runs no script and reaches
 * nothing but the string it is given, so the engine's own matcher is as
 * safe as one written here and is ES3's in every pattern a JScript script
 * can write. What JScript does differently from ES3 is done here, around
 * the matcher:
 *
 * - A group that took no part in a match reads as "", not undefined.
 * - `lastIndex` is set after every match, global or not, and an empty match
 *   moves it one past where it ended, so a `while (re.exec(s))` loop over a
 *   pattern that can match nothing still ends.
 * - The RegExp constructor's `$1`..`$9`, `input`, `index`, `lastIndex`,
 *   `lastMatch`, `lastParen`, `leftContext` and `rightContext` describe the
 *   last successful match.
 * - `split` with a pattern leaves out what the pattern's groups captured and
 *   every empty piece.
 * - `substr` with a negative start starts at 0.
 * - The HTML methods write their tags in capitals.
 */

import { DONTDELETE, DONTENUM, JSFunction, JSObject, READONLY, StringObject } from './objects.js';
import { toInteger } from './realm.js';
import { toUint32 } from './builtins-core.js';

/** @typedef {import('./realm.js').Realm} Realm */

/** A RegExp object, with the host matcher compiled from its pattern. */
export class RegExpObject extends JSObject
{
    /** @param {JSObject} proto @param {string} source @param {string} flags @param {RegExp} matcher */
    constructor(proto, source, flags, matcher){
        super(proto, 'RegExp');
        this.matcher = matcher;
        this.flags = flags;
        this.reset(source, flags, matcher);
    }

    /** @param {string} source @param {string} flags @param {RegExp} matcher */
    reset(source, flags, matcher){
        this.matcher = matcher;
        this.flags = flags;
        const fixed = READONLY | DONTENUM | DONTDELETE;
        this.define('source', source, fixed);
        this.define('global', flags.includes('g'), fixed);
        this.define('ignoreCase', flags.includes('i'), fixed);
        this.define('multiline', flags.includes('m'), fixed);
        this.define('lastIndex', 0, DONTENUM | DONTDELETE);
    }

    get global(){
        return this.flags.includes('g');
    }
}

/**
 * Compiles a pattern for the host: the flags a script gave, checked to be
 * ES3's, and always global so that a search can start where it is told.
 *
 * @param {string} pattern @param {string} flags @returns {RegExp | null}
 */
function compile(pattern, flags){
    if (!/^(?!.*(.).*\1)[gim]*$/.test(flags))
    {
        return null;
    }
    try
    {
        return new RegExp(pattern, `${flags.replace('g', '')}g`);
    }
    catch {
        return null;
    }
}

/**
 * One match: where it starts, the text, and the groups, "" for a group
 * that did not take part.
 *
 * @typedef {{ index: number, text: string, groups: string[] }} Match
 */

/**
 * @param {RegExp} matcher @param {string} text @param {number} from
 * @returns {Match | null}
 */
function matchAt(matcher, text, from){
    matcher.lastIndex = from;
    const found = matcher.exec(text);
    if (found === null)
    {
        return null;
    }
    return { index: found.index, text: found[0],
        groups: found.slice(1).map(group=>group ?? '') };
}

/** @param {Realm} realm */
export function installString(realm){
    const prototype = realm.stringPrototype;
    const constructor = realm.defineConstructor('String', 1, prototype,
        function*(_this, args){
            return args.length === 0 ? '' : yield* realm.toString(args[0]);
        },
        function*(_this, args){
            return new StringObject(prototype,
                args.length === 0 ? '' : yield* realm.toString(args[0]));
        });
    realm.methods(constructor, [
        ['fromCharCode', 1, function*(_this, args){
            let text = '';
            for (const arg of args)
            {
                text += String.fromCharCode((yield* realm.toNumber(arg)) & 0xffff);
            }
            return text;
        }],
    ]);

    /** @param {any} self @returns {string} */
    const thisString = self=>{
        if (typeof self === 'string')
        {
            return self;
        }
        if (self instanceof StringObject)
        {
            return self.value;
        }
        throw realm.typeError(5005);
    };
    /** @param {any} self @returns {Generator<unknown, string, unknown>} */
    const text = function*(self){
        return yield* realm.toString(self === undefined || self === null ? realm.global : self);
    };
    /** @param {any} value @param {number} fallback @returns {Generator<unknown, number, unknown>} */
    const integer = function*(value, fallback){
        return value === undefined ? fallback : toInteger(yield* realm.toNumber(value));
    };

    /** @type {[string, number, import('./objects.js').NativeCall][]} */
    const methods = [
        ['toString', 0, self=>thisString(self)],
        ['valueOf', 0, self=>thisString(self)],
        ['charAt', 1, function*(self, args){
            const s = yield* text(self);
            const at = yield* integer(args[0], 0);
            return at < 0 || at >= s.length ? '' : s[at];
        }],
        ['charCodeAt', 1, function*(self, args){
            const s = yield* text(self);
            const at = yield* integer(args[0], 0);
            return at < 0 || at >= s.length ? NaN : s.charCodeAt(at);
        }],
        ['concat', 1, function*(self, args){
            let s = yield* text(self);
            for (const arg of args)
            {
                s += yield* realm.toString(arg);
            }
            return s;
        }],
        ['indexOf', 1, function*(self, args){
            const s = yield* text(self);
            const search = yield* realm.toString(args[0]);
            const from = Math.min(Math.max(yield* integer(args[1], 0), 0), s.length);
            return s.indexOf(search, from);
        }],
        ['lastIndexOf', 1, function*(self, args){
            const s = yield* text(self);
            const search = yield* realm.toString(args[0]);
            const position = args[1] === undefined ? NaN : yield* realm.toNumber(args[1]);
            const from = Number.isNaN(position) ? Infinity : toInteger(position);
            return s.lastIndexOf(search, Math.min(Math.max(from, 0), s.length));
        }],
        ['localeCompare', 1, function*(self, args){
            const s = yield* text(self);
            const that = yield* realm.toString(args[0]);
            return Math.sign(s.localeCompare(that, 'en-US'));
        }],
        ['slice', 2, function*(self, args){
            const s = yield* text(self);
            const length = s.length;
            const start = yield* integer(args[0], 0);
            const end = yield* integer(args[1], length);
            const from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
            const to = end < 0 ? Math.max(length + end, 0) : Math.min(end, length);
            return s.slice(from, Math.max(to, from));
        }],
        ['substring', 2, function*(self, args){
            const s = yield* text(self);
            const length = s.length;
            const start = Math.min(Math.max(yield* integer(args[0], 0), 0), length);
            const end = Math.min(Math.max(yield* integer(args[1], length), 0), length);
            return s.slice(Math.min(start, end), Math.max(start, end));
        }],
        ['substr', 2, function*(self, args){
            const s = yield* text(self);
            const start = Math.min(Math.max(yield* integer(args[0], 0), 0), s.length);
            const count = yield* integer(args[1], Infinity);
            return count <= 0 ? '' : s.slice(start, start + Math.min(count, s.length - start));
        }],
        ['toLowerCase', 0, function*(self){
            return (yield* text(self)).toLowerCase();
        }],
        ['toLocaleLowerCase', 0, function*(self){
            return (yield* text(self)).toLowerCase();
        }],
        ['toUpperCase', 0, function*(self){
            return (yield* text(self)).toUpperCase();
        }],
        ['toLocaleUpperCase', 0, function*(self){
            return (yield* text(self)).toUpperCase();
        }],
    ];
    /** @type {[string, string, string | null][]} method, tag, attribute */
    const html = [
        ['anchor', 'A', 'NAME'], ['big', 'BIG', null], ['blink', 'BLINK', null],
        ['bold', 'B', null], ['fixed', 'TT', null], ['fontcolor', 'FONT', 'COLOR'],
        ['fontsize', 'FONT', 'SIZE'], ['italics', 'I', null], ['link', 'A', 'HREF'],
        ['small', 'SMALL', null], ['strike', 'STRIKE', null], ['sub', 'SUB', null],
        ['sup', 'SUP', null],
    ];
    for (const [name, tag, attribute] of html)
    {
        methods.push([name, attribute === null ? 0 : 1, function*(self, args){
            const s = yield* text(self);
            const open = attribute === null ? `<${tag}>`
                : `<${tag} ${attribute}="${yield* realm.toString(args[0])}">`;
            return `${open}${s}</${tag}>`;
        }]);
    }
    realm.methods(prototype, methods);
    installRegExp(realm, text);
}

/**
 * @param {Realm} realm
 * @param {(self: any) => Generator<unknown, string, unknown>} text
 */
function installRegExp(realm, text){
    const prototype = realm.regexpPrototype;

    /**
     * @param {string} pattern @param {string} flags @param {RegExpObject} [into]
     * @returns {RegExpObject}
     */
    const create = (pattern, flags, into)=>{
        const matcher = compile(pattern, flags);
        if (matcher === null)
        {
            throw realm.error('SyntaxError', 5017);
        }
        if (into)
        {
            into.reset(pattern, flags, matcher);
            return into;
        }
        return new RegExpObject(prototype, pattern, flags, matcher);
    };
    realm.regexpFactory = (pattern, flags)=>create(pattern, flags);

    /**
     * @param {any[]} args @param {RegExpObject} [into]
     * @returns {Generator<unknown, RegExpObject, unknown>}
     */
    const make = function*(args, into){
        const [pattern, flags] = args;
        if (pattern instanceof RegExpObject)
        {
            if (flags !== undefined)
            {
                throw realm.error('SyntaxError', 5017);
            }
            return create(/** @type {string} */ (pattern.get('source')), pattern.flags, into);
        }
        const source = pattern === undefined ? '' : yield* realm.toString(pattern);
        return create(source, flags === undefined ? '' : yield* realm.toString(flags), into);
    };
    const constructor = realm.defineConstructor('RegExp', 2, prototype,
        (_this, args)=>(args[0] instanceof RegExpObject && args[1] === undefined
            ? args[0] : make(args)),
        (_this, args)=>make(args));

    const statics = constructor;
    const kept = DONTENUM | DONTDELETE;
    /** @param {string} input @param {Match | null} match */
    const record = (input, match)=>{
        if (match === null)
        {
            return;
        }
        const end = match.index + match.text.length;
        for (let n = 1; n <= 9; n++)
        {
            statics.define(`$${n}`, match.groups[n - 1] ?? '', kept);
        }
        statics.define('input', input, kept);
        statics.define('$_', input, kept);
        statics.define('index', match.index, kept);
        statics.define('lastIndex', end, kept);
        statics.define('lastMatch', match.text, kept);
        statics.define('$&', match.text, kept);
        const lastParen = match.groups.length > 0 ? match.groups[match.groups.length - 1] : '';
        statics.define('lastParen', lastParen, kept);
        statics.define('$+', lastParen, kept);
        statics.define('leftContext', input.slice(0, match.index), kept);
        statics.define('$`', input.slice(0, match.index), kept);
        statics.define('rightContext', input.slice(end), kept);
        statics.define('$\'', input.slice(end), kept);
    };
    record('', { index: -1, text: '', groups: [] });
    statics.define('index', -1, kept);
    statics.define('lastIndex', -1, kept);

    /** @param {any} self @returns {RegExpObject} */
    const thisRegExp = self=>{
        if (!(self instanceof RegExpObject))
        {
            throw realm.typeError(5016);
        }
        return self;
    };

    /**
     * exec's search (15.10.6.2) with JScript's lastIndex.
     *
     * @param {RegExpObject} regexp @param {string} input
     * @returns {Generator<unknown, Match | null, unknown>}
     */
    const exec = function*(regexp, input){
        let from = 0;
        if (regexp.global)
        {
            from = toInteger(yield* realm.toNumber(regexp.get('lastIndex')));
        }
        if (from < 0 || from > input.length)
        {
            regexp.put('lastIndex', 0);
            return null;
        }
        const match = matchAt(regexp.matcher, input, from);
        if (match === null)
        {
            regexp.put('lastIndex', 0);
            return null;
        }
        const end = match.index + match.text.length;
        regexp.put('lastIndex', match.text.length === 0 ? end + 1 : end);
        record(input, match);
        return match;
    };

    /** @param {Match} match @param {string} input @returns {JSObject} */
    const matchArray = (match, input)=>{
        const array = realm.newArray([match.text, ...match.groups]);
        array.put('index', match.index);
        array.put('input', input);
        array.put('lastIndex', match.index + match.text.length);
        return array;
    };

    realm.methods(prototype, [
        ['exec', 1, function*(self, args){
            const regexp = thisRegExp(self);
            const input = yield* realm.toString(args[0]);
            const match = yield* exec(regexp, input);
            return match === null ? null : matchArray(match, input);
        }],
        ['test', 1, function*(self, args){
            const regexp = thisRegExp(self);
            return (yield* exec(regexp, yield* realm.toString(args[0]))) !== null;
        }],
        ['toString', 0, self=>{
            const regexp = thisRegExp(self);
            return `/${regexp.get('source')}/${['g', 'i', 'm'].filter(flag=>
                regexp.flags.includes(flag)).join('')}`;
        }],
        ['compile', 2, function*(self, args){
            const regexp = thisRegExp(self);
            yield* make(args, regexp);
            return undefined;
        }],
    ]);

    /**
     * The pattern a String method is given: a RegExp, or text made into one.
     *
     * @param {any} value @returns {Generator<unknown, RegExpObject, unknown>}
     */
    const toRegExp = function*(value){
        if (value instanceof RegExpObject)
        {
            return value;
        }
        return create(value === undefined ? '' : yield* realm.toString(value), '');
    };

    /**
     * Every match from the start, an empty one stepping one further.
     *
     * @param {RegExpObject} regexp @param {string} input @param {boolean} all
     * @returns {Match[]}
     */
    const matches = (regexp, input, all)=>{
        const found = [];
        let from = 0;
        while (from <= input.length)
        {
            const match = matchAt(regexp.matcher, input, from);
            if (match === null)
            {
                break;
            }
            found.push(match);
            if (!all)
            {
                break;
            }
            const end = match.index + match.text.length;
            from = match.text.length === 0 ? end + 1 : end;
        }
        return found;
    };

    /**
     * A replacement's $ forms (15.5.4.11).
     *
     * @param {string} replacement @param {Match} match @param {string} input
     * @returns {string}
     */
    const expand = (replacement, match, input)=>replacement.replace(
        /\$([$&`']|\d{1,2})/g, (whole, what)=>{
            switch (what)
            {
                case '$': return '$';
                case '&': return match.text;
                case '`': return input.slice(0, match.index);
                case '\'': return input.slice(match.index + match.text.length);
                default:
                {
                    const count = match.groups.length;
                    let n = Number(what);
                    if (what.length === 2 && (n > count || n === 0))
                    {
                        n = Number(what[0]);
                        if (n >= 1 && n <= count)
                        {
                            return match.groups[n - 1] + what[1];
                        }
                        return whole;
                    }
                    return n >= 1 && n <= count ? match.groups[n - 1] : whole;
                }
            }
        });

    realm.methods(realm.stringPrototype, [
        ['match', 1, function*(self, args){
            const input = yield* text(self);
            const regexp = yield* toRegExp(args[0]);
            if (!regexp.global)
            {
                const match = yield* exec(regexp, input);
                return match === null ? null : matchArray(match, input);
            }
            const found = matches(regexp, input, true);
            regexp.put('lastIndex', 0);
            if (found.length === 0)
            {
                return null;
            }
            record(input, found[found.length - 1]);
            return realm.newArray(found.map(match=>match.text));
        }],
        ['search', 1, function*(self, args){
            const input = yield* text(self);
            const regexp = yield* toRegExp(args[0]);
            const [match] = matches(regexp, input, false);
            if (match === undefined)
            {
                return -1;
            }
            record(input, match);
            return match.index;
        }],
        ['replace', 2, function*(self, args){
            const input = yield* text(self);
            const [search, replacement] = args;
            /** @type {Match[]} */
            let found;
            if (search instanceof RegExpObject)
            {
                found = matches(search, input, search.global);
                if (search.global)
                {
                    search.put('lastIndex', 0);
                }
                if (found.length > 0)
                {
                    record(input, found[found.length - 1]);
                }
            }
            else
            {
                const pattern = yield* realm.toString(search);
                const at = input.indexOf(pattern);
                found = at < 0 ? [] : [{ index: at, text: pattern, groups: [] }];
            }
            const replaceText = replacement instanceof JSFunction
                ? null : yield* realm.toString(replacement);
            let out = '';
            let last = 0;
            for (const match of found)
            {
                out += input.slice(last, match.index);
                if (replaceText === null)
                {
                    const answer = yield* realm.call(replacement, undefined,
                        [match.text, ...match.groups, match.index, input]);
                    out += yield* realm.toString(answer);
                }
                else
                {
                    out += expand(replaceText, match, input);
                }
                last = match.index + match.text.length;
            }
            return out + input.slice(last);
        }],
        ['split', 2, function*(self, args){
            const input = yield* text(self);
            const [separator, limitValue] = args;
            const limit = limitValue === undefined
                ? 4294967295 : toUint32(yield* realm.toNumber(limitValue));
            if (limit === 0)
            {
                return realm.newArray();
            }
            if (separator === undefined)
            {
                return realm.newArray([input]);
            }
            /** @type {string[]} */
            let pieces;
            if (separator instanceof RegExpObject)
            {
                pieces = splitPattern(separator.matcher, input)
                    .filter(piece=>piece.length > 0);
            }
            else
            {
                const by = yield* realm.toString(separator);
                pieces = input.split(by);
            }
            return realm.newArray(pieces.slice(0, Math.min(limit, pieces.length)));
        }],
    ]);
}

/**
 * ES3's split by a pattern (15.5.4.14) without the groups: the pieces
 * between matches, a match that is empty where the last piece ended not
 * splitting.
 *
 * @param {RegExp} matcher @param {string} input @returns {string[]}
 */
function splitPattern(matcher, input){
    const sticky = new RegExp(matcher.source, matcher.flags.replace('g', '') + 'y');
    /** @param {number} at @returns {number} where a match at `at` ends, or -1 */
    const matchEnd = at=>{
        sticky.lastIndex = at;
        const found = sticky.exec(input);
        return found === null ? -1 : at + found[0].length;
    };
    if (input.length === 0)
    {
        return matchEnd(0) >= 0 ? [] : [input];
    }
    const pieces = [];
    let p = 0;
    let q = 0;
    while (q < input.length)
    {
        const end = matchEnd(q);
        if (end < 0 || end === p)
        {
            q++;
            continue;
        }
        pieces.push(input.slice(p, q));
        p = end;
        q = p;
    }
    pieces.push(input.slice(p));
    return pieces;
}
