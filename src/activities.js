import * as schema from './schemas.js';
import {
  isOrganizer, isParticipant, isAdmin, requireOrganizer, requireParticipant,
  requireMember, newRecord
} from './domain.js';
import { asResource, change, read, requireCondition } from './storage.js';

function itemById(items, id) {
  const item = items.find(candidate => candidate._id === id);
  requireCondition(item, 404, 'Ressource introuvable');
  return item;
}

function remove(items, item) {
  items.splice(items.indexOf(item), 1);
}

function paginate(items, { q, page, limit }, fields, project) {
  const search = q.toLowerCase();
  const matches = search ? items.filter(item =>
    fields.some(field => String(item[field] ?? '').toLowerCase().includes(search))
  ) : items;
  const start = (page - 1) * limit;
  return { items: matches.slice(start, start + limit).map(project), page, limit, total: matches.length };
}

const without = (record, ...keys) => {
  const result = asResource(record);
  for (const key of keys) delete result[key];
  return result;
};

const participantWrite = (event, actor) => requireParticipant(event, actor);
const organizerWrite = (event, actor) => requireOrganizer(event, actor);
const ownerOrManager = (manager, ownerField) => (root, actor, item) => {
  requireCondition(item[ownerField] === actor || manager(root, actor), 403, 'Réservé à l’auteur ou à un responsable');
};

function availability(event, type) {
  return type.quantity - event.tickets.filter(ticket => ticket.ticketTypeId === type._id).length;
}

function duplicate(items, item, field, value) {
  return items.some(candidate => candidate !== item && candidate[field].toLowerCase() === value.toLowerCase());
}

export function installActivities({
  route, events, groups, assertEventVisible, assertGroupVisible, requirePublished, eventIsPublic
}) {
  const eventRoot = {
    collection: events, param: 'eventId', path: '/events/:eventId', manager: isOrganizer,
    visible: async (event, actor) => {
      await assertEventVisible(event, actor);
      requirePublished(event);
    }
  };
  const groupRoot = {
    collection: groups, param: 'groupId', path: '/groups/:groupId', manager: isAdmin,
    visible: assertGroupVisible
  };

  async function access(root, context, mode, use) {
    const id = context.params[root.param];
    const apply = async document => {
      await root.visible(document, context.actor);
      return use(document);
    };
    if (mode === 'write') return change(root.collection, id, apply);
    return apply(await read(root.collection, id));
  }

  function crud(root, details) {
    const {
      area, path, param, label, message, validator, example, output,
      select, view, create, edit = create, erase = edit, fields,
      project = item => asResource(item), extra = () => ({}),
      beforeCreate = () => {}, beforeUpdate = () => {}, beforeDelete = () => {},
      visibleItems = (_document, _context, items) => items, auth = 'required'
    } = details;
    const base = root.path + path;

    route('GET', base, {
      area, label: 'Lister · ' + label, description: message, output, auth, search: true
    }, context => access(root, context, 'read', document => {
      view(document, context.actor);
      const items = visibleItems(document, context, select(document, context.params));
      return paginate(items, context.criteria, fields, item => project(item, document));
    }));

    route('GET', base + '/:' + param, {
      area, label: 'Lire · ' + label, description: message, output, auth
    }, context => access(root, context, 'read', document => {
      view(document, context.actor);
      const items = visibleItems(document, context, select(document, context.params));
      return project(itemById(items, context.params[param]), document);
    }));

    route('POST', base, {
      area, label: 'Créer · ' + label, description: message, body: validator, example, output, status: 201
    }, context => access(root, context, 'write', async document => {
      view(document, context.actor);
      create(document, context.actor);
      const items = select(document, context.params);
      await beforeCreate(document, items, context);
      const item = newRecord({ ...context.data, ...extra(context, document) });
      items.push(item);
      return project(item, document);
    }));

    route('PATCH', base + '/:' + param, {
      area, label: 'Modifier · ' + label, description: message, body: validator.partial(), example, output
    }, context => access(root, context, 'write', async document => {
      view(document, context.actor);
      const items = select(document, context.params);
      const item = itemById(visibleItems(document, context, items), context.params[param]);
      edit(document, context.actor, item);
      await beforeUpdate(document, items, context, item);
      Object.assign(item, context.data, { updatedAt: new Date().toISOString() });
      return project(item, document);
    }));

    route('DELETE', base + '/:' + param, {
      area, label: 'Supprimer · ' + label, description: message, status: 204
    }, context => access(root, context, 'write', async document => {
      view(document, context.actor);
      const items = select(document, context.params);
      const item = itemById(visibleItems(document, context, items), context.params[param]);
      erase(document, context.actor, item);
      await beforeDelete(document, items, context, item);
      remove(items, item);
    }));
  }

  for (const root of [groupRoot, eventRoot]) {
    const forGroup = root === groupRoot;
    const area = forGroup ? 'Discussions de groupe' : 'Discussions d’événement';
    const view = forGroup ? requireMember : requireParticipant;
    const post = forGroup
      ? (group, actor) => requireCondition(isAdmin(group, actor) || group.membersCanPost,
        403, 'La publication par les membres est désactivée dans ce groupe')
      : participantWrite;
    const ownerOrManagerWrite = ownerOrManager(root.manager, 'authorId');
    const thread = (document, params) => itemById(document.threads, params.threadId);
    const messages = (document, params) => thread(document, params).messages;

    crud(root, {
      area, path: '/threads', param: 'threadId', label: 'Fil de discussion',
      message: 'Chaque fil appartient au groupe ou à l’événement désigné par son URL. L’auteur ou un responsable peut modifier et supprimer le fil.',
      validator: schema.thread, example: { title: 'Organisation de la sortie' }, output: 'thread',
      select: document => document.threads, view, create: post, edit: ownerOrManagerWrite, fields: ['title'],
      project: item => without(item, 'messages'), extra: ({ actor }) => ({ authorId: actor, messages: [] })
    });
    crud(root, {
      area, path: '/threads/:threadId/messages', param: 'messageId', label: 'Message',
      message: 'Un membre autorisé ou un participant publie un message dans le fil. L’auteur ou un responsable peut le gérer.',
      validator: schema.message, example: { body: 'Rendez-vous devant la mairie.' }, output: 'message',
      select: messages, view, create: post, edit: ownerOrManagerWrite, fields: ['body'],
      project: item => without(item, 'comments'), extra: ({ actor }) => ({ authorId: actor, comments: [] })
    });
    crud(root, {
      area, path: '/threads/:threadId/messages/:messageId/comments', param: 'commentId', label: 'Commentaire de message',
      message: 'Chaque membre ou participant peut commenter un message. L’auteur ou un responsable peut modifier et supprimer le commentaire.',
      validator: schema.message, example: { body: 'Merci, je serai à l’heure.' }, output: 'comment',
      select: (document, params) => itemById(messages(document, params), params.messageId).comments,
      view, create: view, edit: ownerOrManagerWrite, fields: ['body'],
      extra: ({ actor }) => ({ authorId: actor })
    });
  }

  const albums = event => event.albums;
  const photos = (event, params) => itemById(albums(event), params.albumId).photos;
  const ownerOrOrganizer = ownerOrManager(isOrganizer, 'authorId');
  const area = 'Albums photo';

  crud(eventRoot, {
    area, path: '/albums', param: 'albumId', label: 'Album',
    message: 'Crée un album rattaché à l’événement. Les participants ont accès à ses photos. L’auteur ou un organisateur peut gérer l’album.',
    validator: schema.album, example: { title: 'Photos sur les quais' }, output: 'album',
    select: albums, view: requireParticipant, create: participantWrite, edit: ownerOrOrganizer, fields: ['title'],
    project: item => without(item, 'photos'), extra: ({ actor }) => ({ authorId: actor, photos: [] })
  });
  crud(eventRoot, {
    area, path: '/albums/:albumId/photos', param: 'photoId', label: 'Photo',
    message: 'Un participant ajoute une photo au moyen d’une URL HTTP(S). L’auteur ou un organisateur peut la gérer.',
    validator: schema.photo, example: { url: 'https://example.com/quais.jpg', caption: 'Le départ' }, output: 'photo',
    select: photos, view: requireParticipant, create: participantWrite, edit: ownerOrOrganizer, fields: ['caption', 'url'],
    project: item => without(item, 'comments'), extra: ({ actor }) => ({ authorId: actor, comments: [] })
  });
  crud(eventRoot, {
    area, path: '/albums/:albumId/photos/:photoId/comments', param: 'commentId', label: 'Commentaire de photo',
    message: 'Les participants peuvent commenter une photo. L’auteur ou un organisateur peut modifier et supprimer le commentaire.',
    validator: schema.message, example: { body: 'Très belle photo !' }, output: 'comment',
    select: (event, params) => itemById(photos(event, params), params.photoId).comments,
    view: requireParticipant, create: participantWrite, edit: ownerOrOrganizer, fields: ['body'],
    extra: ({ actor }) => ({ authorId: actor })
  });

  const polls = event => event.polls;
  crud(eventRoot, {
    area: 'Sondages', path: '/polls', param: 'pollId', label: 'Sondage',
    message: 'Un organisateur gère le sondage. Les participants lisent les questions. Les questions sont figées dès qu’une réponse existe.',
    validator: schema.poll, example: { title: 'Le prochain lieu', questions: [{ prompt: 'Quel lieu ?', choices: ['Paris', 'Versailles'] }] },
    output: 'poll', select: polls, view: requireParticipant, create: organizerWrite, fields: ['title'],
    project: item => ({ ...without(item, 'votes'), responseCount: item.votes.length }),
    extra: ({ actor }) => ({ authorId: actor, votes: [] }),
    beforeUpdate: (_event, _items, { data }, item) => {
      requireCondition(!data.questions || !item.votes.length, 409, 'Impossible de changer les questions après un vote');
    }
  });

  const votePath = eventRoot.path + '/polls/:pollId/answers/me';
  function voteAccess(context, mode, use) {
    return access(eventRoot, context, mode, event => {
      requireParticipant(event, context.actor);
      const poll = itemById(polls(event), context.params.pollId);
      return use(poll, poll.votes.find(vote => vote.userId === context.actor));
    });
  }
  route('GET', votePath, {
    area: 'Sondages', label: 'Lire mes réponses', description: 'Renvoie les choix du participant connecté pour ce sondage.', output: 'vote'
  }, context => voteAccess(context, 'read', (_poll, vote) => {
    requireCondition(vote, 404, 'Tu n’as pas encore répondu');
    return vote;
  }));
  route('PUT', votePath, {
    area: 'Sondages', label: 'Enregistrer mes réponses',
    description: 'Crée ou remplace tes réponses. Le tableau contient un index de choix (à partir de 0) par question, dans leur ordre.',
    body: schema.answers, example: { answers: [0] }, output: 'vote'
  }, context => voteAccess(context, 'write', (poll, previous) => {
    const { answers } = context.data;
    requireCondition(answers.length === poll.questions.length
      && answers.every((index, question) => index < poll.questions[question].choices.length), 400,
    'Choisis exactement une option valide pour chaque question');
    if (previous) remove(poll.votes, previous);
    const vote = { userId: context.actor, answers, updatedAt: new Date().toISOString() };
    poll.votes.push(vote);
    return vote;
  }));
  route('DELETE', votePath, {
    area: 'Sondages', label: 'Supprimer mes réponses', description: 'Retire les réponses du participant connecté.', status: 204
  }, context => voteAccess(context, 'write', (poll, vote) => {
    requireCondition(vote, 404, 'Tu n’as pas encore répondu');
    remove(poll.votes, vote);
  }));

  const ticketArea = 'Billetterie';
  const ticketTypes = event => event.ticketTypes;
  const ticketing = event => requireCondition(event.ticketingEnabled, 404, 'Billetterie désactivée');

  crud(eventRoot, {
    area: ticketArea, path: '/ticket-types', param: 'ticketTypeId', label: 'Type de billet',
    message: 'Renvoie le prix en centimes, le stock total et le stock disponible. Seuls les organisateurs gèrent les types de billets.',
    validator: schema.ticketType, example: { name: 'Standard', amountCents: 1500, quantity: 50 }, output: 'ticketType',
    select: ticketTypes, view: ticketing, create: organizerWrite, fields: ['name'], auth: 'optional',
    project: (type, event) => ({ ...asResource(type), available: availability(event, type) }),
    beforeCreate: (_event, items, { data }) => {
      requireCondition(!duplicate(items, null, 'name', data.name), 409, 'Ce type de billet existe déjà');
    },
    beforeUpdate: (event, items, { data }, item) => {
      const sold = item.quantity - availability(event, item);
      requireCondition(!data.name || !duplicate(items, item, 'name', data.name), 409, 'Ce type de billet existe déjà');
      requireCondition(data.quantity === undefined || data.quantity >= sold, 409, 'Le stock ne peut pas passer sous le nombre de billets réservés');
    },
    beforeDelete: (event, _items, _context, item) => {
      requireCondition(availability(event, item) === item.quantity, 409, 'Ce type a déjà des billets réservés');
    }
  });

  const ticketsPath = eventRoot.path + '/tickets';
  const purchaseExample = {
    ticketTypeId: '{{ticketTypeId}}', firstName: 'Alex', lastName: 'Martin',
    address: { street: '10 rue Exemple', postalCode: '75001', city: 'Paris', country: 'France' }
  };
  const ticketVisible = (event, actor, ticket) => isOrganizer(event, actor) || ticket.buyerId === actor;
  const { ticketTypeId: _ticketTypeId, ...buyerExample } = purchaseExample;

  route('POST', ticketsPath, {
    area: ticketArea, label: 'Réserver un billet',
    description: 'Réserve un billet disponible pour un utilisateur connecté extérieur à l’événement. Un seul billet par personne et par événement. Le prix est enregistré en centimes.',
    output: 'ticket', body: schema.purchase, example: purchaseExample, status: 201
  }, context => access(eventRoot, context, 'write', async event => {
    ticketing(event);
    requireCondition(await eventIsPublic(event), 404, 'Billetterie indisponible');
    requireCondition(!isParticipant(event, context.actor), 403, 'Billetterie réservée aux personnes extérieures à l’événement');
    requireCondition(!event.tickets.some(ticket => ticket.buyerId === context.actor), 409, 'Tu as déjà réservé un billet pour cet événement');
    const type = itemById(ticketTypes(event), context.data.ticketTypeId);
    requireCondition(availability(event, type) > 0, 409, 'Ce type de billet est épuisé');
    const ticket = newRecord({
      ...context.data, buyerId: context.actor, purchasedAt: new Date().toISOString(),
      amountCents: type.amountCents, ticketTypeName: type.name
    });
    event.tickets.push(ticket);
    return asResource(ticket);
  }));

  route('GET', ticketsPath, {
    area: ticketArea, label: 'Lister ou rechercher les billets',
    description: 'Le titulaire voit son billet. Les organisateurs voient tous les billets et peuvent rechercher par nom ou type.',
    output: 'ticket', search: true
  }, context => access(eventRoot, context, 'read', event => {
    ticketing(event);
    const visible = event.tickets.filter(ticket => ticketVisible(event, context.actor, ticket));
    return paginate(visible, context.criteria, ['firstName', 'lastName', 'ticketTypeName'], asResource);
  }));

  function ticketAccess(context, mode, use) {
    return access(eventRoot, context, mode, event => {
      ticketing(event);
      const visible = event.tickets.filter(ticket => ticketVisible(event, context.actor, ticket));
      return use(event, itemById(visible, context.params.ticketId));
    });
  }

  route('GET', ticketsPath + '/:ticketId', {
    area: ticketArea, label: 'Lire un billet', description: 'Renvoie les données d’achat au titulaire ou aux organisateurs.', output: 'ticket'
  }, context => ticketAccess(context, 'read', (_event, ticket) => asResource(ticket)));

  route('PATCH', ticketsPath + '/:ticketId', {
    area: ticketArea, label: 'Modifier les coordonnées du billet',
    description: 'Le titulaire ou un organisateur corrige le nom, le prénom ou l’adresse complète. Le type, le prix d’achat et la date restent ceux de la réservation.',
    body: schema.buyer.partial(), example: buyerExample, output: 'ticket'
  }, context => ticketAccess(context, 'write', (_event, ticket) => {
    Object.assign(ticket, context.data, { updatedAt: new Date().toISOString() });
    return asResource(ticket);
  }));

  route('DELETE', ticketsPath + '/:ticketId', {
    area: ticketArea, label: 'Annuler un billet', description: 'Le titulaire ou un organisateur annule le billet et libère une unité de stock.', status: 204
  }, context => ticketAccess(context, 'write', (event, ticket) => remove(event.tickets, ticket)));

  function shoppingAccess(event, actor) {
    requireParticipant(event, actor);
    requireCondition(event.shoppingEnabled, 404, 'Liste de courses désactivée');
  }
  function uniqueShoppingName(_event, items, { data }, item = null) {
    requireCondition(!data.name || !duplicate(items, item, 'name', data.name), 409, 'Cet objet est déjà prévu pour cet événement');
  }
  crud(eventRoot, {
    area: 'Liste de courses', path: '/shopping-items', param: 'shoppingItemId', label: 'Objet à apporter',
    message: 'Un participant indique le nom, la quantité et l’heure d’arrivée. Le nom est unique par événement, sans distinction de casse.',
    validator: schema.shoppingItem, example: { name: 'Bouteilles d’eau', quantity: 6, arrivalAt: '2027-04-17T10:00:00+02:00' },
    output: 'shopping', select: event => event.shoppingItems, view: shoppingAccess, create: participantWrite,
    edit: ownerOrOrganizer, fields: ['name'], extra: ({ actor }) => ({ authorId: actor }),
    beforeCreate: uniqueShoppingName, beforeUpdate: uniqueShoppingName
  });

  crud(eventRoot, {
    area: 'Covoiturage', path: '/rides', param: 'rideId', label: 'Proposition de trajet',
    message: 'Un participant propose un trajet. Le prix est exprimé en centimes et le détour maximum en minutes.',
    validator: schema.ride, example: {
      departurePlace: 'Gare de Lyon', departureAt: '2027-04-17T08:30:00+02:00', priceCents: 400, seats: 3, maxDetourMinutes: 30
    },
    output: 'ride', select: event => event.rides, view: (event, actor) => {
      requireParticipant(event, actor);
      requireCondition(event.carpoolEnabled, 404, 'Covoiturage désactivé');
    },
    create: participantWrite, edit: ownerOrOrganizer, fields: ['departurePlace'], extra: ({ actor }) => ({ authorId: actor })
  });
}
