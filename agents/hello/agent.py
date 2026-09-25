import urllib.request

from google.adk.agents import LlmAgent
from google.adk.planners import BuiltInPlanner
from google.genai import types

METADATA_EMAIL_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"


def whoami() -> dict:
    """Returns the identity this job runs as, read from the metadata server."""
    request = urllib.request.Request(
        METADATA_EMAIL_URL, headers={"Metadata-Flavor": "Google"}
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310 - fixed metadata-server URL
            return {"identity": response.read().decode()}
    except OSError as err:
        return {"error": str(err)}


root_agent = LlmAgent(
    name="hello",
    model="gemini-3.8-flash",
    instruction="Call the whoami tool, then reply with one sentence stating the identity you run as.",
    tools=[whoami],
    planner=BuiltInPlanner(
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.HIGH)
    ),
)
