var path = require('path')
  ,http = require('http')
  ,restify = require('restify')
  ,bunyan = require('bunyan')
  ,yaml = require('js-yaml')
;

var createWebhookHandler = require('./stashWebhookHandler');

var API = require('./api');
var CMAPI = require('./cm_api');


var StashHandler = function(options) {

  this.options = options;

  // Bind functions to ensure `this` works for use in callbacks.
  this.start = this.start.bind(this);
  this.fetchProboYamlConfigFromStash = this.fetchProboYamlConfigFromStash.bind(this);
  this.errorHandler = this.errorHandler.bind(this);
  this.pushHandler = this.pushHandler.bind(this);
  this.getStashApi = this.getStashApi.bind(this);

  // Instantiate a logger instance.
  var log  = bunyan.createLogger({name: 'stash-handler',
                                  level: options.log_level || 'debug',
                                  // src: true,
                                  serializers: {
                                    err: bunyan.stdSerializers.err
                                  }});
  var handler_options = {
    path: options.stashWebhookPath,
    secret: options.stashWebhookSecret
  };

  var handler = createWebhookHandler(handler_options);
  handler.on('error', this.errorHandler);
  // handler.on('pull_request', this.pullRequestHandler);
  handler.on('push', this.pushHandler);

  var self = this;

  this.server = options.server || restify.createServer({log: log, name: "Probo Stash"});
  this.server.use(restify.bodyParser());
  this.server.on('after', restify.auditLogger({
    log: log
  }));

  this.server.on('uncaughtException', function (request, response, route, error) {
    self.server.log.error({err: error, route: route}, "Uncaught Exception");
    response.send(error);
  });


  this.server.post(handler_options.path, function(req, res, next){
    handler(req, res, function(error) {
      if(error){
        res.send(400, 'Error processing hook');
        log.error({ err: error }, 'Error processing hook');
      }

      next();
    });
  });

  var build_status_controller = function(req, res, next){
    var payload = req.body;

    if(req.params.context){
      // usually, context will already be part of update, but read it from URL
      // if it's there for compatability
      payload.update.context = req.params.context;
    }

    log.debug({payload: payload}, "Update payload");

    self.buildStatusUpdateHandler(payload.update, payload.build, function(err, status){
      if(err){
        res.send(500, {error: err});
      } else {
        res.send(status);
      }
      return next();
    });
  };

  this.server.post('/builds/:bid/status/:context', restify.jsonBodyParser(), build_status_controller)
  this.server.post("/update", restify.jsonBodyParser(), build_status_controller);

  this.log = log;

  if(this.options.api.token){
    this.api = new API({
      url: this.options.api.url,
      token: this.options.api.token,
      log: this.log
    })
  } else {
    // use container manager directly
    log.info("api.token not found, using Container Manager API directly");
    this.api = new CMAPI({
      url: this.options.api.url,
      log: this.log,
      handler: this
    })
  }
};

/**
 * Starts the server listening on the configured port.
 */
StashHandler.prototype.start = function(cb) {
  var self = this;
  this.server.listen({port: self.options.port, host: self.options.hostname || '0.0.0.0'}, function() {
    self.log.info('Now listening on', self.server.url);
    cb && cb();
  });
};

StashHandler.prototype.stop = function(cb) {
  var self = this;
  var url = this.server.url;
  this.server.close(function() {
    self.log.info('Stopped', url);
    cb && cb();
  });
};

/**
 * Build options for Stash api HTTP requests.
 */
StashHandler.prototype.getStashApi = function(project) {
  var stash = new StashApi({
    // required
    version: "3.0.0",
    // optional
    debug: true,
    protocol: "https",
    // host: "github.my-GHE-enabled-company.com",
    // pathPrefix: "/api/v3", // for some GHEs
    timeout: 5000,
    headers: {
      "user-agent": "Probo" // GitHub is happy with a unique user agent
    }
  });

  var auth = {type: 'token', token: this.options.stashAPIToken};
  if(project.service_auth){
    auth = {type: 'oauth', token: project.service_auth.token};
  }
  stash.authenticate(auth);

  return stash;
}

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
  this.log.info({event: event}, 'Stash push received');
  return cb && cb(null, {
    id: "build1",
    projectId: "1234",
    sha: "383e221f3f407055bd252c774df4ecdc1a04ed6e",
    project: {
      id: "1234",
      owner: "TEST",
      repo: "testrepo",
      service: "stash",
      slug: "TEST/testrepo"
    }
  });


  // enqueue the event to be processed...
  var self = this;

  this.log.info('Stash Pull request ' + event.payload.pull_request.id + ' received');

  var request = {
    type: 'pull_request', // also in event.event
    service: 'stash',
    host: undefined,
    slug: event.payload.repository.full_name,
    owner: event.payload.repository.owner.login,
    repo: event.payload.repository.name,
    sha: event.payload.pull_request.head.sha,
    payload: event.payload,
    id: event.payload.pull_request.id
  }

  /**
   * build comes back with an embedded .project
   * not necessary to do anything here, build status updates will come asyncronously
   */
  this.processRequest(request, function(error, build){
    self.log.info({type: request.type, slug: request.slug, err: error}, "request processed");
    cb && cb(error, build);
  });
}

/**
 * Called when an build status updates
 *
 * update = {
 *  state: "status of build",
 *  description: "",
 *  context: "the context",
 *  target_url: ""
 * }
 *
 * build has an embedded .project too
 */
StashHandler.prototype.buildStatusUpdateHandler = function(update, build, cb){
  var self = this;
  self.log.info({update: update, build_id: build.id}, "Got build status update");

  var statusInfo = {
    state: update.state,  // can be one of pending, success, error, or failure.
    description: update.description,
    context: update.context,
    target_url: update.target_url
  }

  self.postStatusToStash(build.project, build.ref, statusInfo, function(error){
    if (error) {
      self.log.error({ err: error, build_id: build.id }, 'An error occurred posting status to Stash');
      return cb(error, statusInfo);
    }

    self.log.info(statusInfo, 'Posted status to Stash for', build.project.slug, build.ref);
    cb(null, statusInfo);
  });
}

/**
 * request: {type, service, slug, event}
 */
StashHandler.prototype.processRequest = function(request, cb){
  var self = this;
  self.log.info({type: request.type, id: request.id}, 'Processing request');

  this.api.findProjectByRepo(request, function(error, project){
    if(error || !project){
      return self.log.info(
        {err: error},
        "Project for stash repo " + request.slug + " not found"
      );
    }

    self.log.info({project: project}, "Found project for PR");

    self.fetchProboYamlConfigFromStash(project, request.sha, function(error, config) {
      self.log.info({err: error, config: config}, "Probo Yaml Config file");

      if(error){
        return;
      }

      var build = {
        ref: request.sha,
        config: config,
        request: request
      };

      self.api.submitBuild(build, project, function(err, build){
        if(err){
          // TODO: save the PR if submitting it fails (though logging it here might be ok)
          self.log.error({err: err, request: request, build: build}, "Problem submitting build");
          return cb && cb(err);
        }

        self.log.info({build: build}, "Submitted build");

        self.log.info("Updating build statuses...");

        self.api.setBuildStatus(build, "ci/tests", {
          state: "pending", description: "Waiting on environment " + new Date()
        });
        self.api.setBuildStatus(build, "ci/env", {
          state: "pending", description: "Building environment " + new Date()
        }, function _(){
          // running tests now
          setTimeout(function(){
            self.api.setBuildStatus(build, "ci/env", {
              state: "success", description: "Environment built " + new Date()
            });

            self.api.setBuildStatus(build, "ci/tests", {
              state: "pending", description: "Running tests " + new Date()
            }, function response(error, status){

              setTimeout(function(){
                self.api.setBuildStatus(build, "ci/tests", {
                  state: "success", description: "Tests passed " + new Date()
                }, function _(){

                });
              }, 2000);
            });
          }, 2000);

          self.log.debug("returning from initial HTTP call")
          cb(null, build);
        });
      });

    });
  });
};

/**
 * Posts status updates to Stash.
 *
 * statusInfo should be the status message to post to GH - see https://developer.stash.com/v3/repos/statuses/
 */
StashHandler.prototype.postStatusToStash = function(project, sha, statusInfo, done) {
  var self = this;
  var stash = self.getStashApi(project);

  statusInfo.user = project.owner;
  statusInfo.repo = project.repo;
  statusInfo.sha = sha;

  stash.statuses.create(statusInfo, function(error, body){
    done(error, body);
  })
}

/**
 * Fetches configuration from a .probo.yml file in the stash repo.
 */
StashHandler.prototype.fetchProboYamlConfigFromStash = function(project, sha, done) {
  var self = this;
  var path = '/contents?ref=' + sha;
  var stash = this.getStashApi(project);

  stash.repos.getContent({user: project.owner, repo: project.repo, ref: sha, path: ''}, function(error, files){
    if (error) return done(error)

    var i = null;
    var regex = /^(.?probo.ya?ml|.?proviso.ya?ml)$/;
    var match = false;
    var file;
    for (i in files) {
      file = files[i];
      if (regex.test(file.name)) {
        match = true;
        break;
      }
    }
    if (!match) {
      // Should this be an error or just an empty config?
      return done(new Error('No .probo.yml file was found.'));
    }

    stash.repos.getContent({user: project.owner, repo: project.repo, ref: sha, path: file.path}, function(error, file){
      if (error) {
        self.log.error({error: error}, "Failed to get probo config file contents");

        return done(error);
      }

      var content = new Buffer(file.content, 'base64');
      var settings = yaml.safeLoad(content.toString('utf8'));

      done(null, settings);
    });
  });
};

module.exports = StashHandler;
