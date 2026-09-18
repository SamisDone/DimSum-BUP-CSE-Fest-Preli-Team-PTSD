/**
 * Guardrail Validator — owned by role B.
 * Always returns exactly nNotes valid Directives. Never throws.
 * See ACTION_PLAN.md §3, §B.
 *
 * STUB: ignores whatever interpret() produced and emits one no_op per note.
 * Replace with real validation/repair logic.
 */

import type { Battery, Directive } from "./types";

export function guard(raw: unknown[], nNotes: number, battery: Battery): Directive[] {
  return Array.from({ length: nNotes }, (_, note_index) => ({
    note_index,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation: "stub: guardrails not yet implemented",
  }));
}
