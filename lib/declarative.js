/*jslint node:true, nomen:true */
const fs = require('fs'),
  vm = require('vm'),
  _ = require('lodash'),
  async = require('async'),
  errors = require('./errors'),
  sender = require('./sender'),
  constants = require('./constants').get(),
  paramProc = require('./param'),
  csauth = constants.header.AUTH,
  /*
   * pathRegexp from expressjs https://github.com/visionmedia/express/blob/master/lib/utils.js and modified per our needs
   * expressjs was released under MIT license as of this writing
   * https://github.com/visionmedia/express/blob/9914a1eb3f7bbe01e3783fa70cb78e02570d7336/LICENSE
   */
  pathRegexp = (path, keys, sensitive, strict) => {
    if (path && path.toString() === '[object RegExp]') {
      return path;
    }
    if (Array.isArray(path)) {
      path = '(' + path.join('|') + ')';
    }
    path = path.concat(strict ? '' : '/?').replace(/\/\(/g, '(?:/').replace(/(\/)?(\.)?:(\w+)(?:(\(.*?\)))?(\?)?(\*)?/g, function (_, slash, format, key, capture, optional, star) {
      keys.push({
        name: key,
        optional: !! optional
      });
      slash = slash || '';
      return String(
        (optional ? '' : slash) + '(?:' + (optional ? slash : '') + (format || '') + (capture || ((format && '([^/.]+?)') || '([^/]+?)')) + ')' + (optional || '') + (star ? '(/*)?' : ''));
    }).replace(/([\/.])/g, '\\$1').replace(/\*/g, '(.*)');
    return new RegExp('^' + path + '$', sensitive ? '' : 'i');
  },
  pathToFormat = (path,format) => (!format || path.match(/(\/|\.\:\w+\?)$/)) ? path : path + ".:format?";

let globalLoader;

module.exports = {
  init: (config) => {
    globalLoader = (config || {}).loader;
  },
  loadFile: (cfile,options) => {
    options = options || {};
    const routes = {}, localLoader = options.loader || {},
      // source the config file
      /*jslint stupid:true */
      data = JSON.parse( fs.readFileSync(cfile, "utf8") ) || {};
      /*jslint stupid:false */

    // do we have rules?
    /* each rule is
     * [verb,path,[param,][loggedIn,][loader,]condition]
     * [string,string,[object,][boolean,][string,]string]
     */
    for (let rule of data.routes || []) {
      rule = rule || [];
      if (typeof (rule[2]) !== "object") {
        rule.splice(2, 0, null);
      }
      if (typeof (rule[3]) !== "boolean") {
        rule.splice(3, 0, false);
      }
      if (rule.length < 6) {
        rule.splice(4, 0, null);
      }

      const keys = [],
        verb = rule[0].toLowerCase(),
        fpath = pathToFormat(rule[1],options.format),
        re = pathRegexp(fpath,keys),
        entry = {
          verb: verb,
          url: rule[1],
          param: rule[2],
          loggedIn: rule[3],
          loader: rule[4],
          condition: rule[5],
          re: re,
          keys: keys
        };
      routes[verb] = routes[verb] || [];
      routes[verb].push(entry);
    }
    return (req, res, next) => {
      // authenticated: false = was not logged in and needed to be, send a 401, else check authorized
      // authorized: false = send a 403, else next()
      const user = req[csauth], oldParams = req.params;

      // make sure there is req.param()
      paramProc(req);

      // first check verb, then check route regexp match, then check params
      async.each(routes[req.method.toLowerCase()] || [], (entry, callback) => {
        let useRule = false;
        const path = typeof(req.path) === "function" ? req.path() : req.path,
          checkCondition = (condition, req, user, item) => {
            var authorized;
            try {
              authorized = vm.runInNewContext(condition, {
                req: req,
                request: req,
                user: user,
                _: _,
                item: item
              });
            } catch (e) {
              authorized = false;
            }
            return (authorized);
          },
          // path match check
          match = (path || "").match(entry.re);

        if (match) {
          useRule = true;

          // create the important parameters
          req.params = (entry.keys||[]).reduce((result,val,i) => {
            result[val.name] = match[i+1];
            return result;
          },{});

          // next check if we use param - will be false unless no param, or param is match
          if (entry.param) {
            useRule = false;
            for (let key of Object.keys(entry.param)) {
              const val = entry.param[key];
              if (val !== null && val !== undefined && req.param(key) == val) {
                useRule = true;
                break;
              }
            }

          }
          if (useRule) {
            // did we match the verb+path+param?
            // first check the authentication
            // authenticated = !entry.loggedIn || !!req[csauth];
            if (entry.loggedIn && !req[csauth]) {
              callback(401, errors.unauthenticated());
            } else {
              // next check for the loader
              if (entry.loader) {
                try {
                  req.cansecurity = req.cansecurity || {};
                  const loader = localLoader[entry.loader] || globalLoader[entry.loader];
                  loader(req, res, function (err) {
                    if (err) {
                      next(err);
                    } else if (checkCondition(entry.condition, req, user, (req.cansecurity || {}).item)){
                      callback();
                    } else {
                      callback(403, errors.unauthorized());
                    }
                  });
                } catch (err) {
                  callback(500, errors.uninitialized());
                }
              } else if (checkCondition(entry.condition, req, user)) {
                callback();
              } else {
                callback(403, errors.unauthorized());
              }
            }
          } else {
            callback();
          }
        } else {
          callback();
        }
      }, (err,msg) => {
        // now reset req.params
        req.params = oldParams;
        if (err) {
          sender(res,err,msg);
        } else {
          next();
        }
      });
    };
  }
};
