<!-- Fixture: the workflow-walkthrough step index in Trellis's real format.
     Refresh from a live project with:
       python3 .trellis/scripts/get_context.py --mode phase
     Only the step lines and phase headings matter to Atlas; the prose around them
     is trimmed here on purpose. -->

## Phase Index

Phase 1: Plan    → classify, get task-creation consent, then write planning artifacts
Phase 2: Execute → implement only after task status is in_progress
Phase 3: Finish  → verify, update spec, commit, and wrap up

### Phase 1: Plan
- 1.0 Create task `[required · once]` (only after task-creation consent)
- 1.1 Requirement exploration `[required · repeatable]` (`prd.md`; complex tasks also need `design.md` + `implement.md`)
- 1.2 Research `[optional · repeatable]`
- 1.3 Configure context `[required · once]` — Claude Code, Cursor, OpenCode, Codex, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, ZCode, Reasonix (sub-agent-dispatch platforms only; inline platforms skip)
- 1.4 Activate task `[required · once]` (review gate, then `task.py start`; status → in_progress)
- 1.5 Completion criteria

### Phase 2: Execute
- 2.1 Implement `[required · repeatable]`
- 2.2 Quality check `[required · repeatable]`
- 2.3 Rollback `[on demand]`

### Phase 3: Finish
- 3.2 Debug retrospective `[on demand]`
- 3.3 Spec update `[required · once]`
- 3.4 Commit changes `[required · once]`
- 3.5 Wrap-up reminder

### Rules

- The `[required · once]` marker is the enforcement contract: a step carrying it must
  surface in the per-turn breadcrumb, otherwise the AI silently skips it.

### Loading Step Detail

Run `get_context.py --mode phase --step 1.1` for a single step's detail.

<!-- Per-turn breadcrumb: shown when there is no active task (before Phase 1) -->

[workflow-state:no_task]
No active task. First classify the current turn and ask for task-creation consent.
[/workflow-state:no_task]

<!-- Per-turn breadcrumb: shown throughout Phase 1 (status='planning') -->

[workflow-state:planning]
Load `trellis-brainstorm`; stay in planning.
[/workflow-state:planning]

<!-- Per-turn breadcrumb: shown while status='in_progress' -->

[workflow-state:in_progress]
Flow: implement -> check -> update spec -> commit.
[/workflow-state:in_progress]
