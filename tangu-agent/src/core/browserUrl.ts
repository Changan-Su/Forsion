import { getRawSection } from './config.js';
import { assertPublicHttpUrl } from './util/urlSafety.js';

function allowPrivateUrls(): boolean {
  if (process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS !== undefined)
    return ['1', 'true', 'yes', 'on'].includes(String(process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS).toLowerCase());
  return getRawSection('browser')?.allowPrivateUrls === true; // 默认禁私网
}

export async function validateBrowserUrl(raw: string): Promise<string> {
  if (allowPrivateUrls()) {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs are allowed');
    return u.href;
  }
  return (await assertPublicHttpUrl(raw)).href;
}
