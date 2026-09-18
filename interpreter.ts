/**
 * LLM Interpreter — owned by role B.
 * Raw, UNTRUSTED model output. May be malformed. Never called directly by
 * index.ts — always passed through guard() first. See ACTION_PLAN.md §3, §B.
 *
 * STUB: returns no directives. Replace with the real model call.
 */

import type { Battery } from "./types";

export async function interpret(notes: string[], battery: Battery): Promise<unknown[]> {
  return [];
}
