'use strict';

var util = require('util');
var async = require('async');
var url = require('url');
var restify = require('restify');
var bunyan = require('bunyan');
var yaml = require('js-yaml');

var createWebhookHandler = require('./stashWebhookHandler');

var Stash = require('./stash');


var API = require('./api');

/**
 * Create a queue that only processes one task at a time.
 * A task is simply a function that takes a callback when it's done
 */
var statusUpdateQueue = async.queue(function worker(fn, cb) {
  fn(cb);
}, 1);


var StashHandler = function(options) {

  this.options = options;

  this.validateOptions();
  // Bind functions to ensure `this` works for use in callbacks.
  this.start = this.start.bind(this);
  this.fetchProboYamlConfigFromStash = this.fetchProboYamlConfigFromStash.bind(this);
  this.errorHandler = this.errorHandler.bind(this);
  this.pushHandler = this.pushHandler.bind(this);
  this.getStashApi = this.getStashApi.bind(this);
  this.authLookupController = this.authLookupController.bind(this);

  // Instantiate a logger instance.
  var log = bunyan.createLogger({name: 'stash-handler',
                                  level: options.log_level || 'debug',
                                  src: true,
                                  serializers: {
                                    err: bunyan.stdSerializers.err,
                                    req: bunyan.stdSerializers.req,
                                  }});
  var handlerOptions = {
    path: options.stashWebhookUrl,
  };

  var handler = createWebhookHandler(handlerOptions);
  handler.on('error', this.errorHandler);
  // handler.on('pull_request', this.pullRequestHandler);
  handler.on('UPDATE', this.pushHandler);

  var self = this;

  var server = options.server;

  if (!server) {
    server = restify.createServer({log: log, name: 'Probo Stash'});

    // set up request logging
    server.use(restify.queryParser({mapParams: false}));

    server.use(function(req, res, next) {
      req.log.info({req: req}, 'REQUEST');
      next();
    });
    server.on('after', restify.auditLogger({
      log: log,
    }));

    server.on('uncaughtException', function(request, response, route, error) {
      self.server.log.error({err: error, route: route}, 'Uncaught Exception');
      response.send(error);
    });
  }



  server.post(handlerOptions.path, restify.bodyParser(), function(req, res, next) {
    handler(req, res, function(error) {
      if (error) {
        res.send(400, 'Error processing hook');
        log.error({err: error}, 'Error processing hook');
      }

      next();
    });
  });

  var buildStatusController = function(req, res, next) {
    var payload = req.body;

    if (req.params.context) {
      // usually, context will already be part of update, but read it from URL
      // if it's there for compatability
      payload.update.context = req.params.context;
    }

    log.debug({payload: payload}, 'Update payload');

    self.buildStatusUpdateHandler(payload.update, payload.build, function(err, status) {
      if (err) {
        res.send(500, {error: err});
      }
      else {
        res.send(status);
      }
      return next();
    });
  };

  server.post('/builds/:bid/status/:context', restify.jsonBodyParser(), buildStatusController);
  server.post('/update', restify.jsonBodyParser(), buildStatusController);

  server.get('/auth_lookup', this.authLookupController);

  this.server = server;
  this.log = log;

  this.api = API.getAPI({
    url: this.options.api.url,
    token: this.options.api.token,
    log: this.log,
    // {url, [host|hostname], [protocol], [port]}
    handler: this.options,
  });

  if (!(this.api instanceof API)) {
    log.info('api.token not found, using Container Manager API directly');
  }
};

StashHandler.prototype.validateOptions = function() {
  var providers = this.options.providers;
  var optionsRequired = ['stashWebhookUrl'];
  var providerRequired = ['url', 'consumerKey', 'consumerSecret'];
  var provider;

  this._validate(this.options, optionsRequired);

  for (let p of Object.keys(providers)) {
    provider = providers[p];

    // ignore non-stash providers
    if (provider.type !== 'stash') {
      continue;
    }

    this._validate(provider, providerRequired);
  }
};

StashHandler.prototype._validate = function(obj, required, msg) {
  msg = msg || 'Missing required Stash config: ';

  for (var r in required) {
    if (!obj[required[r]]) {
      throw new Error(msg + required[r]);
    }
  }
};


/**
 * Starts the server listening on the configured port.
 */
StashHandler.prototype.start = function(cb) {
  var self = this;
  this.server.listen(self.options.port, self.options.hostname || '0.0.0.0', function() {
    self.log.info('Now listening on', self.server.url);
    return cb && cb();
  });
};

StashHandler.prototype.stop = function(cb) {
  var self = this;
  var url = this.server.url;
  this.server.close(function() {
    self.log.info('Stopped', url);
    return cb && cb();
  });
};

/**
 * Build options for Stash api HTTP requests.
 */
StashHandler.prototype.getStashApi = function(project) {
  var provider = this.options.providers[project.provider.slug];

  if (!provider) {
    throw new Error('Could not find provider for slug: ' + project.provider.slug);
  }

  var stash = new Stash({
    url: provider.url,
    auth: {
      type: 'oauth1',
      token: project.service_auth.token,
      tokenSecret: project.service_auth.tokenSecret,
      consumerKey: provider.consumerKey,
      consumerSecret: provider.consumerSecret,
    },
  });

  return stash;
};

/**
 * Error handler for Stash webhooks.
 */
StashHandler.prototype.errorHandler = function(error) {
  this.log.error({err: error}, 'An error occurred.');
};


/**
 * Handler for push events.
 */
StashHandler.prototype.pushHandler = function(event, cb) {
  // return cb && cb(null, {
  //   id: "build1",
  //   projectId: "1234",
  //   sha: "383e221f3f407055bd252c774df4ecdc1a04ed6e",
  //   project: {
  //     id: "1234",
  //     owner: "TEST",
  //     repo: "testrepo",
  //     service: "stash:http://localhost:7990",
  //     slug: "TEST/testrepo"
  //   }
  // });


  // enqueue the event to be processed...
  var self = this;

  // this.log.info('Stash Pull request ' + event.payload.pull_request.id + ' received');
  this.log.info('Stash push received');
  this.log.debug({event: event}, 'Stash push received');

  var payload = event.payload;
  var repository = payload.repository;

  // parse out host
  var stashHost;
  try {
    var link = payload.changesets.values[0].links.self[0].href;
    var parts = url.parse(link);
    stashHost = util.format('%s//%s', parts.protocol, parts.host);
  }
  catch (e) {
    self.log.error({err: e, event: event},
                   'Failed to find host for Stash push, ignoring push');
    return;
  }

  var repoHtmlUrl = `${stashHost}/projects/${repository.project.key}/repos/${repository.slug}`;
  var commitHash = payload.refChanges[0].toHash;

  var request = {
    // 'UPDATE'
    type: event.event,
    // set below, this is the full slug of the service
    service: util.format('stash:%s', stashHost),
    owner: repository.project.key.toLowerCase(),
    repo: repository.slug,
    repo_id: repository.id,
    // refId: refs/heads/feature
    branch: payload.refChanges[0].refId.split('/')[2],
    branch_html_url: repoHtmlUrl + `/commits?until=${encodeURIComponent(payload.refChanges[0].refId)}`,
    sha: commitHash,
    commit_url: repoHtmlUrl + '/commits/' + commitHash,

    // pull request information not available
    pull_request: null,
    pull_request_id: null,
    pull_request_name: null,
    pull_request_description: null,
    pull_request_html_url: null,

    payload: payload,
    host: event,
  };
  request.slug = util.format('%s/%s', request.owner, request.repo);

  /**
   * build comes back with an embedded .project
   * not necessary to do anything here, build status updates will come asyncronously
   */
  this.processRequest(request, function(error, build) {
    self.log.info({type: request.type, slug: request.slug, err: error}, 'request processed');
    return cb && cb(error, build);
  });
};

/**
 * Called when an build status updates
 *
 * update = {
 *  state: "status of build",
 *  description: "",
 *  key: "the context", // <- 'context' for github
 *  url: ""             // <- 'target_url' for github
 * }
 *
 * build has an embedded .project too
 */
StashHandler.prototype.buildStatusUpdateHandler = function(update, build, cb) {
  var self = this;
  self.log.info({update: update, build_id: build.id}, 'Got build status update');

  // maps github-like statuses to ones that stash accepts
  var stateMap = {
    success: 'SUCCESSFUL',
    pending: 'INPROGRESS',
    error: 'FAILED',
    fail: 'FAILED',
  };

  var statusInfo = {
    state: stateMap[update.state],
    description: update.description,
    key: update.context,
    url: update.target_url,
  };

  // handle unknown state
  if (!statusInfo.state) {
    statusInfo.state = 'PENDING';
    statusInfo.description = (statusInfo.description || '') + ' (original state:' + update.state + ')';
  }

  var task = this.postStatusToStash.bind(this, build.project, build.commit.ref, statusInfo);
  statusUpdateQueue.push(task, function(error) {
    if (error) {
      self.log.error({err: error, build_id: build.id}, 'An error occurred posting status to Stash');
      return cb(error, statusInfo);
    }

    self.log.info(statusInfo, 'Posted status to Stash for', build.project.slug, build.ref);
    cb(null, statusInfo);
  });
};

/**
 * request: {type, service, slug, event}
 */
StashHandler.prototype.processRequest = function(request, cb) {
  var self = this;
  self.log.info({type: request.type, id: request.id}, 'Processing request');

  this.api.findProjectByRepo(request, function(error, project) {
    if (error || !project) {
      return self.log.warn(
        {err: error},
        'Project for stash repo ' + request.slug + ' not found'
      );
    }

    self.log.info({project: project}, 'Found project for PR');

    self.fetchProboYamlConfigFromStash(project, request.sha, function(error, config) {
      var build;

      if (error) {
        self.log.error({err: error}, 'Problem fetching Probo Yaml Config file');

        // If we can't find a yaml file we should error.
        build = {
          commit: {ref: request.sha},
          project: project,
        };
        var update = {
          state: 'failure',
          description: error.message,
          context: 'ProboCI/env',
        };
        return self.buildStatusUpdateHandler(update, build, cb);
      }

      self.log.info({config: config}, 'Probo Yaml Config file');

      build = {
        commit: {
          ref: request.sha,
          htmlUrl: request.commit_url,
        },
        pullRequest: {
          number: request.pull_request ? request.pull_request + '' : '',
          name: request.pull_request_name,
          description: request.pull_request_description,
          htmlUrl: request.pull_request_html_url,
        },
        branch: {
          name: request.branch,
          htmlUrl: request.branch_html_url,
        },
        config: config,
        request: request,
      };


      self.api.submitBuild(build, project, function(err, submittedBuild) {
        if (err) {
          // TODO: save the PR if submitting it fails (though logging it here might be ok)
          self.log.error({err: err, request: request, build: build, message: submittedBuild}, 'Problem submitting build');
          return cb && cb(err);
        }

        self.log.info({build: submittedBuild}, 'Submitted build');

        cb(null, submittedBuild);
      });

    });
  });
};

/**
 * Posts status updates to Stash.
 *
 */
StashHandler.prototype.postStatusToStash = function(project, sha, statusInfo, done) {
  var self = this;
  var stash;

  try {
    stash = self.getStashApi(project);
  }
  catch (e) {
    return done(e);
  }

  stash.statuses.create(statusInfo, {ref: sha}, function(error, body) {
    done(error, body);
  });
};

/**
 * Fetches configuration from a .probo.yml file in the stash repo.
 */
StashHandler.prototype.fetchProboYamlConfigFromStash = function(project, sha, done) {
  var self = this;
  var stash;

  try {
    stash = this.getStashApi(project);
  }
  catch (e) {
    return done(e);
  }

  stash.repos.getContent({projectKey: project.owner, repositorySlug: project.repo, ref: sha, path: ''}, function(error, files) {
    if (error) return done(error);

    var regex = /^(.?probo.ya?ml|.?proviso.ya?ml)$/;
    var match = false;
    var file;
    for (file of files) {
      if (regex.test(file.path.name)) {
        match = true;
        break;
      }
    }
    if (!match) {
      // Should this be an error or just an empty config?
      return done(new Error('No .probo.yml file was found.'));
    }

    stash.repos.getContent({projectKey: project.owner, repositorySlug: project.repo, ref: sha, path: file.path.name}, function(error, content) {
      if (error) {
        self.log.error({error: error}, 'Failed to get probo config file contents');

        return done(error);
      }

      // TODO: bad YAML error handling
      var settings = yaml.safeLoad(content.toString('utf8'));
      done(null, settings);
    });
  });
};

/**
 * Calculates OAuth1.0 authorization header value for a request
 * params:
 *  - type: 'stash'
 *  - path: pre-build path to append to Stash server URL
 *  - provider_slug: provider slug
 *  - token: user auth token
 *  - tokenSecret: user auth token secret
 */
StashHandler.prototype.authLookupController = function(req, res, next) {
  this.log.debug({query: req.query}, `auth lookup request: ${req.query.provider_slug} ${req.query.path}`);

  try {
    // validate query params
    this._validate(req.query, ['path', 'provider_slug', 'token', 'tokenSecret'],
                   'Missing required query param: ');

    // build a minimum project object
    var project = {
      provider: {
        slug: req.query.provider_slug,
      },
      service_auth: {
        token: req.query.token,
        tokenSecret: req.query.tokenSecret,
      },
    };

    var stash = this.getStashApi(project);
    var auth = stash.getAuthHeader({path: req.query.path});

    var url = stash.url + req.query.path;

    res.send({auth, url});
    next();
  }
  catch (e) {
    this.log.error({err: e}, 'Problem getting auth header: ' + e.message);

    res.send(400, {error: e.message});
    next();
  }
};

module.exports = StashHandler;
