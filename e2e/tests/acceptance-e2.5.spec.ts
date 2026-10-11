import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "./test";
import { ensureAccount, signIn } from "./accounts";
import { ensureAreaLayer, reference, watchQueries } from "./reference";

// Acceptance E2.5 (etappen.md 4, docs/plan-e2.3-e2.6.md WP79): "Dieselbe
// Fragestellung ist über beide Arbeitsweisen lösbar, beide münden in denselben
// Analysezustand, und Herleitung, Schrittzahl und Ergebnis sind nebeneinander
// einsehbar."
//
// Against the model stub (e2e/model-stub; its environment as in
// acceptance-e2.3.spec.ts), with the levels of the contract fixture
// schema/model-cases/v1.json set up through the admin API and put back after.
// The fixture's direct and chain answers share the reference question's
// prompt, so each approach has a connection of its own: the direct one answers
// by prompt, the chain ones force their case (…/case/<id>/v1, the stub's doc):
//
//   E25 direkt      by prompt: the reference answer, the 9-step plan (step_limit)
//   E25 Kette       chain_reference for every request, re-plans included
//   E25 Halt        the same, a re-plan held HOLD_S seconds (…/hold/<s>, the
//                   stub's doc): the steps take milliseconds, so this is what
//                   keeps a run "running" long enough to watch and abort it
//   E25 abweichend  compare_differs: 800 m and Steueranlage > 1.65 (11 hits)
//
// A re-plan follows an empty step before the last (P4). The tests that need
// one empty step 4 by hand (M8.3: Steueranlage > 99); the stub answers the
// re-plan with the whole plan again, five steps after four that ran: nine,
// one beyond the limit (P4: re-planned steps count).
//
// The data release of the connections is on (local: the default), and still
// no row content reaches the model (D9, D10): the last test searches every
// request the stub received for a planted sentinel and for the schools' names.

const STUB = process.env.E2E_STUB_URL;
const CONTROL = process.env.E2E_STUB_CONTROL;
const MODEL = "stub-model";

const DIRECT = "E25 direkt";
const CHAIN = "E25 Kette";
const HOLD = "E25 Halt";
const DIFFERS = "E25 abweichend";
const HOLD_S = 15;
const ANALYST = "e2e.abnahme.e25";

/**
 * The comparison dialog (design M10.1–M10.3) is WP78's, built at the same time
 * as this test. Its test below runs once WP78 is merged and this is true.
 */
const COMPARISON_DIALOG = true;

// The sentinel (D10, like S7): a point layer of its own, visible to the model
// by its name and attributes, whose rows say something that must never leave.
const SENTINEL_LAYER = "e25_sentinel";
const SENTINEL_NAME = "Sentinelschule Quokka 4402";
const SENTINEL_CODE = "zz_sentinel_e25";
const SENTINELS = [SENTINEL_NAME, SENTINEL_CODE, "2600123.5"];

interface PlannedStep {
  text: string;
  tool: string;
  arguments: Record<string, unknown>;
}
interface FixtureCase {
  id: string;
  prompt: string;
  answer?: { steps?: PlannedStep[] };
  expect?: {
    comparison?: {
      only_left: { id: number; name: string }[];
      only_right: { id: number; name: string }[];
      reason: unknown;
    };
  };
}
interface FixtureLevel {
  name: string;
  selectable: boolean;
  is_default?: boolean;
  matrix: Record<string, string>;
}
const fixtureFile = JSON.parse(
  readFileSync(
    new URL("../../schema/model-cases/v1.json", import.meta.url),
    "utf-8",
  ),
) as { levels: FixtureLevel[]; cases: FixtureCase[] };
const fixture = (id: string) => fixtureFile.cases.find((c) => c.id === id)!;
const PROMPT = fixture("reference").prompt;
const PLAN = fixture("chain_reference").answer!.steps!;

interface StoredLevel {
  id?: number | null;
  name: string;
  selectable: boolean;
  is_default: boolean;
  matrix: Record<string, string>;
  [field: string]: unknown;
}

interface Step {
  position: number;
  status: string;
  hits: number | null;
  cell: string;
  model_view: Record<string, unknown> | null;
  stamp: { count: number } | null;
}

interface View {
  id: number;
  status: string;
  decision: string | null;
  decided_at: string | null;
  approach: string;
  query: unknown;
  stamp: { count: number } | null;
  steps: Step[];
  stop_reason: string | null;
  replans: number;
  error: { code: string; details: Record<string, unknown> } | null;
  refusal: { code: string; details: Record<string, unknown> } | null;
  compare_of: number | null;
  previewed_at: string | null;
}

/** A query object without the fields left at their default (null, []). */
function given(query: unknown): unknown {
  if (Array.isArray(query)) return query.map(given);
  if (query === null || typeof query !== "object") return query;
  return Object.fromEntries(
    Object.entries(query)
      .filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => [k, given(v)]),
  );
}

async function levels(request: APIRequestContext) {
  const response = await request.get("/api/admin/levels");
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { levels: StoredLevel[] }).levels;
}

async function putLevels(request: APIRequestContext, set: StoredLevel[]) {
  const response = await request.put("/api/admin/levels", {
    data: { levels: set },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { levels: StoredLevel[] }).levels;
}

/** The fixture's four levels; a stored level of the same name keeps its id, texts and prompt. */
function fixtureLevels(stored: StoredLevel[]): StoredLevel[] {
  return fixtureFile.levels.map((wanted) => {
    const found = stored.find(
      (l) => l.name.toLowerCase() === wanted.name.toLowerCase(),
    );
    return {
      ...(found ?? { description: "", system_prompt: "" }),
      name: wanted.name,
      selectable: wanted.selectable,
      is_default: wanted.is_default === true,
      matrix: { ...wanted.matrix },
    };
  });
}

interface Connection {
  id: number;
  name: string;
}
const OURS: [string, () => string][] = [
  [DIRECT, () => STUB!],
  [CHAIN, () => caseUrl("chain_reference")],
  [HOLD, () => caseUrl("chain_reference", HOLD_S)],
  [DIFFERS, () => caseUrl("compare_differs")],
];

/** The stub with every request answered by fixture case ``id``, a re-plan held ``hold`` s. */
const caseUrl = (id: string, hold?: number) =>
  STUB!.replace(/\/v1\/?$/, `/case/${id}${hold ? `/hold/${hold}` : ""}/v1`);

async function connections(request: APIRequestContext) {
  return (await (
    await request.get("/api/admin/llm/connections")
  ).json()) as Connection[];
}

async function ensureConnections(
  request: APIRequestContext,
): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  const all = await connections(request);
  for (const [name, url] of OURS) {
    const found = all.find((c) => c.name === name);
    if (found) {
      ids[name] = found.id;
      continue;
    }
    // Data release on, as a local connection has it by default: it changes
    // nothing of what the model sees (D10).
    const made = await request.post("/api/admin/llm/connections", {
      data: {
        name,
        base_url: url(),
        model: MODEL,
        enabled: true,
        timeout_s: 120,
        may_receive_data: true,
      },
    });
    expect(made.ok(), await made.text()).toBe(true);
    ids[name] = ((await made.json()) as Connection).id;
  }
  return ids;
}

async function removeConnections(request: APIRequestContext) {
  const names = OURS.map(([name]) => name);
  for (const c of (await connections(request)).filter((c) =>
    names.includes(c.name),
  ))
    await request.delete(`/api/admin/llm/connections/${c.id}`);
}

/** The planted layer: six points in Bern, each row a sentinel (D10). */
async function plantSentinel(request: APIRequestContext) {
  if ((await request.get(`/api/layers/${SENTINEL_LAYER}`)).ok()) return;
  const rows = ["E,N,name,kategorie,wert"];
  for (let i = 0; i < 6; i++)
    rows.push(
      `${2600000 + i * 100},${1200000 + i * 100},${SENTINEL_NAME},${SENTINEL_CODE},${SENTINELS[2]}`,
    );
  const upload = await request.post("/api/admin/imports", {
    multipart: {
      file: {
        name: "e25_sentinel.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(rows.join("\n") + "\n", "utf-8"),
      },
    },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const { import_id } = (await upload.json()) as { import_id: string };
  const run = await request.post(`/api/admin/imports/${import_id}/commit`, {
    data: {
      geo: { mode: "xy", x: "E", y: "N", crs: 2056 },
      layer_name: SENTINEL_LAYER,
      title: "Sentinel E2.5",
    },
  });
  expect(run.ok(), await run.text()).toBe(true);
  expect(["ok", "warning"]).toContain(
    ((await run.json()) as { status: string }).status,
  );
}

async function view(context: BrowserContext, id: number): Promise<View> {
  const response = await context.request.get(`/api/model/actions/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as View;
}

/** The browser's own request, past the interface: status and body. */
async function call(page: Page, method: "GET" | "POST", path: string) {
  return page.evaluate(
    async ([method, path]) => {
      const response = await fetch(path, { method });
      const body = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return { status: response.status, body };
    },
    [method, path] as const,
  );
}

/** As ``call``, the status and error code only. */
async function past(page: Page, method: "GET" | "POST", path: string) {
  const { status, body } = await call(page, method, path);
  return { status, code: (body.code as string | undefined) ?? null };
}

/** Signed in through the login page, the workplace shown. */
async function user(
  browser: Browser,
  username: string,
): Promise<[BrowserContext, Page]> {
  const [context, page] = await signIn(browser, username);
  await expect(page.getByRole("tab", { name: "Klassik" })).toBeVisible();
  return [context, page];
}

/** A choice in the header's menu (M7.2): the level or the connection, as a user makes it. */
async function chooseInMenu(page: Page, name: string, shown: string) {
  const menu = page.getByRole("button", { name: "Modellunterstützung wählen" });
  await menu.click();
  const item = page.getByRole("menuitemradio", {
    name: new RegExp(`^${name}`),
  });
  if ((await item.getAttribute("aria-checked")) === "true") {
    await page.keyboard.press("Escape");
  } else {
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/llm/options") && r.request().method() === "PUT",
    );
    await item.click();
    expect((await saved).ok()).toBe(true);
  }
  await expect(menu).toContainText(shown);
}

const chooseLevel = (page: Page, name: string) =>
  chooseInMenu(page, name, `Stufe: ${name}`);
const chooseConnection = (page: Page, name: string) =>
  chooseInMenu(page, name, name);

const hits = (page: Page) => page.getByLabel("Trefferzahl", { exact: true });
const panelOf = (page: Page) =>
  page.getByRole("region", { name: "Prompt", exact: true });
const stepsOf = (card: Locator) =>
  card.getByRole("listitem", { name: /^Schritt \d: / });
const pending = (page: Page) =>
  page.getByRole("note", { name: "Zwischenstand · Kette" });

/** Sends ``text`` by ``approach``; the answer card once the model has answered, and its id. */
async function ask(
  page: Page,
  text: string,
  approach: "direct" | "chain",
): Promise<{ card: Locator; id: number }> {
  const panel = panelOf(page);
  await panel
    .getByRole("radio", {
      name: approach === "chain" ? "Werkzeugkette" : "Direktabfrage",
    })
    .click();
  const items = panel
    .getByRole("list", { name: "Verlauf" })
    .locator(":scope > li");
  const before = await items.count();
  await panel.getByRole("textbox", { name: "Prompt" }).fill(text);
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/api/model/prompt"),
  );
  await panel.getByRole("button", { name: /Senden/ }).click();
  const response = await posted;
  expect(response.status(), await response.text()).toBe(202);
  const { id, approach: asked } = (await response.json()) as {
    id: number;
    approach: string;
  };
  expect(asked).toBe(approach);
  await expect(items).toHaveCount(before + 1);
  const card = items.last().getByRole("article", { name: "Antwort" });
  await expect(card).not.toHaveAttribute("aria-busy", "true", {
    timeout: 30_000,
  });
  return { card, id };
}

/** The analysis of the first test: the schools, all 137 of them. */
async function addSchools(page: Page) {
  await page.getByRole("tab", { name: "Klassik" }).click();
  await page.getByRole("button", { name: "Layer", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Layer hinzufügen" });
  await picker
    .getByRole("checkbox", { name: /^Schulen/ })
    .first()
    .check();
  await picker.getByRole("button", { name: "Hinzufügen" }).click();
  await expect(hits(page)).toHaveText("137 von 137");
}

/** M8.3: step 4 asks for Steueranlage > 99, so it finds nothing and a re-plan follows (P4). */
async function emptyStepFour(card: Locator) {
  await card.getByRole("button", { name: "Anpassen …" }).click();
  const form = card.getByRole("form", { name: "Plan anpassen" });
  await expect(
    form.getByRole("textbox", { name: "Wert in Schritt 4" }),
  ).toHaveValue("1.6");
  await form.getByRole("textbox", { name: "Wert in Schritt 4" }).fill("99");
  await form.getByRole("button", { name: "Änderungen übernehmen" }).click();
  await expect(form).toHaveCount(0);
}

const STEP_TIME = /^\d+[.,]\d s$/;

test.describe("E2.5 against the model stub", { tag: "@stub" }, () => {
  test.skip(
    !STUB || !CONTROL,
    "E2E_STUB_URL and E2E_STUB_CONTROL name the model stub (scripts/gate.sh)",
  );
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  // Shared by the tests, in order: the analyst's workplace keeps its dialogue.
  let original: StoredLevel[] = [];
  let analyst: BrowserContext;
  let workplace: Page;

  test.beforeAll(async ({ browser, request }) => {
    original = await levels(request);
    const set = await putLevels(request, fixtureLevels(original));
    const levelIds = Object.fromEntries(set.map((l) => [l.name, l.id!]));
    await ensureAreaLayer(request);
    await plantSentinel(request);
    const ids = await ensureConnections(request);
    await ensureAccount(request, browser, ANALYST, "admin");
    [analyst, workplace] = await user(browser, ANALYST);
    const chosen = await analyst.request.put("/api/llm/options", {
      data: { connection_id: ids[DIRECT], level_id: levelIds["Prüfen"] },
    });
    expect(chosen.ok(), await chosen.text()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    await analyst?.close();
    // The shipped set back; a level of it deleted meanwhile comes back as new.
    const now = new Set((await levels(request)).map((l) => l.id));
    if (original.length > 0)
      await putLevels(
        request,
        original.map((l) => (now.has(l.id) ? l : { ...l, id: undefined })),
      );
    await removeConnections(request);
    await request.delete(`/api/admin/layers/${SENTINEL_LAYER}`);
  });

  test("the reference question by both approaches: one analysis state, 10 von 137, the query object of E1", async () => {
    const page = workplace;
    await page.goto("/");
    await addSchools(page);
    await chooseLevel(page, "Prüfen");
    await chooseConnection(page, DIRECT);
    const { sent, failures } = watchQueries(page);
    await page.getByRole("tab", { name: "Prompt" }).click();

    // Direct (E2.4): approval with its preview, Annehmen.
    const direct = await ask(page, PROMPT, "direct");
    const approval = direct.card.getByRole("region", { name: "Freigabe" });
    await expect(approval.getByLabel("Trefferzahl der Vorschau")).toContainText(
      "Treffer: 137 → 10",
    );
    await approval.getByRole("button", { name: "Annehmen" }).click();
    await expect(hits(page)).toHaveText("10 von 137");
    await expect
      .poll(() => sent.some((q) => isDeepStrictEqual(q, reference)), {
        message: `sent: ${JSON.stringify(sent)}`,
      })
      .toBe(true);
    const directView = await view(analyst, direct.id);
    expect([
      directView.status,
      directView.decision,
      directView.stamp?.count,
    ]).toEqual(["applied", "accepted", 10]);
    expect(given(directView.query)).toEqual(reference);
    // Back to where it started, so that the chain's result is seen to arrive.
    await direct.card.getByRole("button", { name: "Zurücknehmen" }).click();
    await expect(hits(page)).toHaveText("137 von 137");
    sent.length = 0;

    // The tool chain (M8.1): the plan before anything runs, one approval under Prüfen.
    await chooseConnection(page, CHAIN);
    const chain = await ask(page, PROMPT, "chain");
    const card = chain.card;
    await expect(card).toHaveAttribute("data-phase", "plan");
    await expect(
      card.getByText("Geplante Schritte · 5 von höchstens 8"),
    ).toBeVisible();
    const steps = stepsOf(card);
    await expect(steps).toHaveCount(PLAN.length);
    for (const [i, step] of PLAN.entries()) {
      await expect(steps.nth(i)).toContainText(step.text);
      await expect(steps.nth(i)).toContainText(step.tool);
      await expect(steps.nth(i)).toContainText("· Freigabe");
    }
    const gate = card.getByRole("region", { name: "Freigabe" });
    await expect(gate).toContainText(
      "Eine Freigabe für die ganze Kette; danach läuft sie ohne weitere Halte durch.",
    );
    await expect(
      gate.getByRole("button", { name: "Kette freigeben und starten" }),
    ).toBeFocused();

    // Past the surface: a chain nobody approved neither runs nor is adopted.
    expect(
      await past(page, "POST", `/api/model/actions/${chain.id}/run`),
    ).toEqual({
      status: 409,
      code: "not_approved",
    });
    expect(
      await past(page, "POST", `/api/model/actions/${chain.id}/adopt`),
    ).toEqual({
      status: 409,
      code: "not_approved",
    });
    let record = await view(analyst, chain.id);
    expect(record.status).toBe("proposed");
    expect(record.steps.map((s) => s.status)).toEqual(
      PLAN.map(() => "planned"),
    );
    await expect(hits(page)).toHaveText("137 von 137");

    await gate
      .getByRole("button", { name: "Kette freigeben und starten" })
      .click();
    await expect(card).toHaveAttribute("data-phase", "done", {
      timeout: 30_000,
    });

    // M9.3, after the run: each step with its result, its time and what the
    // model saw of it, the count the user sees (D9); the result marked, not applied.
    record = await view(analyst, chain.id);
    expect(record.steps.map((s) => s.status)).toEqual(PLAN.map(() => "ok"));
    expect(record.steps.at(-1)?.hits).toBe(10);
    for (const [i, step] of record.steps.entries()) {
      const item = steps.nth(i);
      await expect(item).toHaveAttribute("data-status", "ok");
      await expect(item.getByLabel("Treffer")).toHaveText(String(step.hits));
      await expect(item.getByLabel("Dauer")).toHaveText(STEP_TIME);
      await expect(item).toContainText("Modell sieht: ok");
      await expect(item).toContainText(`nicht leer · ${step.hits}`);
      // Ok, empty or not, the count: nothing else of the data (D9).
      expect(given(step.model_view)).toEqual({
        outcome: "ok",
        empty: false,
        count: step.hits,
      });
    }
    await expect(card.getByLabel("Trefferzahl der Kette")).toHaveText(
      "10 von 137",
    );
    await expect(card).toContainText(/5 Schritte · \d+[.,]\d s/);
    await expect(card.locator('[data-status="done"]')).toContainText(
      "Ergebnis nicht angewendet",
    );
    await expect(pending(page)).toContainText(
      "Ergebnis 10 von 137 · vorgemerkt",
    );
    await expect(hits(page)).toHaveText("137 von 137");

    await card.getByRole("button", { name: "Ergebnis übernehmen" }).click();
    await expect(hits(page)).toHaveText("10 von 137");
    await expect(card).toContainText("Kette übernommen · 10 Treffer");
    // The same analysis state both ways: the query that ran is the hand-built one of E1.
    await expect
      .poll(() => sent.some((q) => isDeepStrictEqual(q, reference)), {
        message: `sent: ${JSON.stringify(sent)}`,
      })
      .toBe(true);
    expect(failures).toEqual([]);
    record = await view(analyst, chain.id);
    expect([record.status, record.decision, record.stamp?.count]).toEqual([
      "applied",
      "accepted",
      10,
    ]);
    expect(given(record.query)).toEqual(reference);
    expect(given(record.query)).toEqual(given(directView.query));

    // Past the surface: adopted once; twice is refused and changes nothing.
    for (let i = 0; i < 2; i++)
      expect(
        await past(page, "POST", `/api/model/actions/${chain.id}/adopt`),
      ).toEqual({
        status: 409,
        code: "already_decided",
      });
    const after = await view(analyst, chain.id);
    expect([
      after.status,
      after.decision,
      after.decided_at,
      after.stamp,
    ]).toEqual([
      record.status,
      record.decision,
      record.decided_at,
      record.stamp,
    ]);
    await expect(hits(page)).toHaveText("10 von 137");
  });

  test("while it runs: the steps, their count and the clock; Abbrechen leaves the analysis, the last complete result adoptable", async () => {
    const page = workplace;
    await chooseConnection(page, HOLD);
    const before = await hits(page).textContent();
    const { card, id } = await ask(page, PROMPT, "chain");
    await emptyStepFour(card);
    await card
      .getByRole("button", { name: "Kette freigeben und starten" })
      .click();

    // Steps 1 to 4 ran, 4 found nothing: the re-plan waits for the model (M9.1).
    const steps = stepsOf(card);
    await expect(steps.nth(3)).toHaveAttribute("data-status", "empty", {
      timeout: 30_000,
    });
    await expect(card).toHaveAttribute("data-phase", "running");
    await expect(card.locator('[data-status="running"]')).toContainText(
      "Schritt 5 von 5",
    );
    await expect(card.getByLabel("Laufzeit der Kette")).toHaveText(
      /^\d:\d\d \/ max\. 5:00$/,
    );
    for (let i = 0; i < 3; i++) {
      await expect(steps.nth(i)).toHaveAttribute("data-status", "ok");
      await expect(steps.nth(i)).toContainText("Modell sieht: ok · nicht leer");
      await expect(steps.nth(i).getByLabel("Dauer")).toHaveText(STEP_TIME);
    }
    await expect(steps.nth(3)).toContainText("Modell sieht: ok · leer · 0");
    await expect(steps.nth(3).getByLabel("Treffer")).toHaveText("0");
    await expect(steps.nth(4)).toHaveAttribute("data-status", "planned");
    await expect(pending(page)).toContainText("Schritt 4 von 5 · 0");
    await expect(pending(page)).toContainText("nicht angewendet");
    await expect(
      panelOf(page).getByRole("textbox", { name: "Prompt" }),
    ).toHaveAttribute("readonly");
    await expect(hits(page)).toHaveText(before!);
    const running = await view(analyst, id);
    expect([running.status, running.stop_reason]).toEqual(["running", null]);

    // M9.4: asked to stop, it says so at once; the re-plan's answer is dropped.
    await card.getByRole("button", { name: "Abbrechen" }).click();
    await expect(card.locator('[data-status="running"]')).toContainText(
      "wird abgebrochen",
    );
    await expect(card).toHaveAttribute("data-phase", "stopped", {
      timeout: (HOLD_S + 15) * 1000,
    });
    await expect(card.locator('[data-status="aborted"]')).toContainText(
      "nach Schritt 4",
    );
    await expect(card).toContainText("Analyse unverändert");
    await expect(steps.nth(4)).toHaveAttribute("data-status", "skipped");
    await expect(
      card.getByRole("button", { name: "Zwischenstand übernehmen (0)" }),
    ).toBeEnabled();
    await expect(hits(page)).toHaveText(before!);
    const stopped = await view(analyst, id);
    expect([
      stopped.status,
      stopped.stop_reason,
      stopped.decision,
      stopped.replans,
    ]).toEqual(["limited", "aborted", null, 1]);
    // The last complete result, step 4's, stays adoptable (decision 16).
    expect(stopped.query).not.toBeNull();
    expect(stopped.stamp?.count).toBe(0);
    expect(stopped.steps.find((s) => s.stamp)?.position).toBe(4);
  });

  test("limits: nine planned steps are refused; nine with a re-plan stop the chain, both said in words", async () => {
    const page = workplace;
    // The stub's plan has nine steps (step_limit); at most eight (P4).
    await chooseConnection(page, DIRECT);
    const planned = await ask(page, fixture("step_limit").prompt, "chain");
    const alert = planned.card.getByRole("alert");
    await expect(alert).toContainText("abgewiesen");
    await expect(alert).toContainText(
      "Die Werkzeugkette braucht mehr als 8 Schritte.",
    );
    await expect(planned.card.getByText("code: step_limit")).toBeAttached();
    await expect(stepsOf(planned.card)).toHaveCount(0);
    const refused = await view(analyst, planned.id);
    expect([
      refused.status,
      refused.refusal?.code,
      refused.refusal?.details,
    ]).toEqual(["refused", "step_limit", { max: 8, value: 9, step: 9 }]);
    expect(refused.steps.filter((s) => s.status !== "planned")).toEqual([]);

    // Four steps ran, the re-plan brings five more: nine, re-planned ones counted (M9.5).
    await chooseConnection(page, CHAIN);
    const before = await hits(page).textContent();
    const { card, id } = await ask(page, PROMPT, "chain");
    await emptyStepFour(card);
    await card
      .getByRole("button", { name: "Kette freigeben und starten" })
      .click();
    await expect(card).toHaveAttribute("data-phase", "stopped", {
      timeout: 30_000,
    });
    await expect(card).toContainText("Schrittzahl erreicht");
    await expect(card).toContainText(
      "Die Kette bräuchte 9 Schritte, neu geplante eingeschlossen (höchstens 8).",
    );
    await expect(
      card.getByRole("button", { name: "Prompt ändern" }),
    ).toBeVisible();
    await expect(hits(page)).toHaveText(before!);
    const limited = await view(analyst, id);
    expect([limited.status, limited.stop_reason, limited.replans]).toEqual([
      "limited",
      "step_limit",
      1,
    ]);
    expect([limited.error?.code, limited.error?.details]).toEqual([
      "step_limit",
      { step: 9, value: 9, max: 8 },
    ]);
    expect(limited.steps.map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "empty",
      "skipped",
    ]);
  });

  test("Teilautonom: the chain halts before the derive step, runs on once approved; past the surface it does not", async () => {
    const page = workplace;
    await chooseLevel(page, "Teilautonom");
    await chooseConnection(page, CHAIN);
    const before = await hits(page).textContent();
    const { card, id } = await ask(page, PROMPT, "chain");
    // M8.2: class and cell per step; only the buffer asks.
    const steps = stepsOf(card);
    await expect(steps.nth(0)).toContainText("Attributfilter · auto");
    await expect(steps.nth(1)).toContainText("Abgeleitete Layer · Freigabe");
    await expect(steps.nth(2)).toContainText("Raumfilter · auto");
    await expect(card).toContainText(
      "die Kette hält vor Schritt 2 zur Freigabe",
    );
    await card.getByRole("button", { name: "Starten" }).click();

    // M9.2: step 1 ran, the run stands before the buffer.
    await expect(card).toHaveAttribute("data-phase", "halt", {
      timeout: 30_000,
    });
    await expect(steps.nth(0)).toHaveAttribute("data-status", "ok");
    await expect(steps.nth(1)).toHaveAttribute("data-status", "waiting");
    const halt = steps.nth(1).getByRole("group", { name: "Freigabe" });
    await expect(halt).toContainText("Braucht Freigabe:");
    await expect(halt).toContainText("Abgeleitete Layer (Stufe Teilautonom)");
    await expect(
      halt.getByRole("button", { name: "Schritt freigeben" }),
    ).toBeFocused();
    await expect(card).toContainText(
      "Die Laufzeit ist angehalten, solange die Freigabe offen ist.",
    );
    let record = await view(analyst, id);
    expect(record.status).toBe("proposed");
    expect(record.steps.map((s) => s.status)).toEqual([
      "ok",
      "waiting",
      "planned",
      "planned",
      "planned",
    ]);
    expect(record.steps.map((s) => s.cell)).toEqual([
      "auto",
      "approve",
      "auto",
      "auto",
      "auto",
    ]);

    // Past the surface: the halted chain does not run on without the approval.
    expect(await past(page, "POST", `/api/model/actions/${id}/run`)).toEqual({
      status: 409,
      code: "not_approved",
    });
    expect((await view(analyst, id)).steps.map((s) => s.status)).toEqual(
      record.steps.map((s) => s.status),
    );

    await halt.getByRole("button", { name: "Schritt freigeben" }).click();
    await expect(card).toHaveAttribute("data-phase", "done", {
      timeout: 30_000,
    });
    await expect(card.getByLabel("Trefferzahl der Kette")).toHaveText(
      "10 von 137",
    );
    record = await view(analyst, id);
    expect([record.status, record.stamp?.count]).toEqual(["done", 10]);
    expect(record.steps.map((s) => s.status)).toEqual(PLAN.map(() => "ok"));
    expect(given(record.query)).toEqual(reference);
    await expect(hits(page)).toHaveText(before!);
  });

  test("partial adoption: stopped at the halt, the result of step 1 becomes the analysis", async () => {
    const page = workplace;
    const { card, id } = await ask(page, PROMPT, "chain");
    await card.getByRole("button", { name: "Starten" }).click();
    await expect(card).toHaveAttribute("data-phase", "halt", {
      timeout: 30_000,
    });
    const steps = stepsOf(card);
    await steps
      .nth(1)
      .getByRole("group", { name: "Freigabe" })
      .getByRole("button", { name: "Kette abbrechen" })
      .click();
    await expect(card).toHaveAttribute("data-phase", "stopped", {
      timeout: 30_000,
    });
    await expect(card.locator('[data-status="aborted"]')).toContainText(
      "nach Schritt 1",
    );
    const stopped = await view(analyst, id);
    const first = stopped.steps[0];
    expect([stopped.status, stopped.stop_reason, first.status]).toEqual([
      "limited",
      "aborted",
      "ok",
    ]);
    expect(stopped.stamp?.count).toBe(first.hits);
    expect(given(stopped.query)).toEqual({
      schema_version: "2",
      source: "schulen",
      output: "map",
      where: PLAN[0].arguments.where,
    });
    await expect(pending(page)).toContainText(
      `Schritt 1 · ${first.hits} Treffer übernehmbar`,
    );

    await card
      .getByRole("button", { name: `Zwischenstand übernehmen (${first.hits})` })
      .click();
    await expect(hits(page)).toHaveText(`${first.hits} von 137`);
    const adopted = await view(analyst, id);
    expect([adopted.status, adopted.decision, adopted.stamp?.count]).toEqual([
      "applied",
      "accepted",
      first.hits,
    ]);
  });

  test("comparison by the API (WP76): the reference question equal both ways, 800 m and 1.65 differ by named schools", async () => {
    const page = workplace;
    await chooseLevel(page, "Prüfen");
    await chooseConnection(page, DIRECT);
    const before = await hits(page).textContent();
    const left = await ask(page, PROMPT, "direct");
    await expect(
      left.card.getByRole("region", { name: "Freigabe" }),
    ).toBeVisible();

    /** The other approach for the same prompt, approved and run to its end. */
    const repeat = async (connection: string) => {
      await chooseConnection(page, connection);
      const asked = await call(
        page,
        "POST",
        `/api/model/actions/${left.id}/compare`,
      );
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      const id = asked.body.id as number;
      await expect
        .poll(async () => (await view(analyst, id)).status, { timeout: 30_000 })
        .toBe("proposed");
      const asRepeat = await view(analyst, id);
      expect([asRepeat.approach, asRepeat.compare_of]).toEqual([
        "chain",
        left.id,
      ]);
      // Not compared before it has a result.
      expect(
        await past(page, "GET", `/api/model/actions/${id}/comparison`),
      ).toEqual({
        status: 409,
        code: "not_approved",
      });
      expect(
        (await call(page, "POST", `/api/model/actions/${id}/approve`)).status,
      ).toBe(200);
      expect(
        (await call(page, "POST", `/api/model/actions/${id}/run`)).status,
      ).toBe(202);
      await expect
        .poll(async () => (await view(analyst, id)).status, { timeout: 30_000 })
        .toBe("done");
      return id;
    };

    interface Compared {
      left_action_id: number;
      right_action_id: number;
      left: { count: number };
      right: { count: number };
      only_left: { id: number; name: string | null }[];
      only_right: { id: number; name: string | null }[];
      reason: unknown;
    }
    const comparison = async (id: number) => {
      const found = await call(
        page,
        "GET",
        `/api/model/actions/${id}/comparison`,
      );
      expect(found.status, JSON.stringify(found.body)).toBe(200);
      return found.body as unknown as Compared;
    };

    // M10.2: the same 10 schools both ways.
    const same = await comparison(await repeat(CHAIN));
    expect(same.left_action_id).toBe(left.id);
    expect([same.left.count, same.right.count]).toEqual([10, 10]);
    expect([same.only_left, same.only_right, same.reason]).toEqual([
      [],
      [],
      null,
    ]);

    // M10.3: the chain took "nahe" as 800 m and "hohe Steueranlage" as over 1.65.
    const expected = fixture("compare_differs").expect!.comparison!;
    const differs = await repeat(DIFFERS);
    const other = await comparison(differs);
    expect([other.left_action_id, other.right_action_id]).toEqual([
      left.id,
      differs,
    ]);
    expect([other.left.count, other.right.count]).toEqual([10, 11]);
    expect(other.only_left).toEqual(expected.only_left);
    expect(other.only_right).toEqual(expected.only_right);
    expect(given(other.reason)).toEqual(expected.reason);
    // Addressed by the record compared: its newest repeat with a result.
    expect((await comparison(left.id)).right_action_id).toBe(differs);

    // Nothing applied: the waiting side was previewed (P2), the analysis is as it was.
    const waiting = await view(analyst, left.id);
    expect([waiting.status, waiting.decision]).toEqual(["proposed", null]);
    expect(waiting.previewed_at).not.toBeNull();
    await expect(hits(page)).toHaveText(before!);
  });

  test("comparison dialog: equal and differing hits side by side, Diese übernehmen (M10)", async () => {
    test.skip(
      !COMPARISON_DIALOG,
      "The comparison dialog is WP78 (M10.1–M10.3), not merged yet: set COMPARISON_DIALOG once it is",
    );
    const page = workplace;
    await chooseLevel(page, "Prüfen");

    /** A chain run to its end, then compared with the direct query (M9.3 → M10). */
    const compared = async (connection: string) => {
      await chooseConnection(page, connection);
      const chain = await ask(page, PROMPT, "chain");
      await chain.card
        .getByRole("button", { name: "Kette freigeben und starten" })
        .click();
      await expect(chain.card).toHaveAttribute("data-phase", "done", {
        timeout: 30_000,
      });
      // The direct repeat answers by prompt.
      await chooseConnection(page, DIRECT);
      await chain.card
        .getByRole("button", { name: "Mit Direktabfrage vergleichen" })
        .click();
      // Opens by itself once both have a result (WP78): the direct repeat has its query at once.
      const dialog = page.getByRole("dialog", {
        name: "Vergleich · gleiche Frage, zwei Arbeitsweisen",
      });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      return { chain, dialog };
    };

    // M10.2: equal hits, derivation and step count side by side.
    const equal = await compared(CHAIN);
    await expect(equal.dialog).toContainText("Werkzeugkette");
    await expect(equal.dialog).toContainText("Direktabfrage");
    await expect(equal.dialog).toContainText("5 Schritte");
    await expect(equal.dialog.getByText("10 von 137")).toHaveCount(2, {
      timeout: 30_000,
    });
    await expect(equal.dialog).not.toContainText("nur links");
    await page.keyboard.press("Escape");
    await expect(equal.dialog).toHaveCount(0);

    // M10.3: left the chain (800 m, > 1.65: 11), right the direct query (10).
    const before = await hits(page).textContent();
    const { chain, dialog } = await compared(DIFFERS);
    await expect(dialog).toContainText("11 von 137", { timeout: 30_000 });
    await expect(
      dialog.getByRole("region", { name: "Werkzeugkette" }),
    ).toContainText("11 von 137");
    await expect(
      dialog.getByRole("region", { name: "Direktabfrage" }),
    ).toContainText("10 von 137");
    await expect(dialog).toContainText("2 nur links, 1 nur rechts");
    for (const school of [
      "Primarstufe Wichtrach",
      "Schule Bernstrasse Ostermundigen",
    ])
      await expect(dialog).toContainText(school);
    // The reason in words, from the two queries (WP76): the distance and the rate.
    for (const value of ["500", "800", "1.65"])
      await expect(dialog).toContainText(value);
    await expect(hits(page)).toHaveText(before!);

    // Diese übernehmen: the chain's side replaces the analysis and counts as its approval.
    await dialog
      .getByRole("button", { name: "Diese übernehmen: Werkzeugkette" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(hits(page)).toHaveText("11 von 137");
    const taken = await view(analyst, chain.id);
    expect([taken.status, taken.decision, taken.stamp?.count]).toEqual([
      "applied",
      "accepted",
      11,
    ]);
  });

  test("privacy: no planted sentinel and no school name reaches the model, in plans, re-plans or steps (D9, D10)", async ({
    request,
  }) => {
    const log = await fetch(`${CONTROL}/_requests`);
    expect(log.ok).toBe(true);
    const requests = (await log.json()) as { path: string; body: unknown }[];
    const bodies = requests.map((r) => JSON.stringify(r.body));
    // Positive controls: the chain's plans and re-plans did reach it, with the
    // planted layer in the profile and what the model may see of a step.
    const replans = bodies.filter((b) =>
      b.includes("Ergebnis der ausgeführten Schritte"),
    );
    expect(replans.length).toBeGreaterThanOrEqual(2);
    expect(replans.join("")).toContain('\\"count\\":0');
    const plans = requests.filter((r) =>
      r.path.includes("/case/chain_reference/"),
    );
    expect(plans.length).toBeGreaterThanOrEqual(4);
    const sentToModel = bodies.join("\n");
    expect(sentToModel).toContain(SENTINEL_LAYER);
    expect(sentToModel).toContain(PROMPT);

    for (const sentinel of SENTINELS)
      expect(sentToModel).not.toContain(sentinel);
    const result = await request.post("/api/query", {
      data: {
        schema_version: "2",
        source: "schulen",
        select: ["name"],
        limit: 200,
      },
    });
    expect(result.ok(), await result.text()).toBe(true);
    const names = (
      (await result.json()).features as { properties: { name: string } }[]
    )
      .map((f) => f.properties.name)
      .filter((n) => n.length > 6);
    expect(names.length).toBeGreaterThan(50);
    // The schools the comparison named to the user among them.
    const compared = fixture("compare_differs").expect!.comparison!;
    for (const ref of [...compared.only_left, ...compared.only_right])
      expect(names).toContain(ref.name);
    expect(names.filter((n) => sentToModel.includes(n))).toEqual([]);
  });
});
