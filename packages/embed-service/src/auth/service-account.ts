import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export class ServiceAccountAuth {
  private readonly email: string;
  private readonly privateKey: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private refreshInFlight: Promise<string> | null = null;

  constructor(keyFile: string) {
    const raw = JSON.parse(readFileSync(keyFile, 'utf-8')) as ServiceAccountKey;
    this.email = raw.client_email;
    this.privateKey = raw.private_key;
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refresh(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 3600;
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: this.email,
      sub: this.email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: expiry,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    })).toString('base64url');
    const signInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signInput);
    const signature = signer.sign(this.privateKey, 'base64url');
    const jwt = `${signInput}.${signature}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OAuth token exchange failed (${resp.status}): ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { access_token: string; expires_in: number };
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
    return this.cachedToken;
  }
}
