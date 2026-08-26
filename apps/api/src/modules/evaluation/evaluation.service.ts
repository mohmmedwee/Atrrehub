import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContextStore } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { newId } from '../../core/ids/id.service';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AgentsService } from '../agents/agents.service';
import {
  METRIC_WEIGHTS,
  overallScore,
  scoreAccuracy,
  scoreGroundedness,
  scoreRelevance,
  scoreRetrievalQuality,
  scoreSafety,
  scoreToolCorrectness,
  type CaseScores,
} from './scorers';

export interface DatasetInput {
  name: string;
  description?: string;
  agentId?: string;
  isGate?: boolean;
  passThreshold?: number;
}

export interface CaseInput {
  name?: string;
  input: { message: string } & Record<string, unknown>;
  expectedOutput?: string;
  expectedContext?: string[];
  expectedTools?: string[];
  tags?: string[];
}

/**
 * A run over more cases than this is a batch job, not a request. The ceiling
 * keeps an evaluation from holding a connection open for minutes; larger
 * datasets should be split, which also makes their failures easier to read.
 */
const MAX_CASES_PER_RUN = 200;

/** What one executed case produced, before it is scored. */
interface CaseObservation {
  actualOutput: string;
  /** Citation labels, in retrieval order — what retrieval quality is scored on. */
  sources: string[];
  /** The passage text behind those citations — what groundedness is scored on. */
  passages: string[];
  toolsUsed: string[];
  latencyMs: number;
  costUsd: number;
  /** The case threw and was never scored on its merits. */
  error?: string;
  /** The agent deliberately declined to answer, and why. Still scored. */
  note?: string;
}

@Injectable()
export class EvaluationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
    private readonly logger: AppLogger,
  ) {}

  // ── Datasets ───────────────────────────────────────────────────────────────

  async listDatasets(agentId?: string) {
    return this.prisma.db.evaluationDataset.findMany({
      where: agentId ? { agentId } : {},
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { cases: true, runs: true } },
        runs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });
  }

  async createDataset(input: DatasetInput) {
    if (input.agentId) await this.agents.get(input.agentId);

    const organizationId = RequestContextStore.organizationId()!;
    const existing = await this.prisma.db.evaluationDataset.findFirst({
      where: { name: input.name },
      select: { id: true },
    });
    if (existing) throw AppError.conflict(`A dataset named "${input.name}" already exists`);

    return this.prisma.db.evaluationDataset.create({
      data: {
        id: newId('dataset'),
        organizationId,
        name: input.name,
        description: input.description,
        agentId: input.agentId,
        isGate: input.isGate ?? false,
        passThreshold: input.passThreshold ?? 0.8,
      },
    });
  }

  async getDataset(datasetId: string) {
    const dataset = await this.prisma.db.evaluationDataset.findFirst({
      where: { id: datasetId },
      include: {
        cases: { orderBy: { createdAt: 'asc' } },
        runs: { orderBy: { startedAt: 'desc' }, take: 10 },
      },
    });
    if (!dataset) throw AppError.notFound('Evaluation dataset', datasetId);
    return dataset;
  }

  async updateDataset(datasetId: string, patch: Partial<DatasetInput>) {
    await this.getDataset(datasetId);
    return this.prisma.db.evaluationDataset.update({
      where: { id: datasetId },
      data: {
        name: patch.name,
        description: patch.description,
        agentId: patch.agentId,
        isGate: patch.isGate,
        passThreshold: patch.passThreshold,
      },
    });
  }

  async deleteDataset(datasetId: string) {
    await this.getDataset(datasetId);
    await this.prisma.db.evaluationDataset.delete({ where: { id: datasetId } });
  }

  // ── Cases ──────────────────────────────────────────────────────────────────

  async addCases(datasetId: string, cases: CaseInput[]) {
    await this.getDataset(datasetId);
    const organizationId = RequestContextStore.organizationId()!;

    const created = await this.prisma.raw.$transaction(
      cases.map((entry) =>
        this.prisma.db.evaluationCase.create({
          data: {
            id: newId('evalCase'),
            organizationId,
            datasetId,
            name: entry.name,
            input: entry.input as Prisma.InputJsonValue,
            expectedOutput: entry.expectedOutput,
            expectedContext: entry.expectedContext ?? [],
            expectedTools: entry.expectedTools ?? [],
            tags: entry.tags ?? [],
          },
        }),
      ),
    );
    return created;
  }

  async deleteCase(datasetId: string, caseId: string) {
    const found = await this.prisma.db.evaluationCase.findFirst({
      where: { id: caseId, datasetId },
      select: { id: true },
    });
    if (!found) throw AppError.notFound('Evaluation case', caseId);
    await this.prisma.db.evaluationCase.delete({ where: { id: caseId } });
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  /**
   * Execute every case in the dataset against an agent and score the results.
   *
   * Cases run sequentially: they share the model gateway's rate limits and
   * token budget, and a burst of parallel executions would make one tenant's
   * evaluation starve its own live traffic.
   */
  async run(datasetId: string, options: { agentId?: string } = {}) {
    const dataset = await this.getDataset(datasetId);
    const agentId = options.agentId ?? dataset.agentId;
    if (!agentId)
      throw AppError.badRequest(
        'This dataset is not bound to an agent — pass an agentId to evaluate against',
      );

    const agent = await this.agents.get(agentId);
    const version = agent.activeVersion ?? agent.draftVersion;
    if (!version) throw AppError.conflict('This agent has no version to evaluate');

    if (!dataset.cases.length) throw AppError.badRequest('This dataset has no cases');
    if (dataset.cases.length > MAX_CASES_PER_RUN)
      throw AppError.badRequest(
        `A run is limited to ${MAX_CASES_PER_RUN} cases; this dataset has ${dataset.cases.length}`,
      );

    const organizationId = RequestContextStore.organizationId()!;
    const runId = newId('evalRun');
    await this.prisma.db.evaluationRun.create({
      data: {
        id: runId,
        organizationId,
        datasetId,
        agentId,
        agentVersionId: version.id,
        status: 'running',
        caseCount: dataset.cases.length,
        triggeredById: RequestContextStore.principal()?.id,
      },
    });

    const totals: Record<keyof CaseScores, number> = {
      accuracy: 0,
      groundedness: 0,
      relevance: 0,
      safety: 0,
      toolCorrectness: 0,
      retrievalQuality: 0,
    };
    let passedCount = 0;
    let scoreSum = 0;
    let latencySum = 0;
    let costSum = 0;

    for (const testCase of dataset.cases) {
      const observation = await this.executeCase(agentId, testCase.input);
      const scores = this.scoreCase(testCase, observation);
      const caseScore = observation.error ? 0 : overallScore(scores);
      const passed = !observation.error && caseScore >= dataset.passThreshold;

      for (const metric of Object.keys(totals) as (keyof CaseScores)[])
        totals[metric] += scores[metric];
      if (passed) passedCount += 1;
      scoreSum += caseScore;
      latencySum += observation.latencyMs;
      costSum += observation.costUsd;

      await this.prisma.db.evaluationResult.create({
        data: {
          id: newId('evalResult'),
          organizationId,
          runId,
          caseId: testCase.id,
          actualOutput: observation.actualOutput,
          // Both halves are kept: the labels say what was cited, the excerpts
          // say what the answer actually had to work with.
          retrievedContext: observation.sources.map((source, index) => ({
            source,
            excerpt: (observation.passages[index] ?? '').slice(0, 400),
          })) as Prisma.InputJsonValue,
          toolsUsed: observation.toolsUsed,
          scores: scores as unknown as Prisma.InputJsonValue,
          overallScore: caseScore,
          passed,
          latencyMs: observation.latencyMs,
          costUsd: new Prisma.Decimal(observation.costUsd.toFixed(6)),
          error: observation.error ?? observation.note,
        },
      });
    }

    const caseCount = dataset.cases.length;
    const metrics = Object.fromEntries(
      (Object.keys(totals) as (keyof CaseScores)[]).map((metric) => [
        metric,
        Math.round((totals[metric] / caseCount) * 1000) / 1000,
      ]),
    );
    const runScore = Math.round((scoreSum / caseCount) * 1000) / 1000;

    const finished = await this.prisma.db.evaluationRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        passedCount,
        overallScore: runScore,
        metrics: metrics as Prisma.InputJsonValue,
        avgLatencyMs: Math.round(latencySum / caseCount),
        totalCostUsd: new Prisma.Decimal(costSum.toFixed(6)),
        // The run — not the individual case — is what a promotion gate reads.
        passed: runScore >= dataset.passThreshold,
        finishedAt: new Date(),
      },
    });

    this.logger.log('Evaluation run finished', {
      runId,
      datasetId,
      agentId,
      score: runScore,
      passed: finished.passed,
      cases: caseCount,
    });

    return finished;
  }

  async listRuns(params: { datasetId?: string; agentId?: string; limit?: number } = {}) {
    return this.prisma.db.evaluationRun.findMany({
      where: {
        ...(params.datasetId ? { datasetId: params.datasetId } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: Math.min(params.limit ?? 25, 100),
      include: { dataset: { select: { id: true, name: true, passThreshold: true } } },
    });
  }

  async getRun(runId: string) {
    const run = await this.prisma.db.evaluationRun.findFirst({
      where: { id: runId },
      include: {
        dataset: { select: { id: true, name: true, passThreshold: true, isGate: true } },
        results: { include: { case: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run) throw AppError.notFound('Evaluation run', runId);
    return run;
  }

  /**
   * Diff two runs case by case. Regressions are listed first: an average that
   * held steady while three cases broke and three improved is the failure mode
   * a single headline score hides.
   */
  async compare(baselineRunId: string, candidateRunId: string) {
    const [baseline, candidate] = await Promise.all([
      this.getRun(baselineRunId),
      this.getRun(candidateRunId),
    ]);

    const baselineByCase = new Map(baseline.results.map((result) => [result.caseId, result]));
    const cases = candidate.results.map((result) => {
      const before = baselineByCase.get(result.caseId);
      return {
        caseId: result.caseId,
        name: result.case.name ?? null,
        baselineScore: before?.overallScore ?? null,
        candidateScore: result.overallScore,
        delta: before
          ? Math.round((result.overallScore - before.overallScore) * 1000) / 1000
          : null,
        regressed: before ? before.passed && !result.passed : false,
        fixed: before ? !before.passed && result.passed : false,
      };
    });

    return {
      baseline: { id: baseline.id, score: baseline.overallScore, passed: baseline.passed },
      candidate: { id: candidate.id, score: candidate.overallScore, passed: candidate.passed },
      regressions: cases.filter((entry) => entry.regressed),
      fixes: cases.filter((entry) => entry.fixed),
      cases,
      weights: METRIC_WEIGHTS,
    };
  }

  // ── Execution & scoring ────────────────────────────────────────────────────

  /**
   * Run one case and recover what the scorers need from the execution trace.
   *
   * A case that throws is recorded rather than aborting the run: a run that
   * stops at the first failure tells you less than one that shows which
   * fifteen cases broke.
   */
  private async executeCase(agentId: string, input: Prisma.JsonValue): Promise<CaseObservation> {
    const message = this.messageOf(input);
    const startedAt = Date.now();

    try {
      const result = await this.agents.run({ agentId, message });
      const trace = await this.traceOf(result.executionId);

      return {
        actualOutput: trace.answer ?? '',
        sources: trace.sources,
        passages: trace.passages,
        toolsUsed: trace.tools,
        latencyMs: result.durationMs ?? Date.now() - startedAt,
        costUsd: result.costUsd,
        // A handoff is a real outcome, not a harness failure: it is scored as
        // the non-answer it is, with the reason kept so the case is readable.
        note: trace.handoffReason ? `handed off: ${trace.handoffReason}` : undefined,
      };
    } catch (error) {
      return {
        actualOutput: '',
        sources: [],
        passages: [],
        toolsUsed: [],
        latencyMs: Date.now() - startedAt,
        costUsd: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Read the answer, the passages it was given and the tools it called out of
   * the execution's steps. Scoring against the trace rather than the final
   * output is what makes groundedness and retrieval quality measurable at all.
   */
  private async traceOf(executionId: string): Promise<{
    answer?: string;
    handoffReason?: string;
    sources: string[];
    passages: string[];
    tools: string[];
  }> {
    const [steps, invocations] = await Promise.all([
      this.prisma.db.executionStep.findMany({
        where: { executionId },
        orderBy: { sequence: 'asc' },
        select: { output: true },
      }),
      // The invocation log, not the step output, is the record of what the
      // agent actually called: a tool node that was blocked or suspended for
      // approval never invoked anything, and must not score as if it had.
      this.prisma.db.toolInvocation.findMany({
        where: { executionId, status: 'succeeded' },
        orderBy: { createdAt: 'asc' },
        select: { tool: { select: { key: true } } },
      }),
    ]);

    let answer: string | undefined;
    let handoffReason: string | undefined;
    const sources: string[] = [];
    const chunkIds: string[] = [];

    for (const step of steps) {
      const output = (step.output ?? {}) as Record<string, unknown>;

      if (typeof output.answer === 'string' && output.answer.trim()) answer = output.answer;
      if (output.handoff === true && typeof output.reason === 'string')
        handoffReason = output.reason;

      const citations =
        (output.citations as { title?: string; heading?: string; chunkId?: string }[]) ?? [];
      for (const citation of citations) {
        const label = [citation.title, citation.heading].filter(Boolean).join(' — ');
        if (label && !sources.includes(label)) sources.push(label);
        if (citation.chunkId && !chunkIds.includes(citation.chunkId))
          chunkIds.push(citation.chunkId);
      }
    }

    // Groundedness has to be measured against the passage text, not the
    // citation label: an answer quoting a policy verbatim would otherwise score
    // as unsupported because it does not repeat the article's title.
    const chunks = chunkIds.length
      ? await this.prisma.db.chunk.findMany({
          where: { id: { in: chunkIds } },
          select: { id: true, content: true },
        })
      : [];
    const contentById = new Map(chunks.map((chunk) => [chunk.id, chunk.content]));

    return {
      answer,
      handoffReason,
      sources,
      passages: chunkIds.map((id) => contentById.get(id) ?? '').filter(Boolean),
      tools: invocations.map((entry) => entry.tool.key),
    };
  }

  private scoreCase(
    testCase: {
      input: Prisma.JsonValue;
      expectedOutput: string | null;
      expectedContext: string[];
      expectedTools: string[];
    },
    observation: CaseObservation,
  ): CaseScores {
    const question = this.messageOf(testCase.input);

    return {
      accuracy: scoreAccuracy(observation.actualOutput, testCase.expectedOutput).score,
      groundedness: scoreGroundedness(observation.actualOutput, observation.passages).score,
      relevance: scoreRelevance(observation.actualOutput, question).score,
      safety: scoreSafety(observation.actualOutput).score,
      toolCorrectness: scoreToolCorrectness(observation.toolsUsed, testCase.expectedTools).score,
      retrievalQuality: scoreRetrievalQuality(observation.sources, testCase.expectedContext).score,
    };
  }

  private messageOf(input: Prisma.JsonValue): string {
    if (typeof input === 'string') return input;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const message = (input as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    return JSON.stringify(input ?? '');
  }
}
