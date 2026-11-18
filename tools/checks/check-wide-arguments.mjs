/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a host function or COM method that takes an argument other than
 * a dword by value does not say so to the bridge, or that answers an address
 * does not say that (`returns: 'pointer'`, `checkReturns`).
 *
 * Every handler here is written in the 32-bit stdcall layout: an __int64, a
 * REFERENCE_TIME, a LARGE_INTEGER, a POINT or a double by value is two of its
 * dwords, a GUID or a VARIANT four, a float one. An x86-64 caller passes each
 * such argument in one slot -- a structure wider than eight bytes as a
 * pointer to a copy -- and a float or a double among the first four in an XMM
 * register; the bridge reads them back into the 32-bit layout only for the
 * arguments the spec declares (`quadwords`, `floats`, `structs`). Undeclared,
 * every argument after the first wide one comes early, and a float is read
 * from a general register that never held it: IAudioClient::Initialize took
 * its format pointer from the period's high half and answered E_POINTER to a
 * 64-bit game.
 *
 * What it reads: each `/** RET Name(params) *\/` signature a spec is written
 * under, its parameters classified by type, and the spec's text that follows
 * up to the next comment. A COM method (a spec with `invoke` or `name: '...'`)
 * counts the interface pointer as dword 0. A declaration written as a literal
 * (`quadwords: [3, 5]`, `floats: { 1: 'f32' }`, `structs: { 1: 4 }`) or as a
 * constant of the same file must name exactly the dwords the signature has; a
 * float past the fourth slot needs none (it is its stack slot's low dword).
 * One built some other way is taken on trust and listed with `--verbose`.
 *
 * What it cannot see: a function or method with no signature comment right
 * above its spec -- a spec made by a helper (`controlAs(...)`), a slot table of
 * `[name, dwords]` pairs (quartz, dmusic, the graphics seams), a signature
 * whose types are typedefs it does not know -- and whether a handler reads the
 * dwords it declared. KNOWN lists the signatures left as they are, with why.
 *
 *     node tools/checks/check-wide-arguments.mjs [src] [--verbose]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/common.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Integer types of eight bytes, and the eight-byte structures passed whole in one slot. */
const QUAD = new Set(['REFERENCE_TIME', 'LONGLONG', 'ULONGLONG', 'LARGE_INTEGER',
    'ULARGE_INTEGER', 'UINT64', 'INT64', 'DWORDLONG', 'DWORD64', 'ULONG64', 'LONG64',
    '__int64', 'int64_t', 'uint64_t', 'FILETIME', 'CY', 'CURRENCY', 'POINT', 'POINTL', 'SIZE',
    'SIZEL', 'MFTIME', 'QWORD', 'REGHANDLE', 'TRACEHANDLE', 'PROCESSTRACE_HANDLE', 'USN']);
/** Floating types of eight bytes. */
const DOUBLE = new Set(['double', 'DOUBLE', 'DATE', 'GLdouble', 'GLclampd', 'REFTIME']);
/** Floating types of four bytes. */
const SINGLE = new Set(['float', 'FLOAT', 'D3DVALUE', 'REAL', 'GLfloat', 'GLclampf']);
/** Structures wider than eight bytes, by their size in dwords: a pointer to a copy on x86-64. */
const STRUCT = new Map([['VARIANT', 4], ['VARIANTARG', 4], ['DECIMAL', 4], ['GUID', 4],
    ['CLSID', 4], ['IID', 4], ['RECT', 4], ['D3DVECTOR', 3], ['D3DXVECTOR3', 3],
    ['D3DXVECTOR4', 4], ['D3DXCOLOR', 4], ['D3DCOLORVALUE', 4], ['D2D1_COLOR_F', 4],
    ['PROPVARIANT', 4], ['MSG', 7]]);

/**
 * Signatures left as they are, by `file :: name`, with why: the list only
 * shrinks -- one that is fixed fails until it is taken off.
 *
 * @type {Map<string, string>}
 */
export const KNOWN = new Map([
    ['modules/core/src/layers/win32/advapi32/eventlog.js :: TraceMessage',
        'variadic, argBytes 0: it reads no argument and answers ERROR_INVALID_HANDLE'],
    ['modules/core/src/layers/win32/kernel32/seh64.js :: RtlLookupFunctionEntry',
        'a 64-bit process\'s alone, written in its layout: DWORD64 is one slot there'],
    ['modules/core/src/layers/win32/kernel32/seh64.js :: RtlVirtualUnwind',
        'a 64-bit process\'s alone, written in its layout: DWORD64 is one slot there'],
    ['modules/core/src/layers/win32/kernel32/seh64.js :: RtlAddFunctionTable',
        'a 64-bit process\'s alone, written in its layout: DWORD64 is one slot there'],
    ...['_allmul', '_alldiv', '_allrem', '_aulldiv', '_aullrem'].map(name=>[
        `modules/core/src/layers/win32/ntdll/integer.js :: ${name}`,
        'the 32-bit compiler\'s helpers: a 64-bit ntdll exports none of them']),
]);

/**
 * @typedef {Object} Layout
 * @property {number[]} quad  Each eight-byte integer's first dword.
 * @property {Record<number, 'f32' | 'f64'>} floats  Each float's first dword.
 * @property {Record<number, number>} slots  Each float's x64 slot, by its first dword.
 * @property {Record<number, number>} structs  Each wide structure's first dword and size.
 */

/**
 * A signature's parameters as the 32-bit layout has them.
 *
 * @param {string} list  The text between the parentheses.
 * @returns {Layout}
 */
export function layoutOf(list){
    /** @type {Layout} */
    const layout = { quad: [], floats: {}, slots: {}, structs: {} };
    const params = list.split(',').map(each=>each.trim()).filter(Boolean);
    if (params.length === 1 && /^void$/i.test(params[0]))
    {
        return layout;
    }
    let word = 0;
    let slot = 0;
    for (const param of params)
    {
        if (param === '...')
        {
            break;
        }
        const at = slot++;
        if (/[*&[]/.test(param))
        {
            word++;
            continue;
        }
        const type = param
            .replace(/\b(const|CONST|struct|enum|unsigned|signed|IN|OUT|OPTIONAL)\b|_In\w*_|_Out\w*_/g, ' ')
            .trim().split(/\s+/)[0];
        const size = STRUCT.get(type);
        if (QUAD.has(type))
        {
            layout.quad.push(word);
            word += 2;
        }
        else if (DOUBLE.has(type) || SINGLE.has(type))
        {
            layout.floats[word] = DOUBLE.has(type) ? 'f64' : 'f32';
            layout.slots[word] = at;
            word += DOUBLE.has(type) ? 2 : 1;
        }
        else if (size)
        {
            layout.structs[word] = size;
            word += size;
        }
        else
        {
            word++;
        }
    }
    return layout;
}

/**
 * A declaration's literal: itself when it is one, the file's constant of that
 * name when it is a name, null when it is built some other way.
 *
 * @param {string} text  The whole file.
 * @param {string} value  What follows `quadwords:`, `floats:` or `structs:`.
 * @returns {string | null}
 */
function literalOf(text, value){
    if (value.startsWith('[') || value.startsWith('{'))
    {
        return balanced(value, 0);
    }
    const name = /^(\w+)/.exec(value)?.[1];
    if (!name)
    {
        return null;
    }
    const defined = new RegExp(String.raw`const\s+${name}\s*=\s*(?:Object\.freeze\()?\s*(?=[[{])`)
        .exec(text);
    return defined ? balanced(text, defined.index + defined[0].length) : null;
}

/**
 * The bracketed text that opens at `at`, its inner brackets -- a JSDoc cast's
 * braces among them -- kept whole.
 *
 * @param {string} text @param {number} at
 * @returns {string | null}
 */
function balanced(text, at){
    let depth = 0;
    for (let i = at; i < text.length; i++)
    {
        if (text[i] === '[' || text[i] === '{')
        {
            depth++;
        }
        else if ((text[i] === ']' || text[i] === '}') && --depth === 0)
        {
            return text.slice(at, i + 1);
        }
    }
    return null;
}

/** @param {string} literal @returns {Record<number, string>} by first dword */
const entriesOf = literal=>(literal.startsWith('[')
    ? Object.fromEntries([...literal.matchAll(/\d+/g)].map(match=>[Number(match[0]), 'q']))
    : Object.fromEntries([...literal.matchAll(/(\d+)\s*:(?:\s*(\d+)|[^,]*?['"](f32|f64)['"])/g)]
        .map(match=>[Number(match[1]), match[2] ?? match[3]])));

/**
 * Whether a declaration says what the signature has: every entry it must
 * name, and none the signature does not have.
 *
 * @param {string} text  The whole file.
 * @param {string | undefined} value  The declaration's text, if there is one.
 * @param {Record<number, string>} want  What it must name.
 * @param {Record<number, string>} all  What it may name.
 * @param {string} key
 * @returns {{ problem: string | null, trusted: boolean }}
 */
function compare(text, value, want, all, key){
    if (value === undefined)
    {
        return Object.keys(want).length === 0 ? { problem: null, trusted: false }
            : { problem: `${key} ${JSON.stringify(want)} not declared`, trusted: false };
    }
    const literal = literalOf(text, value.trim());
    if (literal === null)
    {
        return { problem: null, trusted: true };
    }
    const declared = entriesOf(literal);
    const missing = Object.entries(want)
        .some(([word, kind])=>String(declared[Number(word)]) !== kind);
    const wrong = Object.entries(declared).some(([word, kind])=>String(all[Number(word)]) !== kind);
    return missing || wrong
        ? { problem: `${key} ${literal.replace(/\s+/g, ' ')} where the signature has ${
            JSON.stringify(all)}`, trusted: false }
        : { problem: null, trusted: false };
}

/**
 * The floats a `returningDouble(fpu, bytes, compute, floats)` or
 * `returningSingle(...)` spec names: its call's fourth argument, when it has one.
 *
 * @param {string} spec
 * @returns {string | undefined}
 */
function lastArgumentOf(spec){
    const call = /returning(?:Double|Single)\(/.exec(spec);
    if (!call)
    {
        return undefined;
    }
    /** @type {string[]} */
    const args = [];
    let depth = 0;
    let from = call.index + call[0].length;
    for (let i = from; i < spec.length; i++)
    {
        const c = spec[i];
        if ('([{'.includes(c))
        {
            depth++;
        }
        else if (')]}'.includes(c) && depth-- === 0)
        {
            args.push(spec.slice(from, i));
            break;
        }
        else if (c === ',' && depth === 0)
        {
            args.push(spec.slice(from, i));
            from = i + 1;
        }
    }
    return args.length >= 4 ? args[3].trim() : undefined;
}

/**
 * The body of a helper `const name = (...)=>(...)` of the same file, or ''.
 *
 * @param {string} text @param {string} name
 * @returns {string}
 */
function helperBody(text, name){
    const defined = new RegExp(String.raw`const\s+${name}\s*=\s*(?:\([^)]*\)|\w+)\s*=>\s*`)
        .exec(text);
    if (!defined)
    {
        return '';
    }
    const at = defined.index + defined[0].length;
    return /[([{]/.test(text[at]) ? balanced(text, at) ?? '' : text.slice(at, at + 400);
}

/**
 * Each signature of `text` that has a wide argument, with what its spec says.
 *
 * @param {string} text
 * @returns {{ name: string, line: number, problem: string | null, trusted: boolean }[]}
 */
export function checkText(text){
    const found = [];
    const comment = /\/\*\*\s*(?:\r?\n\s*\*)?\s*(?:[A-Za-z_]\w*\s+)+?\**\s*(\w+)\s*\(/g;
    for (const match of text.matchAll(comment))
    {
        const open = (match.index ?? 0) + match[0].length - 1;
        const end = text.indexOf('*/', open);
        let depth = 0;
        let close = -1;
        for (let i = open; i < end; i++)
        {
            if (text[i] === '(')
            {
                depth++;
            }
            else if (text[i] === ')' && --depth === 0)
            {
                close = i;
                break;
            }
        }
        if (close < 0)
        {
            continue;
        }
        const layout = layoutOf(text.slice(open + 1, close).replace(/\r?\n\s*\*/g, ' '));
        if (layout.quad.length === 0 && Object.keys(layout.floats).length === 0
            && Object.keys(layout.structs).length === 0)
        {
            continue;
        }
        const next = text.indexOf('/**', end);
        const spec = text.slice(end + 2, next < 0 ? text.length : next);
        // A spec a helper makes is the line right under the comment
        // (`Name: toBstr(20, ...)`, `...both('Name', ...)`): what it is told
        // of its wide arguments is passed to it, and read here.
        const helper = /^\s*(?:\w+\s*:|\.\.\.)\s*(?!async\b|function\b)(\w+)\(/.exec(spec)?.[1];
        // A comment over no spec -- a helper, a typedef, an implementation a
        // slot table describes -- declares nothing.
        if (!/argBytes|returning(Double|Single)|invoke\s*:|handler\s*:/.test(spec) && !helper)
        {
            continue;
        }
        const shift = /invoke\s*:|name\s*:\s*['"]/.test(spec) ? 1 : 0;
        /** @param {Record<number, string>} map */
        const shifted = map=>Object.fromEntries(Object.entries(map)
            .map(([word, kind])=>[Number(word) + shift, String(kind)]));
        const quads = shifted(Object.fromEntries(layout.quad.map(word=>[word, 'q'])));
        // A double anywhere is two dwords here and one slot there; a float
        // among the first four slots is in an XMM register there. A float
        // past them is its stack slot's low dword, and needs no word.
        const allFloats = shifted(layout.floats);
        const wantFloats = shifted(Object.fromEntries(Object.entries(layout.floats)
            .filter(([word, kind])=>kind === 'f64' || layout.slots[Number(word)] + shift < 4)));
        const structs = shifted(layout.structs);
        // A spec a helper makes may carry its declaration in the helper's own
        // body (`controlAs`); one guestEntry makes declares its floats from
        // the compiled function's own parameters, and is taken as it is.
        if (helper === 'guestEntry')
        {
            found.push({ name: match[1], line: text.slice(0, match.index).split('\n').length,
                trusted: true, problem: null });
            continue;
        }
        const body = helper ? helperBody(text, helper) : '';
        /** @param {string} key @returns {string | undefined} */
        const declared = key=>{
            const own = new RegExp(String.raw`${key}\s*:\s*([^\n]*)`).exec(spec)?.[1];
            if (own !== undefined)
            {
                return own;
            }
            // In the helper's body only a literal or a constant: a parameter
            // it forwards (`...marshal`) is the call's to say.
            const inBody = new RegExp(String.raw`${key}\s*:\s*(?=[[{]|[A-Z][A-Z0-9_]*\b)`)
                .exec(body);
            return inBody ? body.slice(inBody.index + inBody[0].length) : undefined;
        };
        const floatText = declared('floats') ?? lastArgumentOf(spec);
        const checks = [
            compare(text, declared('quadwords'), quads, quads, 'quadwords'),
            compare(text, floatText, wantFloats, allFloats, 'floats'),
            compare(text, declared('structs'), structs, structs, 'structs'),
        ];
        const problems = checks.map(check=>check.problem).filter(Boolean);
        found.push({
            name: match[1],
            line: text.slice(0, match.index).split('\n').length,
            trusted: checks.some(check=>check.trusted),
            problem: problems.length > 0 ? problems.join('; ') : null,
        });
    }
    return found;
}

/**
 * Pointer-sized types whose value is an address or an unsigned size: a 64-bit
 * process's RAX holds it zero-extended. Any type written with a `*` is one too,
 * and so is every `LP...` typedef. A pointer-sized type left out -- HANDLE,
 * LRESULT, LONG_PTR, INT_PTR, LPARAM, a handle the host makes up -- is
 * sign-extended, as INVALID_HANDLE_VALUE is -1 whole; a dword type's high half
 * the caller never reads.
 */
export const POINTER_RESULTS = new Set(['PVOID', 'PSTR', 'PWSTR', 'PCSTR', 'PCWSTR', 'PTSTR',
    'size_t', 'SIZE_T', 'ULONG_PTR', 'UINT_PTR', 'DWORD_PTR', 'uintptr_t', 'WPARAM',
    'HGLOBAL', 'HLOCAL', 'HMODULE', 'HINSTANCE', 'FARPROC', 'HRSRC', 'BSTR', 'PSLIST_ENTRY',
    'PCCERT_CONTEXT', 'PCCRL_CONTEXT', 'PCCTL_CONTEXT', 'PIDLIST_ABSOLUTE', 'PIDLIST_RELATIVE',
    'PITEMID_CHILD', '_invalid_parameter_handler', '_purecall_handler', '_PNH',
    'PTOP_LEVEL_EXCEPTION_FILTER',
    'PRUNTIME_FUNCTION', 'PEXCEPTION_ROUTINE', 'PVECTORED_EXCEPTION_HANDLER']);

/** Words a signature's return type may carry that are not its type. */
const NOT_TYPE = new RegExp(String.raw`\b(WINAPI|CALLBACK|APIENTRY|__stdcall|__cdecl|CDECL|`
    + String.raw`STDMETHODCALLTYPE|const|CONST|struct|unsigned|signed|static|inline|extern|NTAPI|`
    + String.raw`NTSYSAPI|WINBASEAPI|WINUSERAPI)\b`, 'g');

/**
 * Whether a signature's return type, as its comment writes it before the
 * name, is an address the bridge widens with zeros.
 *
 * @param {string} written  e.g. `LPVOID`, `void *`, `const char *`, `HANDLE`
 */
export function returnsPointer(written){
    if (written.includes('*'))
    {
        return true;
    }
    const type = written.replace(NOT_TYPE, ' ').trim().split(/\s+/).pop() ?? '';
    return POINTER_RESULTS.has(type) || /^LP[A-Z]/.test(type);
}

/**
 * The dwords of a signature's parameters, in the 32-bit layout, that hold an
 * address: what a 64-bit handler reads whole (`pointerArg`, the bridge's
 * `args.high`) once addresses pass 4 GiB. A wide argument before one moves it
 * as `layoutOf` counts; a by-value structure is no address.
 *
 * @param {string} list  The text between the parentheses.
 * @returns {number[]}
 */
export function pointersOf(list){
    const params = list.split(',').map(each=>each.trim()).filter(Boolean);
    if (params.length === 1 && /^void$/i.test(params[0]))
    {
        return [];
    }
    /** @type {number[]} */
    const found = [];
    let word = 0;
    for (const param of params)
    {
        if (param === '...')
        {
            break;
        }
        const type = param.replace(/\b(IN|OUT|OPTIONAL)\b|_In\w*_|_Out\w*_/g, ' ').trim();
        const named = type.replace(NOT_TYPE, ' ').trim().split(/\s+/)[0] ?? '';
        if (type.includes('*') || type.includes('[') || returnsPointer(named))
        {
            found.push(word);
        }
        const layout = layoutOf(param);
        word += layout.quad.length * 2 + Object.values(layout.structs).reduce((a, b)=>a + b, 0)
            + Object.values(layout.floats).filter(kind=>kind === 'f64').length * 2
            + Object.values(layout.floats).filter(kind=>kind === 'f32').length
            || 1;
    }
    return found;
}

/**
 * Each signature of `text` over a spec, with whether its result is an address
 * and whether the spec says so (`returns: 'pointer'`): one that returns an
 * address and does not say so is widened by its sign in a 64-bit process -- a
 * VirtualAlloc above 2 GiB answered 0xFFFFFFFF_9xxxxxxx -- and one that says
 * so and returns no address would make INVALID_HANDLE_VALUE 0x00000000_FFFFFFFF.
 * A spec a helper makes says so where it is made: `Name: { ...make(...),
 * returns: 'pointer' }`, or the helper's call passes it (`...both(name, n,
 * body, { returns: 'pointer' })`).
 *
 * @param {string} text
 * @returns {{ name: string, line: number, pointer: boolean, problem: string | null }[]}
 */
export function checkReturns(text){
    const found = [];
    const comment = /\/\*\*\s*(?:\r?\n\s*\*)?\s*((?:[A-Za-z_]\w*\s*\**\s+)+?\**)\s*(\w+)\s*\(/g;
    for (const match of text.matchAll(comment))
    {
        const end = text.indexOf('*/', match.index ?? 0);
        if (end < 0 || end < (match.index ?? 0) + match[0].length)
        {
            continue;
        }
        const next = text.indexOf('/**', end);
        const spec = text.slice(end + 2, next < 0 ? text.length : next);
        const helper = /^\s*(?:\w+\s*:|\.\.\.)\s*(?!async\b|function\b)(\w+)\(/.exec(spec)?.[1];
        // A spec named by a constant of the file (`malloc: allocator,`) is
        // that constant's object.
        const named = /^\s*\w+\s*:\s*([A-Za-z_]\w*)\s*,/.exec(spec)?.[1];
        const defined = named
            ? new RegExp(String.raw`const\s+${named}\s*=\s*(?=\{)`).exec(text) : null;
        const object = defined ? balanced(text, defined.index + defined[0].length) ?? '' : spec;
        // Only a spec right under its comment: an object with what a host
        // function is made of, or the line a helper makes one with.
        const made = /^\s*(?:['"]?[\w$.]+['"]?\s*:\s*)?\{(?:\s*\.\.\.\w+\(|[^]*?\b(argBytes|invoke|handler)\s*:)/;
        if (!made.test(object) && !helper)
        {
            continue;
        }
        const pointer = returnsPointer(match[1]);
        const own = /\breturns\s*:\s*['"](\w+)['"]/.exec(object)?.[1];
        const line = text.slice(0, match.index).split('\n').length;
        const problem = pointer && own !== 'pointer'
            ? `returns ${match[1].trim()}, an address, without returns: 'pointer'`
            : !pointer && own !== undefined
                ? `returns: '${own}' over ${match[1].trim()}, which is no address` : null;
        found.push({ name: match[2], line, pointer, problem });
    }
    return found;
}

/** @param {string} dir @returns {string[]} */
function sources(dir){
    /** @type {string[]} */
    const out = [];
    for (const name of readdirSync(dir))
    {
        const path = join(dir, name);
        if (statSync(path).isDirectory())
        {
            out.push(...sources(path));
        }
        else if (name.endsWith('.js') && !/\.(i?test|fixture|x86|x64)\.js$/.test(name))
        {
            out.push(path);
        }
    }
    return out;
}

if (isMain(import.meta.url))
{
    const args = process.argv.slice(2);
    const verbose = args.includes('--verbose');
    const src = resolve(args.find(arg=>!arg.startsWith('--'))
        ?? join(ROOT, 'modules', 'core', 'src', 'layers'));
    const failures = [];
    let checked = 0;
    for (const file of sources(src))
    {
        const where = relative(ROOT, file).replace(/\\/g, '/');
        for (const one of checkText(readFileSync(file, 'utf8')))
        {
            checked++;
            const key = `${where} :: ${one.name}`;
            if (one.problem && !KNOWN.has(key))
            {
                failures.push(`${where}:${one.line} ${one.name}: ${one.problem}`);
            }
            else if (!one.problem && KNOWN.has(key))
            {
                failures.push(`${key} is declared now: take it off KNOWN`);
            }
            else if (verbose && one.trusted)
            {
                console.log(`trusted ${where}:${one.line} ${one.name}`);
            }
        }
    }
    let results = 0;
    let addresses = 0;
    for (const file of sources(src))
    {
        const where = relative(ROOT, file).replace(/\\/g, '/');
        for (const one of checkReturns(readFileSync(file, 'utf8')))
        {
            results++;
            addresses += one.pointer ? 1 : 0;
            if (one.problem)
            {
                failures.push(`${where}:${one.line} ${one.name}: ${one.problem}`);
            }
        }
    }
    if (failures.length > 0)
    {
        console.error(`check-wide-arguments: ${failures.length} of ${checked} signatures with a`
            + ' wide argument are not as the bridge must be told:');
        for (const line of failures)
        {
            console.error(`  ${line}`);
        }
        process.exit(1);
    }
    console.log(`check-wide-arguments: ${checked} signatures with a wide argument, each declared;`
        + ` ${results} results, the ${addresses} addresses among them declared`);
}
