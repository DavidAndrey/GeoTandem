// Whether the level rules are enforced on the model path yet (plan P1). Until
// E2.4 (WP70/WP72) every level behaves as proposal-only: an answer is applied
// by hand, nothing waits for an approval, and a record a new prompt overtakes
// is decided ``proposal_only``. WP72 switches this to ``true``.
export const ENFORCEMENT: boolean = false
