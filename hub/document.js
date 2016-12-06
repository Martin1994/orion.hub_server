"use strict";

var ot = require('ot');
var parseUrl = require('url').parse;
var Promise = require('bluebird');
var Request = require('request');

var orionLoadEndpoint = "http://localhost:8081/sharedWorkspace/tree/load/";
var orionSaveEndpoint = "http://localhost:8081/sharedWorkspace/tree/save/";

/**
* This class defines an active document.
* It includes document specific data about clients, deals with the OT and connects to the filesystem.
*/
class Document {

    constructor(id, sessionId) {
    	//every client is identified by clientID; must have as property a connection ID, and in-doc line location
    	this.clients = {};
    	this.ot = null;
    	this.connections = [];
    	this.id = id;
    	this.sessionId = sessionId; 
    }

    startOT() {
    	var self = this;
    	return this.getDocument()
    	.then(function(text, error) {
    		if (error) {
    			console.log('Failed to get initial content.');
    		}
	    	self.ot = new ot.Server(text);
    	});
    }

    destroy() {
    }

    joinDocument(connection, clientId) {
    	this.sendInit(connection);
    	this.connections.push(connection);

		var message = {
			'type': 'utf8',
			'utf8Data': JSON.stringify({
				'type': 'client_joined',
				'clientId': clientId,
				'client': this.clients[clientId],
				'doc': this.id
			})
		};

		// var message = {
		// 	'type': 'utf8',
		// 	'utf8Data': JSON.stringify({
		// 		'type': 'selection',
		// 		'clientId': clientId,
		// 		'selection': this.clients[clientId].selection,
		// 		'doc': this.id
		// 	})
		// };

		this.notifyOthers(connection, message);
    }

    leaveDocument(connection, clientId) {
	    var index = this.connections.indexOf(connection);

	    if (index == -1) {
	    	return;
	    }

	    this.connections.splice(index, 1);
    	//delete the client
    	if (clientId) {
    		delete this.clients[clientId];
    	} else {
    		var toDelete = undefined;
    		for (var client in this.clients) {
    			if (client.connectionID == connection.ID) {
    				toDelete = client;
    				break;
    			}
    		}
    		delete this.clients[toDelete];
    	}

		var message = {
			'type': 'utf8',
			'utf8Data': JSON.stringify({
				'type': 'client_left',
				'clientId': clientId,
				'doc': this.id
			})
		};

		if (this.clients.length == 0) {
			this.destroy();
		}
		this.notifyOthers(null, message);
    }

    onmessage(connection, message) {
		var msg = JSON.parse(message.utf8Data);
		if (!this.clients[msg.clientId]) {
			//create or update the necessary client info
			//create a updateClient function
			this.clients[msg.clientId] = {'clientId': msg.clientId, 'connectionID': connection.ID, 'selection': 0};
    	}

	    if (msg.type == 'join-document') {
			this.joinDocument(connection, msg.clientId);
	    } else if (msg.type == 'leave-document') {
	    	this.leaveDocument(connection, msg.clientId);
	    } else if (msg.type == 'operation') {
	    	var operation = this.newOperation(msg.operation, msg.revision);
	        msg.operation = operation;
	        message.utf8Data = JSON.stringify(msg);
	        connection.sendUTF(JSON.stringify({'type': 'ack', 'doc': this.id}));
	        this.notifyOthers(connection, message);
	    } else if (msg.type == 'selection') {
	    	this.clients[msg.clientId].selection = msg.selection;
	    	this.notifyOthers(connection, message);
	    }
    }

    updateClient(msg) {
    	var changed = false;
    	if (this.clients[msg.clientId]) {
    		var client = this.clients[msg.clientId];
    		if (msg.color && msg.color != client.color) {client.color = msg.color; changed = true;}
    		if (msg.name && msg.name != client.name) {client.name = msg.name; changed = true;}
    	} else {

    	}

    	msg.type = 'update_client';

		var message = {
			'type': 'utf8',
			'utf8Data': JSON.stringify(msg)
		};

    	if (changed) this.notifyOthers(null, message);
    }

	sendInit(c) {
		c.sendUTF(JSON.stringify({
			type: "init-document",
			operation: new ot.TextOperation().insert(this.ot.document),
			revision: this.ot.operations.length,
			'doc': this.id,
			clients: this.clients
		}));
	}

    getDocument() {
    	var self = this;
    	return new Promise(function(resolve, reject) {
			Request(orionLoadEndpoint + self.id + '?hubID=' + self.sessionId, function(error, response, body) {
				if (!error) {
					resolve(body);
				} else {
					reject(error);
				}
			});
		});
    }

    saveDocument() {
    	var self = this;
    	return new Promise(function(resolve, reject) {
    		var headerData = {
				"Orion-Version": "1",
				"Content-Type": "text/plain; charset=UTF-8"
			};
			Request({method: 'PUT', uri: orionSaveEndpoint + self.id + '?hubID=' + self.sessionId, headers: headerData, body: self.ot.document}, function(error, response, body) {
				if (body && !error) {
					resolve(body);
				} else {
					reject(error);
				}
			});
		});
    }

    newOperation(operation, revision) {
        if (revision % 5 == 0) {
	        this.saveDocument()
	        .then(function(success, error) {
				if (error) {
					console.log(error);
				} else {
					console.log("done saving");
				}
	        });
        }
	    var operation = ot.TextOperation.fromJSON(operation);
	    operation = this.ot.receiveOperation(revision, operation);
	    return operation;
    }

    notifyOthers(connection, message, includeMessenger) {
	    for (var i=0; i<this.connections.length; i++) {
	      var conn = this.connections[i];
	      if (conn == connection && !includeMessenger) {
	        continue;
	      }
	      if (message.type === 'utf8') {
	        conn.sendUTF(message.utf8Data);
	      } else if (message.type === 'binary') {
	        conn.sendBytes(message.binaryData);
	      }
	    }
    }
}

module.exports = Document;
