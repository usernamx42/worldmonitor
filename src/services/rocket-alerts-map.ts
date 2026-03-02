// Converts OREF rocket alerts into map-displayable markers with coordinates
import { CITY_COORDS } from './rocket-alert-coords';
import type { OrefAlertsResponse } from './oref-alerts';

export interface RocketAlertMarker {
  id: string;
  lat: number;
  lon: number;
  locationName: string;
  alertType: string;
  timestamp: number;
  isActive: boolean;
  countdown: number; // seconds to shelter
}

// Normalize location name for lookup
function normalizeKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function lookupCoords(locationName: string): [number, number] | null {
  const key = normalizeKey(locationName);
  if (CITY_COORDS[key]) return CITY_COORDS[key];

  // Try case-insensitive match for English names
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(CITY_COORDS)) {
    if (k.toLowerCase() === lower) return v;
  }

  // Partial match: location might be "Industrial Zone X" -> try without prefix
  for (const [k, v] of Object.entries(CITY_COORDS)) {
    if (k.includes(key) || key.includes(k)) return v;
  }

  return null;
}

export function orefAlertsToMarkers(response: OrefAlertsResponse): RocketAlertMarker[] {
  if (!response.alerts?.length) return [];

  const markers: RocketAlertMarker[] = [];
  const now = Date.now();

  for (const alert of response.alerts) {
    const timestamp = alert.alertDate ? new Date(alert.alertDate).getTime() : now;
    const isActive = (now - timestamp) < 300_000; // Active within 5 minutes

    for (const location of alert.data) {
      const coords = lookupCoords(location);
      if (!coords) continue;

      markers.push({
        id: `${alert.id}-${location}`,
        lat: coords[0],
        lon: coords[1],
        locationName: location,
        alertType: alert.title || alert.cat || 'Rocket Alert',
        timestamp,
        isActive,
        countdown: 0,
      });
    }
  }

  return markers;
}
