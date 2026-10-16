# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First
**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes
**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution
**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

# Household Finance App

A personal, local-only finance app for one household: checkbook-style account registers and household budgeting, with reports by category. It runs on the owner's Mac and is used in a browser at localhost.

## About the developer
The owner has JavaScript experience from ServiceNow (business rules, client scripts) but has not built a full application from the ground up, and is new to Node server patterns. Explain structure and reasoning in plain terms. Assume they will read and edit the code themselves.

## Stack
- Node.js (current LTS), plain HTML/CSS/vanilla JavaScript on the frontend, SQLite for storage.
- No build step and no frontend framework.
- The server binds to 127.0.0.1 only. It is never exposed to the network unless the owner explicitly asks.
- SQLite driver: propose the specific choice (Node's built-in module if it is stable in the installed Node version, otherwise a well-known package) and get approval before using it. This is the one dependency we expect.

## How we work
- Plan first. Propose an approach and wait for approval before writing code.
- Build in small steps, one feature at a time.
- After each step, recap in plain terms: what changed, why, and how to try it.
- Commit after each approved step with a small, clearly worded message. Run the tests before committing.
- Ask before adding any dependency. State what it does, why it's needed, and what the alternative would be. Default to fewer packages.

## Code style
- Write generous "why" comments that explain intent, not just mechanics.
- Prefer simple and readable over clever. Plain functions and few abstractions.
- Keep all database access in one isolated module so storage details don't leak into the rest of the app.
- 

## Money and data rules
- **Integer cents everywhere.** Store and calculate amounts as whole cents. Convert to dollars only for display. Never use floating-point for money.
- **Real data lives outside the project folder** (for example `~/FinanceData/`), at a path set by config or an environment variable. Never commit it. Keep data files, backups, and `.env` in `.gitignore`.
- **Development and tests use sample data only.** Do not read or modify the real data file during development.
- **Back up before risk.** Make a timestamped copy of the data file before any import or schema change.
- **Confirm before destructive actions.** Deleting accounts or transactions needs an explicit confirmation in the UI, and Claude must ask before running any script that deletes or overwrites data.

## Testing
- Automated tests for money math (balances, budget totals) and CSV import parsing only. Use Node's built-in test runner.
- No automated UI tests.

## Features and phases
1. **Registers:** accounts (checking, savings, credit card), transactions with running balance, cleared/reconciled marking, editable categories, CSV import and export.
2. **Budget:** monthly planned vs. actual per category. The budgeting model is still open; start simple and flag it if envelope-style budgeting seems worth revisiting.
3. **Reports/dashboard:** views of spending by category, built on the categorization data from phase 1.

Design categorization from the start so reporting works later. Categorization will include broad top-level categories (i.e. Utilities, Auto, etc) followed by secondary sub-categories (i.e. Electric, Water, Car Insurance, Car Loan, etc). Ask about different forms of income and expenses to guide categorization. Recommend top-level categories and secondary sub-categories and ask for verification before creating. Ask before building split transactions (one transaction spread across several categories). 

## Interface
- The primary screen is a register: a spreadsheet-like transaction grid with fast, keyboard-friendly entry, much like a paper checkbook register.
- Reports and a dashboard come later and can be more visual, but keep them simple.

## Sharing (future, not now)
A second person may use the app later. Do not build login, multi-user, or sync code now. Keep the data layer isolated so any sharing approach stays possible.

## Out of scope
- No live bank connections or bank logins. Data comes from manual entry and CSV import.
- No cloud hosting or accounts.
- No recurring transactions, multi-currency, or investment tracking unless requested.

## Commands
(Fill in once the project exists: start the app, run tests, run the backup.)
