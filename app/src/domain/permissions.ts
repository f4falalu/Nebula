// Roles and permissions (PRD §6). In V1 the platform's share level is the
// ceiling: Editor/Owner = Admin, Contributor = RA, Viewer/Commenter =
// Supervisor. An Admin may lower a Contributor to Supervisor and give
// Supervisors explicit grants.
import type { Grant, RoleAssignment, RoleCode } from "./types";

export interface Actor {
  id: string;
  role: RoleCode;
  grants: Grant[];
  canWrite: boolean; // platform allows writing shared data
  ceiling: RoleCode;
}

export function resolveActor(id: string, ceiling: RoleCode, assignment?: RoleAssignment): Actor {
  let role: RoleCode = ceiling;
  if (assignment && ceiling !== "admin") {
    // Only lowering is possible in V1: a Contributor can be made a Supervisor.
    if (assignment.role === "supervisor") role = "supervisor";
  }
  const grants = role === "supervisor" ? assignment?.grants ?? [] : [];
  return { id, role, grants, canWrite: ceiling !== "supervisor", ceiling };
}

export type Action =
  | "requisition.create"
  | "requisition.edit"
  | "requisition.validate"
  | "requisition.finalize"
  | "requisition.cancel"
  | "requisition.cancel_finalized"
  | "requisition.reopen"
  | "lifecycle.record"
  | "fulfillment.record"
  | "fulfillment.close"
  | "fulfillment.reopen"
  | "evidence.upload"
  | "documents.download"
  | "edit_request.submit"
  | "edit_request.approve"
  | "audit.global"
  | "alias.approve"
  | "conversion.propose"
  | "conversion.approve"
  | "master.manage"
  | "users.manage"
  | "settings.manage"
  | "chronology.override"
  | "extraction.retry";

const RA: Action[] = [
  "requisition.create", "requisition.edit", "requisition.validate", "requisition.finalize", "requisition.cancel",
  "lifecycle.record", "fulfillment.record", "fulfillment.close", "evidence.upload", "documents.download",
  "edit_request.submit", "conversion.propose", "extraction.retry",
];
const ADMIN_ONLY: Action[] = [
  "requisition.cancel_finalized", "requisition.reopen", "fulfillment.reopen", "edit_request.approve", "audit.global",
  "alias.approve", "conversion.approve", "master.manage", "users.manage", "settings.manage", "chronology.override",
];
const GRANT_ACTION: Record<Grant, Action> = {
  "requisition.reopen": "requisition.reopen",
  "edit_request.approve": "edit_request.approve",
  "documents.download": "documents.download",
};

export function can(actor: Actor | null, action: Action): boolean {
  if (!actor) return false;
  if (actor.role === "admin") return action !== "edit_request.submit"; // Admins use Reopen
  if (actor.role === "ra") return RA.includes(action);
  // Supervisor: view-only, plus explicit grants (needs platform write for reopen/approve).
  if (action === "audit.global") return true;
  const granted = actor.grants.some((g) => GRANT_ACTION[g] === action);
  if (!granted) return false;
  return action === "documents.download" || actor.canWrite;
}

export const ROLE_LABEL: Record<RoleCode, string> = { ra: "Requisition Assistant", supervisor: "Supervisor", admin: "Administrator" };
