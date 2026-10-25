// Prompt profiles of a measuring point (plan E3, D9): the three choices with
// their German labels, built from the contract's literal types in this one
// place. WP91 adds ``admin/promptProfile.ts`` with the same lists for the
// connection form and stores a profile on the connection; then this file
// re-exports those lists, ``connectionProfile`` reads the connection's field
// and ``applyProfile`` sends it with the connection's PATCH (V6.4).
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { ConnectionInfo, PromptProfile } from '../../api/client'

export type Examples = PromptProfile['examples']
export type Placement = PromptProfile['placement']
export type Output = PromptProfile['output']

/** Today's prompt byte for byte (D9). */
export const DEFAULT_PROFILE: PromptProfile = {
  examples: 'standard',
  placement: 'P0',
  output: 'constrained',
}

const EXAMPLE_LABELS: Record<Examples, MessageDescriptor> = {
  standard: msg`Standard`,
  '12': msg`12 Beispiele`,
}
const PLACEMENT_LABELS: Record<Placement, MessageDescriptor> = {
  P0: msg`P0`,
  P5: msg`P5`,
  P9: msg`P9`,
}
const OUTPUT_LABELS: Record<Output, MessageDescriptor> = {
  constrained: msg`erzwungen`,
  text: msg`nur Text`,
}

export const EXAMPLES = Object.keys(EXAMPLE_LABELS) as Examples[]
export const PLACEMENTS = Object.keys(PLACEMENT_LABELS) as Placement[]
export const OUTPUTS = Object.keys(OUTPUT_LABELS) as Output[]

export const examplesText = (value: Examples) => i18n._(EXAMPLE_LABELS[value])
export const placementText = (value: Placement) => i18n._(PLACEMENT_LABELS[value])
export const outputText = (value: Output) => i18n._(OUTPUT_LABELS[value])

/** "Standard · P0 · erzwungen". */
export const profileText = (p: PromptProfile) =>
  [examplesText(p.examples), placementText(p.placement), outputText(p.output)].join(' · ')

export const sameProfile = (a: PromptProfile, b: PromptProfile) =>
  a.examples === b.examples && a.placement === b.placement && a.output === b.output

export const isDefaultProfile = (p: PromptProfile) => sameProfile(p, DEFAULT_PROFILE)

/** The profile the connection uses in operation. Until WP91 every connection has today's prompt. */
export const connectionProfile = (connection: ConnectionInfo | undefined): PromptProfile => {
  void connection
  return DEFAULT_PROFILE
}

/**
 * Sets the profile on the connection (V6.4, audited as ``llm_connection_changed``);
 * ``null`` while the connection cannot store one (WP91 brings the field).
 */
export const applyProfile:
  ((connectionId: number, profile: PromptProfile) => Promise<unknown>) | null = null
