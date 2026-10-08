/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ERROR_INVALID_COMMAND_LINE, INSTALLUILEVEL, parseMsiexec, repairBits, runMsiexec,
} from './msiexec.js';
import { fakeContext } from './context.fixture.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';
const { NONE, BASIC, REDUCED, FULL, ENDDIALOG, PROGRESSONLY, HIDECANCEL } = INSTALLUILEVEL;

/** @param {string} line */
const plan = line=>parseMsiexec(line);

test('the actions, each with its target, glued to the letter or after it', ()=>{
    assert.deepEqual([plan('/i setup.msi').action, plan('/i setup.msi').target],
        ['install', 'setup.msi']);
    assert.deepEqual([plan(`/I${PRODUCT}`).action, plan(`/I${PRODUCT}`).target],
        ['install', PRODUCT], 'an uninstall string\'s spelling');
    assert.deepEqual([plan(`/X${PRODUCT}`).action, plan(`-x ${PRODUCT}`).action],
        ['uninstall', 'uninstall']);
    assert.equal(plan('/a setup.msi').action, 'admin');
    assert.deepEqual([plan('/package a.msi').action, plan('/uninstall a.msi').action],
        ['install', 'uninstall'], 'the standard options\' spellings');
    assert.deepEqual([plan('/i "C:\\My Setup\\a.msi"').target], ['C:\\My Setup\\a.msi'],
        'a quoted path is one argument, its quotes taken off');
});

test('/f takes REINSTALLMODE\'s letters, "omus" when it is given none', ()=>{
    assert.deepEqual([plan(`/fvomus ${PRODUCT}`).action, plan(`/fvomus ${PRODUCT}`).repairMode],
        ['repair', 'vomus']);
    assert.equal(plan('/f a.msi').repairMode, 'omus');
    assert.equal(plan(`/f${PRODUCT}`).target, PRODUCT);
    assert.equal(plan('/fz a.msi').action, 'usage', 'a letter REINSTALLMODE has not');
    assert.equal(repairBits('omus'), 0x4 | 0x80 | 0x100 | 0x200);
    assert.equal(repairBits('pecmsuv'), 0x2 | 0x8 | 0x20 | 0x80 | 0x200 | 0x100 | 0x400);
});

test('the interface options are INSTALLUILEVEL values and their modifiers', ()=>{
    /** @param {string} option */
    const ui = option=>plan(`/i a.msi ${option}`).ui;
    assert.equal(plan('/i a.msi').ui, null, 'none asked for');
    assert.equal(ui('/q'), NONE);
    assert.equal(ui('/qn'), NONE);
    assert.equal(ui('/QN+'), NONE | ENDDIALOG);
    assert.equal(ui('/qb'), BASIC);
    assert.equal(ui('/qb-!'), BASIC | PROGRESSONLY | HIDECANCEL);
    assert.equal(ui('/qr'), REDUCED);
    assert.equal(ui('/qf'), FULL);
    assert.equal(ui('/quiet'), NONE);
    assert.equal(ui('/passive'), BASIC | PROGRESSONLY | HIDECANCEL);
    assert.equal(plan('/i a.msi /qx').action, 'usage');
});

test('properties are kept as typed, and the options that stand for one add it', ()=>{
    assert.equal(plan('/i a.msi INSTALLDIR="C:\\Program Files\\X" FOO=1 /norestart').properties,
        'INSTALLDIR="C:\\Program Files\\X" FOO=1 REBOOT=ReallySuppress');
    assert.equal(plan('/i a.msi /forcerestart').properties, 'REBOOT=Force');
    assert.equal(plan('/i a.msi /promptrestart').properties, '');
    assert.equal(plan('/i a.msi /t "a.mst;b.mst"').properties, 'TRANSFORMS="a.mst;b.mst"');
});

test('/l takes its letters and a file; with none, "iwearmo"', ()=>{
    assert.deepEqual(plan('/i a.msi /l*v C:\\log.txt').log,
        { mode: 0x10 | 0x4 | 0x2 | 0x100 | 0x200 | 0x8 | 0x800 | 0x1 | 0x80 | 0x400 | 0x1000,
            attributes: 0, path: 'C:\\log.txt' });
    assert.deepEqual(plan('/i a.msi /l log.txt').log,
        { mode: 0x10 | 0x4 | 0x2 | 0x100 | 0x200 | 0x1 | 0x80, attributes: 0, path: 'log.txt' });
    assert.equal(plan('/i a.msi /L+!e x.log').log?.attributes, 3);
    assert.equal(plan('/i a.msi /log x.log').log?.mode, plan('/i a.msi /l* x.log').log?.mode);
    assert.equal(plan('/i a.msi /l').action, 'usage', 'a log needs a file');
});

test('patches, advertisements and patch removal', ()=>{
    assert.deepEqual([plan('/p fix.msp').action, plan('/p fix.msp').target], ['patch', 'fix.msp']);
    assert.deepEqual([plan('/update a.msp;b.msp').action, plan('/update a.msp;b.msp').target],
        ['patch', 'a.msp;b.msp']);
    const image = plan('/a C:\\image\\a.msi /p fix.msp');
    assert.deepEqual([image.action, image.target, image.image],
        ['patch', 'fix.msp', 'C:\\image\\a.msi']);
    const advertised = plan('/jm a.msi /t a.mst /g 1033');
    assert.deepEqual([advertised.action, advertised.assign, advertised.transforms,
        advertised.language, advertised.properties], ['advertise', 0, 'a.mst', 1033, '']);
    assert.equal(plan('/ju a.msi').assign, 1);
    assert.equal(plan('/j a.msi').action, 'usage', 'to the user or the machine, said');
    const removal = plan(`/uninstall {AAAAAAAA-1111-4222-8333-944455556666} /package ${PRODUCT}`);
    assert.deepEqual([removal.action, removal.product], ['removePatches', PRODUCT]);
});

test('a line msiexec would not take is a usage error', ()=>{
    for (const line of ['', '/?', '/h', '/i', '/i a.msi /x b.msi', 'junk', '/z x', '/qn',
        '/i a.msi stray', '/g x /i a.msi'])
    {
        assert.equal(plan(line).action, 'usage', line);
    }
    assert.equal(plan('/regserver').action, 'service');
});

test('msiexec drives msi.dll\'s exports and exits with what they answered', async()=>{
    const install = fakeContext('msiexec /i setup.msi /qn P=1', call=>
        (call.name === 'MsiInstallProductW' ? 3010 : 0));
    assert.equal(await runMsiexec(install.context), 3010);
    assert.deepEqual(install.calls.map(call=>[call.name, call.args]), [
        ['MsiSetInternalUI', [NONE, 0]],
        ['MsiInstallProductW', ['L"setup.msi"', 'L"P=1"']],
    ]);

    const full = fakeContext('"C:\\WINDOWS\\system32\\msiexec.exe" /x a.msi /l x.log');
    await runMsiexec(full.context);
    assert.deepEqual(full.calls.map(call=>[call.name, call.args]), [
        ['MsiSetInternalUI', [FULL, 0]],
        ['MsiEnableLogW', [0x10 | 0x4 | 0x2 | 0x100 | 0x200 | 0x1 | 0x80, 'L"x.log"', 0]],
        ['MsiInstallProductW', ['L"a.msi"', 'L"REMOVE=ALL"']],
    ], 'the full interface unless told otherwise; a package removed by REMOVE=ALL');

    /** @param {string} line */
    const last = async line=>{
        const run = fakeContext(`msiexec ${line}`);
        await runMsiexec(run.context);
        const call = run.calls.at(-1);
        return [call?.name, call?.args];
    };
    assert.deepEqual(await last(`/I${PRODUCT} A=1`),
        ['MsiConfigureProductExW', [`L"${PRODUCT}"`, 0, 5, 'L"A=1"']]);
    assert.deepEqual(await last(`/x ${PRODUCT}`),
        ['MsiConfigureProductExW', [`L"${PRODUCT}"`, 0, 2, 'L""']]);
    assert.deepEqual(await last(`/fpecms ${PRODUCT} IGNORED=1`),
        ['MsiReinstallProductW', [`L"${PRODUCT}"`, repairBits('pecms')]]);
    assert.deepEqual(await last('/f a.msi'),
        ['MsiInstallProductW', ['L"a.msi"', 'L"REINSTALL=ALL REINSTALLMODE=omus"']]);
    assert.deepEqual(await last('/a a.msi TARGETDIR=C:\\img'),
        ['MsiInstallProductW', ['L"a.msi"', 'L"ACTION=ADMIN TARGETDIR=C:\\img"']]);
    assert.deepEqual(await last('/ju a.msi /t a.mst /g 1031'),
        ['MsiAdvertiseProductW', ['L"a.msi"', 1, 'L"a.mst"', 1031]]);
    assert.deepEqual(await last(`/uninstall p.msp /package ${PRODUCT}`),
        ['MsiRemovePatchesW', ['L"p.msp"', `L"${PRODUCT}"`, 2, 'L""']]);
    assert.deepEqual(await last('/p fix.msp'),
        ['MsiApplyPatchW', ['L"fix.msp"', 0, 0, 'L""']]);
});

test('a list of patches goes on in turn, stops at a failure, and keeps a restart', async()=>{
    /** @param {number[]} answers */
    const run = async answers=>{
        const each = fakeContext('msiexec /update a.msp;b.msp;c.msp /qn', call=>
            (call.name === 'MsiApplyPatchW' ? answers.shift() : 0));
        const code = await runMsiexec(each.context);
        return [code, each.calls.filter(call=>call.name === 'MsiApplyPatchW').length];
    };
    assert.deepEqual(await run([0, 3010, 0]), [3010, 3]);
    assert.deepEqual(await run([0, 1603, 0]), [1603, 2]);
});

test('a usage error exits 1639, with the usage shown unless told to be quiet', async()=>{
    const shown = fakeContext('msiexec /?');
    assert.equal(await runMsiexec(shown.context), ERROR_INVALID_COMMAND_LINE);
    assert.equal(shown.calls.length, 1);
    assert.match(String(shown.calls[0].message), /msiexec \/i/);
    const quiet = fakeContext('msiexec /qn');
    assert.equal(await runMsiexec(quiet.context), ERROR_INVALID_COMMAND_LINE);
    assert.deepEqual(quiet.calls, [], 'nothing shown, nothing installed');
    const service = fakeContext('msiexec /regserver');
    assert.equal(await runMsiexec(service.context), 0);
    assert.deepEqual(service.calls, []);
});
