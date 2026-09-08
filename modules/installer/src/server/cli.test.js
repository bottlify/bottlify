/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArguments } from './cli.js';
import { createBottleServer } from './index.js';

test('with no arguments it writes beside the bundles that are already there', ()=>{
    assert.deepEqual(parseArguments([]), { root: 'bundles', port: 8788, host: '127.0.0.1' });
});

test('an unknown argument is refused rather than ignored', ()=>{
    assert.throws(()=>parseArguments(['--token', 'secret']), /unknown argument --token/);
});

test('a server with no token refuses to exist, rather than opening by default', ()=>{
    assert.throws(()=>createBottleServer({ root: '.', token: '' }), /not public/);
});
