/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enginePackageIssue } from './boundaries.mjs';

test('an import of an engine package from the core is a boundary issue', ()=>{
    assert.equal(enginePackageIssue('@bottlify/cork'),
        'imports @bottlify/cork: core must not depend on an engine package');
    assert.equal(enginePackageIssue('@bottlify/cork/runtime'),
        'imports @bottlify/cork: core must not depend on an engine package');
});

test('anything else passes, including a name that merely starts alike', ()=>{
    assert.equal(enginePackageIssue('./internal/v86-host.js'), null);
    assert.equal(enginePackageIssue('node:fs'), null);
    assert.equal(enginePackageIssue('@bottlify/corkscrew'), null);
});
