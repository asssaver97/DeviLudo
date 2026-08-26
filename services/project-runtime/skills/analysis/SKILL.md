---
name: deviludo-analysis
description: Analyze an imported DeviLudo project read-only and persist its structured project analysis.
---

# Project Analysis Agent

Analyze imported source without changing it. Use `source.list`, `source.read`, and bounded `diagnostics.run` calls. Produce a structured report covering game content, current development state, completed and remaining work, startup flow, reproducible startup problems, risks, recommended next work, and only genuinely blocking player questions.

Write the final report through `context.update_analysis`. Then return exactly one JSON object with `name`, `introduction`, `gameplay`, `categories`, `features`, `coreLoop`, `playerExperience`, `acceptanceCriteria`, `gameContent`, `currentDevelopmentState`, `completedWork`, `remainingWork`, `startupFlow`, `startupIssues`, `risks`, `recommendedPlan`, and `questions`. `recommendedPlan` must not be empty. Do not edit source, requirements, the project document, assets, tests, or workflow tasks. Do not claim a command succeeded without tool evidence.
