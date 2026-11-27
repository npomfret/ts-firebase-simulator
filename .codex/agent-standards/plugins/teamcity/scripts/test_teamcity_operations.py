"""Serial unit and transport checks; no live TeamCity changes or real credentials."""

import json
import shlex
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import pytest

from teamcity_operations import BuildOperations, TeamCityClient


pytestmark = pytest.mark.timeout(1)


def test_trigger_resolves_project_configuration_and_defaults_to_composite():
    reads = []

    def read(path):
        reads.append(path)
        return {"buildTypes": {"buildType": [{"id": "Example_AllChecks"}]}}

    operations = BuildOperations(read, "Example", "AllChecks")
    action = operations.trigger(None, "feature/test", 'Reason with "quotes"\nand a newline')
    assert action.expected_build_id is None
    assert reads == ["app/rest/projects/id:Example?fields=buildTypes(buildType(id))"]
    assert (action.method, action.path) == ("POST", "app/rest/buildQueue")
    assert json.loads(action.body) == {
        "buildType": {"id": "Example_AllChecks"}, "branchName": "feature/test",
        "comment": {"text": 'Reason with "quotes"\nand a newline'},
    }


def test_two_projects_use_their_own_configuration_and_reader():
    first = BuildOperations(lambda _: {"buildTypes": {"buildType": [{"id": "One_Checks"}]}}, "One", None)
    second = BuildOperations(lambda _: {"buildTypes": {"buildType": [{"id": "Two_Checks"}]}}, "Two", None)
    assert json.loads(first.trigger("checks", None, "one").body)["buildType"]["id"] == "One_Checks"
    assert json.loads(second.trigger("Two_Checks", None, "two").body)["buildType"]["id"] == "Two_Checks"
    assert "branchName" not in json.loads(first.trigger("Checks", None, "one").body)


def test_trigger_requires_a_target_in_the_project():
    operations = BuildOperations(lambda _: {"buildTypes": {"buildType": []}}, "Example", None)
    with pytest.raises(SystemExit, match="specify trigger --leg"):
        operations.trigger(None, None, "test")
    with pytest.raises(SystemExit, match="No unique configuration"):
        operations.trigger("Other_Checks", None, "test")


def test_rerun_pins_the_recorded_branch_and_every_vcs_revision():
    revisions = [
        {"version": "abc123", "vcsBranchName": "refs/heads/main", "vcs-root-instance": {"id": "17"}},
        {"version": "def456", "vcsBranchName": "refs/heads/main", "vcs-root-instance": {"id": "18"}},
    ]
    source = {"id": 42, "buildTypeId": "Example_Checks", "branchName": "main", "revisions": {"revision": revisions}}
    operations = BuildOperations(lambda _: source, "Example", "AllChecks")
    action = operations.rerun(42, "Retry regression")
    assert action.expected_build_id is None
    body = json.loads(action.body)
    assert (action.method, action.path) == ("POST", "app/rest/buildQueue")
    assert body["buildType"] == {"id": "Example_Checks"}
    assert body["branchName"] == "main"
    assert body["revisions"] == {"revision": revisions, "failOnMissingRevisions": True}
    assert source["revisions"] == {"revision": revisions}


def test_rerun_without_recorded_revisions_refuses_instead_of_building_latest():
    operations = BuildOperations(lambda _: {"id": 42, "buildTypeId": "Example_Checks", "revisions": {}}, "Example", None)
    with pytest.raises(SystemExit, match="no recorded VCS revisions"):
        operations.rerun(42, "Retry")


@pytest.mark.parametrize("state,collection", [("queued", "buildQueue"), ("running", "builds")])
@pytest.mark.parametrize("returned_id", [42, "42"])
def test_cancel_retains_history_and_does_not_requeue(state, collection, returned_id):
    operations = BuildOperations(lambda _: {"id": returned_id, "state": state}, "Example", None)
    action = operations.cancel(42, "Superseded")
    assert action.expected_build_id == 42
    assert (action.method, action.path) == ("POST", f"app/rest/{collection}/id:42")
    assert json.loads(action.body) == {"comment": "Superseded", "readdIntoQueue": False}


def test_cancel_finished_build_does_nothing():
    operations = BuildOperations(lambda _: {"id": 42, "state": "finished"}, "Example", None)
    assert operations.cancel(42, "Already done") is None


@pytest.mark.parametrize("position", ["first", "last"])
def test_move_changes_only_the_selected_build(position):
    operations = BuildOperations(lambda _: {"id": 42, "state": "queued"}, "Example", None)
    action = operations.move(42, position)
    assert action.expected_build_id == 42
    assert (action.method, action.path) == ("PUT", f"app/rest/buildQueue/order/{position}")
    assert json.loads(action.body) == {"id": 42}


def test_move_rejects_a_build_that_has_started():
    operations = BuildOperations(lambda _: {"id": 42, "state": "running"}, "Example", None)
    with pytest.raises(SystemExit, match="not queued"):
        operations.move(42, "first")


@pytest.mark.parametrize("operation,state", [
    ("rerun", "finished"), ("cancel", "queued"), ("cancel", "running"),
    ("cancel", "finished"), ("move", "queued"),
])
@pytest.mark.parametrize("returned_id", [43, "43", None])
def test_id_based_operations_refuse_replaced_or_missing_identity(operation, state, returned_id):
    source = {"state": state, "buildTypeId": "Example_Checks",
              "revisions": {"revision": [{"version": "abc123"}]}}
    if returned_id is not None:
        source["id"] = returned_id
    operations = BuildOperations(lambda _: source, "Example", None)
    with pytest.raises(SystemExit, match="Requested build 42 resolved to"):
        if operation == "move":
            operations.move(42, "first")
        else:
            getattr(operations, operation)(42, "Check identity")


@pytest.mark.parametrize("operation", ["cancel", "move"])
@pytest.mark.parametrize("returned_id", [42, "42", 43, "43", None])
def test_mutation_receipt_must_keep_the_requested_identity_without_retry(operation, returned_id):
    operations = BuildOperations(lambda _: {"id": 42, "state": "queued"}, "Example", None)
    action = operations.move(42, "first") if operation == "move" else operations.cancel(42, "Superseded")
    result = {} if returned_id is None else {"id": returned_id}
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, json.dumps(result), "")

    client = TeamCityClient("host", "teamcity", "http://localhost:8111", lambda: "fake-secret",
                            run, lambda: 0.0, lambda _: None)
    if str(returned_id) == "42":
        assert client.send(action) == result
    else:
        with pytest.raises(SystemExit, match="The operation was sent; do not retry"):
            client.send(action)
    assert len(calls) == 1


@pytest.mark.parametrize("method,path,body", [
    ("POST", "app/rest/buildQueue", {"buildType": {"id": "Example_Checks"}, "comment": {"text": 'a "quote"\n\\café'}}),
    ("PUT", "app/rest/buildQueue/order/last", {"id": 42}),
])
def test_actual_curl_receives_method_json_and_auth_from_stdin(method, path, body):
    observed = []

    class Handler(BaseHTTPRequestHandler):
        def handle_operation(self):
            self.connection.settimeout(0.5)
            observed.append((self.command, self.path, self.headers["Content-Type"],
                             self.headers["Authorization"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            response = b'{"id": 42}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        do_POST = handle_operation
        do_PUT = handle_operation

        def log_message(self, *_):
            pass

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        server.timeout = 0.5
        worker = Thread(target=server.handle_request)
        worker.start()

        def run(argv, **kwargs):
            assert "fake-secret" not in " ".join(argv)
            assert json.dumps(body) not in " ".join(argv)
            remote = shlex.split(argv[-1])
            assert remote[:4] == ["docker", "exec", "-i", "teamcity"]
            return subprocess.run(remote[4:], **kwargs)

        client = TeamCityClient("unused", "teamcity", f"http://127.0.0.1:{server.server_port}",
                                lambda: "fake-secret", run, lambda: 0.0, lambda _: None)
        try:
            assert client.request(method, path, json.dumps(body)) == {"id": 42}
        finally:
            worker.join(0.6)
        assert not worker.is_alive()
    assert observed == [(method, f"/{path}", "application/json", "Bearer fake-secret", body)]


def test_transport_failure_is_redacted_and_never_retried():
    calls, logs = [], []

    def run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 22, "", "error fake-secret")

    client = TeamCityClient("host", "teamcity", "http://localhost:8111", lambda: "fake-secret", run, lambda: 0.0, logs.append)
    with pytest.raises(SystemExit) as failure:
        client.request("POST", "app/rest/buildQueue", "{}")
    assert "fake-secret" not in str(failure.value)
    assert "fake-secret" not in "".join(logs)
    assert "[redacted]" in str(failure.value)
    assert len(calls) == 1


def test_transport_timeout_reports_unknown_outcome_without_retry():
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        assert kwargs["timeout"] == 15
        raise subprocess.TimeoutExpired(argv, 15)

    client = TeamCityClient("host", "teamcity", "http://localhost:8111", lambda: "fake-secret", run, lambda: 0.0, lambda _: None)
    with pytest.raises(SystemExit, match="outcome is unknown"):
        client.request("POST", "app/rest/buildQueue", "{}")
    assert len(calls) == 1
