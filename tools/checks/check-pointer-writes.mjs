#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails where a guest pointer is written or read by hand rather than by the one
 * reader and writer every layer goes through: the memory layer's `readPointer`
 * and `writePointer`, win32's guest view's `ptr` and `setPtr` over them
 * (`win32/common/guest.js`), and, for a block put together in a buffer,
 * win32's `pointerWidth` and `pointerIo` (whose rule is the same). Thirteen copies had
 * grown, each writing a dword and a zero beside it in a 64-bit process: every
 * one keeps an address below 4 GiB only, and a 64-bit process given addresses
 * past it wrote the wrong pointer through each.
 *
 * Two rules over core's sources (tests and fixtures aside):
 *  - a `readPointer` or `writePointer` defined anywhere but the two owners
 *    must hand its work to one of them (`.writePointer(`, `.readPointer(`,
 *    `guest.ptr`, `guest.setPtr`, an alias taken from a guest by name,
 *    `pointerIo(`, `pointerWidth(`, `width.bytes(`, `width.get(`);
 *  - no dword zero written at `+ 4` within a few lines under a test of the
 *    pointer's width (`if (long)`, `pointerSize === 8`, ...): a pointer's upper
 *    half made by hand.
 *
 *     node tools/checks/check-pointer-writes.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/common.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SRC = join(ROOT, 'modules/core/src');

/** The two files that own a pointer's reading and writing. */
const OWNERS = new Set(['layers/memory/module.js', 'layers/win32/common/pointers.js']);

const DEFINITION = /(?:const|let)\s+(?:\{[^}]*\b(?:readPointer|writePointer)\b[^}]*\}|(?:readPointer|writePointer))\s*=|\b(?:readPointer|writePointer)\s*:\s*(?:\(|async|[a-z]+\s*=>)|function\s+(?:readPointer|writePointer)\b/;
const DELEGATES = /\.writePointer\(|\.readPointer\(|\bguest\??\.(?:ptr|setPtr)\b|\{[^}]*\b(?:ptr|setPtr)\b[^}]*\}\s*=\s*(?:[\w$]+\??\.)*guest\b|pointerIo\(|pointerWidth\(|width\.bytes\(|width\.get\(/;
const WIDTH_TEST = /if \((?:long|long\(\)|pointerSize === 8|pointer === 8|width\.size === 8|bits === 64|wide)\)/;
const HIGH_HALF = /write(?:U32|32)\([^;]*\+ ?4\)?, 0\)|setUint32\([^;]*\+ ?4, 0, true\)/;

/** @param {string} dir @returns {string[]} */
const sources = dir=>readdirSync(dir).flatMap(name=>{
    const path = join(dir, name);
    if (statSync(path).isDirectory())
    {
        return sources(path);
    }
    return /\.m?js$/.test(name) && !/\.(test|itest|fixture)\.m?js$/.test(name) ? [path] : [];
});

/**
 * The problems in one file's text, each `line: what`.
 *
 * @param {string} name  path under src/
 * @param {string} text
 * @returns {string[]}
 */
export function pointerWriteIssues(name, text){
    if (OWNERS.has(name))
    {
        return [];
    }
    const lines = text.split('\n');
    /** @type {string[]} */
    const issues = [];
    lines.forEach((line, index)=>{
        if (DEFINITION.test(line))
        {
            // The definition's text: its line and the lines of its body, to the
            // first that ends a statement at the definition's own indentation.
            const indent = line.search(/\S/);
            const block = /\{\s*$/.test(line);
            let end = index;
            while (end < lines.length - 1 && (block
                ? !(end > index && lines[end].search(/\S/) === indent && /^\s*\}/.test(lines[end]))
                : !/;\s*(\/\/.*)?$/.test(lines[end])))
            {
                end++;
            }
            const body = lines.slice(index, end + 1).join('\n');
            if (!DELEGATES.test(body))
            {
                issues.push(`${index + 1}: a pointer read or written by hand: hand it to the memory`
                    + ' layer\'s readPointer/writePointer (or win32\'s pointerIo)');
            }
        }
        if (WIDTH_TEST.test(line))
        {
            for (let at = index + 1; at < Math.min(lines.length, index + 5); at++)
            {
                if (HIGH_HALF.test(lines[at]))
                {
                    issues.push(`${at + 1}: a pointer's upper half written as a zero by hand:`
                        + ' write the pointer whole (writePointer)');
                }
            }
        }
    });
    return issues;
}

if (isMain(import.meta.url))
{
    const issues = sources(SRC).flatMap(path=>{
        const name = relative(SRC, path).split('\\').join('/');
        return pointerWriteIssues(name, readFileSync(path, 'utf8')).map(issue=>`${name}:${issue}`);
    });
    if (issues.length > 0)
    {
        console.error(`pointer writes:\n  ${issues.join('\n  ')}`);
        process.exit(1);
    }
    console.log('pointer writes: every pointer goes through the memory layer\'s reader and writer');
}
