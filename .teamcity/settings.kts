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

// The service account already lives on the agent host, which is the same Mac
// the checkout of this project sits on. Pointing at it in place means the key
// is in neither git nor TeamCity's store -- there is no extra copy to leak,
// and nothing to rotate in two places.
val realFirebaseKey = "/Users/nickpomfret/projects/ts-firebase-simulator/service-account-key.json"

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

// TEMPORARY, removed once the evidence is recorded. Each run confirms the exact revision, checks
// every seed by path, because a clean `git status` cannot see inside .git, then seeds the workspace
// again. The .git seed is what separates emptying the directory from `git clean` and a reset.
// Pinned to one agent, or a later run could land on an agent that never saw the seed and prove
// nothing, and so that the control runs alone there and can report the other workspaces.
//   ProbeControl: nothing cleans, so every seed must survive. Without this the other two could
//   pass only because nothing was ever left to find. Lists its sibling directories, which shows
//   whether ProbeBuildCleanup's has gone without waiting for that probe's own next run.
//   ProbeCleanCheckout: only the emptying before checkout acts, so a survivor shows it failed.
//   ProbeBuildCleanup: only the removal after a build acts, so a survivor shows it failed. Run 2
//   fails on purpose and run 3 is stopped by the execution timeout. The sentinel it publishes shows
//   whether a build's evidence leaves before the directory goes, under the same default publishing
//   mode as the real legs.
fun workspaceProbe(
    probeId: String,
    probeName: String,
    clean: Boolean,
    expireHours: String,
    seedSurvives: Boolean,
    endsBadly: Boolean,
) = BuildType {
    id(probeId)
    name = probeName
    maxRunningBuilds = 1
    artifactRules = "probe-sentinel.txt => evidence"
    vcs {
        root(DslContext.settingsRoot)
        checkoutDir = "ts-firebase-simulator-" + probeId.lowercase()
        cleanCheckout = clean
    }
    params {
        param("system.teamcity.build.checkoutDir.expireHours", expireHours)
    }
    requirements {
        equals("teamcity.agent.name", "macstudio-2")
    }
    val ending = if (endsBadly) {
        "case %build.counter% in " +
            "2) echo 'PROBE controlled failure'; exit 1 ;; " +
            "3) echo 'PROBE waiting for the execution timeout'; sleep 150 ;; " +
            "esac"
    } else {
        ""
    }
    steps {
        script {
            name = "probe"
            scriptContent = """
                set -eu
                echo "PROBE run=%build.counter% agent=%teamcity.agent.name%"
                test "$(git rev-parse HEAD)" = "%build.vcs.number%"
                echo "PROBE exact revision %build.vcs.number%"
                echo "PROBE workspaces: $(ls -d ../ts-firebase-simulator-* | tr '\n' ' ')"
                wrong=0
                for f in .git/probe-sentinel probe-sentinel.txt dist/stale.js node_modules/.stale test-reports/unit.xml tmp/stale.log; do
                    if [ -e "${'$'}f" ]; then found=yes; else found=no; fi
                    echo "PROBE ${'$'}f found=${'$'}found"
                    if [ %build.counter% -gt 1 ] && [ "$seedSurvives" = "true" ]; then
                        if [ "${'$'}found" = "no" ]; then wrong=1; fi
                    elif [ "${'$'}found" = "yes" ]; then
                        wrong=1
                    fi
                done
                if [ "${'$'}wrong" = "1" ]; then echo "PROBE UNEXPECTED"; exit 3; fi
                echo "PROBE as expected"
                mkdir -p dist node_modules test-reports tmp
                echo stale > .git/probe-sentinel
                echo stale > probe-sentinel.txt
                echo stale > dist/stale.js
                echo stale > node_modules/.stale
                echo '<testsuites/>' > test-reports/unit.xml
                echo stale > tmp/stale.log
                echo "PROBE seeded"
                $ending
            """.trimIndent()
        }
    }
    triggers {
        schedule {
            schedulingPolicy = cron {
                seconds = "0"
                minutes = "*/3"
                hours = "*"
                dayOfMonth = "*"
                month = "*"
                dayOfWeek = "?"
            }
            branchFilter = "+:<default>"
            triggerBuild = always()
            withPendingChangesOnly = false
        }
    }
    failureConditions {
        executionTimeoutMin = 1
    }
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
    buildType(workspaceProbe("ProbeControl", "Probe: control", false, "1", true, false))
    buildType(workspaceProbe("ProbeCleanCheckout", "Probe: clean checkout", true, "1", false, false))
    buildType(workspaceProbe("ProbeBuildCleanup", "Probe: build cleanup", false, "0", false, true))
}
