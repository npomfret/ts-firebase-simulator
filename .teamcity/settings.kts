import jetbrains.buildServer.configs.kotlin.*
import jetbrains.buildServer.configs.kotlin.buildSteps.script
import jetbrains.buildServer.configs.kotlin.triggers.schedule
import jetbrains.buildServer.configs.kotlin.triggers.vcs

/*
 * TeamCity settings for ts-firebase-simulator, on ci.snowmonkey.co.uk.
 *
 * All three agents (funmax-mac-1/2/3) are the same Mac -- macstudio -- and it
 * already carries what this project needs: Node 26, first on PATH via nvm.
 *
 * The integration suites run against the real Firebase project
 * fir-simulator-test, NOT against the emulators. The emulators want a JVM and
 * bind fixed ports (firestore 8080, storage 9199, ui 4000) that all three
 * agents would contend for, so they are not something we start on the shared
 * Mac. Run those locally with `npm run test:with-emulator`; please do not add
 * a build configuration that does.
 */

version = "2026.1"

// The CI account has its own copy of the service account key outside the
// checkout, at the path below. The key is in neither git nor TeamCity's store.
// Rotating the key means updating this CI copy as well as the developer's
// own copy.
val realFirebaseKey = "/Users/teamcity/.config/ts-firebase-simulator/service-account-key.json"

// Each leg owns a directory by name, rather than the VCS-settings hash the two would otherwise
// share. It is emptied before checkout, ignored files included, and removed once the build ends,
// however it ends: a node_modules left by an earlier build is what used to fail `npm ci` with
// ENOTEMPTY. Nothing in it is a cache. What outlives a build sits outside it: the agent's Git
// mirror, from which checkout resolves one exact revision, and npm's download cache, which
// `npm ci` checks against the lockfile's integrity hashes. Neither can supply a generated file or
// a test result, so no build here needs an exception.
fun BuildType.onTheMac(workspace: String) {
    maxRunningBuilds = 1
    params {
        param("env.TMPDIR", "%system.teamcity.build.tempDir%")
        param("system.teamcity.build.checkoutDir.expireHours", "0")
    }
    vcs {
        root(DslContext.settingsRoot)
        checkoutDir = workspace
        cleanCheckout = true
    }
}

// Generic rather than the typed builder, following SuperFunMaxMusic: a wrong
// parameter finds no reports and says so, where a wrong symbol stops the script
// compiling.
fun BuildType.keepsWhatVitestSaid(report: String) {
    artifactRules = "test-reports/$report => test-reports"
    features {
        feature {
            type = "xml-report-plugin"
            param("xmlReportParsing.reportType", "junit")
            param("xmlReportParsing.reportDirs", "+:test-reports/$report")
            param("xmlReportParsing.verboseOutput", "true")
        }
    }
}

// Nightly as well as on push, and deliberately not withPendingChangesOnly: a
// night with no commits is exactly when these earn their keep. Every dependency
// is on a caret range, so `npm ci` can resolve a different tree from one day to
// the next without a line of ours changing; Node comes from an nvm install on a
// Mac other projects share; and the integration leg talks to a live Firebase
// project that can change under us entirely. A run that goes red on an
// untouched tree names that as the cause, which a push-triggered build cannot.
fun BuildType.onPushAndNightly(atMinute: Int) {
    triggers {
        vcs {
            branchFilter = "+:<default>"
            perCheckinTriggering = true
        }
        schedule {
            schedulingPolicy = daily {
                hour = 3
                minute = atMinute
                timezone = "Europe/London"
            }
            branchFilter = "+:<default>"
            triggerBuild = always()
            withPendingChangesOnly = false
        }
    }
}

val buildAndUnit = BuildType {
    id("BuildAndUnit")
    name = "Build & Unit"
    description = "Format, typecheck, bundle and the in-memory unit suite. Talks to nothing " +
        "outside the checkout, so it cannot go red for a reason that is not ours."
    onTheMac("ts-firebase-simulator-build-and-unit")
    keepsWhatVitestSaid("unit.xml")
    steps {
        script {
            name = "install"
            scriptContent = "npm ci"
        }
        script {
            name = "format"
            scriptContent = "npm run format:check"
        }
        script {
            name = "typecheck"
            scriptContent = "npm run build:check"
        }
        script {
            name = "bundle"
            scriptContent = "npx tsup"
        }
        script {
            name = "unit"
            scriptContent = "npx vitest run src/__tests__/unit " +
                "--reporter=default --reporter=junit --outputFile.junit=test-reports/unit.xml"
        }
    }
    failureConditions {
        executionTimeoutMin = 15
    }
    onPushAndNightly(atMinute = 30)
}

val integration = BuildType {
    id("Integration")
    name = "Integration"
    description = "The compatibility suites against the real Firebase project " +
        "fir-simulator-test: every assertion is made against the stub and against live " +
        "Firestore and Storage, so a divergence between them fails here. Signed URLs are " +
        "covered on this leg and cannot be covered on the emulator one, which has no key " +
        "to sign with."
    onTheMac("ts-firebase-simulator-integration")
    keepsWhatVitestSaid("integration.xml")
    params {
        param("env.GOOGLE_APPLICATION_CREDENTIALS", realFirebaseKey)
        // Left unset deliberately: the suite derives
        // fir-simulator-test.firebasestorage.app from the key's project id, and that is
        // this project's bucket. Set it only if the bucket is ever renamed.
        // param("env.FIREBASE_STORAGE_BUCKET", "...")
    }
    steps {
        script {
            name = "credentials"
            // Without this the build is worse than useless. isRealFirebaseAvailable()
            // is a file-existence check, so a missing key does not fail the suite --
            // it silently drops the real leg, runs the stub against itself, and reports
            // a green build that proved nothing. Fail loudly here instead.
            scriptContent = "set -eu\n" +
                "if [ ! -f '$realFirebaseKey' ]; then\n" +
                "  echo \"##teamcity[buildProblem description='No service account at $realFirebaseKey - the real Firebase leg would have been skipped silently']\"\n" +
                "  exit 1\n" +
                "fi\n" +
                "echo \"Service account present; the real leg will run.\""
        }
        script {
            name = "install"
            scriptContent = "npm ci"
        }
        script {
            name = "integration"
            scriptContent = "npx vitest run src/__tests__/integration " +
                "--reporter=default --reporter=junit --outputFile.junit=test-reports/integration.xml"
        }
    }
    failureConditions {
        // The suite takes about a minute against live Firebase; the margin is for
        // a slow day on the API rather than for it growing tenfold.
        executionTimeoutMin = 20
    }
    onPushAndNightly(atMinute = 45)
}

project {
    description = "TypeScript-first in-memory Firebase stubs for unit testing."

    // The server-wide default keeps everything forever. The bundle is small but there
    // is no reason to keep every one; the test history is what the Tests tab and flaky
    // detection are built on, so it outlives the artifacts.
    cleanup {
        baseRule {
            artifacts(days = 7)
            history(days = 30)
        }
    }

    buildType(buildAndUnit)
    buildType(integration)
}
