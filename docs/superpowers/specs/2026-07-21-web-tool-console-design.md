# Web Tool Console Design

Date: 2026-07-21

## Goal

Add a small, polished web console that gives one user direct access to the same live BizHawk and NHL94 tools exposed to MCP clients. Add four semantic NHL94 write tools for common game-state edits.

## Scope

The console provides:

- a backend selector;
- a searchable, type-ahead tool selector;
- a form generated from the selected tool's MCP input schema;
- visible defaults and help for optional parameters;
- a Run button; and
- a result panel for text, images, and errors.

The new semantic tools are:

- `nhl94_set_score`;
- `nhl94_set_line`;
- `nhl94_add_penalty`; and
- `nhl94_remove_penalty`.

This is a personal utility. It will not include accounts, a database, persistent history, a frontend framework, a separate frontend build pipeline, or a new general-purpose internal abstraction layer.

## Architecture

The existing process gains a second HTTP listener dedicated to the web console. The `/mcp` behavior remains unchanged. This deployment binds both listeners to `10.245.0.226`.

The web listener serves one dependency-free HTML/CSS/JavaScript application and two narrow endpoints:

- `GET /api/tools` obtains the current MCP tool catalog; and
- `POST /api/call` forwards one tool name and arguments to the existing MCP endpoint and returns its content.

The proxy uses the existing MCP endpoint as the source of truth. Tool availability, schemas, validation, queueing, usage logging, and result semantics therefore remain identical for MCP and web callers.

The web listener defaults to the MCP host on port `8767` and can be changed with `WEB_HTTP_HOST` and `WEB_HTTP_PORT`. It accepts clients only from `127.0.0.0/8` and `10.245.0.0/16`. Other source addresses receive a forbidden response before static assets or API data are served.

## Interface

The page uses the approved focused-console layout: a narrow centered work surface, dark neutral palette, green connected-state accent, restrained borders, and compact monospace details.

The header contains the product name, connection state, and backend selector. Backend options come from `bizhawk_list_backends`; the selected target is inserted automatically for tools that require it.

The searchable tool selector matches tool names and descriptions. Selecting a tool shows its description and generates inputs from its JSON Schema:

- required parameters appear first;
- optional parameters appear in a separate collapsible section;
- schema defaults are prefilled and visibly identified;
- enums use selects;
- booleans use checkboxes;
- primitive strings and numbers use native inputs; and
- nested objects and arrays use a JSON textarea with parse-error feedback.

Submitting calls the proxy once and disables the Run button until the response arrives. `Ctrl+Enter` or `Cmd+Enter` also submits. The result panel renders MCP text content as readable preformatted text, image content inline, and errors as concise messages. No result persistence is required.

## NHL94 Write Tools

### `nhl94_set_score`

Inputs are `target`, `home`, and `away`. Scores are nonnegative integers constrained by the actual backing field width. The tool writes both scores together and reads both back before returning.

### `nhl94_set_line`

Inputs are `target`, `team`, and `line`. `team` is `home` or `away`; `line` is `Sc1`, `Sc2`, or `Chk`. The tool writes the appropriate selected-line field and returns its decoded readback.

### `nhl94_add_penalty`

Inputs are `target`, one player selector, `penalty_type`, and `duration_seconds`. The penalty type accepts the full known retail penalty enum. Duration accepts any nonnegative whole number supported by the backing field, including intentionally nonstandard combinations such as six-minute tripping.

A player can be selected either by live entity slot (`s0` through `s11`) or by team plus player identity. Team/player selection resolves to exactly one live entity before any write. No write occurs when the identity is absent or ambiguous; the error reports useful candidate matches.

The tool applies all fields needed to place the skater in the penalty box, then reads back the affected penalty state.

### `nhl94_remove_penalty`

The tool uses the same two player-selection forms. It clears the selected skater's active penalty/box state and reads the result back. It does not clear unrelated skaters' penalties.

### Documentation contract

All four definitions use the repository's existing `PURPOSE / USAGE / BEHAVIOR / RETURNS` description style. `nhl94_recipes` gains concise examples for setting the score, selecting either team's line, adding standard and arbitrary-duration penalties, removing a penalty, choosing players by slot or identity, and verifying the result.

## Errors

The UI distinguishes connection failures, invalid form values, MCP tool errors, and successful results. It keeps the entered arguments after an error so they can be corrected and retried.

The semantic NHL94 tools validate all arguments and resolve the active NHL94 RAM domain before writing. Multi-field changes are sent as a single batched operation where the bridge supports it. Each successful tool performs immediate readback; a mismatched readback is returned as an error rather than reported as success.

## Verification

Focused automated tests cover:

- allowed and rejected web-client addresses;
- tool listing and tool-call proxying, including text, image, and error content;
- representative schema-to-form behavior and JSON parsing;
- the four new tool schemas and descriptions;
- player selection by slot and by team/player identity;
- ambiguous or missing player resolution without writes;
- known penalty types with standard and arbitrary durations;
- score, line, penalty-add, and penalty-remove write batches and readback;
- the new `nhl94_recipes` guidance; and
- preservation of the existing MCP transport and tool surface.

The implementation is complete when the focused tests and the repository's full existing test suite pass.
