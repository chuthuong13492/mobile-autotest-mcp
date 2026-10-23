/**
 * Optional MCP elicitation for `request_approval` (AUTH-004; ADR-0006; RL-030, RL-031).
 *
 * Elicitation is client-attested and can be answered by a hook without a human, so an `accept` is AL1 at most and
 * creates an approval only when policy's minimum for the scope is AL1 or lower; otherwise the outcome is
 * `accepted_insufficient` and the dialog's text points the human at `autotest approve`. Both protocol eras work:
 * on the 2025 era the server sends `elicitation/create` directly; on the 2026-07-28 era it returns
 * `input_required` and the client retries the call with the answer (the retry finds the same open request by its
 * scope digest). Clients without the elicitation capability get `not_offered`.
 */
import os from 'node:os';
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolOutput } from '@autotest/core';
import { minAssurance, type PolicyEnvironment, type PolicyLoadResult } from '@autotest/policy';
import { grantApproval, type WorkflowPorts } from '@autotest/workflow';
import type { ToolResult } from './middleware/pipeline.ts';

export interface ElicitationDeps {
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly serverEnvironment: { readonly id: string; readonly kind: PolicyEnvironment };
  /** Capabilities the client declared at initialize (2025 era). */
  readonly clientCapabilities: () => ClientCapabilities | undefined;
}

const Confirm = z.object({ confirm: z.boolean() });
const KEY = 'approve';

export async function elicitApproval(
  deps: ElicitationDeps,
  args: unknown,
  result: ToolResult,
  ctx: ServerContext,
): Promise<ToolResult> {
  if (result.isError || !deps.policy.ok) return result;
  const out = result.structuredContent as ToolOutput<'request_approval'>;
  const offer = (args as { offerElicitation?: unknown } | undefined)?.offerElicitation !== false;
  if (!offer || out.status !== 'open') return result;
  const request = await deps.ports.approvals.getRequest(out.approvalRequestId);
  if (!request) return result;

  const message = [
    `AutoTest approval request ${request.id}`,
    request.display?.summary ?? request.scope.kind,
    `Agent justification (untrusted): ${request.display?.justification || '—'}`.slice(0, 600),
    `Scope digest: ${request.scope.digest}`,
    `Required assurance: ${request.requiredAssurance}. Confirming here counts as AL1 only.`,
    `To approve at AL2, run in your own terminal: ${request.instructions.cliCommand}`,
  ].join('\n');

  let answer: { action: 'accept' | 'decline' | 'cancel'; confirm: boolean } | undefined;
  const view = inputResponse(ctx.mcpReq.inputResponses, KEY);
  if (view.kind === 'elicit')
    answer = {
      action: view.action,
      confirm: acceptedContent(ctx.mcpReq.inputResponses, KEY, Confirm)?.confirm === true,
    };
  else {
    if (!deps.clientCapabilities()?.elicitation) return result;
    try {
      const r = await ctx.mcpReq.elicitInput({
        mode: 'form',
        message,
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', title: 'I approve this exact scope' } },
          required: ['confirm'],
        },
      });
      answer = { action: r.action, confirm: r.content?.['confirm'] === true };
    } catch {
      // 2026-07-28 era: ask through an input_required result; the client retries with the answer.
      return inputRequired({
        inputRequests: { [KEY]: inputRequired.elicit({ message, requestedSchema: Confirm }) },
      }) as unknown as ToolResult;
    }
  }

  let outcome: ToolOutput<'request_approval'>['elicitationOutcome'];
  let approvalId: string | null = null;
  let status: ToolOutput<'request_approval'>['status'] = out.status;
  if (answer.action === 'cancel') outcome = 'cancelled';
  else if (answer.action === 'decline' || !answer.confirm) outcome = 'declined';
  else {
    const { required } = minAssurance(
      request.scope.kind,
      deps.serverEnvironment.kind,
      deps.policy.policy.config.approvals.minAssurance,
    );
    if (required === 'AL1' || required === 'none') {
      const granted = await grantApproval(deps.ports, {
        request,
        source: 'elicitation',
        assurance: 'AL1',
        approver: { osUser: os.userInfo().username },
        environment: deps.serverEnvironment.id,
        policyVersion: deps.policy.policy.policyVersion,
        actor: 'agent',
      });
      if (granted.ok) {
        outcome = 'accepted';
        approvalId = granted.approval.id;
        status = 'fulfilled';
      } else outcome = 'accepted_insufficient';
    } else outcome = 'accepted_insufficient';
  }
  const structured = { ...out, status, approvalId, elicitationOutcome: outcome };
  const text =
    outcome === 'accepted'
      ? `Approved at AL1 (${approvalId}).`
      : outcome === 'accepted_insufficient'
        ? `Confirmation recorded but ${request.requiredAssurance} is required. Ask the human to run: ${request.instructions.cliCommand}`
        : `Elicitation ${outcome}. The request stays open: ${request.instructions.cliCommand}`;
  return { ...result, structuredContent: structured, content: [{ type: 'text', text }] };
}
