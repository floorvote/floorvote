import { describe, it, expect } from 'vitest'
import { presignUrl } from '../../src/lib/presign'

describe('presignUrl', () => {
  // The worked example in AWS's "Authenticating Requests: Using Query
  // Parameters" (Signature Version 4) guide.
  it('matches the AWS SigV4 query-signing example', async () => {
    const url = await presignUrl({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
      expiresSeconds: 86400,
      headers: {},
    })
    const u = new URL(url)
    expect(u.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request')
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(u.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
  })

  it('signs the headers it is given, so the upload must send them unchanged', async () => {
    const url = await presignUrl({
      method: 'PUT',
      url: 'https://acct.r2.cloudflarestorage.com/bucket/inst/abc',
      region: 'auto',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      date: new Date('2026-10-19T12:00:00Z'),
      expiresSeconds: 600,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': '1234' },
    })
    const u = new URL(url)
    expect(u.pathname).toBe('/bucket/inst/abc')
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
    expect(u.searchParams.get('X-Amz-Expires')).toBe('600')
  })
})
