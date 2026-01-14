import dgram from 'dgram';
import { Buffer } from 'buffer';

const PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_SCRAPE = 2;
const ACTION_ERROR = 3;
const DEFAULT_TIMEOUT = 15000; // 15 seconds

export interface ScrapeResult {
    infoHash: string;
    seeders: number;
    leechers: number;
    completed: number;
}

export class UdpTracker {
    private url: URL;
    private socket: dgram.Socket;
    private connectionId: bigint | null = null;
    private transactionId: number = 0;
    private timeout: number = DEFAULT_TIMEOUT;

    constructor(url: string) {
        // Ensure protocol is udp
        if (!url.startsWith('udp://')) {
            throw new Error('Only UDP trackers are supported');
        }
        this.url = new URL(url);
        this.socket = dgram.createSocket('udp4');
    }

    public setTimeout(timeout: number) {
        this.timeout = timeout;
    }

    private getTransactionId(): number {
        return Math.floor(Math.random() * 0xFFFFFFFF);
    }

    private async send(buf: Buffer, expectedSize: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.socket.close();
                reject(new Error('Timeout'));
            }, this.timeout);

            this.socket.on('message', (msg) => {
                if (msg.length < expectedSize) {
                    return; // Ignore incomplete packets
                }
                clearTimeout(timeoutId);
                resolve(msg);
            });

            this.socket.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(err);
            });

            this.socket.send(buf, 0, buf.length, Number(this.url.port) || 80, this.url.hostname, (err) => {
                if (err) {
                    clearTimeout(timeoutId);
                    reject(err);
                }
            });
        });
    }

    private async connect(): Promise<bigint> {
        if (this.connectionId) return this.connectionId;

        const transactionId = this.getTransactionId();
        const buf = Buffer.alloc(16);
        buf.writeBigUInt64BE(PROTOCOL_ID, 0);
        buf.writeUInt32BE(ACTION_CONNECT, 8);
        buf.writeUInt32BE(transactionId, 12);

        try {
            const response = await this.send(buf, 16);
            const action = response.readUInt32BE(0);
            const resTransactionId = response.readUInt32BE(4);

            if (resTransactionId !== transactionId) {
                throw new Error('Invalid transaction ID');
            }
            if (action === ACTION_ERROR) {
                throw new Error('Tracker returned error'); // Could read message
            }
            if (action !== ACTION_CONNECT) {
                throw new Error('Invalid action');
            }

            this.connectionId = response.readBigUInt64BE(8);
            return this.connectionId;
        } catch (e) {
            this.socket.close();
            throw e;
        }
    }

    public async scrape(infoHashes: string[]): Promise<ScrapeResult[]> {
        if (infoHashes.length > 74) {
            throw new Error('Too many infohashes');
        }

        try {
            const connectionId = await this.connect();
            const transactionId = this.getTransactionId();

            const buf = Buffer.alloc(16 + infoHashes.length * 20);
            buf.writeBigUInt64BE(connectionId, 0);
            buf.writeUInt32BE(ACTION_SCRAPE, 8);
            buf.writeUInt32BE(transactionId, 12);

            for (let i = 0; i < infoHashes.length; i++) {
                const hash = infoHashes[i];
                if (hash) {
                    const hashBuf = Buffer.from(hash, 'hex');
                    hashBuf.copy(buf, 16 + i * 20);
                }
            }

            const response = await this.send(buf, 8 + 12 * infoHashes.length);
            
            const action = response.readUInt32BE(0);
            const resTransactionId = response.readUInt32BE(4);

            if (resTransactionId !== transactionId) {
                throw new Error('Invalid transaction ID');
            }
            if (action === ACTION_ERROR) {
                throw new Error('Tracker returned error');
            }
            if (action !== ACTION_SCRAPE) {
                throw new Error('Invalid action');
            }

            const results: ScrapeResult[] = [];
            for (let i = 0; i < infoHashes.length; i++) {
                const offset = 8 + i * 12;
                const hash = infoHashes[i];
                if (hash) {
                    results.push({
                        infoHash: hash,
                        seeders: response.readUInt32BE(offset),
                        completed: response.readUInt32BE(offset + 4),
                        leechers: response.readUInt32BE(offset + 8),
                    });
                }
            }

            this.socket.close();
            return results;

        } catch (e) {
            this.socket.close();
            throw e;
        }
    }
}
