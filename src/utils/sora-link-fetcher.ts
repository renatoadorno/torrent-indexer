import { RedisCache } from '../cache/redis';

const SPOOFED_USER_AGENT = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';

export class SoraLinkFetcher {
    private baseURL: string;
    private redisCache: RedisCache;

    constructor(baseURL: string, redisCache: RedisCache) {
        this.baseURL = baseURL;
        this.redisCache = redisCache;
    }

    public async fetchLink(queryID: string): Promise<string | null> {
        const key = `soralink:${queryID}`;
        
        // Try to get from cache
        const cachedLink = await this.redisCache.get(key);
        if (cachedLink) {
            console.log(`[DEBUG] Returning SoraLink from cache for ${queryID}`);
            return cachedLink;
        }

        console.log(`[DEBUG] Fetching SoraLink page for ${queryID}`);
        const pageURL = `${this.baseURL}?id=${queryID}`;

        try {
            // Step 1: GET the page to extract token and action
            const response = await fetch(pageURL, {
                headers: {
                    'User-Agent': SPOOFED_USER_AGENT,
                    'Accept': '*/*'
                }
            });

            if (!response.ok) {
                console.error(`Failed to fetch SoraLink page: ${response.status}`);
                return null;
            }

            const bodyText = await response.text();

            // Step 2: Extract token
            const tokenMatch = bodyText.match(/"token":"(.*?)"/);
            if (!tokenMatch || !tokenMatch[1]) {
                console.error('Failed to extract token from SoraLink page');
                return null;
            }
            const token = tokenMatch[1].replace(/\\\//g, '/');

            // Step 3: Extract action code
            const actionMatch = bodyText.match(/"soralink_z":"(.*?)"/);
            const action = (actionMatch && actionMatch[1]) ? actionMatch[1] : '';

            // Step 4: POST request to ajax endpoint
            const ajaxURL = `${this.baseURL}/wp-admin/admin-ajax.php`;
            const formData = new URLSearchParams();
            formData.append('token', token);
            formData.append('action', action);

            const postResponse = await fetch(ajaxURL, {
                method: 'POST',
                headers: {
                    'User-Agent': SPOOFED_USER_AGENT,
                    'Accept': '*/*',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: formData,
                redirect: 'manual' // We need to catch the 302 redirect
            });

            // Check Location header (fetch API handles redirects transparently usually, but with 'manual' we get the opaqueredirect or basic response)
            // Actually, fetch with 'manual' returns type 'opaqueredirect' if it's a cross-origin redirect, or we can inspect headers if it's same-origin.
            // However, usually the Location header is what we want.
            // If the server returns 302, fetch(..., {redirect: 'manual'}) returns a response with status 0 (opaque) or the status code if possible.
            // But standard fetch API in browsers/Bun might hide the Location header if it's opaque.
            // Let's try to see if we can get it.
            
            // Wait, if we use 'manual', we get the response object.
            let location = postResponse.headers.get('Location');
            
            // If fetch followed the redirect automatically (default), 'location' would be the final URL.
            // But we want the magnet link which IS the redirect target.
            // If we let it follow, it might fail if magnet: protocol is not supported by fetch.
            // So 'manual' is correct.
            
            if (!location && postResponse.status >= 300 && postResponse.status < 400) {
                 // It might be in headers
                 location = postResponse.headers.get('Location');
            }

            if (!location) {
                // Sometimes it might not be a redirect but a JSON response? 
                // Go code says: location := postResp.Header.Get("Location")
                console.error('No Location header found in SoraLink response');
                return null;
            }

            if (!location.startsWith('magnet:')) {
                console.error(`Location header is not a magnet link: ${location}`);
                return null;
            }

            // Cache the result
            await this.redisCache.set(key, location, 24 * 60 * 60); // 24 hours

            return location;

        } catch (e) {
            console.error('Error fetching SoraLink', e);
            return null;
        }
    }
}
