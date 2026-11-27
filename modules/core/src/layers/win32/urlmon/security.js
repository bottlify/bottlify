/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Internet security manager: which zone a URL belongs to and what that
 * zone lets it do. The .NET runtime asks it the zone of every assembly it
 * loads, as evidence, and stops the program when the manager cannot be made.
 *
 * Everything this machine runs is on its own volume, so a file - a `file:`
 * URL or a path - is the local machine's zone and allowed what it asks;
 * anything else is the Internet zone, where an action is refused and said
 * once: no zone here is set up beyond that.
 */

import { canonicalUrl } from './monikers.js';
import { wholeAddress } from '../common/pointers.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;
const INET_E_DEFAULT_ACTION = 0x800c0011 | 0;

export const URLZONE_LOCAL_MACHINE = 0;
export const URLZONE_INTERNET = 3;
const URLPOLICY_ALLOW = 0;
const URLPOLICY_DISALLOW = 3;

const CLSID_INTERNET_SECURITY_MANAGER = '{7B8A2D94-0AC9-11D1-896C-00C04FB6BFC4}';
const IID_IINTERNETSECURITYMANAGER = '{79EAC9EE-BAF9-11CE-8C82-00AA004BA90B}';

/** The zone a URL belongs to. @param {string} url */
export const zoneOfUrl = url=>(/^file:/i.test(canonicalUrl(url, null))
    ? URLZONE_LOCAL_MACHINE : URLZONE_INTERNET);

/**
 * GetSecurityId's answer: the scheme, a colon, the host for a URL that has
 * one, then the zone as four bytes.
 *
 * @param {string} url
 */
export function securityId(url){
    const canonical = canonicalUrl(url, null);
    const scheme = canonical.slice(0, canonical.indexOf(':') + 1).toLowerCase();
    const zone = zoneOfUrl(url);
    const site = zone === URLZONE_LOCAL_MACHINE ? ''
        : (canonical.slice(scheme.length).match(/^\/\/([^/?#:]*)/)?.[1] ?? '').toLowerCase();
    const text = scheme + site;
    const bytes = new Uint8Array(text.length + 4);
    for (let i = 0; i < text.length; i++)
    {
        bytes[i] = text.charCodeAt(i) & 0xff;
    }
    new DataView(bytes.buffer).setUint32(text.length, zone, true);
    return bytes;
}

/**
 * @param {Pick<import('./monikers.js').UrlmonHost, 'readMemory' | 'writeMemory'
 *     | 'readWideString' | 'vtables' | 'makeObject' | 'divergence'>} host
 */
export function createSecurityManager(host){
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            host.writeMemory(wholeAddress(address),
                new Uint8Array(new Uint32Array([value >>> 0]).buffer));
        }
    };
    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(wholeAddress(address), 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address */
    const urlAt = address=>host.readWideString(wholeAddress(address), 0x8000);
    const said = new Set();
    /** @param {string} api @param {string} what */
    const sayOnce = (api, what)=>{
        if (!said.has(what))
        {
            said.add(what);
            host.divergence?.(api, what);
        }
    };

    const make = ()=>{
        let site = 0;
        const object = host.makeObject(CLSID_INTERNET_SECURITY_MANAGER, {
            interfaces: [{ id: IID_IINTERNETSECURITYMANAGER, methods: [
                { name: 'SetSecuritySite', argBytes: 8, invoke: (_, [given])=>{
                    site = given >>> 0;
                    return S_OK;
                } },
                { name: 'GetSecuritySite', argBytes: 8, invoke: (_, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    writeU32(out, site);
                    return S_OK;
                } },
                { name: 'MapUrlToZone', argBytes: 16, invoke: (_, [url, out])=>{
                    if ((url >>> 0) === 0 || (out >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    writeU32(out, zoneOfUrl(urlAt(url)));
                    return S_OK;
                } },
                { name: 'GetSecurityId', argBytes: 20, invoke: (_, [url, out, size])=>{
                    if ((url >>> 0) === 0 || (out >>> 0) === 0 || (size >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    const id = securityId(urlAt(url));
                    const room = readU32(size);
                    writeU32(size, id.length);
                    if (room < id.length)
                    {
                        return E_NOT_SUFFICIENT_BUFFER;
                    }
                    host.writeMemory(wholeAddress(out), id);
                    return S_OK;
                } },
                { name: 'ProcessUrlAction', argBytes: 36,
                    invoke: (_, [url, , policy, policySize])=>{
                        if ((url >>> 0) === 0)
                        {
                            return E_INVALIDARG;
                        }
                        const local = zoneOfUrl(urlAt(url)) === URLZONE_LOCAL_MACHINE;
                        if (!local)
                        {
                            sayOnce('IInternetSecurityManager::ProcessUrlAction',
                                'an action outside the local machine zone is refused');
                        }
                        if ((policy >>> 0) !== 0 && (policySize >>> 0) >= 4)
                        {
                            writeU32(policy, local ? URLPOLICY_ALLOW : URLPOLICY_DISALLOW);
                        }
                        return local ? S_OK : S_FALSE;
                    } },
                { name: 'QueryCustomPolicy', argBytes: 32, invoke: ()=>INET_E_DEFAULT_ACTION },
                { name: 'SetZoneMapping', argBytes: 16, invoke: ()=>{
                    sayOnce('IInternetSecurityManager::SetZoneMapping',
                        'zone mappings are not kept');
                    return E_NOTIMPL;
                } },
                { name: 'GetZoneMappings', argBytes: 16, invoke: (_, [, out])=>{
                    writeU32(out, 0);
                    sayOnce('IInternetSecurityManager::GetZoneMappings', 'no zone has mappings');
                    return E_NOTIMPL;
                } },
            ] }],
        });
        return host.vtables.publish(object, IID_IINTERNETSECURITYMANAGER);
    };

    return {
        /**
         * HRESULT CoInternetCreateSecurityManager(IServiceProvider *pSP,
         *     IInternetSecurityManager **ppSM, DWORD dwReserved)
         */
        CoInternetCreateSecurityManager: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if (wholeAddress(out) === 0)
                {
                    return E_INVALIDARG;
                }
                const pointer = make();
                writeU32(out, pointer);
                return pointer === 0 ? 0x8007000e | 0 : S_OK;
            },
        },
    };
}
