from pathlib import Path
from unittest import mock

from common.context import RunContext

from deploy import agent


def test_workflow_builds():
    run = RunContext("r", "deploy", "p", "o/r", "main", None, "flawed", Path("/tmp/w"))
    workflow = agent.build(
        run, mock.Mock(), mock.Mock(), mock.Mock(), mock.Mock(), {"stages": {}}
    )
    assert workflow.name == "deploy"
    assert agent.AuditReport.model_json_schema()["required"] == [
        "summary",
        "markdown",
        "notes",
        "judged_checks",
    ]
