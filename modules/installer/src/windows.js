/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Windows a bottle runs under.
 *
 * A bottle's manifest may name one, as `windows`, and an install runs under
 * the one the bottle will: an installer that asks which Windows it is on acts
 * on the answer -- a path it writes down, a component it picks -- and a bottle
 * installed under one and started under another starts on a machine it was not
 * installed for.
 *
 * The names are the engine's own (`createApp`'s `windows` option), which
 * refuses any other name too. Refusing here as well says so while the bottle
 * is still being made, rather than the first time somebody starts it.
 */

/** @typedef {'win2000' | 'winxp' | 'win7' | 'win10'} WindowsChoice */

/** @type {readonly WindowsChoice[]} */
export const WINDOWS_CHOICES = Object.freeze(['win2000', 'winxp', 'win7', 'win10']);

/**
 * The name itself, or undefined for none -- the engine's default, XP with its
 * third service pack. Anything else is refused, naming the four.
 *
 * @param {unknown} value
 * @returns {WindowsChoice | undefined}
 */
export function windowsChoice(value){
    if (value === undefined || value === null)
    {
        return undefined;
    }
    const found = WINDOWS_CHOICES.find(choice=>choice === value);
    if (found === undefined)
    {
        throw new Error(`unknown Windows version ${JSON.stringify(value)}: `
            + `the choices are ${WINDOWS_CHOICES.join(', ')}`);
    }
    return found;
}
