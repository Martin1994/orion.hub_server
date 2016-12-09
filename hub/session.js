"use strict";

var ot = require('ot');
var parseUrl = require('url').parse;
var Document = require('./document.js');

/**
* This class defines an active session.
* It includes the list of connections, list of active documents, etc.
*/
class Session {

    constructor(sessionId) {
    	this.allConnections = [];
    	this.clients = {};
		//static class makeStats(...)?
		this.connectionStats = {
			created: Date.now(),
			sample: [],
			domains: {},
			urls: {},
			firstDomain: null,
			totalMessageChars: 0,
			totalMessages: 0,
			connections: 0,
			lastLeft: null
		};
		this.docs = {};
		this.sessionId = sessionId;
    }

    connectionJoined(c) {
    	this.allConnections.push(c);
    	this.connectionStats.connections++;
    	c.sendUTF(JSON.stringify({
			type: "init-connection",
			peerCount: this.allConnections.length-1
		}));
    }

    connectionLeft(c) {
	    var index = this.allConnections.indexOf(c);
	    if (index != -1) {
	      this.allConnections.splice(index, 1);
	    }
    	//delete the client
		var toDelete = undefined;
		for (var client in this.clients) {
			if (this.clients[client].connectionID == c.ID) {
				toDelete = this.clients[client].clientId;
				break;
			}
		}

		if (typeof toDelete !== 'undefined') {
			//remove the user from the document
			if (this.clients[toDelete].currentDoc) {
				this.docs[this.clients[toDelete].currentDoc].leaveDocument(c, this.clients[toDelete].clientId);
			}

			delete this.clients[toDelete];
		}

	    // var message = {
	    // 	'type': 'utf8',
	    // 	'utf8Data': JSON.stringify({
	    // 		'type': 'client_left'
	    // 	})
	    // };

	    // this.notifyAll(c, message);
	    return true;
    }

    onmessage(c, message) {
    	this.miscInfo(message);
      	
		var msg = JSON.parse(message.utf8Data);
		
		if (!this.clients[msg.clientId]) {
			//populate the client data or update it if it already exists
			this.clients[msg.clientId] = this.createClient(c.id, msg.clientId, 'unknown');
    	}

    	//if its a doc specific message, only send it to the clients involved. Otherwise send to all.
    	if (msg.doc) {
		    var doc = msg.doc;
	    	this.clients[msg.clientId].currentDoc = doc;
		    //if we don't have the document, let's start it up.
	    	if (!this.docs[doc]) {
	    		var self = this;
				this.docs[doc] = new Document(doc, this.sessionId);
				this.docs[doc].startOT()
				.then(function() {
					self.docs[doc].onmessage(c, message, self.clients[msg.clientId]);
				});
			} else {
				this.docs[doc].onmessage(c, message, this.clients[msg.clientId]);
			}
    	} else {
    		if (msg.type == 'leave-document') {
    			if (this.docs[this.clients[msg.clientId].currentDoc]) {
	    			this.docs[this.clients[msg.clientId].currentDoc].onmessage(c, message, this.clients[msg.clientId]);
    			}    				
    		} else {
	    		if (this.clients[msg.clientId].currentDoc) {
	    			//update doc specific client data
	    			this.docs[this.clients[msg.clientId].currentDoc].updateClient(msg);
	    		}
	    	 	this.notifyAll(c, message);
    		}
    	}
    }
    
    notifyAll(c, message, includeMessenger) {
	    for (var i=0; i<this.allConnections.length; i++) {
	      var conn = this.allConnections[i];
	      if (conn == c && !includeMessenger) {
	        continue;
	      }
	      if (message.type === 'utf8') {
	        conn.sendUTF(message.utf8Data);
	      } else if (message.type === 'binary') {
	        conn.sendBytes(message.binaryData);
	      }
	    }
    }

    createClient(connectionID, clientId, username) {
    	if (!this.clients[clientId]) {
    		var usercolor = this.generateUserColor();

    		this.clients[clientId] = {
				'clientId': clientId,
				'username': username,
				'usercolor': usercolor,
				'connectionID': connectionID,
				'active': true
    		};
    	}
    }

    miscInfo(message) {
	    var domain = null;
       	var msg = JSON.parse(message.utf8Data);

		if (msg.url) {
		  domain = parseUrl(msg.url).hostname;
		  this.connectionStats.urls[msg.url] = true;
		}
		if ((! this.connectionStats.firstDomain) && domain) {
		  this.connectionStats.firstDomain = domain;
		}
		this.connectionStats.domains[domain] = true;
		this.connectionStats.totalMessageChars += message.utf8Data.length;
		this.connectionStats.totalMessages++;
    }

    generateUserColor() {
		var COLORS = [
			"#8A2BE2", "#DC143C", "#E67E00", "#FF00FF", "#00CC00", "#999966", "#669999",
			"#FF6347", "#006AFF", "#000000"
		];
		return COLORS[Math.floor(Math.random() * COLORS.length)];
    }
}

module.exports = Session;