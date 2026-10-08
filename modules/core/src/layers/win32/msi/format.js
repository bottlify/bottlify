/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Windows Installer formatted strings: what MsiFormatRecord writes, and what
 * every Formatted column (a type 51 action's target, a registry value, a
 * dialog's text) becomes before it is used.
 *
 * The SDK's "Formatted" page describes the forms; the answers to everything
 * it leaves out are the ones Windows gives in Wine's conformance tests, and
 * they are irregular enough that a clean grammar does not reproduce them:
 *
 * - The expansion is a single left-to-right pass over a text that is rewritten
 *   in place. Each closing bracket or brace reduces back to the nearest opener
 *   of its kind, and what it is replaced by is not read again, so
 *   `[[1]]` with field 1 = `2` is field 2, but a property whose value is
 *   `[PropA]` comes out as the text `[PropA]`.
 * - Without a package nothing but field references expands: `[Prop]`,
 *   `[%VAR]`, `[\x]` and `[~]` stay as written.
 * - A `{...}` group vanishes when a property in it is unset, keeps its braces
 *   when nothing in it is a property, and a group whose content is itself a
 *   whole `{...}` is dropped outright. Nested groups have rules of their own,
 *   which the code follows from the tests rather than from any description.
 * - A template with more `[` than `]` is not expanded at all.
 * - `[~]` is a real NUL character in the result; the caller writes it, and a
 *   C reader of the buffer stops there.
 *
 * Each record field that is a string is expanded first, on its own and
 * without the record (so the field references in it stay), and the template
 * then reads the expanded fields. An empty or missing template is formatted
 * as `1: [1] 2: [2] ` and so on, one entry per field.
 *
 * Nothing here touches guest memory: the caller resolves names through the
 * environment it passes.
 */

/**
 * @typedef {Object} FormatRecord
 * @property {number} count               field count
 * @property {(index: number) => string | number | null} field   0..count; null = null field
 */

/**
 * @typedef {Object} FormatEnvironment
 * @property {(name: string) => string} property          '' when unset
 * @property {(name: string) => string | null} [environment]   [%VAR]
 * @property {(fileKey: string, short: boolean) => string | null} [file]   [#key] (short=false)
 *           and [!key] (short=true): the file's full target path; null = unknown key
 * @property {(componentKey: string) => string | null} [component]   [$key]: the component's
 *           directory, null unknown
 * @property {boolean} [deferred]  true inside a deferred custom action
 */

/**
 * Token kinds. A closer is its opener with the low bit set, so `kind & OPENER`
 * names the opener a closer reduces to.
 */
const LITERAL = 0x02;
const NUMBER = 0x04;
const OPEN_BRACKET = 0x10;
const CLOSE_BRACKET = 0x11;
const OPEN_BRACE = 0x20;
const CLOSE_BRACE = 0x21;
const ESCAPE = 0x40;
const TILDE = 0x80;
const OPENER = 0xf0;

/**
 * The properties a deferred custom action can still read. The SDK limits
 * MsiFormatRecord there to CustomActionData and ProductCode; UserSID is the
 * one more that MsiGetProperty answers in Wine's deferred-action test. The
 * file and component forms read tables the action no longer has, so they
 * expand as unknown keys.
 */
const DEFERRED_PROPERTIES = new Set(['CustomActionData', 'ProductCode', 'UserSID']);

/**
 * One lexed piece of the text, or what a reduction left in its place.
 *
 * `length` is bookkeeping, not always the span of the text the token stands
 * for: when a reduction's result is merged into the token before it, and when
 * a NUL goes in, the lengths stop matching the text, and a group then cuts
 * its content by the lengths. Windows does the same, so it is kept.
 *
 * @typedef {Object} Token
 * @property {number} kind
 * @property {number} start
 * @property {number} length
 * @property {boolean} resolved   a property (or field) in it had a value
 * @property {boolean} verbatim   it is text that was not substituted
 */

/**
 * @typedef {Object} Expansion
 * @property {string} text
 * @property {number} at
 * @property {FormatEnvironment | null} env
 * @property {(string | null)[] | null} fields   the expanded record, or null for a field's own pass
 * @property {boolean} propertyFailed
 * @property {boolean} groupFailed
 * @property {number} depth   braces open at the cursor
 */

/** @param {number} kind @param {number} start @param {number} length @returns {Token} */
const token = (kind, start, length)=>({ kind, start, length, resolved: false, verbatim: false });

/** @param {string} c */
const isDigit = c=>c >= '0' && c <= '9';

/**
 * Everything that is not a digit, a bracket or a brace reads as a name
 * character, so spaces, dots and backslashes run on inside a name.
 *
 * @param {string | undefined} c
 */
const isNameChar = c=>c !== undefined && c !== '[' && c !== ']' && c !== '{' && c !== '}';

/** @param {Expansion} x @returns {Token | null} */
const lex = x=>{
    const { text, at } = x;
    if (at >= text.length)
    {
        return null;
    }
    const c = text[at];
    const single = c === '[' ? OPEN_BRACKET : c === ']' ? CLOSE_BRACKET
        : c === '{' ? OPEN_BRACE : c === '}' ? CLOSE_BRACE : c === '~' ? TILDE : 0;
    if (single)
    {
        x.at++;
        return token(single, at, 1);
    }
    let end = at + 1;
    let kind = LITERAL;
    if (c === '\\')
    {
        // Runs to the closing bracket so `[\[]` escapes the bracket itself.
        while (end < text.length && text[end] !== ']')
        {
            end++;
        }
        kind = ESCAPE;
    }
    else if (isDigit(c))
    {
        while (end < text.length && isDigit(text[end]))
        {
            end++;
        }
        if (text[end] === ']')
        {
            kind = NUMBER;
        }
        else
        {
            while (isNameChar(text[end]))
            {
                end++;
            }
        }
    }
    else
    {
        while (isNameChar(text[end]))
        {
            end++;
        }
    }
    x.at = end;
    return token(kind, at, end - at);
};

/** @param {string} text */
const bracketsBalance = text=>{
    let open = 0;
    for (let i = 0; i < text.length; i++)
    {
        if (text[i] === '\\' && text[i + 1] === '[')
        {
            i++;
        }
        else if (text[i] === '[')
        {
            open++;
        }
        else if (text[i] === ']')
        {
            open--;
        }
    }
    // Surplus closers are harmless: they never find an opener to reduce to.
    return open <= 0;
};

/** @param {Expansion} x @param {number} start @param {number} length */
const slice = (x, start, length)=>(length > 0 ? x.text.substr(start, length) : null);

/** @param {string | null | undefined} value */
const valueOrNull = value=>(value ? value : null);

/**
 * The record field `[n]` names. Only digits reach here, so no sign and no
 * base; a number past the record is a null field.
 *
 * @param {Expansion} x @param {string} digits
 */
const fieldValue = (x, digits)=>{
    const fields = /** @type {(string | null)[]} */ (x.fields);
    const index = Number(digits);
    return index < fields.length ? fields[index] : null;
};

/**
 * What the inside of a bracket names, with a package to ask.
 *
 * @param {Expansion} x
 * @param {FormatEnvironment} env
 * @param {number} start
 * @param {number} length
 * @param {{ kind: number, resolved: boolean }} out
 * @returns {string | null}
 */
const resolveName = (x, env, start, length, out)=>{
    const lead = x.text[start];
    if (lead === '\\')
    {
        // `[\xyz]` is the one character after the backslash; `[\]` is nothing.
        return length === 1 ? null : x.text[start + 1];
    }
    if (lead === '~')
    {
        return length === 1 ? '' : null;
    }
    out.kind = LITERAL;
    if (lead === '%' || lead === '#' || lead === '!' || lead === '$')
    {
        const key = x.text.substr(start + 1, length - 1);
        if (lead === '%')
        {
            return valueOrNull(env.environment?.(key));
        }
        if (env.deferred)
        {
            return null;
        }
        if (lead === '$')
        {
            return valueOrNull(env.component?.(key));
        }
        return valueOrNull(env.file?.(key, lead === '!'));
    }
    const name = x.text.substr(start, length);
    const value = env.deferred && !DEFERRED_PROPERTIES.has(name) ? null
        : valueOrNull(env.property(name));
    if (value === null)
    {
        x.propertyFailed = true;
    }
    else
    {
        out.resolved = true;
    }
    return value;
};

/**
 * A `[...]` run reduced: `run` is the tokens from the opener to the closer.
 *
 * @param {Expansion} x
 * @param {Token[]} run
 * @returns {{ replacement: string | null, kind: number, resolved: boolean, verbatim: boolean,
 *     span: number }}
 */
const reduceBracket = (x, run)=>{
    let span = 0;
    for (const t of run)
    {
        span += t.length;
    }
    // The inside is a number only when every piece of it is; an escape keeps
    // its kind whatever follows it.
    let kind = run[1].kind;
    for (let i = 1; i < run.length - 1; i++)
    {
        if (kind !== ESCAPE && run[i].kind !== kind)
        {
            kind = LITERAL;
        }
    }
    const start = run[0].start + 1;
    const length = span - 2;
    if (kind === NUMBER && x.fields)
    {
        const value = fieldValue(x, x.text.substr(start, length));
        if (value === null)
        {
            x.propertyFailed = true;
            return { replacement: null, kind, resolved: false, verbatim: false, span };
        }
        return {
            replacement: value, kind: /^\d+$/.test(value) ? NUMBER : LITERAL,
            resolved: true, verbatim: false, span,
        };
    }
    // A field's own pass has no record, so its field references stay for the
    // template to read as text; without a package, so does every other form.
    if (x.env && kind !== NUMBER)
    {
        const out = { kind, resolved: false };
        const replacement = resolveName(x, x.env, start, length, out);
        return { replacement, kind: out.kind, resolved: out.resolved, verbatim: false, span };
    }
    return {
        replacement: slice(x, start - 1, length + 2), kind, resolved: false, verbatim: true, span,
    };
};

/**
 * A `{...}` run reduced.
 *
 * @param {Expansion} x
 * @param {Token[]} run
 * @returns {{ replacement: string | null, kind: number, resolved: boolean, verbatim: boolean,
 *     span: number }}
 */
const reduceGroup = (x, run)=>{
    let span = 0;
    let resolved = false;
    let verbatim = false;
    for (let i = 0; i < run.length; i++)
    {
        span += run[i].length;
        if (i > 0)
        {
            resolved ||= run[i].resolved;
            verbatim ||= run[i].verbatim;
        }
    }
    const start = run[0].start;
    const dropped = { replacement: null, kind: LITERAL, resolved, verbatim, span };
    if (!x.groupFailed && (span === 2 || (x.propertyFailed && !verbatim)))
    {
        return dropped;
    }
    let replacement;
    if (x.text[start + 1] === '{' && x.text[start + span - 2] === '}')
    {
        x.groupFailed = false;
        replacement = null;
    }
    else if (resolved && !verbatim && !x.groupFailed && x.depth === 0)
    {
        replacement = slice(x, start + 1, span - 2);
    }
    else
    {
        if (x.depth !== 0)
        {
            x.groupFailed = true;
        }
        verbatim = true;
        replacement = slice(x, start, span);
    }
    if (x.depth === 0)
    {
        x.propertyFailed = false;
    }
    return { replacement, kind: LITERAL, resolved, verbatim, span };
};

/**
 * Reduce the top of the stack back to its opener and splice the result into
 * the text. The result is not lexed again: the cursor moves past it.
 *
 * @param {Expansion} x @param {Token[]} stack @param {number} opener
 */
const reduce = (x, stack, opener)=>{
    let from = stack.length - 1;
    while (stack[from].kind !== opener)
    {
        from--;
    }
    const run = stack.splice(from);
    const group = opener === OPEN_BRACE;
    const r = group ? reduceGroup(x, run) : reduceBracket(x, run);
    const at = run[0].start;
    const inserted = r.replacement === null ? '' : r.replacement || '\0';
    x.text = x.text.slice(0, at) + inserted + x.text.slice(at + r.span);
    if (r.replacement === null)
    {
        x.at = at;
        return;
    }
    // A NUL is stepped over and counts for nothing.
    const result = r.replacement === ''
        ? token(r.kind, at + 1, 0)
        : token(r.kind, at, r.replacement.length);
    result.resolved = r.resolved;
    result.verbatim = r.verbatim;
    x.at = result.start + result.length;
    const top = stack[stack.length - 1];
    if (top && (top.kind === LITERAL || top.kind === NUMBER) && top.kind === result.kind)
    {
        top.length += result.length;
        if (group)
        {
            top.verbatim = false;
        }
        if (top.kind === LITERAL)
        {
            top.verbatim = result.verbatim;
        }
        top.resolved ||= result.resolved;
        return;
    }
    stack.push(result);
};

/**
 * @param {string} template
 * @param {FormatEnvironment | null} env
 * @param {(string | null)[] | null} fields
 * @returns {string}
 */
const expand = (template, env, fields)=>{
    if (!bracketsBalance(template))
    {
        return template;
    }
    /** @type {Expansion} */
    const x = {
        text: template, at: 0, env, fields,
        propertyFailed: false, groupFailed: false, depth: 0,
    };
    /** @type {Token[]} */
    const stack = [];
    for (let t = lex(x); t; t = lex(x))
    {
        if (t.kind === CLOSE_BRACKET || t.kind === CLOSE_BRACE)
        {
            if (t.kind === CLOSE_BRACE)
            {
                x.depth--;
            }
            stack.push(t);
            const opener = t.kind & OPENER;
            if (stack.some(s=>s.kind === opener))
            {
                reduce(x, stack, opener);
            }
            continue;
        }
        if (t.kind === OPEN_BRACE)
        {
            x.propertyFailed = false;
            x.depth++;
        }
        else if (t.kind === ESCAPE && !stack.some(s=>s.kind === OPEN_BRACKET))
        {
            // Outside a bracket a backslash escapes nothing and is one character.
            x.at = t.start + 1;
            t.length = 1;
        }
        stack.push(t);
    }
    return x.text;
};

/**
 * A record field as text: an integer in decimal, a string up to its first NUL
 * (what a record stores), and an empty string as the null field it is.
 *
 * @param {string | number | null} value
 * @returns {string | null}
 */
const fieldText = value=>{
    if (value === null || value === undefined)
    {
        return null;
    }
    if (typeof value === 'number')
    {
        return String(Math.trunc(value));
    }
    const nul = value.indexOf('\0');
    return valueOrNull(nul < 0 ? value : value.slice(0, nul));
};

/**
 * @param {FormatRecord} record
 * @param {FormatEnvironment | null} env  null = no installer handle (MsiFormatRecord(0, ...)): only
 *     what Windows expands without a package
 * @returns {string}
 */
export function formatRecord(record, env){
    const count = Math.max(0, record.count | 0);
    let template = fieldText(record.field(0));
    if (template === null)
    {
        template = '';
        for (let i = 1; i <= count; i++)
        {
            template += `${i}: [${i}] `;
        }
    }
    /** @type {(string | null)[]} */
    const fields = [template];
    for (let i = 1; i <= count; i++)
    {
        const raw = record.field(i);
        const text = fieldText(raw);
        fields.push(typeof raw === 'string' && text !== null
            ? fieldText(expand(text, env, null))
            : text);
    }
    return expand(template, env, fields);
}
