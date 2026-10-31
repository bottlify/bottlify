/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceSteamClient, createSteamclientFunctions, steamClientDll } from './functions.js';
import { INTERFACES } from './interfaces.js';
import { createHive } from '../advapi32/registry.js';
import { createRegistryService } from '../advapi32/registry-service.js';

const ACCOUNT = { steamId: '76561197960287930', accountName: 'someone', apps: [400, 620],
    appId: 620 };

/** A guest of plain memory, and a Steam client over it whose placed methods are kept by address. */
function fixture(account = /** @type {any} */ (ACCOUNT), pointerSize = 4){
    const bytes = new Uint8Array(0x100000);
    const view = new DataView(bytes.buffer);
    let next = 0x1000;
    /** @type {Map<number, { name: string, fn: any }>} */
    const placed = new Map();
    let stub = 0x80000;
    /** @type {number[]} */
    const highs = [];
    const fns = createSteamclientFunctions({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        readCString: (at, max)=>{
            let end = at;
            while (end - at < max && bytes[end] !== 0)
            {
                end++;
            }
            return new TextDecoder().decode(bytes.subarray(at, end));
        },
        allocate: size=>{
            const at = next;
            next += (size + 15) & ~15;
            return at;
        },
        register: (name, fn)=>{
            stub += 16;
            placed.set(stub, { name, fn });
            return stub;
        },
        answerHigh: high=>highs.push(high),
        environment: ()=>null,
        account,
        pointerSize: /** @type {4 | 8} */ (pointerSize),
    });
    /** @param {string} text */
    const put = text=>{
        const at = next;
        bytes.set(new TextEncoder().encode(`${text}\0`), at);
        next += text.length + 16;
        return at;
    };
    /** The method in a slot of an object's vtable. @param {number} object @param {number} index */
    const method = (object, index)=>{
        const table = view.getUint32(object, true);
        return /** @type {{ name: string, fn: any }} */ (
            placed.get(view.getUint32(table + index * pointerSize, true)));
    };
    return { fns, view, put, method, highs };
}

test('CreateInterface answers a version the SDK declares, laid out as its header is', ()=>{
    const { fns, put, method, view } = fixture();
    const code = 0x9000;
    const client = fns.CreateInterface.handler([put('SteamClient020'), code]);
    assert.notEqual(client, 0);
    assert.equal(view.getUint32(code, true), 0, 'found');
    const slots = INTERFACES.SteamClient020.split(',');
    // The deprecated callback slots, a function pointer's parentheses and all,
    // keep the slots after them where the header has them.
    assert.equal(method(client, slots.indexOf('GetISteamVideo:12:i')).name,
        'SteamClient020.GetISteamVideo');
    assert.equal(method(client, 0).fn.convention, 'thiscall');
    assert.equal(fns.CreateInterface.handler([put('SteamNothing999'), code]), 0);
    assert.equal(view.getUint32(code, true), 1, 'none');
});

test('no account signed in, no client', ()=>{
    const { fns, put } = fixture(null);
    assert.equal(fns.CreateInterface.handler([put('SteamClient020'), 0]), 0);
});

test('a private method keeps its slot: GetAppID is the tenth of SteamUtils010', ()=>{
    // STEAM_PRIVATE_API( GetCSERIPPort ) sits before it; dropped, every later
    // slot is one early and steam_api reads the wrong method as the app id.
    const { fns, put, method } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const generic = method(client, INTERFACES.SteamClient020.split(',')
        .findIndex(entry=>entry.startsWith('GetISteamGenericInterface:')));
    const utils = generic.fn.handler([client, 1, 1, put('SteamUtils010')]);
    const appId = method(utils, 9);
    assert.equal(appId.name, 'SteamUtils010.GetAppID');
    assert.equal(appId.fn.handler([utils]), 620);
});

test('GetSteamID returns the class through the hidden pointer the caller pushed', ()=>{
    const { fns, put, method, view } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const user = method(client, 5).fn.handler([client, 1, 1, put('SteamUser021')]);
    const getSteamId = method(user, 2);
    assert.equal(getSteamId.name, 'SteamUser021.GetSteamID');
    assert.equal(getSteamId.fn.argBytes, 8, 'this and the hidden pointer');
    const out = 0xa000;
    assert.equal(getSteamId.fn.handler([user, out]), out);
    assert.equal(view.getBigUint64(out, true), 76561197960287930n);
});

test('an app is owned only when the account\'s licences grant it', ()=>{
    const { fns, put, method } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const apps = method(client, 15).fn.handler([client, 1, 1,
        put('STEAMAPPS_INTERFACE_VERSION008')]);
    const slots = INTERFACES.STEAMAPPS_INTERFACE_VERSION008.split(',');
    const subscribed = method(apps, slots.findIndex(entry=>entry.startsWith('BIsSubscribedApp:')));
    assert.equal(subscribed.fn.handler([apps, 620]), 1);
    assert.equal(subscribed.fn.handler([apps, 70]), 0, 'not granted');
    assert.equal(method(apps, 0).fn.handler([apps]), 1, 'BIsSubscribed: the app running');
});

test('a method returning eight bytes answers the high half in EDX', ()=>{
    const { fns, put, method, highs } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const user = method(client, 5).fn.handler([client, 1, 1, put('SteamUser021')]);
    const slots = INTERFACES.SteamUser021.split(',');
    const ticket = method(user,
        slots.findIndex(entry=>entry.startsWith('RequestEncryptedAppTicket:')));
    assert.equal(ticket.fn.argBytes, 12);
    assert.equal(ticket.fn.handler([user, 0, 0]), 0, 'not answered: zero');
    assert.deepEqual(highs, [0]);
});

test('RequestCurrentStats leaves a UserStatsReceived_t for the game to pump', ()=>{
    const { fns, put, method, view } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const stats = method(client, 13).fn.handler([client, 1, 1,
        put('STEAMUSERSTATS_INTERFACE_VERSION012')]);
    assert.equal(method(stats, 0).fn.handler([stats]), 1);
    const out = 0xb000;
    assert.equal(fns.Steam_BGetCallback.handler([1, out, 0]), 1);
    assert.equal(view.getInt32(out + 4, true), 1101);
    const data = view.getUint32(out + 8, true);
    assert.equal(view.getBigUint64(data, true), 620n, 'the game');
    assert.equal(view.getUint32(data + 8, true), 1, 'k_EResultOK');
    assert.equal(fns.Steam_BGetCallback.handler([1, out, 0]), 0, 'and nothing more');
});

test('a running client is announced as Steam writes it: its pid and its library', ()=>{
    const hive = createRegistryService(createHive());
    announceSteamClient(hive, { pid: 0x2040, account: ACCOUNT });
    const active = /** @type {number} */ (hive.open(/** @type {number} */ (
        hive.root(0x80000001)), 'Software\\Valve\\Steam\\ActiveProcess'));
    /** @param {string} name */
    const value = name=>/** @type {{ data: Uint8Array }} */ (hive.getValue(active, name)).data;
    assert.equal(new DataView(value('pid').buffer).getUint32(0, true), 0x2040);
    assert.equal(new TextDecoder().decode(value('SteamClientDll')),
        'C:\\Program Files (x86)\\Steam\\steamclient.dll\0', 'narrow, as the hive keeps a string');
});

test('a method a PlayStation 3 build alone has is no slot of the Windows vtable', ()=>{
    // GetISteamPS3OverlayRender sits under #ifdef _PS3 in SteamClient012's
    // header; counted, every later slot is one late, and steam_api's call for
    // HTTP lands on it with its three arguments left on the stack.
    const slots = INTERFACES.SteamClient012.split(',').map(entry=>entry.split(':')[0]);
    assert.equal(slots.includes('GetISteamPS3OverlayRender'), false);
    assert.equal(slots.indexOf('GetISteamHTTP'), slots.indexOf('BShutdownIfAllPipesClosed') + 1);
});

test('the first controller interface is answered by its macro\'s own name', ()=>{
    // An SDK of 2014 asks for "STEAMCONTROLLER_INTERFACE_VERSION"; answered
    // none, SteamAPI_Init gives up.
    assert.equal(INTERFACES.STEAMCONTROLLER_INTERFACE_VERSION, INTERFACES.SteamController001);
});

test('CheckFileSignature is an API call that completes, its result fetched by id', ()=>{
    // Source's engine waits for the call before it loads a map, calling
    // IsAPICallCompleted until it says yes; a call that is never issued
    // (handle 0) holds it on "Loading..." for ever.
    const { fns, put, method, view, highs } = fixture();
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    const generic = method(client, INTERFACES.SteamClient020.split(',')
        .findIndex(entry=>entry.startsWith('GetISteamGenericInterface:')));
    const utils = generic.fn.handler([client, 1, 1, put('SteamUtils010')]);
    const slots = INTERFACES.SteamUtils010.split(',').map(entry=>entry.split(':')[0]);
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        method(utils, slots.indexOf(name)).fn.handler([utils, ...args]);
    const low = call('CheckFileSignature', [put('bin\\server.dll')]);
    const high = /** @type {number} */ (highs.at(-1));
    assert.notEqual(low + high, 0, 'a call, not k_uAPICallInvalid');

    const failed = 0xc000;
    view.setUint8(failed, 1);
    assert.equal(call('IsAPICallCompleted', [low, high, failed]), 1);
    assert.equal(view.getUint8(failed), 0);
    assert.equal(call('GetAPICallFailureReason', [low, high]), -1, 'k_ESteamAPICallFailureNone');

    const out = 0xc100;
    assert.equal(call('GetAPICallResult', [low, high, out, 4, 704, failed]), 0, 'another callback');
    assert.equal(view.getUint8(failed), 1);
    assert.equal(call('GetAPICallResult', [low, high, out, 4, 705, failed]), 1);
    assert.equal(view.getUint8(failed), 0);
    assert.equal(view.getUint32(out, true), 3, 'k_ECheckFileSignatureNoSignaturesFoundForThisApp');

    // steam_api's call results learn of it from SteamAPICallCompleted_t on the user's pipe.
    const message = 0xc200;
    assert.equal(fns.Steam_BGetCallback.handler([1, message, 0]), 1);
    assert.equal(view.getInt32(message + 4, true), 703);
    const data = view.getUint32(message + 8, true);
    assert.equal(view.getUint32(data, true), low);
    assert.equal(view.getUint32(data + 4, true), high);
    assert.equal(view.getInt32(data + 8, true), 705);
    assert.equal(view.getUint32(data + 12, true), 4);
    assert.equal(fns.Steam_GetAPICallResult.handler([1, low, high, out, 4, 705, failed]), 1);

    assert.equal(call('IsAPICallCompleted', [0, 0, failed]), 0, 'no such call');
    assert.equal(view.getUint8(failed), 1);
    assert.equal(call('GetAPICallFailureReason', [0, 0]), 2, 'k_ESteamAPICallFailureInvalidHandle');
});

test('steamclient64.dll: eight-byte slots, eight-byte arguments in one slot, a wider message', ()=>{
    // A 64-bit steam_api loads the library ActiveProcess names SteamClientDll64,
    // calls through vtables of eight-byte slots, passes a CSteamID or an API
    // call's handle whole in one register, and reads CallbackMsg_t with its
    // data pointer eight bytes wide.
    assert.equal(steamClientDll(8), 'steamclient64.dll');
    assert.equal(steamClientDll(4), 'steamclient.dll');
    const { fns, put, method, view } = fixture(ACCOUNT, 8);
    const client = fns.CreateInterface.handler([put('SteamClient020'), 0]);
    assert.equal(view.getUint32(client + 4, true), 0, 'the high half of the vtable pointer');
    const user = method(client, 5).fn.handler([client, 1, 1, put('SteamUser021')]);
    const slots = INTERFACES.SteamUser021.split(',');
    const license = method(user, slots.findIndex(entry=>entry.startsWith('UserHasLicenseForApp:')));
    assert.deepEqual(license.fn.quadwords, [1], 'the CSteamID after this');
    assert.equal(license.fn.handler([user, 0x1234, 0x01100001, 620]), 0,
        'k_EUserHasLicenseResultHasLicense');
    assert.deepEqual(fns.Steam_GetAPICallResult.quadwords, [1],
        'the handle of the call, after the pipe');

    const stats = method(client, 13).fn.handler([client, 1, 1,
        put('STEAMUSERSTATS_INTERFACE_VERSION012')]);
    method(stats, 0).fn.handler([stats]);
    const out = 0xb000;
    assert.equal(fns.Steam_BGetCallback.handler([1, out, 0]), 1);
    assert.equal(view.getInt32(out + 4, true), 1101);
    assert.equal(view.getInt32(out + 16, true), 24, 'the size past the eight-byte pointer');
    assert.equal(view.getBigUint64(view.getUint32(out + 8, true), true), 620n);
});

test('the eight-byte and floating-point arguments of a method are named for an x86-64 caller', ()=>{
    // What the SDK's headers declare: SetStat(const char*, float) passes its
    // float in XMM1, UserHasLicenseForApp(CSteamID, AppId_t) its ID whole.
    const entry = (/** @type {string} */ version, /** @type {string} */ name)=>
        INTERFACES[version].split(',').find(one=>one.startsWith(`${name}:`));
    assert.equal(entry('SteamUser021', 'UserHasLicenseForApp'), 'UserHasLicenseForApp:12:i:0q');
    // The int32 overload first, as the header declares the two.
    assert.deepEqual(INTERFACES.STEAMUSERSTATS_INTERFACE_VERSION012.split(',')
        .filter(one=>one.startsWith('SetStat:')), ['SetStat:8:i', 'SetStat:8:i:1f']);
    assert.equal(entry('SteamUser021', 'GetSteamID'), 'GetSteamID:0:s8');
});

test('ISteamAppTicket hands out the ticket Steam signed for an owned app, and none otherwise',
    ()=>{
        // A ticket as Steam lays one out: its signed length first, the Steam
        // ID at 8, the app id at 16, the signature after the signed part.
        const ticket = new Uint8Array(46 + 128);
        const view = new DataView(ticket.buffer);
        view.setUint32(0, 46, true);
        view.setBigUint64(8, 76561197960287930n, true);
        view.setUint32(16, 620, true);
        ticket.fill(0xa5, 46);
        const { fns, put, method, view: memory } = fixture(/** @type {any} */ (
            { ...ACCOUNT, ownershipTickets: { 620: ticket } }));
        const client = fns.CreateInterface.handler([put('SteamClient017'), 0]);
        const slots = INTERFACES.SteamClient017.split(',');
        const generic = method(client, slots.findIndex(slot=>
            slot.startsWith('GetISteamGenericInterface:')));
        const tickets = generic.fn.handler([client, 1, 1,
            put('STEAMAPPTICKET_INTERFACE_VERSION001')]);
        assert.notEqual(tickets, 0);
        const get = method(tickets, 0);
        assert.equal(get.name, 'STEAMAPPTICKET_INTERFACE_VERSION001.GetAppOwnershipTicketData');
        const [buffer, outs] = [0x20000, 0x21000];
        const call = (/** @type {number} */ app, size = 0x400)=>get.fn.handler([tickets, app,
            buffer, size, outs, outs + 4, outs + 8, outs + 12]);
        assert.equal(call(620), ticket.length);
        assert.deepEqual([...new Uint8Array(memory.buffer, buffer, ticket.length)], [...ticket]);
        assert.deepEqual([0, 4, 8, 12].map(at=>memory.getUint32(outs + at, true)),
            [16, 8, 46, 128], 'the app id, the Steam ID, the signature and its size');
        assert.equal(call(400), 0, 'owned, but no ticket was given for it: none');
        assert.equal(call(480), 0, 'not owned: none, as Steam has none');
        assert.equal(call(620, 16), 0, 'nor into a buffer too small');
    });
