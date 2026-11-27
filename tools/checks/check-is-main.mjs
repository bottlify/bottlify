/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a script decides whether it is the one node was started with by
 * comparing `process.argv[1]` with its own URL itself, rather than through
 * `isMain` (tools/lib/common.mjs).
 *
 * Three gates and a generator compared `import.meta.url` with
 * `file://${process.argv[1]}`, which on Windows is `file://C:\...` against
 * `file:///C:/...`: never equal, so each ran nothing there and exited 0 - a
 * gate green without having run.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/common.mjs';

const files = execFileSync('git', ['ls-files', 'tools', 'modules/*/bench', 'modules/*/scripts'],
    { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n')
    .filter(file=>/\.m?js$/.test(file) && file !== 'tools/lib/common.mjs');
const found = [];
for (const file of files)
{
    readFileSync(join(REPO_ROOT, file), 'utf8').split('\n').forEach((line, at)=>{
        if (/process\.argv\[1\]/.test(line) && /import\.meta\.url/.test(line))
        {
            found.push(`${file}:${at + 1}: ${line.trim()}`);
        }
    });
}
if (found.length > 0)
{
    console.error('a script compares argv[1] with its own URL itself; use isMain(import.meta.url)'
        + ' from tools/lib/common.mjs:');
    for (const line of found)
    {
        console.error(`  ${line}`);
    }
    process.exit(1);
}
console.log(`check-is-main: ${files.length} scripts, none compares argv[1] with its URL itself`);
