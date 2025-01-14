'use strict';

var _ = require('lodash');
var os = require('os');
var cp = require('child_process');
var path = require('path');
var Promise = require('bluebird');
var debug = require('debug')('cypress:cli');
var debugElectron = require('debug')('cypress:electron');

var util = require('../util');
var state = require('../tasks/state');
var xvfb = require('./xvfb');

var _require = require('../errors'),
    throwFormErrorText = _require.throwFormErrorText,
    errors = _require.errors;

var isXlibOrLibudevRe = /^(?:Xlib|libudev)/;
var isHighSierraWarningRe = /\*\*\* WARNING/;
var isRenderWorkerRe = /\.RenderWorker-/;

var GARBAGE_WARNINGS = [isXlibOrLibudevRe, isHighSierraWarningRe, isRenderWorkerRe];

var isGarbageLineWarning = function isGarbageLineWarning(str) {
  return _.some(GARBAGE_WARNINGS, function (re) {
    return re.test(str);
  });
};

function isPlatform(platform) {
  return os.platform() === platform;
}

function needsStderrPiped(needsXvfb) {
  return _.some([isPlatform('darwin'), needsXvfb && isPlatform('linux'), util.isPossibleLinuxWithIncorrectDisplay()]);
}

function needsEverythingPipedDirectly() {
  return isPlatform('win32');
}

function getStdio(needsXvfb) {
  if (needsEverythingPipedDirectly()) {
    return 'pipe';
  }

  // https://github.com/cypress-io/cypress/issues/921
  // https://github.com/cypress-io/cypress/issues/1143
  // https://github.com/cypress-io/cypress/issues/1745
  if (needsStderrPiped(needsXvfb)) {
    // returning pipe here so we can massage stderr
    // and remove garbage from Xlib and libuv
    // due to starting the Xvfb process on linux
    return ['inherit', 'inherit', 'pipe'];
  }

  return 'inherit';
}

module.exports = {
  isGarbageLineWarning: isGarbageLineWarning,

  start: function start(args) {
    var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

    var needsXvfb = xvfb.isNeeded();
    var executable = state.getPathToExecutable(state.getBinaryDir());

    if (util.getEnv('CYPRESS_RUN_BINARY')) {
      executable = path.resolve(util.getEnv('CYPRESS_RUN_BINARY'));
    }

    debug('needs to start own Xvfb?', needsXvfb);

    // always push cwd into the args
    // which additionally acts as a signal to the
    // binary that it was invoked through the NPM module
    args = [].concat(args, '--cwd', process.cwd());

    _.defaults(options, {
      dev: false,
      env: process.env,
      detached: false,
      stdio: getStdio(needsXvfb)
    });

    var spawn = function spawn() {
      var overrides = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

      return new Promise(function (resolve, reject) {
        _.defaults(overrides, {
          onStderrData: false,
          electronLogging: false
        });

        if (options.dev) {
          // if we're in dev then reset
          // the launch cmd to be 'npm run dev'
          executable = 'node';
          args.unshift(path.resolve(__dirname, '..', '..', '..', 'scripts', 'start.js'));
        }

        var onStderrData = overrides.onStderrData,
            electronLogging = overrides.electronLogging;

        var envOverrides = util.getEnvOverrides();
        var electronArgs = _.clone(args);
        var node11WindowsFix = isPlatform('win32');

        // strip dev out of child process options
        var stdioOptions = _.pick(options, 'env', 'detached', 'stdio');

        // figure out if we're going to be force enabling or disabling colors.
        // also figure out whether we should force stdout and stderr into thinking
        // it is a tty as opposed to a pipe.
        stdioOptions.env = _.extend({}, stdioOptions.env, envOverrides);

        if (node11WindowsFix) {
          stdioOptions = _.extend({}, stdioOptions, { windowsHide: false });
        }

        if (electronLogging) {
          stdioOptions.env.ELECTRON_ENABLE_LOGGING = true;
        }

        if (util.isPossibleLinuxWithIncorrectDisplay()) {
          // make sure we use the latest DISPLAY variable if any
          debug('passing DISPLAY', process.env.DISPLAY);
          stdioOptions.env.DISPLAY = process.env.DISPLAY;
        }

        debug('spawning Cypress with executable: %s', executable);
        debug('spawn args %o %o', electronArgs, _.omit(stdioOptions, 'env'));

        var child = cp.spawn(executable, electronArgs, stdioOptions);

        child.on('close', resolve);
        child.on('error', reject);

        child.stdin && child.stdin.pipe(process.stdin);
        child.stdout && child.stdout.pipe(process.stdout);

        // if this is defined then we are manually piping for linux
        // to filter out the garbage
        child.stderr && child.stderr.on('data', function (data) {
          var str = data.toString();

          // bail if this is warning line garbage
          if (isGarbageLineWarning(str)) {
            return;
          }

          // if we have a callback and this explictly returns
          // false then bail
          if (onStderrData && onStderrData(str) === false) {
            return;
          }

          // else pass it along!
          process.stderr.write(data);
        });

        // https://github.com/cypress-io/cypress/issues/1841
        // In some versions of node, it will throw on windows
        // when you close the parent process after piping
        // into the child process. unpiping does not seem
        // to have any effect. so we're just catching the
        // error here and not doing anything.
        process.stdin.on('error', function (err) {
          if (err.code === 'EPIPE') {
            return;
          }

          throw err;
        });

        if (stdioOptions.detached) {
          child.unref();
        }
      });
    };

    var spawnInXvfb = function spawnInXvfb() {
      return xvfb.start().then(userFriendlySpawn).finally(xvfb.stop);
    };

    var userFriendlySpawn = function userFriendlySpawn(linuxWithDisplayEnv) {
      debug('spawning, should retry on display problem?', Boolean(linuxWithDisplayEnv));

      var brokenGtkDisplay = void 0;

      var overrides = {};

      if (linuxWithDisplayEnv) {
        _.extend(overrides, {
          electronLogging: true,
          onStderrData: function onStderrData(str) {
            // if we receive a broken pipe anywhere
            // then we know that's why cypress exited early
            if (util.isBrokenGtkDisplay(str)) {
              brokenGtkDisplay = true;
            }

            // we should attempt to always slurp up
            // the stderr logs unless we've explicitly
            // enabled the electron debug logging
            if (!debugElectron.enabled) {
              return false;
            }
          }
        });
      }

      return spawn(overrides).then(function (code) {
        if (code !== 0 && brokenGtkDisplay) {
          util.logBrokenGtkDisplayWarning();

          return spawnInXvfb();
        }

        return code;
      }).catch(throwFormErrorText(errors.unexpected));
    };

    if (needsXvfb) {
      return spawnInXvfb();
    }

    // if we are on linux and there's already a DISPLAY
    // set, then we may need to rerun cypress after
    // spawning our own Xvfb server
    var linuxWithDisplayEnv = util.isPossibleLinuxWithIncorrectDisplay();

    return userFriendlySpawn(linuxWithDisplayEnv);
  }
};