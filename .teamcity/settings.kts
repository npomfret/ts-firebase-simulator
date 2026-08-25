import jetbrains.buildServer.configs.kotlin.*
import jetbrains.buildServer.configs.kotlin.buildFeatures.xmlReport
import jetbrains.buildServer.configs.kotlin.buildSteps.script
import jetbrains.buildServer.configs.kotlin.triggers.vcs
import jetbrains.buildServer.configs.kotlin.vcs.GitVcsRoot

/*
 * TeamCity settings for ts-firebase-simulator, on ci.snowmonkey.co.uk.
 *
 * The three build agents (funmax-mac-1/2/3) all live on a single Mac. They
 * already carry what this project needs: Node 22 first on PATH via nvm, and
 * OpenJDK 25, which is what the Firebase emulators run on. Nothing else has to
 * be installed on that box -- firebase-tools is a devDependency here, so
 * `npm ci` supplies it.
 *
 * Because the agents share one host and firebase.json pins the emulator to
 * fixed ports (firestore 8080, storage 9199, ui 4000), two integration builds
 * running at once would collide. The `firebase-emulators` shared resource
 * below serialises them, the same way SuperFunMaxMusic serialises Xcode.
 */

version = "2026.1"

project {
    description = "TypeScript-first in-memory Firebase stubs for unit testing."

    vcsRoot(Repo)

    buildType(BuildAndUnit)
    buildType(Integration)

    features {
        feature {
            id = "FIREBASE_EMULATORS_LOCK"
            type = "JetBrains.SharedResources"
            param("name", "firebase-emulators")
            param("type", "quoted")
            param("quota", "1")
        }
    }
}

object Repo : GitVcsRoot({
    name = "https://github.com/npomfret/ts-firebase-simulator#refs/heads/main"
    url = "https://github.com/npomfret/ts-firebase-simulator.git"
    branch = "refs/heads/main"
    branchSpec = "+:refs/heads/*"
    // Public repo, so anonymous HTTPS: no token to store, rotate, or leak.
    authMethod = anonymous()
})

object BuildAndUnit : BuildType({
    name = "Build & Unit"
    description = "Format, typecheck, bundle, and run the in-memory unit tests. " +
        "Touches no emulator, so it holds no lock and can run beside anything else on the Mac."

    artifactRules = "dist => dist"

    vcs {
        root(Repo)
    }

    params {
        param("env.TMPDIR", "%system.teamcity.build.tempDir%")
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

    triggers {
        vcs {
            branchFilter = "+:<default>"
        }
    }

    features {
        xmlReport {
            reportType = XmlReport.XmlReportType.JUNIT
            rules = "+:test-reports/unit.xml"
            verbose = true
        }
    }

    failureConditions {
        executionTimeoutMin = 15
    }

    maxRunningBuilds = 1
})

object Integration : BuildType({
    name = "Integration"
    description = "Runs the compatibility suites against the Firestore and Storage emulators. " +
        "Holds the firebase-emulators lock, because all three agents share one Mac and the ports are fixed."

    vcs {
        root(Repo)
    }

    params {
        param("env.TMPDIR", "%system.teamcity.build.tempDir%")
    }

    steps {
        script {
            name = "install"
            scriptContent = "npm ci"
        }
        script {
            name = "integration"
            // emulators:exec sets FIRESTORE_EMULATOR_HOST and
            // FIREBASE_STORAGE_EMULATOR_HOST, which is what switches the
            // emulator leg of these suites on. Without it they silently run
            // the stub leg only and pass without proving anything.
            // demo- prefixed project ids never touch a real GCP project.
            scriptContent = "npx firebase emulators:exec " +
                "--project demo-test-project " +
                "--only firestore,storage " +
                "\"npx vitest run src/__tests__/integration " +
                "--reporter=default --reporter=junit --outputFile.junit=test-reports/integration.xml\""
        }
    }

    triggers {
        vcs {
            branchFilter = "+:<default>"
        }
    }

    features {
        xmlReport {
            reportType = XmlReport.XmlReportType.JUNIT
            rules = "+:test-reports/integration.xml"
            verbose = true
        }
        feature {
            type = "JetBrains.SharedResources"
            param("locks-param", "firebase-emulators writeLock")
        }
    }

    failureConditions {
        executionTimeoutMin = 25
    }

    maxRunningBuilds = 1
})
