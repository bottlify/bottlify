/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from './version.js';
import { version } from './index.js';

test('the version the module says is package.json\'s', ()=>{
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, manifest.version,
        'src/version.js is behind package.json: run `node scripts/stamp-version.mjs` in modules/cork');
    assert.equal(version, VERSION, 'and the entry module exports it');
});
