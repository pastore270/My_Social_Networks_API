import express from 'express';
import * as schema from './schemas.js';
import { identify, hashPassword, tokenFor, verifyPassword } from './auth.js';
import { HttpError, asResource, change, list, read, requireCondition } from './storage.js';
import { installActivities } from './activities.js';
import { isOrganizer, isParticipant, isAdmin, isMember, requireOrganizer, requireAdmin, parse, newRecord } from './domain.js';

const now = () => new Date().toISOString();
const unique = items => [...new Set(items)];
const publicUser = user => ({ id: user._id, firstName: user.firstName, lastName: user.lastName });
const ownUser = user => ({ ...publicUser(user), email: user.email });
const eventMetadata = event => {
  const { threads, albums, polls, ticketTypes, tickets, shoppingItems, rides, ...metadata } = asResource(event);
  return metadata;
};
const groupMetadata = group => {
  const { threads, ...metadata } = asResource(group);
  return metadata;
};

export function createApp(db, { jwtSecret, publicBaseUrl }) {
  const app = express();
  const router = express.Router();
  const docs = [];
  const users = db.collection('users');
  const groups = db.collection('groups');
  const events = db.collection('events');

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({ status: 'ok' });
  });
  app.use('/api/v2', identify(users, jwtSecret), router);
  app.use((_req, _res, next) => next(new HttpError(404, 'Route introuvable')));
  app.use((error, _req, res, _next) => {
    if (error.code === 11000) return res.status(409).json({ error: 'Cette adresse e-mail est déjà utilisée' });
    if (error.code === 10334 || error.name === 'BSONError' && /size|buffer/i.test(error.message)) {
      return res.status(409).json({ error: 'Capacité maximale de la ressource atteinte' });
    }
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status === 500 ? 'Erreur interne du serveur' : error.message });
  });

  // Les métadonnées servent aussi à générer la collection Postman.
  function route(method, path, { area, label, description, body, example, output, auth = 'required', status = 200, search = false }, action) {
    docs.push({ method, path, area, label, description, example, output, auth, status, search });
    router[method.toLowerCase()](path, async (req, res) => {
      if (auth === 'required') requireCondition(req.user, 401, 'Authentification requise');
      const params = Object.fromEntries(Object.entries(req.params).map(([key, value]) => [key, parse(schema.id, value)]));
      const data = body ? parse(body, req.body ?? {}) : undefined;
      const criteria = search ? parse(schema.search, req.query) : undefined;
      const result = await action({ actor: req.user?._id, user: req.user, params, data, criteria });
      return status === 204 ? res.sendStatus(204) : res.status(status).json(result);
    });
  }

  async function activeUsers(ids) {
    if (!ids.length) return;
    const found = await users.countDocuments({ _id: { $in: ids }, deletedAt: null });
    requireCondition(found === ids.length, 400, 'Au moins un utilisateur est introuvable ou désactivé');
  }

  function assertGroupVisible(group, actor) {
    requireCondition(group.visibility !== 'secret' || isMember(group, actor), 404, 'Groupe introuvable');
  }

  async function eventIsPublic(event, actor) {
    if (event.status !== 'published' || event.visibility !== 'public') return false;
    if (!event.groupId) return true;
    const group = await groups.findOne({ _id: event.groupId, deletedAt: null });
    return Boolean(group && (group.visibility === 'public' || isMember(group, actor)));
  }

  async function assertEventVisible(event, actor) {
    const participant = event.status === 'published' && isParticipant(event, actor);
    requireCondition(isOrganizer(event, actor) || participant || await eventIsPublic(event, actor), 404, 'Événement introuvable');
  }

  function requirePublished(event) {
    requireCondition(event.status === 'published', 409, 'Publie d’abord l’événement');
  }

  function checkDates(event) {
    requireCondition(event.endsAt > event.startsAt, 400, 'La date de fin doit suivre la date de début');
  }

  async function checkTicketing(event, enabled) {
    if (!enabled) {
      requireCondition(!event.tickets.length, 409, 'Des billets sont encore réservés');
      return;
    }
    const group = event.groupId ? await read(groups, event.groupId) : null;
    requireCondition(event.visibility === 'public' && (!group || group.visibility === 'public'),
      400, 'La billetterie est réservée aux événements accessibles au public');
  }

  const examples = {
    user: { firstName: 'Camille', lastName: 'Dupont', email: 'camille@example.com', password: 'exemple-demo-2026' },
    group: {
      name: 'Club photo', description: 'Sorties photo à Paris', iconUrl: 'https://example.com/icon.png',
      coverUrl: 'https://example.com/group.jpg', visibility: 'public', membersCanPost: true,
      membersCanCreateEvents: true, memberIds: ['{{participantId}}']
    },
    event: {
      name: 'Balade photo', description: 'Photographier les quais de Seine',
      startsAt: '2027-04-17T10:00:00+02:00', endsAt: '2027-04-17T14:00:00+02:00',
      location: 'Parvis de la mairie, Paris', coverUrl: 'https://example.com/event.jpg', visibility: 'public',
      groupId: '{{groupId}}', participantIds: ['{{participantId}}']
    },
    options: { shoppingEnabled: true, carpoolEnabled: true, ticketingEnabled: true, inviteAllGroupMembers: true }
  };

  const accountRoutes = (method, path, options, action) => route(method, path, { area: 'Utilisateurs', ...options }, action);

  accountRoutes('POST', '/users', {
    label: 'Créer un utilisateur', description: 'Crée un compte. Une adresse e-mail est unique, indépendamment de la casse.',
    body: schema.account, example: examples.user, output: 'account', auth: 'none', status: 201
  }, async ({ data: { password, ...data } }) => {
    const user = newRecord({ ...data, passwordHash: await hashPassword(password), authVersion: 0 });
    await users.insertOne(user);
    return ownUser(user);
  });

  accountRoutes('POST', '/auth/login', {
    label: 'Se connecter', description: 'Renvoie un jeton Bearer valable deux heures et le compte connecté.',
    body: schema.credentials, example: { email: examples.user.email, password: examples.user.password },
    output: 'login', auth: 'none'
  }, async ({ data }) => {
    const user = await users.findOne({ email: data.email, deletedAt: null });
    requireCondition(await verifyPassword(data.password, user?.passwordHash), 401, 'Identifiants invalides');
    return { token: tokenFor(user, jwtSecret), user: ownUser(user) };
  });

  accountRoutes('GET', '/users', {
    label: 'Lister ou rechercher les utilisateurs', description: 'Recherche sur le prénom et le nom. Annuaire pour les utilisateurs connectés.',
    output: 'user', search: true
  }, ({ criteria }) => list(users, { deletedAt: null }, criteria, ['firstName', 'lastName'], publicUser, { firstName: 1, lastName: 1 }));

  accountRoutes('GET', '/users/:userId', {
    label: 'Lire un utilisateur', description: 'Renvoie le profil. La personne connectée peut également lire son adresse e-mail.',
    output: 'user'
  }, async ({ params, actor }) => {
    const user = await read(users, params.userId);
    return actor === user._id ? ownUser(user) : publicUser(user);
  });

  accountRoutes('PATCH', '/users/:userId', {
    label: 'Modifier son compte', description: 'Modifie les champs fournis. Un changement d’e-mail ou de mot de passe invalide les anciens jetons.',
    body: schema.account.partial(), example: { firstName: 'Camille-Marie' }, output: 'account'
  }, ({ actor, params, data }) => {
    requireCondition(actor === params.userId, 403, 'Tu peux modifier uniquement ton compte');
    return change(users, actor, async user => {
      const { password, ...fields } = data;
      if (password || (fields.email && fields.email !== user.email)) user.authVersion += 1;
      if (password) user.passwordHash = await hashPassword(password);
      Object.assign(user, fields);
      return ownUser(user);
    });
  });

  accountRoutes('DELETE', '/users/:userId', {
    label: 'Désactiver son compte', description: 'Désactive le compte et invalide son jeton. Les contributions restent rattachées à leur auteur.',
    status: 204
  }, async ({ actor, params }) => {
    requireCondition(actor === params.userId, 403, 'Tu peux désactiver uniquement ton compte');
    await change(users, actor, async user => {
      const [managedGroup, managedEvent] = await Promise.all([
        groups.findOne({ deletedAt: null, adminIds: [actor] }, { projection: { _id: 1 } }),
        events.findOne({ deletedAt: null, organizerIds: [actor] }, { projection: { _id: 1 } })
      ]);
      requireCondition(!managedGroup && !managedEvent, 409, 'Transfère tes groupes et événements ou supprime-les avant de désactiver ton compte');
      user.deletedAt = now();
    });
  });

  const groupRoutes = (method, path, options, action) => route(method, path, { area: 'Groupes', ...options }, action);

  groupRoutes('POST', '/groups', {
    label: 'Créer un groupe', description: 'Crée un groupe public, privé ou secret. Le créateur devient administrateur et membre.',
    body: schema.group, example: examples.group, output: 'group', status: 201
  }, async ({ actor, data }) => {
    const adminIds = unique([actor, ...(data.adminIds ?? [])]);
    const memberIds = unique([...adminIds, ...(data.memberIds ?? [])]);
    await activeUsers(memberIds);
    const group = newRecord({ ...data, adminIds, memberIds, threads: [] });
    await groups.insertOne(group);
    return groupMetadata(group);
  });

  function projectGroup(group, actor) {
    const { memberIds, adminIds, ...metadata } = groupMetadata(group);
    if (group.visibility === 'private' && !isMember(group, actor)) return metadata;
    return { ...metadata, memberIds, adminIds };
  }

  groupRoutes('GET', '/groups', {
    label: 'Lister ou rechercher les groupes', description: 'Recherche sur le nom et la description. Les groupes secrets apparaissent pour leurs membres.',
    output: 'group', auth: 'optional', search: true
  }, ({ actor, criteria }) => list(groups, {
    deletedAt: null, $or: [{ visibility: { $in: ['public', 'private'] } }, ...(actor ? [{ memberIds: actor }] : [])]
  }, criteria, ['name', 'description'], group => projectGroup(group, actor), { threads: 0 }));

  groupRoutes('GET', '/groups/:groupId', {
    label: 'Lire un groupe', description: 'Renvoie les paramètres. La liste des membres d’un groupe privé est réservée à ses membres.',
    output: 'group', auth: 'optional'
  }, async ({ actor, params }) => {
    const group = await read(groups, params.groupId);
    assertGroupVisible(group, actor);
    return projectGroup(group, actor);
  });

  groupRoutes('PATCH', '/groups/:groupId', {
    label: 'Modifier un groupe', description: 'Un administrateur modifie les paramètres ou remplace les listes. Les administrateurs sont toujours membres.',
    body: schema.group.partial(), example: { membersCanPost: false }, output: 'group'
  }, ({ actor, params, data }) => change(groups, params.groupId, async group => {
    assertGroupVisible(group, actor);
    requireAdmin(group, actor);
    const adminIds = data.adminIds ?? group.adminIds;
    const memberIds = unique([...(data.memberIds ?? group.memberIds), ...adminIds]);
    requireCondition(adminIds.length, 400, 'Le groupe doit garder au moins un administrateur');
    if (data.adminIds || data.memberIds) {
      await activeUsers(unique([...adminIds, ...memberIds.filter(id => !group.memberIds.includes(id))]));
    }
    if (data.visibility && data.visibility !== 'public' && group.visibility === 'public') {
      requireCondition(!await events.findOne({ groupId: group._id, deletedAt: null, ticketingEnabled: true }),
        409, 'Désactive les billetteries du groupe avant de modifier sa visibilité');
    }
    Object.assign(group, data, { adminIds, memberIds });
    return groupMetadata(group);
  }));

  groupRoutes('DELETE', '/groups/:groupId', {
    label: 'Supprimer un groupe', description: 'Un administrateur supprime le groupe après avoir supprimé ses événements liés.',
    status: 204
  }, ({ actor, params }) => change(groups, params.groupId, async group => {
    assertGroupVisible(group, actor);
    requireAdmin(group, actor);
    requireCondition(!await events.findOne({ groupId: group._id, deletedAt: null }), 409, 'Ce groupe contient encore des événements');
    group.deletedAt = now();
  }));

  const eventRoutes = (method, path, options, action) => route(method, path, { area: 'Événements', ...options }, action);

  eventRoutes('POST', '/events', {
    label: 'Étape 1 · Configurer un événement', description: 'Crée un brouillon. Le créateur devient organisateur. Dans un groupe, la création dépend des permissions.',
    body: schema.event, example: examples.event, output: 'eventDraft', status: 201
  }, async ({ actor, data }) => {
    if (data.groupId) {
      const group = await read(groups, data.groupId);
      assertGroupVisible(group, actor);
      requireCondition(isAdmin(group, actor) || isMember(group, actor) && group.membersCanCreateEvents,
        403, 'La création d’événements est désactivée pour ce membre');
    }
    checkDates(data);
    const organizerIds = unique([actor, ...(data.organizerIds ?? [])]);
    const participantIds = unique([...organizerIds, ...(data.participantIds ?? [])]);
    await activeUsers(participantIds);
    const event = newRecord({
      ...data, organizerIds, participantIds, status: 'draft', optionsConfigured: false,
      shoppingEnabled: false, carpoolEnabled: false, ticketingEnabled: false,
      threads: [], albums: [], polls: [], ticketTypes: [], tickets: [], shoppingItems: [], rides: []
    });
    await events.insertOne(event);
    return eventMetadata(event);
  });

  eventRoutes('GET', '/events', {
    label: 'Lister ou rechercher les événements', description: 'Recherche sur le titre, la description et le lieu. Renvoie uniquement les événements accessibles.',
    output: 'event', auth: 'optional', search: true
  }, async ({ actor, criteria }) => {
    const groupIds = groups.find({
      deletedAt: null, $or: [{ visibility: 'public' }, ...(actor ? [{ memberIds: actor }] : [])]
    }, { projection: { _id: 1 } });
    const accessibleGroupIds = (await groupIds.toArray()).map(group => group._id);
    const alternatives = [
      { status: 'published', visibility: 'public', $or: [{ groupId: null }, { groupId: { $in: accessibleGroupIds } }] }
    ];
    if (actor) alternatives.push({ organizerIds: actor }, { status: 'published', participantIds: actor });
    return list(events, { deletedAt: null, $or: alternatives }, criteria,
      ['name', 'description', 'location'], event => projectEvent(event, actor),
      { threads: 0, albums: 0, polls: 0, ticketTypes: 0, tickets: 0, shoppingItems: 0, rides: 0 });
  });

  function projectEvent(event, actor) {
    const { organizerIds, participantIds, ...metadata } = eventMetadata(event);
    if (!isParticipant(event, actor)) return { ...metadata, participantCount: participantIds.length };
    return { ...metadata, organizerIds, participantIds };
  }

  eventRoutes('GET', '/events/:eventId', {
    label: 'Lire un événement', description: 'Renvoie les informations de l’événement. Les listes d’organisateurs et de participants sont réservées aux personnes conviées.',
    output: 'event', auth: 'optional'
  }, async ({ actor, params }) => {
    const event = await read(events, params.eventId);
    await assertEventVisible(event, actor);
    return projectEvent(event, actor);
  });

  eventRoutes('PATCH', '/events/:eventId', {
    label: 'Modifier un événement', description: 'Un organisateur modifie les champs fournis, dont les listes. Le groupe est fixé à la création.',
    body: schema.event.omit({ groupId: true }).partial(), example: { location: 'Place des Vosges, Paris' }, output: 'eventMember'
  }, ({ actor, params, data }) => change(events, params.eventId, async event => {
    await assertEventVisible(event, actor);
    requireOrganizer(event, actor);
    const organizerIds = data.organizerIds ?? event.organizerIds;
    const participantIds = unique([...(data.participantIds ?? event.participantIds), ...organizerIds]);
    requireCondition(organizerIds.length, 400, 'L’événement doit garder au moins un organisateur');
    if (data.organizerIds || data.participantIds) {
      await activeUsers(unique([...organizerIds, ...participantIds.filter(id => !event.participantIds.includes(id))]));
    }
    requireCondition(!event.ticketingEnabled || data.visibility !== 'private', 409, 'Désactive la billetterie avant de passer en privé');
    Object.assign(event, data, { organizerIds, participantIds });
    checkDates(event);
    return eventMetadata(event);
  }));

  async function inviteGroup(event) {
    requireCondition(event.groupId, 400, 'Cet événement doit appartenir à un groupe');
    const group = await read(groups, event.groupId);
    const members = await users.find({ _id: { $in: group.memberIds }, deletedAt: null }, { projection: { _id: 1 } }).toArray();
    event.participantIds = unique([...event.participantIds, ...members.map(member => member._id)]);
  }

  function editEvent({ actor, params }, apply) {
    return change(events, params.eventId, async event => {
      await assertEventVisible(event, actor);
      requireOrganizer(event, actor);
      await apply(event);
      return eventMetadata(event);
    });
  }

  eventRoutes('PUT', '/events/:eventId/options', {
    label: 'Étape 2 · Configurer les options', description: 'Active ou désactive les modules. L’option d’invitation ajoute les membres actifs du groupe.',
    body: schema.eventOptions, example: examples.options, output: 'eventOptions'
  }, context => editEvent(context, async event => {
    const { inviteAllGroupMembers, ...options } = context.data;
    await checkTicketing(event, options.ticketingEnabled);
    if (inviteAllGroupMembers) await inviteGroup(event);
    Object.assign(event, options, { optionsConfigured: true });
  }));

  eventRoutes('POST', '/events/:eventId/publish', {
    label: 'Étape 3 · Publier', description: 'Publie après la configuration des options. Répéter la requête conserve le statut publié.',
    output: 'eventMember'
  }, context => editEvent(context, async event => {
    requireCondition(event.optionsConfigured, 409, 'Configure les options avant de publier');
    await checkTicketing(event, event.ticketingEnabled);
    event.status = 'published';
  }));

  eventRoutes('POST', '/events/:eventId/invitations/group-members', {
    label: 'Inviter tous les membres du groupe', description: 'Ajoute en une fois les membres actifs du groupe associé à la liste des invités. Sans doublons.',
    output: 'eventMember'
  }, context => editEvent(context, inviteGroup));

  eventRoutes('GET', '/events/:eventId/share', {
    label: 'Générer les liens de partage', description: 'L’organisateur obtient les liens de partage d’un événement public publié dans un groupe public.',
    output: 'share'
  }, async ({ actor, params }) => {
    const event = await read(events, params.eventId);
    await assertEventVisible(event, actor);
    requireOrganizer(event, actor);
    requirePublished(event);
    const group = event.groupId ? await read(groups, event.groupId) : null;
    requireCondition(group?.visibility === 'public' && event.visibility === 'public', 403, 'Le partage est réservé aux événements publics de groupes publics');
    const url = new URL('/api/v2/events/' + event._id, publicBaseUrl).href;
    const encoded = encodeURIComponent(url);
    return {
      url, facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + encoded,
      linkedin: 'https://www.linkedin.com/sharing/share-offsite/?url=' + encoded,
      x: 'https://twitter.com/intent/tweet?url=' + encoded
    };
  });

  eventRoutes('DELETE', '/events/:eventId', {
    label: 'Supprimer un événement', description: 'Archive l’événement et retire l’accès à ses discussions, albums et autres sous-ressources.',
    status: 204
  }, context => editEvent(context, event => { event.deletedAt = now(); }));

  installActivities({
    route, events, groups, assertEventVisible, assertGroupVisible, requirePublished, eventIsPublic
  });
  return { app, docs };
}
