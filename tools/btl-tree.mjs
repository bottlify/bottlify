#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a bottle carries, by directory: the files and bytes under each path to
 * a given depth, largest first, so what an installation left that is not the
 * program -- a setup's cache, a copy of its own package -- is seen at once.
 *
 *   node tools/btl-tree.mjs <bundle.btl> [depth]
 */

import { openBundle } from './btl.mjs';

const [path, depthText] = process.argv.slice(2);
if (!path)
{
    console.error('usage: node tools/btl-tree.mjs <bundle.btl> [depth]');
    process.exit(2);
}
const depth = Number(depthText ?? 3);
const bundle = await openBundle(path);
/** @type {Map<string, { files: number, bytes: number }>} */
const groups = new Map();
for (const file of bundle.list())
{
    const key = file.path.split('\\').slice(0, Math.max(1, depth)).join('\\');
    const group = groups.get(key) ?? { files: 0, bytes: 0 };
    group.files += 1;
    group.bytes += file.size;
    groups.set(key, group);
}
const total = bundle.list().reduce((sum, file)=>sum + file.size, 0);
/** @param {number} bytes @param {number} files @param {string} what */
const line = (bytes, files, what)=>
    `${(bytes / 1048576).toFixed(1).padStart(8)} MB ${String(files).padStart(5)}  ${what}`;
for (const [key, group] of [...groups].sort((a, b)=>b[1].bytes - a[1].bytes))
{
    console.log(line(group.bytes, group.files, key));
}
console.log(line(total, bundle.list().length, 'total'));
await bundle.close();
