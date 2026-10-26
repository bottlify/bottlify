/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C++ a Visual C++ decorated name stands for, as `__unDName` writes it.
 *
 * A name is read into a small tree -- the symbol's qualified name, its kind
 * (a function, a variable, a table, a thunk) and the types it carries -- and
 * the tree is written the way C writes a declaration: a type around the
 * declarator it qualifies, so a pointer to a function puts the name inside
 * the function's parentheses (`int (__cdecl** Bar::Qux)(int)`) and a pointer
 * to an array inside the array's (`int (* x)[3]`). The spacing is the
 * runtime's own -- `char const * const *`, `(__cdecl*const)` -- and so is
 * what the flags leave out.
 *
 * What cannot be read is answered with the name itself, as the runtime
 * answers a name it does not understand.
 */

/** `__unDName`'s flags. */
export const UNDNAME = Object.freeze({
    NO_LEADING_UNDERSCORES: 0x0001,
    NO_MS_KEYWORDS: 0x0002,
    NO_FUNCTION_RETURNS: 0x0004,
    NO_ALLOCATION_LANGUAGE: 0x0010,
    NO_MS_THISTYPE: 0x0020,
    NO_CV_THISTYPE: 0x0040,
    NO_ACCESS_SPECIFIERS: 0x0080,
    NO_MEMBER_TYPE: 0x0200,
    NAME_ONLY: 0x1000,
    TYPE_ONLY: 0x2000,
});

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
    M: 'unsigned __int128', N: 'bool', S: 'char16_t', U: 'char32_t', W: 'wchar_t',
};

/** A type's qualifiers by their letter. @type {Record<string, string>} */
const CV = { A: '', B: 'const', C: 'volatile', D: 'const volatile' };

/** The calling conventions, by letter. @type {Record<string, string>} */
const CONVENTIONS = {
    A: '__cdecl', B: '__cdecl', C: '__pascal', D: '__pascal', E: '__thiscall', F: '__thiscall',
    G: '__stdcall', H: '__stdcall', I: '__fastcall', J: '__fastcall', K: '', L: '',
    M: '__clrcall', N: '__clrcall', O: '__eabi', P: '__eabi', Q: '__vectorcall',
};

/** The operators after `?`, by their code. @type {Record<string, string>} */
const OPERATORS = {
    2: 'operator new', 3: 'operator delete', 4: 'operator=', 5: 'operator>>', 6: 'operator<<',
    7: 'operator!', 8: 'operator==', 9: 'operator!=', A: 'operator[]', C: 'operator->',
    D: 'operator*', E: 'operator++', F: 'operator--', G: 'operator-', H: 'operator+',
    I: 'operator&', J: 'operator->*', K: 'operator/', L: 'operator%', M: 'operator<',
    N: 'operator<=', O: 'operator>', P: 'operator>=', Q: 'operator,', R: 'operator()',
    S: 'operator~', T: 'operator^', U: 'operator|', V: 'operator&&', W: 'operator||',
    X: 'operator*=', Y: 'operator+=', Z: 'operator-=',
    _0: 'operator/=', _1: 'operator%=', _2: 'operator>>=', _3: 'operator<<=', _4: 'operator&=',
    _5: 'operator|=', _6: 'operator^=', _7: '`vftable\'', _8: '`vbtable\'', _9: '`vcall\'',
    _A: '`typeof\'', _B: '`local static guard\'', _C: '`string\'',
    _D: '`vbase destructor\'', _E: '`vector deleting destructor\'',
    _F: '`default constructor closure\'', _G: '`scalar deleting destructor\'',
    _H: '`vector constructor iterator\'', _I: '`vector destructor iterator\'',
    _J: '`vector vbase constructor iterator\'', _K: '`virtual displacement map\'',
    _L: '`eh vector constructor iterator\'', _M: '`eh vector destructor iterator\'',
    _N: '`eh vector vbase constructor iterator\'', _O: '`copy constructor closure\'',
    _S: '`local vftable\'', _T: '`local vftable constructor closure\'', _U: 'operator new[]',
    _V: 'operator delete[]', _X: '`placement delete closure\'',
    _Y: '`placement delete[] closure\'',
};

/** The access a member's letter gives it, eight letters each. */
const ACCESS = ['private', 'protected', 'public'];

/**
 * A type as read: what it is, and what it is made of.
 *
 * @typedef {{ kind: 'basic', name: string, cv?: string, unaligned?: boolean }
 *     | { kind: 'pointer', to: Type, symbol: string, cv: string, pointeeCv: string,
 *         ptr64: boolean, restrict: boolean, member?: string }
 *     | { kind: 'array', of: Type, dims: string[], cv?: string }
 *     | { kind: 'function', convention: string, returns: Type | null, args: string,
 *         thisSuffix: string, member?: string }} Type
 */

class Unreadable extends Error {}

/**
 * The text of a decorated name.
 *
 * @param {string} mangled
 * @param {number} [flags]
 * @returns {string}  The name itself when it cannot be read.
 */
export function undecorateName(mangled, flags = 0){
    try
    {
        const reader = createReader(mangled, flags);
        const text = (flags & UNDNAME.TYPE_ONLY) !== 0 ? reader.dataType() : reader.symbol();
        return reader.done() ? text : mangled;
    }
    catch (e){
        if (e instanceof Unreadable || e instanceof RangeError)
        {
            return mangled;
        }
        throw e;
    }
}

/**
 * A type descriptor's name -- `?AVclass@@`, `ABVVec4@ref2@dice@@` -- as
 * type_info::name() gives it, or null for one that is not a whole type.
 *
 * @param {string} mangled
 * @returns {string | null}
 */
export function undecorateType(mangled){
    try
    {
        const reader = createReader(mangled, 0);
        const text = reader.dataType();
        return reader.done() ? text : null;
    }
    catch (e){
        if (e instanceof Unreadable || e instanceof RangeError)
        {
            return null;
        }
        throw e;
    }
}

/**
 * @param {string} s @param {number} flags
 */
function createReader(s, flags){
    let at = 0;
    /**
     * The names read so far, which a digit refers back to. A nested
     * symbol's names are dropped when it ends but stay readable until
     * written over, as the runtime's table keeps them.
     *
     * @type {string[]}
     */
    let names = [];
    /** How many of `names` are current. */
    let top = 0;
    /** The argument types read so far, which a digit refers back to. @type {string[]} */
    let argTypes = [];

    const fail = ()=>{
        throw new Unreadable(s);
    };
    const peek = (offset = 0)=>s[at + offset];
    const next = ()=>{
        if (at >= s.length)
        {
            fail();
        }
        return s[at++];
    };
    /** @param {string} text */
    const consume = text=>{
        if (s.startsWith(text, at))
        {
            at += text.length;
            return true;
        }
        return false;
    };

    /** A keyword the flags may shorten or drop. @param {string} word */
    const keyword = word=>{
        if ((flags & UNDNAME.NO_MS_KEYWORDS) !== 0 && word.startsWith('__'))
        {
            return '';
        }
        return (flags & UNDNAME.NO_LEADING_UNDERSCORES) !== 0 ? word.replace(/^__/, '') : word;
    };

    /** The words given, the empty ones left out. @param {string[]} words */
    const join = (...words)=>words.filter(word=>word !== '').join(' ');

    /**
     * An encoded number: a digit is one more than itself, else hex digits
     * A to P up to an `@`; `?` makes it negative.
     */
    const number = ()=>{
        const negative = consume('?');
        const first = next();
        let value = 0n;
        if (first >= '0' && first <= '9')
        {
            value = BigInt(first.charCodeAt(0) - 0x2f);
        }
        else
        {
            for (let c = first; c !== '@'; c = next())
            {
                const digit = c.charCodeAt(0) - 0x41;
                if (!(digit >= 0 && digit < 16))
                {
                    fail();
                }
                value = value * 16n + BigInt(digit);
            }
        }
        return negative ? -value : value;
    };

    /** A number as the runtime prints one of a thunk's: its 32 bits unsigned. */
    const unsigned = ()=>String(BigInt.asUintN(32, number()));

    /** A name's text up to its `@`. */
    const fragment = ()=>{
        const end = s.indexOf('@', at);
        if (end <= at)
        {
            fail();
        }
        const text = s.slice(at, end);
        if (!/^[\w$<>`'.?-]+$/.test(text) || text.includes('.'))
        {
            fail();
        }
        at = end + 1;
        return text;
    };

    /** @param {string} name */
    const remember = name=>{
        if (top < 10 && !names.slice(0, top).includes(name))
        {
            names[top++] = name;
        }
    };

    /**
     * A template's name and arguments, `?$` already read: its own back
     * references, the arguments' list closed by an `@` or the text's end.
     */
    const template = ()=>{
        const savedNames = names;
        const savedTop = top;
        const savedArgs = argTypes;
        names = [];
        top = 0;
        argTypes = [];
        let kind = '';
        let base;
        if (peek() === '?')
        {
            next();
            ({ name: base, kind } = operatorName());
        }
        else
        {
            base = fragment();
        }
        if (base !== '')
        {
            remember(base);
        }
        /** @type {string[]} */
        const args = [];
        while (at < s.length && peek() !== '@')
        {
            args.push(templateArgument());
        }
        consume('@');
        names = savedNames;
        top = savedTop;
        argTypes = savedArgs;
        const list = args.join(',');
        return { name: `${base}<${list}${list.endsWith('>') ? ' ' : ''}>`, kind };
    };

    /** One template argument. */
    const templateArgument = ()=>{
        if (consume('$0'))
        {
            return String(number());
        }
        if (consume('$1'))
        {
            return `&${symbolText()}`;
        }
        if (consume('$D'))
        {
            return `\`template-parameter${number()}'`;
        }
        if (consume('$$V') || consume('$$Z'))
        {
            return '';
        }
        if (peek() === '?')
        {
            next();
            return `\`template-parameter-${number()}'`;
        }
        if (consume('X'))
        {
            return 'void';
        }
        return argumentType();
    };

    /**
     * An operator or special name, the `?` before it read: its text, and
     * what it asks of the rest of the symbol.
     *
     * @returns {{ name: string, kind: string }}
     */
    const operatorName = ()=>{
        const code = next();
        if (code === '0')
        {
            return { name: '', kind: 'constructor' };
        }
        if (code === '1')
        {
            return { name: '', kind: 'destructor' };
        }
        if (code === 'B')
        {
            return { name: 'operator', kind: 'cast' };
        }
        if (code === '$')
        {
            const { name, kind } = template();
            return { name, kind: kind === 'cast' ? 'cast' : 'template' };
        }
        if (code === '_')
        {
            const second = next();
            if (second === 'R')
            {
                return rttiName();
            }
            const name = OPERATORS[`_${second}`];
            if (name === undefined)
            {
                fail();
            }
            return { name, kind: '' };
        }
        const name = OPERATORS[code];
        if (name === undefined)
        {
            fail();
        }
        return { name, kind: '' };
    };

    /** The RTTI names, `?_R` read. */
    const rttiName = ()=>{
        const which = next();
        switch (which)
        {
            case '0': {
                consume('?');
                const cv = CV[next()] ?? fail();
                const type = render(typeNode(), '');
                return { name: `${join(type, cv)} \`RTTI Type Descriptor'`, kind: 'rtti' };
            }
            case '1': {
                const values = [number(), number(), number(), number()];
                return { name: `\`RTTI Base Class Descriptor at (${values.join(',')})'`,
                    kind: '' };
            }
            case '2': return { name: '`RTTI Base Class Array\'', kind: '' };
            case '3': return { name: '`RTTI Class Hierarchy Descriptor\'', kind: '' };
            case '4': return { name: '`RTTI Complete Object Locator\'', kind: '' };
            default: return fail();
        }
    };

    /**
     * The qualifiers after a symbol's first name, to their closing `@`:
     * each a name, a template, a back reference, a lexical scope's number
     * or a whole symbol nested in quotes.
     */
    const scopes = ()=>{
        /** @type {string[]} */
        const parts = [];
        while (peek() !== '@')
        {
            if (at >= s.length)
            {
                fail();
            }
            const c = peek();
            if (c >= '0' && c <= '9')
            {
                next();
                parts.push(names[c.charCodeAt(0) - 0x30] ?? fail());
                continue;
            }
            if (consume('?$'))
            {
                const { name } = template();
                remember(name);
                parts.push(name);
                continue;
            }
            if (consume('??'))
            {
                // A nested symbol sees the names and argument types read so
                // far; the names it adds are dropped after it.
                const count = top;
                const nested = symbolText(true);
                top = count;
                parts.push(`\`${nested}'`);
                continue;
            }
            if (consume('?A'))
            {
                fragment();
                parts.push('`anonymous namespace\'');
                continue;
            }
            if (consume('?'))
            {
                parts.push(`\`${number()}'`);
                continue;
            }
            const name = fragment();
            remember(name);
            parts.push(name);
        }
        next();
        return parts;
    };

    /**
     * A symbol's qualified name: the parts, innermost first, and what its
     * first part asks of the rest.
     */
    const qualifiedName = (symbol = false)=>{
        let first;
        let kind = '';
        if (symbol && peek() === '?' && s[at + 1] === '$')
        {
            // A symbol that is a template of its own: no back reference.
            next();
            const special = operatorName();
            first = special.name;
            kind = special.kind;
        }
        else if (consume('?$'))
        {
            ({ name: first } = template());
            remember(first);
        }
        else if (consume('?'))
        {
            const special = operatorName();
            first = special.name;
            kind = special.kind;
        }
        else if (peek() >= '0' && peek() <= '9')
        {
            first = names[next().charCodeAt(0) - 0x30] ?? fail();
        }
        else
        {
            first = fragment();
            remember(first);
        }
        const rest = scopes();
        if (kind === 'constructor' || kind === 'destructor')
        {
            const owner = rest[0] ?? fail();
            first = `${kind === 'destructor' ? '~' : ''}${owner}`;
        }
        if (kind === 'template' && /^operator/.test(first) === false && first.startsWith('<'))
        {
            first = `${rest[0] ?? ''}${first}`;
        }
        return { name: [...rest].reverse().concat(first).join('::'), kind, first };
    };

    /**
     * The modifiers a pointer, a `this` or a variable may carry: __ptr64,
     * __unaligned, __restrict, in any order.
     */
    const modifiers = ()=>{
        const found = { ptr64: false, unaligned: false, restrict: false };
        for (;;)
        {
            if (consume('E'))
            {
                found.ptr64 = true;
            }
            else if (consume('F'))
            {
                found.unaligned = true;
            }
            else if (consume('I'))
            {
                found.restrict = true;
            }
            else
            {
                return found;
            }
        }
    };

    /**
     * What a member function's qualifiers write after its arguments:
     * `const `, `volatile __unaligned `, `const __ptr64`.
     *
     * @param {string} cv @param {{ ptr64: boolean, unaligned: boolean }} mods
     */
    const thisSuffix = (cv, mods)=>{
        let text = (flags & UNDNAME.NO_CV_THISTYPE) !== 0 ? '' : cv;
        if (mods.unaligned && (flags & UNDNAME.NO_MS_THISTYPE) === 0)
        {
            text = join(text, keyword('__unaligned'));
        }
        const ptr64 = mods.ptr64 && (flags & UNDNAME.NO_MS_THISTYPE) === 0
            ? keyword('__ptr64') : '';
        if (ptr64 !== '')
        {
            return `${text === '' ? ' ' : `${text} `}${ptr64}`;
        }
        return text === '' ? '' : `${text} `;
    };

    /** A function's argument list, to its `@` or its closing `Z`. */
    const argumentList = ()=>{
        if (consume('X'))
        {
            return 'void';
        }
        /** @type {string[]} */
        const args = [];
        while (peek() !== '@' && peek() !== 'Z')
        {
            if (at >= s.length)
            {
                fail();
            }
            args.push(argumentType());
        }
        if (consume('Z'))
        {
            args.push('...');
            return args.join(',');
        }
        next();
        return args.join(',');
    };

    /** The throw specification after the arguments: `Z`, none. */
    const throwSpec = ()=>{
        if (!consume('Z'))
        {
            argumentList();
        }
    };

    /** A type in an argument list, remembered for a digit to repeat. */
    const argumentType = ()=>{
        const c = peek();
        if (c >= '0' && c <= '9')
        {
            next();
            return argTypes[c.charCodeAt(0) - 0x30] ?? fail();
        }
        const start = at;
        const text = render(typeNode(), '');
        if (at - start > 1 && argTypes.length < 10)
        {
            argTypes.push(text);
        }
        return text;
    };

    /** A function's convention, return type, arguments and throw spec. @param {string} suffix */
    const functionNode = suffix=>{
        const convention = keyword(CONVENTIONS[next()] ?? fail());
        let returns = null;
        if (!consume('@'))
        {
            returns = returnType();
        }
        const args = argumentList();
        throwSpec();
        return /** @type {Type} */ ({ kind: 'function', convention, returns, args,
            thisSuffix: suffix });
    };

    /** A return type: `?` and a qualifier before a class's, the type otherwise. */
    const returnType = ()=>{
        if (consume('?'))
        {
            const cv = CV[next()] ?? fail();
            const type = typeNode();
            return cv === '' ? type : withCv(type, cv);
        }
        return typeNode();
    };

    /** @param {Type} type @param {string} cv @returns {Type} */
    const withCv = (type, cv)=>{
        if (type.kind === 'basic')
        {
            return { ...type, cv: join(type.cv ?? '', cv) };
        }
        if (type.kind === 'pointer')
        {
            return { ...type, cv: join(type.cv, cv) };
        }
        return type;
    };

    /** A pointer, reference or handle, its letter read. @param {string} letter */
    const pointerNode = letter=>{
        const ownCv = { P: '', Q: 'const', R: 'volatile', S: 'const volatile', A: '',
            B: 'volatile', '&&': '', '&&v': 'volatile' }[letter] ?? '';
        let symbol = letter === 'A' || letter === 'B' ? '&' : letter.startsWith('&&') ? '&&' : '*';
        const mods = modifiers();
        if (consume('$A'))
        {
            symbol = symbol === '*' ? '^' : '%';
        }
        const more = modifiers();
        mods.ptr64 ||= more.ptr64;
        mods.unaligned ||= more.unaligned;
        mods.restrict ||= more.restrict;
        const code = next();
        if (code === '6' || code === '7')
        {
            return /** @type {Type} */ ({ kind: 'pointer', to: functionNode(''), symbol, cv: ownCv,
                pointeeCv: '', ptr64: mods.ptr64, restrict: mods.restrict });
        }
        if (code === '8' || code === '9')
        {
            const owner = qualifiedClass();
            const thisMods = modifiers();
            const cv = CV[next()] ?? fail();
            const fn = functionNode(thisSuffix(cv, thisMods));
            return /** @type {Type} */ ({ kind: 'pointer', to: { ...fn, member: owner }, symbol,
                cv: ownCv, pointeeCv: '', ptr64: mods.ptr64, restrict: mods.restrict });
        }
        if ('QRST'.includes(code))
        {
            const owner = qualifiedClass();
            const pointee = typeNode();
            const cv = { Q: '', R: 'const', S: 'volatile', T: 'const volatile' }[code] ?? '';
            return /** @type {Type} */ ({ kind: 'pointer', to: cv === '' ? pointee
                : withCv(pointee, cv), symbol, cv: '', pointeeCv: '', ptr64: mods.ptr64,
            restrict: mods.restrict, member: owner });
        }
        const pointeeCv = CV[code] ?? fail();
        let pointee = typeNode(false);
        if (mods.unaligned && pointee.kind === 'basic')
        {
            pointee = { ...pointee, unaligned: true };
        }
        if (pointee.kind === 'array')
        {
            return /** @type {Type} */ ({ kind: 'pointer', to: pointee, symbol, cv: ownCv,
                pointeeCv, ptr64: mods.ptr64, restrict: mods.restrict });
        }
        return /** @type {Type} */ ({ kind: 'pointer', to: pointeeCv === '' ? pointee
            : withCv(pointee, pointeeCv), symbol, cv: ownCv, pointeeCv: '', ptr64: mods.ptr64,
        restrict: mods.restrict });
    };

    /** A class's qualified name, as a member pointer names it. */
    const qualifiedClass = ()=>{
        if (peek() >= '0' && peek() <= '9' && s[at + 1] === '@')
        {
            const name = names[next().charCodeAt(0) - 0x30] ?? fail();
            next();
            return name;
        }
        return qualifiedName().name;
    };

    /** An array, `Y` read: its dimensions and element. */
    const arrayNode = ()=>{
        const count = Number(number());
        /** @type {string[]} */
        const dims = [];
        for (let i = 0; i < count; i++)
        {
            dims.push(`[${number()}]`);
        }
        return /** @type {Type} */ ({ kind: 'array', of: typeNode(), dims });
    };

    /** @returns {Type} */
    const typeNode = (inArgs = true)=>{
        const c = next();
        if (BASIC[c] !== undefined)
        {
            return { kind: 'basic', name: BASIC[c] };
        }
        switch (c)
        {
            case '_': {
                const name = EXTENDED[next()];
                return name === undefined ? fail() : { kind: 'basic', name };
            }
            case 'T': return { kind: 'basic', name: `union ${qualifiedName().name}` };
            case 'U': return { kind: 'basic', name: `struct ${qualifiedName().name}` };
            case 'V': return { kind: 'basic', name: `class ${qualifiedName().name}` };
            case 'W': {
                next();
                return { kind: 'basic', name: `enum ${qualifiedName().name}` };
            }
            case 'Y': return arrayNode();
            case 'P': case 'Q': case 'R': case 'S': case 'A': case 'B':
                // A pointer's own qualifier counts only where a type stands
                // alone; one a pointer points at takes the pointee's.
                return pointerNode(inArgs || c === 'A' || c === 'B' ? c : 'P');
            case '$': {
                if (consume('$Q'))
                {
                    return pointerNode('&&');
                }
                if (consume('$R'))
                {
                    return pointerNode('&&v');
                }
                if (consume('$C'))
                {
                    const cv = CV[next()] ?? fail();
                    return withCv(typeNode(), cv);
                }
                if (consume('$B'))
                {
                    return typeNode();
                }
                if (consume('$A6'))
                {
                    return functionNode('');
                }
                return fail();
            }
            default:
                return fail();
        }
    };

    /**
     * A type written around a declarator: the declarator inside a pointer
     * to a function's or an array's parentheses, after any other type.
     *
     * @param {Type} type @param {string} declarator
     * @param {boolean} [tight]  A function's own name and arguments, which
     *     a pointer to a function returned is written against.
     * @returns {string}
     */
    const render = (type, declarator, tight = false)=>{
        switch (type.kind)
        {
            case 'basic': {
                const base = join(type.name, type.cv ?? '',
                    type.unaligned ? keyword('__unaligned') : '');
                return declarator === '' ? base : `${base} ${declarator}`;
            }
            case 'array':
                return render(type.of, declarator === ''
                    ? type.dims.join('') : `(${declarator})${type.dims.join('')}`);
            case 'function': {
                const head = type.member === undefined ? declarator
                    : `${type.member}::${declarator}`;
                const inner = `(${/^[*&^%]/.test(head) ? `${type.convention}${head}`
                    : join(type.convention, head)})(${type.args})${type.thisSuffix}`;
                return type.returns === null ? inner : render(type.returns, inner);
            }
            case 'pointer': {
                const toFunction = type.to.kind === 'function';
                const extra = join(type.ptr64 ? keyword('__ptr64') : '',
                    type.restrict ? keyword('__restrict') : '');
                const member = type.member === undefined ? '' : `${type.member}::`;
                let own;
                if (toFunction)
                {
                    own = `${type.symbol}${join(extra, type.cv)}`;
                }
                else
                {
                    own = join(`${member}${type.symbol}`, extra, type.cv);
                }
                if (type.to.kind === 'array' && type.pointeeCv !== '')
                {
                    own = `${type.pointeeCv} ${own}`;
                }
                const inner = declarator === '' ? own
                    : `${own}${toFunction && (tight || !/^[\w`<~]/.test(declarator)) ? '' : ' '}${declarator}`;
                return render(type.to, inner);
            }
            default:
                return fail();
        }
    };

    /**
     * A whole symbol, the leading `?` read: its name, then what kind of
     * thing it is and its types.
     *
     * @param {boolean} [nested]  Inside another's name, in quotes.
     */
    const symbolText = (nested = false)=>{
        if (!nested && consume('$'))
        {
            // `?$name@args`: a template's name alone.
            at--;
            return '';
        }
        const { name, kind, first } = qualifiedName(true);
        const text = declaration(name, kind, first);
        return (flags & UNDNAME.NAME_ONLY) !== 0 ? name : text;
    };

    /**
     * What follows a symbol's name, written with it.
     *
     * @param {string} name @param {string} kind @param {string} first
     */
    const declaration = (name, kind, first)=>{
        const code = next();
        const access = (/** @type {number} */ group)=>
            ((flags & UNDNAME.NO_ACCESS_SPECIFIERS) !== 0 ? '' : `${ACCESS[group]}:`);
        if (code >= '0' && code <= '5')
        {
            return variable(name, code);
        }
        if (code === '6' || code === '7')
        {
            return table(name);
        }
        if (code === '8')
        {
            return kind === 'rtti' ? first : name;
        }
        if (code === '$')
        {
            return thunk(name, access);
        }
        const index = code.charCodeAt(0) - 0x41;
        if (index < 0 || index > 25)
        {
            return fail();
        }
        if (index >= 24)
        {
            return functionDeclaration(name, kind, '', '', '');
        }
        const group = index >> 3;
        // Eight letters to an access: two each for a plain, a static, a
        // virtual member and an adjusting thunk, the second of each far.
        const member = (index & 7) >> 1;
        let prefix = '';
        let suffix = '';
        if (member !== 1)
        {
            const mods = modifiers();
            const cv = CV[next()] ?? fail();
            suffix = thisSuffix(cv, mods);
        }
        if (member === 1)
        {
            prefix = 'static';
        }
        if (member === 2)
        {
            prefix = 'virtual';
        }
        if (member === 3)
        {
            const adjustment = number();
            return `[thunk]:${functionDeclaration(`${name}\`adjustor{${adjustment}}' `, kind,
                access(group), 'virtual', suffix)}`;
        }
        return functionDeclaration(name, kind, access(group), prefix, suffix);
    };

    /**
     * A function's whole text.
     *
     * @param {string} name @param {string} kind @param {string} access
     * @param {string} prefix @param {string} suffix
     */
    const functionDeclaration = (name, kind, access, prefix, suffix)=>{
        const fn = functionNode(suffix);
        if (fn.kind !== 'function')
        {
            return fail();
        }
        let label = name;
        let returns = fn.returns;
        if (kind === 'cast' && returns !== null)
        {
            label = `${name} ${render(returns, '')}`;
            if (returns.kind === 'basic' && returns.cv)
            {
                label += ' ';
            }
            returns = null;
        }
        if ((flags & UNDNAME.NO_FUNCTION_RETURNS) !== 0)
        {
            returns = null;
        }
        const head = join(access, prefix);
        const call = `${join(fn.convention, label)}(${fn.args})${fn.thisSuffix}`;
        if (returns === null)
        {
            return join(head, call);
        }
        return join(head, renderReturn(returns, call));
    };

    /**
     * A function's return type around its name and arguments: a pointer's
     * own qualifiers dropped, as the runtime writes a return.
     *
     * @param {Type} returns @param {string} call
     */
    const renderReturn = (returns, call)=>{
        const bare = returns.kind === 'pointer' && returns.to.kind === 'function'
            ? { ...returns, cv: '' } : returns;
        return render(bare, call, true);
    };

    /** A variable's text. @param {string} name @param {string} code */
    const variable = (name, code)=>{
        const type = typeNode();
        const storage = storageClass();
        const group = code.charCodeAt(0) - 0x30;
        const head = group <= 2
            ? join((flags & UNDNAME.NO_ACCESS_SPECIFIERS) !== 0 ? '' : `${ACCESS[group]}:`,
                'static')
            : '';
        const declarator = join(storage, name);
        return join(head, render(type, declarator));
    };

    /** A variable's own qualifiers: `const`, `__ptr64`, a member's class. */
    const storageClass = ()=>{
        const mods = modifiers();
        const letter = next();
        let cv;
        if ('QRST'.includes(letter))
        {
            cv = { Q: '', R: 'const', S: 'volatile', T: 'const volatile' }[letter] ?? '';
            qualifiedClass();
        }
        else
        {
            cv = CV[letter] ?? fail();
        }
        return join(cv, mods.ptr64 ? keyword('__ptr64') : '');
    };

    /** A virtual table's text: `const X::`vftable'{for `Y'}`. @param {string} name */
    const table = name=>{
        const cv = CV[next()] ?? fail();
        /** @type {string[]} */
        const bases = [];
        while (peek() !== '@')
        {
            if (at >= s.length)
            {
                fail();
            }
            bases.push(`\`${qualifiedName().name}'`);
        }
        next();
        return `${join(cv, name)}${bases.length > 0 ? `{for ${bases.join('s ')}}` : ''}`;
    };

    /**
     * A thunk, `$` read: a vtordisp, a vtordispex or a vcall.
     *
     * @param {string} name @param {(group: number) => string} access
     */
    const thunk = (name, access)=>{
        if (consume('B'))
        {
            const offset = unsigned();
            next();
            const convention = keyword(CONVENTIONS[next()] ?? fail());
            return `[thunk]: ${convention} ${name}{${offset},{flat}}' }'`;
        }
        const extended = consume('R');
        const code = next();
        const group = Math.floor((code.charCodeAt(0) - 0x30) / 2);
        const values = extended ? [unsigned(), unsigned(), unsigned(), unsigned()]
            : [unsigned(), unsigned()];
        const mods = modifiers();
        const cv = CV[next()] ?? fail();
        const label = `${name}\`${extended ? 'vtordispex' : 'vtordisp'}{${values.join(',')}}' `;
        return `[thunk]:${functionDeclaration(label, '', access(group), 'virtual',
            thisSuffix(cv, mods))}`;
    };

    return {
        /** A symbol: `?` and a name, or `?$` and a template's name alone. */
        symbol(){
            if (!consume('?'))
            {
                return fail();
            }
            if (consume('$'))
            {
                return template().name;
            }
            return symbolText();
        },

        /** A type alone: `?` and a qualifier before it, or the type. */
        dataType(){
            if (consume('?'))
            {
                const cv = CV[next()] ?? fail();
                return render(cv === '' ? typeNode() : withCv(typeNode(), cv), '');
            }
            return render(typeNode(), '');
        },

        /** Whether all of the text was read. */
        done: ()=>at === s.length,
    };
}
