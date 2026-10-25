// The prompt profile of a connection (plan E3, D9) in words: measured presets,
// never free text. Shared by the connection form and a run's measuring points.
import { t } from '@lingui/core/macro'
import type { PromptProfile } from '../api/client'

export type ExampleSet = PromptProfile['examples']
export type Placement = PromptProfile['placement']
export type OutputMode = PromptProfile['output']

export const EXAMPLE_SETS: ExampleSet[] = ['standard', '12']
export const PLACEMENTS: Placement[] = ['P0', 'P5', 'P9']
export const OUTPUT_MODES: OutputMode[] = ['constrained', 'text']

/** Today's prompt, byte for byte. */
export const DEFAULT_PROMPT_PROFILE: PromptProfile = {
  examples: 'standard',
  placement: 'P0',
  output: 'constrained',
}

export const examplesLabel = (e: ExampleSet) =>
  ({ standard: t`Standard`, '12': t`12 Beispiele` })[e]

export const placementLabel = (p: Placement) =>
  ({
    P0: t`P0 (wie bisher)`,
    P5: t`P5 (Beispiele vor dem Steckbrief)`,
    P9: t`P9 (Hinweis „erste Frage" als eigene Systemnachricht)`,
  })[p]

export const outputLabel = (o: OutputMode) => ({ constrained: t`erzwungen`, text: t`nur Text` })[o]

export const sameProfile = (a: PromptProfile, b: PromptProfile) =>
  a.examples === b.examples && a.placement === b.placement && a.output === b.output
