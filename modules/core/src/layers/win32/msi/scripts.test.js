/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Script custom actions through msi.dll: JScript and VBScript in the action's
 * Target, in the Binary table with a function to call, and deferred with only
 * its CustomActionData -- each working the Session object, and the
 * installation reading back what the scripts set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsiFunctions } from './functions.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { HKEY_LOCAL_MACHINE } from '../advapi32/registry.js';
import { databaseBytes } from './database-writer.js';
import { MACHINE, machine, packageDatabase, registryText, typed } from './install.fixture.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';

const CHECK = `
function Check()
{
    var record = Session.Installer.CreateRecord(1);
    record.StringData(0) = "[1]";
    record.StringData(1) = Session.Property("ProductName");
    Session.Property("NAME") = Session.FormatRecord(record) + "!";
    var view = Session.Database.OpenView("SELECT \`Directory\` FROM \`Directory\` " +
        "WHERE \`Directory_Parent\` = 'ProgramFilesFolder'");
    view.Execute();
    var row = view.Fetch();
    Session.Property("FOLDER") = row.StringData(1) + ":" + (view.Fetch() == null);
    view.Close();
    return 1;
}`;

/** CHECK in VBScript: the same calls, with a Function's answer as its name assigned. */
const CHECK_VB = `
Function Check()
    Dim record, view, row
    Set record = Session.Installer.CreateRecord(1)
    record.StringData(0) = "[1]"
    record.StringData(1) = Session.Property("ProductName")
    Session.Property("NAME") = Session.FormatRecord(record) & "!"
    Set view = Session.Database.OpenView("SELECT \`Directory\` FROM \`Directory\` " & _
        "WHERE \`Directory_Parent\` = 'ProgramFilesFolder'")
    view.Execute
    Set row = view.Fetch
    Session.Property("FOLDER") = row.StringData(1) & ":" & LCase(CStr(view.Fetch Is Nothing))
    view.Close
    Check = 1
End Function`;

/**
 * A package whose execute sequence runs the scripts given, then writes three
 * properties to the registry.
 *
 * @param {[string, number, string | null, string | null][]} actions
 */
const tables = actions=>/** @type {import('./install.fixture.js').Tables} */ ({
    Property: [['Property', 'Value'], [['ProductCode', PRODUCT], ['ProductName', 'Game'],
        ['ProductVersion', '1.0'], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033'],
        ['ProgramFilesFolder', 'C:\\Program Files\\']]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'], ['ProgramFilesFolder', 'TARGETDIR', '.'],
        ['INSTALLDIR', 'ProgramFilesFolder', 'Game']]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0]]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [['Core', '{11111111-1111-1111-1111-111111111111}', 'INSTALLDIR', 4, null,
        'reg']]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Core']]],
    Registry: [['Registry', 'Root', 'Key', 'Name', 'Value', 'Component_'], [
        ['reg', 2, 'Software\\Game', 'Inline', '[INLINE]', 'Core'],
        ['name', 2, 'Software\\Game', 'Name', '[NAME]', 'Core'],
        ['folder', 2, 'Software\\Game', 'Folder', '[FOLDER]', 'Core'],
    ]],
    Binary: [['Name', 'Data'], [['Script', 1]]],
    CustomAction: [['Action', 'Type', 'Source', 'Target'], actions],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], [
        ['CostInitialize', null, 800], ['CostFinalize', null, 1000],
        ...actions.map(([action], index)=>/** @type {[string, null, number]} */ (
            [action, null, 1100 + index])),
        ['InstallValidate', null, 1400], ['InstallInitialize', null, 1500],
        ['Deferred', null, 1550], ['ProcessComponents', null, 1600],
        ['WriteRegistryValues', null, 5000], ['RegisterProduct', null, 6100],
        ['InstallFinalize', null, 6600]].filter(entry=>entry[0] !== 'Deferred'
        || actions.some(([action])=>action === 'Deferred'))],
});

/** Installs the package through msi.dll; its answer and the machine. */
async function install(/** @type {Parameters<typeof tables>[0]} */ actions, binary = CHECK){
    const host = await machine(['C:\\src']);
    const node = host.files.open('C:\\src\\game.msi', { write: true, create: true });
    host.files.write(node, 0, await databaseBytes(typed(packageDatabase(tables(actions),
        { 'Binary.Script': encodeAnsi(binary) }))));
    host.files.close(node);
    const memory = new Uint8Array(0x40000);
    let next = 0x20000;
    /** @type {string[]} */
    const said = [];
    const fns = /** @type {any} */ (createMsiFunctions(/** @type {any} */ ({
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>memory.subarray(at, at + n),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
            memory.set(data, at),
        readCString: (/** @type {number} */ at)=>decodeAnsi(memory.subarray(at,
            memory.indexOf(0, at))),
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += size + 16;
            return at;
        },
        free: ()=>{},
        hive: host.hive, files: host.files, fullPath: (/** @type {string} */ path)=>path,
        callerThread: ()=>null, machine: ()=>MACHINE,
        log: (/** @type {string} */ line)=>void said.push(line),
    })));
    memory.set(encodeAnsi('C:\\src\\game.msi\0'), 0x100);
    memory.set(encodeAnsi('\0'), 0x200);
    const code = await fns.MsiInstallProductA.handler([0x100, 0x200]);
    /** @param {string} name */
    const value = name=>registryText(host.hive, HKEY_LOCAL_MACHINE, 'Software\\Game', name);
    return { code, value, said };
}

test('JScript actions work the Session, its Installer, records and views', async()=>{
    const { code, value } = await install([
        ['Inline', 37, null, 'Session.Property("INLINE") = "set " + (1 + 2);'],
        ['Check', 5, 'Script', 'Check'],
        ['SetData', 51, 'Deferred', 'payload'],
        ['Deferred', 37 | 0x400, null,
            'if (Session.Property("CustomActionData") != "payload" '
            + '|| Session.Property("ProductName") != "") throw new Error("not deferred");'],
    ]);
    assert.equal(code, 0);
    assert.equal(value('Inline'), 'set 3');
    assert.equal(value('Name'), 'Game!', 'a record formatted by the session');
    assert.equal(value('Folder'), 'INSTALLDIR:true', 'a view fetched to its end');
});

test('a script that fails fails its action, unless the action ignores it', async()=>{
    const broken = await install([['Inline', 37, null, 'this is not JScript ;;; (']]);
    assert.equal(broken.code, 1603);
    assert.ok(broken.said.some(line=>/script error/.test(line)), 'and says why');
    const ignored = await install([['Inline', 37 | 0x40, null, 'throw new Error("no");']]);
    assert.equal(ignored.code, 0);
    const aborted = await install([['Check', 5, 'Script', 'Missing']]);
    assert.equal(aborted.code, 1603, 'a function the script does not have');
});

test('VBScript actions work the Session as JScript\'s do', async()=>{
    const { code, value, said } = await install([
        ['Inline', 38, null, 'Session.Property("INLINE") = "set " & (1 + 2)'],
        ['Check', 6, 'Script', 'Check'],
        ['SetData', 51, 'Deferred', 'payload'],
        ['Deferred', 38 | 0x400, null,
            'If Session.Property("CustomActionData") <> "payload" Or '
            + 'Session.Property("ProductName") <> "" Then Err.Raise 5'],
    ], CHECK_VB);
    assert.equal(code, 0, said.join('\n'));
    assert.equal(value('Inline'), 'set 3');
    assert.equal(value('Name'), 'Game!', 'a record formatted by the session');
    assert.equal(value('Folder'), 'INSTALLDIR:true', 'a view fetched to its end');
});

test('a VBScript action fails as a JScript one does: on an error, or a 3 from its function',
    async()=>{
        const broken = await install([['Inline', 38, null, 'If Then Else']]);
        assert.equal(broken.code, 1603);
        assert.ok(broken.said.some(line=>/script error 10\d\d/.test(line)),
            'a compilation error, by its number');
        const raised = await install([['Inline', 38, null, 'Err.Raise 13']]);
        assert.equal(raised.code, 1603);
        assert.ok(raised.said.some(line=>/script error 13 Type mismatch/.test(line)));
        const resumed = await install([['Inline', 38, null,
            'On Error Resume Next\nErr.Raise 13\nSession.Property("INLINE") = Err.Number']]);
        assert.equal(resumed.code, 0, 'an error the script handles is its own');
        assert.equal(resumed.value('Inline'), '13');
        const failed = await install([['Check', 6, 'Script', 'Check']],
            'Function Check()\n    Check = 3\nEnd Function');
        assert.equal(failed.code, 1603, 'IDABORT from the function');
    });
