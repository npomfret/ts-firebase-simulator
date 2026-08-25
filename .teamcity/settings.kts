import jetbrains.buildServer.configs.kotlin.*
import jetbrains.buildServer.configs.kotlin.buildSteps.script
import jetbrains.buildServer.configs.kotlin.triggers.vcs

/*
 * TeamCity settings for ts-firebase-simulator, on ci.snowmonkey.co.uk.
 *
 * The three agents (funmax-mac-1/2/3) all live on a single Mac and already
 * carry what this project needs: Node 22, first on PATH via nvm. Nothing has
 * to be installed on that box for this build.
 *
 * The emulator compatibility suites under src/__tests__/integration are
 * deliberately NOT here. They need the Firebase emulators, and the emulators
 * are not something we want starting on the shared Mac -- they want a JVM and
 * they bind fixed ports (firestore 8080, storage 9199, ui 4000) that all three
 * agents would contend for. Those tests are run locally, from time to time,
 * with `npm run test:with-emulator`. Please do not add a build configuration
 * that runs them.
 */

version = "2026.1"

val buildAndUnit = BuildType {
    id("BuildAndUnit")
    name = "Build & Unit"
    description = "Format, typecheck, bundle and the in-memory unit suite. Starts no " +
        "emulator and binds no ports, so it can run on any of the three agents at any time."

    maxRunningBuilds = 1
    params {
        param("env.TMPDIR", "%system.teamcity.build.tempDir%")
    }
    vcs {
        root(DslContext.settingsRoot)
    }

    artifactRules = "test-reports/unit.xml => test-reports"
    // Generic rather than the typed builder, following SuperFunMaxMusic: a wrong
    // parameter finds no reports and says so, where a wrong symbol stops the
    // script compiling.
    features {
        feature {
            type = "xml-report-plugin"
            param("xmlReportParsing.reportType", "junit")
            param("xmlReportParsing.reportDirs", "+:test-reports/unit.xml")
            param("xmlReportParsing.verboseOutput", "true")
        }
    }

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
    triggers {
        vcs {
            branchFilter = "+:<default>"
            perCheckinTriggering = true
        }
    }
}

project {
    description = "TypeScript-first in-memory Firebase stubs for unit testing."

    // The server-wide default keeps everything forever. The bundle is small but
    // there is no reason to keep every one; the test history is what the Tests
    // tab and flaky detection are built on, so it outlives the artifacts.
    cleanup {
        baseRule {
            artifacts(days = 7)
            history(days = 30)
        }
    }

    buildType(buildAndUnit)
}
