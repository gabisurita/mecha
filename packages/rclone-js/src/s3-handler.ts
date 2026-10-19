import type { BlobStorage } from './types.js'
import { TraversalError } from './types.js'

// --- XML helpers ---

function buildListXml(bucket: string, prefix: string, items: Array<{ key: string; size: number }>): string {
  const contents = items
    .map(
      ({ key, size }) =>
        `  <Contents><Key>${escapeXml(key)}</Key><Size>${size}</Size></Contents>`,
    )
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Name>${escapeXml(bucket)}</Name>`,
    `  <Prefix>${escapeXml(prefix)}</Prefix>`,
    `  <KeyCount>${items.length}</KeyCount>`,
    `  <MaxKeys>1000</MaxKeys>`,
    `  <IsTruncated>false</IsTruncated>`,
    contents,
    `</ListBucketResult>`,
  ].join('\n')
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || size <= 0) return null
  const [, startStr, endStr] = match
  if (!startStr && !endStr) return null
  if (!startStr) {
    const suffix = Number(endStr)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startStr)
  if (!Number.isFinite(start) || start < 0 || start >= size) return null
  if (!endStr) {
    return { start, end: size - 1 }
  }
  const rawEnd = Number(endStr)
  if (!Number.isFinite(rawEnd) || rawEnd < start) return null
  return { start, end: Math.min(rawEnd, size - 1) }
}

// --- Handler factory ---

/**
 * Creates an S3-compatible subset request handler from any BlobStorage backend.
 *
 * Supported operations:
 *   PUT    /{bucket}/{key}                — store object
 *   GET    /{bucket}/{key}                — retrieve object (full or Range)
 *   HEAD   /{bucket}/{key}                — object metadata
 *   DELETE /{bucket}/{key}                — remove object
 *   GET    /{bucket}?list-type=2[&prefix] — list objects (ListObjectsV2)
 *
 * Browser-safe — no Node.js dependencies.
 */
export function makeS3Handler(storage: BlobStorage): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url)
      const segments = url.pathname.split('/').filter(Boolean)
      const bucket = segments[0]

      if (!bucket) {
        return new Response('Bad Request: missing bucket', { status: 400 })
      }

      const key = segments.slice(1).join('/')
      const method = req.method.toUpperCase()

      // LIST — GET on bucket root with list-type=2
      if (method === 'GET' && !key && url.searchParams.has('list-type')) {
        const prefix = url.searchParams.get('prefix') ?? ''
        const items = await storage.list(bucket, prefix)
        const xml = buildListXml(bucket, prefix, items)
        return new Response(xml, {
          status: 200,
          headers: { 'Content-Type': 'application/xml' },
        })
      }

      if (!key) {
        return new Response('Bad Request: missing object key', { status: 400 })
      }

      switch (method) {
        case 'PUT': {
          const contentType = req.headers.get('Content-Type') ?? 'application/octet-stream'
          const data = await req.arrayBuffer()
          await storage.write(bucket, key, data, contentType)
          return new Response(null, { status: 200 })
        }

        case 'GET': {
          const rangeHeader = req.headers.get('Range')
          if (rangeHeader) {
            const meta = await storage.head(bucket, key)
            if (!meta) return new Response('Not Found', { status: 404 })
            const range = parseByteRange(rangeHeader, meta.size)
            if (!range) {
              return new Response('Range Not Satisfiable', {
                status: 416,
                headers: { 'Content-Range': `bytes */${meta.size}` },
              })
            }
            const { start, end } = range
            let sliceData: ArrayBuffer
            let contentType = meta.contentType
            let totalSize = meta.size
            if (storage.readRange) {
              const ranged = await storage.readRange(bucket, key, start, end)
              if (!ranged) return new Response('Not Found', { status: 404 })
              sliceData = ranged.data
              contentType = ranged.contentType
              totalSize = ranged.totalSize
            } else {
              const obj = await storage.read(bucket, key)
              if (!obj) return new Response('Not Found', { status: 404 })
              sliceData = obj.data.slice(start, end + 1)
              contentType = obj.contentType
              totalSize = obj.data.byteLength
            }
            return new Response(sliceData, {
              status: 206,
              headers: {
                'Content-Type': contentType,
                'Content-Length': String(sliceData.byteLength),
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                'Accept-Ranges': 'bytes',
              },
            })
          }

          const obj = await storage.read(bucket, key)
          if (!obj) return new Response('Not Found', { status: 404 })
          return new Response(obj.data, {
            status: 200,
            headers: {
              'Content-Type': obj.contentType,
              'Content-Length': String(obj.data.byteLength),
              'Accept-Ranges': 'bytes',
            },
          })
        }

        case 'HEAD': {
          const meta = await storage.head(bucket, key)
          if (!meta) return new Response(null, { status: 404 })
          return new Response(null, {
            status: 200,
            headers: {
              'Content-Type': meta.contentType,
              'Content-Length': String(meta.size),
              'Accept-Ranges': 'bytes',
            },
          })
        }

        case 'DELETE': {
          await storage.delete(bucket, key)
          return new Response(null, { status: 204 })
        }

        default:
          return new Response(`Method ${req.method} not allowed`, { status: 405 })
      }
    } catch (err) {
      if (err instanceof TraversalError) {
        return new Response(err.message, { status: 400 })
      }
      const message = err instanceof Error ? err.message : String(err)
      return new Response(`Internal Server Error: ${message}`, { status: 500 })
    }
  }
}
