// `test` for every spec: fails a test in which the browser refused something
// under the Content-Security-Policy (security review #7), so the policy is
// checked on every screen the suite visits.
import { test as base, expect } from '@playwright/test'

export * from '@playwright/test'

export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
          violations.push(message.text())
        }
      })
      await use(violations)
      expect(violations, 'Content-Security-Policy violations').toEqual([])
    },
    { auto: true },
  ],
})
