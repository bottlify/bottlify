/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocs, checkTypedef, sectionTable, shownDefault, valueOf }
    from './check-cork-settings.mjs';

/** @type {Record<string, import('../../modules/cork/src/runtime/settings.js').Setting>} */
const SETTINGS = {
    port: { kind: 'host', value: undefined, shown: 'none', doc: 'The port.' },
    bytes: { kind: 'host', value: 256 << 20, doc: 'The bytes.' },
    exact: { kind: 'debug', value: false, doc: 'Exact.' },
    after: { kind: 'test', value: 1 << 16, doc: 'After.' },
};

/** A page with the three tables as the settings make them. @param {typeof SETTINGS} settings */
const pageOf = settings=>['# cork settings', '',
    ...['host', 'debug', 'test'].flatMap(kind=>[`<!-- settings: ${kind} -->`,
        sectionTable(settings, /** @type {'host' | 'debug' | 'test'} */ (kind)),
        '<!-- /settings -->', ''])].join('\n');

/** A typedef naming the keys given, with the text given. @param {Record<string, string>} keys */
const typedefOf = keys=>['/**', ' * @typedef {Object} EngineConfig',
    ...Object.entries(keys).map(([name, text])=>` * @property {{ a: number }} [${name}]  ${text}`),
    ' */'].join('\n');

test('a default shows as a size, a power of two, a word, or as the entry says', ()=>{
    assert.equal(shownDefault(SETTINGS.bytes), '256 MiB');
    assert.equal(shownDefault(SETTINGS.after), '2^16');
    assert.equal(shownDefault(SETTINGS.exact), '`false`');
    assert.equal(shownDefault(SETTINGS.port), 'none');
    assert.equal(shownDefault({ kind: 'test', value: 10_000, doc: '' }), '10000');
    assert.deepEqual(['256 MiB', '2^16', '`false`', '2 (`createMachine`: 50)', 'none', '10_000']
        .map(valueOf), [256 << 20, 1 << 16, false, 2, undefined, 10_000]);
});

test('the page the settings make passes, and one row off in any way fails', ()=>{
    const page = pageOf(SETTINGS);
    assert.deepEqual(checkDocs(page, SETTINGS).problems, []);
    assert.equal(checkDocs(page, SETTINGS).written, page);
    const broken = {
        'a row missing': page.replace(/^\| `exact`.*\n/m, ''),
        'a row of no setting': page.replace('| `exact`', '| `gone` | `true` | Gone. |\n| `exact`'),
        'another default': page.replace('| `after` | 2^16 |', '| `after` | 2^20 |'),
        'another line': page.replace('The bytes.', 'Some bytes.'),
        'a row in another section': page.replace(/^(\| `exact`.*)\n/m, '')
            .replace('| `after`', '| `exact` | `false` | Exact. |\n| `after`'),
        'a row outside the tables': `${page}\n| \`port\` | none | The port. |\n`,
        'a section missing': page.replace('<!-- settings: test -->', ''),
    };
    for (const [what, text] of Object.entries(broken))
    {
        assert.notEqual(checkDocs(text, SETTINGS).problems.length, 0, what);
    }
    const written = checkDocs(broken['another line'], SETTINGS).written;
    assert.equal(written, page, '--write makes the page the settings make');
});

test('the typedef names the same keys and gives the same defaults, or fails', ()=>{
    const keys = { port: 'The port.', bytes: 'The bytes. Default 256 MiB.',
        exact: 'Exact. Default false -- as games run.', after: 'After. Default 2^16.' };
    assert.deepEqual(checkTypedef(typedefOf(keys), SETTINGS), []);
    const lacking = Object.fromEntries(Object.entries(keys).filter(([name])=>name !== 'port'));
    assert.deepEqual(checkTypedef(typedefOf(lacking), SETTINGS), ['EngineConfig: no [port]']);
    assert.deepEqual(checkTypedef(typedefOf({ ...keys, extra: 'More.' }), SETTINGS),
        ['EngineConfig: [extra] is no key of the settings table']);
    assert.equal(checkTypedef(typedefOf({ ...keys, after: 'After. Default 2^20.' }), SETTINGS)
        .length, 1, 'another default');
    assert.equal(checkTypedef(typedefOf({ ...keys, exact: 'Exact. Default true.' }), SETTINGS)
        .length, 1, 'another boolean');
});
