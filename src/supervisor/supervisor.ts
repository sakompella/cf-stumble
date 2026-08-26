/// <reference types="@cloudflare/workers-types" />
/* oxlint-disable eslint/max-lines, eslint/max-lines-per-function, eslint/max-classes-per-file, import/max-dependencies, unicorn/no-array-sort */

import { authorizeSupervisorRequest } from "./auth.js";
import {
  healthyAgentSource,
  initializationErrorAgentSource,
  loadAgent,
  syntaxErrorAgentSource,
} from "../agent/loader.js";
import {
  AgentExecutor,
  AgentMaterializationError,
  type AgentDefinition,
  type AgentSkill,
} from "../agent/runtime/index.js";
import { buildGeneration } from "../generation/build.js";
import { makeGenesisPin, seedGenesis } from "../generation/genesis.js";
import type { GenesisPin } from "../generation/genesis.js";
import { GENESIS_NUMBER, parseGenerationNumber } from "../generation/types.js";
import { readGeneration } from "../generation/read.js";
import type { LoadedGeneration } from "../generation/read.js";
import type { Attestation, CommitSnapshot, Module, Verdict } from "../generation/types.js";
import type { GenerationNumber } from "../generation/types.js";
import type { GenerationRecord, MaterializationState } from "../generation/registry-types.js";
import { assertNever, parseSha } from "../git/types.js";
import type { Sha, Signature } from "../git/types.js";
import type {
  EffectsDifference,
  PrimitiveCall,
  ReplayInconclusiveReason,
  ReplaySession,
  WorkspaceFile,
} from "../replay/index.js";
import { parseReplaySession, runReplay } from "../replay/index.js";
import type { ReplayOutcome } from "../replay/index.js";
import { DurableObjectSqliteStore } from "../storage/do-sqlite.js";
import {
  computeCorpusVersion,
  computeGateVersion,
  MemoryValidationResultStore,
  ValidationGate,
  type RecordedCaseOutcome,
  type ValidationCase,
  type ValidationCaseResult,
  type ValidationResult,
  type ValidationRun,
} from "../validation/index.js";
import { isJsonObjectValue, parseJsonValue, type JsonObject, type JsonValue } from "../json.js";
import { DurableObject } from "cloudflare:workers";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
  readonly SUPERVISOR_SECRET?: string;
};

type CandidateMode = "healthy" | "syntax" | "init";

type GenerationRow = {
  readonly number: number;
  readonly commit_sha: string;
  readonly baseline_number: number | null;
  readonly state: MaterializationState;
  readonly artifact_digest: string | null;
  readonly idempotency_key: string;
  readonly created_at: number;
  readonly failure: string | null;
};

type PointerRow = { readonly generation_number: number | null };
type MetaRow = { readonly value: string };
type ContextRow = { readonly key: string; readonly value: string; readonly updated_at: number };
type HistoryRow = {
  readonly sequence: number;
  readonly kind: ActivationKind;
  readonly generation_number: number;
  readonly from_generation_number: number | null;
  readonly at: number;
};
type CorpusRow = {
  readonly name: string;
  readonly session_json: string;
  readonly mandatory_canary: number;
};
type ValidationRow = {
  readonly generation_number: number;
  readonly candidate_sha: string;
  readonly artifact_digest: string;
  readonly validated_against: string | null;
  readonly validated_against_generation: number | null;
  readonly corpus_version: string;
  readonly gate_version: string;
  readonly verdict: Verdict;
  readonly created_at: number;
  readonly case_results_json: string;
};
type QuarantineRow = {
  readonly generation_number: number;
  readonly reason: string;
  readonly created_at: number;
};

type GenerationSummary = {
  readonly number: GenerationNumber;
  readonly commit: Sha;
  readonly baseline: GenerationNumber | null;
  readonly state: MaterializationState;
  readonly artifactDigest: Sha | null;
  readonly idempotencyKey: string;
  readonly createdAt: number;
  readonly failure: string | null;
};

type CandidateGeneration = {
  readonly row: GenerationRow;
  readonly loaded: LoadedGeneration | undefined;
};

type InvalidRequest = { readonly kind: "invalid-request"; readonly message: string };
type RegistryPromotionRejection =
  | {
      readonly kind: "pointer-moved";
      readonly expected: GenerationNumber | undefined;
      readonly actual: GenerationNumber | undefined;
    }
  | {
      readonly kind: "stale-attestation";
      readonly validatedAgainst: Sha | undefined;
      readonly liveNow: Sha | undefined;
      readonly validatedAgainstGeneration: GenerationNumber | undefined;
      readonly liveGeneration: GenerationNumber | undefined;
    }
  | {
      readonly kind: "wrong-generation";
      readonly attested: GenerationNumber;
      readonly requested: GenerationNumber;
    }
  | { readonly kind: "artifact-changed"; readonly attested: Sha; readonly current: Sha }
  | { readonly kind: "corpus-changed"; readonly attested: string; readonly current: string }
  | { readonly kind: "gate-changed"; readonly attested: string; readonly current: string }
  | { readonly kind: "wrong-candidate"; readonly attested: Sha; readonly requested: Sha }
  | { readonly kind: "not-passing"; readonly verdict: Verdict };

type RegistryPromotionResult =
  | {
      readonly outcome: "promoted";
      readonly from: GenerationNumber | undefined;
      readonly to: GenerationNumber;
    }
  | { readonly outcome: "rejected"; readonly reason: RegistryPromotionRejection };

type RegistryPromotionRejectionJson =
  | {
      readonly kind: "pointer-moved";
      readonly expected: GenerationNumber | null;
      readonly actual: GenerationNumber | null;
    }
  | {
      readonly kind: "stale-attestation";
      readonly validatedAgainst: Sha | null;
      readonly liveNow: Sha | null;
      readonly validatedAgainstGeneration: GenerationNumber | null;
      readonly liveGeneration: GenerationNumber | null;
    }
  | {
      readonly kind: "wrong-generation";
      readonly attested: GenerationNumber;
      readonly requested: GenerationNumber;
    }
  | { readonly kind: "artifact-changed"; readonly attested: Sha; readonly current: Sha }
  | { readonly kind: "corpus-changed"; readonly attested: string; readonly current: string }
  | { readonly kind: "gate-changed"; readonly attested: string; readonly current: string }
  | { readonly kind: "wrong-candidate"; readonly attested: Sha; readonly requested: Sha }
  | { readonly kind: "not-passing"; readonly verdict: Verdict };

type GenerationResetResult =
  | {
      readonly outcome: "reset";
      readonly from: GenerationNumber | undefined;
      readonly to: GenerationNumber;
    }
  | { readonly outcome: "contended"; readonly attempts: number };

type ActivationKind = "promoted" | "rolled_back";

const initialCandidate: CandidateMode = "healthy";
const secretKey = "supervisor-secret";
const POINTER_TABLE = "cf_stumble_generation_pointer";
const GENERATIONS_TABLE = "cf_stumble_generations";
const HISTORY_TABLE = "cf_stumble_generation_history";
const META_TABLE = "cf_stumble_supervisor_meta";
const CONTEXT_TABLE = "cf_stumble_context";
const CORPUS_TABLE = "cf_stumble_corpus";
const VALIDATION_TABLE = "cf_stumble_validation_results";
const QUARANTINE_TABLE = "cf_stumble_quarantine";
const GENESIS_META_KEY = "genesis_sha";
const CORPUS_VERSION_META_KEY = "corpus_version";
const GATE_VERSION_META_KEY = "gate_version";
const NEXT_GENERATION_META_KEY = "next_generation_number";
const INITIAL_TIMESTAMP = 1_700_000_000;

const genesisAuthor: Signature = {
  name: "cf-stumble supervisor",
  email: "supervisor@cf-stumble.invalid",
  timestamp: INITIAL_TIMESTAMP,
  timezoneOffsetMinutes: 0,
};

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly store: DurableObjectSqliteStore;
  private readonly supervisorSecret: string | undefined;
  private initialization: Promise<void> | undefined;
  private genesisPin: GenesisPin | undefined;
  private attempt = 0;
  private activeFacetName: string | undefined;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.store = new DurableObjectSqliteStore(ctx);
    this.supervisorSecret = env.SUPERVISOR_SECRET;
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
      isPrivilegedRoute(pathname, request.method) &&
      !authorizeSupervisorRequest(request, this.supervisorSecret)
    ) {
      return unauthorizedResponse();
    }
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
    if (pathname === "/quarantine") {
      return request.method === "POST" ? this.quarantine(request) : this.readQuarantine();
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
      `CREATE TABLE IF NOT EXISTS ${GENERATIONS_TABLE} (number INTEGER PRIMARY KEY, commit_sha TEXT NOT NULL, baseline_number INTEGER, state TEXT NOT NULL CHECK (state IN ('loading', 'load_failed', 'loaded', 'validation_failed', 'validated')), artifact_digest TEXT, idempotency_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, failure TEXT)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('promoted', 'rolled_back')), generation_number INTEGER NOT NULL, from_generation_number INTEGER, at INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${POINTER_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), generation_number INTEGER)`,
    );
    sql.exec(`INSERT OR IGNORE INTO ${POINTER_TABLE} (id, generation_number) VALUES (1, NULL)`);
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
      `CREATE TABLE IF NOT EXISTS ${VALIDATION_TABLE} (generation_number INTEGER PRIMARY KEY, candidate_sha TEXT NOT NULL, artifact_digest TEXT NOT NULL, validated_against TEXT, validated_against_generation INTEGER, corpus_version TEXT NOT NULL, gate_version TEXT NOT NULL, verdict TEXT NOT NULL, created_at INTEGER NOT NULL, case_results_json TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${QUARANTINE_TABLE} (generation_number INTEGER PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL)`,
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
      const genesis = await seedGenesis(
        this.store,
        {
          modules: [
            {
              path: "agent.js",
              content: new TextEncoder().encode(healthyAgentSource),
              executable: false,
            },
            {
              path: "prompt.md",
              content: new TextEncoder().encode("known-good prompt\n"),
              executable: false,
            },
            {
              path: "policy.md",
              content: new TextEncoder().encode("known-good policy\n"),
              executable: false,
            },
          ],
          author: genesisAuthor,
          createdAt: INITIAL_TIMESTAMP,
          summary: "known-good generation 0",
        },
        { claimPointer: false },
      );
      const genesisPin = makeGenesisPin(genesis);
      const loadedGenesis = await readGeneration(this.store, genesis.sha);
      const genesisArtifact = await digestArtifact(loadedGenesis);
      const genesisRecord = {
        number: GENESIS_NUMBER,
        commit: genesis.sha,
        baseline: undefined,
        state: "validated",
        artifactDigest: genesisArtifact,
        idempotencyKey: "genesis",
        createdAt: genesis.createdAt,
        failure: undefined,
      } satisfies GenerationRecord;
      this.ctx.storage.transactionSync(() => {
        this.insertGeneration(genesisRecord);
        this.ctx.storage.sql.exec(
          `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
          GENESIS_META_KEY,
          genesisPin.sha,
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
          `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
          NEXT_GENERATION_META_KEY,
          "1",
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO ${HISTORY_TABLE} (kind, generation_number, from_generation_number, at) VALUES (?, ?, ?, ?)`,
          "promoted",
          GENESIS_NUMBER,
          null,
          Date.now(),
        );
        if (!this.updatePointer(GENESIS_NUMBER)) {
          throw new Error("generation 0 seed lost a pointer race");
        }
      });
      this.genesisPin = genesisPin;
      return;
    }

    const genesisPin = this.readGenesisPin();
    this.genesisPin = genesisPin;
    if (this.readMeta(CORPUS_VERSION_META_KEY) === undefined) {
      this.writeMeta(CORPUS_VERSION_META_KEY, corpusVersion);
    }
    if (this.readMeta(GATE_VERSION_META_KEY) === undefined) {
      this.writeMeta(GATE_VERSION_META_KEY, gateVersion);
    }
    this.ctx.storage.sql.exec(
      `UPDATE ${POINTER_TABLE} SET generation_number = ? WHERE id = 1 AND generation_number IS NULL`,
      GENESIS_NUMBER,
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

  // The old GET spike API only exercises facet loading and never changes the live pointer.
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
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ promoted: false, reason: detail }, { status: 422 });
    }
  }

  private async promote(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const number = parseGenerationNumberField(body.candidate ?? body.generation, "candidate");
      const candidate = await this.readCandidateGeneration(number);
      if (this.isQuarantined(number)) {
        throw new SafetyViolationError("quarantined", `generation ${number} is quarantined`);
      }
      const loaded = await this.loadCandidate(candidate);
      if (loaded.outcome === "failed") {
        return promotionResponse({
          outcome: "rejected",
          reason: { kind: "not-passing", verdict: "inconclusive" },
        });
      }
      if (candidate.loaded === undefined) {
        throw new Error(`generation ${number} has no materialized commit`);
      }
      const validation = await this.validateCandidate(
        number,
        candidate.loaded.generation.sha,
        loaded.artifactDigest,
      );
      const result = this.promoteTransaction(number, validation, loaded.artifactDigest);
      return promotionResponse(result);
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private validateCandidate(
    number: GenerationNumber,
    candidate: Sha,
    artifactDigest: Sha,
  ): Promise<ValidationRun> {
    const gate = new ValidationGate({
      pointerStore: {
        readPointer: () => {
          const live = this.readPointerSql();
          const row = live === undefined ? undefined : this.readGenerationRow(live);
          if (live !== undefined && row === undefined) {
            throw new Error(`live generation ${live} is missing`);
          }
          return Promise.resolve(row === undefined ? undefined : parseSha(row.commit_sha));
        },
        setPointer: () => Promise.resolve(false),
      },
      resultStore: new MemoryValidationResultStore(),
      corpus: this.readCorpusCases(),
      execute: (generation, session) => this.executeGeneration(generation, session),
    });
    return gate.validate(candidate, {
      generation: number,
      artifactDigest,
      validatedAgainstGeneration: this.readPointerSql(),
    });
  }

  private async executeGeneration(
    generation: Sha | undefined,
    session: ReplaySession,
  ): Promise<ReplayOutcome> {
    if (generation === undefined) {
      throw new Error("validation requires a live generation");
    }
    const loaded = await readGeneration(this.store, generation);
    const sourceModule = loaded.modules.find((module) => module.path === "agent.js");
    if (sourceModule === undefined) {
      throw new Error(`generation ${generation} has no agent.js module`);
    }
    const facet = this.mountFacet(decodeValidationText("agent.js", sourceModule.content));
    const probe = await facet.fetch(new Request("https://facet/probe"));
    if (!probe.ok) {
      throw new Error(`generation ${generation} probe returned ${probe.status}`);
    }
    const definition = materializeSupervisorGeneration(loaded);
    return runReplay(session, new AgentExecutor(definition));
  }

  private async readCandidateGeneration(number: GenerationNumber): Promise<CandidateGeneration> {
    const row = this.readGenerationRow(number);
    if (row === undefined) {
      throw new MissingResourceError(`candidate generation ${number} does not exist`);
    }
    if (row.state === "load_failed" || row.state === "validation_failed") {
      return { row, loaded: undefined };
    }
    try {
      return {
        row,
        loaded: await readGeneration(this.store, parseSha(row.commit_sha)),
      };
    } catch (error: unknown) {
      const failure = error instanceof Error ? error.message : String(error);
      this.markLoadFailed(number, failure);
      return {
        row: { ...row, state: "load_failed", failure },
        loaded: undefined,
      };
    }
  }

  private async loadCandidate(
    candidate: CandidateGeneration,
  ): Promise<
    { readonly outcome: "loaded"; readonly artifactDigest: Sha } | { readonly outcome: "failed" }
  > {
    if (candidate.row.state === "load_failed" || candidate.row.state === "validation_failed") {
      return { outcome: "failed" };
    }
    if (candidate.loaded === undefined) {
      throw new Error(`generation ${rowNumber(candidate.row)} has no materialized commit`);
    }
    const sourceModule = candidate.loaded.modules.find((module) => module.path === "agent.js");
    if (sourceModule === undefined) {
      this.markLoadFailed(rowNumber(candidate.row), "agent.js is missing");
      return { outcome: "failed" };
    }
    const digest = await digestBytes(sourceModule.content);
    if (candidate.row.state !== "loading") {
      const storedDigest =
        candidate.row.artifact_digest === null
          ? undefined
          : parseSha(candidate.row.artifact_digest);
      return storedDigest === digest
        ? { outcome: "loaded", artifactDigest: digest }
        : { outcome: "failed" };
    }
    try {
      const facet = this.mountFacet(decodeValidationText("agent.js", sourceModule.content));
      const probe = await facet.fetch(new Request("https://facet/probe"));
      if (!probe.ok) {
        throw new Error(
          `candidate generation ${rowNumber(candidate.row)} probe returned ${probe.status}`,
        );
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.markLoadFailed(rowNumber(candidate.row), detail, digest);
      return { outcome: "failed" };
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE ${GENERATIONS_TABLE} SET state = ?, artifact_digest = ? WHERE number = ? AND state = ?`,
        "loaded",
        digest,
        rowNumber(candidate.row),
        "loading",
      );
    });
    return { outcome: "loaded", artifactDigest: digest };
  }

  private markLoadFailed(number: GenerationNumber, failure: string, artifactDigest?: Sha): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE ${GENERATIONS_TABLE} SET state = ?, artifact_digest = ?, failure = ? WHERE number = ? AND state = ?`,
        "load_failed",
        artifactDigest ?? null,
        failure,
        number,
        "loading",
      );
    });
  }

  private promoteTransaction(
    number: GenerationNumber,
    validation: ValidationRun,
    artifactDigest: Sha,
  ): RegistryPromotionResult {
    let result: RegistryPromotionResult | undefined;
    this.ctx.storage.transactionSync(() => {
      if (this.isQuarantined(number)) {
        throw new SafetyViolationError("quarantined", `generation ${number} is quarantined`);
      }
      const liveNow = this.readPointerSql();
      const registeredGeneration = this.readGenerationRow(number);
      if (registeredGeneration === undefined) {
        throw new MissingResourceError(`candidate generation ${number} does not exist`);
      }
      const candidate = parseSha(registeredGeneration.commit_sha);
      const liveCommit =
        liveNow === undefined ? undefined : this.readGenerationRowOrThrow(liveNow).commit_sha;
      const corpusVersion = this.readMetaOrThrow(CORPUS_VERSION_META_KEY);
      const gateVersion = this.readMetaOrThrow(GATE_VERSION_META_KEY);
      if (validation.attestation === undefined) {
        if (registeredGeneration.state === "loaded") {
          this.transitionGeneration(number, "validation_failed", validation.result.verdict);
        }
        this.insertValidationResult(validation.result);
        result = {
          outcome: "rejected",
          reason: { kind: "not-passing", verdict: validation.result.verdict },
        };
        return;
      }
      const rejection = verifyAttestation(
        number,
        candidate,
        artifactDigest,
        validation.attestation,
        liveCommit === undefined ? undefined : parseSha(liveCommit),
        liveNow,
        corpusVersion,
        gateVersion,
      );
      if (rejection !== undefined) {
        result = { outcome: "rejected", reason: rejection };
        return;
      }

      const swapped = this.updatePointer(number, liveNow);
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

      this.transitionGeneration(number, "validated");
      this.insertValidationResult(validation.result);
      this.ctx.storage.sql.exec(
        `INSERT INTO ${HISTORY_TABLE} (kind, generation_number, from_generation_number, at) VALUES (?, ?, ?, ?)`,
        "promoted",
        number,
        liveNow,
        Date.now(),
      );
      result = { outcome: "promoted", from: liveNow, to: number };
    });
    if (result === undefined) {
      throw new Error("promotion transaction did not produce a result");
    }
    return result;
  }

  private async rollback(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const target = parseGenerationNumberField(body.target, "target");
      const expected = parseNullableGenerationNumber(body.expected, "expected");
      const result = this.rollbackTransaction(target, expected);
      return promotionResponse(result);
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private rollbackTransaction(
    target: GenerationNumber,
    expected: GenerationNumber | undefined,
  ): RegistryPromotionResult {
    let result: RegistryPromotionResult | undefined;
    this.ctx.storage.transactionSync(() => {
      if (this.readGenerationRow(target) === undefined) {
        throw new MissingResourceError(`rollback target generation ${target} does not exist`);
      }
      if (this.isQuarantined(target)) {
        throw new SafetyViolationError("quarantined", `generation ${target} is quarantined`);
      }
      if (!this.wasPreviouslyLive(target)) {
        throw new SafetyViolationError(
          "not-live",
          `generation ${target} was never recorded as live`,
        );
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
        `INSERT INTO ${HISTORY_TABLE} (kind, generation_number, from_generation_number, at) VALUES (?, ?, ?, ?)`,
        "rolled_back",
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

  // Keep the old unauthenticated spike reset as a response-only compatibility endpoint.
  private legacyReset(): Response {
    return Response.json({ generation: "0", reset: true });
  }

  private reset(): Response {
    return this.resetResponse(false);
  }

  private resetResponse(legacy: boolean): Response {
    try {
      this.deleteActiveFacet();
      const result = this.resetTransaction();
      if (result.outcome === "contended") {
        return Response.json(
          { outcome: result.outcome, attempts: result.attempts },
          { status: 409 },
        );
      }
      if (legacy) {
        return Response.json({ generation: "0", reset: true });
      }
      return Response.json({
        outcome: result.outcome,
        generation: 0,
        from: result.from ?? null,
        to: result.to,
      });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private resetTransaction(): GenerationResetResult {
    const pin = this.genesisPin;
    if (pin === undefined) {
      throw new Error("genesis pin is unavailable");
    }

    let result: GenerationResetResult | undefined;
    this.ctx.storage.transactionSync(() => {
      const from = this.readPointerSql();
      const swapped = this.updatePointer(GENESIS_NUMBER, from);
      result = swapped
        ? { outcome: "reset", from, to: GENESIS_NUMBER }
        : { outcome: "contended", attempts: 1 };
      if (result.outcome === "contended") {
        return;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO ${HISTORY_TABLE} (kind, generation_number, from_generation_number, at) VALUES (?, ?, ?, ?)`,
        "rolled_back",
        result.to,
        result.from ?? null,
        Date.now(),
      );
      this.writeState("generation", "0");
    });
    if (result === undefined) {
      throw new Error("reset transaction did not produce a result");
    }
    return result;
  }

  private listGenerations(): Response {
    try {
      const rows = this.readGenerationRows();
      const generations = rows.map((row) => generationResponse(row));
      return Response.json({ generations });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private history(): Response {
    try {
      const rows = this.ctx.storage.sql
        .exec<HistoryRow>(
          `SELECT id AS sequence, kind, generation_number, from_generation_number, at FROM ${HISTORY_TABLE} ORDER BY id`,
        )
        .toArray();
      return Response.json({
        history: rows.map((row) => ({
          sequence: row.sequence,
          kind: row.kind,
          generation: parseGenerationNumber(row.generation_number),
          from:
            row.from_generation_number === null
              ? null
              : parseGenerationNumber(row.from_generation_number),
          at: row.at,
        })),
      });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private showGeneration(rawNumber: string): Response {
    try {
      let decodedNumber: string;
      try {
        decodedNumber = decodeURIComponent(rawNumber);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new InvalidRequestError(`generation number is not valid URL encoding: ${detail}`);
      }
      const number = parseGenerationNumberField(decodedNumber, "generation");
      const row = this.readGenerationRow(number);
      if (row === undefined) {
        return Response.json(
          { error: { kind: "not-found", resource: "generation", number } },
          { status: 404 },
        );
      }
      return Response.json({ generation: generationResponse(row) });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
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
      return Response.json({ generation: generationResponse(row) });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private async createGeneration(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const modules = parseModules(body.modules);
      const summary = readNonEmptyString(body.summary, "summary");
      const idempotencyKey =
        body.idempotencyKey === undefined
          ? crypto.randomUUID()
          : readNonEmptyString(body.idempotencyKey, "idempotencyKey");
      const createdAt =
        body.createdAt === undefined
          ? Math.floor(Date.now() / 1_000)
          : readSafeInteger(body.createdAt, "createdAt");
      const existing = this.readGenerationByIdempotencyKey(idempotencyKey);
      if (existing !== undefined) {
        return Response.json({ generation: generationResponse(existing) });
      }
      const liveNumber = this.readPointerSql();
      if (liveNumber === undefined) {
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
      const parent = this.readGenerationRow(liveNumber);
      if (parent === undefined) {
        return Response.json(
          { error: { kind: "corrupt-state", message: `live generation ${liveNumber} is missing` } },
          { status: 500 },
        );
      }
      let parentSnapshot: CommitSnapshot;
      try {
        parentSnapshot = (await readGeneration(this.store, parseSha(parent.commit_sha))).generation;
      } catch (error: unknown) {
        if (error instanceof TypeError) {
          throw new InvalidRequestError(error.message);
        }
        throw error;
      }
      let generation: CommitSnapshot;
      try {
        generation = await buildGeneration(this.store, {
          modules,
          parent: parentSnapshot,
          author: genesisAuthor,
          createdAt,
          summary,
        });
      } catch (error: unknown) {
        if (error instanceof TypeError) {
          throw new InvalidRequestError(error.message);
        }
        throw error;
      }
      let row: GenerationRow | undefined;
      this.ctx.storage.transactionSync(() => {
        row = this.allocateGeneration(
          generation.sha,
          liveNumber,
          idempotencyKey,
          generation.createdAt,
        );
      });
      if (row === undefined) {
        throw new Error("generation allocation did not produce a row");
      }
      return Response.json({ generation: generationResponse(row) }, { status: 201 });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
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
      return requestErrorResponse(error instanceof Error ? error : String(error));
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
      return requestErrorResponse(error instanceof Error ? error : String(error));
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
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private readCorpus(): Response {
    try {
      return Response.json({
        corpus: this.readCorpusCases(),
        corpusVersion: this.readMetaOrThrow(CORPUS_VERSION_META_KEY),
      });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private async writeValidationResult(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const result = parseValidationResult(body.result ?? body, "result");
      this.insertValidationResult(result);
      return Response.json({ result }, { status: 201 });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private readValidationResults(url: URL): Response {
    try {
      const candidateValue = url.searchParams.get("candidate");
      const generationValue = url.searchParams.get("generation");
      const verdictValue = url.searchParams.get("verdict");
      const candidate =
        candidateValue === null ? undefined : parseShaField(candidateValue, "candidate");
      const generation =
        generationValue === null
          ? undefined
          : parseGenerationNumberField(generationValue, "generation");
      const verdict = verdictValue === null ? undefined : parseVerdict(verdictValue, "verdict");
      const clauses: string[] = [];
      const parameters: (string | number | null)[] = [];
      if (generation !== undefined) {
        clauses.push("generation_number = ?");
        parameters.push(generation);
      }
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
          `SELECT generation_number, candidate_sha, artifact_digest, validated_against, validated_against_generation, corpus_version, gate_version, verdict, created_at, case_results_json FROM ${VALIDATION_TABLE}${where} ORDER BY created_at`,
          ...parameters,
        )
        .toArray();
      return Response.json({ results: rows.map((row) => validationResponse(row)) });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private async quarantine(request: Request): Promise<Response> {
    try {
      const body = await readRequestRecord(request);
      const target = parseGenerationNumberField(
        body.target ?? body.generation ?? body.candidate,
        "target",
      );
      const reason =
        body.reason === undefined
          ? "marked bad by supervisor"
          : readNonEmptyString(body.reason, "reason");
      if (this.readGenerationRow(target) === undefined) {
        throw new MissingResourceError(`generation ${target} does not exist`);
      }
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO ${QUARANTINE_TABLE} (generation_number, reason, created_at) VALUES (?, ?, ?)`,
          target,
          reason,
          Date.now(),
        );
      });
      return Response.json({ quarantined: target, reason }, { status: 201 });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
    }
  }

  private readQuarantine(): Response {
    try {
      const rows = this.ctx.storage.sql
        .exec<QuarantineRow>(
          `SELECT generation_number, reason, created_at FROM ${QUARANTINE_TABLE} ORDER BY created_at, generation_number`,
        )
        .toArray();
      return Response.json({
        quarantined: rows.map((row) => ({
          generation: parseGenerationNumber(row.generation_number),
          reason: row.reason,
          createdAt: row.created_at,
        })),
      });
    } catch (error: unknown) {
      return requestErrorResponse(error instanceof Error ? error : String(error));
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
      const row = this.readGenerationRow(pinned);
      if (row === undefined) {
        throw new Error(`live generation ${pinned} is missing`);
      }
      const loaded = await readGeneration(this.store, parseSha(row.commit_sha));
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
      return requestErrorResponse(error instanceof Error ? error : String(error));
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

  private readGenesisPin(): GenesisPin {
    const sha = parseSha(this.readMetaOrThrow(GENESIS_META_KEY));
    const row = this.readGenerationRow(GENESIS_NUMBER);
    if (row === undefined || row.commit_sha !== sha) {
      throw new Error(`genesis generation ${sha} is not registered`);
    }
    return { kind: "genesis", sha };
  }

  private writeMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
      key,
      value,
    );
  }

  private readPointerSql(): GenerationNumber | undefined {
    const rows = this.ctx.storage.sql
      .exec<PointerRow>(`SELECT generation_number FROM ${POINTER_TABLE} WHERE id = 1`)
      .toArray();
    const value = rows[0]?.generation_number;
    return value === null || value === undefined ? undefined : parseGenerationNumber(value);
  }

  private updatePointer(next: GenerationNumber, expected?: GenerationNumber): boolean {
    const result =
      expected === undefined
        ? this.ctx.storage.sql.exec(
            `UPDATE ${POINTER_TABLE} SET generation_number = ? WHERE id = 1 AND generation_number IS NULL`,
            next,
          )
        : this.ctx.storage.sql.exec(
            `UPDATE ${POINTER_TABLE} SET generation_number = ? WHERE id = 1 AND generation_number = ?`,
            next,
            expected,
          );
    return result.rowsWritten === 1;
  }

  private readGenerationRows(): readonly GenerationRow[] {
    return this.ctx.storage.sql
      .exec<GenerationRow>(
        `SELECT number, commit_sha, baseline_number, state, artifact_digest, idempotency_key, created_at, failure FROM ${GENERATIONS_TABLE} ORDER BY number`,
      )
      .toArray();
  }

  private readGenerationRow(number: GenerationNumber): GenerationRow | undefined {
    const rows = this.ctx.storage.sql
      .exec<GenerationRow>(
        `SELECT number, commit_sha, baseline_number, state, artifact_digest, idempotency_key, created_at, failure FROM ${GENERATIONS_TABLE} WHERE number = ?`,
        number,
      )
      .toArray();
    return rows[0];
  }

  private readGenerationRowOrThrow(number: GenerationNumber): GenerationRow {
    const row = this.readGenerationRow(number);
    if (row === undefined) {
      throw new Error(`generation ${number} was not registered`);
    }
    return row;
  }

  private readGenerationByIdempotencyKey(key: string): GenerationRow | undefined {
    const rows = this.ctx.storage.sql
      .exec<GenerationRow>(
        `SELECT number, commit_sha, baseline_number, state, artifact_digest, idempotency_key, created_at, failure FROM ${GENERATIONS_TABLE} WHERE idempotency_key = ?`,
        key,
      )
      .toArray();
    return rows[0];
  }

  private isQuarantined(number: GenerationNumber): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ generation_number: number }>(
        `SELECT generation_number FROM ${QUARANTINE_TABLE} WHERE generation_number = ?`,
        number,
      )
      .toArray();
    return rows.length === 1;
  }

  private wasPreviouslyLive(number: GenerationNumber): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ generation_number: number }>(
        `SELECT generation_number FROM ${HISTORY_TABLE} WHERE generation_number = ? LIMIT 1`,
        number,
      )
      .toArray();
    return rows.length === 1;
  }

  private insertGeneration(generation: GenerationRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ${GENERATIONS_TABLE} (number, commit_sha, baseline_number, state, artifact_digest, idempotency_key, created_at, failure) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      generation.number,
      generation.commit,
      generation.baseline ?? null,
      generation.state,
      generation.artifactDigest ?? null,
      generation.idempotencyKey,
      generation.createdAt,
      generation.failure ?? null,
    );
  }

  private allocateGeneration(
    commit: Sha,
    baseline: GenerationNumber,
    idempotencyKey: string,
    createdAt: number,
  ): GenerationRow {
    const existing = this.readGenerationByIdempotencyKey(idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }
    const nextValue = Number(this.readMetaOrThrow(NEXT_GENERATION_META_KEY));
    if (!Number.isSafeInteger(nextValue) || nextValue < 0) {
      throw new RangeError("generation number counter is invalid or exhausted");
    }
    const next = parseGenerationNumber(nextValue);
    if (nextValue === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("generation number counter is exhausted");
    }
    const record = {
      number: next,
      commit,
      baseline,
      state: "loading",
      artifactDigest: undefined,
      idempotencyKey,
      createdAt,
      failure: undefined,
    } satisfies GenerationRecord;
    this.insertGeneration(record);
    this.writeMeta(NEXT_GENERATION_META_KEY, String(next + 1));
    return this.readGenerationRowOrThrow(next);
  }

  private transitionGeneration(
    number: GenerationNumber,
    state: Extract<MaterializationState, "validation_failed" | "validated">,
    failure?: string,
  ): void {
    const result = this.ctx.storage.sql.exec(
      state === "validation_failed"
        ? `UPDATE ${GENERATIONS_TABLE} SET state = ?, failure = ? WHERE number = ? AND state = ?`
        : `UPDATE ${GENERATIONS_TABLE} SET state = ?, failure = NULL WHERE number = ? AND state IN (?, ?)`,
      ...(state === "validation_failed"
        ? [state, failure ?? "validation failed", number, "loaded"]
        : [state, number, "loaded", "validated"]),
    );
    if (result.rowsWritten !== 1) {
      const row = this.readGenerationRow(number);
      if (row?.state !== state) {
        throw new Error(`generation ${number} cannot transition to ${state}`);
      }
    }
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
      `INSERT OR REPLACE INTO ${VALIDATION_TABLE} (generation_number, candidate_sha, artifact_digest, validated_against, validated_against_generation, corpus_version, gate_version, verdict, created_at, case_results_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      result.generation,
      result.candidate,
      result.artifactDigest,
      result.validatedAgainst ?? null,
      result.validatedAgainstGeneration ?? null,
      result.corpusVersion,
      result.gateVersion,
      result.verdict,
      result.createdAt,
      JSON.stringify(result.caseResults),
    );
  }
}

const validationTextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function digestArtifact(loaded: LoadedGeneration): Promise<Sha> {
  const source = loaded.modules.find((module) => module.path === "agent.js");
  if (source === undefined) {
    throw new Error(`commit ${loaded.generation.sha} has no agent.js module`);
  }
  return digestBytes(source.content);
}

async function digestBytes(bytes: Uint8Array): Promise<Sha> {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return parseSha(
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function rowNumber(row: GenerationRow): GenerationNumber {
  return parseGenerationNumber(row.number);
}

function materializeSupervisorGeneration(loaded: LoadedGeneration): AgentDefinition {
  const modules = loaded.modules.filter((module) => module.path !== "agent.js");
  const promptModule = modules.find((module) => module.path === "prompt.md");
  if (promptModule === undefined) {
    throw new AgentMaterializationError(
      "missing-module",
      "prompt.md",
      'required module "prompt.md" is missing',
    );
  }
  const policyModule = modules.find((module) => module.path === "policy.md");
  if (policyModule === undefined) {
    throw new AgentMaterializationError(
      "missing-module",
      "policy.md",
      'required module "policy.md" is missing',
    );
  }

  const skills: AgentSkill[] = modules
    .filter((module) => module.path !== "prompt.md" && module.path !== "policy.md")
    .map((module): AgentSkill => {
      if (!module.path.startsWith("skills/")) {
        throw new AgentMaterializationError(
          "unsupported-module",
          module.path,
          'module must be "prompt.md", "policy.md", or under "skills/"',
        );
      }
      const fileName = module.path.slice("skills/".length);
      if (fileName.length <= ".md".length || !fileName.endsWith(".md") || fileName.includes("/")) {
        throw new AgentMaterializationError(
          "unsupported-module",
          module.path,
          'skill module must be a non-empty .md file directly under "skills/"',
        );
      }
      return {
        name: fileName.slice(0, -".md".length),
        content: decodeValidationText(module.path, module.content),
      };
    })
    .sort((left: AgentSkill, right: AgentSkill) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

  return {
    generation: loaded.generation,
    systemPrompt: decodeRequiredValidationText("prompt.md", promptModule.content),
    policy: decodeRequiredValidationText("policy.md", policyModule.content),
    skills,
  };
}

function decodeRequiredValidationText(path: string, content: Uint8Array): string {
  const text = decodeValidationText(path, content);
  if (text.length === 0) {
    throw new AgentMaterializationError(
      "invalid-module",
      path,
      "required module content must not be empty",
    );
  }
  return text;
}

function decodeValidationText(path: string, content: Uint8Array): string {
  try {
    return validationTextDecoder.decode(content);
  } catch (error: unknown) {
    throw new AgentMaterializationError(
      "invalid-module",
      path,
      "module content is not valid UTF-8",
      error,
    );
  }
}

function generationResponse(row: GenerationRow): GenerationSummary {
  return {
    number: parseGenerationNumber(row.number),
    commit: parseSha(row.commit_sha),
    baseline: row.baseline_number === null ? null : parseGenerationNumber(row.baseline_number),
    state: row.state,
    artifactDigest: row.artifact_digest === null ? null : parseSha(row.artifact_digest),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    failure: row.failure,
  };
}

function isPrivilegedRoute(pathname: string, method: string): boolean {
  if (pathname === "/rollback") {
    return true;
  }
  if (pathname === "/promote" || pathname === "/reset") {
    return method === "POST";
  }
  if (
    pathname === "/generations" ||
    pathname === "/context" ||
    pathname === "/corpus" ||
    pathname === "/validation-results" ||
    pathname === "/quarantine"
  ) {
    return method === "POST";
  }
  return false;
}

function unauthorizedResponse(): Response {
  return Response.json(
    { error: { kind: "unauthorized", message: "valid supervisor credential required" } },
    { status: 401 },
  );
}

function promotionResponse(result: RegistryPromotionResult): Response {
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

function serializePromotionRejection(
  reason: RegistryPromotionRejection,
): RegistryPromotionRejectionJson {
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
        validatedAgainstGeneration: reason.validatedAgainstGeneration ?? null,
        liveGeneration: reason.liveGeneration ?? null,
      };
    case "wrong-generation":
    case "artifact-changed":
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
  generation: GenerationNumber,
  candidate: Sha,
  artifactDigest: Sha,
  attestation: Attestation,
  liveNow: Sha | undefined,
  liveGeneration: GenerationNumber | undefined,
  corpusVersion: string,
  gateVersion: string,
): RegistryPromotionRejection | undefined {
  if (attestation.generation !== generation) {
    return {
      kind: "wrong-generation",
      attested: attestation.generation,
      requested: generation,
    };
  }
  if (attestation.candidate !== candidate) {
    return {
      kind: "wrong-candidate",
      attested: attestation.candidate,
      requested: candidate,
    };
  }
  if (attestation.artifactDigest !== artifactDigest) {
    return {
      kind: "artifact-changed",
      attested: attestation.artifactDigest,
      current: artifactDigest,
    };
  }
  if (
    attestation.validatedAgainst !== liveNow ||
    attestation.validatedAgainstGeneration !== liveGeneration
  ) {
    return {
      kind: "stale-attestation",
      validatedAgainst: attestation.validatedAgainst,
      liveNow,
      validatedAgainstGeneration: attestation.validatedAgainstGeneration,
      liveGeneration,
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

async function readRequestRecord(request: Request): Promise<JsonObject> {
  let value: JsonValue;
  try {
    value = parseJsonValue(JSON.parse(await request.text()));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidRequestError(`request body is not valid JSON: ${detail}`);
  }
  if (!isJsonObjectValue(value)) {
    throw new InvalidRequestError("request body must be a JSON object");
  }
  return value;
}

function readNonEmptyString(value: JsonValue | undefined, path: string): string {
  if (!isString(value) || value.length === 0) {
    throw new InvalidRequestError(`${path} must be a non-empty string`);
  }
  return value;
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function isBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}

function isSafeInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function readSafeInteger(value: JsonValue | undefined, path: string): number {
  if (!isSafeInteger(value)) {
    throw new InvalidRequestError(`${path} must be a safe integer`);
  }
  return value;
}

function parseShaField(value: JsonValue | undefined, path: string): Sha {
  const raw = readNonEmptyString(value, path);
  try {
    return parseSha(raw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidRequestError(`${path} is invalid: ${detail}`);
  }
}

function parseGenerationNumberField(value: JsonValue | undefined, path: string): GenerationNumber {
  let raw: number;
  if (isString(value)) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
      throw new InvalidRequestError(`${path} must be a non-negative integer`);
    }
    raw = Number(value);
  } else {
    raw = readSafeInteger(value, path);
  }
  try {
    return parseGenerationNumber(raw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidRequestError(`${path} is invalid: ${detail}`);
  }
}

function parseNullableGenerationNumber(
  value: JsonValue | undefined,
  path: string,
): GenerationNumber | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseGenerationNumberField(value, path);
}

function parseNullableSha(value: JsonValue | undefined, path: string): Sha | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseShaField(value, path);
}

function parseVerdict(value: JsonValue | undefined, path: string): Verdict {
  if (value === "pass" || value === "fail" || value === "inconclusive") {
    return value;
  }
  throw new InvalidRequestError(`${path} must be pass, fail, or inconclusive`);
}

function parseModules(value: JsonValue | undefined): readonly Module[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestError("modules must be a non-empty array");
  }
  const entries: readonly JsonValue[] = value;
  return entries.map((entry, index) => {
    const path = `modules[${index}]`;
    const record = readRecord(entry, path);
    return {
      path: readNonEmptyString(record.path, `${path}.path`),
      content: new TextEncoder().encode(readString(record.content, `${path}.content`)),
      executable: readBoolean(record.executable, `${path}.executable`),
    } satisfies Module;
  });
}

function parseValidationCase(value: JsonValue | undefined, path: string): ValidationCase {
  const record = readRecord(value, path);
  const name = readNonEmptyString(record.name, `${path}.name`);
  let session: ValidationCase["session"];
  try {
    session = parseReplaySession(record.session);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidRequestError(`${path}.session is invalid: ${detail}`);
  }
  return {
    name,
    session,
    mandatoryCanary: readBoolean(record.mandatoryCanary, `${path}.mandatoryCanary`),
  };
}

function parseValidationResult(value: JsonValue | undefined, path: string): ValidationResult {
  const record = readRecord(value, path);
  const caseResultsValue = record.caseResults;
  if (!Array.isArray(caseResultsValue)) {
    throw new InvalidRequestError(`${path}.caseResults must be an array`);
  }
  const caseResults: readonly JsonValue[] = caseResultsValue;
  return {
    candidate: parseShaField(record.candidate, `${path}.candidate`),
    generation: parseGenerationNumberField(record.generation, `${path}.generation`),
    artifactDigest: parseShaField(record.artifactDigest, `${path}.artifactDigest`),
    validatedAgainst: parseNullableSha(record.validatedAgainst, `${path}.validatedAgainst`),
    validatedAgainstGeneration: parseNullableGenerationNumber(
      record.validatedAgainstGeneration,
      `${path}.validatedAgainstGeneration`,
    ),
    corpusVersion: readNonEmptyString(record.corpusVersion, `${path}.corpusVersion`),
    gateVersion: readNonEmptyString(record.gateVersion, `${path}.gateVersion`),
    verdict: parseVerdict(record.verdict, `${path}.verdict`),
    createdAt: readSafeInteger(record.createdAt, `${path}.createdAt`),
    caseResults: caseResults.map((entry, index) =>
      parseValidationCaseResult(entry, `${path}.caseResults[${index}]`),
    ),
  };
}

function parseValidationCaseResult(
  value: JsonValue | undefined,
  path: string,
): ValidationCaseResult {
  const record = readRecord(value, path);
  return {
    name: readNonEmptyString(record.name, `${path}.name`),
    mandatoryCanary: readBoolean(record.mandatoryCanary, `${path}.mandatoryCanary`),
    baseline: parseRecordedCaseOutcome(record.baseline, `${path}.baseline`),
    candidate: parseRecordedCaseOutcome(record.candidate, `${path}.candidate`),
  };
}

function parseRecordedCaseOutcome(value: JsonValue | undefined, path: string): RecordedCaseOutcome {
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

function parseEffectsDifference(value: JsonValue | undefined, path: string): EffectsDifference {
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

function parseNullablePrimitiveCall(
  value: JsonValue | undefined,
  path: string,
): PrimitiveCall | undefined {
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

function parseNullableWorkspaceFile(
  value: JsonValue | undefined,
  path: string,
): WorkspaceFile | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = readRecord(value, path);
  return {
    path: readNonEmptyString(record.path, `${path}.path`),
    content: readString(record.content, `${path}.content`),
  };
}

function parseInconclusiveReason(
  value: JsonValue | undefined,
  path: string,
): ReplayInconclusiveReason {
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

function readRecord(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObjectValue(value)) {
    throw new InvalidRequestError(`${path} must be an object`);
  }
  return value;
}

function readString(value: JsonValue | undefined, path: string): string {
  if (!isString(value)) {
    throw new InvalidRequestError(`${path} must be a string`);
  }
  return value;
}

function readBoolean(value: JsonValue | undefined, path: string): boolean {
  if (!isBoolean(value)) {
    throw new InvalidRequestError(`${path} must be a boolean`);
  }
  return value;
}

function parseStoredJson(value: string, path: string): JsonValue {
  try {
    return parseJsonValue(JSON.parse(value));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} contains invalid JSON: ${detail}`, { cause: error });
  }
}

function parseJsonOrText(value: string): JsonValue {
  try {
    return parseJsonValue(JSON.parse(value));
  } catch {
    return value;
  }
}

function validationResponse(row: ValidationRow): ValidationResult {
  const caseResults = parseStoredJson(row.case_results_json, `validation ${row.candidate_sha}`);
  if (!Array.isArray(caseResults)) {
    throw new TypeError(`validation ${row.candidate_sha} case results are not an array`);
  }
  const parsedCaseResults: readonly JsonValue[] = caseResults;
  return {
    candidate: parseSha(row.candidate_sha),
    generation: parseGenerationNumber(row.generation_number),
    artifactDigest: parseSha(row.artifact_digest),
    validatedAgainst: row.validated_against === null ? undefined : parseSha(row.validated_against),
    validatedAgainstGeneration:
      row.validated_against_generation === null
        ? undefined
        : parseGenerationNumber(row.validated_against_generation),
    corpusVersion: row.corpus_version,
    gateVersion: row.gate_version,
    verdict: row.verdict,
    createdAt: row.created_at,
    caseResults: parsedCaseResults.map((entry, index) =>
      parseValidationCaseResult(entry, `validation ${row.candidate_sha}[${index}]`),
    ),
  };
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

type SafetyViolationKind = "not-live" | "quarantined";

class SafetyViolationError extends Error {
  readonly kind: SafetyViolationKind;

  constructor(kind: SafetyViolationKind, message: string) {
    super(message);
    this.name = "SafetyViolationError";
    this.kind = kind;
  }
}

function requestErrorResponse(error: Error | string): Response {
  if (error instanceof InvalidRequestError) {
    return Response.json(
      { error: { kind: error.kind, message: error.message } satisfies InvalidRequest },
      { status: 400 },
    );
  }
  if (error instanceof MissingResourceError) {
    return Response.json({ error: { kind: error.kind, message: error.message } }, { status: 404 });
  }
  if (error instanceof SafetyViolationError) {
    return Response.json({ error: { kind: error.kind, message: error.message } }, { status: 422 });
  }
  return Response.json(
    { error: { kind: "internal", message: error instanceof Error ? error.message : error } },
    { status: 500 },
  );
}
