// New Relic Server monitoring support
if ( process.env.NEW_RELIC_HOME ) {
  require("newrelic");
}

var STATS_INTERVAL = 5*60*1000; //5 minutes

var WebSocketServer = require("websocket").server;
var http = require('http');
var parseUrl = require('url').parse;
var fs = require('fs');
var Session = require('./session.js');
var jwt = require('jsonwebtoken');
var config = require('./config.js');

var jwt_secret = config.jwt_secret;

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
  if (url.pathname == '/'){
    response.end("OK")
  } else if (url.pathname == '/status') {
    response.end("Running");
  } else if (url.pathname == '/load') {
    var load = getLoad();
    response.writeHead(200, {"Content-Type": "text/plain"});
    response.end("OK " + load.connections + " connections " +
                 load.sessions + " sessions; " +
                 load.solo + " are single-user and " +
                 (load.sessions - load.solo) + " active sessions");
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

    //give the connection an ID
    connection.ID = ID++;
    //Add the 'autheticated' flag to the connection
    connection.authenticated = false;

    //initialize the session if its the first user connecting to it
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

        //we don't want to process messages from this connection if it is not authenticated
        if (!connection.authenticated) {
            // throw error;
            return;
        }
    
        sessions[id].onmessage(connection, message);
    });

    connection.on('close', function(reasonCode, description) {
        if (! sessions[id]) {
            // Got cleaned up entirely, somehow?
            logger.info("Session ID", id, "was cleaned up entirely before last connection closed");
            return;
        }

        //check with the session if its the last person who left
        sessions[id].connectionLeft(connection, function(lastPerson) {
            lastPerson ? delete sessions[id] : null;
        });

        logger.debug('Peer ' + connection.remoteAddress + ' disconnected, ID: ' + connection.ID);
    });
});

setInterval(function() {
    var stats = {
        totalSessions: 0,
        totalClients: 0
    };

    for (id in sessions) {
        stats.totalSessions += 1;
        stats.totalClients += sessions[id].allConnections.length;
    }

    logger.info('SERVER STATS: ' + JSON.stringify(stats));
}, STATS_INTERVAL);

if (require.main == module) {
    var port = process.env.PORT || 8080;
    var host = process.env.HOST || '127.0.0.1' /*|| '0.0.0.0'*/; //'0.0.0.0' is used to make this public and accessible by ipaddress.
    var logLevel = process.env.LOG_LEVEL || 0;
    var logFile = process.env.LOG_FILE;
    var stdout = !logFile;
    logger = new Logger(logLevel, logFile, stdout);
    startServer(port, host);
}

exports.startServer = startServer;
