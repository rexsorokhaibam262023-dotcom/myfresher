import type { EventSettings } from './types.js';

export type { EventSettings };

const DEFAULT_TIME = process.env.EVENT_TIME || '5:30 PM Sharp';
const DEFAULT_VENUE = process.env.EVENT_VENUE || 'Pune (MSAP Campus Main Auditorium)';
const parsedPrice = process.env.EVENT_TICKET_PRICE ? Number(process.env.EVENT_TICKET_PRICE) : 350;
const DEFAULT_PRICE = Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : 350;

let cachedSettings: EventSettings = {
  time: DEFAULT_TIME,
  venue: DEFAULT_VENUE,
  registrationPrice: DEFAULT_PRICE,
  updatedAt: new Date(0).toISOString(),
};

export function getCachedEventSettings(): EventSettings {
  return { ...cachedSettings };
}

export function setCachedEventSettings(settings: EventSettings): EventSettings {
  cachedSettings = {
    time: settings.time,
    venue: settings.venue,
    registrationPrice: settings.registrationPrice,
    updatedAt: settings.updatedAt,
  };
  return getCachedEventSettings();
}

export function getDefaultEventSettings(): EventSettings {
  return {
    time: DEFAULT_TIME,
    venue: DEFAULT_VENUE,
    registrationPrice: DEFAULT_PRICE,
    updatedAt: new Date(0).toISOString(),
  };
}
