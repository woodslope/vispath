# VisPath Agent Rules

## UI work

VisPath is a dense, desktop-first visual workbench. Before any broad UI change, read:

1. `DESIGN_SYSTEM.md` for executable tokens and component contracts.
2. `UI_STYLE_GUIDE.md` for product language and visual direction.
3. Invoke `xiaobai-coding` and load its `references/design-system-routing.md` and `references/config-workbench-ui.md` references only when the change establishes or changes a shared contract across repeated controls, dialogs, layouts, states, or product-level visual acceptance.

Broad UI work includes page-wide spacing, navigation, panels, cards, forms, dialogs, buttons, icon buttons, tabs, toasts, responsive rules, and repeated component families when the change affects multiple instances or their shared contract. A local adjustment inside one existing component is not broad UI work by itself.

The following user requests are explicit UI-system triggers, even when they do not mention implementation details: `设计规范`, `视觉统一`, `设计系统`, `组件系统`, `组件规范`, `控件规范`, `布局规范`, `状态统一`, `全站统一`, `全页面同步调整`, or `梳理当前应用的设计系统`. For these requests, load `DESIGN_SYSTEM.md`, `UI_STYLE_GUIDE.md`, `xiaobai-coding/references/design-system-routing.md`, and `xiaobai-coding/references/config-workbench-ui.md` before editing; treat the project files as the source of truth and verify the rendered result afterward.

## Task routing

Use the lightest path that matches the actual risk. Do not promote a small UI adjustment to a strict workflow merely because it has a short task list.

### Quick path

Use for local, reversible changes such as copy, spacing, alignment, truncation, Tooltip behavior, a single card detail, or one existing component state that does not change data, APIs, persistence, or the overall workflow.

- Inspect the relevant source and existing contract.
- Make the minimum sufficient edit.
- Rebuild only when the changed source requires it.
- Run one focused check or rendered verification that proves the requested behavior.
- Do not invoke `execute`, full TDD, full `review`, or full experience smoke solely for this class of change.
- Do not create a multi-step progress plan unless the change actually has independent stages.

### Standard path

Use for a shared component behavior, several related UI states, or a contained workflow change with an existing focused test entry. Add or update a focused regression when it materially protects the behavior, then run the smallest relevant surrounding checks.

### Strict path

Reserve `execute` + TDD + review + finish for core workflow changes, persistence or data migration, async generation state machines, cross-module refactors, high-risk changes, or when the user explicitly requests strict execution or test-first development.

## Implementation rules

- Prefer the shared CSS tokens and classes in `styles.css`; do not add one-off sizes for a repeated component.
- Preserve the existing information architecture, product copy, local-first data model, and desktop-only boundary unless the user explicitly changes them.
- Every repeated control must define its default, hover, active, focus, disabled, selected, loading, error, and destructive states when applicable.
- Icon buttons must have a stable icon box, `aria-label`, and `title`. Dialog close buttons use the `dialog-close` contract.
- Do not edit `app.bundle.js` by hand. Run `npm run build:browser` after changing `app.js` or `src/`.

## Validation

Run the smallest relevant checks, then perform rendered verification for visible UI work. The commands below are conditional, not an automatic full suite:

```text
npm run build:browser       # when app.js or src/ changed
npm run test:design-system  # shared design-system or component-contract changes
npm run test:file-open      # static entry or browser bundle changes
npm run test:experience        # page-wide component or layout work
```

For quick-path UI changes, prefer one focused test or one rendered state check plus the required browser build. Do not run `test:experience` unless the change is page-wide, changes the user workflow, or the focused check exposes adjacent risk.

For page-wide UI changes, inspect at least one normal desktop viewport and the 900px desktop breakpoint. Record screenshots or DOM measurements, console errors, horizontal overflow, and the states that were not reachable.

Do not call a visual pass complete based on source inspection alone. Report product-experience evidence separately from build or test evidence.
