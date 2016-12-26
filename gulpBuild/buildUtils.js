var concat = require("gulp-concat"),
    dtsGenerator = require("dts-generator"),
    eventStream = require("event-stream"),
    fs = require("fs"),
    glob = require("glob"),
    gulp = require("gulp"),
    gulpIf = require("gulp-if"),
    preservetime = require("gulp-preservetime"),
    rename = require("gulp-rename"),
    sourcemaps = require("gulp-sourcemaps"),
    tsc = require("gulp-typescript"),
    through = require('through2'),
    uglify = require("gulp-uglify");


var buildSettings = require("./buildSettings");

var bu = buildUtils = {

    // For a single given project, build it, then minify it, and then generate a d.ts file for it (as needed)
    buildAndMinifyProject: function (project) {
        // Check for incremental build and nothing changed; if that's the case, then emit "no build needed" and skip it
        // Returns a stream object that can be returned directly.
        var skipStream = bu.checkCanSkipBuildProject(project);
        if (skipStream)
            return skipStream;

        // Build the Project; then in parallel minify it and build d.ts file (as needed).
        return bu.runSeries([
            // First, build the project.  This transpiles .ts files into .js files and copies result to
            // folder specified in the project's buildConfig.
            () => bu.buildProject(project),

            // Once the project has been built, we can in-parallel minify the built .js files and also
            // build d.ts files (as determined by the project's buildConfig)
            () => bu.runParallel([
                () => bu.minifyProject(project),
                () => bu.buildDefinitionFile(project)
            ])
        ]);
    },

    // Build a single project. Details:
    //  TS files are transpiled into JS files
    //  JS files are output to 'project.buildRootFolder'
    //  Bundled file created if project.bundleFiles == true.
    //      bundle name = project.[debug|min]BundleFilename
    //      Bundle output to project.outputFolder
    buildProject: function (project) {
        var taskTracker = new bu.TaskTracker("buildProject", project);
        var projectFolderName = bu.joinPath(project.path, "/");
        var ts = tsc.createProject(project.projectGroup.tsConfigFile || bu.joinPath(projectFolderName, "tsconfig.json"));

        // Create list of files to compile.  Combination of common files in the project group AND files in the project
        var filesToCompile = project.files.slice();
        if (project.projectGroup.commonFiles)
            for (var commonFile of project.projectGroup.commonFiles)
                filesToCompile.push(commonFile);

        if (project.extraFilesToBundle)
            for (var file of project.extraFilesToBundle) {
                // debugstart
                if (buildSettings.debug) {
                    if (file.indexOf(".js") != -1 && !ts.options.allowJs)
                        throw Error("Including .js files via project.extraFilesToBundle requires that allowJs be set in the project's tsconfig.json");
                }
                // debugend
                filesToCompile.push(bu.joinPath(project.path, file));
            }

        // TODO (CLEANUP): is the base:"." necessary, or is that the default value already?
        return gulp.src(filesToCompile, { base: "." })

            // Initialize sourcemap generation
            .pipe(sourcemaps.init())

            // Do the actual transpilation from Typescript to Javascript.
            .pipe(ts())

            // We always bundle output for simplicity's sake, so combine all of the resultant javascript into a single file
            .pipe(concat(project.debugBundleFilename))

            // Write sourcemaps into the folder set by the following gulp.dest call
            .pipe(sourcemaps.write(".", { includeContent: false, sourceRoot: "/" }))

            // Copy built project output into project.buildFolder and, if outputFolder is specified, to project.outputFolder
            .pipe(gulp.dest(project.buildFolder))
            .pipe(gulp.dest(project.outputFolder))

            // Output end of task
            .on("end", () => taskTracker.end());
    },

    // Minifies a single Project.  Details:
    //  Uses the Project's already-built files as source files
    //  Generates "*-min.js" output files
    minifyProject: function (project) {
        var taskTracker = new bu.TaskTracker("minifyProject", project);

        // Minify all the built bundle js files in the built folder
        return gulp.src([bu.joinPath(project.buildFolder, project.debugBundleFilename)], { base: project.buildFolder })

            // Initialize Sourcemap generation, telling it to load existing sourcemap (from the already-built *-debug.js file(s))
            .pipe(sourcemaps.init({ loadMaps: true }))

            // Strip //debugstart and //debugend and everything in between from -min builds.
            .pipe(bu.stripDebugStartEnd())

            // Rename output to project.minBundleFilename
            .pipe(rename(project.minBundleFilename))

            // Minify the project
            .pipe(uglify())

            // Write sourcemaps into the folder(s) set by the following gulp.dest call
            .pipe(sourcemaps.write(".", {
                includeContent: false, sourceRoot: "/",

                // The sourceRoot and sources' paths from the source files are getting flattened; vscode's chrome debugger
                // plugin doesn't like that, so forcibly remove the source root (a slash).
                mapSources: (path) => path.substr(1)
            }))

            // Copy built project output into project.buildFolder and, if outputFolder is specified, to project.outputFolder
            .pipe(gulp.dest(project.buildFolder))
            .pipe(gulp.dest(project.outputFolder))

            // Output end of task
            .on("end", () => taskTracker.end())
    },

    // Generates .d.ts definition file for a single project
    buildDefinitionFile: function (project) {

        // Only generate d.ts files if so desired
        if (!project.generateTyping)
            return bu.getCompletedStream();

        var taskTracker = new bu.TaskTracker("buildLibDefinitionFile", project);

        var outputFile = bu.joinPath(project.buildFolder, "typings", project.typingBundleFilename);
        var stream = through();
        dtsGenerator.default({
            name: project.name,
            project: project.path,
            rootDir: "./",
            exclude: ["./**/*.d.ts"],
            out: outputFile
        }).then(() => {
            stream.resume().end();
            taskTracker.end();
        });
        return stream;
    },
    // Builds a project group (e.g. editor, plugins, samples, or tests)
    buildProjectGroup: function (projectGroup) {
        bu.outputTaskHeader("Build " + projectGroup.name);
        return bu.runSeries([
            () => bu.precopyRequiredFiles(projectGroup),

            // Build all of the projects in the projectgroup
            () => bu.buildProjects(projectGroup),

            // Then, if the ProjectGroup has specified that all projects within it should be bundled, create that bundle and 
            // copy it to the output folder defined in the projectgroup's buildConfig.
            () => bu.buildProjectGroupBundle(projectGroup)
        ]);
    },

    // Build a collection of projects
    buildProjects: function (projectGroup) {
        var buildActions = [];
        for (var projectId in projectGroup.projects) {
            let p = projectGroup.projects[projectId]; // closure
            buildActions.push(() => bu.buildAndMinifyProject(p));
        }
        return bu.runParallel(buildActions);
    },

    buildAll: function (buildConfig) {
        // If buildConfig contains a custom buildAll then use it.  Used when a buildConfig does more complex building
        // If no custom buildAll then just build all of the ProjectGroups in order
        if (buildConfig.buildAll)
            return buildConfig.buildAll(bu.buildProjectGroup, bu.createAggregateBundle);
        else
            for (var projectGroup in buildConfig.projectGroups)
                bu.buildProjectGroup(buildConfig.projectGroups[projectGroup]);
    },


    // ====================================================================================================================
    // ======= INCREMENTAL BUILD SUPPORT ==================================================================================

    // The Typescript compiler requires that all files be included, even those that haven't changed; therefore we can't 
    // blindly use something like gulp-changed-in-place, which would just filter out unchanged files.  What we *can* do is:
    //
    //  1. Maintain an always-running 'watch' task which internally maintains some degree of state about a build and saves
    //     some time when rebuilding (~15% in this project, presumably more in others).  This is what the 'watch' task does.
    //  2. Maintain a *project-wide* modified state and skip building the entire project if nothing in the project has
    //     changed.  That's what checkCanSkipBuildProject does.

    // Checks if anything in the project has been modified and the project needs to be rebuilt; if so, returns null
    // If the project can be skipped, then returns a stream that can be returned from the caller.
    checkCanSkipBuildProject: function (project) {

        // Check if incremental builds are enabled
        if (!buildSettings.incrementalBuild)
            return null;

        // If this is first build, then modifiedFilesCache is empty.  In that case, then create the modified file cache for
        // later comparison.  Continue so that we can populate the cache with first run values.
        project.modifiedFilesCache = project.modifiedFilesCache || {};

        // If here, then project has been previously built, and project.modifiedFilesCache contains info.  Compare against
        // current state; if ANY project file has changed, then rebuild.
        var fileHasChanged = false;

        // Generate list of files in the project that we should check
        var filesToCheck = [];
        var globFiles = [];
        project.files.forEach((fileGlob) => globFiles = globFiles.concat(glob.sync(fileGlob)));

        // If project doesn't have any .ts files (e.g. it only has .js) then nothing to compile.
        // Bit tricky here; project *could* have .d.ts files; if it only has those, then don't compile
        var hasFilesToCompile = false;
        for (var file of globFiles)
            if (file.indexOf(".ts") != -1 && file.indexOf(".d.ts") == -1) {
                hasFilesToCompile = true;
                break;
            }

        if (!hasFilesToCompile)
            bu.log(bu.getTimeString(new Date()) + " -- SKIPPING (" + project.name + "): no files to compile");
        else {
            for (var projectFile of globFiles)
                filesToCheck.push(projectFile);
            var fileHasChanged = bu.checkForChangedFile(filesToCheck, project.modifiedFilesCache);

            // If any files have changed then return null, signifying need to recompile Project
            if (fileHasChanged)
                return null;

            // If here, then no files in the project have changed; skip!
            bu.log(bu.getTimeString(new Date()) + " -- SKIPPING (" + project.name + "): no files changed");
        }

        // Create an already-completed stream; caller will pass back up the chain
        return bu.getCompletedStream();
    },

    checkForChangedFile: function (filesToCheck, modifiedCache) {
        var fileHasChanged = false;

        for (var file of filesToCheck) {
            var stat = fs.statSync(file);
            var lastModifiedTime = stat.mtime.valueOf();
            var lastSeenModifiedTime = modifiedCache[file];
            if (lastModifiedTime != lastSeenModifiedTime) {
                // File has changed; track change.  Since we're going to rebuild, continue comparing 
                // file change times and updating the latest
                modifiedCache[file] = lastModifiedTime;

                // if recompiledOnDTSChanges is false, and the file is a d.ts file, then we do not trigger a recompilation.
                if (!buildSettings.recompiledOnDTSChanges && file.indexOf(".d.ts") > -1)
                    continue;

                fileHasChanged = true;
            }
        }
        return fileHasChanged;
    },

    checkCanSkipBuildBundle: function (bundle, buildConfig) {

        // Check if incremental builds are enabled
        if (!buildSettings.incrementalBuild)
            return null;

        // If here, then bundle has been previously built, and bundle.modifiedBundleCache contains info.  Compare against
        // current state; if ANY file has changed, then rebuild the bundle
        var filesToCheck = [];
        for (var projectGroup in buildConfig.projectGroups) {
            for (var projectId in buildConfig.projectGroups[projectGroup].projects) {
                var project = buildConfig.projectGroups[projectGroup].projects[projectId];
                if (project.aggregateBundle == bundle)
                    filesToCheck.push(bu.joinPath(buildSettings.bldPath, project.path, project.name + "-debug.js"));
            }
        }
        var fileHasChanged = bu.checkForChangedFile(filesToCheck, bundle.modifiedBundleCache);

        // If any files have changed then return null, signifying need to recreate the bundle
        if (fileHasChanged)
            return null;

        // If here, then no files that we'd bundle have changed; skip!
        bu.log(bu.getTimeString(new Date()) + " -- SKIPPING BUNDLE: no files changed");

        // Create an already-completed stream; caller will pass back up the chain
        return bu.getCompletedStream();
    },

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

        // preface src and destPath with ./ to ensure it isn't copying to or from the filesystem root
        src = bu.joinPath(".", src);
        destPath = bu.joinPath(".", destPath);
        return gulp.src(src)
            .pipe(gulp.dest(destPath))
            .pipe(gulpIf(buildSettings.incrementalBuild, preservetime()));
    },

    // basic assert function
    assert: function (check, string) {
        if (!check)
            throw new Error(string);
    },

    // Returns true if a file exists; false otherwise.
    fileExists: function (fullPath) {
        try {
            return fs.statSync(fullPath).isFile();
        }
        catch (e) {
            if (e.code != 'ENOENT')
                throw e;
            return false;
        }
    },

    // Joins two or more paths together, removing multiple slashes (e.g. path/to//file)
    joinPath: function () {
        var segments = Array.prototype.slice.call(arguments);
        return segments.join('/').replace(/\/{2,}/, '/');
    },

    outputFilesInStream: function (taskName) {
        var bu = this;
        return through.obj(function (file, enc, callback) {
            // we compile d.ts files, but don't babble about them here.
            if (file.relative.indexOf(".d.ts") == -1)
                bu.log("[" + taskName + "]: File in stream: " + file.relative);

            bu.push(file);
            return callback();
        });
    },

    // outputs a string to the console IFF verboseOutput is true
    log: function (string) {
        if (buildSettings.verboseOutput)
            console.log(string);
    },

    // strip // DEBUGSTART, // DEBUGEND, and everything in-between them
    stripDebugStartEnd: function () {
        var bu = this;
        return through.obj(function (file, enc, callback) {
            var contents = file.contents.toString();

            // Here's what I want to do, which works:
            //   var strippedContents = contents.replace(/\/\/ DEBUGSTART([\s\S]*?)\/\/ DEBUGEND/gi, "")
            // However, I want to specify custom start/end strings in buildSettings, so I can't use regexp literal notation.
            // So, I use 'new RegExp' instead
            var re = new RegExp(buildSettings.debugBlockStartText + "([\\s\\S]*?)" + buildSettings.debugBlockEndText, "gi");
            file.contents = new Buffer(contents.replace(re, ""));
            this.push(file);
            return callback();
        });
    },

    // Copies any previously built files into the ProjectGroup's Projects.
    precopyRequiredFiles: function (projectGroup) {
        var taskTracker = new bu.TaskTracker("precopyRequiredFiles");

        var buildActions = [];
        // Copy files that should be copied one time before a projectgroup is built; e.g. tests/typings/bundle.d.ts is
        // used by all tests and needs to be copied from dist first.
        if (projectGroup.filesToPrecopyOnce)
            for (var fileToCopy of projectGroup.filesToPrecopyOnce) {
                let file = fileToCopy; // closure
                buildActions.push(() => bu.copyFile(file.src, file.dest));
            }
        for (var projectId in projectGroup.projects) {
            var project = projectGroup.projects[projectId];

            // Copy files that should be copied to every project in the entire project group
            if (projectGroup.filesToPrecopyToAllProjects)
                for (var fileToCopy of projectGroup.filesToPrecopyToAllProjects) {
                    let file = fileToCopy, p = project; // closure
                    buildActions.push(() => bu.copyFile(file.src, bu.joinPath(p.path, file.dest)));
                }

            // Copy any files that this project needs
            if (project.filesToPrecopy)
                for (var fileToCopy of project.filesToPrecopy) {
                    let file = fileToCopy, p = project; // closure
                    buildActions.push(() => bu.copyFile(file.src, bu.joinPath(p.path, file.dest)));
                }

            // Copy any dependent projects
            if (project.dependsOn)
                for (var dependentProject of project.dependsOn) {
                    let libSrc = bu.joinPath(dependentProject.buildFolder, "**/*.js")
                    let libDest = bu.joinPath(project.path, "lib");
                    let typingSrc = bu.joinPath(dependentProject.buildFolder, "typings/*.d.ts")
                    let typingDest = bu.joinPath(project.path, "typings");

                    if (buildSettings.debugSettings && !buildSettings.debugSettings.allowEmptyFolders) {
                        // verify that there is something in the lib folder
                        var numFiles = glob.sync(libSrc).length;
                        bu.assert(numFiles > 0, "No lib files found for dependent project '" + dependentProject.name +
                            "' in folder '" + dependentProject.buildFolder + "'.  If this is expected behavior, then set buildSettings.debug.allowEmptyFolders:true");
                        
                        // verify there is something in the typing folder
                        numFiles = glob.sync(typingSrc).length;
                        bu.assert(numFiles > 0, "No typing found for dependent project '" + dependentProject.name +
                            "' in folder '" + dependentProject.buildFolder + "/typing'.  If this is expected behavior, then set buildSettings.debug.allowEmptyFolders:true");
                    }
                    buildActions.push(() => bu.copyFile(libSrc, libDest));
                    buildActions.push(() => bu.copyFile(typingSrc, typingDest));
                }
        }
        return bu.runParallel(buildActions).on("end", () => taskTracker.end());
    },

    // Called at the start of a top-level Task.
    outputTaskHeader: function (taskName) {
        bu.log("===== " + taskName + " =======================================================");
    },

    // Outputs task start and end info to console, including task run time.
    TaskTracker: function (taskName, project) {
        if (buildSettings.verboseOutput) {
            var startTime = new Date();
            var startTimeStr = bu.getTimeString(startTime);
            var outStr = startTimeStr + " Starting " + taskName;
            if (project)
                outStr += " (" + project.name + ")";
            bu.log(outStr);
        }

        return {
            end: function () {
                if (!buildSettings.verboseOutput)
                    return;
                var endTime = new Date();
                var delta = (endTime - startTime) / 1000;
                var endTimeStr = bu.getTimeString(endTime);
                if (project)
                    bu.log(endTimeStr + " Finished " + taskName + " (" + project.name + ") after " + delta + " s");
                else
                    bu.log(endTimeStr + " Finished " + taskName + " after " + delta + " s");
            }
        };
    },

    getTimeString: function (time) {
        return "[" + time.toTimeString().replace(/.*(\d{2}:\d{2}:\d{2}).*/, "$1") + "]";
    },

    finishInitializingBundles: function (buildConfig) {
        if (buildConfig.bundlesInitialized)
            return;

        for (var bundleName in buildConfig.aggregateBundles)
            buildConfig.aggregateBundles[bundleName] = bu.finishInitializingBundle(buildConfig.aggregateBundles[bundleName]);
        buildConfig.bundlesInitialized = true;
    },

    // For build config debugging purposes; defines the set of required fields on a bundle; if any are missing then we throw an error
    requiredBundleFields: ["name", "version"],

    // For build config debugging purposes; defines the set of optional fields on a bundle
    // if any fields other than (requiredBundleFields + optionalBundleFields) are present on a bundle then we throw an error
    optionalBundleFields: ["generateCombinedTyping"],

    finishInitializingBundle: function (bundle) {
        if (bundle.initialized)
            return bundle;

        var bundleNameVer = bundle.name;

        if (buildSettings.debug) {
            // do various checks to validate the config file
            // verify required fields are present, and only fields in (requiredBundleFields + optionalBundleFields) are present
            for (var field of bu.requiredBundleFields)
                bu.assert(bundle[field], "Required bundle field '" + field + "' missing on bundle '" + bundle.name + "'");
            for (var field in bundle) {
                var fieldAllowed = bu.requiredBundleFields.indexOf(field) != -1 || bu.optionalBundleFields.indexOf(field) != -1;
                bu.assert(fieldAllowed, "Unrecognized field '" + field + "' specified on bundle '" + bundle.name + "'");
            }
        }

        // Include version in the name if specified in the bundle
        if (bundle.version)
            bundleNameVer += "-" + bundle.version;

        if (!bundle.outputFolder)
            bundle.outputFolder = buildSettings.distPath;
        // ensure bundle is rooted in the build root; otherwise, could end up in file system root if caller specifies something like "/dist"
        bundle.outputFolder = bu.joinPath(".", bundle.outputFolder);

        // Set the output file names (if not already set in the bundle)
        bundle.debugFilename = bundle.debugFilename || (bundleNameVer + ".debug.js");
        bundle.minFilename = bundle.minFilename || (bundleNameVer + ".min.js");
        bundle.typingFilename = bundle.typingFilename || (bundleNameVer + ".d.ts");

        // Initialize the incremental project build cache which tracks last-changed times
        bundle.modifiedBundleCache = {};

        bundle.initialized = true;
        return bundle;
    },

    // For build config debugging purposes; defines the set of required fields on a Project; if any are missing then we throw an error
    requiredProjectFields: ["path"],

    // For build config debugging purposes; defines the set of optional fields on a Project
    // if any fields other than (requiredProjectFields + optionalProjectFields) are present on a Project then we throw an error
    optionalProjectFields: ["name", "dependsOn", "files", "extraFilesToBundle", "filesToClean", "aggregateBundle", "generateTyping", "outputFolder"],

    // For build config debugging purposes; defines the set of required fields on a ProjectGroup; if any are missing then we throw an error
    requiredProjectGroupFields: [],

    // For build config debugging purposes; defines the set of optional fields on a ProjectGroup
    // if any fields other than (requiredProjectGroupFields + optionalProjectGroupFields) are present on a ProjectGroup then we throw an error
    optionalProjectGroupFields: ["name", "filesToClean", "filesToPrecopyToAllProjects", "projectDefaults", "projectRootFolder", "projects",
        "tsConfigFile", "commonFiles", "bundleProjectsTogether", "filesToPrecopyOnce"],

    finishInitializingProjects: function (buildConfig, buildProjectGroup, createAggregateBundle) {

        // If the buildConfig.js didn't complete initialization of any bundles, then do so automatically here.  A more 
        // complex build environment may do this initialization itself
        if (!buildConfig.bundlesInitialized);
        bu.finishInitializingBundles(buildConfig);

        for (var projectGroupId in buildConfig.projectGroups) {
            var projectGroup = buildConfig.projectGroups[projectGroupId];
            if (projectGroup.name === undefined)
                projectGroup.name = projectGroupId;
            if (buildSettings.debug) {
                // verify required fields are present, and only fields in (requiredProjectGroupFields + optionalProjectGroupFields) are present
                for (var field of bu.requiredProjectGroupFields)
                    bu.assert(projectGroup[field], "Required field '" + field + "' missing on ProjectGroup '" + projectGroup.name + "'");
                for (var field in projectGroup) {
                    var fieldAllowed = bu.requiredProjectGroupFields.indexOf(field) != -1 || bu.optionalProjectGroupFields.indexOf(field) != -1;
                    bu.assert(fieldAllowed, "Unrecognized field '" + field + "' specified on ProjectGroup '" + projectGroup.name + "'");
                }
            }

            if (buildSettings.debug) {
                // If ProjectGroup specified a tsconfig.json file for all projects within it, then verify tsconfig.json file is present
                if (projectGroup.tsConfigFile)
                    bu.assert(bu.fileExists(projectGroup.tsConfigFile), "projectGroup.tsConfigFile not found for ProjectGroup '" + projectGroupId + "'");
            }

            for (var projectId in projectGroup.projects) {
                var project = projectGroup.projects[projectId];

                if (!project.name)
                    project.name = projectId;

                if (buildSettings.debug) {
                    // verify required fields are present, and only fields in (requiredProjectFields + optionalProjectFields) are present
                    for (var field of bu.requiredProjectFields)
                        bu.assert(project[field], "Required field '" + field + "' missing on Project '" + project.name + "'");
                    for (var field in project) {
                        var fieldAllowed = bu.requiredProjectFields.indexOf(field) != -1 || bu.optionalProjectFields.indexOf(field) != -1;
                        bu.assert(fieldAllowed, "Unrecognized field '" + field + "' specified on Project '" + project.name + "'");
                    }
                }

                // Associate the Project with the ProjectGroup
                project.projectGroup = projectGroup;

                // All projects must specify a path
                if (!project.path)
                    throw Error(project.name + " must specify project.path");

                // if our ProjectGroup specified a projectRootFolder, then prepend it now
                if (projectGroup.projectRootFolder)
                    project.path = bu.joinPath(projectGroup.projectRootFolder, project.path);

                // Pass projectDefaults from the ProjectGroup into the Project IF the Project hasn't overridden them
                if (projectGroup.projectDefaults)
                    for (var projectDefault in projectGroup.projectDefaults)
                        if (project[projectDefault] === undefined)
                            project[projectDefault] = projectGroup.projectDefaults[projectDefault];

                // By default, project files are built into /bld
                if (project.buildRootFolder === undefined)
                    project.buildRootFolder = buildSettings.bldPath;

                // Ensure project is rooted in build root folder, not file system root folder
                project.buildRootFolder = bu.joinPath(".", project.buildRootFolder);

                // buildFolder is where files get built into - combination of root folder (e.g. bld/) and project.path (e.g. plugins/plugin1)
                if (project.buildFolder === undefined)
                    project.buildFolder = bu.joinPath(project.buildRootFolder, project.path)

                // By default, project output files are copied into the project's folder
                if (project.outputFolder === undefined)
                    project.outputFolder = project.path;

                // Ensure outputFolder is rooted in build root folder, not file system root folder
                project.outputFolder = bu.joinPath(".", project.outputFolder);

                // By default, project output files are bundled together
                if (project.bundleFiles === undefined)
                    project.bundleFiles = true;

                // By default, projects do not output d.ts files
                if (project.generateTyping === undefined)
                    project.generateTyping = false;

                if (project.debugBundleFilename === undefined)
                    project.debugBundleFilename = project.name + buildSettings.bundleSuffix + "-debug.js"
                if (project.minBundleFilename === undefined)
                    project.minBundleFilename = project.name + buildSettings.bundleSuffix + "-min.js"
                if (project.typingBundleFilename === undefined)
                    project.typingBundleFilename = project.name + buildSettings.bundleSuffix + ".d.ts"

                // project.files - if not specified then default to project.path/**.*.ts
                if (project.files === undefined)
                    project.files = ["**/*.ts"];

                // Rebase passed-in file names so that they are within the project folder
                for (var i = 0; i < project.files.length; i++)
                    project.files[i] = bu.joinPath(project.path, project.files[i]);

                if (buildSettings.debug) {
                    // do various checks to validate the config file
                    // if projectgroup didn't specify a tsconfig.json file for all projects in it, then verify that this project's
                    // tsconfig.json file is in the project root
                    if (!projectGroup.tsConfigFile)
                        bu.assert(bu.fileExists(bu.joinPath(project.path, "tsconfig.json")), "tsconfig.json file not found in Project root('" + project.path + "') for Project '" + projectId + "'");

                    // Verify that there's at least one file to compile.
                    if (!buildSettings.debugSettings.allowEmptyFolders) {
                        var numFiles = 0;
                        project.files.forEach((fileGlob) => numFiles += glob.sync(fileGlob).length);
                        bu.assert(numFiles > 0, "No .ts files found for project '" + projectId + "'.  If this is expected behavior, then set buildSettings.debug.allowEmptyFolders:true");
                    }

                    // If dependsOn is specified, then ensure dependent projects exists
                    if (project.dependsOn)
                        project.dependsOn.forEach((dependency) => bu.assert(dependency, "Project specified in dependsOn doesn't exist for project '" + project.name + "'"));
                }
            }
        }

        // If the buildConfig doesn't have a buildAll function defined, then create one now based around dependencies
        if (!buildConfig.buildAll)
            bu.buildProjectDependencyGraph(buildConfig);

        // Return the config to enable chaining
        return buildConfig;
    },

    // build dependency graph of ProjectGroups within the specified buildConfig. Uses basic depth-first topo sort and
    // compares 'project.dependsOn: object[]' values.
    // NOTE: This function is not heavily tested.  If dependency graph isn't working for you, then skip this by defining
    // your own buildConfig.buildAll() which sets order explicitly; see the main buildConfig in this sample env for example
    buildProjectDependencyGraph: function (buildConfig) {
        var state = { exploring: 1, placed: 2 };
        var buildSlots = [];
        for (var projectGroupId in buildConfig.projectGroups)
            exploreProjectGroup(buildConfig.projectGroups[projectGroupId]);

        function exploreProjectGroup(projectGroup) {
            if (projectGroup.state == state.exploring)
                throw new Error("Circular dependency!");

            if (projectGroup.state != state.placed) {
                projectGroup.state = state.exploring;
                for (var projectId in projectGroup.projects) {
                    let project = projectGroup.projects[projectId];
                    if (project.dependsOn)
                        for (var dependentProject of project.dependsOn)
                            exploreProjectGroup(dependentProject.projectGroup);
                }
                projectGroup.state = state.placed;
                buildSlots.push(() => bu.buildProjectGroup(projectGroup))
            }
        }

        // If here, then buildAll isn't specified; if there are any aggregateBundles then build them after the above
        if (buildConfig.aggregateBundles)
            for (var bundleId in buildConfig.aggregateBundles) {
                let bundle = buildConfig.aggregateBundles[bundleId];
                buildSlots.push(() => bu.createAggregateBundle(bundle, buildConfig));
            }

        // Create the buildAll function on buildConfig with the proper order here.
        buildConfig.buildAll = function (buildProjectGroup, createBundle) {
            return bu.runSeries(buildSlots);
        }
    },

    createAggregateBundle: function (bundle, buildConfig) {
        bu.outputTaskHeader("Build Bundle");

        // If none of the files that we're going to bundle have changed then don't build bundle.
        // Returns a stream object that can be returned directly.
        var skipStream = bu.checkCanSkipBuildBundle(bundle, buildConfig);
        if (skipStream)
            return skipStream;

        var stream = through();
        // First build the "bundle-debug.js" file
        // once bundle-debug.js is built, we can in parallel built bundle-min.js from it AND bundle.d.ts.
        bu.buildAggregateBundledJS(bundle, buildConfig).on("end", () => {
            bu.runParallel([
                () => bu.minifyAggregateBundledJS(bundle, buildConfig),
                () => bu.buildAggregateBundledDTS(bundle, buildConfig)
            ]).on("end", () => stream.resume().end());
        });
        return stream;
    },

    buildAggregateBundledJS: function (bundle, buildConfig) {
        var sourceFiles = [];
        for (var projectGroup in buildConfig.projectGroups)
            for (var projectId in buildConfig.projectGroups[projectGroup].projects) {
                var project = buildConfig.projectGroups[projectGroup].projects[projectId];
                if (project.aggregateBundle == bundle)
                    sourceFiles.push(bu.joinPath(project.buildFolder, project.debugBundleFilename));
            }
        return bu.buildAggregateBundle(bundle, sourceFiles, false, "Build bundled JS", bundle.outputFolder);
    },
    buildProjectGroupBundle: function (projectGroup) {
        var taskTracker = new bu.TaskTracker("buildProjectGroupBundle (" + projectGroup.name + ")");
        if (!projectGroup.bundleProjectsTogether) {
            // project group not bundled together, so nothing to do here
            return bu.getCompletedStream();
        }

        // Create list of source files for bundle.js; it's the list of bundle files built for the projects in the project group
        var sourceFiles = [];
        for (var projectId in projectGroup.projects) {
            var project = projectGroup.projects[projectId];
            sourceFiles.push(project.buildFolder + "/" + project.debugBundleFilename);
        }

        return bu.runSeries([
            () => bu.buildAggregateBundle(projectGroup.bundleProjectsTogether, sourceFiles, false, "Build project group bundle (" +
                projectGroup.name + ")", projectGroup.bundleProjectsTogether.outputFolder),
            () => bu.buildAggregateBundle(projectGroup.bundleProjectsTogether, sourceFiles, true, "Build project group bundle (" +
                projectGroup.name + ")", projectGroup.bundleProjectsTogether.outputFolder),
            () => {
                if (!projectGroup.bundleProjectsTogether.generateTyping)
                    return bu.getCompletedStream();

                // Create list of typing files we'll bundle
                var typingFiles = [];
                for (var projectId in projectGroup.projects) {
                    var project = projectGroup.projects[projectId];
                    if (project.generateTyping)
                        typingFiles.push(project.buildFolder + "/typings/" + project.typingBundleFilename);
                }

                return gulp.src(typingFiles)
                    .pipe(concat(projectGroup.bundleProjectsTogether.typingFilename))
                    .pipe(gulp.dest(bu.joinPath(".", buildSettings.distPath, "typings")))
                    .on("end", () => taskTracker.end());
            }
        ]);
    },

    // Takes the pre-built bundle-debug.js file and bundle/minify it into bundle-min.js
    minifyAggregateBundledJS: function (bundle) {
        var debugSourceFilename = bu.joinPath(bundle.outputFolder, bundle.debugFilename);
        return bu.buildAggregateBundle(bundle, [debugSourceFilename], true, "Minify bundled JS", bundle.outputFolder);
    },

    // This is passed in one or more already built files (with corresponding sourcemaps); it bundles them into just
    // one file and minifies if so requested.
    buildAggregateBundle: function (bundle, sourceFiles, minify, taskName, destFolder) {
        var taskTracker = new bu.TaskTracker(taskName);
        return gulp.src(sourceFiles)
            .pipe(sourcemaps.init({ loadMaps: true }))
            .pipe(gulpIf(!minify, concat(bundle.debugFilename)))
            .pipe(gulpIf(minify, rename(bundle.minFilename)))
            .pipe(gulpIf(minify, uglify()))
            .pipe(sourcemaps.write(".", {
                includeContent: false, sourceRoot: "/",

                // The sourceRoot and sources' paths from the source files are getting flattened; I need to maintain them
                // separately, so forcibly remove the source root (a slash).
                mapSources: (path) => path.substr(1)
            }))
            .pipe(gulp.dest(destFolder))
            .on("end", () => taskTracker.end());
    },

    // Combines already-built d.ts files that should be included in the passed-in bundle
    buildAggregateBundledDTS: function (bundle, buildConfig) {
        // If bundle doesn't have a typing file name defined, then don't build one.
        if (!bundle.typingFilename)
            return bu.getCompletedStream();

        var taskTracker = new bu.TaskTracker("Build bundled DTS");
        var files = [];
        for (var projectGroup in buildConfig.projectGroups)
            for (var projectId in buildConfig.projectGroups[projectGroup].projects) {
                var project = buildConfig.projectGroups[projectGroup].projects[projectId];
                if (project.aggregateBundle == bundle)
                    files.push(bu.joinPath(project.buildFolder, "typings", project.name + ".d.ts"));
            }
        return gulp.src(files)
            .pipe(concat(bundle.typingFilename))
            .pipe(gulp.dest(bu.joinPath(".", buildSettings.distPath, "typings")))
            .on("end", () => taskTracker.end());
    }
}

module.exports = buildUtils;