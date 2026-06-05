# Why three projects, not one?

> Why did we create 3 small projects for this course plan? Why did we not come up with one project idea & implement all the certification-required concepts there in that one project?

Genuinely good question — and the answer matters because it reveals a tension in the plan worth being honest about.

**Short version**: three projects optimises for the exam; one big project optimises for the portfolio. We picked the former because you said *"the focus to cover the topics required to clear the certificate still is our high priority."* Both choices are defensible.

The longer version has three threads.

## 1. The cert blueprint is structurally three surfaces, not one

The Anthropic stack has three distinct deployment surfaces that the exam tests as separate skills:

- **Agent SDK** — you *build* with it.
- **Claude Code** — you *use* it as a CLI / CI tool.
- **MCP** — you *connect* things with it.

A single unified project will naturally lean toward one surface and short-change the others. Project 1 is Agent SDK + MCP territory. Project 3 is Claude Code + GitHub Actions territory — that one literally cannot live inside the same Next.js app as Project 1, because Claude Code is a separate CLI / agent product. If we'd unified, we'd have either skipped the Claude Code surface (the 20% domain) or shoe-horned it in awkwardly. Three projects map cleanly onto the three surfaces.

## 2. Each project naturally maximises a different domain

Look at where each one peaks:

| Project | Cert domain it stress-tests most |
| --- | --- |
| **Research agent** | Agentic orchestration (27% — the biggest) |
| **Triage agent** | Governance, hooks, evals, vision, structured output |
| **Claude Code CI** | Claude Code config, plugins, sub-agents, headless mode |

A unified *"AI engineering platform"* with all these features would technically cover the same surface area, but the cognitive cost of architecting one coherent thing that does all of it is much higher than three small things that each go deep on one thing. For a two-week sprint with cert-deadline pressure, **time-to-confidence matters more than elegance**.

## 3. The honest concession

There *is* a real argument for one project. A single integrated system is more impressive to a recruiter, mirrors what a real architect would actually build, and exercises composition (sub-agents calling other agents, RAG feeding the triage agent, etc.) in a way three siloed projects don't. The exam doesn't test composition heavily, but real work does. If your priority were *"land a senior AI engineer role"* rather than *"pass the cert,"* I'd have steered toward one platform.

## The retrofit option

The retrofit option you have right now: on **Day 13 (portfolio polish)**, instead of writing three separate READMEs, write **one top-level narrative** that frames the projects as modules of a single AI-engineering platform — research module, support module, CI module. Same code, much stronger story. Project 4 (the RAG study assistant) becomes the knowledge layer that ties them together. From the outside it reads as one coherent system. From the inside, you still got the cert-friendly breadth.

That's actually the move I'd make in your position: **keep the three codebases** (you're 11 days in, don't restructure), **unify the narrative**, **add Project 4 as the connective tissue** post-exam.
