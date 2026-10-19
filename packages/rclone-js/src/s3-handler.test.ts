import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createS3Handler } from './fs-storage.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('createS3Handler', () => {
  let handler: (req: Request) => Promise<Response>
  let tempDir: string

  beforeAll(async () => {
    // Use a temp directory as the storage root (simulates OPFS in Node.js)
    tempDir = await mkdtemp(join(tmpdir(), 'mecha-s3-'))
    handler = createS3Handler({ rootDir: tempDir })
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('handles PUT (store object)', async () => {
    const req = new Request('http://localhost/my-bucket/test.txt', {
      method: 'PUT',
      body: 'hello world',
      headers: { 'Content-Type': 'text/plain' },
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
  })

  it('handles GET (retrieve object)', async () => {
    const req = new Request('http://localhost/my-bucket/test.txt', {
      method: 'GET',
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe('hello world')
  })

  it('handles HEAD (metadata)', async () => {
    const req = new Request('http://localhost/my-bucket/test.txt', {
      method: 'HEAD',
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
    expect(Number(res.headers.get('Content-Length'))).toBeGreaterThan(0)
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
  })

  it('handles GET with Range header (partial content and 416)', async () => {
    const r1 = await handler(new Request('http://localhost/my-bucket/test.txt', {
      method: 'GET',
      headers: { Range: 'bytes=0-4' },
    }))
    expect(r1.status).toBe(206)
    expect(r1.headers.get('Content-Range')).toBe('bytes 0-4/11')
    expect(r1.headers.get('Content-Length')).toBe('5')
    expect(await r1.text()).toBe('hello')

    const r2 = await handler(new Request('http://localhost/my-bucket/test.txt', {
      method: 'GET',
      headers: { Range: 'bytes=6-' },
    }))
    expect(r2.status).toBe(206)
    expect(r2.headers.get('Content-Range')).toBe('bytes 6-10/11')
    expect(await r2.text()).toBe('world')

    const r3 = await handler(new Request('http://localhost/my-bucket/test.txt', {
      method: 'GET',
      headers: { Range: 'bytes=-5' },
    }))
    expect(r3.status).toBe(206)
    expect(r3.headers.get('Content-Range')).toBe('bytes 6-10/11')
    expect(await r3.text()).toBe('world')

    const r4 = await handler(new Request('http://localhost/my-bucket/test.txt', {
      method: 'GET',
      headers: { Range: 'bytes=20-30' },
    }))
    expect(r4.status).toBe(416)
    expect(r4.headers.get('Content-Range')).toBe('bytes */11')
  })

  it('handles GET on missing object (404)', async () => {
    const req = new Request('http://localhost/my-bucket/nonexistent.txt', {
      method: 'GET',
    })
    const res = await handler(req)
    expect(res.status).toBe(404)
  })

  it('handles PUT with binary data', async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG header bytes
    const req = new Request('http://localhost/my-bucket/image.png', {
      method: 'PUT',
      body: data,
      headers: { 'Content-Type': 'image/png' },
    })
    const res = await handler(req)
    expect(res.status).toBe(200)

    // Verify round-trip
    const getReq = new Request('http://localhost/my-bucket/image.png', { method: 'GET' })
    const getRes = await handler(getReq)
    const retrieved = new Uint8Array(await getRes.arrayBuffer())
    expect(retrieved).toEqual(data)
  })

  it('handles nested keys (subdirectories)', async () => {
    const req = new Request('http://localhost/my-bucket/photos/2026/vacation.jpg', {
      method: 'PUT',
      body: 'fake-image-data',
      headers: { 'Content-Type': 'image/jpeg' },
    })
    const res = await handler(req)
    expect(res.status).toBe(200)

    const getReq = new Request('http://localhost/my-bucket/photos/2026/vacation.jpg', { method: 'GET' })
    const getRes = await handler(getReq)
    expect(getRes.status).toBe(200)
    expect(await getRes.text()).toBe('fake-image-data')
  })

  it('handles LIST (list objects with prefix)', async () => {
    const req = new Request('http://localhost/my-bucket?list-type=2&prefix=photos/', {
      method: 'GET',
    })
    const res = await handler(req)
    expect(res.status).toBe(200)

    const body = await res.text()
    // S3 ListObjectsV2 returns XML
    expect(body).toContain('<ListBucketResult')
    expect(body).toContain('photos/2026/vacation.jpg')
  })

  it('handles LIST on empty prefix', async () => {
    const req = new Request('http://localhost/my-bucket?list-type=2', {
      method: 'GET',
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('test.txt')
    expect(body).toContain('image.png')
  })

  it('handles DELETE', async () => {
    const req = new Request('http://localhost/my-bucket/test.txt', {
      method: 'DELETE',
    })
    const res = await handler(req)
    expect(res.status).toBe(204)

    // Verify deleted
    const getReq = new Request('http://localhost/my-bucket/test.txt', { method: 'GET' })
    const getRes = await handler(getReq)
    expect(getRes.status).toBe(404)
  })

  it('rejects path traversal attempts', async () => {
    // Percent-encoded slashes preserve the '..' through URL parsing to test handler rejection.
    const req = new Request('http://localhost/my-bucket/..%2F..%2F..%2Fetc%2Fpasswd', {
      method: 'GET',
    })
    const res = await handler(req)
    expect([400, 404]).toContain(res.status)
  })
})
