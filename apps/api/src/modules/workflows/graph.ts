/**
 * The workflow graph model.
 *
 * A workflow is a directed graph of typed nodes, immutable once published.
 * Everything the visual builder produces and the runtime executes is described
 * here, so the canvas and the interpreter can never drift apart.
 */

export type NodeCategory = 'trigger' | 'ai' | 'knowledge' | 'logic' | 'action' | 'human';

export const NODE_TYPES = {
  // Triggers
  'trigger.conversation_started': 'trigger',
  'trigger.message_received': 'trigger',
  'trigger.ticket_created': 'trigger',
  'trigger.webhook': 'trigger',
  'trigger.schedule': 'trigger',
  // AI
  'ai.llm': 'ai',
  'ai.agent': 'ai',
  'ai.intent': 'ai',
  'ai.sentiment': 'ai',
  'ai.classify': 'ai',
  // Knowledge
  'knowledge.search': 'knowledge',
  'knowledge.retrieve': 'knowledge',
  // Logic
  'logic.condition': 'logic',
  'logic.switch': 'logic',
  'logic.router': 'logic',
  'logic.loop': 'logic',
  'logic.delay': 'logic',
  'logic.set': 'logic',
  // Actions
  'action.send_message': 'action',
  'action.send_email': 'action',
  'action.create_ticket': 'action',
  'action.update_ticket': 'action',
  'action.update_customer': 'action',
  'action.http': 'action',
  'action.webhook': 'action',
  'action.tool': 'action',
  // Human
  'human.handoff': 'human',
  'human.transfer': 'human',
  'human.escalate': 'human',
} as const satisfies Record<string, NodeCategory>;

export type NodeType = keyof typeof NODE_TYPES;

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name?: string;
  position?: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  /** Named output for branching nodes: `true`/`false`, a switch case, or `error`. */
  branch?: string;
  /** Expression that must evaluate truthy for this edge to be taken. */
  condition?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface GraphIssue {
  severity: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

/**
 * Validate a graph before it can be published.
 *
 * Publishing a broken workflow means discovering it in production on a live
 * customer conversation, so the checks here are deliberately strict: exactly
 * one trigger, no orphans, no unknown node types, no dangling edges, and no
 * cycle that is not an explicit loop.
 */
export function validateGraph(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];

  if (!nodes.length) {
    return [{ severity: 'error', message: 'The workflow has no nodes' }];
  }

  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id))
      issues.push({
        severity: 'error',
        nodeId: node.id,
        message: `Duplicate node id "${node.id}"`,
      });
    ids.add(node.id);
    if (!(node.type in NODE_TYPES)) {
      issues.push({
        severity: 'error',
        nodeId: node.id,
        message: `Unknown node type "${node.type}"`,
      });
    }
  }

  const triggers = nodes.filter((node) => NODE_TYPES[node.type] === 'trigger');
  if (triggers.length === 0)
    issues.push({ severity: 'error', message: 'The workflow has no trigger node' });
  if (triggers.length > 1) {
    issues.push({
      severity: 'error',
      message: `The workflow has ${triggers.length} triggers; exactly one is required`,
    });
  }

  for (const edge of edges) {
    if (!ids.has(edge.from))
      issues.push({
        severity: 'error',
        message: `Edge "${edge.id}" starts at unknown node "${edge.from}"`,
      });
    if (!ids.has(edge.to))
      issues.push({
        severity: 'error',
        message: `Edge "${edge.id}" ends at unknown node "${edge.to}"`,
      });
  }

  // Every node must be reachable from the trigger, or it is dead configuration.
  if (triggers.length === 1) {
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    }
    const reachable = new Set<string>();
    const stack = [triggers[0].id];
    while (stack.length) {
      const current = stack.pop()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const next of adjacency.get(current) ?? []) stack.push(next);
    }
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        issues.push({
          severity: 'warning',
          nodeId: node.id,
          message: `"${node.name ?? node.id}" is unreachable from the trigger`,
        });
      }
    }
  }

  // Branching nodes need somewhere to branch to.
  for (const node of nodes) {
    const outgoing = edges.filter((edge) => edge.from === node.id);
    if ((node.type === 'logic.condition' || node.type === 'logic.switch') && outgoing.length < 2) {
      issues.push({
        severity: 'warning',
        nodeId: node.id,
        message: `"${node.name ?? node.id}" branches but has fewer than two outgoing edges`,
      });
    }
    if (NODE_TYPES[node.type] === 'trigger' && !outgoing.length) {
      issues.push({
        severity: 'error',
        nodeId: node.id,
        message: 'The trigger has no outgoing edge',
      });
    }
  }

  for (const cycle of findCycles(nodes, edges)) {
    const hasLoopNode = cycle.some(
      (id) => nodes.find((node) => node.id === id)?.type === 'logic.loop',
    );
    if (!hasLoopNode) {
      issues.push({
        severity: 'error',
        message: `Cycle without a loop node: ${cycle.join(' → ')}`,
      });
    }
  }

  return issues;
}

/** Depth-first cycle detection, returning each cycle's node path. */
function findCycles(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges)
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);

  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (id: string) => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const start = path.indexOf(id);
      if (start >= 0) cycles.push([...path.slice(start), id]);
      return;
    }
    state.set(id, 'visiting');
    path.push(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    path.pop();
    state.set(id, 'done');
  };

  for (const node of nodes) visit(node.id);
  return cycles;
}

/** True when the graph has no errors — warnings do not block publishing. */
export function isPublishable(issues: GraphIssue[]): boolean {
  return !issues.some((issue) => issue.severity === 'error');
}
