/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Windows Installer conditional statements: what MsiEvaluateCondition answers,
 * and what every Condition column and sequence table row is gated on.
 *
 * The syntax is the SDK's "Conditional Statement Syntax"; where the SDK is
 * silent, the answers are the ones Windows gives in Wine's conformance tests.
 * Those answers are less regular than the grammar suggests, and an installer
 * depends on the irregular parts without knowing it:
 *
 * - A value has one of three kinds, and the kind decides how it compares: a
 *   number written in the condition is an integer, a quoted literal is a
 *   string, and a property (or an environment variable) is a string that
 *   becomes an integer when it is compared with one, or with another value
 *   that is all digits. So `P = "5"` holds for P = 5, but `1 = "1"` does not:
 *   an integer against a literal is never equal, and only `<>` holds.
 * - A feature or component the package does not know is an empty literal, not
 *   an error, so `&Missing` is false and `&Missing <> 3` is true.
 * - The substring operators turn into bitwise ones when both sides are
 *   integers, including two literals that happen to be all digits.
 *
 * Nothing here touches guest memory: the caller resolves names to values
 * through the environment it passes.
 */

/** MSICONDITION values */
export const MSICONDITION = Object.freeze({ FALSE: 0, TRUE: 1, NONE: 2, ERROR: 3 });

/**
 * Where a condition's names get their values.
 *
 * @typedef {Object} ConditionEnvironment
 * @property {(name: string) => string} property   '' when unset
 * @property {(name: string) => string | null} [environment]  %VAR; null when unset.
 *           The SDK makes the name case-insensitive; that is this callback's job.
 * @property {(key: string) => { installed: number, action: number } | null} [component]
 *           $comp (action) / ?comp (installed); null = unknown key
 * @property {(key: string) => { installed: number, action: number } | null} [feature]
 *           &feat (action) / !feat (installed)
 */

/**
 * @typedef {'=' | '<>' | '<' | '>' | '<=' | '>=' | '><' | '<<' | '>>'} Relation
 *
 * @typedef {{ type: 'op', relation: Relation, folded: boolean }
 *     | { type: 'ident' | 'number' | 'literal', text: string }
 *     | { type: 'not' | 'and' | 'or' | 'xor' | 'eqv' | 'imp'
 *         | '(' | ')' | '%' | '$' | '?' | '&' | '!' }} Token
 *
 * @typedef {{ kind: 'integer', value: number }
 *     | { kind: 'literal' | 'symbol', value: string }} Value
 */

/** Thrown inside the parser; the caller sees MSICONDITION.ERROR. */
class ConditionSyntaxError extends Error {}

/**
 * Parentheses or NOTs nested deeper than this are a syntax error. Windows has some limit
 * (its parser's stack) that was not measured; this one only keeps a hostile
 * condition from exhausting ours.
 */
const MAX_NESTING = 1000;

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

/**
 * Longest first, so `~<=` is not read as `~<` followed by `=`. A `~`, `<` or
 * `>` that starts none of these is a syntax error, `~ =` with its space
 * among them.
 *
 * @type {readonly [string, Relation, boolean][]}
 */
const OPERATORS = Object.freeze([
    ['~<=', '<=', true], ['~><', '><', true], ['~>>', '>>', true], ['~<>', '<>', true],
    ['~>=', '>=', true], ['~<<', '<<', true],
    ['~=', '=', true], ['~<', '<', true], ['~>', '>', true],
    ['>=', '>=', false], ['><', '><', false], ['<<', '<<', false], ['<>', '<>', false],
    ['<=', '<=', false], ['>>', '>>', false],
    ['>', '>', false], ['<', '<', false],
]);

/** @type {Readonly<Record<string, Token['type']>>} */
const KEYWORDS = Object.freeze({
    NOT: 'not', AND: 'and', OR: 'or', XOR: 'xor', EQV: 'eqv', IMP: 'imp',
});

/** @type {Readonly<Record<string, Token['type']>>} */
const PUNCTUATION = Object.freeze({
    '(': '(', ')': ')', '%': '%', '$': '$', '?': '?', '&': '&', '!': '!',
});

/** @param {string} c */
const isAlpha = c=>(c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';

/**
 * A number token may carry a sign or a dot anywhere; only its leading integer counts.
 *
 * @param {string} c
 */
const isNumberChar = c=>(c >= '0' && c <= '9') || c === '-' || c === '.';

/** @param {string} c */
const isIdentChar = c=>isAlpha(c) || isNumberChar(c) || c === '#';

/**
 * Only the space separates tokens: a tab or a line break is an unknown
 * character, as in the parser Wine's tests were checked against.
 *
 * @param {string} text @returns {Token[]}
 */
const tokenize = text=>{
    /** @type {Token[]} */
    const tokens = [];
    // A condition reaches Windows as a C string; whatever follows a NUL was never seen.
    const end = text.indexOf('\0') < 0 ? text.length : text.indexOf('\0');
    let at = 0;
    while (at < end)
    {
        const c = text[at];
        if (c === ' ')
        {
            at++;
            continue;
        }
        if (c === '=')
        {
            tokens.push({ type: 'op', relation: '=', folded: false });
            at++;
            continue;
        }
        if (c === '~' || c === '<' || c === '>')
        {
            const match = OPERATORS.find(([spelling])=>text.startsWith(spelling, at)
                && at + spelling.length <= end);
            if (!match)
            {
                throw new ConditionSyntaxError(`operator at ${at}`);
            }
            tokens.push({ type: 'op', relation: match[1], folded: match[2] });
            at += match[0].length;
            continue;
        }
        const punctuation = PUNCTUATION[c];
        if (punctuation)
        {
            tokens.push(/** @type {Token} */ ({ type: punctuation }));
            at++;
            continue;
        }
        if (c === '"')
        {
            // No escape exists: the first quote after the opening one closes it.
            const close = text.indexOf('"', at + 1);
            if (close < 0 || close >= end)
            {
                throw new ConditionSyntaxError(`unterminated literal at ${at}`);
            }
            tokens.push({ type: 'literal', text: text.slice(at + 1, close) });
            at = close + 1;
            continue;
        }
        if (isAlpha(c))
        {
            let stop = at + 1;
            while (stop < end && isIdentChar(text[stop]))
            {
                stop++;
            }
            const word = text.slice(at, stop);
            const keyword = KEYWORDS[word.toUpperCase()];
            tokens.push(keyword ? /** @type {Token} */ ({ type: keyword })
                : { type: 'ident', text: word });
            at = stop;
            continue;
        }
        if (isNumberChar(c))
        {
            let stop = at + 1;
            while (stop < end && isNumberChar(text[stop]))
            {
                stop++;
            }
            tokens.push({ type: 'number', text: text.slice(at, stop) });
            at = stop;
            continue;
        }
        throw new ConditionSyntaxError(`unknown character at ${at}`);
    }
    return tokens;
};

/**
 * A number token's value, read the way `strtol` reads it: the leading
 * integer, 0 when there is none (`-`, `.5`, `--1`), held at the 32-bit
 * bounds when it is larger.
 *
 * @param {string} text @returns {number}
 */
const numberValue = text=>{
    const match = /^-?\d+/.exec(text);
    if (!match)
    {
        return 0;
    }
    return Math.min(INT32_MAX, Math.max(INT32_MIN, Number(match[0])));
};

/**
 * A string as an integer, or null when it is not one. Leading zeros are
 * fine; a space, a plus sign, a dot or a second minus are not. A value outside
 * 32 bits is not an integer either: Windows was not measured there, and
 * comparing it as text is the answer that cannot invent an equality.
 *
 * @param {string} text @param {boolean} signed  whether a leading '-' is allowed
 * @returns {number | null}
 */
const integerOf = (text, signed)=>{
    if (!(signed ? /^-?\d+$/ : /^\d+$/).test(text))
    {
        return null;
    }
    const value = Number(text);
    return value < INT32_MIN || value > INT32_MAX ? null : value;
};

/** @type {Map<number, number>} */
const foldCache = new Map();

/**
 * Case folded one UTF-16 unit at a time, as `wcsicmp` does, so a fold never
 * changes a string's length or the order of what it did not fold.
 *
 * @param {string} text @returns {string}
 */
const fold = text=>{
    let folded = '';
    for (let i = 0; i < text.length; i++)
    {
        const unit = text.charCodeAt(i);
        let lower = foldCache.get(unit);
        if (lower === undefined)
        {
            const mapped = String.fromCharCode(unit).toLowerCase();
            lower = mapped.length === 1 ? mapped.charCodeAt(0) : unit;
            foldCache.set(unit, lower);
        }
        folded += String.fromCharCode(lower);
    }
    return folded;
};

/**
 * @param {number} a @param {Relation} relation @param {boolean} folded @param {number} b
 * @returns {boolean}
 */
const compareIntegers = (a, relation, folded, b)=>{
    switch (relation)
    {
        case '=': return a === b;
        case '<>': return a !== b;
        case '<': return a < b;
        case '>': return a > b;
        case '<=': return a <= b;
        case '>=': return a >= b;
        case '><': return (a & b) !== 0;
        // The SDK gives `~` no meaning on integers; Wine's tests do not reach
        // `~<<` or `~>>` here, and Wine's parser answers false, as this does.
        case '<<': return !folded && ((a >> 16) & 0xffff) === b;
        case '>>': return !folded && (a & 0xffff) === b;
    }
    return false;
};

/**
 * @param {string} a @param {Relation} relation @param {boolean} folded @param {string} b
 * @param {boolean} convert  whether a property is on either side
 * @returns {boolean}
 */
const compareStrings = (a, relation, folded, b, convert)=>{
    if (relation === '><' || relation === '<<' || relation === '>>')
    {
        // An empty haystack holds nothing, and an empty needle is in everything.
        if (a === '')
        {
            return false;
        }
        if (b === '')
        {
            return true;
        }
        const ai = integerOf(a, false);
        const bi = integerOf(b, false);
        if (ai !== null && bi !== null)
        {
            return compareIntegers(ai, relation, folded, bi);
        }
        const left = folded ? fold(a) : a;
        const right = folded ? fold(b) : b;
        if (relation === '><')
        {
            return left.includes(right);
        }
        return relation === '<<' ? left.startsWith(right) : left.endsWith(right);
    }
    if (convert)
    {
        const ai = integerOf(a, false);
        const bi = integerOf(b, false);
        if (ai !== null && bi !== null)
        {
            return compareIntegers(ai, relation, folded, bi);
        }
    }
    // By UTF-16 unit, as `wcscmp`: "100" < "21", and no locale collation.
    const left = folded ? fold(a) : a;
    const right = folded ? fold(b) : b;
    switch (relation)
    {
        case '=': return left === right;
        case '<>': return left !== right;
        case '<': return left < right;
        case '>': return left > right;
        case '<=': return left <= right;
        case '>=': return left >= right;
    }
    return false;
};

/**
 * @param {Value} left @param {Relation} relation @param {boolean} folded @param {Value} right
 * @returns {boolean}
 */
const compareValues = (left, relation, folded, right)=>{
    if (left.kind === 'integer' && right.kind === 'integer')
    {
        return compareIntegers(left.value, relation, folded, right.value);
    }
    if (left.kind !== 'integer' && right.kind !== 'integer')
    {
        return compareStrings(left.value, relation, folded, right.value,
            left.kind === 'symbol' || right.kind === 'symbol');
    }
    // A literal never becomes a number; a property does when it reads as one.
    /** @param {Value} side @returns {number | null} */
    const asInteger = side=>side.kind === 'integer' ? side.value
        : side.kind === 'symbol' ? integerOf(side.value, true) : null;
    const a = asInteger(left);
    const b = asInteger(right);
    if (a === null || b === null)
    {
        return relation === '<>';
    }
    return compareIntegers(a, relation, folded, b);
};

/** @param {Value} value @returns {boolean} */
const truthOf = value=>value.kind === 'integer' ? value.value !== 0 : value.value !== '';

/**
 * Recursive descent over the tokens, evaluating as it goes. Every operand is
 * evaluated, including the ones a short circuit would skip, because the whole
 * condition has to parse before it has an answer.
 *
 * Precedence is the SDK's, high to low: NOT, AND, OR, XOR, EQV, IMP, each
 * binary level left-associative. A comparison takes two values and nothing
 * larger: `(1 AND 1) = 2` is an error, and `NOT A = 1` reads as `NOT (A = 1)`.
 *
 * @param {Token[]} tokens @param {ConditionEnvironment} env
 * @returns {boolean}
 */
const parse = (tokens, env)=>{
    let at = 0;
    let depth = 0;

    /** @param {Token['type']} type @returns {boolean} */
    const accept = type=>{
        if (tokens[at]?.type === type)
        {
            at++;
            return true;
        }
        return false;
    };

    /** @param {() => boolean} inner @returns {boolean} */
    const nested = inner=>{
        if (++depth > MAX_NESTING)
        {
            throw new ConditionSyntaxError('nested too deeply');
        }
        const result = inner();
        depth--;
        return result;
    };

    /** @returns {string} */
    const name = ()=>{
        const token = tokens[at++];
        if (token?.type !== 'ident')
        {
            throw new ConditionSyntaxError(`name expected at token ${at - 1}`);
        }
        return token.text;
    };

    /**
     * @param {{ installed: number, action: number } | null} state
     * @param {boolean} action  the action state rather than the installed one
     * @returns {Value}
     */
    const stateValue = (state, action)=>state
        ? { kind: 'integer', value: action ? state.action : state.installed }
        : { kind: 'literal', value: '' };

    /** @returns {Value} */
    const value = ()=>{
        const token = tokens[at++];
        switch (token?.type)
        {
            case 'ident':
                return { kind: 'symbol', value: env.property(token.text) ?? '' };
            case 'literal':
                return { kind: 'literal', value: token.text };
            case 'number':
                return { kind: 'integer', value: numberValue(token.text) };
            // The name is read before the callback is looked up: a missing
            // callback still leaves `%`, `$` and the rest needing one.
            case '%':
            {
                const variable = name();
                return { kind: 'symbol', value: env.environment?.(variable) ?? '' };
            }
            case '$':
            case '?':
            {
                const key = name();
                return stateValue(env.component?.(key) ?? null, token.type === '$');
            }
            case '&':
            case '!':
            {
                const key = name();
                return stateValue(env.feature?.(key) ?? null, token.type === '&');
            }
        }
        throw new ConditionSyntaxError(`value expected at token ${at - 1}`);
    };

    /** @type {() => boolean} */
    let expression;

    /** @returns {boolean} */
    const factor = ()=>{
        if (accept('not'))
        {
            return !nested(factor);
        }
        if (accept('('))
        {
            const result = nested(expression);
            if (!accept(')'))
            {
                throw new ConditionSyntaxError('missing )');
            }
            return result;
        }
        const left = value();
        const next = tokens[at];
        if (next?.type !== 'op')
        {
            return truthOf(left);
        }
        at++;
        return compareValues(left, next.relation, next.folded, value());
    };

    /**
     * One left-associative level of binary operators.
     *
     * @param {Token['type']} keyword @param {() => boolean} operand
     * @param {(a: boolean, b: boolean) => boolean} combine
     * @returns {() => boolean}
     */
    const level = (keyword, operand, combine)=>()=>{
        let result = operand();
        while (accept(keyword))
        {
            result = combine(result, operand());
        }
        return result;
    };

    const conjunction = level('and', factor, (a, b)=>a && b);
    const disjunction = level('or', conjunction, (a, b)=>a || b);
    const exclusive = level('xor', disjunction, (a, b)=>a !== b);
    const equivalence = level('eqv', exclusive, (a, b)=>a === b);
    expression = level('imp', equivalence, (a, b)=>!a || b);

    const result = expression();
    if (at !== tokens.length)
    {
        throw new ConditionSyntaxError(`unexpected token ${at}`);
    }
    return result;
};

/**
 * @param {string} text  the condition; empty/whitespace-only -> NONE
 * @param {ConditionEnvironment} env
 * @returns {0|1|2|3}
 */
export function evaluateCondition(text, env){
    try
    {
        const tokens = tokenize(text);
        if (tokens.length === 0)
        {
            return MSICONDITION.NONE;
        }
        return parse(tokens, env) ? MSICONDITION.TRUE : MSICONDITION.FALSE;
    }
    catch (e){
        if (e instanceof ConditionSyntaxError)
        {
            return MSICONDITION.ERROR;
        }
        throw e;
    }
}
