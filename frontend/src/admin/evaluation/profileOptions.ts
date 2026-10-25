// Prompt profiles of a measuring point (plan E3, D9): the lists and words are
// the connection form's (``admin/promptProfile.ts``, WP91); here only what a
// run adds: the short placement name for selects and column heads, one short
// line for a profile (``profileShortText``; the form's long one is
// ``profileText``), the connection's own profile and applying a measured one to
// the connection (V6.4).
import { t } from '@lingui/core/macro'
import { api, type ConnectionInfo, type PromptProfile } from '../../api/client'
import {
  DEFAULT_PROMPT_PROFILE,
  examplesLabel,
  outputLabel,
  sameProfile,
  type Placement,
} from '../promptProfile'

/** "P9": the short name; the connection form explains it in full (``placementLabel``). */
export const placementText = (value: Placement) => ({ P0: t`P0`, P5: t`P5`, P9: t`P9` })[value]

/** "Standard · P0 · erzwungen": a profile in one short line, the placement by its name. */
export const profileShortText = (p: PromptProfile) =>
  [examplesLabel(p.examples), placementText(p.placement), outputLabel(p.output)].join(' · ')

/** The profile the connection uses in operation (D9). */
export const connectionProfile = (connection: ConnectionInfo | undefined): PromptProfile =>
  connection?.prompt_profile ?? DEFAULT_PROMPT_PROFILE

/** Whether a point measures the connection's own profile. */
export const isOwnProfile = (connection: ConnectionInfo | undefined, profile: PromptProfile) =>
  sameProfile(connectionProfile(connection), profile)

/**
 * Sets the profile on the connection (V6.4) with the connection's PATCH; the
 * server audits it as ``llm_connection_changed`` (O8).
 */
export const applyProfile = (connectionId: number, profile: PromptProfile) =>
  api.admin.updateConnection(connectionId, { prompt_profile: profile, confirm_data_release: false })
