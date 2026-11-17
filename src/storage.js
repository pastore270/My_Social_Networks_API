import { MongoClient } from 'mongodb';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function requireCondition(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

export async function connect(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db();
    await Promise.all([
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('groups').createIndex({ deletedAt: 1, visibility: 1, createdAt: -1 }),
      db.collection('groups').createIndex({ memberIds: 1 }),
      db.collection('events').createIndex({ status: 1, visibility: 1, groupId: 1, createdAt: -1 }),
      db.collection('events').createIndex({ organizerIds: 1 }),
      db.collection('events').createIndex({ participantIds: 1 })
    ]);
    return { db, client };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function read(collection, id) {
  const record = await collection.findOne({ _id: id, deletedAt: null });
  requireCondition(record, 404, 'Ressource introuvable');
  return record;
}

// Une version protège chaque événement ou groupe et ses sous-ressources.
// Les règles de stock et d’unicité sont réévaluées à chaque conflit d’écriture.
export async function change(collection, id, apply) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const record = await read(collection, id);
    const version = record.version;
    record.updatedAt = new Date().toISOString();
    const result = await apply(record);
    record.version += 1;
    const written = await collection.replaceOne({ _id: id, version }, record);
    if (written.modifiedCount) return result;
  }
  throw new HttpError(409, 'Modification concurrente. Réessaie la requête.');
}

export function asResource(record) {
  const { _id, version, deletedAt, ...fields } = record;
  return { id: _id, ...fields };
}

export function searchFilter(query, fields) {
  if (!query) return {};
  const expression = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $or: fields.map(field => ({ [field]: { $regex: expression, $options: 'i' } })) };
}

export async function list(collection, filter, criteria, fields, project, projection) {
  const predicate = { $and: [filter, searchFilter(criteria.q, fields)] };
  const skip = (criteria.page - 1) * criteria.limit;
  const [documents, total] = await Promise.all([
    collection.find(predicate, { projection }).sort({ createdAt: -1, _id: 1 }).skip(skip).limit(criteria.limit).toArray(),
    collection.countDocuments(predicate)
  ]);
  return { items: documents.map(project), page: criteria.page, limit: criteria.limit, total };
}
