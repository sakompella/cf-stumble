/// <reference types="@cloudflare/workers-types" />
/* oxlint-disable eslint/max-lines, eslint/max-lines-per-function, eslint/max-classes-per-file */

import {
  healthyAgentSource,
  initializationErrorAgentSource,
  loadAgent,
  syntaxErrorAgentSource,
} from "../agent/loader.js";
import { buildGeneration } from "../generation/build.js";
import { parseGenerationNumber } from "../generation/types.js";
import { readGeneration } from "../generation/read.js";
import type {
  Attestation,
  Generation,
  Module,
  PromotionRejection,
  PromotionResult,
  Verdict,
} from "../generation/types.js";
import { assertNever, parseSha } from "../git/types.js";
import type { Sha, Signature } from "../git/types.js";
import type {
  EffectsDifference,
  PrimitiveCall,
  ReplayInconclusiveReason,
  WorkspaceFile,
} from "../replay/index.js";
import { parseReplaySession } from "../replay/index.js";
import { DurableObjectSqliteStore } from "../storage/do-sqlite.js";
import {
  computeCorpusVersion,
  computeGateVersion,
  type RecordedCaseOutcome,
  type ValidationCase,
  type ValidationCaseResult,
  type ValidationResult,
} from "../validation/index.js";
import { DurableObject } from "cloudflare:workers";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
};

type CandidateMode = "healthy" | "syntax" | "init";

type GenerationRow = {
  readonly sha: string;
  readonly number: number;
  readonly parent_sha: string | null;
  readonly manifest_sha: string;
  readonly created_at: number;
  readonly summary: string;
};

type PointerRow = { readonly sha: string | null };
type MetaRow = { readonly value: string };
type ContextRow = { readonly key: string; readonly value: string; readonly updated_at: number };
type HistoryRow = {
  readonly operation: string;
  readonly generation_sha: string;
  readonly from_sha: string | null;
  readonly created_at: number;
};
type CorpusRow = {
  readonly name: string;
  readonly session_json: string;
  readonly mandatory_canary: number;
};
type ValidationRow = {
  readonly candidate_sha: string;
  readonly validated_against: string | null;
  readonly corpus_version: string;
  readonly gate_version: string;
  readonly verdict: Verdict;
  readonly created_at: number;
  readonly case_results_json: string;
};

type GenerationSummary = {
  readonly sha: Sha;
  readonly number: number;
  readonly parent: Sha | null;
  readonly manifest: Sha;
  readonly createdAt: number;
  readonly summary: string;
};

type GenerationResponse = GenerationSummary & {
  readonly lineage: readonly GenerationSummary[];
};

type InvalidRequest = { readonly kind: "invalid-request"; readonly message: string };
type PromotionRejectionJson =
  | { readonly kind: "pointer-moved"; readonly expected: Sha | null; readonly actual: Sha | null }
  | {
      readonly kind: "stale-attestation";
      readonly validatedAgainst: Sha | null;
      readonly liveNow: Sha | null;
    }
  | { readonly kind: "corpus-changed"; readonly attested: string; readonly current: string }
  | { readonly kind: "gate-changed"; readonly attested: string; readonly current: string }
  | { readonly kind: "wrong-candidate"; readonly attested: Sha; readonly requested: Sha }
  | { readonly kind: "not-passing"; readonly verdict: Verdict };

const initialCandidate: CandidateMode = "healthy";
const secretKey = "supervisor-secret";
const POINTER_TABLE = "cf_stumble_pointer";
const GENERATIONS_TABLE = "cf_stumble_generations";
const HISTORY_TABLE = "cf_stumble_generation_history";
const META_TABLE = "cf_stumble_supervisor_meta";
const CONTEXT_TABLE = "cf_stumble_context";
const CORPUS_TABLE = "cf_stumble_corpus";
const VALIDATION_TABLE = "cf_stumble_validation_results";
const GENESIS_META_KEY = "genesis_sha";
const CORPUS_VERSION_META_KEY = "corpus_version";
const GATE_VERSION_META_KEY = "gate_version";
const INITIAL_TIMESTAMP = 1_700_000_000;

const genesisAuthor: Signature = {
  name: "cf-stumble supervisor",
  email: "supervisor@cf-stumble.invalid",
  timestamp: INITIAL_TIMESTAMP,
  timezoneOffsetMinutes: 0,
};

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly store: DurableObjectSqliteStore;
  private initialization: Promise<void> | undefined;
  private attempt = 0;
  private activeFacetName: string | undefined;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.store = new DurableObjectSqliteStore(ctx);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS spike_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS spike_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (
      pathname !== "/facet/ping" &&
      pathname !== "/facet/probe" &&
      !pathname.startsWith("/candidate/")
    ) {
      await this.ensureInitialized();
    }

    if (pathname === "/facet/ping") {
      return this.fetchFacet("ping");
    }
    if (pathname === "/facet/probe") {
      return this.fetchFacet("probe");
    }
    if (pathname === "/seed") {
      return this.seed();
    }
    if (pathname === "/inspect") {
      return this.inspect();
    }
    if (pathname === "/state") {
      return this.state();
    }
    if (pathname === "/promote") {
      return request.method === "GET" ? this.legacyPromote() : this.promote(request);
    }
    if (pathname === "/rollback") {
      return this.rollback(request);
    }
    if (pathname === "/reset") {
      return request.method === "GET" ? this.legacyReset() : this.reset();
    }
    if (pathname === "/generations") {
      return request.method === "POST" ? this.createGeneration(request) : this.listGenerations();
    }
    if (pathname === "/generations/live") {
      return this.live();
    }
    if (pathname === "/history") {
      return this.history();
    }
    if (pathname.startsWith("/generations/")) {
      return this.showGeneration(pathname.slice("/generations/".length));
    }
    if (pathname === "/live" || pathname === "/generation/live") {
      return this.live();
    }
    if (pathname === "/context") {
      return request.method === "POST" ? this.writeContext(request) : this.readContext();
    }
    if (pathname === "/corpus") {
      return request.method === "POST" ? this.writeCorpus(request) : this.readCorpus();
    }
    if (pathname === "/validation-results") {
      return request.method === "POST"
        ? this.writeValidationResult(request)
        : this.readValidationResults(new URL(request.url));
    }
    if (pathname === "/turn") {
      return this.turn(request);
    }
    if (pathname === "/candidate/healthy") {
      return this.setCandidate("healthy");
    }
    if (pathname === "/candidate/syntax") {
      return this.setCandidate("syntax");
    }
    if (pathname === "/candidate/init") {
      return this.setCandidate("init");
    }
    return new Response("not found", { status: 404 });
  }

  private ensureInitialized(): Promise<void> {
    this.initialization ??= this.ctx.blockConcurrencyWhile(() => this.initialize());
    return this.initialization;
  }

  private async initialize(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${GENERATIONS_TABLE} (sha TEXT PRIMARY KEY, number INTEGER NOT NULL, parent_sha TEXT, manifest_sha TEXT NOT NULL, created_at INTEGER NOT NULL, summary TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, generation_sha TEXT NOT NULL, from_sha TEXT, created_at INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${CONTEXT_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${CORPUS_TABLE} (name TEXT PRIMARY KEY, session_json TEXT NOT NULL, mandatory_canary INTEGER NOT NULL CHECK (mandatory_canary IN (0, 1)))`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${VALIDATION_TABLE} (candidate_sha TEXT PRIMARY KEY, validated_against TEXT, corpus_version TEXT NOT NULL, gate_version TEXT NOT NULL, verdict TEXT NOT NULL, created_at INTEGER NOT NULL, case_results_json TEXT NOT NULL)`,
    );

    if (this.readState("candidate") === undefined) {
      this.writeState("candidate", initialCandidate);
    }
    if (this.readState("generation") === undefined) {
      this.writeState("generation", "0");
    }

    const [corpusVersion, gateVersion] = await Promise.all([
      computeCorpusVersion([]),
      computeGateVersion(),
    ]);
    const existingGenesis = this.readMeta(GENESIS_META_KEY);
    if (existingGenesis === undefined) {
      const genesis = await buildGeneration(this.store, {
        modules: [
          {
            path: "agent.js",
            content: new TextEncoder().encode(healthyAgentSource),
            executable: false,
          },
        ],
        parent: undefined,
        author: genesisAuthor,
        createdAt: INITIAL_TIMESTAMP,
        summary: "known-good generation 0",
      });
      this.ctx.storage.transactionSync(() => {
        this.insertGeneration(genesis);
        this.ctx.storage.sql.exec(
          `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
          GENESIS_META_KEY,
          genesis.sha,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
          CORPUS_VERSION_META_KEY,
          corpusVersion,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
          GATE_VERSION_META_KEY,
          gateVersion,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO ${HISTORY_TABLE} (operation, generation_sha, from_sha, created_at) VALUES (?, ?, ?, ?)`,
          "seed",
          genesis.sha,
          null,
          Date.now(),
        );
        this.ctx.storage.sql.exec(
          `UPDATE ${POINTER_TABLE} SET sha = ? WHERE id = 1 AND sha IS NULL`,
          genesis.sha,
        );
      });
      return;
    }

    if (this.readMeta(CORPUS_VERSION_META_KEY) === undefined) {
      this.writeMeta(CORPUS_VERSION_META_KEY, corpusVersion);
    }
    if (this.readMeta(GATE_VERSION_META_KEY) === undefined) {
      this.writeMeta(GATE_VERSION_META_KEY, gateVersion);
    }
    this.ctx.storage.sql.exec(
      `UPDATE ${POINTER_TABLE} SET sha = ? WHERE id = 1 AND sha IS NULL`,
      existingGenesis,
    );
  }

  private fetchFacet(path: "ping" | "probe"): Promise<Response> {
    const facet = this.mountFacet(this.readCandidateSource());
    return facet.fetch(new Request(`https://facet/${path}`));
  }

  private mountFacet(source: string): Fetcher {
    this.attempt += 1;
    const uniqueName = `${this.attempt}-${crypto.randomUUID()}`;
    const worker = loadAgent(this.env.LOADER, `candidate-${uniqueName}`, source);
    const facetName = `agent-${uniqueName}`;
    const agentClass = worker.getDurableObjectClass("Agent");
    const facet = this.ctx.facets.get(facetName, () => ({ class: agentClass }));
    this.activeFacetName = facetName;
    return facet;
  }

  private seed(): Response {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO spike_secrets (key, value) VALUES (?, ?)",
      secretKey,
      "supervisor-only-secret",
    );
    this.writeState("generation", "0");
    return new Response("seeded", { status: 201 });
  }

  private inspect(): Response {
    const rows = this.ctx.storage.sql
      .exec<{ key: string; value: string }>("SELECT key, value FROM spike_secrets ORDER BY key")
      .toArray();
    return Response.json({ rows });
  }

  private state(): Response {
    return Response.json({
      candidate: this.readState("candidate"),
      generation: this.readState("generation"),
      live: this.readPointerSql() ?? null,
      corpusVersion: this.readMeta(CORPUS_VERSION_META_KEY),
      gateVersion: this.readMeta(GATE_VERSION_META_KEY),
    });
  }

  private async legacyPromote(): Promise<Response> {
    try {
      const facet = this.mountFacet(this.readCandidateSource());
      const response = await facet.fetch(new Request("https://facet/probe"));
      if (!response.ok) {
        return Response.json(
          { promoted: false, reason: `facet returned ${response.status}` },
          { status: 422 },
        );
      }
      this.writeState("generation", "candidate");
      return Response.json({ promoted: true });
    } catch (error: unknown) {
      return Response.json({ promoted: false, reason: errorMessage(error) }, { status: 422 });
    }
  }

  private async promote(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const candidate = parseShaField(body.candidate, "candidate");
      const attestation = parseAttestation(body.attestation ?? body, "attestation");
      const suppliedResultValue = body.validationResult ?? body.result;
      const suppliedResult =
        suppliedResultValue === undefined
          ? undefined
          : parseValidationResult(suppliedResultValue, "validationResult");
      if (suppliedResult !== undefined) {
        ensureResultMatchesAttestation(suppliedResult, attestation);
      }
      const candidateGeneration = await this.readCandidateGeneration(candidate);

      const result = this.promoteTransaction(
        candidate,
        attestation,
        suppliedResult,
        candidateGeneration,
      );
      return promotionResponse(result);
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private async readCandidateGeneration(candidate: Sha): Promise<Generation> {
    try {
      return (await readGeneration(this.store, candidate)).generation;
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.startsWith("missing generation commit object")) {
        throw new MissingResourceError(`candidate generation ${candidate} does not exist`);
      }
      throw error;
    }
  }

  private promoteTransaction(
    candidate: Sha,
    attestation: Attestation,
    suppliedResult: ValidationResult | undefined,
    candidateGeneration: Generation,
  ): PromotionResult {
    let result: PromotionResult | undefined;
    this.ctx.storage.transactionSync(() => {
      const liveNow = this.readPointerSql();
      const registeredGeneration = this.readGenerationRow(candidate);
      const corpusVersion = this.readMetaOrThrow(CORPUS_VERSION_META_KEY);
      const gateVersion = this.readMetaOrThrow(GATE_VERSION_META_KEY);
      const rejection = verifyAttestation(
        candidate,
        attestation,
        liveNow,
        corpusVersion,
        gateVersion,
      );
      if (rejection !== undefined) {
        result = { outcome: "rejected", reason: rejection };
        return;
      }

      const swapped = this.updatePointer(candidate, liveNow);
      if (!swapped) {
        result = {
          outcome: "rejected",
          reason: {
            kind: "pointer-moved",
            expected: liveNow,
            actual: this.readPointerSql(),
          },
        };
        return;
      }

      if (registeredGeneration === undefined) {
        this.insertGeneration(candidateGeneration);
      }
      const validation = suppliedResult ?? makeValidationResult(attestation, attestation.createdAt);
      this.insertValidationResult(validation);
      this.ctx.storage.sql.exec(
        `INSERT INTO ${HISTORY_TABLE} (operation, generation_sha, from_sha, created_at) VALUES (?, ?, ?, ?)`,
        "promote",
        candidate,
        liveNow,
        Date.now(),
      );
      result = { outcome: "promoted", from: liveNow, to: candidate };
    });
    if (result === undefined) {
      throw new Error("promotion transaction did not produce a result");
    }
    return result;
  }

  private async rollback(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const target = parseShaField(body.target, "target");
      const expected = parseNullableSha(body.expected, "expected");
      const result = this.rollbackTransaction(target, expected);
      return promotionResponse(result);
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private rollbackTransaction(target: Sha, expected: Sha | undefined): PromotionResult {
    let result: PromotionResult | undefined;
    this.ctx.storage.transactionSync(() => {
      if (this.readGenerationRow(target) === undefined) {
        throw new MissingResourceError(`rollback target generation ${target} does not exist`);
      }
      const actual = this.readPointerSql();
      const compareWith = expected ?? actual;
      if (!this.updatePointer(target, compareWith)) {
        result = {
          outcome: "rejected",
          reason: { kind: "pointer-moved", expected: compareWith, actual: this.readPointerSql() },
        };
        return;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO ${HISTORY_TABLE} (operation, generation_sha, from_sha, created_at) VALUES (?, ?, ?, ?)`,
        "rollback",
        target,
        actual,
        Date.now(),
      );
      result = { outcome: "promoted", from: actual, to: target };
    });
    if (result === undefined) {
      throw new Error("rollback transaction did not produce a result");
    }
    return result;
  }

  private legacyReset(): Response {
    this.deleteActiveFacet();
    this.resetPointerOnly();
    this.writeState("generation", "0");
    return Response.json({ generation: "0", reset: true });
  }

  private reset(): Response {
    try {
      this.deleteActiveFacet();
      const genesis = parseSha(this.readMetaOrThrow(GENESIS_META_KEY));
      let from: Sha | undefined;
      this.ctx.storage.transactionSync(() => {
        from = this.readPointerSql();
        if (!this.updatePointer(genesis, from)) {
          throw new Error("generation 0 reset lost a pointer race");
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO ${HISTORY_TABLE} (operation, generation_sha, from_sha, created_at) VALUES (?, ?, ?, ?)`,
          "reset",
          genesis,
          from,
          Date.now(),
        );
      });
      this.writeState("generation", "0");
      return Response.json({
        outcome: "reset",
        generation: 0,
        from: from ?? null,
        to: genesis,
      });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private resetPointerOnly(): void {
    const genesis = parseSha(this.readMetaOrThrow(GENESIS_META_KEY));
    this.ctx.storage.transactionSync(() => {
      const from = this.readPointerSql();
      if (!this.updatePointer(genesis, from)) {
        throw new Error("generation 0 reset lost a pointer race");
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO ${HISTORY_TABLE} (operation, generation_sha, from_sha, created_at) VALUES (?, ?, ?, ?)`,
        "reset",
        genesis,
        from,
        Date.now(),
      );
    });
  }

  private listGenerations(): Response {
    try {
      const rows = this.readGenerationRows();
      const bySha = new Map(rows.map((row) => [row.sha, row]));
      const generations = rows.map((row) => generationResponse(row, bySha));
      return Response.json({ generations });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private history(): Response {
    try {
      const rows = this.ctx.storage.sql
        .exec<HistoryRow>(
          `SELECT operation, generation_sha, from_sha, created_at FROM ${HISTORY_TABLE} ORDER BY id`,
        )
        .toArray();
      return Response.json({
        history: rows.map((row) => ({
          operation: row.operation,
          generation: parseSha(row.generation_sha),
          from: row.from_sha === null ? null : parseSha(row.from_sha),
          createdAt: row.created_at,
        })),
      });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private showGeneration(rawSha: string): Response {
    try {
      const sha = parseSha(decodeURIComponent(rawSha));
      const row = this.readGenerationRow(sha);
      if (row === undefined) {
        return Response.json(
          { error: { kind: "not-found", resource: "generation", sha } },
          { status: 404 },
        );
      }
      const bySha = new Map(this.readGenerationRows().map((entry) => [entry.sha, entry]));
      return Response.json({ generation: generationResponse(row, bySha) });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private live(): Response {
    try {
      const live = this.readPointerSql();
      if (live === undefined) {
        return Response.json({ generation: null });
      }
      const row = this.readGenerationRow(live);
      if (row === undefined) {
        return Response.json(
          { error: { kind: "corrupt-state", message: `live generation ${live} is missing` } },
          { status: 500 },
        );
      }
      const bySha = new Map(this.readGenerationRows().map((entry) => [entry.sha, entry]));
      return Response.json({ generation: generationResponse(row, bySha) });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private async createGeneration(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const modules = parseModules(body.modules);
      const summary = readNonEmptyString(body.summary, "summary");
      const createdAt =
        body.createdAt === undefined
          ? Math.floor(Date.now() / 1_000)
          : readSafeInteger(body.createdAt, "createdAt");
      const liveSha = this.readPointerSql();
      if (liveSha === undefined) {
        return Response.json(
          {
            error: {
              kind: "conflict",
              message: "cannot create a candidate without a live generation",
            },
          },
          { status: 409 },
        );
      }
      const parent = this.readGenerationRow(liveSha);
      if (parent === undefined) {
        return Response.json(
          { error: { kind: "corrupt-state", message: `live generation ${liveSha} is missing` } },
          { status: 500 },
        );
      }
      const generation = await buildGeneration(this.store, {
        modules,
        parent: toGeneration(parent),
        author: genesisAuthor,
        createdAt,
        summary,
      });
      this.ctx.storage.transactionSync(() => {
        this.insertGeneration(generation);
      });
      const bySha = new Map(this.readGenerationRows().map((entry) => [entry.sha, entry]));
      return Response.json(
        { generation: generationResponse(this.readGenerationRowOrThrow(generation.sha), bySha) },
        { status: 201 },
      );
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private async writeContext(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const key = readNonEmptyString(body.key, "key");
      const value = body.value;
      if (value === undefined) {
        throw new InvalidRequestError("value must be present and JSON-compatible");
      }
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new InvalidRequestError("value must be JSON-compatible");
      }
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO ${CONTEXT_TABLE} (key, value, updated_at) VALUES (?, ?, ?)`,
        key,
        encoded,
        Date.now(),
      );
      return Response.json({ key, value }, { status: 201 });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private readContext(): Response {
    try {
      const rows = this.ctx.storage.sql
        .exec<ContextRow>(`SELECT key, value, updated_at FROM ${CONTEXT_TABLE} ORDER BY key`)
        .toArray();
      return Response.json({
        context: rows.map((row) => ({
          key: row.key,
          value: parseStoredJson(row.value, `context ${row.key}`),
          updatedAt: row.updated_at,
        })),
      });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private async writeCorpus(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const validationCase = parseValidationCase(body, "case");
      const current = this.readCorpusCases();
      const withoutCurrent = current.filter((entry) => entry.name !== validationCase.name);
      const corpus = [...withoutCurrent, validationCase];
      const corpusVersion = await computeCorpusVersion(corpus);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO ${CORPUS_TABLE} (name, session_json, mandatory_canary) VALUES (?, ?, ?)`,
          validationCase.name,
          JSON.stringify(validationCase.session),
          validationCase.mandatoryCanary ? 1 : 0,
        );
        this.ctx.storage.sql.exec(
          `UPDATE ${META_TABLE} SET value = ? WHERE key = ?`,
          corpusVersion,
          CORPUS_VERSION_META_KEY,
        );
      });
      return Response.json({ validationCase, corpusVersion }, { status: 201 });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private readCorpus(): Response {
    try {
      return Response.json({
        corpus: this.readCorpusCases(),
        corpusVersion: this.readMetaOrThrow(CORPUS_VERSION_META_KEY),
      });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private async writeValidationResult(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const result = parseValidationResult(body.result ?? body, "result");
      this.insertValidationResult(result);
      return Response.json({ result }, { status: 201 });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private readValidationResults(url: URL): Response {
    try {
      const candidateValue = url.searchParams.get("candidate");
      const verdictValue = url.searchParams.get("verdict");
      const candidate =
        candidateValue === null ? undefined : parseShaField(candidateValue, "candidate");
      const verdict = verdictValue === null ? undefined : parseVerdict(verdictValue, "verdict");
      const clauses: string[] = [];
      const parameters: (string | number | null)[] = [];
      if (candidate !== undefined) {
        clauses.push("candidate_sha = ?");
        parameters.push(candidate);
      }
      if (verdict !== undefined) {
        clauses.push("verdict = ?");
        parameters.push(verdict);
      }
      const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
      const rows = this.ctx.storage.sql
        .exec<ValidationRow>(
          `SELECT candidate_sha, validated_against, corpus_version, gate_version, verdict, created_at, case_results_json FROM ${VALIDATION_TABLE}${where} ORDER BY created_at`,
          ...parameters,
        )
        .toArray();
      return Response.json({ results: rows.map((row) => validationResponse(row)) });
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private async turn(request: Request): Promise<Response> {
    try {
      const pinned = this.readPointerSql();
      if (pinned === undefined) {
        return Response.json(
          { error: { kind: "conflict", message: "cannot start a turn without a live generation" } },
          { status: 409 },
        );
      }
      const loaded = await readGeneration(this.store, pinned);
      const source = loaded.modules.find((module) => module.path === "agent.js");
      if (source === undefined) {
        throw new Error(`generation ${pinned} has no agent.js module`);
      }
      const facet = this.mountFacet(new TextDecoder().decode(source.content));
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      const facetRequest =
        body === undefined
          ? new Request("https://facet/turn", { method: "POST" })
          : new Request("https://facet/turn", { method: "POST", body });
      const facetResponse = await facet.fetch(facetRequest);
      const facetText = await facetResponse.text();
      return Response.json(
        { generation: pinned, result: parseJsonOrText(facetText) },
        {
          status: facetResponse.status,
        },
      );
    } catch (error: unknown) {
      return requestErrorResponse(error);
    }
  }

  private setCandidate(mode: CandidateMode): Response {
    this.writeState("candidate", mode);
    return Response.json({ candidate: mode });
  }

  private readCandidateSource(): string {
    const candidate = this.readState("candidate");
    if (candidate === "syntax") {
      return syntaxErrorAgentSource;
    }
    if (candidate === "init") {
      return initializationErrorAgentSource;
    }
    return healthyAgentSource;
  }

  private deleteActiveFacet(): void {
    if (this.activeFacetName !== undefined) {
      this.ctx.facets.delete(this.activeFacetName);
      this.activeFacetName = undefined;
    }
  }

  private readState(key: string): string | undefined {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM spike_state WHERE key = ?", key)
      .toArray();
    return rows[0]?.value;
  }

  private writeState(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO spike_state (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  private readMeta(key: string): string | undefined {
    const rows = this.ctx.storage.sql
      .exec<MetaRow>(`SELECT value FROM ${META_TABLE} WHERE key = ?`, key)
      .toArray();
    return rows[0]?.value;
  }

  private readMetaOrThrow(key: string): string {
    const value = this.readMeta(key);
    if (value === undefined) {
      throw new Error(`missing supervisor metadata ${key}`);
    }
    return value;
  }

  private writeMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
      key,
      value,
    );
  }

  private readPointerSql(): Sha | undefined {
    const rows = this.ctx.storage.sql
      .exec<PointerRow>(`SELECT sha FROM ${POINTER_TABLE} WHERE id = 1`)
      .toArray();
    const value = rows[0]?.sha;
    return value === null || value === undefined ? undefined : parseSha(value);
  }

  private updatePointer(next: Sha, expected: Sha | undefined): boolean {
    const result =
      expected === undefined
        ? this.ctx.storage.sql.exec(
            `UPDATE ${POINTER_TABLE} SET sha = ? WHERE id = 1 AND sha IS NULL`,
            next,
          )
        : this.ctx.storage.sql.exec(
            `UPDATE ${POINTER_TABLE} SET sha = ? WHERE id = 1 AND sha = ?`,
            next,
            expected,
          );
    return result.rowsWritten === 1;
  }

  private readGenerationRows(): readonly GenerationRow[] {
    return this.ctx.storage.sql
      .exec<GenerationRow>(
        `SELECT sha, number, parent_sha, manifest_sha, created_at, summary FROM ${GENERATIONS_TABLE} ORDER BY number, sha`,
      )
      .toArray();
  }

  private readGenerationRow(sha: Sha): GenerationRow | undefined {
    const rows = this.ctx.storage.sql
      .exec<GenerationRow>(
        `SELECT sha, number, parent_sha, manifest_sha, created_at, summary FROM ${GENERATIONS_TABLE} WHERE sha = ?`,
        sha,
      )
      .toArray();
    return rows[0];
  }

  private readGenerationRowOrThrow(sha: Sha): GenerationRow {
    const row = this.readGenerationRow(sha);
    if (row === undefined) {
      throw new Error(`generation ${sha} was not registered`);
    }
    return row;
  }

  private insertGeneration(generation: Generation): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO ${GENERATIONS_TABLE} (sha, number, parent_sha, manifest_sha, created_at, summary) VALUES (?, ?, ?, ?, ?, ?)`,
      generation.sha,
      generation.number,
      generation.parent ?? null,
      generation.manifest,
      generation.createdAt,
      generation.summary,
    );
  }

  private readCorpusCases(): readonly ValidationCase[] {
    const rows = this.ctx.storage.sql
      .exec<CorpusRow>(
        `SELECT name, session_json, mandatory_canary FROM ${CORPUS_TABLE} ORDER BY name`,
      )
      .toArray();
    return rows.map((row) => ({
      name: row.name,
      session: parseReplaySession(parseStoredJson(row.session_json, `corpus ${row.name}`)),
      mandatoryCanary: row.mandatory_canary === 1,
    }));
  }

  private insertValidationResult(result: ValidationResult): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ${VALIDATION_TABLE} (candidate_sha, validated_against, corpus_version, gate_version, verdict, created_at, case_results_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      result.candidate,
      result.validatedAgainst ?? null,
      result.corpusVersion,
      result.gateVersion,
      result.verdict,
      result.createdAt,
      JSON.stringify(result.caseResults),
    );
  }
}

function toGeneration(row: GenerationRow): Generation {
  return {
    sha: parseSha(row.sha),
    number: parseGenerationNumber(row.number),
    parent: row.parent_sha === null ? undefined : parseSha(row.parent_sha),
    manifest: parseSha(row.manifest_sha),
    createdAt: row.created_at,
    summary: row.summary,
  };
}

function generationResponse(
  row: GenerationRow,
  bySha: ReadonlyMap<string, GenerationRow>,
): GenerationResponse {
  const lineage: GenerationRow[] = [];
  const visited = new Set<string>();
  let current: GenerationRow | undefined = row;
  while (current !== undefined) {
    if (visited.has(current.sha)) {
      throw new Error(`generation lineage cycle detected at ${current.sha}`);
    }
    visited.add(current.sha);
    lineage.push(current);
    const parentSha: string | null = current.parent_sha;
    current = parentSha === null ? undefined : bySha.get(parentSha);
    if (current === undefined && parentSha !== null) {
      throw new Error(`generation lineage references missing parent for ${row.sha}`);
    }
  }
  return {
    ...generationSummary(row),
    lineage: lineage.map((entry) => generationSummary(entry)),
  };
}

function generationSummary(row: GenerationRow): GenerationSummary {
  return {
    sha: parseSha(row.sha),
    number: row.number,
    parent: row.parent_sha === null ? null : parseSha(row.parent_sha),
    manifest: parseSha(row.manifest_sha),
    createdAt: row.created_at,
    summary: row.summary,
  };
}

function promotionResponse(result: PromotionResult): Response {
  if (result.outcome === "promoted") {
    return Response.json({
      outcome: result.outcome,
      from: result.from ?? null,
      to: result.to,
    });
  }
  const status = result.reason.kind === "pointer-moved" ? 409 : 422;
  return Response.json(
    { outcome: result.outcome, reason: serializePromotionRejection(result.reason) },
    { status },
  );
}

function serializePromotionRejection(reason: PromotionRejection): PromotionRejectionJson {
  switch (reason.kind) {
    case "pointer-moved":
      return {
        kind: reason.kind,
        expected: reason.expected ?? null,
        actual: reason.actual ?? null,
      };
    case "stale-attestation":
      return {
        kind: reason.kind,
        validatedAgainst: reason.validatedAgainst ?? null,
        liveNow: reason.liveNow ?? null,
      };
    case "corpus-changed":
    case "gate-changed":
    case "wrong-candidate":
    case "not-passing":
      return reason;
    default:
      return assertNever(reason, "promotion rejection");
  }
}

function verifyAttestation(
  candidate: Sha,
  attestation: Attestation,
  liveNow: Sha | undefined,
  corpusVersion: string,
  gateVersion: string,
): PromotionRejection | undefined {
  if (attestation.candidate !== candidate) {
    return {
      kind: "wrong-candidate",
      attested: attestation.candidate,
      requested: candidate,
    };
  }
  if (attestation.validatedAgainst !== liveNow) {
    return {
      kind: "stale-attestation",
      validatedAgainst: attestation.validatedAgainst,
      liveNow,
    };
  }
  if (attestation.corpusVersion !== corpusVersion) {
    return {
      kind: "corpus-changed",
      attested: attestation.corpusVersion,
      current: corpusVersion,
    };
  }
  if (attestation.gateVersion !== gateVersion) {
    return {
      kind: "gate-changed",
      attested: attestation.gateVersion,
      current: gateVersion,
    };
  }
  switch (attestation.verdict) {
    case "pass":
      return undefined;
    case "fail":
    case "inconclusive":
      return { kind: "not-passing", verdict: attestation.verdict };
    default:
      return assertNever(attestation.verdict, "attestation verdict");
  }
}

function makeValidationResult(attestation: Attestation, createdAt: number): ValidationResult {
  return {
    candidate: attestation.candidate,
    validatedAgainst: attestation.validatedAgainst,
    corpusVersion: attestation.corpusVersion,
    gateVersion: attestation.gateVersion,
    verdict: attestation.verdict,
    createdAt,
    caseResults: [],
  };
}

function ensureResultMatchesAttestation(result: ValidationResult, attestation: Attestation): void {
  if (
    result.candidate !== attestation.candidate ||
    result.validatedAgainst !== attestation.validatedAgainst ||
    result.corpusVersion !== attestation.corpusVersion ||
    result.gateVersion !== attestation.gateVersion ||
    result.verdict !== attestation.verdict
  ) {
    throw new InvalidRequestError("validationResult does not match attestation");
  }
}

async function readRequestRecord(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await request.text());
  } catch (error: unknown) {
    throw new InvalidRequestError(`request body is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) {
    throw new InvalidRequestError("request body must be a JSON object");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidRequestError(`${path} must be a non-empty string`);
  }
  return value;
}

function readSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new InvalidRequestError(`${path} must be a safe integer`);
  }
  return value;
}

function parseShaField(value: unknown, path: string): Sha {
  const raw = readNonEmptyString(value, path);
  try {
    return parseSha(raw);
  } catch (error: unknown) {
    throw new InvalidRequestError(`${path} is invalid: ${errorMessage(error)}`);
  }
}

function parseNullableSha(value: unknown, path: string): Sha | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseShaField(value, path);
}

function parseVerdict(value: unknown, path: string): Verdict {
  if (value === "pass" || value === "fail" || value === "inconclusive") {
    return value;
  }
  throw new InvalidRequestError(`${path} must be pass, fail, or inconclusive`);
}

function parseAttestation(value: unknown, path: string): Attestation {
  const record = readRecord(value, path);
  return {
    candidate: parseShaField(record.candidate, `${path}.candidate`),
    validatedAgainst: parseNullableSha(record.validatedAgainst, `${path}.validatedAgainst`),
    corpusVersion: readNonEmptyString(record.corpusVersion, `${path}.corpusVersion`),
    gateVersion: readNonEmptyString(record.gateVersion, `${path}.gateVersion`),
    verdict: parseVerdict(record.verdict, `${path}.verdict`),
    createdAt: readSafeInteger(record.createdAt, `${path}.createdAt`),
  };
}

function parseModules(value: unknown): readonly Module[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestError("modules must be a non-empty array");
  }
  return value.map((entry, index) => {
    const path = `modules[${index}]`;
    const record = readRecord(entry, path);
    return {
      path: readNonEmptyString(record.path, `${path}.path`),
      content: new TextEncoder().encode(readString(record.content, `${path}.content`)),
      executable: readBoolean(record.executable, `${path}.executable`),
    } satisfies Module;
  });
}

function parseValidationCase(value: unknown, path: string): ValidationCase {
  const record = readRecord(value, path);
  const name = readNonEmptyString(record.name, `${path}.name`);
  const session = parseReplaySession(record.session);
  return {
    name,
    session,
    mandatoryCanary: readBoolean(record.mandatoryCanary, `${path}.mandatoryCanary`),
  };
}

function parseValidationResult(value: unknown, path: string): ValidationResult {
  const record = readRecord(value, path);
  const caseResultsValue = record.caseResults;
  if (!Array.isArray(caseResultsValue)) {
    throw new InvalidRequestError(`${path}.caseResults must be an array`);
  }
  return {
    candidate: parseShaField(record.candidate, `${path}.candidate`),
    validatedAgainst: parseNullableSha(record.validatedAgainst, `${path}.validatedAgainst`),
    corpusVersion: readNonEmptyString(record.corpusVersion, `${path}.corpusVersion`),
    gateVersion: readNonEmptyString(record.gateVersion, `${path}.gateVersion`),
    verdict: parseVerdict(record.verdict, `${path}.verdict`),
    createdAt: readSafeInteger(record.createdAt, `${path}.createdAt`),
    caseResults: caseResultsValue.map((entry, index) =>
      parseValidationCaseResult(entry, `${path}.caseResults[${index}]`),
    ),
  };
}

function parseValidationCaseResult(value: unknown, path: string): ValidationCaseResult {
  const record = readRecord(value, path);
  return {
    name: readNonEmptyString(record.name, `${path}.name`),
    mandatoryCanary: readBoolean(record.mandatoryCanary, `${path}.mandatoryCanary`),
    baseline: parseRecordedCaseOutcome(record.baseline, `${path}.baseline`),
    candidate: parseRecordedCaseOutcome(record.candidate, `${path}.candidate`),
  };
}

function parseRecordedCaseOutcome(value: unknown, path: string): RecordedCaseOutcome {
  const record = readRecord(value, path);
  const status = readNonEmptyString(record.status, `${path}.status`);
  switch (status) {
    case "PASS":
      return { status };
    case "FAIL":
      return {
        status,
        difference: parseEffectsDifference(record.difference, `${path}.difference`),
      };
    case "INCONCLUSIVE":
      return {
        status,
        reason: parseInconclusiveReason(record.reason, `${path}.reason`),
        detail: readString(record.detail, `${path}.detail`),
      };
    default:
      throw new InvalidRequestError(`${path}.status is unsupported`);
  }
}

function parseEffectsDifference(value: unknown, path: string): EffectsDifference {
  const record = readRecord(value, path);
  const kind = readNonEmptyString(record.kind, `${path}.kind`);
  if (kind === "trace") {
    return {
      kind,
      index: readSafeInteger(record.index, `${path}.index`),
      expected: parseNullablePrimitiveCall(record.expected, `${path}.expected`),
      actual: parseNullablePrimitiveCall(record.actual, `${path}.actual`),
    };
  }
  if (kind === "workspace") {
    return {
      kind,
      path: readNonEmptyString(record.path, `${path}.path`),
      expected: parseNullableWorkspaceFile(record.expected, `${path}.expected`),
      actual: parseNullableWorkspaceFile(record.actual, `${path}.actual`),
    };
  }
  throw new InvalidRequestError(`${path}.kind is unsupported`);
}

function parseNullablePrimitiveCall(value: unknown, path: string): PrimitiveCall | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = readRecord(value, path);
  const kind = readNonEmptyString(record.kind, `${path}.kind`);
  switch (kind) {
    case "read":
      return { kind, path: readNonEmptyString(record.path, `${path}.path`) };
    case "write":
      return {
        kind,
        path: readNonEmptyString(record.path, `${path}.path`),
        content: readString(record.content, `${path}.content`),
      };
    case "edit":
      return {
        kind,
        path: readNonEmptyString(record.path, `${path}.path`),
        oldText: readString(record.oldText, `${path}.oldText`),
        newText: readString(record.newText, `${path}.newText`),
      };
    case "bash":
      return { kind, command: readNonEmptyString(record.command, `${path}.command`) };
    default:
      throw new InvalidRequestError(`${path}.kind is unsupported`);
  }
}

function parseNullableWorkspaceFile(value: unknown, path: string): WorkspaceFile | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = readRecord(value, path);
  return {
    path: readNonEmptyString(record.path, `${path}.path`),
    content: readString(record.content, `${path}.content`),
  };
}

function parseInconclusiveReason(value: unknown, path: string): ReplayInconclusiveReason {
  const reason = readNonEmptyString(value, path);
  switch (reason) {
    case "tape-exhausted":
    case "unexpected-model-request":
    case "unused-tape":
    case "timeout":
    case "malformed-response":
    case "agent-error":
      return reason;
    default:
      throw new InvalidRequestError(`${path} is unsupported`);
  }
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidRequestError(`${path} must be an object`);
  }
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new InvalidRequestError(`${path} must be a string`);
  }
  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new InvalidRequestError(`${path} must be a boolean`);
  }
  return value;
}

function parseStoredJson(value: string, path: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error: unknown) {
    throw new Error(`${path} contains invalid JSON: ${errorMessage(error)}`, { cause: error });
  }
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function validationResponse(row: ValidationRow): ValidationResult {
  const caseResults = parseStoredJson(row.case_results_json, `validation ${row.candidate_sha}`);
  if (!Array.isArray(caseResults)) {
    throw new TypeError(`validation ${row.candidate_sha} case results are not an array`);
  }
  return {
    candidate: parseSha(row.candidate_sha),
    validatedAgainst: row.validated_against === null ? undefined : parseSha(row.validated_against),
    corpusVersion: row.corpus_version,
    gateVersion: row.gate_version,
    verdict: row.verdict,
    createdAt: row.created_at,
    caseResults: caseResults.map((entry, index) =>
      parseValidationCaseResult(entry, `validation ${row.candidate_sha}[${index}]`),
    ),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class InvalidRequestError extends Error implements InvalidRequest {
  readonly kind = "invalid-request";

  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

class MissingResourceError extends Error {
  readonly kind = "not-found";

  constructor(message: string) {
    super(message);
    this.name = "MissingResourceError";
  }
}

function requestErrorResponse(error: unknown): Response {
  if (error instanceof InvalidRequestError) {
    return Response.json(
      { error: { kind: error.kind, message: error.message } satisfies InvalidRequest },
      { status: 400 },
    );
  }
  if (error instanceof MissingResourceError) {
    return Response.json({ error: { kind: error.kind, message: error.message } }, { status: 404 });
  }
  return Response.json(
    { error: { kind: "internal", message: errorMessage(error) } },
    { status: 500 },
  );
}
