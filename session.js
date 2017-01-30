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

var ot = require('ot');
var parseUrl = require('url').parse;
var Document = require('./document.js');

/**
 * This class record some connection status
 */
class ConnectionStatus {
    constructor() {
        this.created = Date.now();
        this.sample = [];
        this.domains = {};
        this.urls = {};
        this.firstDomain = null;
        this.totalMessageChars = 0;
        this.totalMessages = 0;
        this.connections = 0;
    }
};

/**
* This class defines an active session.
* It includes the list of connections, list of active documents, etc.
*/
class Session {

    constructor(sessionId) {
        /** @type {Map.<WebSocket, Client>} */
        this.clients = new Map();
        this.connectionStats = new ConnectionStatus();
        /** @type {Object.<string, Document>} */
        this.docs = {};
        this.sessionId = sessionId;
    }

    /**
     * Add a connection
     * 
     * @param {WebSocket} c
     * @param {Client} client
     */
    connectionJoined(c, client) {
        this.clients.set(c, client);
        this.connectionStats.connections++;
        this.notifyAll(c, {
            type: 'client-joined',
            clientId: client.clientId,
            name: client.name,
            color: client.color
        });
    }

    /**
     * Remove a connection
     * 
     * @param {WebSocket} c
     * @param {function} callback - calls when it's done, with a boolean
     *     parameter indicates whether there is no conenctions left.
     */
    connectionLeft(c, callback) {
        var self = this;
        var client = this.clients.get(c);
        if (client) {
            this.clients.delete(c);

            this.notifyAll(c, {
                type: 'client-left',
                clientId: client.clientId
            });

            // remove the user from the document
            var doc = client.location;
            if (doc && this.docs[doc]) {
                // check with the document if this is the last user. If so, clear the doc from memory.
                this.docs[doc].leaveDocument(c, client.clientId, function(lastPerson) {
                    if (lastPerson) {
                        self.docs[doc].destroy();
                        delete self.docs[doc];
                    }
                    callback(!self.clients.size);
                });
            } else {
                callback(!self.clients.size);
            }
        }
    }

    /**
     * Handles incoming message
     * 
     * @param {WebSocket} c
     * @param {Object} msg
     */
    onmessage(c, msg) {
        var client = this.clients.get(c);

        // if its a doc specific message, only send it to the clients involved. Otherwise send to all.
        if (msg.doc) {
            if (msg.type === 'join-document') {
                this.joinDocument(c, msg, client, msg.doc);
            } else {
                var doc = this.docs[msg.doc];
                if (doc) {
                    doc.onmessage(c, msg, client);
                } else {
                    c.send(JSON.stringify({
                        type: 'error',
                        error: 'Invalid document ' + msg.doc
                    }));
                }
            }
        } else {
            if (msg.type === 'leave-document') {
                if (client.location && this.docs[client.location]) {
                    this.leaveDocument(c, msg, client);
                }
            } else if (msg.type === 'update-client') {
                if (msg.name) {
                    client.name = msg.name;
                }
                if (msg.color) {
                    client.color = msg.color;
                }
                if (msg.location) {
                    client.location = msg.location;
                }
                var outMsg = client.serialize();
                outMsg.type = 'client-updated';
                this.notifyAll(c, outMsg);
            } else if (msg.type === 'get-clients') {
                this.clients.forEach(function(peerClient) {
                    var outMsg = peerClient.serialize();
                    outMsg.type = 'client-joined';
                    c.send(JSON.stringify(outMsg));
                });
            } else {
                c.send(JSON.stringify({
                    type: 'error',
                    error: 'Unknown message type: ' + msg.type
                }));
            }
        }
    }

    /**
     * Join a document
     * 
     * @param {WebSocket} c
     * @param {Object} msg
     * @param {Client} client
     * @param {string} doc
     */
    joinDocument(c, msg, client, doc) {
        if (client.location && this.docs[client.location]) {
            this.leaveDocument(c, msg, client);
        }
        // if we don't have the document, let's start it up.
        if (!this.docs[doc]) {
            var self = this;
            this.docs[doc] = new Document(doc, this.sessionId);
            this.docs[doc].startOT()
            .then(function() {
                self.docs[doc].onmessage(c, msg, client);
            });
        } else {
            this.docs[doc].onmessage(c, msg, client);
        }
    }

    /**
     * Leave the client's document
     * 
     * @param {WebSocket} c
     * @param {Object} msg
     * @param {Client} client
     */
    leaveDocument(c, msg, client) {
        var self = this;
        var doc = client.location;
        this.docs[doc].leaveDocument(c, msg.clientId, function(lastPerson) {
            if (lastPerson) {
                self.docs[doc].destroy();
                delete self.docs[doc];
            }
        });
    }

    /**
     * Send message to all clients
     * 
     * @param {WebSocket} c
     * @param {Object} msg
     * @param {boolean} [includeSender=false]
     */
    notifyAll(c, msg, includeSender) {
        includeSender = !!includeSender;
        var msgStr = JSON.stringify(msg);
        this.clients.forEach(function(client, conn) {
            if (conn === c && !includeSender) {
                return;
            }
            conn.send(msgStr);
        });
    }
}

module.exports = Session;