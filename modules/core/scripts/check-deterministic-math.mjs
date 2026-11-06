/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when the HLSL compiler folds a constant with one of the Math
 * functions ECMAScript leaves implementation-approximated (sin, exp, log,
 * pow, ...) or with the `**` operator, which is Math.pow.
 *
 * The compiler's output is bytecode a program reads and may hash or cache;
 * those functions answer different last bits on different engines and on x86
 * and ARM, so the same shader would compile to different bytes on two
 * machines. hlsl-math.js has the same functions from correctly rounded
 * operations alone.
 *
 *     node scripts/check-deterministic-math.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIRECTORY = fileURLToPath(new URL('../src/layers/win32/d3dx9/', import.meta.url));
// The Shader Model 4 compiler folds constants into its bytecode the same way.
const MODEL4 = fileURLToPath(new URL('../src/layers/graphics/d3dcompiler/', import.meta.url));
const APPROXIMATED = /\bMath\.(?:sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b/g;
const POWER = /\*\*/;

const files = [
    ...readdirSync(DIRECTORY)
        .filter(name=>/^(?:hlsl-|preprocess).*\.js$/.test(name)
            && !/\.(?:test|itest|fixture)\.js$/.test(name) && name !== 'hlsl-math.js')
        .map(name=>join(DIRECTORY, name)),
    ...readdirSync(MODEL4).filter(name=>name.endsWith('.js')
        && !/\.(?:test|itest|fixture)\.js$/.test(name)).map(name=>join(MODEL4, name)),
];

/** @type {string[]} */
const problems = [];
for (const path of files)
{
    // Split on CRLF too: a Windows checkout's lines end in \r, which `.`
    // does not match, so no comment was taken out and every `/**` read as a
    // power.
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((line, index)=>{
        const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
            .replace(/^\s*\/?\*.*$/, '');
        const found = [...code.matchAll(APPROXIMATED)].map(match=>match[0]);
        if (POWER.test(code))
        {
            found.push('**');
        }
        for (const what of found)
        {
            problems.push(`${relative(process.cwd(), path)}:${index + 1}: ${what}`
                + ' -- use hlsl-math.js, whose answers are the same on every machine');
        }
    });
}
if (problems.length > 0)
{
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`deterministic math: ${files.length} compiler files checked`);
