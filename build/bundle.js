module.exports =
/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};

/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {

/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;

/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			exports: {},
/******/ 			id: moduleId,
/******/ 			loaded: false
/******/ 		};

/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);

/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;

/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}


/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;

/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;

/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "/build/";

/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var Auth0 = __webpack_require__(1);
	var async = __webpack_require__(2);
	var moment = __webpack_require__(3);
	var useragent = __webpack_require__(4);
	var express = __webpack_require__(5);
	var Webtask = __webpack_require__(6);
	var app = express();
	var Mixpanel = __webpack_require__(7);
	var Request = __webpack_require__(12);
	var memoizer = __webpack_require__(13);
	var metadata = __webpack_require__(16);

	function lastLogCheckpoint(req, res) {
	  console.log('starting mixpanel-test');
	  var ctx = req.webtaskContext;
	  var required_settings = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'MIXPANEL_TOKEN', 'MIXPANEL_KEY'];
	  var missing_settings = required_settings.filter(function (setting) {
	    return !ctx.data[setting];
	  });

	  if (missing_settings.length) {
	    return res.status(400).send({ message: 'Missing settings: ' + missing_settings.join(', ') });
	  }

	  // If this is a scheduled task, we'll get the last log checkpoint from the previous run and continue from there.
	  req.webtaskContext.storage.get(function (err, data) {
	    var startCheckpointId = typeof data === 'undefined' && data.checkpointId ? null : data.checkpointId;

	    if (err) {
	      console.log('storage.get', err);
	    }

	    // Initialize both clients.
	    var auth0 = new Auth0.ManagementClient({
	      domain: ctx.data.AUTH0_DOMAIN,
	      token: req.access_token
	    });

	    // Create a new event logger
	    var Logger = Mixpanel.init(ctx.data.MIXPANEL_TOKEN, {
	      key: ctx.data.MIXPANEL_KEY
	    });

	    Logger.error = function (err, context) {
	      // Handle errors here
	      console.log("error", err, "context", context);
	    };

	    // Start the process.
	    async.waterfall([function (callback) {
	      var getLogs = function getLogs(context) {
	        console.log('Logs from: ' + (context.checkpointId || 'Start') + '.');
	        console.log('here');

	        var take = Number.parseInt(ctx.data.BATCH_SIZE);

	        take = take > 100 ? 100 : take;

	        context.logs = context.logs || [];

	        getLogsFromAuth0(req.webtaskContext.data.AUTH0_DOMAIN, req.access_token, take, context.checkpointId, function (logs, err) {
	          if (err) {
	            console.log('Error getting logs from Auth0', err);
	            return callback(err);
	          }

	          if (logs && logs.length) {
	            logs.forEach(function (l) {
	              return context.logs.push(l);
	            });
	            context.checkpointId = context.logs[context.logs.length - 1]._id;
	            // return setImmediate(() => getLogs(context));
	          }

	          console.log('Total logs: ' + context.logs.length + '.');
	          return callback(null, context);
	        });
	      };

	      getLogs({ checkpointId: startCheckpointId });
	    }, function (context, callback) {
	      var min_log_level = parseInt(ctx.data.LOG_LEVEL) || 0;
	      var log_matches_level = function log_matches_level(log) {
	        if (logTypes[log.type]) {
	          return logTypes[log.type].level >= min_log_level;
	        }
	        return true;
	      };

	      var types_filter = ctx.data.LOG_TYPES && ctx.data.LOG_TYPES.split(',') || [];
	      var log_matches_types = function log_matches_types(log) {
	        if (!types_filter || !types_filter.length) return true;
	        return log.type && types_filter.indexOf(log.type) >= 0;
	      };

	      context.logs = context.logs.filter(function (l) {
	        return l.type !== 'sapi' && l.type !== 'fapi';
	      }).filter(log_matches_level).filter(log_matches_types);

	      callback(null, context);
	    }, function (context, callback) {
	      console.log('Sending ' + context.logs.length);
	      if (context.logs.length > 0) {
	        (function () {
	          var now = Date.now();
	          var mixpanelEvents = context.logs.map(function (log) {
	            var eventName = logTypes[log.type].event;
	            // TODO - consider setting the time to date in the underlying log file?
	            // log.time = log.date;
	            log.time = now;
	            log.distinct_id = 'auth0-logs';
	            return {
	              event: eventName,
	              properties: log
	            };
	          });

	          // import all events at once
	          Logger.import_batch(mixpanelEvents, function (errorList) {
	            if (errorList && errorList.length > 0) {
	              console.log('Errors occurred sending logs to Mixpanel:', JSON.stringify(errorList));
	              return callback(err);
	            }
	            console.log('Upload complete.');
	            return callback(null, context);
	          });
	        })();
	      } else {
	        // no logs, just callback
	        console.log('No logs to upload - completed.');
	        return callback(null, context);
	      }
	    }], function (err, context) {
	      if (err) {
	        console.log('Job failed.', err);

	        return req.webtaskContext.storage.set({ checkpointId: startCheckpointId }, { force: 1 }, function (error) {
	          if (error) {
	            console.log('Error storing startCheckpoint', error);
	            return res.status(500).send({ error: error });
	          }

	          res.status(500).send({
	            error: err
	          });
	        });
	      }

	      console.log('Job complete.');

	      return req.webtaskContext.storage.set({
	        checkpointId: context.checkpointId,
	        totalLogsProcessed: context.logs.length
	      }, { force: 1 }, function (error) {
	        if (error) {
	          console.log('Error storing checkpoint', error);
	          return res.status(500).send({ error: error });
	        }

	        res.sendStatus(200);
	      });
	    });
	  });
	}

	var logTypes = {
	  's': {
	    event: 'Success Login',
	    level: 1 // Info
	  },
	  'seacft': {
	    event: 'Success Exchange',
	    level: 1 // Info
	  },
	  'feacft': {
	    event: 'Failed Exchange',
	    level: 3 // Error
	  },
	  'f': {
	    event: 'Failed Login',
	    level: 3 // Error
	  },
	  'w': {
	    event: 'Warnings During Login',
	    level: 2 // Warning
	  },
	  'du': {
	    event: 'Deleted User',
	    level: 1 // Info
	  },
	  'fu': {
	    event: 'Failed Login (invalid email/username)',
	    level: 3 // Error
	  },
	  'fp': {
	    event: 'Failed Login (wrong password)',
	    level: 3 // Error
	  },
	  'fc': {
	    event: 'Failed by Connector',
	    level: 3 // Error
	  },
	  'fco': {
	    event: 'Failed by CORS',
	    level: 3 // Error
	  },
	  'con': {
	    event: 'Connector Online',
	    level: 1 // Info
	  },
	  'coff': {
	    event: 'Connector Offline',
	    level: 3 // Error
	  },
	  'fcpro': {
	    event: 'Failed Connector Provisioning',
	    level: 4 // Critical
	  },
	  'ss': {
	    event: 'Success Signup',
	    level: 1 // Info
	  },
	  'fs': {
	    event: 'Failed Signup',
	    level: 3 // Error
	  },
	  'cs': {
	    event: 'Code Sent',
	    level: 0 // Debug
	  },
	  'cls': {
	    event: 'Code/Link Sent',
	    level: 0 // Debug
	  },
	  'sv': {
	    event: 'Success Verification Email',
	    level: 0 // Debug
	  },
	  'fv': {
	    event: 'Failed Verification Email',
	    level: 0 // Debug
	  },
	  'scp': {
	    event: 'Success Change Password',
	    level: 1 // Info
	  },
	  'fcp': {
	    event: 'Failed Change Password',
	    level: 3 // Error
	  },
	  'sce': {
	    event: 'Success Change Email',
	    level: 1 // Info
	  },
	  'fce': {
	    event: 'Failed Change Email',
	    level: 3 // Error
	  },
	  'scu': {
	    event: 'Success Change Username',
	    level: 1 // Info
	  },
	  'fcu': {
	    event: 'Failed Change Username',
	    level: 3 // Error
	  },
	  'scpn': {
	    event: 'Success Change Phone Number',
	    level: 1 // Info
	  },
	  'fcpn': {
	    event: 'Failed Change Phone Number',
	    level: 3 // Error
	  },
	  'svr': {
	    event: 'Success Verification Email Request',
	    level: 0 // Debug
	  },
	  'fvr': {
	    event: 'Failed Verification Email Request',
	    level: 3 // Error
	  },
	  'scpr': {
	    event: 'Success Change Password Request',
	    level: 0 // Debug
	  },
	  'fcpr': {
	    event: 'Failed Change Password Request',
	    level: 3 // Error
	  },
	  'fn': {
	    event: 'Failed Sending Notification',
	    level: 3 // Error
	  },
	  'sapi': {
	    event: 'API Operation'
	  },
	  'fapi': {
	    event: 'Failed API Operation'
	  },
	  'limit_wc': {
	    event: 'Blocked Account',
	    level: 4 // Critical
	  },
	  'limit_mu': {
	    event: 'Blocked IP Address',
	    level: 4 // Critical
	  },
	  'limit_ui': {
	    event: 'Too Many Calls to /userinfo',
	    level: 4 // Critical
	  },
	  'api_limit': {
	    event: 'Rate Limit On API',
	    level: 4 // Critical
	  },
	  'sdu': {
	    event: 'Successful User Deletion',
	    level: 1 // Info
	  },
	  'fdu': {
	    event: 'Failed User Deletion',
	    level: 3 // Error
	  },
	  'slo': {
	    event: 'Success Logout',
	    level: 1 // Info
	  },
	  'flo': {
	    event: 'Failed Logout',
	    level: 3 // Error
	  },
	  'sd': {
	    event: 'Success Delegation',
	    level: 1 // Info
	  },
	  'fd': {
	    event: 'Failed Delegation',
	    level: 3 // Error
	  }
	};

	function getLogsFromAuth0(domain, token, take, from, cb) {
	  var url = 'https://' + domain + '/api/v2/logs';

	  Request.get(url).set('Authorization', 'Bearer ' + token).set('Accept', 'application/json').query({ take: take }).query({ from: from }).query({ sort: 'date:1' }).query({ per_page: take }).end(function (err, res) {
	    if (err || !res.ok) {
	      console.log('Error getting logs', err);
	      cb(null, err);
	    } else {
	      console.log('x-ratelimit-limit: ', res.headers['x-ratelimit-limit']);
	      console.log('x-ratelimit-remaining: ', res.headers['x-ratelimit-remaining']);
	      console.log('x-ratelimit-reset: ', res.headers['x-ratelimit-reset']);
	      cb(res.body);
	    }
	  });
	}

	var getTokenCached = memoizer({
	  load: function load(apiUrl, audience, clientId, clientSecret, cb) {
	    Request.post(apiUrl).send({
	      audience: audience,
	      grant_type: 'client_credentials',
	      client_id: clientId,
	      client_secret: clientSecret
	    }).type('application/json').end(function (err, res) {
	      if (err || !res.ok) {
	        cb(null, err);
	      } else {
	        cb(res.body.access_token);
	      }
	    });
	  },
	  hash: function hash(apiUrl) {
	    return apiUrl;
	  },
	  max: 100,
	  maxAge: 1000 * 60 * 60
	});

	app.use(function (req, res, next) {
	  var apiUrl = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/oauth/token';
	  var audience = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/api/v2/';
	  var clientId = req.webtaskContext.data.AUTH0_CLIENT_ID;
	  var clientSecret = req.webtaskContext.data.AUTH0_CLIENT_SECRET;

	  getTokenCached(apiUrl, audience, clientId, clientSecret, function (access_token, err) {
	    if (err) {
	      console.log('Error getting access_token', err);
	      return next(err);
	    }

	    req.access_token = access_token;
	    next();
	  });
	});

	app.get('/', lastLogCheckpoint);
	app.post('/', lastLogCheckpoint);
	app.get('/meta', function (req, res) {
	  res.status(200).send(metadata);
	});

	module.exports = Webtask.fromExpress(app);

/***/ },
/* 1 */
/***/ function(module, exports) {

	module.exports = require("auth0@2.1.0");

/***/ },
/* 2 */
/***/ function(module, exports) {

	module.exports = require("async");

/***/ },
/* 3 */
/***/ function(module, exports) {

	module.exports = require("moment");

/***/ },
/* 4 */
/***/ function(module, exports) {

	module.exports = require("useragent");

/***/ },
/* 5 */
/***/ function(module, exports) {

	module.exports = require("express");

/***/ },
/* 6 */
/***/ function(module, exports) {

	module.exports = require("webtask-tools");

/***/ },
/* 7 */
/***/ function(module, exports, __webpack_require__) {

	/*
	    Heavily inspired by the original js library copyright Mixpanel, Inc.
	    (http://mixpanel.com/)

	    Copyright (c) 2012 Carl Sverre

	    Released under the MIT license.
	*/

	var http            = __webpack_require__(8),
	    querystring     = __webpack_require__(9),
	    Buffer          = __webpack_require__(10).Buffer,
	    util            = __webpack_require__(11);

	var create_client = function(token, config) {
	    var metrics = {};

	    if(!token) {
	        throw new Error("The Mixpanel Client needs a Mixpanel token: `init(token)`");
	    }

	    // Default config
	    metrics.config = {
	        test: false,
	        debug: false,
	        verbose: false,
	        host: 'api.mixpanel.com'
	    };

	    metrics.token = token;

	    /**
	        send_request(data)
	        ---
	        this function sends an async GET request to mixpanel

	        data:object                     the data to send in the request
	        callback:function(err:Error)    callback is called when the request is
	                                        finished or an error occurs
	    */
	    metrics.send_request = function(endpoint, data, callback) {
	        callback = callback || function() {};
	        var event_data = new Buffer(JSON.stringify(data));
	        var request_data = {
	            'data': event_data.toString('base64'),
	            'ip': 0,
	            'verbose': metrics.config.verbose ? 1 : 0
	        };

	        if (endpoint === '/import') {
	            var key = metrics.config.key;
	            if (!key) {
	                throw new Error("The Mixpanel Client needs a Mixpanel api key when importing old events: `init(token, { key: ... })`");
	            }
	            request_data.api_key = key;
	        }

	        var request_options = {
	            host: metrics.config.host,
	            port: metrics.config.port,
	            headers: {}
	        };

	        if (metrics.config.test) { request_data.test = 1; }

	        var query = querystring.stringify(request_data);

	        request_options.path = [endpoint,"?",query].join("");

	        http.get(request_options, function(res) {
	            var data = "";
	            res.on('data', function(chunk) {
	               data += chunk;
	            });

	            res.on('end', function() {
	                var e;
	                if (metrics.config.verbose) {
	                    try {
	                        var result = JSON.parse(data);
	                        if(result.status != 1) {
	                            e = new Error("Mixpanel Server Error: " + result.error);
	                        }
	                    }
	                    catch(ex) {
	                        e = new Error("Could not parse response from Mixpanel");
	                    }
	                }
	                else {
	                    e = (data !== '1') ? new Error("Mixpanel Server Error: " + data) : undefined;
	                }

	                callback(e);
	            });
	        }).on('error', function(e) {
	            if (metrics.config.debug) {
	                console.log("Got Error: " + e.message);
	            }
	            callback(e);
	        });
	    };

	    /**
	        track(event, properties, callback)
	        ---
	        this function sends an event to mixpanel.

	        event:string                    the event name
	        properties:object               additional event properties to send
	        callback:function(err:Error)    callback is called when the request is
	                                        finished or an error occurs
	    */
	    metrics.track = function(event, properties, callback) {
	        if (typeof(properties) === 'function' || !properties) {
	            callback = properties;
	            properties = {};
	        }

	        // if properties.time exists, use import endpoint
	        var endpoint = (typeof(properties.time) === 'number') ? '/import' : '/track';

	        properties.token = metrics.token;
	        properties.mp_lib = "node";

	        var data = {
	            'event' : event,
	            'properties' : properties
	        };

	        if (metrics.config.debug) {
	            console.log("Sending the following event to Mixpanel:");
	            console.log(data);
	        }

	        metrics.send_request(endpoint, data, callback);
	    };

	    var parse_time = function(time) {
	        if (time === void 0) {
	            throw new Error("Import methods require you to specify the time of the event");
	        } else if (Object.prototype.toString.call(time) === '[object Date]') {
	            time = Math.floor(time.getTime() / 1000);
	        }
	        return time;
	    };

	    /**
	        import(event, properties, callback)
	        ---
	        This function sends an event to mixpanel using the import
	        endpoint.  The time argument should be either a Date or Number,
	        and should signify the time the event occurred.

	        It is highly recommended that you specify the distinct_id
	        property for each event you import, otherwise the events will be
	        tied to the IP address of the sending machine.

	        For more information look at:
	        https://mixpanel.com/docs/api-documentation/importing-events-older-than-31-days

	        event:string                    the event name
	        time:date|number                the time of the event
	        properties:object               additional event properties to send
	        callback:function(err:Error)    callback is called when the request is
	                                        finished or an error occurs
	    */
	    metrics.import = function(event, time, properties, callback) {
	        if (typeof(properties) === 'function' || !properties) {
	            callback = properties;
	            properties = {};
	        }

	        properties.time = parse_time(time);

	        metrics.track(event, properties, callback);
	    };

	    /**
	        import_batch(event_list, options, callback)
	        ---
	        This function sends a list of events to mixpanel using the import
	        endpoint. The format of the event array should be:

	        [
	            {
	                "event": "event name",
	                "properties": {
	                    "time": new Date(), // Number or Date; required for each event
	                    "key": "val",
	                    ...
	                }
	            },
	            {
	                "event": "event name",
	                "properties": {
	                    "time": new Date()  // Number or Date; required for each event
	                }
	            },
	            ...
	        ]

	        See import() for further information about the import endpoint.

	        Options:
	            max_batch_size: the maximum number of events to be transmitted over
	                            the network simultaneously. useful for capping bandwidth
	                            usage.

	        N.B.: the Mixpanel API only accepts 50 events per request, so regardless
	        of max_batch_size, larger lists of events will be chunked further into
	        groups of 50.

	        event_list:array                    list of event names and properties
	        options:object                      optional batch configuration
	        callback:function(error_list:array) callback is called when the request is
	                                            finished or an error occurs
	    */
	    metrics.import_batch = function(event_list, options, callback) {
	        var batch_size = 50, // default: Mixpanel API permits 50 events per request
	            total_events = event_list.length,
	            max_simultaneous_events = total_events,
	            completed_events = 0,
	            event_group_idx = 0,
	            request_errors = [];

	        if (typeof(options) === 'function' || !options) {
	            callback = options;
	            options = {};
	        }
	        if (options.max_batch_size) {
	            max_simultaneous_events = options.max_batch_size;
	            if (options.max_batch_size < batch_size) {
	                batch_size = options.max_batch_size;
	            }
	        }

	        var send_next_batch = function() {
	            var properties,
	                event_batch = [];

	            // prepare batch with required props
	            for (var ei = event_group_idx; ei < total_events && ei < event_group_idx + batch_size; ei++) {
	                properties = event_list[ei].properties;
	                properties.time = parse_time(properties.time);
	                if (!properties.token) {
	                    properties.token = metrics.token;
	                }
	                event_batch.push(event_list[ei]);
	            }

	            if (event_batch.length > 0) {
	                metrics.send_request('/import', event_batch, function(e) {
	                    completed_events += event_batch.length;
	                    if (e) {
	                        request_errors.push(e);
	                    }
	                    if (completed_events < total_events) {
	                        send_next_batch();
	                    } else if (callback) {
	                        callback(request_errors);
	                    }
	                });
	                event_group_idx += batch_size;
	            }
	        };

	        if (metrics.config.debug) {
	            console.log(
	                "Sending " + event_list.length + " events to Mixpanel in " +
	                Math.ceil(total_events / batch_size) + " requests"
	            );
	        }

	        for (var i = 0; i < max_simultaneous_events; i += batch_size) {
	            send_next_batch();
	        }
	    };

	    /**
	        alias(distinct_id, alias)
	        ---
	        This function creates an alias for distinct_id

	        For more information look at:
	        https://mixpanel.com/docs/integration-libraries/using-mixpanel-alias

	        distinct_id:string              the current identifier
	        alias:string                    the future alias
	    */
	    metrics.alias = function(distinct_id, alias, callback) {
	        var properties = {
	            distinct_id: distinct_id,
	            alias: alias
	        };

	        metrics.track('$create_alias', properties, callback);
	    };

	    metrics.people = {
	        /** people.set_once(distinct_id, prop, to, modifiers, callback)
	            ---
	            The same as people.set but in the words of mixpanel:
	            mixpanel.people.set_once

	            " This method allows you to set a user attribute, only if
	             it is not currently set. It can be called multiple times
	             safely, so is perfect for storing things like the first date
	             you saw a user, or the referrer that brought them to your
	             website for the first time. "

	        */
	        set_once: function(distinct_id, prop, to, modifiers, callback) {
	            var $set = {};

	            if (typeof(prop) === 'object') {
	                if (typeof(to) === 'object') {
	                    callback = modifiers;
	                    modifiers = to;
	                } else {
	                    callback = to;
	                }
	                $set = prop;
	            } else {
	                $set[prop] = to;
	                if (typeof(modifiers) === 'function' || !modifiers) {
	                    callback = modifiers;
	                }
	            }

	            modifiers = modifiers || {};
	            modifiers.set_once = true;

	            this._set(distinct_id, $set, callback, modifiers);
	        },

	        /**
	            people.set(distinct_id, prop, to, modifiers, callback)
	            ---
	            set properties on an user record in engage

	            usage:

	                mixpanel.people.set('bob', 'gender', 'm');

	                mixpanel.people.set('joe', {
	                    'company': 'acme',
	                    'plan': 'premium'
	                });
	        */
	        set: function(distinct_id, prop, to, modifiers, callback) {
	            var $set = {};

	            if (typeof(prop) === 'object') {
	                if (typeof(to) === 'object') {
	                    callback = modifiers;
	                    modifiers = to;
	                } else {
	                    callback = to;
	                }
	                $set = prop;
	            } else {
	                $set[prop] = to;
	                if (typeof(modifiers) === 'function' || !modifiers) {
	                    callback = modifiers;
	                }
	            }

	            this._set(distinct_id, $set, callback, modifiers);
	        },

	        // used internally by set and set_once
	        _set: function(distinct_id, $set, callback, options) {
	            options = options || {};
	            var set_key = (options && options.set_once) ? "$set_once" : "$set";

	            var data = {
	                '$token': metrics.token,
	                '$distinct_id': distinct_id
	            };
	            data[set_key] = $set;

	            if ('ip' in $set) {
	                data.$ip = $set.ip;
	                delete $set.ip;
	            }

	            if ($set.$ignore_time) {
	                data.$ignore_time = $set.$ignore_time;
	                delete $set.$ignore_time;
	            }

	            data = merge_modifiers(data, options);

	            if (metrics.config.debug) {
	                console.log("Sending the following data to Mixpanel (Engage):");
	                console.log(data);
	            }

	            metrics.send_request('/engage', data, callback);
	        },

	        /**
	            people.increment(distinct_id, prop, by, modifiers, callback)
	            ---
	            increment/decrement properties on an user record in engage

	            usage:

	                mixpanel.people.increment('bob', 'page_views', 1);

	                // or, for convenience, if you're just incrementing a counter by 1, you can
	                // simply do
	                mixpanel.people.increment('bob', 'page_views');

	                // to decrement a counter, pass a negative number
	                mixpanel.people.increment('bob', 'credits_left', -1);

	                // like mixpanel.people.set(), you can increment multiple properties at once:
	                mixpanel.people.increment('bob', {
	                    counter1: 1,
	                    counter2: 3,
	                    counter3: -2
	                });
	        */
	        increment: function(distinct_id, prop, by, modifiers, callback) {
	            var $add = {};

	            if (typeof(prop) === 'object') {
	                if (typeof(by) === 'object') {
	                    callback = modifiers;
	                    modifiers = by;
	                } else {
	                    callback = by;
	                }
	                Object.keys(prop).forEach(function(key) {
	                    var val = prop[key];

	                    if (isNaN(parseFloat(val))) {
	                        if (metrics.config.debug) {
	                            console.error("Invalid increment value passed to mixpanel.people.increment - must be a number");
	                            console.error("Passed " + key + ":" + val);
	                        }
	                        return;
	                    } else {
	                        $add[key] = val;
	                    }
	                });
	            } else {
	                if (typeof(by) === 'number' || !by) {
	                    by = by || 1;
	                    $add[prop] = by;
	                    if (typeof(modifiers) === 'function') {
	                        callback = modifiers;
	                    }
	                } else if (typeof(by) === 'function') {
	                    callback = by;
	                    $add[prop] = 1;
	                } else {
	                    callback = modifiers;
	                    modifiers = (typeof(by) === 'object') ? by : {};
	                    $add[prop] = 1;
	                }
	            }

	            var data = {
	                '$add': $add,
	                '$token': metrics.token,
	                '$distinct_id': distinct_id
	            };

	            data = merge_modifiers(data, modifiers);

	            if (metrics.config.debug) {
	                console.log("Sending the following data to Mixpanel (Engage):");
	                console.log(data);
	            }

	            metrics.send_request('/engage', data, callback);
	        },

	        /**
	            people.append(distinct_id, prop, value, modifiers, callback)
	            ---
	            Append a value to a list-valued people analytics property.

	            usage:

	                // append a value to a list, creating it if needed
	                mixpanel.people.append('pages_visited', 'homepage');

	                // like mixpanel.people.set(), you can append multiple properties at once:
	                mixpanel.people.append({
	                    list1: 'bob',
	                    list2: 123
	                });
	        */
	        append: function(distinct_id, prop, value, modifiers, callback) {
	            var $append = {};

	            if (typeof(prop) === 'object') {
	                if (typeof(value) === 'object') {
	                    callback = modifiers;
	                    modifiers = value;
	                } else {
	                    callback = value;
	                }
	                Object.keys(prop).forEach(function(key) {
	                    $append[key] = prop[key];
	                });
	            } else {
	                $append[prop] = value;
	                if (typeof(modifiers) === 'function') {
	                    callback = modifiers;
	                }
	            }

	            var data = {
	                '$append': $append,
	                '$token': metrics.token,
	                '$distinct_id': distinct_id
	            };

	            data = merge_modifiers(data, modifiers);

	            if (metrics.config.debug) {
	                console.log("Sending the following data to Mixpanel (Engage):");
	                console.log(data);
	            }

	            metrics.send_request('/engage', data, callback);
	        },

	        /**
	            people.track_charge(distinct_id, amount, properties, modifiers, callback)
	            ---
	            Record that you have charged the current user a certain
	            amount of money.

	            usage:

	                // charge a user $29.99
	                mixpanel.people.track_charge('bob', 29.99);

	                // charge a user $19 on the 1st of february
	                mixpanel.people.track_charge('bob', 19, { '$time': new Date('feb 1 2012') });
	        */
	        track_charge: function(distinct_id, amount, properties, modifiers, callback) {
	            if (typeof(properties) === 'function' || !properties) {
	                callback = properties || function() {};
	                properties = {};
	            } else {
	                if (typeof(modifiers) === 'function' || !modifiers) {
	                    callback = modifiers || function() {};
	                    if (properties.$ignore_time || properties.hasOwnProperty("$ip")) {
	                        modifiers = {};
	                        Object.keys(properties).forEach(function(key) {
	                            modifiers[key] = properties[key];
	                            delete properties[key];
	                        });
	                    }
	                }
	            }

	            if (typeof(amount) !== 'number') {
	                amount = parseFloat(amount);
	                if (isNaN(amount)) {
	                    console.error("Invalid value passed to mixpanel.people.track_charge - must be a number");
	                    return;
	                }
	            }

	            properties.$amount = amount;

	            if (properties.hasOwnProperty('$time')) {
	                var time = properties.$time;
	                if (Object.prototype.toString.call(time) === '[object Date]') {
	                    properties.$time = time.toISOString();
	                }
	            }

	            var data = {
	                '$append': { '$transactions': properties },
	                '$token': metrics.token,
	                '$distinct_id': distinct_id
	            };

	            data = merge_modifiers(data, modifiers);

	            if (metrics.config.debug) {
	                console.log("Sending the following data to Mixpanel (Engage):");
	                console.log(data);
	            }

	            metrics.send_request('/engage', data, callback);
	        },

	        /**
	            people.clear_charges(distinct_id, modifiers, callback)
	            ---
	            Clear all the current user's transactions.

	            usage:

	                mixpanel.people.clear_charges('bob');
	        */
	        clear_charges: function(distinct_id, modifiers, callback) {
	            var data = {
	                '$set': { '$transactions': [] },
	                '$token': metrics.token,
	                '$distinct_id': distinct_id
	            };

	            if (typeof(modifiers) === 'function') { callback = modifiers; }

	            data = merge_modifiers(data, modifiers);

	            if (metrics.config.debug) {
	                console.log("Clearing this user's charges:", distinct_id);
	            }

	            metrics.send_request('/engage', data, callback);
	        },

	        /**
	            people.delete_user(distinct_id, modifiers, callback)
	            ---
	            delete an user record in engage

	            usage:

	                mixpanel.people.delete_user('bob');
	        */
	        delete_user: function(distinct_id, modifiers, callback) {
	            var data = {
	                '$delete': '',
	                '$token': metrics.token,
	                '$distinct_id': distinct_id
	            };

	            if (typeof(modifiers) === 'function') { callback = modifiers; }

	            data = merge_modifiers(data, modifiers);

	            if (metrics.config.debug) {
	                console.log("Deleting the user from engage:", distinct_id);
	            }

	            metrics.send_request('/engage', data, callback);
	        },

	        /**
	         people.union(distinct_id, data, modifiers, callback)
	         ---
	         merge value(s) into a list-valued people analytics property.

	         usage:

	            mixpanel.people.union('bob', {'browsers': 'firefox'});

	            mixpanel.people.union('bob', {'browsers', ['chrome'], os: ['linux']});
	         */
	        union: function(distinct_id, data, modifiers, callback) {
	            var $union = {};

	            if (typeof(data) !== 'object' || util.isArray(data)) {
	                if (metrics.config.debug) {
	                    console.error("Invalid value passed to mixpanel.people.union - data must be an object with array values");
	                }
	                return;
	            }

	            Object.keys(data).forEach(function(key) {
	                var val = data[key];
	                if (util.isArray(val)) {
	                    var merge_values = val.filter(function(v) {
	                        return typeof(v) === 'string' || typeof(v) === 'number';
	                    });
	                    if (merge_values.length > 0) {
	                        $union[key] = merge_values;
	                    }
	                } else if (typeof(val) === 'string' || typeof(val) === 'number') {
	                    $union[key] = [val];
	                } else {
	                    if (metrics.config.debug) {
	                        console.error("Invalid argument passed to mixpanel.people.union - values must be a scalar value or array");
	                        console.error("Passed " + key + ':', val);
	                    }
	                    return;
	                }
	            });

	            if (Object.keys($union).length === 0) {
	                return;
	            }

	            data = {
	                '$union': $union,
	                '$token': metrics.token,
	                '$distinct_id': distinct_id
	            };

	            if (typeof(modifiers) === 'function') {
	                callback = modifiers;
	            }

	            data = merge_modifiers(data, modifiers);

	            if (metrics.config.debug) {
	                console.log("Sending the following data to Mixpanel (Engage):");
	                console.log(data);
	            }

	            metrics.send_request('/engage', data, callback);
	        },

	        /**
	         people.unset(distinct_id, prop, modifiers, callback)
	         ---
	         delete a property on an user record in engage

	         usage:

	            mixpanel.people.unset('bob', 'page_views');

	            mixpanel.people.unset('bob', ['page_views', 'last_login']);
	         */
	        unset: function(distinct_id, prop, modifiers, callback) {
	            var $unset = [];

	            if (util.isArray(prop)) {
	                $unset = prop;
	            } else if (typeof(prop) === 'string') {
	                $unset = [prop];
	            } else {
	                if (metrics.config.debug) {
	                    console.error("Invalid argument passed to mixpanel.people.unset - must be a string or array");
	                    console.error("Passed: " + prop);
	                }
	                return;
	            }

	            var data = {
	                '$unset': $unset,
	                '$token': metrics.token,
	                '$distinct_id': distinct_id
	            };

	            if (typeof(modifiers) === 'function') {
	                callback = modifiers;
	            }

	            data = merge_modifiers(data, modifiers);

	            if (metrics.config.debug) {
	                console.log("Sending the following data to Mixpanel (Engage):");
	                console.log(data);
	            }

	            metrics.send_request('/engage', data, callback);
	        }
	    };

	    var merge_modifiers = function(data, modifiers) {
	        if (modifiers) {
	            if (modifiers.$ignore_time) {
	                data.$ignore_time = modifiers.$ignore_time;
	            }
	            if (modifiers.hasOwnProperty("$ip")) {
	                data.$ip = modifiers.$ip;
	            }
	            if (modifiers.hasOwnProperty("$time")) {
	                data.$time = parse_time(modifiers.$time);
	            }
	        }
	        return data;
	    };

	    /**
	        set_config(config)
	        ---
	        Modifies the mixpanel config

	        config:object       an object with properties to override in the
	                            mixpanel client config
	    */
	    metrics.set_config = function(config) {
	        for (var c in config) {
	            if (config.hasOwnProperty(c)) {
	                if (c == "host") { // Split host, into host and port.
	                    metrics.config.host = config[c].split(':')[0];
	                    var port = config[c].split(':')[1];
	                    if (port) {
	                        metrics.config.port = Number(port);
	                    }
	                } else {
	                    metrics.config[c] = config[c];
	                }
	            }
	        }
	    };

	    if (config) {
	        metrics.set_config(config);
	    }

	    return metrics;
	};

	// module exporting
	module.exports = {
	    Client: function(token) {
	        console.warn("The function `Client(token)` is deprecated.  It is now called `init(token)`.");
	        return create_client(token);
	    },
	    init: create_client
	};


/***/ },
/* 8 */
/***/ function(module, exports) {

	module.exports = require("http");

/***/ },
/* 9 */
/***/ function(module, exports) {

	module.exports = require("querystring");

/***/ },
/* 10 */
/***/ function(module, exports) {

	module.exports = require("buffer");

/***/ },
/* 11 */
/***/ function(module, exports) {

	module.exports = require("util");

/***/ },
/* 12 */
/***/ function(module, exports) {

	module.exports = require("superagent");

/***/ },
/* 13 */
/***/ function(module, exports, __webpack_require__) {

	const LRU        = __webpack_require__(14);
	const _          = __webpack_require__(15);
	const lru_params = [ 'max', 'maxAge', 'length', 'dispose', 'stale' ];

	module.exports = function (options) {
	  const cache   = new LRU(_.pick(options, lru_params));
	  const load    = options.load;
	  const hash    = options.hash;
	  const bypass  = options.bypass;
	  const loading  = new Map();

	  if (options.disable) {
	    return load;
	  }

	  const result = function () {
	    const args       = _.toArray(arguments);
	    const parameters = args.slice(0, -1);
	    const callback   = args.slice(-1).pop();
	    const self       = this;

	    var key;

	    if (bypass && bypass.apply(self, parameters)) {
	      return load.apply(self, args);
	    }

	    if (parameters.length === 0 && !hash) {
	      //the load function only receives callback.
	      key = '_';
	    } else {
	      key = hash.apply(self, parameters);
	    }

	    var fromCache = cache.get(key);

	    if (fromCache) {
	      return callback.apply(null, [null].concat(fromCache));
	    }

	    if (!loading.get(key)) {
	      loading.set(key, []);

	      load.apply(self, parameters.concat(function (err) {
	        const args = _.toArray(arguments);

	        //we store the result only if the load didn't fail.
	        if (!err) {
	          cache.set(key, args.slice(1));
	        }

	        //immediately call every other callback waiting
	        loading.get(key).forEach(function (callback) {
	          callback.apply(null, args);
	        });

	        loading.delete(key);
	        /////////

	        callback.apply(null, args);
	      }));
	    } else {
	      loading.get(key).push(callback);
	    }
	  };

	  result.keys = cache.keys.bind(cache);

	  return result;
	};


	module.exports.sync = function (options) {
	  const cache = new LRU(_.pick(options, lru_params));
	  const load = options.load;
	  const hash = options.hash;
	  const disable = options.disable;
	  const bypass = options.bypass;
	  const self = this;

	  if (disable) {
	    return load;
	  }

	  const result = function () {
	    var args = _.toArray(arguments);

	    if (bypass && bypass.apply(self, arguments)) {
	      return load.apply(self, arguments);
	    }

	    var key = hash.apply(self, args);

	    var fromCache = cache.get(key);

	    if (fromCache) {
	      return fromCache;
	    }

	    var result = load.apply(self, args);

	    cache.set(key, result);

	    return result;
	  };

	  result.keys = cache.keys.bind(cache);

	  return result;
	};


/***/ },
/* 14 */
/***/ function(module, exports) {

	module.exports = require("lru-cache");

/***/ },
/* 15 */
/***/ function(module, exports) {

	module.exports = require("lodash");

/***/ },
/* 16 */
/***/ function(module, exports) {

	module.exports = {
		"title": "xAuth0 Logs to Mixpanel",
		"name": "xauth0-logs-to-mixpanel",
		"version": "1.3.2",
		"author": "auth0",
		"description": "This extension will take all of your Auth0 logs and export them to Mixpanel",
		"type": "cron",
		"repository": "https://github.com/auth0/auth0-logs-to-mixpanel",
		"keywords": [
			"auth0",
			"extension"
		],
		"schedule": "0 */5 * * * *",
		"auth0": {
			"scopes": "read:logs"
		},
		"secrets": {
			"MIXPANEL_TOKEN": {
				"description": "Mixpanel Token - this is your Mixpanel Token for your mixpanel project",
				"required": true
			},
			"MIXPANEL_KEY": {
				"description": "Mixpanel Key - this is your Mixpanel Key for your mixpanel project",
				"required": true,
				"type": "password"
			},
			"BATCH_SIZE": {
				"description": "The ammount of logs to be read on each execution. Maximun is 100.",
				"default": 100
			},
			"LOG_LEVEL": {
				"description": "This allows you to specify the log level of events that need to be sent",
				"type": "select",
				"allowMultiple": true,
				"options": [
					{
						"value": "-",
						"text": ""
					},
					{
						"value": "0",
						"text": "Debug"
					},
					{
						"value": "1",
						"text": "Info"
					},
					{
						"value": "2",
						"text": "Warning"
					},
					{
						"value": "3",
						"text": "Error"
					},
					{
						"value": "4",
						"text": "Critical"
					}
				]
			},
			"LOG_TYPES": {
				"description": "If you only want to send events with a specific type (eg: failed logins)",
				"type": "select",
				"allowMultiple": true,
				"options": [
					{
						"value": "-",
						"text": ""
					},
					{
						"value": "s",
						"text": "Success Login (Info)"
					},
					{
						"value": "seacft",
						"text": "Success Exchange (Info)"
					},
					{
						"value": "feacft",
						"text": "Failed Exchange (Error)"
					},
					{
						"value": "f",
						"text": "Failed Login (Error)"
					},
					{
						"value": "w",
						"text": "Warnings During Login (Warning)"
					},
					{
						"value": "du",
						"text": "Deleted User (Info)"
					},
					{
						"value": "fu",
						"text": "Failed Login (invalid email/username) (Error)"
					},
					{
						"value": "fp",
						"text": "Failed Login (wrong password) (Error)"
					},
					{
						"value": "fc",
						"text": "Failed by Connector (Error)"
					},
					{
						"value": "fco",
						"text": "Failed by CORS (Error)"
					},
					{
						"value": "con",
						"text": "Connector Online (Info)"
					},
					{
						"value": "coff",
						"text": "Connector Offline (Error)"
					},
					{
						"value": "fcpro",
						"text": "Failed Connector Provisioning (Critical)"
					},
					{
						"value": "ss",
						"text": "Success Signup (Info)"
					},
					{
						"value": "fs",
						"text": "Failed Signup (Error)"
					},
					{
						"value": "cs",
						"text": "Code Sent (Debug)"
					},
					{
						"value": "cls",
						"text": "Code/Link Sent (Debug)"
					},
					{
						"value": "sv",
						"text": "Success Verification Email (Debug)"
					},
					{
						"value": "fv",
						"text": "Failed Verification Email (Debug)"
					},
					{
						"value": "scp",
						"text": "Success Change Password (Info)"
					},
					{
						"value": "fcp",
						"text": "Failed Change Password (Error)"
					},
					{
						"value": "sce",
						"text": "Success Change Email (Info)"
					},
					{
						"value": "fce",
						"text": "Failed Change Email (Error)"
					},
					{
						"value": "scu",
						"text": "Success Change Username (Info)"
					},
					{
						"value": "fcu",
						"text": "Failed Change Username (Error)"
					},
					{
						"value": "scpn",
						"text": "Success Change Phone Number (Info)"
					},
					{
						"value": "fcpn",
						"text": "Failed Change Phone Number (Error)"
					},
					{
						"value": "svr",
						"text": "Success Verification Email Request (Debug)"
					},
					{
						"value": "fvr",
						"text": "Failed Verification Email Request (Error)"
					},
					{
						"value": "scpr",
						"text": "Success Change Password Request (Debug)"
					},
					{
						"value": "fcpr",
						"text": "Failed Change Password Request (Error)"
					},
					{
						"value": "fn",
						"text": "Failed Sending Notification (Error)"
					},
					{
						"value": "limit_wc",
						"text": "Blocked Account (Critical)"
					},
					{
						"value": "limit_mu",
						"text": "Blocked IP Address (Critical)"
					},
					{
						"value": "limit_ui",
						"text": "Too Many Calls to /userinfo (Critical)"
					},
					{
						"value": "api_limit",
						"text": "Rate Limit On API (Critical)"
					},
					{
						"value": "sdu",
						"text": "Successful User Deletion (Info)"
					},
					{
						"value": "fdu",
						"text": "Failed User Deletion (Error)"
					},
					{
						"value": "slo",
						"text": "Success Logout (Info)"
					},
					{
						"value": "flo",
						"text": "Failed Logout (Error)"
					},
					{
						"value": "sd",
						"text": "Success Delegation (Info)"
					},
					{
						"value": "fd",
						"text": "Failed Delegation (Error)"
					}
				]
			}
		}
	};

/***/ }
/******/ ]);