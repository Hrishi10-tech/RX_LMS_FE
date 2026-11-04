import { test, expect, APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { ACCOUNTS } from './helpers/auth';
import { sql, sqlValue, lit, userFixtureIds, createInventoryItemFixture, dropFixtures, countUploadedFixtures, deleteUploadedFixtures } from './helpers/db';

/**
 * Uploaded files go to the configured store (S3 in production) and come back
 * byte for byte. Runs against whichever store the sandbox backend is using;
 * with STORAGE_PROVIDER=s3 it also proves nothing was written to the server's
 * disk, which is the whole point — that disk does not survive a deploy.
 */

const API = 'http://localhost:3001/api';

// A real 1×1 PNG — the upload routes check the bytes, not just the name.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478da63f8ffff3f0005fe02fea7d6a4b60000000049454e44ae426082',
  'hex',
);

const tokenFor = async (request: APIRequestContext, email: string) => {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: 'password123' } });
  const body = await res.json();
  return (body.accessToken ?? body.data?.accessToken) as string;
};

const storageMode = () => {
  try { return execFileSync('docker', ['exec', 'lms-ui-backend', 'printenv', 'STORAGE_PROVIDER'], { encoding: 'utf8' }).trim() || 'local'; }
  catch { return 'local'; }
};
const onServerDisk = (stored: string) => {
  try { execFileSync('docker', ['exec', 'lms-ui-backend', 'test', '-f', `/app/${stored}`]); return true; } catch { return false; }
};

test.describe('file storage', () => {
  test.afterEach(() => dropFixtures());

  test('a request photo is stored and read back byte for byte', async ({ request }) => {
    const suffix = `e2e-store-${Date.now()}.png`;
    const me = userFixtureIds(ACCOUNTS.user);
    const item = createInventoryItemFixture();
    const token = await tokenFor(request, ACCOUNTS.user);
    let reqId: string | undefined;
    try {
      const created = await request.post(`${API}/requests`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { inventoryItemId: item.id, qtyRequested: 1, nature: 'PERMANENT', durationValue: 1, durationUnit: 'DAYS', departmentId: me.departmentId, responsiblePersonIds: [me.id] },
      });
      expect(created.status()).toBe(201);
      reqId = ((await created.json()).data ?? (await created.json())).id;

      const up = await request.post(`${API}/requests/${reqId}/attachment`, {
        headers: { Authorization: `Bearer ${token}` },
        multipart: { attachment: { name: suffix, mimeType: 'image/png', buffer: PNG } },
      });
      expect(up.status(), 'the upload was refused').toBe(201);

      const stored = sqlValue(`SELECT "attachmentPath" FROM "ComponentRequest" WHERE id = ${lit(reqId!)}`)!;
      expect(countUploadedFixtures(suffix), 'the file is not in the store').toBe(1);
      if (storageMode() === 's3') {
        expect(onServerDisk(stored), 'in S3 mode the file was still written to the server disk').toBe(false);
      }

      const back = await request.get(`${API}/requests/${reqId}/attachment`, { headers: { Authorization: `Bearer ${token}` } });
      expect(back.status()).toBe(200);
      expect(Buffer.compare(await back.body(), PNG), 'the file came back different').toBe(0);
    } finally {
      if (reqId) {
        sql(`DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(reqId)}`);
        sql(`DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(reqId)}`);
        sql(`DELETE FROM "ComponentRequest" WHERE id = ${lit(reqId)}`);
      }
      deleteUploadedFixtures(suffix);
    }
  });

  test('an asset photo link opens through the app, not straight from the bucket', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.finance);
    const deptId = sqlValue(`SELECT id FROM "Department" ORDER BY name LIMIT 1`)!;
    const made = await request.post(`${API}/fixed-assets`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: `E2E photo asset ${Date.now()}`, category: 'COMPUTERS_IT', departmentId: deptId },
    });
    const asset = (await made.json()).data ?? (await made.json());
    let key: string | undefined;
    try {
      expect(made.status()).toBe(201);
      const up = await request.post(`${API}/fixed-assets/${asset.id}/photos`, {
        headers: { Authorization: `Bearer ${token}` },
        multipart: { file: { name: 'photo.png', mimeType: 'image/png', buffer: PNG } },
      });
      expect(up.status(), `photo upload refused: ${await up.text()}`).toBeLessThan(300);
      const uploaded = (await up.json()).data ?? (await up.json());
      key = uploaded.key;
      // Same origin as the app — the CSP only lets images load from there.
      expect(String(uploaded.url).startsWith('/api/storage/serve/'), `photo link points elsewhere: ${uploaded.url}`).toBe(true);
      const img = await request.get(`http://localhost:3001${uploaded.url}`);
      expect(img.status()).toBe(200);
      expect(img.headers()['content-type']).toContain('image/png');
      expect(Buffer.compare(await img.body(), PNG)).toBe(0);
      // A link for this photo must not open anything else.
      const forged = String(uploaded.url).replace(encodeURI(key!), 'payment-receipts/anything.pdf');
      expect((await request.get(`http://localhost:3001${forged}`)).status()).toBe(403);
    } finally {
      if (asset?.id) {
        if (key) await request.delete(`${API}/fixed-assets/${asset.id}/photos?key=${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
        for (const t of ['FixedAssetEvent', 'FixedAssetMaintenance']) { // custom values cascade
          sql(`DELETE FROM "${t}" WHERE "fixedAssetId" = ${lit(asset.id)}`);
        }
        sql(`DELETE FROM "FixedAsset" WHERE id = ${lit(asset.id)}`);
      }
    }
  });
});
