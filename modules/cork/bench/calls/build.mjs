/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The calling-convention benchmark as one page that opens from disk: the
 * benchmark (`calls.mjs`) and the workloads (`profiles.json`) written into it.
 *
 *     node modules/cork/bench/calls/build.mjs [out.html]   # default calls.html beside it
 */

import { readFileSync, writeFileSync } from 'node:fs';

const here = (/** @type {string} */ name)=>new URL(`./${name}`, import.meta.url);
const benchmark = readFileSync(here('calls.mjs'), 'utf8');
const profiles = readFileSync(here('profiles.json'), 'utf8');
const page = readFileSync(here('page.html'), 'utf8');
const html = page
    .replace('/* PROFILES */', ()=>`const PROFILES = ${profiles.trim()};`)
    .replace('/* BENCHMARK */', ()=>benchmark);
const out = process.argv[2] ?? new URL('./calls.html', import.meta.url);
writeFileSync(out, html);
console.log(`written ${typeof out === 'string' ? out : out.pathname} (${html.length} bytes)`);
