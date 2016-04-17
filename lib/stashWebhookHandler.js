'use strict';

var EventEmitter = require('events').EventEmitter;

module.exports = function(options) {
  // make it an EventEmitter, sort of
  Object.setPrototypeOf(handler, EventEmitter.prototype);
  EventEmitter.call(handler);

  return handler;

  function handler(req, res, cb) {
    var payload = req.body;

    /*
     * There are several Stash event types:
     *  UPDATE
     */
    var eventType = payload.refChanges[0].type;

    var emitData = {
      event: eventType,
      payload: payload,
      host: req.headers.host,
      url: req.url,
    };

    handler.emit(eventType, emitData);

    res.json({ok: true});

    cb();
  }
};
