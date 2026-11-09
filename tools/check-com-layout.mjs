#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Checks a table of COM interfaces - each method's name and the bytes a
 * stdcall call to it pops - against the C vtables of an SDK header.
 *
 *   node tools/check-com-layout.mjs <header.h> <module.js> [export]
 *
 * The module exports `{ Name: { methods: [[method, bytes], ...] } }` (by
 * default `INTERFACES`); the header is one whose interfaces are declared as
 * `typedef struct NameVtbl { ... HRESULT (STDMETHODCALLTYPE *Method)(Name *This, ...); }`,
 * as mingw-w64's are. A 32-bit argument is four bytes; a double, a
 * LARGE_INTEGER and its unsigned twin eight; anything with a `*` four.
 * An interface the header does not declare is listed and passed over.
 * Exits 1 on a method whose name, place or bytes differ.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [header, modulePath, exportName = 'INTERFACES'] = process.argv.slice(2);
if (!header || !modulePath)
{
    console.error('usage: node tools/check-com-layout.mjs <header.h> <module.js> [export]');
    process.exit(2);
}
const text = readFileSync(header, 'utf8');
const table = (await import(pathToFileURL(resolve(modulePath)).href))[exportName];

const EIGHT = /^(?:const\s+)?(?:double|DOUBLE|LARGE_INTEGER|ULARGE_INTEGER|LONGLONG|ULONGLONG|INT64|UINT64|__int64|unsigned __int64)\b/;

/** The bytes one argument takes on the stack. @param {string} arg */
const bytesOf = arg=>(arg.includes('*') ? 4 : EIGHT.test(arg.trim()) ? 8 : 4);

/** @param {string} name */
const vtableOf = name=>{
    const start = text.indexOf(`typedef struct ${name}Vtbl {`);
    if (start < 0)
    {
        return null;
    }
    const end = text.indexOf(`} ${name}Vtbl;`, start);
    const body = text.slice(start, end);
    const methods = body.matchAll(/\(STDMETHODCALLTYPE \*(\w+)\)\(([^;]*)\);/g);
    return [...methods].map(([, method, args])=>[method, args.split(',')
        .map(arg=>arg.replace(/\s+/g, ' ').trim()).filter(Boolean)
        .reduce((sum, arg)=>sum + bytesOf(arg), 0)]);
};

let bad = 0;
for (const [name, layout] of Object.entries(table))
{
    const vtable = vtableOf(name);
    if (!vtable)
    {
        console.log(`not in the header: ${name}`);
        continue;
    }
    // The header's vtable starts with IUnknown's and every base's methods.
    const own = vtable.slice(vtable.length - layout.methods.length);
    layout.methods.forEach(([method, bytes], index)=>{
        const [want, wantBytes] = own[index] ?? ['(none)', 0];
        if (want !== method || wantBytes !== bytes)
        {
            bad++;
            console.log(`${name}::${method} [${index}] ${bytes} bytes;`
                + ` the header: ${want} ${wantBytes}`);
        }
    });
}
console.log(bad === 0 ? 'every method agrees' : `${bad} methods differ`);
process.exit(bad === 0 ? 0 : 1);
