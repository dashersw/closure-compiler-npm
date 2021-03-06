/*
 * Copyright 2015 The Closure Compiler Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Gulp task for closure-compiler. Multiplexes input
 * files into a json encoded stream which can be piped into closure-compiler.
 * Each json file object includes the contents, path and optionally sourcemap
 * for every input file.
 *
 * Closure-compiler will return the same style string via standard-out which
 * is then converted back to vinyl files.
 *
 * @author Chad Killingsworth (chadkillingsworth@gmail.com)
 */

'use strict';


/**
 * @param {Object<string,string>} initOptions
 * @return {function(Object<string,string>|Array<string>):Object}
 */
module.exports = function(initOptions) {
  var filesToJson = require('./concat-to-json');
  var jsonToVinyl = require('./json-to-vinyl');
  var Compiler = require('../node/closure-compiler');
  var gutil = require('gulp-util');
  var PluginError = gutil.PluginError;
  var through = require('through2');
  /** @const */
  var PLUGIN_NAME = 'gulp-google-closure-compiler';
  var streamInputRequired = initOptions ? !!initOptions.requireStreamInput : false;
  var SourceMapGenerator = require('source-map').SourceMapGenerator;
  var SourceMapConsumer = require('source-map').SourceMapConsumer;
  var applySourceMap = require('vinyl-sourcemaps-apply');
  var path = require('path');

  return function (compilationOptions, pluginOptions) {
    pluginOptions = pluginOptions || {};

    var streamMode = pluginOptions.streamMode || 'BOTH';
    var log = pluginOptions.logger || gutil.log;
    var pluginName = pluginOptions.pluginName || PLUGIN_NAME;

    var fileList = [];

    // Buffer the files into an array
    function bufferContents(file, enc, cb) {
      // ignore empty files
      if (file.isNull()) {
        cb();
        return;
      }

      if (file.isStream()) {
        this.emit('error', new PluginError(pluginName, 'Streaming not supported'));
        cb();
        return;
      }

      fileList.push(file);

      cb();
    }

    function endStream(cb) {
      var jsonFiles, logger = log.warn ? log.warn : log;
      if (fileList.length > 0) {
        // Input files are present. Convert them to a JSON encoded string
        jsonFiles = filesToJson(fileList);
      } else {
        // If files in the stream were required, no compilation needed here.
        if (streamInputRequired) {
          this.emit('end');
          cb();
          return;
        }

        // The compiler will always expect something on standard-in. So pass it an empty
        // list if no files were piped into this plugin.
        jsonFiles = [];
      }

      var compiler = new Compiler(compilationOptions);

      // Add the gulp-specific argument so the compiler will understand the JSON encoded input
      // for gulp, the stream mode will be 'BOTH', but when invoked from grunt, we only use
      // a stream mode of 'IN'
      compiler.command_arguments.push('--json_streams', streamMode);

      var compiler_process = compiler.run();

      var gulpStream = this;
      var stdOutData = '', stdErrData = '';

      compiler_process.stdout.on('data', function (data) {
        stdOutData += data;
      });
      compiler_process.stderr.on('data', function (data) {
        stdErrData += data;
      });
      compiler_process.on('close', function (code) {
        // non-zero exit means a compilation error
        if (code !== 0) {
          gulpStream.emit('error', new PluginError(pluginName,
              'Compilation error: \n\n' + compiler.prependFullCommand(stdErrData)));
        }

        // standard error will contain compilation warnings, log those
        if (stdErrData.trim().length > 0) {
          logger(gutil.colors.yellow(pluginName) + ': ' + stdErrData);
        }

        // If present, standard output will be a string of JSON encoded files.
        // Convert these back to vinyl
        if (stdOutData.trim().length > 0) {
          var outputFiles;
          try {
            outputFiles = jsonToVinyl(stdOutData);
          } catch (e) {
            this.emit('error', new PluginError(pluginName, 'Error parsing json encoded files'));
            cb();
            return;
          }

          for (i = 0; i < outputFiles.length; i++) {
            if (outputFiles[i].sourceMap) {
              // Closure compiler does not compose source maps (use input source maps)
              // We need to manually compose the maps so that we reference the original file
              var generator = SourceMapGenerator.fromSourceMap(
                  new SourceMapConsumer(outputFiles[i].sourceMap));
              outputFiles[i].sourceMap = undefined;

              for (var j = 0; j < jsonFiles.length; j++) {
                if (!jsonFiles[j].source_map) {
                  continue;
                }
                generator.applySourceMap(
                    new SourceMapConsumer(jsonFiles[j].source_map),
                    jsonFiles[j].path.substr(1));
              }
              applySourceMap(outputFiles[i], generator.toString());
            }
            gulpStream.push(outputFiles[i]);
          }
        }
        cb();
      });

      // Error events occur when there was a problem spawning the compiler process
      compiler_process.on('error', function (err) {
        gulpStream.emit('error', new PluginError(pluginName,
            'Process spawn error. Is java in the path?\n' + err.message));
        cb();
      });

      compiler_process.stdin.on('error', function(err) {
        gulpStream.emit('Error', new PluginError(pluginName,
            'Error writing to stdin of the compiler.\n' + err.message));
        cb();
      });

      var CHUNK_SIZE = 1024, i = 0, stdInData = JSON.stringify(jsonFiles);
      var num_chunks = Math.ceil(stdInData.length / CHUNK_SIZE);

      // Write the data to the stdin stream
      // Be attentive to back-pressure.
      (function write_buffer_in_chunks(callback) {
        var ok = true;
        do {
          i++;

          if (i < num_chunks) {
            ok = compiler_process.stdin.write(stdInData.substr((i - 1) * CHUNK_SIZE, CHUNK_SIZE),
                "UTF-8");
          } else {
            compiler_process.stdin.write(stdInData.substr((i - 1) * CHUNK_SIZE), "UTF-8", callback);
          }
        } while (i < num_chunks && ok);
        if (i < num_chunks) {
          // had to stop early!
          // write some more once it drains
          compiler_process.stdin.once('drain', write_buffer_in_chunks.bind(null, callback));
        }
      })(function () {
        compiler_process.stdin.end();
      });
    }

    return through.obj(bufferContents, endStream);
  };
};
