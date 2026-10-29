/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Certificate stores, contexts and chains, driven as a TLS client drives
 * them: the server's certificates into a memory store, a chain asked for, the
 * chain judged under the SSL policy. The certificates are made for these
 * tests (a root, an intermediate it signed, a server certificate for
 * *.example.test and example.test and a client one the intermediate signed,
 * and a stranger that signed itself), valid from 2026 to 2036.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrypt32Functions } from './functions.js';
import { nameMatches, TRUST_ERROR, TRUST_INFO } from './certificates.js';

/** @param {string[]} lines */
const der = lines=>Uint8Array.from(atob(lines.join('')), ch=>ch.charCodeAt(0));

const ROOT = der([
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

const INTERMEDIATE = der([
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

const LEAF = der([
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

const CLIENT = der([
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

const STRANGER = der([
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

const NOW = Date.UTC(2030, 0, 1);
const E_INVALIDARG = 0x80070057;
const CRYPT_E_EXISTS = 0x80092005;
const CRYPT_E_NOT_FOUND = 0x80092004;
const CERT_E_EXPIRED = 0x800b0101;
const CERT_E_UNTRUSTEDROOT = 0x800b0109;
const CERT_E_CHAINING = 0x800b010a;
const CERT_E_CN_NO_MATCH = 0x800b010f;
const CERT_E_WRONG_USAGE = 0x800b0110;
const CRYPT_E_REVOCATION_OFFLINE = 0x80092013;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

/** @param {{ roots?: Uint8Array[] }} [options] */
function setup({ roots = [ROOT] } = {}){
    const bytes = new Uint8Array(0x100000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    /** @type {Set<number>} */
    const live = new Set();
    let next = 0x10000;
    let scratch = 0x1000;
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
    return { bytes, view, u32, call, create, chain, policy, put, out, errors, live };
}

test('a server certificate chains through the intermediate to a trusted root', ()=>{
    const { call, create, chain, policy, live } = setup();
    const leaf = create(LEAF);
    const built = chain(leaf, [INTERMEDIATE]);
    assert.equal(built.error, 0);
    assert.equal(built.elements.length, 3);
    assert.equal(built.elements[0].context, leaf, 'the leaf element is the context asked about');
    assert.ok(built.elements[2].info & TRUST_INFO.IS_SELF_SIGNED);
    assert.ok(built.elements[0].info & TRUST_INFO.HAS_PREFERRED_ISSUER);
    for (const server of ['www.example.test', 'example.test', 'WWW.Example.Test'])
    {
        assert.deepEqual(policy(built.context, server), { error: 0, chain: -1, element: -1 },
            server);
    }
    for (const server of ['a.b.example.test', 'other.test', 'example.test.evil'])
    {
        assert.equal(policy(built.context, server).error, CERT_E_CN_NO_MATCH, server);
    }
    assert.equal(policy(built.context, 'other.test', { checks: 0x1000 }).error, 0,
        'SECURITY_FLAG_IGNORE_CERT_CN_INVALID');
    assert.equal(policy(built.context, null).error, 0, 'no name, no name check');
    // Everything is let go: the chain's references, then the caller's own.
    call('CertFreeCertificateChain', built.context);
    call('CertFreeCertificateContext', leaf);
    const rootStore = [...live];
    assert.equal(rootStore.length, 1, 'only the ROOT store\'s own context is left');
});

test('a chain whose intermediate was not sent is partial', ()=>{
    const { create, chain, policy } = setup();
    const built = chain(create(LEAF), []);
    assert.equal(built.elements.length, 1);
    assert.ok(built.error & TRUST_ERROR.IS_PARTIAL_CHAIN);
    assert.equal(policy(built.context, 'www.example.test').error, CERT_E_CHAINING);
});

test('a root the machine does not trust is an untrusted root, which a flag can excuse', ()=>{
    const { create, chain, policy } = setup({ roots: [] });
    const built = chain(create(LEAF), [INTERMEDIATE, ROOT]);
    assert.equal(built.elements.length, 3);
    assert.equal(built.elements[2].error, TRUST_ERROR.IS_UNTRUSTED_ROOT);
    assert.equal(built.error, TRUST_ERROR.IS_UNTRUSTED_ROOT);
    assert.deepEqual(policy(built.context, 'www.example.test'),
        { error: CERT_E_UNTRUSTEDROOT, chain: 0, element: 2 });
    assert.equal(policy(built.context, 'www.example.test', { checks: 0x100 }).error, 0);
    assert.equal(policy(built.context, 'www.example.test', { policy: 1, flags: 0x10 }).error, 0,
        'the base policy\'s CERT_CHAIN_POLICY_ALLOW_UNKNOWN_CA_FLAG');

    const stranger = chain(create(STRANGER), []);
    assert.equal(stranger.elements.length, 1);
    assert.ok(stranger.elements[0].info & TRUST_INFO.IS_SELF_SIGNED);
    assert.equal(stranger.error, TRUST_ERROR.IS_UNTRUSTED_ROOT);
});

test('a chain judged at a time past its certificates is not time valid', ()=>{
    const { create, chain, policy } = setup();
    const built = chain(create(LEAF), [INTERMEDIATE], { time: Date.UTC(2060, 0, 1) });
    assert.ok(built.elements.every(element=>element.error & TRUST_ERROR.IS_NOT_TIME_VALID));
    assert.equal(policy(built.context, 'www.example.test').error, CERT_E_EXPIRED);
    assert.equal(policy(built.context, 'www.example.test', { checks: 0x2000 }).error, 0);
    const now = chain(create(LEAF), [INTERMEDIATE], { time: Date.UTC(2031, 5, 1) });
    assert.equal(now.error, 0);
});

test('a client certificate is no server\'s, by the policy and by the usage asked for', ()=>{
    const { create, chain, policy } = setup();
    const client = chain(create(CLIENT), [INTERMEDIATE]);
    assert.equal(client.error, 0, 'no usage asked, none judged');
    assert.equal(policy(client.context, 'client.example.test').error, CERT_E_WRONG_USAGE);
    assert.equal(policy(client.context, 'client.example.test', { client: true }).error, 0);
    const asked = chain(create(CLIENT), [INTERMEDIATE], { usages: [SERVER_AUTH] });
    assert.equal(asked.elements[0].error, TRUST_ERROR.IS_NOT_VALID_FOR_USAGE);
    assert.equal(policy(asked.context, 'client.example.test', { checks: 0x200 }).error, 0);
    const server = chain(create(LEAF), [INTERMEDIATE], { usages: [SERVER_AUTH] });
    assert.equal(server.error, 0);
});

test('revocation, when asked, is unknown and offline: nothing is fetched', ()=>{
    const { create, chain, policy } = setup();
    const unknown = TRUST_ERROR.REVOCATION_STATUS_UNKNOWN | TRUST_ERROR.IS_OFFLINE_REVOCATION;
    const whole = chain(create(LEAF), [INTERMEDIATE], { flags: 0x20000000 });
    assert.deepEqual(whole.elements.map(element=>element.error), [unknown, unknown, 0],
        'a root is not checked for revocation');
    const end = chain(create(LEAF), [INTERMEDIATE], { flags: 0x10000000 });
    assert.deepEqual(end.elements.map(element=>element.error), [unknown, 0, 0]);
    assert.equal(policy(end.context, 'www.example.test').error, CRYPT_E_REVOCATION_OFFLINE);
    assert.equal(policy(end.context, 'www.example.test', { checks: 0x80 }).error, 0);
    assert.equal(policy(end.context, 'www.example.test', { policy: 1 }).error, 0,
        'the base policy does not judge revocation that is unknown');
});

test('a context is CERT_CONTEXT over CERT_INFO, as wincrypt.h lays them out', ()=>{
    const { bytes, u32, create, call, put, errors } = setup();
    const leaf = create(LEAF);
    assert.equal(u32(leaf), 1, 'X509_ASN_ENCODING');
    assert.deepEqual(bytes.slice(u32(leaf + 4), u32(leaf + 4) + u32(leaf + 8)), LEAF);
    const info = u32(leaf + 12);
    assert.equal(u32(info), 2, 'CERT_V3');
    assert.deepEqual([...bytes.slice(u32(info + 8), u32(info + 8) + u32(info + 4))],
        [5, 4, 3, 2, 1], 'the serial number little-endian');
    const cString = (/** @type {number} */ at)=>{
        let text = '';
        for (let i = at; bytes[i] !== 0; i++)
        {
            text += String.fromCharCode(bytes[i]);
        }
        return text;
    };
    assert.equal(cString(u32(info + 12)), '1.2.840.113549.1.1.11', 'sha256RSA');
    assert.equal(cString(u32(info + 56)), '1.2.840.113549.1.1.1', 'an RSA key');
    assert.equal(u32(info + 104), 6, 'six extensions');
    const extensions = u32(info + 108);
    assert.deepEqual(Array.from({ length: 6 }, (_, i)=>cString(u32(extensions + i * 16))),
        ['2.5.29.19', '2.5.29.15', '2.5.29.37', '2.5.29.17', '2.5.29.14', '2.5.29.35']);
    assert.equal(u32(extensions + 4), 1, 'basic constraints are critical');
    assert.equal(u32(extensions + 16 * 2 + 4), 0, 'the usage is not');
    // The value is the OCTET STRING's contents: a SEQUENCE of usages.
    assert.equal(bytes[u32(extensions + 16 * 2 + 12)], 0x30);
    // A store keeps a context of its own; adding the same one again is refused.
    const store = call('CertOpenStore', 2, 0, 0, 0, 0);
    const added = put(new Uint8Array(4));
    assert.equal(call('CertAddCertificateContextToStore', store, leaf, 1, added), 1);
    assert.notEqual(u32(added), leaf);
    assert.equal(u32(u32(added) + 16), store, 'its hCertStore is the store');
    assert.equal(call('CertAddCertificateContextToStore', store, leaf, 1, 0), 0);
    assert.equal(errors.at(-1), CRYPT_E_EXISTS);
    assert.equal(call('CertAddCertificateContextToStore', store, leaf, 2, 0), 1, 'USE_EXISTING');
    assert.equal(call('CertCreateCertificateContext', 1, put(new Uint8Array([1, 2, 3])), 3), 0);
    assert.equal(call('CertCloseStore', 0, 0), 1, 'a NULL store closes');
});

test('a store enumerates what it holds; ROOT holds the machine\'s roots', ()=>{
    const { u32, call, put, errors } = setup({ roots: [ROOT, STRANGER] });
    const root = call('CertOpenStore', 10, 0, 0, 0x20000, put(new Uint8Array([82, 0, 79, 0, 79,
        0, 84, 0, 0, 0])));
    assert.notEqual(root, 0);
    /** @type {number[]} */
    const seen = [];
    for (let context = call('CertEnumCertificatesInStore', root, 0); context !== 0;
        context = call('CertEnumCertificatesInStore', root, context))
    {
        seen.push(u32(context + 8));
    }
    assert.deepEqual(seen, [ROOT.length, STRANGER.length]);
    assert.equal(errors.at(-1), CRYPT_E_NOT_FOUND);
    assert.equal(call('CertCloseStore', root, 0), 1);
    const named = call('CertOpenSystemStoreA', 0, put('MY'));
    assert.equal(call('CertEnumCertificatesInStore', named, 0), 0, 'MY starts empty');
    assert.equal(call('CertOpenStore', 10, 0, 0, 0x4000, put(new Uint8Array([88, 0, 0, 0]))), 0,
        'a system store that does not exist is not opened when it must exist');
    assert.equal(call('CertGetCertificateChain', 0, 0x1234, 0, 0, put(new Uint8Array(16)), 0, 0,
        put(new Uint8Array(4))), 0);
    assert.equal(errors.at(-1), E_INVALIDARG, 'a context that is none');
});

test('a name matches a pattern whole, a wildcard only as the leftmost label', ()=>{
    assert.ok(nameMatches('example.test', 'EXAMPLE.test.'));
    assert.ok(nameMatches('*.example.test', 'a.example.test'));
    assert.ok(!nameMatches('*.example.test', 'example.test'));
    assert.ok(!nameMatches('*.example.test', 'a.b.example.test'));
    assert.ok(!nameMatches('*.test', 'example.test'), 'a wildcard over a top-level name');
    assert.ok(!nameMatches('example.test', 'xexample.test'));
});
