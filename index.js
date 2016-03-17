'use strict';

var path = require('path');
var util = require('util');

var Loader = require('yaml-config-loader');
var yargs = require('yargs');
var loader = new Loader();

loader.on('error', function(error) {
  if (error.name === 'YAMLException') {
    console.error(util.print('Error parsing YAML file `', error.filePath, '`:', error.reason));
    console.log(error);
  }
});

var handler = require('./handler');

var argv = yargs
  .describe('config', 'A YAML config file or directory of yaml files to load, can be invoked multiple times and later files will override earlier.')
  .alias('config', 'c')
  .argv;

loader.add(path.resolve(path.join(__dirname, 'defaults.yaml')));
loader.addAndNormalizeObject(process.env);

if (argv.config) {
  if (typeof argv.config === 'string') {
    argv.config = [argv.config];
  }
  for (let conf of argv.config) {
    loader.add(path.resolve(conf));
  }
}

var executor = handler;

if (executor.options) {
  yargs = executor.options(yargs);
  var setOptions = {};
  var key = null;
  for (key in yargs.argv) {
    if (yargs.argv[key] !== void 0) {
      setOptions[key] = yargs.argv[key];
    }
  }
  loader.addAndNormalizeObject(setOptions);
}

loader.load(function(error, config) {
  if (error) throw error;
  if (executor.configure) {
    executor.configure(config);
  }
  executor.run();
});
