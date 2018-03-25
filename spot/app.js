var fs = require('fs')
var express = require('express');
var os = require('os');
var pty = require('node-pty');
var path = require('path');
require('ejs'); // allows 'pkg' to include this dependency. see https://github.com/zeit/pkg#config

var app = express();
var expressWs = require('express-ws')(app);

var chokidar = require('chokidar');

var terminals = {};
var logs = {};

var instanceToken = process.env.INSTANCE_TOKEN;

if (!instanceToken) {
  console.error('ERROR: Instance token is not set!');
  process.exit(1);
}

app.set('view engine', 'ejs');

app.use('/build', express.static(path.join(__dirname, 'node_modules', 'xterm', 'dist')));

var requiresValidToken = function (req, res, next) {
  if (req.query.token == instanceToken) {
    next();
  } else {
    res.sendStatus(401);
  }
};

app.get('/health-check', requiresValidToken, (req, res) => res.sendStatus(200));

app.get('/', requiresValidToken, function(req, res){
  res.render('index', {instanceToken: instanceToken});
});

app.get('/favicon.ico', function(req, res){
  res.sendFile(path.join(__dirname, '/favicon.ico'));
});

app.get('/style.css', function(req, res){
  res.sendFile(path.join(__dirname, '/style.css'));
});

app.get('/main.js', requiresValidToken, function(req, res){
  res.render('main', {instanceToken: instanceToken});
});

app.post('/terminals', requiresValidToken, function (req, res) {
  var cols = parseInt(req.query.cols),
      rows = parseInt(req.query.rows),
      term = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : 'bash', [], {
        name: 'xterm-color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: process.env.PWD,
        env: process.env
      });

  console.log('Created terminal with PID: ' + term.pid);
  terminals[term.pid] = term;
  logs[term.pid] = '';
  term.on('data', function(data) {
    logs[term.pid] += data;
  });
  res.send(term.pid.toString());
  res.end();
});

app.post('/terminals/:pid/size', requiresValidToken, function (req, res) {
  var pid = parseInt(req.params.pid),
      cols = parseInt(req.query.cols),
      rows = parseInt(req.query.rows),
      term = terminals[pid];

  term.resize(cols, rows);
  console.log('Resized terminal ' + pid + ' to ' + cols + ' cols and ' + rows + ' rows.');
  res.end();
});

app.ws('/file/:fileid', function(ws, req) {
  if (req.query.token == instanceToken) {
    var theFilePath = undefined;
    var fileId = req.params.fileid;
    ws.on('message', function(msg) {
      try {
        msg_obj = JSON.parse(msg);
      } catch (e) {
        msg_obj = undefined;
      }
      if (msg_obj && msg_obj.event === 'fileDownload') {
        console.log('Received message', msg_obj);
        if (msg_obj.event === 'fileDownload') {
          console.log(msg_obj.path);
          theFilePath = msg_obj.path;
          fs.readFile(msg_obj.path, "utf8", function(err, data) {
            ws.send(data);
          });
        }
      } else {
        // Must be a file for us to save.
        fs.writeFile(theFilePath, msg, (err) => {
          if (err) {
            console.error("Error saving file", err);
          }
        });
      }
    });
    ws.on('close', function () {
      console.log('Closed');
    });
  } else {
    ws.close();
  }
});

app.ws('/files', function(ws, req) {
  if (req.query.token == instanceToken) {
    var watcher = chokidar.watch('/root', {ignored: /(^|[\/\\])\../, ignorePermissionErrors: true}).on('all', (event, path) => {
      console.log(event, path);
      data = {event: event, path: path};
      try {
        ws.send(JSON.stringify(data));
      } catch (ex) {
        console.error(ex);
        // The WebSocket is not open, ignore
      }
    });
    console.log('Connected to file watcher');
    ws.on('close', function () {
      watcher.close();
      console.log('Closed file watcher');
    });
  } else {
    ws.close();
  }
});

app.ws('/terminals/:pid', function (ws, req) {
  if (req.query.token == instanceToken) {
    var term = terminals[parseInt(req.params.pid)];
    console.log('Connected to terminal ' + term.pid);
    ws.send(logs[term.pid]);
  
    term.on('data', function(data) {
      try {
        ws.send(data);
      } catch (ex) {
        // The WebSocket is not open, ignore
      }
    });
    ws.on('message', function(msg) {
      term.write(msg);
    });
    ws.on('close', function () {
      term.kill();
      console.log('Closed terminal ' + term.pid);
      // Clean things up
      delete terminals[term.pid];
      delete logs[term.pid];
    });
  } else {
    ws.close();
  }
  
});

var port = process.env.PORT || 3000,
    host = os.platform() === 'win32' ? '127.0.0.1' : '0.0.0.0';

console.log('App listening to http://' + host + ':' + port);
app.listen(port, host);