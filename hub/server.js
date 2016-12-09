/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// New Relic Server monitoring support
if ( process.env.NEW_RELIC_HOME ) {
  require("newrelic");
}

var SAMPLE_STATS_INTERVAL = 60*1000; // 1 minute
var SAMPLE_LOAD_INTERVAL = 5*60*1000; // 5 minutes
var EMPTY_ROOM_LOG_TIMEOUT = 3*60*1000; // 3 minutes
var WEBSOCKET_COMPAT = false;

var WebSocketServer = require("websocket").server;
var http = require('http');
var parseUrl = require('url').parse;
var fs = require('fs');
var Session = require('./session.js');
var Request = require('request');
var jwt = require('jsonwebtoken');

// FIXME: not sure what logger to use
//var logger = require('../../lib/logger');

// LOG_LEVEL values:
// 0: show everything (including debug)
// 1: don't show debug, do show logger.log
// 2: don't show logger.log and debug, do show logger.info (and STATS)
// 3: don't show info, do show warn
// 4: don't show warn, do show error
// 5: don't show anything
// Stats are at level 2

//jwt_secret needs to be the same as the one in the orion server
var jwt_secret = "pomato (potato and tomato mix lol)";

var thisSource = "// What follows is the source for the server.\n" +
    "// Obviously we can't prove this is the actual source, but if it isn't then we're \n" +
    "// a bunch of lying liars, so at least you have us on record.\n\n" +
    fs.readFileSync(__filename);

var Logger = function (level, filename, stdout) {
  this.level = level;
  this.filename = filename;
  this.stdout = !!stdout;
  this._open();
  process.on("SIGUSR2", (function () {
    this._open();
  }).bind(this));
};

Logger.prototype = {

  write: function () {
    if (this.stdout) {
      console.log.apply(console, arguments);
    }
    if (this.file) {
      var s = [];
      for (var i=0; i<arguments.length; i++) {
        var a = arguments[i];
        if (typeof a == "string") {
          s.push(a);
        } else {
          s.push(JSON.stringify(a));
        }
      }
      s = s.join(" ") + "\n";
      this.file.write(this.date() + " " + s);
    }
  },

  date: function () {
    return (new Date()).toISOString();
  },

  _open: function () {
    if (this.file) {
      this.file.end(this.date() + " Logs rotating\n");
      this.file = null;
    }
    if (this.filename) {
      this.file = fs.createWriteStream(this.filename, {flags: 'a', mode: parseInt('644', 8), encoding: "UTF-8"});
    }
  }

};

[["error", 4], ["warn", 3], ["info", 2], ["log", 1], ["debug", 0]].forEach(function (nameLevel) {
  var name = nameLevel[0];
  var level = nameLevel[1];
  Logger.prototype[name] = function () {
    if (logLevel <= level) {
      if (name != "log") {
        this.write.apply(this, [name.toUpperCase()].concat(Array.prototype.slice.call(arguments)));
      } else {
        this.write.apply(this, arguments);
      }
    }
  };
});

var logger = new Logger(0, null, true);

var server = http.createServer(function(request, response) {
  var url = parseUrl(request.url, true);
  var protocol = request.headers["forwarded-proto"] || "http:";
  var host = request.headers.host;
  var base = protocol + "//" + host;
  if (url.pathname == '/status') {
    response.end("OK");
  } else if (url.pathname == '/load') {
    var load = getLoad();
    response.writeHead(200, {"Content-Type": "text/plain"});
    response.end("OK " + load.connections + " connections " +
                 load.sessions + " sessions; " +
                 load.solo + " are single-user and " +
                 (load.sessions - load.solo) + " active sessions");
  } else if (url.pathname == '/server-source') {
    response.writeHead(200, {"Content-Type": "text/plain"});
    response.end(thisSource);
  } else {
    write404(response);
  }
});

function corsAccept(request, response) {
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*"
  });
  response.end();
}

function write500(error, response) {
  response.writeHead(500, {"Content-Type": "text/plain"});
  if (typeof error != "string") {
    error = "\n" + JSON.stringify(error, null, "  ");
  }
  response.end("Error: " + error);
}

function write404(response) {
  response.writeHead(404, {"Content-Type": "text/plain"});
  response.end("Resource not found");
}

function write400(error, response) {
  response.writeHead(400, {"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"});
  response.end("Bad request: " + error);
}

function write401(error, response) {
  response.writeHead(404, {"Content-Type": "text/plain"});
  response.end("Unauthorized request");
}

function generateId(length) {
  length = length || 10;
  var letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV0123456789';
  var s = '';
  for (var i=0; i<length; i++) {
    s += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  return s;
}

function pickRandom(seq) {
  return seq[Math.floor(Math.random() * seq.length)];
}

function startServer(port, host) {
  server.listen(port, host, function() {
    logger.info('HUB Server listening on port ' + port + " interface: " + host + " PID: " + process.pid);
  });
}

var wsServer = new WebSocketServer({
    httpServer: server,
    // 10Mb max size (1Mb is default, maybe this bump is unnecessary)
    maxReceivedMessageSize: 0x1000000,
    // The browser doesn't seem to break things up into frames (not sure what this means)
    // and the default of 64Kb was exceeded; raised to 1Mb
    maxReceivedFrameSize: 0x100000,
    // Using autoaccept because the origin is somewhat dynamic
    // FIXME: make this smarter?
    autoAcceptConnections: false
  });

function originIsAllowed(origin) {
  // Unfortunately the origin will be whatever page you are sharing,
  // which could be any origin
  return true;
}

var sessions = {};

var ID = 0;

wsServer.on('request', function(request) {
  if (!originIsAllowed(request.origin)) {
    // Make sure we only accept requests from an allowed origin
    request.reject();
    logger.info('Connection from origin ' + request.origin + ' rejected.');
    return;
  }
  
  var id = request.httpRequest.url.replace(/^\/+hub\/+/, '').replace(/\//g, "");

  if (! id) {
    request.reject(404, 'No ID Found');
    return;
  }

  // FIXME: we should use a protocol here instead of null, but I can't
  // get it to work.  "Protocol" is what the two clients are using
  // this channel for (we don't bother to specify this)
  var connection = request.accept(null, request.origin);
  connection.ID = ID++;
  connection.authenticated = false;

  if (! sessions[id]) {
    sessions[id] = new Session(id);
  }

  sessions[id].connectionJoined(connection);

  logger.debug('Connection accepted to ' + JSON.stringify(id) + ' ID:' + connection.ID);

  connection.on('message', function(message) {
    var parsed;
    try {
      parsed = JSON.parse(message.utf8Data);
    } catch (e) {
      logger.warn('Error parsing JSON: ' + JSON.stringify(message.utf8Data) + ": " + e);
      return;
    }

    if (parsed.type == 'authenticate') {
      //decode & verify token, then approve connection if successful
      try {
        var decoded = jwt.verify(parsed.token, jwt_secret);
        console.log("decoded username is: " + decoded.username);
        connection.sendUTF(JSON.stringify({'type': 'authenticated'}));
        connection.authenticated = true;
        //add info about the user like username, user-color (for client-side annotation and identification)
        sessions[id].createClient(connection.ID, parsed.clientId, decoded.username);
        return;
      } catch (err) {
        //failed to authenticate
      }
    }

    if (!connection.authenticated) {
      // throw error;
      return;
    }

    logger.debug('Message on ' + id + ' bytes: ' +
                 (message.utf8Data && message.utf8Data.length) +
                 ' conn ID: ' + connection.ID + ' data:' + message.utf8Data.substr(0, 20) +
                 ' connections: ' + sessions[id].allConnections.length);
    
    sessions[id].onmessage(connection, message);
  });
  connection.on('close', function(reasonCode, description) {
    if (! sessions[id]) {
      // Got cleaned up entirely, somehow?
      logger.info("Session ID", id, "was cleaned up entirely before last connection closed");
      return;
    }

    if (sessions[id].connectionLeft(connection)) {
      if (! sessions[id].allConnections.length) {
        delete sessions[id];
        // connectionStats[id].lastLeft = Date.now();
      }
    }

    logger.debug('Peer ' + connection.remoteAddress + ' disconnected, ID: ' + connection.ID);
  });
});

setInterval(function () {
  for (var id in sessions) {
    var sessionStats = sessions[id].connectionStats
    if (sessionStats.lastLeft && Date.now() - sessionStats.lastLeft > EMPTY_ROOM_LOG_TIMEOUT) {
      logStats(id, sessionStats);
      delete sessions[id].connectionStats;
      continue;
    }
    var totalClients = countClients(sessionStats.clients);
    var connections = 0;
    if (sessions[id].allConnections) {
      connections = sessions[id].allConnections.length;
    }
    sessions[id].connectionStats.sample.push({
      time: Date.now(),
      totalClients: totalClients,
      connections: connections
    });
  }
}, SAMPLE_STATS_INTERVAL);

setInterval(function () {
  var load = getLoad();
  load.time = Date.now();
  logger.info("LOAD", JSON.stringify(load));
}, SAMPLE_LOAD_INTERVAL);

function getLoad() {
  var opensessions = 0;
  var connections = 0;
  var empty = 0;
  var solo = 0;
  for (var id in sessions) {
    if (sessions[id].allConnections.length) {
      opensessions++;
      connections += sessions[id].allConnections.length;
      if (sessions[id].allConnections.length == 1) {
        solo++;
      }
    } else {
      empty++;
    }
  }
  return {
    sessions: opensessions,
    connections: connections,
    empty: empty,
    solo: solo
  };
}

function countClients(clients) {
  var n = 0;
  for (var clientId in clients) {
    n++;
  }
  return n;
}

function logStats(id, stats) {
  logger.info("STATS", JSON.stringify({
    id: id,
    created: stats.created,
    sample: stats.sample,
    totalClients: countClients(stats.clients),
    totalMessageChars: stats.totalMessageChars,
    totalMessages: stats.totalMessages,
    domain: stats.firstDomain || null,
    domainCount: countClients(stats.domains),
    urls: countClients(stats.urls)
  }));
}

if (require.main == module) {
  var ops = require('optimist')
      .usage("Usage: $0 [--port 8080] [--host=localhost] [--log=filename] [--log-level=N]")
      .describe("port", "The port to server on (default $HUB_SERVER_PORT, $PORT, $VCAP_APP_PORT, or 8080")
      .describe("host", "The interface to serve on (default $HUB_SERVER_HOST, $HOST, $VCAP_APP_HOST, 127.0.0.1).  Use 0.0.0.0 to make it public")
      .describe("log-level", "The level of logging to do, from 0 (very verbose) to 5 (nothing) (default $LOG_LEVEL or 0)")
      .describe("log", "A file to log to (default $LOG_FILE or stdout)")
      .describe("stdout", "Log to both stdout and the log file");
  var port = ops.argv.port || process.env.HUB_SERVER_PORT || process.env.VCAP_APP_PORT ||
      process.env.PORT || 8080;
  var host = ops.argv.host || process.env.HUB_SERVER_HOST || process.env.VCAP_APP_HOST ||
      process.env.HOST || '0.0.0.0';
  var logLevel = process.env.LOG_LEVEL || 0;
  var logFile = process.env.LOG_FILE || ops.argv.log;
  var stdout = ops.argv.stdout || !logFile;
  if (ops.argv['log-level']) {
    logLevel = parseInt(ops.argv['log-level'], 10);
  }
  logger = new Logger(logLevel, logFile, stdout);
  if (ops.argv.h || ops.argv.help) {
    console.log(ops.help());
    process.exit();
  } else {
    startServer(port, host);
  }
}

exports.startServer = startServer;
