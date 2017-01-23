"use strict";

var ot = require('ot');
var parseUrl = require('url').parse;
var Promise = require('bluebird');
var Request = require('request');
var config = require('./config.js');

var fileLoadUrl = config.orion + config.fileLoadUrl;
var fileSaveUrl = config.orion + config.fileSaveUrl;

/**
* This class defines an active document.
* It includes document specific data about clients, deals with the OT and connects to the filesystem.
*/
class Document {

	/**
	 * @param id - the doc id.
	 * @param sessionId - the id of the session
	**/
    constructor(id, sessionId) {
    	//every client is identified by clientID; must have as property a connection ID, and in-doc line location
    	this.clients = {};
    	this.ot = null;
    	this.connections = [];
    	this.id = id;
		this.sessionId = sessionId;
		this.awaitingDoc = false;
		this.waitingConnections = [];
    }

    startOT() {
		if (this.awaitingDoc) {
			return new Promise.resolve();
		}
		this.awaitingDoc = true;
    	var self = this;
    	return this.getDocument()
    	.then(function(text, error) {
    		if (error) {
    			console.log('Failed to get initial content.');
    		}
	    	self.ot = new ot.Server(text);
			console.log("******************");
			console.log(self.id);
			console.log("OT HAS STARTED!!");
			self.awaitingDoc = false;
			self.waitingConnections.forEach(function(c) {
				self.sendInit(c);
			});
			self.waitingConnections = [];
    	});
    }

    destroy() {
    }

    joinDocument(connection, clientId, client) {
		if (!this.clients[clientId] && client) {
			this.clients[clientId] = client;
			this.clients[clientId].selection = new ot.Selection.createCursor(0);
		}

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

		this.notifyOthers(connection, message);

		this.sendInit(connection);
    }

    leaveDocument(connection, clientId, callback) {
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

		if (Object.keys(this.clients).length == 0) {
			this.saveDocument()
			.then(function() {
				callback(true);
			});
		} else {
			this.notifyOthers(null, message);
			callback(false);
		}
    }

    onmessage(connection, message, client) {
		var msg = JSON.parse(message.utf8Data);

	    if (msg.type == 'join-document') {
			this.joinDocument(connection, msg.clientId, client);
	    } else if (msg.type == 'operation') {
			try {
				var operation = this.newOperation(msg.operation, msg.revision);
		        msg.operation = operation;
		        message.utf8Data = JSON.stringify(msg);
		        connection.sendUTF(JSON.stringify({'type': 'ack', 'doc': this.id}));
		        this.notifyOthers(connection, message);
			} catch (e) {
				console.warn(e);
				var self = this;
				this.connections.forEach(function(c) {
					self.sendInit(c);
				});
			}
	    } else if (msg.type == 'selection') {
			if (this.clients[msg.clientId]) {
				this.clients[msg.clientId].selection = msg.selection;
			}
	    	this.notifyOthers(connection, message);
	    } else if (msg.type == 'get-clients') {
	    	this.sendAllClients(connection);
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
		//if doc being grabbed by other user, add this user to waiting list for receiving it.
		if (this.awaitingDoc) {
			this.waitingConnections.push(c);
			console.log("connection waiting for doc.");
			return;
		}
		try {
			var message = JSON.stringify({
				type: "init-document",
				operation: new ot.TextOperation().insert(this.ot.document),
				revision: this.ot.operations.length,
				'doc': this.id,
				clients: this.clients
			}); 
			c.sendUTF(message);
		} catch (e) {
			console.warn(e.stack);
			if (!this.ot) {
				var self = this;
				console.log("******************");
				console.log(this.id);
				console.log("two users probably entered a doc at the same moment.");
				this.startOT()
				.then(function() {
					self.sendInit(c);
				});
			}
		}
	}

    getDocument() {
    	var self = this;
    	return new Promise(function(resolve, reject) {
			Request(fileLoadUrl + self.id + '?hubID=' + self.sessionId, function(error, response, body) {
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
			Request({method: 'PUT', uri: fileSaveUrl + self.id + '?hubID=' + self.sessionId, headers: headerData, body: self.ot.document}, function(error, response, body) {
				if (body && !error) {
					resolve(body);
				} else {
					reject(error);
				}
			});
		});
    }

    sendAllClients(connection) {
		var message = JSON.stringify({
			type: "all_clients",
			'doc': this.id,
			clients: this.clients
		});
		connection.sendUTF(message);
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
