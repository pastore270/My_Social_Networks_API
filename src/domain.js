import { randomUUID } from 'node:crypto';
import { HttpError, requireCondition } from './storage.js';

const now = () => new Date().toISOString();

function hasId(record, field, actor) {
  return Boolean(actor && record[field].includes(actor));
}

export const isOrganizer = (event, actor) => hasId(event, 'organizerIds', actor);
export const isParticipant = (event, actor) => isOrganizer(event, actor) || hasId(event, 'participantIds', actor);
export const isAdmin = (group, actor) => hasId(group, 'adminIds', actor);
export const isMember = (group, actor) => isAdmin(group, actor) || hasId(group, 'memberIds', actor);
export const requireOrganizer = (event, actor) => requireCondition(isOrganizer(event, actor), 403, 'Réservé aux organisateurs');
export const requireParticipant = (event, actor) => requireCondition(isParticipant(event, actor), 403, 'Réservé aux participants');
export const requireMember = (group, actor) => requireCondition(isMember(group, actor), 403, 'Réservé aux membres');
export const requireAdmin = (group, actor) => requireCondition(isAdmin(group, actor), 403, 'Réservé aux administrateurs');

export function parse(validator, input) {
  const result = validator.safeParse(input);
  if (!result.success) throw new HttpError(400, result.error.issues.map(issue =>
    [issue.path.join('.'), issue.message].filter(Boolean).join(' — ')
  ).join(' | '));
  return result.data;
}

export function newRecord(data) {
  const time = now();
  return { ...data, _id: randomUUID(), createdAt: time, updatedAt: time, version: 0 };
}

