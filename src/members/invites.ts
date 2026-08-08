import { createHash, randomBytes } from "node:crypto";

import { withPlatform, withTenant } from "@/db";
import { authorize, effectivePermissions } from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";
import { record } from "@/audit/record";
import { inviteUrl } from "@/auth";
import { send } from "@/mailer";

/**
 * Member invitations (ours, not Better Auth's — DATA_MODEL §6.1).
 * Raw tokens never touch the database: sha256 hash stored, link
 * carries the token once. Subset guard (AUTHZ.md §7.1): an inviter may
 * propose only roles whose combined permission set they hold.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export async function createInvite(input: {
  tenantId: string;
  actorMemberId: string;
  email: string;
  roleIds: string[];
}): Promise<{ inviteId: string }> {
  const email = input.email.trim().toLowerCase();
  const token = randomBytes(32).toString("base64url");

  const inviteId = await withTenant(
    input.tenantId,
    { type: "member", id: input.actorMemberId },
    async (tx) => {
      await authorize(tx, { memberId: input.actorMemberId }, "member:invite");

      const roles = await tx.role.findMany({
        where: { id: { in: input.roleIds } },
        include: {
          rolePermissions: {
            where: { source: { not: "TENANT_REVOKE" } },
            select: { permission: { select: { code: true } } },
          },
        },
      });
      if (roles.length !== input.roleIds.length) {
        deny("NOT_FOUND", "unknown role in proposal");
      }

      // Subset guard: assigning a role grants its whole set — the
      // actor's effective set must be a superset (§7.1 rule 1).
      const actorSet = await effectivePermissions(tx, input.actorMemberId);
      for (const role of roles) {
        for (const rp of role.rolePermissions) {
          if (!actorSet.has(rp.permission.code)) {
            deny(
              "FORBIDDEN",
              `cannot grant ${rp.permission.code} via role "${role.name}" — you do not hold it`,
            );
          }
        }
      }

      const existingMember = await tx.member.findFirst({
        where: { user: { email } },
        select: { id: true },
      });
      if (existingMember) deny("FORBIDDEN", "already a member");

      const invite = await tx.memberInvite.create({
        data: {
          tenantId: input.tenantId,
          email,
          proposedRoleIds: input.roleIds,
          tokenHash: hashToken(token),
          invitedByMemberId: input.actorMemberId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });

      await record(tx, {
        action: "member.invited",
        targetType: "MemberInvite",
        targetId: invite.id,
        metadata: { email, roleCount: input.roleIds.length },
      });

      return invite.id;
    },
  );

  await send({
    to: email,
    subject: "You have been invited to Fortleva",
    text: `You have been invited to a Fortleva workspace.\n\nAccept the invitation: ${inviteUrl(token)}\n\nThis link expires in 7 days.`,
  });

  return { inviteId };
}

export type InvitePreview = {
  tenantName: string;
  email: string;
  status: "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";
  expired: boolean;
};

/** Token → preview for the acceptance page. Cross-tenant by nature
 * (the acceptor has no tenant context yet) — system path, read-only. */
export async function previewInvite(token: string): Promise<InvitePreview | null> {
  return withPlatform(
    { type: "system", job: "invite-preview" },
    "resolve invite token for acceptance page",
    async (tx) => {
      const invite = await tx.memberInvite.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { tenant: { select: { name: true } } },
      });
      if (!invite) return null;
      return {
        tenantName: invite.tenant.name,
        email: invite.email,
        status: invite.status,
        expired: invite.expiresAt.getTime() < Date.now(),
      };
    },
  );
}

/**
 * Acceptance: Member + MemberRole rows + status flip in ONE
 * transaction (DATA_MODEL §6.3). The signed-in user's email must match
 * the invitation — decision 6 keeps identities separate; an invite
 * never creates a portal identity (PLAN.md non-negotiable test).
 */
export async function acceptInvite(input: {
  token: string;
  userId: string;
  userEmail: string;
}): Promise<{ tenantId: string; memberId: string }> {
  return withPlatform(
    { type: "system", job: "invite-acceptance" },
    "accept member invitation",
    async (tx) => {
      const invite = await tx.memberInvite.findUnique({
        where: { tokenHash: hashToken(input.token) },
      });
      if (!invite) throw new AuthzError("NOT_FOUND");
      if (invite.status !== "PENDING") {
        throw new AuthzError("FORBIDDEN", `invite is ${invite.status}`);
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        await tx.memberInvite.update({
          where: { id: invite.id },
          data: { status: "EXPIRED" },
        });
        throw new AuthzError("FORBIDDEN", "invite expired");
      }
      if (invite.email !== input.userEmail.trim().toLowerCase()) {
        throw new AuthzError("FORBIDDEN", "invitation was issued to a different email");
      }

      const member = await tx.member.create({
        data: {
          tenantId: invite.tenantId,
          userId: input.userId,
          invitedById: invite.invitedByMemberId,
        },
      });

      const roleIds = (invite.proposedRoleIds as string[]) ?? [];
      const roles = await tx.role.findMany({
        where: { tenantId: invite.tenantId, id: { in: roleIds } },
        select: { id: true },
      });
      for (const role of roles) {
        await tx.memberRole.create({
          data: {
            tenantId: invite.tenantId,
            memberId: member.id,
            roleId: role.id,
            assignedById: invite.invitedByMemberId,
          },
        });
      }

      await tx.memberInvite.update({
        where: { id: invite.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });

      await tx.auditEvent.create({
        data: {
          tenantId: invite.tenantId,
          actorType: "MEMBER",
          actorId: input.userId,
          action: "member.joined",
          targetType: "Member",
          targetId: member.id,
          metadata: { inviteId: invite.id, roleCount: roles.length },
          visibility: "TENANT",
        },
      });

      return { tenantId: invite.tenantId, memberId: member.id };
    },
    { readOnly: false, targetTenantId: undefined },
  );
}
