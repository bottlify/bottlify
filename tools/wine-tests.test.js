/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { againstReference, classify, markdown, parseOutput, summarise } from './wine-tests.mjs';

/** @param {Partial<import('./wine-tests.mjs').ChildResult>} [extra] */
const result = (extra = {})=>({
    output: '', exitCode: 0, error: null, killed: false, died: null, wallMs: 10,
    unimplemented: [], divergences: [], missing: [], unresolved: [], ...extra,
});

test('the closing count, the failed checks and the skips are read from the text', ()=>{
    const parsed = parseOutput([
        'alpha.c:12: Test failed: expected 1, got 0\r',
        'alpha.c:30: Test succeeded inside todo block: held anyway',
        'alpha.c:40: Tests skipped: no device',
        'alpha.c:41: some trace',
        '0a2c:alpha: 120 tests executed (3 marked as todo, 0 as flaky, 2 failures), 1 skipped.',
    ].join('\n'), 'alpha');
    assert.deepEqual(parsed.summary, { executed: 120, todo: 3, flaky: 0, failures: 2, skipped: 1 });
    assert.deepEqual(parsed.failed.map(check=>[check.file, check.line, check.kind]), [
        ['alpha.c', 12, 'Test failed'],
        ['alpha.c', 30, 'Test succeeded inside todo block'],
    ]);
    assert.equal(parsed.failed[0].message, 'expected 1, got 0');
    assert.equal(parsed.skips, 1);
});

test('a line written in pieces is read once it is whole, with the elapsed time field too', ()=>{
    const parsed = parseOutput(['beta.c:7:', '1.250', ' Test failed: ', 'no\n',
        '0001:beta:2.000 1 tests executed (0 marked as todo, 1 failure), 0 skipped.\n'].join(''));
    assert.equal(parsed.failed.length, 1);
    assert.equal(parsed.summary?.failures, 1);
});

test('a child process\'s closing count does not stand in for the test\'s own', ()=>{
    const parsed = parseOutput([
        '0010:gamma: 900 tests executed (0 marked as todo, 0 as flaky, 0 failures), 0 skipped.',
        '0011:child: 5 tests executed (0 marked as todo, 0 as flaky, 5 failures), 0 skipped.',
    ].join('\n'), 'gamma');
    assert.equal(parsed.summary?.executed, 900);
});

test('a child running the same test is told apart by its process, and never closes the test', ()=>{
    const tail = '(0 marked as todo, 0 as flaky, 0 failures), 0 skipped.';
    const child = `2000:msg: 19 tests executed ${tail}`;
    const own = `1000:msg: 900 tests executed ${tail}`;
    assert.equal(parseOutput([child, own].join('\n'), 'msg', 0x1000).summary?.executed, 900);
    assert.equal(parseOutput([own, child].join('\n'), 'msg', 0x1000).summary?.executed, 900);
    assert.equal(parseOutput(child, 'msg', 0x1000).summary, null,
        'a test whose own process never closed has no count, whatever its child printed');
});

test('the names a --list prints are the program\'s tests', ()=>{
    const parsed = parseOutput('Valid test names:\r\n    one\r\n    two\r\n');
    assert.deepEqual(parsed.names, ['one', 'two']);
});

test('a run is classed by how it ended before by what it printed', ()=>{
    const passed = parseOutput(
        '1000:t: 3 tests executed (0 marked as todo, 0 failures), 0 skipped.');
    assert.equal(classify(result(), passed), 'pass');
    assert.equal(classify(result({ killed: true }), passed), 'timeout');
    assert.equal(classify(result({ died: 'child exited SIGSEGV' }), passed), 'engine-crash');
    assert.equal(classify(result({ error: { reason: 'runaway', message: '' } }), passed),
        'timeout');
    assert.equal(classify(result({ error: { reason: 'deadlock', message: '' } }), passed),
        'deadlock');
    assert.equal(classify(result({ error: { reason: 'host-call', message: 'TypeError' } }),
        passed), 'engine-crash');
    assert.equal(classify(result({ error: { reason: 'guest-fault',
        message: 'unimplemented import user32.dll!Foo, called from 0x401000' } }), passed),
    'unimplemented');
    assert.equal(classify(result({ error: { reason: 'guest-fault', message: 'page fault' } }),
        passed), 'guest-fault');

    const empty = parseOutput('');
    assert.equal(classify(result(), empty), 'no-summary');
    assert.equal(classify(result(), parseOutput('Fatal: test \'x\' does not exist.')),
        'no-such-test');
    assert.equal(classify(result(), parseOutput(
        '1000:t: unhandled exception c0000005 at 00401000')), 'guest-exception');
    assert.equal(classify(result(), parseOutput(
        '1000:t: 3 tests executed (0 marked as todo, 0 as flaky, 1 failure), 0 skipped.')), 'fail');
});

test('a run that did not finish counts the failed checks it printed', ()=>{
    const report = summarise('lib', 't', result({
        output: 'a.c:1: Test failed: x\na.c:2: Test failed: y\n',
        error: { reason: 'runaway', message: 'program did not finish' },
    }));
    assert.equal(report.status, 'timeout');
    assert.equal(report.failures, 2);
    assert.equal(report.executed, null);
});

test('the markdown groups a failing line checked in a loop and compares with a baseline', ()=>{
    const now = summarise('lib', 't', result({ output: [
        'a.c:5: Test failed: n=1', 'a.c:5: Test failed: n=2', 'a.c:9: Test failed: other',
        '1000:t: 10 tests executed (0 marked as todo, 0 as flaky, 3 failures), 0 skipped.',
    ].join('\n') }));
    const before = { ...now, failures: 7, status: 'fail' };
    const text = markdown({ build: 'b', engine: 'cork', started: 's', tests: [now] },
        { failures: 20, baseline: { tests: [before] } });
    assert.match(text, /`a\.c:5` \(x2\): n=1/);
    assert.match(text, /\| lib:t \| fail \| 10 \| 3 \| 0 \| 0 \| 0\.0 \| fail, 7 -> 3 \|/);
});

test('a check that fails only on the tested engine is the translator\'s, set apart', ()=>{
    const tested = summarise('lib', 't', result({ output: [
        'a.c:5: Test failed: x87', 'a.c:7: Test failed: layer', 'a.c:7: Test failed: layer',
        '1000:t: 10 tests executed (0 marked as todo, 0 as flaky, 3 failures), 0 skipped.',
    ].join('\n') }));
    const reference = summarise('lib', 't', result({ output: [
        'a.c:7: Test failed: layer',
        '1000:t: 10 tests executed (0 marked as todo, 0 as flaky, 1 failure), 0 skipped.',
    ].join('\n') }));
    const against = againstReference(tested, reference, 'emulator');
    assert.deepEqual(against.onlyHere.map(check=>check.message), ['x87']);
    assert.equal(against.statusOnlyHere, false);

    tested.reference = against;
    const text = markdown({ build: 'b', engine: 'cork', started: 's', tests: [tested] },
        { failures: 20, baseline: null });
    assert.match(text, /## Only on cork \(held on emulator\)[\s\S]*`a\.c:5`: x87/);
    // The shared failure is the layers', listed under the failed checks and not
    // with the translator's.
    assert.match(text, /## Failed checks\n\n### lib:t \(3 failures, 1 of them cork-only\)\n\n- `a\.c:7` \(x2\)/);
});

test('a run that stops where the reference finished ended worse there', ()=>{
    const stopped = summarise('lib', 't',
        result({ error: { reason: 'guest-fault', message: 'x' } }));
    const finished = summarise('lib', 't', result({
        output: '1000:t: 1 tests executed (0 marked as todo, 0 failures), 0 skipped.' }));
    assert.equal(againstReference(stopped, finished, 'emulator').statusOnlyHere, true);
    assert.equal(againstReference(finished, stopped, 'emulator').statusOnlyHere, false);
});

test('a hang where the reference stopped on an exception ended worse, a pass never did', ()=>{
    const hung = summarise('lib', 't', result({ killed: true }));
    const excepted = summarise('lib', 't', result({
        output: '1000:t: unhandled exception c0000005 at 00000000' }));
    assert.equal(againstReference(hung, excepted, 'emulator').statusOnlyHere, true);
    assert.equal(againstReference(excepted, hung, 'emulator').statusOnlyHere, false);
});

test('the names a test asked for and did not get are listed, but for the Wine probe', ()=>{
    const report = summarise('lib', 't', result({
        missing: ['ntdll.dll!wine_server_call', 'msvcrt.dll!_get_environ'] }));
    const text = markdown({ build: 'b', engine: 'cork', started: 's', tests: [report] },
        { failures: 20, baseline: null });
    assert.match(text, /## Asked for by name and not found\n\n- lib:t: msvcrt\.dll!_get_environ\n/);
});
