'use strict';

var StashHandler = require('./lib/StashHandler');

var exports = function() {
  this.configure = this.configure.bind(this);
  this.options = this.options.bind(this);
  this.run = this.run.bind(this);
  this.yargs = null;
};

var config = {};
var server = {};

exports.shortDescription = 'Runs a webhook handler and sends updates to stash status API.';

exports.help = 'Usage: npm start [args]';
exports.help += '\n';
exports.help += 'Provides a stash webhook endpoint.';

exports.options = function(yargs) {
  this.yargs = yargs;
  return yargs
    .describe('port', 'The port on which to listen for incoming requests.')
    .alias('port', 'p')
    .describe('stash-webhook-path', 'The path at which to listen for webhooks.')
    .alias('stash-webhook-path', 'P')
    .describe('stash-webhook-secret', 'The webhook secret provided to Stash.')
    .alias('stash-webhook-secret', 's')
    .describe('stash-api-token', 'The API token to use to write to Stash.')
    .alias('stash-api-token', 'a')
  ;
};

exports.configure = function(conf) {
  config = conf;
  server = new StashHandler(config);
};

exports.run = function(cb) {
  server.start();
};

module.exports = exports;
