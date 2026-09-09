/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fitting a picture onto a display that is not its shape.
 *
 * A cinematic is authored at its own dimensions and they are rarely the
 * display's. Presenting it at those dimensions resizes the surface everything
 * else is drawn on, and a display does not change shape because a film started
 * -- so the frame is scaled to fit, centred, and the margins left black, which
 * is what a video renderer does with a destination rectangle it does not fill.
 */

/**
 * @typedef {Object} Picture
 * @property {Uint8Array} bgra   Four bytes a pixel, top row first.
 * @property {number} width
 * @property {number} height
 */

/**
 * Draws a picture into a screen-sized buffer, scaled to fit and centred.
 *
 * Nearest neighbour rather than anything better: this runs once per film frame
 * on the same thread as the guest, and a cinematic is watched rather than
 * inspected. A filter here would be paid for out of the program's own time.
 *
 * @param {Picture} picture
 * @param {Uint8Array} out   `width * height * 4` bytes, overwritten whole.
 * @param {number} width
 * @param {number} height
 */
export function fitFrame(picture, out, width, height){
    out.fill(0);
    if (picture.width <= 0 || picture.height <= 0 || width <= 0 || height <= 0)
    {
        return;
    }
    const scale = Math.min(width / picture.width, height / picture.height);
    const drawnWidth = Math.max(1, Math.min(width, Math.floor(picture.width * scale)));
    const drawnHeight = Math.max(1, Math.min(height, Math.floor(picture.height * scale)));
    const left = (width - drawnWidth) >> 1;
    const top = (height - drawnHeight) >> 1;
    for (let y = 0; y < drawnHeight; y++)
    {
        const from = Math.min(picture.height - 1, Math.floor(y / scale)) * picture.width * 4;
        let to = ((top + y) * width + left) * 4;
        for (let x = 0; x < drawnWidth; x++, to += 4)
        {
            const at = from + Math.min(picture.width - 1, Math.floor(x / scale)) * 4;
            out[to] = picture.bgra[at];
            out[to + 1] = picture.bgra[at + 1];
            out[to + 2] = picture.bgra[at + 2];
            out[to + 3] = 0xff;
        }
    }
}
