/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The certificates crypt32's tests share and a machine to drive them on: a
 * root, an intermediate it signed, a server certificate for *.example.test and
 * example.test and a client one the intermediate signed, and a stranger that
 * signed itself, valid from 2026 to 2036; guest memory with a LocalAlloc that
 * checks every block is freed once.  Named *.test.js so it stays out of the
 * package; it holds no tests of its own.
 */

import assert from 'node:assert/strict';
import { createCrypt32Functions } from './functions.js';
/** @param {string[]} lines */
const der = lines=>Uint8Array.from(atob(lines.join('')), ch=>ch.charCodeAt(0));

export const ROOT = der([
    'MIICATCCAWqgAwIBAgIBATANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlUZXN0IFJvb3QwHhcN',
    'MjYxMDI5MTY1MTU4WhcNNDYxMDI0MTY1MTU4WjAUMRIwEAYDVQQDDAlUZXN0IFJvb3QwgZ8wDQYJ',
    'KoZIhvcNAQEBBQADgY0AMIGJAoGBAODgh1Qeh78QkuZsquvERXPEeo1O1sfoslJLubG2nIAfWpn8',
    'FvCR1eflMK9zbsCZyP3LM1FizZN4FtglmFk4vM8FU/GekP6+aBBSJ2MxwBaAa2qkeQKcaqd2jq82',
    'R2Dic3197SkBUdK4BSOBD25gcFjhKK749Pvg+Zit4jAvslItAgMBAAGjYzBhMB0GA1UdDgQWBBRd',
    'aK3ifB4WjdvCqWo6aG3rgjRYnDAfBgNVHSMEGDAWgBRdaK3ifB4WjdvCqWo6aG3rgjRYnDAPBgNV',
    'HRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICBDANBgkqhkiG9w0BAQsFAAOBgQDdEassieDmkVp/',
    'AvyfiRK+KgSaBwiqnCmcxClIdYDI79TTUVf0nycSwV14TVaVWtbMAC47iYvlekJZ19mKdC6YZ28C',
    'WBaUEj4rHpVMGOST9fEuW9O3tAn05oWB6KU8EEVe1bVu58Uwjs4pSgyUeO7hwUw4xiTA5iTX/nfZ',
    'HXWkLQ==',
]);

export const INTERMEDIATE = der([
    'MIICCTCCAXKgAwIBAgIBAjANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlUZXN0IFJvb3QwHhcN',
    'MjYxMDI5MTY1MTU5WhcNNDUxMjI4MTY1MTU5WjAcMRowGAYDVQQDDBFUZXN0IEludGVybWVkaWF0',
    'ZTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA0nznNYwzuffoGGiL7+jieLIjZhcqG2d3faqx',
    'HsONij6EfwULHImOLVDI2VIYMFLHY1Od3hFP77WzkzqZwNy/wfKuNNzsKcUnfAup627VyBGowxRr',
    'FGXV+g+OVy6CNc9im+y3zQJwwVmqSr4UQFbOYP/HKjVH/ubyKFB4g47C1l0CAwEAAaNjMGEwDwYD',
    'VR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFAw2bnHdxPBW7huiU2VMNWTC',
    'az4DMB8GA1UdIwQYMBaAFF1oreJ8HhaN28KpajpobeuCNFicMA0GCSqGSIb3DQEBCwUAA4GBAMuI',
    '2qyNhLZtnlpoeInFMKKx3DUe9ITJxq3Y0JAz/AZd4/6nAapVJym9MuA0voeoW1Tqp0Mi9m7uWl8J',
    'IWm24mL2AxqY8T0+JpnmJwoVbtlNWLcwQlJZSh81RNcqegbPVxdPvckCRn/Db3ahhydVqbunzBL+',
    '79Dvs1IUkgdgQZBZ',
]);

export const LEAF = der([
    'MIICUTCCAbqgAwIBAgIFAQIDBAUwDQYJKoZIhvcNAQELBQAwHDEaMBgGA1UEAwwRVGVzdCBJbnRl',
    'cm1lZGlhdGUwHhcNMjYxMDI5MTY1MTU5WhcNMzYxMDI2MTY1MTU5WjAbMRkwFwYDVQQDDBB3d3cu',
    'ZXhhbXBsZS50ZXN0MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDE4cSA6Hgmj2ik5Q91OgEh',
    'qRKhN6O2cHo6dtStIFQo4RjR5zoiSK21PZzTJdlCMz+J2Zz/kd9mAH4QS3v52W0odxmNJ7qRTC0V',
    'QPzR+epn4mYYIoEq3Xm+HJ2GkfvdnguHHgOYwE+d2UJGUmc2FsnHFd/ydZ7HeZRSFWaYyuWg/wID',
    'AQABo4GfMIGcMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUF',
    'BwMBMCcGA1UdEQQgMB6CDiouZXhhbXBsZS50ZXN0ggxleGFtcGxlLnRlc3QwHQYDVR0OBBYEFJCi',
    '4aNrTtNSB0prhZYr+QEV8yQOMB8GA1UdIwQYMBaAFAw2bnHdxPBW7huiU2VMNWTCaz4DMA0GCSqG',
    'SIb3DQEBCwUAA4GBAA/t87qk8OvGkQbnLf38MAowcgYOkK0enTAAQUBcju66VfYztdXfFELB7ZtG',
    '2/0gYJUw4YShTjDzjE/qy22sxh6JqaUg0oylIvnzrOT6ie/cx55heO7sKJPsaEKZZqxt7J24RvrW',
    'TH6Jmlwwsxaosu+PxqW5t2TLPlffryhmxoEe',
]);

export const CLIENT = der([
    'MIICNDCCAZ2gAwIBAgIBBDANBgkqhkiG9w0BAQsFADAcMRowGAYDVQQDDBFUZXN0IEludGVybWVk',
    'aWF0ZTAeFw0yNjEwMjkxNjUxNTlaFw0zNjEwMjYxNjUxNTlaMBsxGTAXBgNVBAMMEHd3dy5leGFt',
    'cGxlLnRlc3QwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAMThxIDoeCaPaKTlD3U6ASGpEqE3',
    'o7Zwejp21K0gVCjhGNHnOiJIrbU9nNMl2UIzP4nZnP+R32YAfhBLe/nZbSh3GY0nupFMLRVA/NH5',
    '6mfiZhgigSrdeb4cnYaR+92eC4ceA5jAT53ZQkZSZzYWyccV3/J1nsd5lFIVZpjK5aD/AgMBAAGj',
    'gYYwgYMwDAYDVR0TAQH/BAIwADATBgNVHSUEDDAKBggrBgEFBQcDAjAeBgNVHREEFzAVghNjbGll',
    'bnQuZXhhbXBsZS50ZXN0MB0GA1UdDgQWBBSQouGja07TUgdKa4WWK/kBFfMkDjAfBgNVHSMEGDAW',
    'gBQMNm5x3cTwVu4bolNlTDVkwms+AzANBgkqhkiG9w0BAQsFAAOBgQABQItHH0I7K6wFqIFY75tT',
    'oQ4aKbf6hFyxIdYjzbNma4TkXggsZjIGZRpXcQ07mn+twlFpArKEujAUvY+ZV1enise3HYIxkkVE',
    'ZfyLVJ7gNp+u6Me1SkvFXDJlUkahbssRntNeyxj9QsAxMWebfI1ypdnom6tRceQBjVSEN4DucQ==',
]);

export const STRANGER = der([
    'MIIB7zCCAVigAwIBAgIBBTANBgkqhkiG9w0BAQsFADATMREwDwYDVQQDDAhTdHJhbmdlcjAeFw0y',
    'NjEwMjkxNjUxNTlaFw0zNjEwMjYxNjUxNTlaMBMxETAPBgNVBAMMCFN0cmFuZ2VyMIGfMA0GCSqG',
    'SIb3DQEBAQUAA4GNADCBiQKBgQC/l+wBb0DAcMCtGmrzbRvsfAacSBzNAVQedef1IZPaZHFV7yuV',
    'VgGVG/rGAcCBuMHh1AFZ5uNrUEOBm8q0dAPw61rU+aDP5gAGYN1tA1WrDe5zkeNyvfQbMwk4ovoD',
    'NsNdiIJP9SvdGA4mn5vcEdKO2/uhIlEvtdXlPxTmpKBUIQIDAQABo1MwUTAdBgNVHQ4EFgQU6V6b',
    'PiFGTB9NSsPVSURGJVWi/CowHwYDVR0jBBgwFoAU6V6bPiFGTB9NSsPVSURGJVWi/CowDwYDVR0T',
    'AQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOBgQAGNR67UUzuNygJF6r3+dbQaaN2eqJwjml2VbZY',
    'AdC7FvRicFWBuq51YuX6oTbRzqLC+/lv+KoJbatwv8rg+ZAzCBPfjwfuY7xvHiAOEJgyuy9nUPBf',
    'jJQDbFqCbcwoHqWtzemPelNi3NZ5IQr3TaOl4E2nvR0c4wJoLcR8VyS/1w==',
]);

export const NOW = Date.UTC(2030, 0, 1);

/**
 * @param {{ roots?: Uint8Array[], files?: Record<string, Uint8Array> }} [options]
 */
export function setup({ roots = [ROOT], files = {} } = {}){
    /** @type {string[]} */
    const divergences = [];
    const bytes = new Uint8Array(0x100000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    /** @type {Set<number>} */
    const live = new Set();
    let next = 0x10000;
    // Above 0x10000, where an LPCSTR is a pointer rather than a number.
    let scratch = 0xa0000;
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (createCrypt32Functions({
            readMemory: (address, length)=>bytes.subarray(address, address + length),
            writeMemory: (address, data)=>bytes.set(data, address),
            readWideString: address=>{
                let text = '';
                for (let at = address; view.getUint16(at, true) !== 0; at += 2)
                {
                    text += String.fromCharCode(view.getUint16(at, true));
                }
                return text;
            },
            readCString: address=>{
                let text = '';
                for (let at = address; bytes[at] !== 0; at++)
                {
                    text += String.fromCharCode(bytes[at]);
                }
                return text;
            },
            setLastError: code=>errors.push(code >>> 0),
            localAlloc: size=>{
                const at = next;
                next += (size + 15) & ~15;
                bytes.fill(0, at, at + size);
                live.add(at);
                return at;
            },
            localFree: address=>{
                assert.ok(live.delete(address),
                    `freed ${address.toString(16)} twice or never had it`);
            },
            now: ()=>NOW,
            trustedRoots: ()=>roots,
            readFile: path=>files[path] ?? null,
            divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        })));
    /** @param {Uint8Array | string} data */
    const put = data=>{
        const at = scratch;
        const raw = typeof data === 'string'
            ? Uint8Array.from([...data, '\0'], ch=>ch.charCodeAt(0)) : data;
        bytes.set(raw, at);
        scratch += (raw.length + 15) & ~15;
        return at;
    };
    /** @param {string} text */
    const wide = text=>{
        const raw = new Uint8Array(text.length * 2 + 2);
        for (let i = 0; i < text.length; i++)
        {
            raw[i * 2] = text.charCodeAt(i);
        }
        return put(raw);
    };
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>fns[name].handler(args) >>> 0;
    /** @param {Uint8Array} certificate */
    const create = certificate=>call('CertCreateCertificateContext', 1, put(certificate),
        certificate.length);
    const out = ()=>put(new Uint8Array(16));
    /**
     * A chain for `leaf` with `extra` in a memory store beside it.
     *
     * @param {number} leaf @param {Uint8Array[]} extra
     * @param {{ flags?: number, usages?: string[], time?: number }} [options]
     */
    const chain = (leaf, extra, { flags = 0, usages = [], time = 0 } = {})=>{
        const store = call('CertOpenStore', 2, 0, 0, 0, 0);
        for (const one of extra)
        {
            assert.equal(call('CertAddEncodedCertificateToStore', store, 1, put(one), one.length,
                4, 0), 1);
        }
        const list = put(new Uint8Array(4 * Math.max(usages.length, 1)));
        usages.forEach((usage, i)=>view.setUint32(list + i * 4, put(usage), true));
        const parameters = put(new Uint8Array(16));
        view.setUint32(parameters, 16, true);
        view.setUint32(parameters + 8, usages.length, true);
        view.setUint32(parameters + 12, list, true);
        let timePointer = 0;
        if (time)
        {
            const ticks = (BigInt(time) + 11644473600000n) * 10000n;
            timePointer = put(new Uint8Array(8));
            view.setBigUint64(timePointer, ticks, true);
        }
        const result = out();
        assert.equal(call('CertGetCertificateChain', 0, leaf, timePointer, store, parameters,
            flags, 0, result), 1);
        call('CertCloseStore', store, 0);
        const context = u32(result);
        const simple = u32(u32(context + 16));
        const elements = Array.from({ length: u32(simple + 12) },
            (_, i)=>u32(u32(simple + 16) + i * 4));
        return {
            context,
            error: u32(context + 4),
            info: u32(context + 8),
            elements: elements.map(element=>({ context: u32(element + 4),
                error: u32(element + 8), info: u32(element + 12) })),
        };
    };
    /**
     * The SSL policy's verdict on a chain for `server`.
     *
     * @param {number} context @param {string | null} server
     * @param {{ checks?: number, client?: boolean, policy?: number, flags?: number }} [options]
     */
    const policy = (context, server, options = {})=>{
        const { checks = 0, client = false, policy: which = 4, flags = 0 } = options;
        const extra = put(new Uint8Array(16));
        view.setUint32(extra, 16, true);
        view.setUint32(extra + 4, client ? 1 : 2, true);
        view.setUint32(extra + 8, checks, true);
        view.setUint32(extra + 12, server === null ? 0 : wide(server), true);
        const parameters = put(new Uint8Array(12));
        view.setUint32(parameters, 12, true);
        view.setUint32(parameters + 4, flags, true);
        view.setUint32(parameters + 8, extra, true);
        const status = put(new Uint8Array(20));
        view.setUint32(status, 20, true);
        assert.equal(call('CertVerifyCertificateChainPolicy', which, context, parameters,
            status), 1);
        return { error: u32(status + 4), chain: view.getInt32(status + 8, true),
            element: view.getInt32(status + 12, true) };
    };
    return { bytes, view, u32, call, create, chain, policy, put, wide, out, errors, live,
        divergences };
}
