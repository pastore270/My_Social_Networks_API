import { z } from 'zod';

export const id = z.uuid({ version: 'v4' });
const shortText = z.string().trim().min(1).max(120);
const text = z.string().trim().min(1).max(4000);
const date = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const url = z.url({ protocol: /^https?$/ }).max(2000);
const ids = z.array(id).max(1000).refine(values => new Set(values).size === values.length, 'Identifiants en double');
const price = z.number().int().min(0).max(100_000_000);
const quantity = z.number().int().min(1).max(10_000);
const email = z.string().trim().max(254).pipe(z.email()).transform(value => value.toLowerCase());
const password = z.string().min(10).max(128);

export const account = z.strictObject({ firstName: shortText, lastName: shortText, email, password });
export const credentials = z.strictObject({ email, password });
export const group = z.strictObject({
  name: shortText, description: text, iconUrl: url, coverUrl: url,
  visibility: z.enum(['public', 'private', 'secret']),
  membersCanPost: z.boolean(), membersCanCreateEvents: z.boolean(),
  memberIds: ids.optional(), adminIds: ids.optional()
});
export const event = z.strictObject({
  name: shortText, description: text, startsAt: date, endsAt: date,
  location: shortText, coverUrl: url, visibility: z.enum(['public', 'private']),
  organizerIds: ids.optional(), participantIds: ids.optional(), groupId: id.optional()
});
export const eventOptions = z.strictObject({
  shoppingEnabled: z.boolean(),
  carpoolEnabled: z.boolean(),
  ticketingEnabled: z.boolean(),
  inviteAllGroupMembers: z.boolean().optional()
});
export const empty = z.strictObject({});
export const thread = z.strictObject({ title: shortText });
export const message = z.strictObject({ body: text });
export const album = z.strictObject({ title: shortText });
export const photo = z.strictObject({ url, caption: z.string().trim().max(500).optional() });
const question = z.strictObject({
  prompt: shortText,
  choices: z.array(shortText).min(2).max(20)
    .refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length, 'Choix en double')
});
export const poll = z.strictObject({ title: shortText, questions: z.array(question).min(1).max(30) });
export const answers = z.strictObject({ answers: z.array(z.number().int().min(0)).min(1).max(30) });
export const ticketType = z.strictObject({ name: shortText, amountCents: price, quantity });
export const buyer = z.strictObject({
  firstName: shortText, lastName: shortText,
  address: z.strictObject({
    street: shortText, postalCode: shortText, city: shortText, country: shortText
  })
});
export const purchase = buyer.extend({ ticketTypeId: id });
export const shoppingItem = z.strictObject({ name: shortText, quantity, arrivalAt: date });
export const ride = z.strictObject({
  departurePlace: shortText, departureAt: date, priceCents: price, seats: z.number().int().min(1).max(8),
  maxDetourMinutes: z.number().int().min(0).max(720)
});
export const search = z.object({
  q: z.string().trim().max(120).default(''),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});
