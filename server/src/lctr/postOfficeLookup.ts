export interface LctrPostOfficeLocation {
  sourceId: string;
  name: string;
  address: string;
  phone?: string;
  suburb?: string;
  postcode?: string;
  state?: string;
  latitude: number;
  longitude: number;
  hours?: string;
}

interface LctrRetailOutlet {
  id?: unknown;
  brand?: unknown;
  sub_brand?: unknown;
  name?: unknown;
  address1?: unknown;
  address2?: unknown;
  suburb?: unknown;
  postcode?: unknown;
  state?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  phone?: unknown;
  hours_raw?: unknown;
}

interface LctrResponse {
  ok?: boolean;
  data?: LctrRetailOutlet[];
}

interface PostcodeLookupRow {
  postcode: string;
  suburb: string;
  state: string;
}

const lctrBaseUrl = process.env.LCTR_API_BASE_URL ?? "https://api.lctr.app";
const postcodeLookupUrl = process.env.POSTCODE_LOOKUP_URL
  ?? "https://raw.githubusercontent.com/schappim/australian-postcodes/master/data/lookup/postcodes-lookup.csv";
const states = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"];
const cacheTtlMs = 1000 * 60 * 30;
let cachedAt = 0;
let cachedLocations: LctrPostOfficeLocation[] = [];
let cachedPostcodeRows: PostcodeLookupRow[] = [];
let cachedPostcodesAt = 0;

export async function searchLctrPostOffices(query: string, state?: string): Promise<LctrPostOfficeLocation[]> {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length < 2) return [];

  if (/^\d{4}$/.test(normalizedQuery)) {
    return rankedLocations(await fetchPostcode(normalizedQuery), normalizedQuery);
  }

  const postcodeLocations = await fetchSuburbPostcodeLocations(query);
  const postcodeMatches = rankedLocations(postcodeLocations, normalizedQuery);
  if (postcodeMatches.length > 0) return postcodeMatches;

  const suburbLocations = await fetchSuburb(query);
  const suburbMatches = rankedLocations(suburbLocations, normalizedQuery);
  if (suburbMatches.length > 0) return suburbMatches;

  return rankedLocations(await loadAustraliaPostLocations(state), normalizedQuery);
}

export function rankedLocations(locations: LctrPostOfficeLocation[], normalizedQuery: string) {
  const suburbAnchors = locations.filter((location) => normalize(location.suburb) === normalizedQuery);

  return locations
    .map((location) => ({ location, score: scoreLocation(location, normalizedQuery, suburbAnchors) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.location.name.localeCompare(b.location.name))
    .slice(0, 20)
    .map((result) => result.location);
}

export async function fetchAllLctrPostOffices(): Promise<LctrPostOfficeLocation[]> {
  return fetchBrand();
}

async function loadAustraliaPostLocations(state?: string): Promise<LctrPostOfficeLocation[]> {
  if (!state && cachedLocations.length > 0 && Date.now() - cachedAt < cacheTtlMs) {
    return cachedLocations;
  }

  const selectedStates = state ? [state.toUpperCase()] : states;
  const allRows = (await Promise.all(selectedStates.map(fetchState))).flat();
  const deduped = dedupeLocations(allRows);

  if (!state) {
    cachedLocations = deduped;
    cachedAt = Date.now();
  }

  return deduped;
}

async function fetchBrand(): Promise<LctrPostOfficeLocation[]> {
  const pageSize = 500;
  const pages = 100;
  const locations: LctrPostOfficeLocation[] = [];

  for (let page = 0; page < pages; page += 1) {
    const url = new URL("/retail-outlets.php", lctrBaseUrl);
    url.searchParams.set("brand", "Australia Post");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));

    const response = await fetch(url);
    if (!response.ok) throw new Error("LCTR post office lookup failed.");
    const payload = await response.json() as LctrResponse;
    const rows = payload.data ?? [];
    locations.push(...rows.map(mapOutlet).filter((location): location is LctrPostOfficeLocation => location !== null));
    if (rows.length < pageSize) break;
  }

  return dedupeLocations(locations);
}

async function fetchSuburbPostcodeLocations(query: string) {
  const postcodes = await postcodesForSuburb(query);
  if (postcodes.length === 0) return [];
  return dedupeLocations((await Promise.all(postcodes.slice(0, 8).map(fetchPostcode))).flat());
}

async function fetchPostcode(postcode: string): Promise<LctrPostOfficeLocation[]> {
  const url = new URL("/retail-outlets.php", lctrBaseUrl);
  url.searchParams.set("brand", "Australia Post");
  url.searchParams.set("postcode", postcode);
  url.searchParams.set("limit", "500");
  url.searchParams.set("offset", "0");

  const response = await fetch(url);
  if (!response.ok) throw new Error("LCTR post office lookup failed.");
  const payload = await response.json() as LctrResponse;
  return dedupeLocations((payload.data ?? []).map(mapOutlet).filter((location): location is LctrPostOfficeLocation => location !== null));
}

async function postcodesForSuburb(query: string) {
  const normalizedQuery = normalize(query);
  const rows = await loadPostcodeLookup();
  return [
    ...new Set(
      rows
        .filter((row) => normalize(row.suburb) === normalizedQuery)
        .map((row) => row.postcode)
    )
  ];
}

async function loadPostcodeLookup() {
  if (cachedPostcodeRows.length > 0 && Date.now() - cachedPostcodesAt < cacheTtlMs) {
    return cachedPostcodeRows;
  }

  const response = await fetch(postcodeLookupUrl);
  if (!response.ok) throw new Error("Postcode lookup failed.");
  const csv = await response.text();
  cachedPostcodeRows = csv
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(","))
    .filter((parts) => parts.length >= 3)
    .map(([postcode, suburb, state]) => ({
      postcode: postcode.trim(),
      suburb: suburb.trim(),
      state: state.trim()
    }))
    .filter((row) => row.postcode && row.suburb && row.state);
  cachedPostcodesAt = Date.now();
  return cachedPostcodeRows;
}

async function fetchSuburb(suburb: string): Promise<LctrPostOfficeLocation[]> {
  const url = new URL("/retail-outlets.php", lctrBaseUrl);
  url.searchParams.set("brand", "Australia Post");
  url.searchParams.set("suburb", suburb);
  url.searchParams.set("limit", "500");
  url.searchParams.set("offset", "0");

  const response = await fetch(url);
  if (!response.ok) throw new Error("LCTR post office lookup failed.");
  const payload = await response.json() as LctrResponse;
  return dedupeLocations((payload.data ?? []).map(mapOutlet).filter((location): location is LctrPostOfficeLocation => location !== null));
}

async function fetchState(state: string): Promise<LctrPostOfficeLocation[]> {
  const pageSize = 500;
  const pages = 20;
  const locations: LctrPostOfficeLocation[] = [];

  for (let page = 0; page < pages; page += 1) {
    const url = new URL("/retail-outlets.php", lctrBaseUrl);
    url.searchParams.set("brand", "Australia Post");
    url.searchParams.set("state", state);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));

    const response = await fetch(url);
    if (!response.ok) throw new Error("LCTR post office lookup failed.");
    const payload = await response.json() as LctrResponse;
    const rows = payload.data ?? [];
    locations.push(...rows.map(mapOutlet).filter((location): location is LctrPostOfficeLocation => location !== null));
    if (rows.length < pageSize) break;
  }

  return locations;
}

function mapOutlet(row: LctrRetailOutlet): LctrPostOfficeLocation | null {
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  const name = stringValue(row.name);
  if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const addressParts = [
    stringValue(row.address1),
    stringValue(row.address2),
    stringValue(row.suburb),
    stringValue(row.state),
    stringValue(row.postcode)
  ].filter(Boolean);
  const address = addressParts.join(", ");
  if (!address) return null;

  return {
    sourceId: stringValue(row.id) || `${name}-${latitude}-${longitude}`,
    name,
    address,
    phone: stringValue(row.phone),
    suburb: stringValue(row.suburb),
    postcode: stringValue(row.postcode),
    state: stringValue(row.state),
    latitude,
    longitude,
    hours: stringValue(row.hours_raw)
  };
}

function dedupeLocations(locations: LctrPostOfficeLocation[]) {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = [
      normalize(location.name),
      normalize(location.address),
      location.latitude.toFixed(6),
      location.longitude.toFixed(6)
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreLocation(location: LctrPostOfficeLocation, query: string, suburbAnchors: LctrPostOfficeLocation[] = []) {
  const postcode = normalize(location.postcode);
  const suburb = normalize(location.suburb);
  const name = normalize(location.name);
  const address = normalize(location.address);

  if (postcode === query) return 100;
  if (suburb === query) return 95;
  if (name === query) return 90;
  if (postcode.startsWith(query)) return 80;
  if (suburb.startsWith(query)) return 78;
  if (name.startsWith(query)) return 76;
  if (startsWithWord(name, query)) return 72;
  if (startsWithWord(suburb, query)) return 70;
  if (name.includes(query)) return 65;
  if (suburb.includes(query)) return 60;
  if (address.includes(query)) return 50;
  const nearestAnchorKm = nearestDistanceKm(location, suburbAnchors);
  if (nearestAnchorKm !== undefined && nearestAnchorKm <= 15) return Math.max(1, 45 - nearestAnchorKm);
  return 0;
}

function startsWithWord(value: string, query: string) {
  return value.split(/\s+/).some((part) => part.startsWith(query));
}

function nearestDistanceKm(location: LctrPostOfficeLocation, anchors: LctrPostOfficeLocation[]) {
  if (anchors.length === 0) return undefined;
  return Math.min(...anchors.map((anchor) => distanceKm(location, anchor)));
}

function distanceKm(a: LctrPostOfficeLocation, b: LctrPostOfficeLocation) {
  const earthRadiusKm = 6371;
  const latA = toRadians(a.latitude);
  const latB = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function toRadians(value: number) {
  return value * Math.PI / 180;
}

function normalize(value?: string) {
  return (value ?? "").trim().toLowerCase();
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
