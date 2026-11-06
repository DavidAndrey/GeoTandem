// The prompt profile of a connection (plan E3, D9) in words: measured presets,
// never free text. Shared by the connection form and a run's measuring points.
import { t } from '@lingui/core/macro'
import type { PromptProfile } from '../api/client'

export type ExampleSet = PromptProfile['examples']
export type Placement = PromptProfile['placement']
export type OutputMode = PromptProfile['output']

export const EXAMPLE_SETS: ExampleSet[] = ['standard', '12', 'eigene']
export const PLACEMENTS: Placement[] = ['P0', 'P5', 'P9']

/**
 * The placements measured with ``examples``: ``eigene`` only at P0
 * (plan-improve-examples 5, D5; the server refuses the others).
 */
export const placementsFor = (examples: ExampleSet): Placement[] =>
  examples === 'eigene' ? ['P0'] : PLACEMENTS

/** The profile with other examples, its placement moved to P0 where only that is measured. */
export const withExamples = (p: PromptProfile, examples: ExampleSet): PromptProfile => ({
  ...p,
  examples,
  placement: placementsFor(examples).includes(p.placement) ? p.placement : 'P0',
})
export const OUTPUT_MODES: OutputMode[] = ['constrained', 'text']

/** Today's prompt, byte for byte. */
export const DEFAULT_PROMPT_PROFILE: PromptProfile = {
  examples: 'standard',
  placement: 'P0',
  output: 'constrained',
}

export const examplesLabel = (e: ExampleSet) =>
  ({ standard: t`Standard`, '12': t`12 Beispiele`, eigene: t`Eigene (geprüfte Fälle je Frage)` })[e]

/** "Eigene": the examples in a column head or a short line. */
export const examplesShortLabel = (e: ExampleSet) => (e === 'eigene' ? t`Eigene` : examplesLabel(e))

export const placementLabel = (p: Placement) =>
  ({
    P0: t`P0 (wie bisher)`,
    P5: t`P5 (Beispiele vor dem Steckbrief)`,
    P9: t`P9 (Hinweis „erste Frage" als eigene Systemnachricht)`,
  })[p]

export const outputLabel = (o: OutputMode) => ({ constrained: t`erzwungen`, text: t`nur Text` })[o]

export const sameProfile = (a: PromptProfile, b: PromptProfile) =>
  a.examples === b.examples && a.placement === b.placement && a.output === b.output

/**
 * "12 Beispiele · P9 (…) · nur Text": one line for a profile, the placement
 * explained (the run's short line is ``profileShortText``).
 */
export const profileText = (p: PromptProfile) =>
  [examplesLabel(p.examples), placementLabel(p.placement), outputLabel(p.output)].join(' · ')
