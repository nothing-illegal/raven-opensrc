export type Flight = {
  id: string; name: string; droneModel: string; flightDate: string; durationMinutes?: number;
  notes: string; createdAt: string;
};
export type MediaRecord = {
  id: string; flightId?: string; filename: string; mimeType: string; sizeBytes: number;
  capturedAt?: string; latitude?: number; longitude?: number; altitudeMeters?: number; notes: string; blob: Blob;
};
const DB_NAME = 'fieldnote-flight-log';
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | undefined;
function db() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('flights')) database.createObjectStore('flights', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('media')) database.createObjectStore('media', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
  });
  return dbPromise;
}
async function request<T>(store: string, mode: IDBTransactionMode, action: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, mode);
    const req = action(transaction.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Local storage request failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction failed.'));
  });
}
export const listFlights = () => request<Flight[]>('flights', 'readonly', s => s.getAll());
export const listMedia = () => request<MediaRecord[]>('media', 'readonly', s => s.getAll());
export const saveFlight = (flight: Flight) => request<IDBValidKey>('flights', 'readwrite', s => s.put(flight));
export const saveMedia = (media: MediaRecord) => request<IDBValidKey>('media', 'readwrite', s => s.put(media));
export const removeFlight = (id: string) => request<undefined>('flights', 'readwrite', s => s.delete(id));
export const removeMedia = (id: string) => request<undefined>('media', 'readwrite', s => s.delete(id));
export async function replaceAll(flights: Flight[], media: MediaRecord[]) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['flights', 'media'], 'readwrite');
    const f = tx.objectStore('flights'); f.clear(); flights.forEach(row => f.put(row));
    const m = tx.objectStore('media'); m.clear(); media.forEach(row => m.put(row));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not restore backup.'));
    tx.onabort = () => reject(tx.error ?? new Error('Could not restore backup.'));
  });
}
export function newId() { return crypto.randomUUID(); }
