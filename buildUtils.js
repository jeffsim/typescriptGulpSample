var eventStream = require("event-stream"),
    gulp = require("gulp"),
    gulpIf = require("gulp-if"),
    preservetime = require("gulp-preservetime"),
    through = require('through2');

var buildSettings = require("./buildSettings");

module.exports = {
    // Runs in order a series of functions which return streams or promises.  Does not call function N until function (N-1)
    // has reached the end of its stream; denoted by the stream triggering the "end" event.  Returns a stream.
    // NOTE: This is likely a pretty fragile function and doesn't support myriad realities of streams and promises.  Works
    //       for this gulpfile's needs, though!
    runSeries: function (functions) {
        var stream = through();
        var i = 0, toRun = functions.length;
        var run = () => {
            if (i == toRun)
                stream.resume().end();
            else {
                var result = functions[i++]();
                if (result.on)
                    result.on("end", run);
                else if (result.then)
                    result.then(run);
                else
                    throw new Error("functions passed to runSeries must return a stream or promise");
            }
        };
        run();
        return stream;
    },

    // Runs a series of functions and returns a stream that is ended when all functions' streams end.
    // This is mostly just a pass-through to event-stream; however, I allow the user to force serialized
    // task execution here
    runParallel: function (callbacks) {
        if (buildSettings.forceSerializedTasks) {
            // Run them in series
            return runSeries(callbacks);
        } else {
            // run them in parallel.  This function takes an array of callbacks, but event-stream expects already
            // started streams, so call the callbacks here
            // TODO: runSeries accepts both promises and streams, but eventStream only accepts streams.  convert them here
            var funcs = [];
            for (var func of callbacks)
                funcs.push(func());
            return eventStream.merge(funcs);
        }
    },

    getCompletedStream: function () {
        // runSeries and runParallel take a collection of streams; if a function has nothing to
        // do, then it can just return a completed stream as a 'nop'
        // TODO: Clean this up.
        var stream = through.obj();
        stream.resume().end();
        return stream;
    },

    // Copies a file from the source location to the dest location
    // This only supports copying a (glob of files) into a folder; destPath cannot be a specific filename.
    copyFile: function (src, destPath) {
        // Incremental builds need to maintain the src's modified time in the dest copy, but gulp.src.dest doesn't do that
        // Automatically.  So: call preservetime.
        // See http://stackoverflow.com/questions/26177805/copy-files-with-gulp-while-preserving-modification-time
        return gulp.src(src)
            .pipe(gulp.dest(destPath))
            .pipe(gulpIf(buildSettings.incrementalBuild, preservetime()));
    },

    // Joins two paths together, removing multiple slashes (e.g. path/to//file)
    joinPath: function (path, file) {
        return (path + '/' + file).replace(/\/{2,}/, '/');
    },
    
    outputFilesInStream: function (taskName) {
        return through.obj(function (file, enc, callback) {
            if (buildSettings.verboseOutput) {
                // we compile d.ts files, but don't babble about them here.
                if (file.relative.indexOf(".d.ts") == -1)
                    console.log("[" + taskName + "]: File in stream: " + file.relative);
            }

            this.push(file);
            return callback();
        });
    }
}