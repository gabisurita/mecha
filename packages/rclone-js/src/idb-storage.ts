import type { BlobStorage } from './types.js'

/**
 * IndexedDB-backed BlobStorage for browser environments.
 * Each object is stored as { data: ArrayBuffer, contentType: string }.
 */
export function createIdbBlobStorage(dbName = 'mecha-blobs'): BlobStorage {
  const STORE_NAME = 'objects'

  function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  let dbPromise: Promise<IDBDatabase> | null = null
  function getDB(): Promise<IDBDatabase> {
    if (!dbPromise) dbPromise = openDB()
    return dbPromise
  }

  function storeKey(bucket: string, key: string): string {
    return `${bucket}/${key}`
  }

  type StoredObject = {
    blob?: Blob
    data?: ArrayBuffer
    size?: number
    contentType: string
  }

  function idbGet(db: IDBDatabase, key: string): Promise<StoredObject | undefined> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => resolve(req.result as StoredObject | undefined)
      req.onerror = () => reject(req.error)
    })
  }

  function idbPut(db: IDBDatabase, key: string, value: StoredObject): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const req = tx.objectStore(STORE_NAME).put(value, key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  function idbDelete(db: IDBDatabase, key: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const req = tx.objectStore(STORE_NAME).delete(key)
      req.onsuccess = () => resolve(true)
      req.onerror = () => reject(req.error)
    })
  }

  function idbGetAllKeys(db: IDBDatabase): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAllKeys()
      req.onsuccess = () => resolve(req.result as string[])
      req.onerror = () => reject(req.error)
    })
  }

  function entrySize(entry: StoredObject): number {
    return entry.size ?? entry.blob?.size ?? entry.data?.byteLength ?? 0
  }

  return {
    async read(bucket, key) {
      const db = await getDB()
      const entry = await idbGet(db, storeKey(bucket, key))
      if (!entry) return null
      const data = entry.blob ? await entry.blob.arrayBuffer() : entry.data!
      return { data, contentType: entry.contentType }
    },

    async readRange(bucket, key, start, end) {
      const db = await getDB()
      const entry = await idbGet(db, storeKey(bucket, key))
      if (!entry) return null
      const totalSize = entrySize(entry)
      const data = entry.blob
        ? await entry.blob.slice(start, end + 1).arrayBuffer()
        : entry.data!.slice(start, end + 1)
      return { data, contentType: entry.contentType, totalSize }
    },

    async write(bucket, key, data, contentType) {
      const db = await getDB()
      const blob = new Blob([data], { type: contentType })
      await idbPut(db, storeKey(bucket, key), { blob, size: data.byteLength, contentType })
    },

    async delete(bucket, key) {
      const db = await getDB()
      return idbDelete(db, storeKey(bucket, key))
    },

    async head(bucket, key) {
      const db = await getDB()
      const entry = await idbGet(db, storeKey(bucket, key))
      if (!entry) return null
      return { size: entrySize(entry), contentType: entry.contentType }
    },

    async list(bucket, prefix) {
      const db = await getDB()
      const allKeys = await idbGetAllKeys(db)
      const bucketPrefix = `${bucket}/${prefix}`
      return allKeys
        .filter((k) => k.startsWith(bucketPrefix))
        .map((k) => ({ key: k.slice(`${bucket}/`.length), size: 0 }))
    },
  }
}
