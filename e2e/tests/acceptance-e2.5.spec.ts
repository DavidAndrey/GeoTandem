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
//   E25 direkt       by prompt: the reference answer, the 9-step plan (step_limit)
//   E25 Kette        chain_reference for every request, re-plans included
//   E25 Halt         the same, a re-plan held (…/hold/<s>, the stub's doc):
//                    the steps take milliseconds, so this is what keeps a run
//                    "running" long enough to watch and abort it
//   E25 abweichend   compare_differs: 800 m and Steueranlage > 1.65 (11 hits)
//   E25 neu geplant  e25_replan, scripted by this test (below, REPLAN_CASE)
//
// A re-plan follows an empty step before the last (P4). The tests that need
// one empty step 4 by hand (M8.3: Steueranlage > 99); the stub answers the
// re-plan with the whole plan again, five steps after four that ran: nine,
// one beyond the limit (P4: re-planned steps count). A re-plan the run goes
// on with is e25_replan's: the fixture has no case for it, so the test adds
// one to the stub (PUT /_cases/<id>, the stub's doc), made of the fixture's
// steps: a plan whose step 5 finds nothing, and a re-plan answer (the case's
// ``replan``) that brings steps 6 and 7, which end in the reference question.
//
// The data release of the connections is on (local: the default), and still
// no row content reaches the model (D9, D10): the last test empties the
// stub's request log, runs that chain, one step of which reads a planted
// sentinel layer, and searches every request for the sentinel and the
// schools' names.

const STUB = process.env.E2E_STUB_URL;
const CONTROL = process.env.E2E_STUB_CONTROL;
const MODEL = "stub-model";

const DIRECT = "E25 direkt";
const CHAIN = "E25 Kette";
const HOLD = "E25 Halt";
const DIFFERS = "E25 abweichend";
const REPLANNED = "E25 neu geplant";
const REPLAN_CASE = "e25_replan";
/**
 * The longest the stub holds a re-plan (below the 120 s of a model call). It
 * does not end the hold in the test: the test does, right after *Abbrechen*
 * (``release``), so neither a slow runner (a hold ending before the test has
 * looked) nor a long wait after the abort depends on a number of seconds.
 */
const HOLD_S = 100;
const ANALYST = "e2e.abnahme.e25";

// The sentinel (D10, like S7): a point layer of its own, visible to the model
// by its name and attributes, whose rows say something that must never leave.
const SENTINEL_LAYER = "e25_sentinel";
const SENTINEL_NAME = "Sentinelschule Quokka 4402";
const SENTINEL_CODE = "zz_sentinel_e25";
const SENTINELS = [SENTINEL_NAME, SENTINEL_CODE, "2600123.5"];
const SENTINEL_POINTS = 6;

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

/** The fixture's step 4 with another rate: over 99 finds no municipality. */
const taxAbove = (value: number): PlannedStep => ({
  text: `Gemeinden mit Steueranlage über ${value}`,
  tool: "filter",
  arguments: {
    layer: "gemeinden_steuern",
    where: { op: "compare", attr: "steueranlage", cmp: "gt", value },
  },
});
const schoolsIn = (of: number, inside: number): PlannedStep => ({
  text: "Primarschulen in diesen Gemeinden",
  tool: "within",
  arguments: { of, in: inside },
});
/**
 * e25_replan, the chain of the last two tests. Its plan: the fixture's steps
 * 1 to 3, a step that reads the sentinel layer (all of it: its count is what
 * the model learns), Steueranlage > 99, which finds nothing, so a re-plan
 * follows (P4), and the schools in those municipalities. The re-plan keeps
 * steps 1 to 5 and brings 6 and 7: over 1.6, as assumed, and the schools in
 * them, 7 steps in all (at most 8). Nothing in it names a sentinel value.
 */
const REPLAN_PLAN: PlannedStep[] = [
  ...PLAN.slice(0, 3),
  {
    text: "Punkte des Testlayers auswählen",
    tool: "filter",
    arguments: {
      layer: SENTINEL_LAYER,
      where: { op: "compare", attr: "kategorie", cmp: "ne", value: "keine" },
    },
  },
  taxAbove(99),
  schoolsIn(3, 5),
];
const REPLAN_STEPS: PlannedStep[] = [taxAbove(1.6), schoolsIn(3, 6)];
const replanCase = {
  approach: "chain",
  prompt: PROMPT,
  answer: {
    ...fixture("chain_reference").answer,
    explanation:
      "Ich gehe in sechs Schritten vor: Primarschulen nahe der Kantonsstrassen B, die Punkte des Testlayers, Gemeinden mit sehr hoher Steueranlage, Schulen darin.",
    steps: REPLAN_PLAN,
  },
  replan: {
    kind: "plan",
    explanation:
      "Schritt 5 fand keine Gemeinde; ich nehme die Steueranlage über 1.6, wie angenommen.",
    assumptions: [],
    steps: REPLAN_STEPS,
  },
};

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
  revised: boolean;
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
  is_default: boolean;
}
const OURS: [string, () => string][] = [
  [DIRECT, () => STUB!],
  [CHAIN, () => caseUrl("chain_reference")],
  [HOLD, () => caseUrl("chain_reference", HOLD_S)],
  [DIFFERS, () => caseUrl("compare_differs")],
  [REPLANNED, () => caseUrl(REPLAN_CASE)],
];
const urlOf = (connection: string) =>
  OURS.find(([name]) => name === connection)![1]();

/** The stub with every request answered by fixture case ``id``, a re-plan held ``hold`` s. */
const caseUrl = (id: string, hold?: number) =>
  STUB!.replace(/\/v1\/?$/, `/case/${id}${hold ? `/hold/${hold}` : ""}/v1`);

// --- the stub's side: what reached the model --------------------------------

interface Logged {
  path: string;
  body: {
    messages?: { role: string; content: unknown }[];
    response_format?: { json_schema?: { schema?: Record<string, unknown> } };
    tools?: unknown[];
  };
}

async function stubLog(): Promise<Logged[]> {
  const log = await fetch(`${CONTROL}/_requests`);
  expect(log.ok).toBe(true);
  return (await log.json()) as Logged[];
}

/** The model calls made through the connection to ``base``; a connection test's probes left out. */
function callsTo(log: Logged[], base: string): Logged[] {
  const path = new URL(base).pathname;
  return log.filter(
    (r) =>
      r.path.startsWith(`${path}/`) &&
      !r.body.tools &&
      JSON.stringify(r.body.response_format?.json_schema?.schema?.required) !==
        '["result"]',
  );
}

const callsSince = async (base: string, from: number) =>
  callsTo(await stubLog(), base).slice(from);

const said = (content: unknown) =>
  typeof content === "string" ? content : JSON.stringify(content);

/** The user turns of a call: the prompt, then each re-plan's input. */
const userTurns = (call: Logged) =>
  (call.body.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => said(m.content));

const REPLAN_INPUT = /^Ergebnis der ausgeführten Schritte:\n/;

/** A re-plan (P4): its last turn tells the model what it may see of the steps that ran. */
const isReplan = (call: Logged) =>
  REPLAN_INPUT.test(userTurns(call).at(-1) ?? "");

/** The question of a user turn, as ``prompt.py`` writes it (after a last "Frage: ", if any). */
function questionOf(text: string): string {
  const at = text.lastIndexOf("Frage: ");
  return (at >= 0 ? text.slice(at + "Frage: ".length) : text).trim();
}

/** The answer kinds a constrained output allows (``oneOf`` of ``$defs`` with a ``kind``). */
function kindsOf(schema: Record<string, unknown> | undefined): string[] {
  const defs = (schema?.$defs ?? {}) as Record<
    string,
    { properties?: { kind?: { const?: string } } }
  >;
  return ((schema?.oneOf ?? []) as { $ref: string }[]).map(
    (one) => defs[one.$ref.split("/").pop()!]?.properties?.kind?.const ?? "?",
  );
}

/**
 * A chain's model call as the app sends it (P4), whatever the forced case
 * answers: the chain's answer format as constrained output, a plan and no
 * query, and the question. A re-plan goes on from the plan the model gave,
 * with what it may see of the steps that ran (D9); a plan call has none.
 */
function expectChainCall(call: Logged | undefined, replan: boolean) {
  expect(call, "the chain's model call").toBeDefined();
  const kinds = kindsOf(call!.body.response_format?.json_schema?.schema);
  expect(kinds).toContain("plan");
  expect(kinds).not.toContain("query");
  expect(isReplan(call!)).toBe(replan);
  const messages = (call!.body.messages ?? []).map((m) => ({
    role: m.role,
    text: said(m.content),
  }));
  // A plan call ends in the question; a (first) re-plan in the question, the
  // plan the model gave, and the re-plan's input.
  const asked = messages.at(replan ? -3 : -1);
  expect(asked?.role).toBe("user");
  expect(questionOf(asked!.text)).toBe(PROMPT);
  if (replan) {
    expect(messages.at(-2)?.role).toBe("assistant");
    expect((JSON.parse(messages.at(-2)!.text) as { kind: string }).kind).toBe(
      "plan",
    );
  }
}

/** Ends the stub's holds: the held re-plan is answered now (HOLD_S). */
async function release() {
  const released = await fetch(`${CONTROL}/_release`, { method: "POST" });
  expect(released.status).toBe(204);
}

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
  const ours = async () =>
    (await connections(request)).filter((c) => names.includes(c.name));
  // The default last: while another connection is enabled, the default cannot
  // go (C18, ``default_connection_required``); the first one made is the default.
  const order = (await ours()).sort(
    (a, b) => Number(a.is_default) - Number(b.is_default),
  );
  for (const c of order) {
    const gone = await request.delete(`/api/admin/llm/connections/${c.id}`);
    expect(gone.ok(), `${c.name}: ${gone.status()} ${await gone.text()}`).toBe(
      true,
    );
  }
  // None left enabled: the next spec (and the gate's second pass) starts without them.
  expect((await ours()).map((c) => c.name)).toEqual([]);
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

/**
 * The analysis's query, as the app itself sends it. The sidebar's count
 * (``useCounts``: the result query, the layer's total, each condition) is
 * mounted per tab, so going to *Klassik* asks the engine for it again; then
 * back to the prompt panel.
 */
async function analysisQuery(page: Page): Promise<unknown> {
  const counted = page.waitForRequest(
    (r) => {
      if (r.method() !== "POST" || !r.url().endsWith("/api/query/count"))
        return false;
      const queries =
        (
          r.postDataJSON() as {
            queries?: { source?: string; where?: unknown }[];
          }
        ).queries ?? [];
      return (
        queries.length >= 2 &&
        queries[1].where === undefined &&
        queries[1].source === queries[0].source
      );
    },
    { timeout: 15_000 },
  );
  await page.getByRole("tab", { name: "Klassik" }).click();
  const { queries } = (await counted).postDataJSON() as { queries: unknown[] };
  await page.getByRole("tab", { name: "Prompt" }).click();
  await expect(panelOf(page)).toBeVisible();
  return queries[0];
}

/** One side of the comparison dialog (M10.2): derivation, step count and result. */
async function expectSide(
  dialog: Locator,
  approach: string,
  [derivation, steps, result]: [string, string, string],
) {
  const side = dialog.getByRole("region", { name: approach, exact: true });
  const fact = (term: string) =>
    side
      .locator("dt")
      .filter({ hasText: new RegExp(`^${term}$`) })
      .locator("xpath=following-sibling::dd[1]");
  await expect(fact("Herleitung")).toHaveText(derivation);
  await expect(fact("Schritte")).toHaveText(steps);
  await expect(fact("Ergebnis")).toHaveText(result, { timeout: 30_000 });
}

/**
 * e25_replan under *Prüfen*, approved and run: step 5 finds nothing, the
 * re-plan's steps wait for a new approval (P4), ``atHalt`` looks at them,
 * then they are approved and the chain runs to its end.
 */
async function replanned(
  page: Page,
  atHalt: (card: Locator, id: number) => Promise<void> = async () => {},
) {
  await chooseConnection(page, REPLANNED);
  const asked = await ask(page, PROMPT, "chain");
  const { card, id } = asked;
  await expect(stepsOf(card)).toHaveCount(REPLAN_PLAN.length);
  await card
    .getByRole("button", { name: "Kette freigeben und starten" })
    .click();
  const resume = card
    .getByRole("group", { name: "Freigabe" })
    .getByRole("button", { name: "Freigeben und fortsetzen" });
  await expect(resume).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute("data-phase", "halt");
  await atHalt(card, id);
  await resume.click();
  await expect(card).toHaveAttribute("data-phase", "done", {
    timeout: 30_000,
  });
  return asked;
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
    const scripted = await fetch(`${CONTROL}/_cases/${REPLAN_CASE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replanCase),
    });
    expect(scripted.status).toBe(204);
    const ids = await ensureConnections(request);
    await ensureAccount(request, browser, ANALYST, "admin");
    [analyst, workplace] = await user(browser, ANALYST);
    const chosen = await analyst.request.put("/api/llm/options", {
      data: { connection_id: ids[DIRECT], level_id: levelIds["Prüfen"] },
    });
    expect(chosen.ok(), await chosen.text()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    // A re-plan still held by a failed test is answered, not left waiting.
    await fetch(`${CONTROL}/_release`, { method: "POST" }).catch(() => null);
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
    const known = callsTo(await stubLog(), urlOf(CHAIN)).length;
    const chain = await ask(page, PROMPT, "chain");
    const card = chain.card;
    await expect(card).toHaveAttribute("data-phase", "plan");
    // The forced case answers whatever it is asked: the app asked for a plan, with the question.
    const planning = await callsSince(urlOf(CHAIN), known);
    expect(planning).toHaveLength(1);
    expectChainCall(planning[0], false);
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
    // The analysis as the first test left it: the reference question.
    const analysis = await analysisQuery(page);
    expect(given(analysis)).toEqual(reference);
    const before = await hits(page).textContent();
    const held = urlOf(HOLD);
    const known = callsTo(await stubLog(), held).length;
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
    // The re-plan reached the model, which holds it: the plan's format, the
    // question, the plan as the model gave it, and of steps 1 to 4 only what
    // the model may see (D9), step 4 empty.
    let replans: Logged[] = [];
    await expect
      .poll(
        async () =>
          (replans = (await callsSince(held, known)).filter(isReplan)).length,
        { timeout: 15_000 },
      )
      .toBe(1);
    expectChainCall(replans[0], true);
    expect(userTurns(replans[0]).at(-1)).toContain(
      'Schritt 4 (filter): {"outcome":"ok","empty":true,"count":0}',
    );
    await expect(card).toHaveAttribute("data-phase", "running");

    // M9.4: asked to stop, it says so at once; the re-plan's answer is dropped.
    await card.getByRole("button", { name: "Abbrechen" }).click();
    await expect(card.locator('[data-status="running"]')).toContainText(
      "wird abgebrochen",
    );
    await expect(card).toHaveAttribute("data-phase", "running");
    // The model answers now; the run drops the answer and stops.
    await release();
    await expect(card).toHaveAttribute("data-phase", "stopped", {
      timeout: 30_000,
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
    // The analysis is the query it was, not only its count.
    expect(await analysisQuery(page)).toEqual(analysis);
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
    // The analysis is now the stopped chain's query itself, as the app sends it.
    expect(given(await analysisQuery(page))).toEqual(given(stopped.query));
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
      const known = callsTo(await stubLog(), urlOf(connection)).length;
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
      // The repeat asked the model for a plan of the same question.
      const planning = await callsSince(urlOf(connection), known);
      expect(planning).toHaveLength(1);
      expectChainCall(planning[0], false);
      const asRepeat = await view(analyst, id);
      expect([asRepeat.approach, asRepeat.compare_of]).toEqual([
        "chain",
        left.id,
      ]);
      // Not compared before it has a result.
      expect(
        await past(page, "POST", `/api/model/actions/${id}/comparison`),
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
        "POST",
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
      const difference = dialog.getByRole("region", {
        name: "Unterschied",
        exact: true,
      });
      return { chain, dialog, difference };
    };

    // M10.2: equal hits; derivation, step count and result side by side.
    const equal = await compared(CHAIN);
    await expect(equal.difference).toContainText("Treffermengen gleich", {
      timeout: 30_000,
    });
    await expect(equal.difference).toContainText("10 = 10, dieselben Objekte");
    await expect(equal.difference).not.toContainText("nur links");
    await expectSide(equal.dialog, "Werkzeugkette", [
      "5 Schritte, Ergebnis als eine Abfrage",
      "5",
      "10 von 137",
    ]);
    await expectSide(equal.dialog, "Direktabfrage", [
      "eine Abfrage, 3 Bedingungen",
      "1",
      "10 von 137",
    ]);
    await page.keyboard.press("Escape");
    await expect(equal.dialog).toHaveCount(0);

    // M10.3: left the chain (800 m, > 1.65: 11), right the direct query (10).
    const before = await hits(page).textContent();
    const { chain, dialog, difference } = await compared(DIFFERS);
    await expectSide(dialog, "Werkzeugkette", [
      "5 Schritte, Ergebnis als eine Abfrage",
      "5",
      "11 von 137",
    ]);
    await expectSide(dialog, "Direktabfrage", [
      "eine Abfrage, 3 Bedingungen",
      "1",
      "10 von 137",
    ]);
    await expect(difference).toContainText("2 nur links, 1 nur rechts");
    // By name, from the fixture (its left is the direct query, the dialog's the chain).
    const expected = fixture("compare_differs").expect!.comparison!;
    const names = (refs: { name: string }[]) =>
      refs.map((r) => r.name).join(", ");
    await expect(difference).toContainText(
      `Nur Werkzeugkette: ${names(expected.only_right)}`,
    );
    await expect(difference).toContainText(
      `Nur Direktabfrage: ${names(expected.only_left)}`,
    );
    // The reason in words, read from the two queries (WP76): under its heading,
    // one line per condition that differs, the chain's against the direct one's.
    const reasons = difference
      .getByText("Grund, aus den beiden Abfragen gelesen:", { exact: true })
      .locator("xpath=following-sibling::ul[1]")
      .getByRole("listitem");
    await expect(reasons).toHaveText([
      /^Werkzeugkette „≤ 800 m zu [^„“]+“, Direktabfrage „≤ 500 m zu [^„“]+“$/,
      /^Werkzeugkette „[^„“]*> 1\.65\)“, Direktabfrage „[^„“]*> 1\.6\)“$/,
    ]);
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

  test("a re-plan the run goes on with: step 5 finds nothing, steps 6 and 7 come in, are approved again and end in 10 von 137 (P4)", async () => {
    const page = workplace;
    await chooseLevel(page, "Prüfen");
    // The analysis of the test before: the chain's 11.
    const before = await hits(page).textContent();
    const known = callsTo(await stubLog(), urlOf(REPLANNED)).length;
    const { card, id } = await replanned(page, async (card, id) => {
      // M9.2 after a re-plan: steps 1 to 5 ran and stay, 6 and 7 are the
      // re-plan's, marked; the level asks again for them (Prüfen: always).
      const steps = stepsOf(card);
      // Six planned, the sixth replaced by the re-plan's two.
      await expect(steps).toHaveCount(5 + REPLAN_STEPS.length);
      await expect(
        card.getByText("Geplante Schritte · 7 von höchstens 8"),
      ).toBeVisible();
      for (let i = 0; i < 4; i++)
        await expect(steps.nth(i)).toHaveAttribute("data-status", "ok");
      await expect(steps.nth(3)).toContainText(
        `Modell sieht: ok · nicht leer · ${SENTINEL_POINTS}`,
      );
      await expect(steps.nth(4)).toHaveAttribute("data-status", "empty");
      await expect(steps.nth(4)).toContainText("Modell sieht: ok · leer · 0");
      for (const [i, step] of REPLAN_STEPS.entries()) {
        const item = steps.nth(5 + i);
        await expect(item).toHaveAttribute("data-status", "planned");
        await expect(item).toContainText(step.text);
        await expect(item).toContainText("neu geplant");
      }
      await expect(card.getByRole("group", { name: "Freigabe" })).toContainText(
        "Schritt 5 brachte kein Ergebnis; die Kette wurde neu geplant, geänderte Schritte sind markiert. Die Stufe verlangt eine neue Freigabe.",
      );
      const halted = await view(analyst, id);
      expect([halted.status, halted.replans, halted.stop_reason]).toEqual([
        "proposed",
        1,
        null,
      ]);
      expect(
        halted.steps.map((s) => [s.position, s.status, s.revised]),
      ).toEqual([
        [1, "ok", false],
        [2, "ok", false],
        [3, "ok", false],
        [4, "ok", false],
        [5, "empty", false],
        [6, "planned", true],
        [7, "planned", true],
      ]);
      await expect(hits(page)).toHaveText(before!);
    });

    // Run to its end: the reference question's 10, marked, not applied.
    await expect(card.getByLabel("Trefferzahl der Kette")).toHaveText(
      "10 von 137",
    );
    await expect(card).toContainText(/7 Schritte · \d+[.,]\d s/);
    const record = await view(analyst, id);
    expect([
      record.status,
      record.replans,
      record.stop_reason,
      record.stamp?.count,
    ]).toEqual(["done", 1, null, 10]);
    expect(record.steps.map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "empty",
      "ok",
      "ok",
    ]);
    expect(record.steps.at(-1)?.hits).toBe(10);
    expect(given(record.query)).toEqual(reference);
    await expect(hits(page)).toHaveText(before!);
    // One plan and one re-plan, nothing else asked of the model.
    expect((await callsSince(urlOf(REPLANNED), known)).map(isReplan)).toEqual([
      false,
      true,
    ]);

    // Adopted: the analysis is the reference question again, as the app sends it.
    await card.getByRole("button", { name: "Ergebnis übernehmen" }).click();
    await expect(hits(page)).toHaveText("10 von 137");
    const adopted = await view(analyst, id);
    expect([adopted.status, adopted.decision]).toEqual(["applied", "accepted"]);
    expect(given(await analysisQuery(page))).toEqual(reference);
  });

  test("privacy: no planted sentinel and no school name reaches the model, in plans, re-plans or steps (D9, D10)", async ({
    request,
  }) => {
    // Only what this test sends: the positive controls below are met by the
    // chain it runs, never by another test or spec.
    const cleared = await fetch(`${CONTROL}/_requests`, { method: "DELETE" });
    expect(cleared.status).toBe(204);
    await replanned(workplace);
    const requests = await stubLog();

    // Positive controls: the plan and the re-plan reached the model, each
    // with the plan's format and the question; the planted layer was in the
    // profile, one step read it, and the re-plan told the model what it may
    // see of that step and of the empty one (D9): ok, empty or not, the count.
    const calls = callsTo(requests, urlOf(REPLANNED));
    expect(calls.map(isReplan)).toEqual([false, true]);
    const [plan, replan] = calls;
    expectChainCall(plan, false);
    expectChainCall(replan, true);
    expect(JSON.stringify(plan.body.messages)).toContain(SENTINEL_LAYER);
    const input = userTurns(replan).at(-1)!;
    expect(input).toContain(
      `Schritt 4 (filter): {"outcome":"ok","empty":false,"count":${SENTINEL_POINTS}}`,
    );
    expect(input).toContain(
      'Schritt 5 (filter): {"outcome":"ok","empty":true,"count":0}',
    );

    const sentToModel = requests.map((r) => JSON.stringify(r.body)).join("\n");
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
