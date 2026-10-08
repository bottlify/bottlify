/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpoolerFunctions } from './functions.js';

test('with no printer installed, opening one fails by name and properties are refused', ()=>{
    /** @type {number[]} */
    const errors = [];
    const fns = createSpoolerFunctions({ setLastError: code=>errors.push(code) });

    assert.equal(fns.OpenPrinterA.handler(), 0);
    assert.deepEqual(errors, [1801], 'ERROR_INVALID_PRINTER_NAME');
    assert.equal(fns.DocumentPropertiesA.handler(), -1);
    assert.equal(fns.ClosePrinter.handler(), 0);

    assert.equal(fns.OpenPrinterA.argBytes, 12);
    assert.equal(fns.ClosePrinter.argBytes, 4);
    assert.equal(fns.DocumentPropertiesA.argBytes, 24);
});

test('there is no port to list', ()=>{
    const bytes = new Uint8Array(16).fill(0xcc);
    const fns = createSpoolerFunctions({ writeMemory: (at, data)=>bytes.set(data, at) });
    assert.equal(fns.EnumPortsA.handler([0, 1, 0, 0, 4, 8]), 1);
    assert.deepEqual([...bytes.subarray(4, 8)], [0, 0, 0, 0], 'none needed');
    assert.deepEqual([...bytes.subarray(8, 12)], [0, 0, 0, 0], 'none returned');
    assert.equal(fns.EnumPortsA.argBytes, 24);
});

const ERROR_SUCCESS = 0;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_LEVEL = 124;
const ERROR_INVALID_PRINTER_NAME = 1801;
const ERROR_CANCELLED = 1223;
const RPC_S_SERVER_UNAVAILABLE = 1722;
const RPC_X_NULL_REF_POINTER = 1780;
const ERROR_INVALID_USER_BUFFER = 1784;
const ERROR_UNKNOWN_PRINTER_DRIVER = 1797;
const ERROR_UNKNOWN_PRINTPROCESSOR = 1798;
const ERROR_INVALID_ENVIRONMENT = 1805;
const ERROR_UNKNOWN_PRINT_MONITOR = 3000;

/** Addresses in the fixture; only their being apart matters. */
const NEEDED = 0x10;
const RETURNED = 0x14;
const NAME = 0x100;
const ENVIRONMENT = 0x200;
const BUFFER = 0x400;

function spooler(){
    const bytes = new Uint8Array(0x1000).fill(0xcc);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    const fns = /** @type {Record<string, { argBytes: number, handler: Function }>} */ (
        createSpoolerFunctions({
            setLastError: code=>errors.push(code),
            writeMemory: (at, data)=>bytes.set(data, at),
            readMemory: (at, length)=>bytes.slice(at, at + length),
        }));
    return {
        fns, errors, bytes, view,
        /** @param {number} at @param {string} text */
        wide(at, text){
            [...text, '\0'].forEach((unit, index)=>view.setUint16(at + index * 2,
                unit.charCodeAt(0), true));
            return at;
        },
        /** @param {number} at @param {string} text */
        ansi(at, text){
            bytes.set([...text, '\0'].map(unit=>unit.charCodeAt(0)), at);
            return at;
        },
        /** @param {number} at */
        dword: at=>view.getUint32(at, true),
    };
}

test('every listing succeeds with nothing in it, after checking its level and environment', ()=>{
    // [name, argBytes, args, answer, last error]
    const cases = /** @type {[string, number, number[], number, number][]} */ ([
        ['EnumPrintersA', 28, [2, 0, 2, 0, 0, NEEDED, RETURNED], 1, ERROR_SUCCESS],
        ['EnumPrintersW', 28, [2, 0, 4, 0, 0, NEEDED, RETURNED], 1, ERROR_SUCCESS],
        ['EnumPrintersW', 28, [2, 0, 3, 0, 0, NEEDED, RETURNED], 0, ERROR_INVALID_LEVEL],
        ['EnumPrintersW', 28, [2, 0, 2, 0, 0, 0, RETURNED], 0, RPC_X_NULL_REF_POINTER],
        ['EnumPortsW', 24, [0, 2, 0, 0, NEEDED, RETURNED], 1, ERROR_SUCCESS],
        ['EnumPortsA', 24, [0, 3, 0, 0, NEEDED, RETURNED], 0, ERROR_INVALID_LEVEL],
        ['EnumMonitorsW', 24, [0, 1, 0, 0, NEEDED, RETURNED], 1, ERROR_SUCCESS],
        ['EnumMonitorsW', 24, [0, 0, 0, 0, NEEDED, RETURNED], 0, ERROR_INVALID_LEVEL],
        ['EnumPrintProcessorsW', 28, [0, 0, 1, 0, 0, NEEDED, RETURNED], 1, ERROR_SUCCESS],
        ['EnumPrintProcessorsW', 28, [0, ENVIRONMENT, 1, 0, 0, NEEDED, RETURNED], 0,
            ERROR_INVALID_ENVIRONMENT],
        ['EnumPrinterDriversW', 28, [0, 0, 3, 0, 0, NEEDED, RETURNED], 1, ERROR_SUCCESS],
        ['EnumPrinterDriversW', 28, [0, 0, 7, 0, 0, NEEDED, RETURNED], 0, ERROR_INVALID_LEVEL],
        ['EnumPrintProcessorDatatypesW', 28, [0, NAME, 1, 0, 0, NEEDED, RETURNED], 0,
            ERROR_UNKNOWN_PRINTPROCESSOR],
        ['EnumPrintProcessorDatatypesW', 28, [0, NAME, 2, 0, 0, NEEDED, RETURNED], 0,
            ERROR_INVALID_LEVEL],
    ]);
    for (const [name, argBytes, args, answer, lastError] of cases)
    {
        const fx = spooler();
        fx.wide(ENVIRONMENT, 'Windows 3.1');
        assert.equal(fx.fns[name].argBytes, argBytes, name);
        assert.equal(fx.fns[name].handler(args), answer, name);
        assert.deepEqual(fx.errors, [lastError], name);
        if (answer === 1)
        {
            assert.deepEqual([fx.dword(NEEDED), fx.dword(RETURNED)], [0, 0], name);
        }
    }
});

test('no printer, job or form handle exists, and the data calls answer with the error', ()=>{
    const failing = /** @type {[string, number][]} */ ([
        ['ClosePrinter', 4], ['GetPrinterW', 20], ['SetPrinterW', 16], ['DeletePrinter', 4],
        ['ResetPrinterW', 8], ['AbortPrinter', 4], ['StartDocPrinterW', 12],
        ['EndDocPrinter', 4], ['StartPagePrinter', 4], ['EndPagePrinter', 4],
        ['WritePrinter', 16], ['ReadPrinter', 16], ['GetPrinterDriverW', 24],
        ['FindClosePrinterChangeNotification', 4], ['AddJobW', 20], ['ScheduleJob', 8],
        ['GetJobA', 24], ['GetJobW', 24], ['SetJobW', 20], ['EnumJobsW', 32], ['AddFormW', 12],
        ['DeleteFormW', 8], ['GetFormW', 24], ['SetFormW', 16], ['EnumFormsW', 24],
    ]);
    for (const [name, argBytes] of failing)
    {
        const fx = spooler();
        assert.equal(fx.fns[name].argBytes, argBytes, name);
        assert.equal(fx.fns[name].handler([0x1234]), 0, name);
        assert.deepEqual(fx.errors, [ERROR_INVALID_HANDLE], name);
    }
    const answering = /** @type {[string, number][]} */ ([
        ['GetPrinterDataW', 24], ['GetPrinterDataExW', 28], ['SetPrinterDataW', 20],
        ['SetPrinterDataExW', 24], ['DeletePrinterDataExW', 12], ['EnumPrinterDataW', 36],
        ['EnumPrinterDataExW', 24], ['EnumPrinterKeyW', 20],
    ]);
    for (const [name, argBytes] of answering)
    {
        const fx = spooler();
        assert.equal(fx.fns[name].argBytes, argBytes, name);
        assert.equal(fx.fns[name].handler([0x1234]), ERROR_INVALID_HANDLE, name);
    }
    const fx = spooler();
    assert.equal(fx.fns.AdvancedDocumentPropertiesW.handler([0, 0x1234, 0, 0, 0]), -1);
    assert.equal(fx.fns.AdvancedDocumentPropertiesW.argBytes, 20);
    assert.deepEqual(fx.errors, [ERROR_INVALID_HANDLE]);
});

test('a printer by name is not there, and the dialogs close with none chosen', ()=>{
    const cases = /** @type {[string, number, number, number][]} */ ([
        ['OpenPrinterW', 12, 0, ERROR_INVALID_PRINTER_NAME],
        ['AddPrinterConnectionW', 4, 0, ERROR_INVALID_PRINTER_NAME],
        ['DeletePrinterConnectionW', 4, 0, ERROR_INVALID_PRINTER_NAME],
        ['DeviceCapabilities', 20, -1, ERROR_INVALID_PRINTER_NAME],
        ['DeviceCapabilitiesA', 20, -1, ERROR_INVALID_PRINTER_NAME],
        ['DeviceCapabilitiesW', 20, -1, ERROR_INVALID_PRINTER_NAME],
        ['ExtDeviceMode', 32, -1, ERROR_INVALID_PRINTER_NAME],
        ['ConnectToPrinterDlg', 8, 0, ERROR_CANCELLED],
    ]);
    for (const [name, argBytes, answer, lastError] of cases)
    {
        const fx = spooler();
        assert.equal(fx.fns[name].argBytes, argBytes, name);
        assert.equal(fx.fns[name].handler([0, NAME, 0, 0, 0]), answer, name);
        assert.deepEqual(fx.errors, [lastError], name);
    }
    const fx = spooler();
    assert.equal(fx.fns.SpoolerInit.handler(), 1);
    assert.equal(fx.fns.SpoolerInit.argBytes, 0);
});

test('changing the spooler\'s setup is refused as for a user who may not, or names nothing', ()=>{
    // [name, argBytes, args, last error]
    const cases = /** @type {[string, number, number[], number][]} */ ([
        ['AddPrinterW', 12, [0, 2, BUFFER], ERROR_ACCESS_DENIED],
        ['AddPrinterW', 12, [0, 1, BUFFER], ERROR_INVALID_LEVEL],
        ['AddPrinterW', 12, [0, 2, 0], ERROR_INVALID_PARAMETER],
        ['AddPrinterDriverW', 12, [0, 3, BUFFER], ERROR_ACCESS_DENIED],
        ['AddPrinterDriverExW', 16, [0, 5, BUFFER, 0], ERROR_INVALID_LEVEL],
        ['AddMonitorW', 12, [0, 2, BUFFER], ERROR_ACCESS_DENIED],
        ['AddMonitorW', 12, [0, 1, 0], ERROR_INVALID_LEVEL],
        ['AddPrintProvidorW', 12, [0, 1, BUFFER], ERROR_ACCESS_DENIED],
        ['AddPrintProcessorW', 16, [0, 0, NAME, NAME], ERROR_ACCESS_DENIED],
        ['AddPrintProcessorW', 16, [0, ENVIRONMENT, NAME, NAME], ERROR_INVALID_ENVIRONMENT],
        ['DeletePrintProvidorW', 12, [0, 0, NAME], ERROR_ACCESS_DENIED],
        ['AddPortW', 12, [0, 0, NAME], ERROR_NOT_SUPPORTED],
        ['AddPortW', 12, [0, 0, 0], RPC_X_NULL_REF_POINTER],
        ['ConfigurePortW', 12, [0, 0, NAME], ERROR_NOT_SUPPORTED],
        ['DeletePortW', 12, [0, 0, NAME], ERROR_NOT_SUPPORTED],
        ['DeleteMonitorW', 12, [0, 0, NAME], ERROR_UNKNOWN_PRINT_MONITOR],
        ['DeleteMonitorW', 12, [0, 0, 0], ERROR_INVALID_PARAMETER],
        ['DeletePrinterDriverW', 12, [0, 0, NAME], ERROR_UNKNOWN_PRINTER_DRIVER],
        ['DeletePrinterDriverExW', 20, [0, 0, NAME, 0, 0], ERROR_UNKNOWN_PRINTER_DRIVER],
        ['DeletePrinterDriverW', 12, [0, ENVIRONMENT, NAME], ERROR_INVALID_ENVIRONMENT],
        ['DeletePrintProcessorW', 12, [0, 0, NAME], ERROR_UNKNOWN_PRINTPROCESSOR],
    ]);
    for (const [name, argBytes, args, lastError] of cases)
    {
        const fx = spooler();
        fx.wide(NAME, 'Something');
        fx.wide(ENVIRONMENT, 'Windows 3.1');
        assert.equal(fx.fns[name].argBytes, argBytes, name);
        assert.equal(fx.fns[name].handler(args), 0, name);
        assert.deepEqual(fx.errors, [lastError], name);
    }
});

test('the spooler\'s directories are there with no printer, sized in bytes', ()=>{
    const fx = spooler();
    const drivers = 'C:\\WINDOWS\\system32\\spool\\DRIVERS\\W32X86';
    const get = fx.fns.GetPrinterDriverDirectoryW.handler;
    assert.equal(get([0, 0, 1, 0, 0, NEEDED]), 0);
    assert.equal(fx.errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(fx.dword(NEEDED), (drivers.length + 1) * 2);
    assert.equal(get([0, 0, 1, 0, 0x200, NEEDED]), 0);
    assert.equal(fx.errors.at(-1), ERROR_INVALID_USER_BUFFER);
    assert.equal(get([0, 0, 1, BUFFER, 0x200, NEEDED]), 1);
    assert.equal(new TextDecoder('utf-16le').decode(
        fx.bytes.subarray(BUFFER, BUFFER + drivers.length * 2)), drivers);
    fx.wide(ENVIRONMENT, 'windows 4.0');
    assert.equal(get([0, ENVIRONMENT, 1, BUFFER, 0x200, NEEDED]), 1, 'case does not matter');
    assert.match(new TextDecoder('utf-16le').decode(fx.bytes.subarray(BUFFER,
        BUFFER + fx.dword(NEEDED) - 2)), /\\WIN40$/);
    fx.wide(ENVIRONMENT, 'Windows 3.1');
    assert.equal(get([0, ENVIRONMENT, 1, BUFFER, 0x200, NEEDED]), 0);
    assert.equal(fx.errors.at(-1), ERROR_INVALID_ENVIRONMENT);
    assert.equal(get([0, 0, 2, BUFFER, 0x200, NEEDED]), 0);
    assert.equal(fx.errors.at(-1), ERROR_INVALID_LEVEL);
    assert.equal(get([0, 0, 1, BUFFER, 0x200, 0]), 0);
    assert.equal(fx.errors.at(-1), RPC_X_NULL_REF_POINTER);
    fx.wide(NAME, '\\\\elsewhere');
    assert.equal(get([NAME, 0, 1, BUFFER, 0x200, NEEDED]), 0);
    assert.equal(fx.errors.at(-1), RPC_S_SERVER_UNAVAILABLE);

    const processors = 'C:\\WINDOWS\\system32\\spool\\PRTPROCS\\W32X86';
    fx.ansi(ENVIRONMENT, '');
    assert.equal(fx.fns.GetPrintProcessorDirectoryA.handler(
        [0, ENVIRONMENT, 1, BUFFER, 0x200, NEEDED]), 1, 'an empty environment is ours');
    assert.equal(fx.dword(NEEDED), processors.length + 1);
    assert.equal(String.fromCharCode(...fx.bytes.subarray(BUFFER, BUFFER + processors.length)),
        processors);
    assert.equal(fx.bytes[BUFFER + processors.length], 0);
    for (const name of ['GetPrinterDriverDirectoryA', 'GetPrinterDriverDirectoryW',
        'GetPrintProcessorDirectoryA', 'GetPrintProcessorDirectoryW'])
    {
        assert.equal(fx.fns[name].argBytes, 24, name);
    }
});
