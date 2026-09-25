# agents

The four ADK agents (CodeGuard, Architect + Critic, IaC + Cost, Deploy + Audit), built into one image and run as Cloud Run Jobs.

- `main.py`: entrypoint. Loads `<AGENT>/agent.py` (`root_agent`) and runs it once with `PROMPT`.
- `hello/`: hello-world agent that checks the Job's Agent Identity can call Gemini and run a tool.
- Each Job sets `AGENT=<folder>` and deploys with `--functional-type=agent --identity-type=agent-identity` (see `../cloudbuild.yaml`).
