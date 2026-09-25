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
        with urllib.request.urlopen(request, timeout=5) as response:
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


async def main() -> int:
    from google.adk.runners import InMemoryRunner

    runner = InMemoryRunner(agent=root_agent, app_name="hello")
    session = await runner.session_service.create_session(
        app_name="hello", user_id="vibe2prod"
    )
    message = types.Content(role="user", parts=[types.Part(text="Start.")])
    async for event in runner.run_async(
        user_id="vibe2prod", session_id=session.id, new_message=message
    ):
        for part in (event.content.parts or []) if event.content else []:
            if part.function_call:
                print(f"[{event.author}] tool call: {part.function_call.name}")
            elif part.text and not part.thought:
                print(f"[{event.author}] {part.text}")
    return 0
