import jetbrains.buildServer.configs.kotlin.*
import jetbrains.buildServer.configs.kotlin.buildSteps.script
import jetbrains.buildServer.configs.kotlin.triggers.vcs

/*
 * TeamCity settings for ts-firebase-simulator, on ci.snowmonkey.co.uk.
 *
 * The three agents (funmax-mac-1/2/3) all live on a single Mac and already
 * carry what this project needs: Node 22 first on PATH via nvm, and OpenJDK 25,
 * which is what the Firebase emulators run on. Nothing else has to be installed
 * on that box -- firebase-tools is a devDependency, so `npm ci` supplies it.
 */

version = "2026.1"

val emulatorLock = "firebase-emulators"

fun BuildType.onTheMac() {
    maxRunningBuilds = 1
    params {
        param("env.TMPDIR", "%system.teamcity.build.tempDir%")
    }
    vcs {
        root(DslContext.settingsRoot)
    }
}

// Because the three agents share one Mac and firebase.json pins the emulator to
// fixed ports (firestore 8080, storage 9199, ui 4000), two builds starting
// emulators at once would collide on the ports rather than merely on the CPU.
// Quota 1 and a write lock, so the second one waits.
fun BuildType.oneEmulatorSetAtATime() {
    features {
        sharedResources {
            writeLock(emulatorLock)
        }
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

val buildAndUnit = BuildType {
    id("BuildAndUnit")
    name = "Build & Unit"
    description = "Format, typecheck, bundle and the in-memory unit suite. Starts no " +
        "emulator, so it holds no lock and runs beside the integration leg on an agent " +
        "that would otherwise be idle."
    onTheMac()
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
    triggers {
        vcs {
            branchFilter = "+:<default>"
            perCheckinTriggering = true
        }
    }
}

val integration = BuildType {
    id("Integration")
    name = "Integration"
    description = "The compatibility suites against the Firestore and Storage emulators. " +
        "emulators:exec is what sets FIRESTORE_EMULATOR_HOST and " +
        "FIREBASE_STORAGE_EMULATOR_HOST, and those are what switch the emulator leg of " +
        "those suites on -- without them the suites quietly run the stub leg alone and " +
        "pass without proving anything."
    onTheMac()
    oneEmulatorSetAtATime()
    keepsWhatVitestSaid("integration.xml")
    steps {
        script {
            name = "install"
            scriptContent = "npm ci"
        }
        script {
            name = "integration"
            // demo- prefixed project ids never reach a real GCP project.
            scriptContent = "npx firebase emulators:exec " +
                "--project demo-test-project " +
                "--only firestore,storage " +
                "\"npx vitest run src/__tests__/integration " +
                "--reporter=default --reporter=junit --outputFile.junit=test-reports/integration.xml\""
        }
    }
    failureConditions {
        executionTimeoutMin = 25
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

    // The server-wide default keeps everything forever. dist is small, but there is
    // no reason to keep every bundle; the test history is what the Tests tab and
    // flaky detection are built on, so it outlives the artifacts.
    cleanup {
        baseRule {
            artifacts(days = 7)
            history(days = 30)
        }
    }

    buildType(buildAndUnit)
    buildType(integration)

    features {
        feature {
            id = "FIREBASE_EMULATORS_LOCK"
            type = "JetBrains.SharedResources"
            param("name", emulatorLock)
            param("type", "quoted")
            param("quota", "1")
        }
    }
}
