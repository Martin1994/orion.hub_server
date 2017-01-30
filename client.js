/*******************************************************************************
 * @license
 * Copyright (c) 2017 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License v1.0
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html).
 *
 * Contributors: IBM Corporation - initial API and implementation
 ******************************************************************************/

'use strict';

var hsl2rgb = require('hsl-to-rgb-for-reals');

/**
 * A client record
 */
class Client {
    /**
     * @param {string} clientId
     * @param {string} name
     */
    constructor(clientId, name) {
        this.clientId = clientId;
        this.name = name;
        this.color = generateColorByName(name);
        this.location = '';
        /** @type ot.Selection */
        this.selection = null;
    }

    /**
     * Serialize this client to a JSON object
     */
    serialize() {
        return {
            clientId: this.clientId,
            name: this.name,
            color: this.color,
            location: this.location
        }
    }
};

var MASK = 0xFF + 1;
var MAGIC = 161803398 / 2 % MASK;
var SATURATION = 0.7;
var LIGHTNESS = 0.5;

/**
 * Generate an RGB value from a string
 * 
 * @param {string} str
 * 
 * @return {string} - RGB value
 */
function generateColorByName(str) {
    var hue = 0;
    for (var i = 0; i < str.length; i++) {
        hue = (hue + str.charCodeAt(i)) % MASK;
    }
    hue = (hue * MAGIC) % MASK;
    var rgb = hsl2rgb(hue, SATURATION, LIGHTNESS);
    return ('#' + rgb[0].toString(16) + rgb[1].toString(16) + rgb[2].toString(16)).toUpperCase();
}

module.exports = Client;
