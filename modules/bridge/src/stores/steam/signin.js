/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Steam's sign-in page (`steam/signin.html`), which the launcher shows in a
 * frame: a QR code, or the account name and password with Steam Guard's
 * step. It is the extension's page, not the launcher's: the launcher's
 * scripts cannot reach its document, and it speaks to GameHub's service
 * worker alone (serve.js `serveSignIn`), which signs in over HTTPS. The
 * password goes to the worker and is kept nowhere; the token stays in the
 * worker. The launcher is told only the account's name, once signed in.
 */

import { encodeQr, qrToSvg } from '../../../../core/src/steam/qr.js';
import { Guard } from './messages.js';

const STORE = 'steam';
const NAME = 'Steam';

// The hosts this build answers on beyond what its manifest lets frame this
// page; the build writes the dev build's (manifest.js HOSTS), null answers anywhere.
const HOSTS = /** @type {RegExp | null} */ (null);
const { chrome } = /** @type {any} */ (globalThis);
const parentOrigin = location.ancestorOrigins?.[0] ?? null;

/** @param {string} id */
const $ = id=>/** @type {HTMLElement} */ (document.getElementById(id));
const status = $('status');
const qrCode = $('qr-code');
const passwordForm = /** @type {HTMLFormElement} */ ($('password'));
const guardForm = /** @type {HTMLFormElement} */ ($('guard'));

/** @param {string} text @param {boolean} [error] */
const say = (text, error = false)=>{
    status.textContent = text;
    status.classList.toggle('error', error);
};

/** @type {any} */
let port = null;
/** @type {'qr' | 'password'} */
let mode = 'qr';
/** The code Steam Guard asks for, of `Guard`. */
let codeType = 0;
let retry = 0;

/** The launcher learns the account's name, and nothing else. @param {string} name */
const tellParent = name=>{
    if (parentOrigin)
    {
        parent.postMessage({ from: 'bottlify-signin', store: STORE, signedIn: { name } },
            parentOrigin);
    }
};

/** @param {Record<string, any>} message */
function heard(message){
    if (message.event === 'challenge')
    {
        qrCode.innerHTML = qrToSvg(encodeQr(message.url), 5);
        say(`Scan with the ${NAME} app on your phone.`);
    }
    else if (message.event === 'scanned')
    {
        say(`Scanned. Approve the sign-in in the ${NAME} app.`);
    }
    else if (message.event === 'guard')
    {
        showGuard(message.types, message.hint);
    }
    else if (message.event === 'wrongCode')
    {
        say('That code was not right. Try again.', true);
        /** @type {HTMLButtonElement} */ ($('code-send')).disabled = false;
    }
    else if (message.done)
    {
        passwordForm.hidden = true;
        guardForm.hidden = true;
        $('qr').hidden = true;
        say(`Signed in as ${message.done.name}.`);
        tellParent(message.done.name);
        port?.disconnect();
        port = null;
    }
    else if (message.error)
    {
        say(message.error, true);
        guardForm.hidden = true;
        passwordForm.hidden = mode !== 'password';
        // A QR code expires: a new one, after a moment so a Steam that cannot
        // be reached is not asked again at once.
        if (mode === 'qr')
        {
            clearTimeout(retry);
            retry = Number(setTimeout(()=>start({ start: 'qr' }), 3000));
        }
    }
}

/** @param {number[]} types @param {string} hint */
function showGuard(types, hint){
    passwordForm.hidden = true;
    guardForm.hidden = false;
    /** @type {HTMLButtonElement} */ ($('code-send')).disabled = false;
    codeType = types.includes(Guard.DeviceCode) ? Guard.DeviceCode
        : types.includes(Guard.EmailCode) ? Guard.EmailCode : 0;
    const approve = types.includes(Guard.DeviceConfirmation)
        || types.includes(Guard.EmailConfirmation);
    const there = approve ? ', or approve the sign-in there' : '';
    const at = hint ? ` at ${hint}` : '';
    const orEmail = types.includes(Guard.EmailConfirmation) ? ' or from the email it sent' : '';
    const asks = codeType === Guard.DeviceCode
        ? `Enter the code from the ${NAME} app on your phone${there}.`
        : codeType === Guard.EmailCode ? `Enter the code ${NAME} sent to your email${at}.`
            : `Approve the sign-in in the ${NAME} app${orEmail}.`;
    $('guard-asks').textContent = asks;
    $('code-label').hidden = codeType === 0;
    $('code-send').hidden = codeType === 0;
    say('');
    if (codeType)
    {
        /** @type {HTMLInputElement} */ (guardForm.elements.namedItem('code')).focus();
    }
}

/** A sign-in over a new port to the worker; the last one ends. @param {Record<string, any>} message */
function start(message){
    clearTimeout(retry);
    port?.disconnect();
    const now = chrome.runtime.connect({ name: 'signin' });
    port = now;
    now.onMessage.addListener(heard);
    now.onDisconnect.addListener(()=>{
        if (port === now)
        {
            port = null;
            heard({ error: 'GameHub was restarted. Try again.' });
        }
    });
    now.postMessage(message);
}

/** @param {'qr' | 'password'} to */
function show(to){
    mode = to;
    $('by-qr').setAttribute('aria-pressed', String(to === 'qr'));
    $('by-password').setAttribute('aria-pressed', String(to === 'password'));
    $('qr').hidden = to !== 'qr';
    passwordForm.hidden = to !== 'password';
    guardForm.hidden = true;
    qrCode.textContent = '';
    say('');
    clearTimeout(retry);
    port?.disconnect();
    port = null;
    if (to === 'qr')
    {
        say(`Connecting to ${NAME}…`);
        start({ start: 'qr' });
    }
}

if (HOSTS && parentOrigin && !HOSTS.test(new URL(parentOrigin).hostname))
{
    document.body.textContent = 'This page signs in to a store for Bottlify alone.';
}
else
{
    $('by-qr').addEventListener('click', ()=>show('qr'));
    $('by-password').addEventListener('click', ()=>show('password'));
    passwordForm.addEventListener('submit', event=>{
        event.preventDefault();
        const fields = passwordForm.elements;
        const accountName = /** @type {HTMLInputElement} */ (fields.namedItem('account')).value.trim();
        const input = /** @type {HTMLInputElement} */ (fields.namedItem('password'));
        say('Signing in…');
        start({ start: 'credentials', accountName, password: input.value });
        // Not kept in the page either, once sent.
        input.value = '';
    });
    guardForm.addEventListener('submit', event=>{
        event.preventDefault();
        const input = /** @type {HTMLInputElement} */ (guardForm.elements.namedItem('code'));
        if (!input.value.trim() || !port)
        {
            return;
        }
        port.postMessage({ code: input.value.trim(), type: codeType });
        input.value = '';
        /** @type {HTMLButtonElement} */ ($('code-send')).disabled = true;
        say('Checking the code…');
    });
    show('qr');
}
