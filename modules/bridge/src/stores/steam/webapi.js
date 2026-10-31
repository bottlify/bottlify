/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Steam's service methods over HTTPS (api.steampowered.com), as a CM
 * connection calls them (connection.js `call`): the request protobuf-encoded
 * in a form field, the answer a protobuf with its EResult in a header. The
 * sign-in runs here, in GameHub's service worker, so the refresh token Steam
 * answers it with comes to the worker alone and never crosses a tab.
 */

import { decode, encode } from '../../../../core/src/steam/protobuf.js';
import { EResult } from './messages.js';

/** @typedef {import('../../../../core/src/steam/protobuf.js').Schema} Schema */

export const WEB_API = 'https://api.steampowered.com';

/**
 * @param {Object} [options]
 * @param {typeof fetch} [options.fetch]
 */
export function webApi({ fetch: get = fetch } = {}){
    return {
        /**
         * `Authentication.BeginAuthSessionViaQR#1` is
         * `IAuthenticationService/BeginAuthSessionViaQR/v1`.
         *
         * @param {string} method @param {Schema} requestSchema
         * @param {Record<string, any>} request @param {Schema} responseSchema
         * @param {{ get?: boolean }} [options]  A method Steam takes as a GET.
         * @returns {Promise<{ eresult: number, body: Record<string, any>, message?: string }>}
         */
        async call(method, requestSchema, request, responseSchema, { get: asGet = false } = {}){
            const [, service, name, version] = /^(\w+)\.(\w+)#(\d+)$/.exec(method) ?? [];
            if (!service)
            {
                throw new Error(`steam: ${method} is not a service method`);
            }
            const bytes = encode(requestSchema, request);
            const form = new URLSearchParams({ input_protobuf_encoded:
                btoa(String.fromCharCode(...bytes)) });
            const url = `${WEB_API}/I${service}Service/${name}/v${version}/`;
            const answer = await (asGet ? get(`${url}?${form}`)
                : get(url, { method: 'POST', body: form }));
            const body = new Uint8Array(await answer.arrayBuffer());
            const eresult = Number(answer.headers.get('x-eresult') ?? (answer.ok ? EResult.OK
                : EResult.Fail));
            const message = answer.headers.get('x-error_message') ?? undefined;
            return { eresult, body: decode(responseSchema, body), ...message ? { message } : {} };
        },
    };
}
