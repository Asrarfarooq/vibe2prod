import asyncio
import importlib
import os

from google.adk.runners import InMemoryRunner
from google.genai import types

USER_ID = "vibe2prod"


async def run() -> None:
    agent_name = os.environ["AGENT"]
    prompt = os.environ.get("PROMPT", "Start.")
    root_agent = importlib.import_module(f"{agent_name}.agent").root_agent

    runner = InMemoryRunner(agent=root_agent, app_name=agent_name)
    session = await runner.session_service.create_session(app_name=agent_name, user_id=USER_ID)
    message = types.Content(role="user", parts=[types.Part(text=prompt)])

    async for event in runner.run_async(user_id=USER_ID, session_id=session.id, new_message=message):
        if not event.content or not event.content.parts:
            continue
        for part in event.content.parts:
            if part.function_call:
                print(f"[{event.author}] tool call: {part.function_call.name}({part.function_call.args})")
            elif part.function_response:
                print(f"[{event.author}] tool result: {part.function_response.response}")
            elif part.text and not part.thought:
                print(f"[{event.author}] {part.text}")


if __name__ == "__main__":
    asyncio.run(run())
