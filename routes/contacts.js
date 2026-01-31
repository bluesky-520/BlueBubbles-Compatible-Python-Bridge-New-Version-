import express from 'express';
import swiftDaemon from '../services/swift-daemon.js';
import { optionalAuthenticateToken } from '../middleware/auth.js';
import logger from '../config/logger.js';
import { sendSuccess, sendError } from '../utils/envelope.js';

const router = express.Router();

const CONTACTS_CACHE_TTL_MS = 60 * 1000;
let contactsCache = [];
let contactsCacheAt = 0;

/** Invalidate contacts cache so next request refetches from daemon (e.g. after contacts_updated from SSE). */
export function invalidateContactsCache() {
  contactsCache = [];
  contactsCacheAt = 0;
}

const getContactsCached = async (opts = {}) => {
  const { limit, offset, extraProperties } = opts;
  const now = Date.now();
  if (contactsCache.length > 0 && now - contactsCacheAt < CONTACTS_CACHE_TTL_MS && limit == null && offset == null) {
    return contactsCache;
  }

  const contacts = await swiftDaemon.getContacts({ limit, offset, extraProperties });
  if (limit == null && offset == null) {
    contactsCache = contacts || [];
    contactsCacheAt = now;
  }
  return contacts || [];
};

const normalizeExtraProperties = (input) => {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map(String).map(v => v.trim()).filter(Boolean);
  }
  return String(input)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
};

const shouldIncludeAvatar = (extraProps) => {
  const lower = extraProps.map(v => v.toLowerCase());
  return (
    lower.includes('avatar') ||
    lower.includes('contactimage') ||
    lower.includes('contactthumbnailimage')
  );
};

const dedupeByAddress = (items) => {
  const seen = new Set();
  return items.filter(item => {
    if (!item.address) return false;
    if (seen.has(item.address)) return false;
    seen.add(item.address);
    return true;
  });
};

const extractEmails = (contact) => {
  const raw = []
    .concat(contact.emails || [])
    .concat(contact.emailAddresses || [])
    .concat(contact.addresses || []);
  const normalized = raw
    .map(value => {
      const address =
        typeof value === 'string'
          ? value
          : value?.address || value?.value || value?.email || null;
      return { address: address ? String(address) : null, id: value?.id || value?.identifier || null };
    })
    .filter(entry => entry.address && entry.address.includes('@'));

  return dedupeByAddress(normalized);
};

const extractPhoneNumbers = (contact) => {
  const raw = []
    .concat(contact.phones || [])
    .concat(contact.phoneNumbers || [])
    .concat(contact.addresses || []);
  const normalized = raw
    .map(value => {
      const address =
        typeof value === 'string'
          ? value
          : value?.address || value?.value || value?.phone || value?.number || null;
      return { address: address ? String(address) : null, id: value?.id || value?.identifier || null };
    })
    .filter(entry => entry.address && !entry.address.includes('@'));

  return dedupeByAddress(normalized);
};

const mapContact = (contact, includeAvatar) => {
  const phoneNumbers = extractPhoneNumbers(contact);
  const emails = extractEmails(contact);
  const firstName = contact.firstName ?? contact.first_name ?? null;
  const lastName = contact.lastName ?? contact.last_name ?? null;

  const displayName =
    (contact.displayName ?? contact.display_name) ||
    [firstName, lastName]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    phoneNumbers[0]?.address ||
    'Unknown';

  return {
    phoneNumbers,
    emails,
    firstName,
    lastName,
    displayName,
    nickname: contact.nickname ?? null,
    birthday: contact.birthday ?? null,
    avatar: includeAvatar ? (contact.avatar ?? '') : '',
    sourceType: contact.sourceType ?? 'api',
    id: contact.id
  };
};

const mapContacts = (contacts, extraProps) => {
  const includeAvatar = shouldIncludeAvatar(extraProps);
  return contacts.map(contact => mapContact(contact, includeAvatar));
};

const filterByAddresses = (contacts, addresses) => {
  const addressSet = new Set(addresses.map(String));
  return contacts.filter(contact => {
    const phones = Array.isArray(contact.phoneNumbers) ? contact.phoneNumbers : [];
    const emails = Array.isArray(contact.emails) ? contact.emails : [];
    return (
      phones.some(p => addressSet.has(p.address)) ||
      emails.some(e => addressSet.has(e.address))
    );
  });
};

/**
 * GET /api/v1/contacts
 * Returns all contacts
 */
router.get('/api/v1/contacts', optionalAuthenticateToken, async (req, res) => {
  try {
    const extraProps = normalizeExtraProperties(req.query?.extraProperties);
    const limit = req.query?.limit != null ? parseInt(req.query.limit, 10) : null;
    const offset = req.query?.offset != null ? parseInt(req.query.offset, 10) : null;
    const contacts = await getContactsCached({ limit, offset, extraProperties: extraProps });
    sendSuccess(res, mapContacts(contacts, extraProps));
  } catch (error) {
    logger.error(`Get contacts error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * GET /api/v1/contact
 * Alias for BlueBubbles clients expecting singular endpoint
 */
router.get('/api/v1/contact', optionalAuthenticateToken, async (req, res) => {
  try {
    const extraProps = normalizeExtraProperties(req.query?.extraProperties);
    const limit = req.query?.limit != null ? parseInt(req.query.limit, 10) : null;
    const offset = req.query?.offset != null ? parseInt(req.query.offset, 10) : null;
    const contacts = await getContactsCached({ limit, offset, extraProperties: extraProps });
    sendSuccess(res, mapContacts(contacts, extraProps));
  } catch (error) {
    logger.error(`Get contact error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * POST /api/v1/contacts/query
 * Query contacts by addresses (phone/email)
 * Body: { addresses: string[] }
 */
router.post('/api/v1/contacts/query', optionalAuthenticateToken, async (req, res) => {
  try {
    const { addresses = [], extraProperties = [] } = req.body || {};
    const extraProps = normalizeExtraProperties(extraProperties);
    const contacts = mapContacts(await getContactsCached({}), extraProps);

    if (!Array.isArray(addresses) || addresses.length === 0) {
      return sendSuccess(res, contacts);
    }

    sendSuccess(res, filterByAddresses(contacts, addresses));
  } catch (error) {
    logger.error(`Query contacts error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * POST /api/v1/contact/query
 * Alias for BlueBubbles clients expecting singular endpoint
 */
router.post('/api/v1/contact/query', optionalAuthenticateToken, async (req, res) => {
  try {
    const { addresses = [], extraProperties = [] } = req.body || {};
    const extraProps = normalizeExtraProperties(extraProperties);
    const contacts = mapContacts(await getContactsCached({}), extraProps);

    if (!Array.isArray(addresses) || addresses.length === 0) {
      return sendSuccess(res, contacts);
    }

    sendSuccess(res, filterByAddresses(contacts, addresses));
  } catch (error) {
    logger.error(`Query contact error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

/**
 * GET /api/v1/contacts/vcf
 * Returns contacts as vCard
 */
router.get('/api/v1/contacts/vcf', optionalAuthenticateToken, async (req, res) => {
  try {
    const vcf = await swiftDaemon.getContactsVcf();
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.send(vcf);
  } catch (error) {
    logger.error(`Get contacts vCard error: ${error.message}`);
    sendError(res, 500, error.message);
  }
});

export default router;
