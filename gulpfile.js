"use strict";

// Load NPM modules
var del = require("del"),
    gulp = require("gulp"),
    gulpWatch = require("gulp-watch");

// Load build support files
var bu = require("./gulpBuild/buildUtils"),
    buildSettings = require("./gulpBuild/buildSettings");


// ************************************************************************************************
// ************************************************************************************************
// **                                                                                            **
// **      buildConfig.js is the only file that you should have to modify for your projects!     **
// **                                                                                            **
// ************************************************************************************************
// ************************************************************************************************

// Load the build configuration.  This defines the ProjectGroups and Projects which will be built
var buildConfig = require("./buildConfig");

// Comment out the above and use the following buildConfigs instead to play with other buildConfigs
// NOTE: Building these does not result in executable apps (e.g. no index.html); they instead show build process.
// var buildConfig = require("./moreExampleBuildEnvs/simpleApp/buildConfig");
// var buildConfig = require("./moreExampleBuildEnvs/simpleLibraryAndApp/buildConfig");
// var buildConfig = require("./moreExampleBuildEnvs/programmaticBuildConfig/buildConfig");
// var buildConfig = require("./moreExampleBuildEnvs/simpleAggregateBundle/buildConfig");
// var buildConfig = require("./moreExampleBuildEnvs/externalModuleReferenceBundle/buildConfig");
// var buildConfig = require("./moreExampleBuildEnvs/externalModuleImportBundle2/buildConfig");
// var buildConfig = require("./moreExampleBuildEnvs/externalModuleImportBundle/buildConfig");

// NOTE: The following buildConfig is not yet working.  I'd like to add sample configurations that demonstrate how
// to use all of the different loaders, and in each case I'll want to include the relevant loader code in the bundle.
// The following sample does do that inclusion, but it's not including the right file.  I need to dig deeper into
// how these loaders are expected to work.
// var buildConfig = require("./moreExampleBuildEnvs/externalModuleImportBundleWithLoader/buildConfig");

// TODO: Add a sample that demonstrates async loading.  Disable bundling.  

// Finish initializing the build configuration by populating default ProjectGroup and Project values.
bu.finishInitializingProjects(buildConfig);


// Used to store global info
var globals = {};


// ====================================================================================================================
// ======= CLEAN ======================================================================================================

function clean() {
    var taskTracker = new bu.TaskTracker("clean");

    // Create list of files to delete.  Start with files that apply across all apps
    var filesToDelete = [
        // Delete /dist and /bld entirely
        bu.joinPath(".", buildSettings.bldPath),
        bu.joinPath(".", buildSettings.distPath),

        // Delete all sourcemaps, everywhere
        "**/*.js.map",
    ];

    // Delete any previously built bundle.d.ts files that were placed into app folders.  Edge case: If you've changed
    // the list of bundles in buildConfig.aggregateBundles, then this won't clean up the detritus of any removed ones.
    for (var bundle in buildConfig.aggregateBundles)
        filesToDelete.push("**/typings/" + buildConfig.aggregateBundles[bundle].typingFilename);

    // Only projects know what should be deleted within them.  In a lot of cases, that can be **/*.js (e.g. in tests)
    // but in other cases it can't be - e.g. samples which have js in them.  So: each project has two choices:
    //  define 'filesToClean:string[] to be an array of globs to delete (in addition to the ones in filesToDeletea above)
    //  don't define filesToClean, in which case it defaults to **/*.js,
    for (var projectGroupId in buildConfig.projectGroups) {
        var projectGroup = buildConfig.projectGroups[projectGroupId];

        // delete filesToClean in this projectgroup
        if (projectGroup.filesToClean) {
            for (var fileToClean of projectGroup.filesToClean)
                filesToDelete.push(fileToClean)
        }

        // delete filesToClean in this projectgroup's Projects
        for (var projectId in projectGroup.projects) {
            var project = projectGroup.projects[projectId];
            if (project.filesToClean) {
                for (var fileToClean of project.filesToClean)
                    filesToDelete.push(bu.joinPath(project.path, fileToClean));
            } else {
                // delete generated bundle files
                filesToDelete.push(bu.joinPath(project.path, project.debugBundleFilename));
                filesToDelete.push(bu.joinPath(project.path, project.minBundleFilename));
                filesToDelete.push(bu.joinPath(project.path, "typings", project.typingBundleFilename));
            }

            // If a project dependsOn another, then we copied its js and d.ts files over (to ./lib and ./typing) - remove them
            if (project.dependsOn) {
                project.dependsOn.forEach((dependency) => {
                    // Get the list of files that were copied over from the dependent project into this project's ./lib
                    // folder and add them.  Include "*" to get .js.map as well
                    if (project.copyDependencyLibs) {
                        filesToDelete.push(bu.joinPath(project.path, "lib", dependency.debugBundleFilename + "*"));
                        filesToDelete.push(bu.joinPath(project.path, "lib", dependency.minBundleFilename + "*"));
                    }
                    // Add the dependent project's d.ts file (if any)
                    if (dependency.generateTyping || (dependency.ts && dependency.ts.options.declaration))
                        filesToDelete.push(bu.joinPath(project.path, "typings", dependency.typingFilename));
                });
            }
        }
    }

    // Perform the actual deletion
    return del(filesToDelete).then(() => taskTracker.end());
}


// ====================================================================================================================
// ======= ROOT TASKS =================================================================================================

// Does a complete rebuild
gulp.task("rebuild-all", function () {
    globals.isBuilding = true;
    if (bu.forceSerializedTasks)
        bu.log("== Forcing serialized tasks ==");

    // Don't do an incremental build
    bu.incrementalBuild = false;

    // Clean and then build.
    return bu.runSeries([
        () => clean(),
        () => buildAll()
    ]);
});

// Builds everything (w/o cleaning first)
gulp.task("build-all", () => buildAll());

function buildAll() {
    // Initialize the build process; clear previous errors, etc
    bu.initialize();

    globals.isBuilding = true;
    if (globals.isFirstBuild) {
        bu.log("== First build; complete build will be performed ==");
        globals.isFirstBuild = false;
    }

    if (bu.forceSerializedTasks)
        bu.log("== Forcing serialized tasks ==");

    // Do an incremental build at the project-level
    bu.incrementalBuild = true;

    return bu.buildAll(buildConfig).on("end", () => onBuildCompleted());
}

// Called when build-all or rebuild-all are finished; checks if any files changed during build and triggers
// a new build-all if so.
function onBuildCompleted() {
    globals.isBuilding = false;
    if (bu.numCompileErrors > 0) {
        if (!bu.buildCancelled)
            bu.log(bu.getTimeString(new Date()) + " Build completed, but with " + bu.numCompileErrors + " errors", true);
        if (buildSettings.reoutputErrorsAtEnd) {
            if (buildSettings.verboseErrorOutput)
                bu.logError(bu.errorList);
            else {
                // output first '#buildSettings.maxErrorsToOutput' errors only
                var numOutput = 0;
                bu.log("ERRORS:");
                for (var error of bu.errorList) {
                    bu.logError(bu.getClickableErrorMessage(error));
                    if (numOutput++ >= buildSettings.maxErrorsToOutput) {
                        bu.log("... +" + (bu.errorList.length - numOutput) + " more errors.", true);
                        break;
                    }
                }
            }
        }
    }
    if (globals.rebuildWhenDoneBuilding) {
        globals.rebuildWhenDoneBuilding = false;
        bu.log(" ", true);
        bu.log("----- Restarting build-all due to filechange during build", true);
        bu.log(" ", true);
        return buildAll();
    }
}

// Watches; also enables incremental builds.
gulp.task('watch', function () {
    // Since this is always running, limit output to errors
    // buildSettings.verboseOutput = false;

    // Because we don't maintain information about files between Task runs, our modifiedCache is always empty
    // at the start, and thus we'll rebuild everything.  Track that it's the first build so that we can output it.
    globals.isFirstBuild = true;

    // Drop a quick command line warning if this is a debug build
    if (buildSettings.debug && buildSettings.warnIfDebugBuild)
        bu.log("This is a debug build.  Once everything is building as expected, consider clearing buildSettings.debug for performance.", true);

    // Watch for changes to .ts files; when they occur, run the 'build-all' task
    var filesToWatch = ["**/*.ts", "!**/*.d.ts", "!dist", "!bld"];
    // Also watch for changes to any JS files that are bundled (since changes to them won't trigger rebuilds)
    for (var projectGroupId in buildConfig.projectGroups) {
        var projectGroup = buildConfig.projectGroups[projectGroupId];
        for (var projectId in projectGroup.projects) {
            var project = projectGroup.projects[projectId];
            if (project.extraFilesToBundle)
                for (var file of project.extraFilesToBundle)
                    filesToWatch.push(bu.joinPath(project.path, file));
        }
    }

    // NOTE: Using gulp-watch instead of gulp.watch, as I'm not getting an 'end' event from the latter and I need it to
    // track rebuilds when using gulp.watch.  I could be using it wrong...
    gulpWatch(filesToWatch, () => {
        // If this is the filechange that triggers the build, then start the build
        if (!globals.isBuilding)
            return buildAll();

        // If we've already previously triggered the need to rebuild during current build, then don't re-output that we'll rebuild
        if (globals.rebuildWhenDoneBuilding)
            return;

        // trigger a rebuild when done building
        bu.log("- File changed while building; will restart build again when done.  Will attempt to cancel the rest of the current build...", true);
        globals.rebuildWhenDoneBuilding = true;

        // Try to cancel the current build.  It won't stop the current 'low-level' task, but can stop subsequent project builds...
        bu.buildCancelled = true;
    });

    // If build settings change then reload them
    gulp.watch(["gulpBuild/buildSettings.js"], ["load-build-settings"]);
});

gulp.task('load-build-settings', function () {
    // Reload our buildSettings.
    buildSettings = bu.requireUncached("./buildSettings");

    // Also update the version cached in buildUtils
    bu.updateBuildSettings(buildSettings);
});
