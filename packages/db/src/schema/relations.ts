import { relations } from 'drizzle-orm';
import { actions } from './actions.js';
import { auditLog } from './audit-log.js';
import { exceptions } from './exceptions.js';
import { merchants } from './merchants.js';
import { outcomes } from './outcomes.js';
import { plans } from './plans.js';
import { recoveryCases } from './recovery-cases.js';
import { users } from './users.js';

/**
 * Relations, mirroring the entity graph in docs/DATABASE_DESIGN.md:
 *
 *   merchants
 *       └─< recovery_cases
 *               ├─< plans ─< actions ─< outcomes
 *               ├─< exceptions
 *               └─< audit_log
 *
 *   raw_events   standalone; consumed to create recovery_cases
 *   bandit_arms  standalone; keyed by issuer × method × cause
 */

export const merchantsRelations = relations(merchants, ({ many }) => ({
  recoveryCases: many(recoveryCases),
  users: many(users),
}));

export const usersRelations = relations(users, ({ one }) => ({
  merchant: one(merchants, { fields: [users.merchantId], references: [merchants.id] }),
}));

export const recoveryCasesRelations = relations(recoveryCases, ({ one, many }) => ({
  merchant: one(merchants, { fields: [recoveryCases.merchantId], references: [merchants.id] }),
  plans: many(plans),
  actions: many(actions),
  outcomes: many(outcomes),
  exceptions: many(exceptions),
  auditEntries: many(auditLog),
}));

export const plansRelations = relations(plans, ({ one, many }) => ({
  case: one(recoveryCases, { fields: [plans.caseId], references: [recoveryCases.id] }),
  actions: many(actions),
}));

export const actionsRelations = relations(actions, ({ one, many }) => ({
  plan: one(plans, { fields: [actions.planId], references: [plans.id] }),
  case: one(recoveryCases, { fields: [actions.caseId], references: [recoveryCases.id] }),
  outcomes: many(outcomes),
}));

export const outcomesRelations = relations(outcomes, ({ one }) => ({
  case: one(recoveryCases, { fields: [outcomes.caseId], references: [recoveryCases.id] }),
  action: one(actions, { fields: [outcomes.actionId], references: [actions.id] }),
}));

export const exceptionsRelations = relations(exceptions, ({ one }) => ({
  case: one(recoveryCases, { fields: [exceptions.caseId], references: [recoveryCases.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  case: one(recoveryCases, { fields: [auditLog.caseId], references: [recoveryCases.id] }),
}));
