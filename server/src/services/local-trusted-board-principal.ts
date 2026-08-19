import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";

export const LOCAL_TRUSTED_BOARD_USER_ID = "local-board" as const;
const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
const LOCAL_BOARD_USER_NAME = "Board";

/**
 * Materialize the implicit local board as a real user principal. Execution
 * policy user participants are deliberately validated against durable users
 * and active company membership, so local-trusted mode must not rely on an
 * authorization-only sentinel that the user directory cannot resolve.
 */
export async function ensureLocalTrustedBoardPrincipal(db: Db): Promise<void> {
  const now = new Date();
  const existingUser = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, LOCAL_TRUSTED_BOARD_USER_ID))
    .then((rows) => rows[0] ?? null);

  if (!existingUser) {
    await db.insert(authUsers).values({
      id: LOCAL_TRUSTED_BOARD_USER_ID,
      name: LOCAL_BOARD_USER_NAME,
      email: LOCAL_BOARD_USER_EMAIL,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const role = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(
      eq(instanceUserRoles.userId, LOCAL_TRUSTED_BOARD_USER_ID),
      eq(instanceUserRoles.role, "instance_admin"),
    ))
    .then((rows) => rows[0] ?? null);
  if (!role) {
    await db.insert(instanceUserRoles).values({
      userId: LOCAL_TRUSTED_BOARD_USER_ID,
      role: "instance_admin",
    });
  }

  const companyRows = await db.select({ id: companies.id }).from(companies);
  for (const company of companyRows) {
    const membership = await db
      .select({
        id: companyMemberships.id,
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, company.id),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, LOCAL_TRUSTED_BOARD_USER_ID),
      ))
      .then((rows) => rows[0] ?? null);
    if (!membership) {
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_TRUSTED_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
      continue;
    }
    if (membership.status !== "active" || membership.membershipRole !== "owner") {
      await db
        .update(companyMemberships)
        .set({ status: "active", membershipRole: "owner", updatedAt: now })
        .where(eq(companyMemberships.id, membership.id));
    }
  }
}
